#!/usr/bin/env node
/**
 * Daemon: the backend worker host. ONE process owns the job queue and all
 * worker processes.
 *
 *  - Single instance via daemon.lock (exclusive create; stale lock reclaimed).
 *  - Owns a JSONL job queue (atomic appends, fsync); assigns pending jobs to
 *    idle nodes, or spawns nodes when autospawn is on.
 *  - Spawns each worker as a DETACHED child process (entire OS process per
 *    node), stdio -> per-node log files. Tracks pids; heartbeats via
 *    heartbeat-file mtime; restarts per policy (never/on-failure/always).
 *  - Reconciles on boot: dead pids marked, respawned per policy — nodes are
 *    persistent across daemon restarts. Workers are NOT killed on daemon
 *    stop; a restarted daemon re-adopts live pids.
 */
import { spawn } from "node:child_process";
import { openSync, closeSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  stateDir, ensureStateDir, loadConfig, listNodeIds, loadNode, saveNode,
  pidAlive, pidIsDaemon, heartbeatAgeMs, touchHeartbeat, writeJobFile, readJobFile,
} from "./state.mjs";
import { appendEvent, pendingJobs } from "./queue.mjs";
import { createNode } from "./nodes.mjs";
import { nowSec } from "./grant.mjs";
import { startApiServer } from "./httpapi.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "worker.mjs");

function log(...a) {
  console.log(`[daemon ${new Date().toISOString()}]`, ...a);
}

/**
 * Ticket E4: the supervisor runs on every tick, so a node that is
 * terminally dead (policy=never, or max restarts reached) got its "not
 * respawning / leaving dead" line re-logged every tick — ~25k lines and a
 * 10MB daemon.log in a day. Terminal states never change on their own, so
 * log each distinct terminal state once per daemon lifetime; a genuinely
 * new situation (policy edited, restarts incremented) still logs.
 */
const terminalLogged = new Set();
function logTerminalOnce(key, msg) {
  if (terminalLogged.has(key)) return;
  terminalLogged.add(key);
  log(msg);
}

function lockPath(dir) { return join(dir, "daemon.lock"); }
function daemonJsonPath(dir) { return join(dir, "daemon.json"); }

function acquireLock(dir) {
  try {
    const fd = openSync(lockPath(dir), "wx");
    closeSync(fd);
    return true;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    // Possibly stale — check the recorded pid. kill(pid,0) alone is racy: a
    // dead daemon's pid can be reused by an unrelated process in the window
    // between the check and the claim, making a stale lock look live (seen
    // 2026-09-21: restart refused with "lock held by live pid" while no
    // daemon ran). pidIsDaemon verifies the cmdline actually belongs to
    // this daemon.
    try {
      const d = JSON.parse(readFileSync(daemonJsonPath(dir), "utf8"));
      if (pidIsDaemon(d.pid, dir)) return false; // genuinely running
    } catch { /* fall through: stale */ }
    unlinkSync(lockPath(dir));
    const fd = openSync(lockPath(dir), "wx");
    closeSync(fd);
    log("reclaimed stale daemon lock");
    return true;
  }
}

function spawnWorker(dir, id) {
  const ndir = join(dir, "nodes", id);
  const out = openSync(join(ndir, "stdout.log"), "a");
  const err = openSync(join(ndir, "stderr.log"), "a");
  const child = spawn(process.execPath, [WORKER, id], {
    detached: true,
    stdio: ["ignore", out, err],
    env: { ...process.env, KILN_SWARM_DIR: dir },
  });
  child.unref();
  closeSync(out); closeSync(err);
  const node = loadNode(dir, id);
  node.workerPid = child.pid;
  saveNode(dir, node);
  touchHeartbeat(dir, id);
  log(`spawned worker for ${node.name} (${id.slice(0, 12)}…) pid=${child.pid}`);
  return child.pid;
}

function nodeStatus(dir, cfg, node) {
  const alive = pidAlive(node.workerPid);
  const hbAge = heartbeatAgeMs(dir, node.id);
  const fresh = hbAge < cfg.heartbeatTimeoutMs;
  if (alive && fresh) return readJobFile(dir, node.id) ? "working" : "idle";
  if (alive && !fresh) return "stale";
  return "dead";
}

function reconcile(dir, cfg) {
  for (const id of listNodeIds(dir)) {
    const node = loadNode(dir, id);
    if (!node.autostart) continue;
    const st = nodeStatus(dir, cfg, node);
    if (st === "idle" || st === "working" || st === "stale") {
      if (st === "stale") log(`node ${node.name}: worker pid ${node.workerPid} alive but heartbeat stale`);
      continue; // live worker (or at least a live pid) — adopt it
    }
    // dead worker: respawn per policy
    const policy = node.restartPolicy || "on-failure";
    const should = policy === "always" || (policy === "on-failure" && node.lastExit !== 0);
    if (!should) { logTerminalOnce(`${node.id}:dead:${policy}`, `node ${node.name}: dead, policy=${policy} — not respawning`); continue; }
    if (node.restarts >= (node.maxRestarts ?? 3)) {
      logTerminalOnce(`${node.id}:maxrestarts:${node.restarts}`, `node ${node.name}: max restarts (${node.maxRestarts}) reached — leaving dead`);
      continue;
    }
    node.restarts += 1;
    saveNode(dir, node);
    spawnWorker(dir, id);
  }
}

function reapExited(dir) {
  // Detect workers that died without the daemon noticing: pid gone but
  // record still claims it. reconcile() handles the respawn.
  for (const id of listNodeIds(dir)) {
    const node = loadNode(dir, id);
    if (node.workerPid && !pidAlive(node.workerPid)) {
      if (node.lastExit === null || node.lastExit === undefined) {
        // We don't know the exit code; treat unknown death as failure-ish.
        node.lastExit = 1;
        saveNode(dir, node);
        log(`node ${node.name}: worker pid ${node.workerPid} is gone`);
      }
    }
  }
}

/** Jobs waiting on a node that is still being cloned. Guards the tick. */
const autospawnInflight = new Set();

async function autospawnForJob(dir, cfg, job) {
  if (autospawnInflight.has(job.id)) return;
  autospawnInflight.add(job.id);
  try {
    const wd = cfg.workerDefaults || {};
    const node = await createNode(dir, {
      name: `job-${job.id.slice(4, 10)}`,
      caps: wd.caps ?? 15,
      expiresAt: nowSec() + (wd.ttlSec ?? 86400),
      repo: job.repo || wd.repo || null,
      mind: job.mind || wd.mind || "script",
      restartPolicy: wd.restartPolicy || "on-failure",
      maxRestarts: wd.maxRestarts ?? 3,
    });
    spawnWorker(dir, node.id);
    log(`autospawned ${node.name} for ${job.id}`);
  } catch (e) {
    // createNode already cleaned up its node dir on clone failure.
    log(`autospawn for ${job.id} failed: ${e.message}`);
  } finally {
    autospawnInflight.delete(job.id);
  }
}

function tick(dir, cfg) {
  try {
    reapExited(dir);
    reconcile(dir, cfg);

    const pending = pendingJobs(dir);
    if (!pending.length) return;

    const idle = [];
    for (const id of listNodeIds(dir)) {
      const node = loadNode(dir, id);
      let grantLive = false;
      try { grantLive = node.grant && node.grant.expiresAt > nowSec(); } catch { grantLive = false; }
      if (!grantLive) continue;
      if (nodeStatus(dir, cfg, node) === "idle") idle.push(node);
    }

    for (const job of pending) {
      let node = null;
      if (job.node) {
        try {
          const n = loadNode(dir, job.node);
          if (nodeStatus(dir, cfg, n) === "idle") node = n;
        } catch { /* unknown node: fall through to any idle */ }
      }
      node = node || idle.shift() || null;
      if (!node && cfg.autospawn) {
        const count = listNodeIds(dir).length;
        if (count < (cfg.maxNodes || 8)) {
          // Async: the clone must not block the tick (self-deadlock when the
          // repo URL points at this daemon). The job stays pending; the next
          // tick picks it up once the node is idle.
          autospawnForJob(dir, cfg, job).catch((e) => log(`autospawn error: ${e.message}`));
          continue;
        }
      }
      if (!node) { log(`no capacity for ${job.id} — waiting`); continue; }
      writeJobFile(dir, node.id, { id: job.id, name: job.name, plan: job.plan, mind: job.mind });
      appendEvent(dir, "assign", { jobId: job.id, node: node.id });
      log(`assigned ${job.id} -> ${node.name}`);
    }
  } catch (e) {
    log("tick error:", e.message);
  }
}

async function main() {
  const dir = ensureStateDir(stateDir());
  if (!acquireLock(dir)) {
    console.error("daemon: already running (lock held by live pid) — exiting");
    process.exit(1);
  }
  const cfg = loadConfig(dir);
  let api = null;
  try {
    api = await startApiServer(dir, cfg);
    log(`api on ${api.url} (127.0.0.1 only, bearer token required)`);
  } catch (e) {
    console.error(`daemon: api failed to start: ${e.message} — exiting`);
    try { unlinkSync(lockPath(dir)); } catch {}
    process.exit(1);
  }
  writeFileSync(daemonJsonPath(dir), JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    apiPort: api.port,
    apiUrl: api.url,
  }) + "\n");
  log(`up pid=${process.pid} dir=${dir}`);

  let stopping = false;
  const onStop = () => {
    if (stopping) return;
    stopping = true;
    log("stopping (workers left running — they are persistent)");
    clearInterval(timer);
    try { api.server.close(); } catch {}
    try { unlinkSync(lockPath(dir)); } catch {}
    process.exit(0);
  };
  process.on("SIGTERM", onStop);
  process.on("SIGINT", onStop);
  // Never die silently: an uncaught exception in a tick would otherwise kill
  // the daemon with no explanation in the log (see ticket E2). Log it loudly
  // and keep supervising — the workers are persistent and depend on us.
  process.on("uncaughtException", (err) => {
    try { log(`FATAL uncaughtException (staying alive): ${err && err.stack ? err.stack : err}`); } catch {}
  });
  process.on("unhandledRejection", (reason) => {
    try { log(`FATAL unhandledRejection (staying alive): ${reason && reason.stack ? reason.stack : reason}`); } catch {}
  });

  reconcile(dir, cfg); // boot reconcile: adopt live, respawn dead per policy
  const timer = setInterval(() => { if (!stopping) tick(dir, cfg); }, cfg.tickMs || 2000);
}

main();
