#!/usr/bin/env node
/**
 * swarm.mjs — CLI for the KILN headless agent runtime.
 *
 *   swarm.mjs init [--dir PATH]
 *   swarm.mjs daemon start|stop|status|token [--dir PATH]
 *   swarm.mjs node spawn --name N --caps CAPS --ttl SEC [--repo PATH] [--mind script|http]
 *                        [--policy never|on-failure|always] [--max-restarts N] [--dir PATH]
 *   swarm.mjs node list [--dir PATH]
 *   swarm.mjs node stop <id|name> [--dir PATH]
 *   swarm.mjs node logs <id|name> [--tail N] [--dir PATH]
 *   swarm.mjs job submit --plan FILE [--name N] [--mind M] [--node ID] [--dir PATH]
 *   swarm.mjs job list [--dir PATH]
 *   swarm.mjs receipts verify [--node ID] [--dir PATH]
 *
 * State dir: --dir, else $KILN_SWARM_DIR, else ~/.kiln-swarm.
 */
import { spawn } from "node:child_process";
import { readFileSync, existsSync, openSync, closeSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  stateDir as defaultStateDir, ensureStateDir, listNodeIds, loadNode, saveNode,
  resolveNode, pidAlive, heartbeatAgeMs, nodeDir, loadApiToken,
} from "./lib/state.mjs";
import { createNode } from "./lib/nodes.mjs";
import { loadKeypair } from "./lib/keys.mjs";
import { loadKeyFile } from "./lib/state.mjs";
import { parseCaps, capsToNames, nowSec } from "./lib/grant.mjs";
import { appendEvent, replay, newJobId } from "./lib/queue.mjs";
import { verifyReceipts, receiptsPath } from "./lib/receipts.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > -1) args[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) args[a.slice(2)] = argv[++i];
      else args[a.slice(2)] = true;
    } else args._.push(a);
  }
  return args;
}

function dirOf(args) {
  if (args.dir) return resolve(String(args.dir));
  return defaultStateDir();
}

function need(args, k) {
  if (args[k] === undefined) { console.error(`missing --${k}`); process.exit(2); }
  return args[k];
}

function fmtTs(ts) { return new Date(ts * 1000).toISOString(); }

// ---------------------------------------------------------------- init

function cmdInit(args) {
  const dir = dirOf(args);
  ensureStateDir(dir);
  console.log(`swarm state dir: ${dir}`);
}

// ---------------------------------------------------------------- daemon

function daemonJson(dir) {
  const p = join(dir, "daemon.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

function cmdDaemon(args) {
  const sub = args._[1];
  const dir = dirOf(args);
  ensureStateDir(dir);
  if (sub === "start") {
    const d = daemonJson(dir);
    if (d && pidAlive(d.pid)) { console.error(`daemon already running pid=${d.pid}`); process.exit(1); }
    const out = openSync(join(dir, "daemon.log"), "a");
    const child = spawn(process.execPath, [join(HERE, "lib", "daemon.mjs")], {
      detached: true, stdio: ["ignore", out, out],
      env: { ...process.env, KILN_SWARM_DIR: dir },
    });
    child.unref();
    closeSync(out);
    console.log(`daemon starting pid=${child.pid} dir=${dir}`);
  } else if (sub === "stop") {
    const d = daemonJson(dir);
    if (!d || !pidAlive(d.pid)) { console.log("daemon not running"); return; }
    process.kill(d.pid, "SIGTERM");
    console.log(`daemon stop signaled pid=${d.pid} (workers left running — persistent)`);
  } else if (sub === "status") {
    const d = daemonJson(dir);
    const alive = !!(d && pidAlive(d.pid));
    console.log(`daemon: ${alive ? `running pid=${d.pid} since ${d.startedAt}` : "not running"}`);
    if (alive && d.apiUrl) console.log(`api: ${d.apiUrl} (127.0.0.1 only, bearer token in ${join(dir, "api.token")})`);
    const ids = listNodeIds(dir);
    let idle = 0, working = 0, dead = 0;
    for (const id of ids) {
      const n = loadNode(dir, id);
      const a = pidAlive(n.workerPid);
      if (!a) dead++;
      else if (existsSync(join(nodeDir(dir, id), "job.json"))) working++;
      else idle++;
    }
    const jobs = replay(dir);
    const pending = [...jobs.values()].filter((j) => j.status === "pending").length;
    console.log(`nodes: ${ids.length} (idle=${idle} working=${working} dead=${dead})  jobs: ${jobs.size} total, ${pending} pending`);
  } else if (sub === "token") {
    console.log(loadApiToken(dir));
  } else { console.error("usage: daemon start|stop|status|token"); process.exit(2); }
}

// ---------------------------------------------------------------- node

function cmdNode(args) {
  const sub = args._[1];
  const dir = dirOf(args);
  ensureStateDir(dir);
  if (sub === "spawn") {
    const name = need(args, "name");
    const caps = parseCaps(need(args, "caps"));
    const ttl = parseInt(need(args, "ttl"), 10);
    if (!(ttl > 0)) { console.error("--ttl must be positive seconds"); process.exit(2); }
    const node = createNode(dir, {
      name: String(name),
      caps,
      expiresAt: nowSec() + ttl,
      repo: args.repo ? String(args.repo) : null,
      mind: String(args.mind || "script"),
      restartPolicy: String(args.policy || "on-failure"),
      maxRestarts: args["max-restarts"] ? parseInt(args["max-restarts"], 10) : 3,
    });
    console.log(`spawned node ${node.name}`);
    console.log(`  id:   ${node.id}`);
    console.log(`  caps: ${node.grant.capabilities} [${capsToNames(node.grant.capabilities).join(",")}] until ${fmtTs(node.grant.expiresAt)}`);
    console.log(`  work: ${node.workdir}`);
    const d = daemonJson(dir);
    console.log(d && pidAlive(d.pid)
      ? "  daemon will start the worker on its next tick"
      : "  daemon not running — start it to launch the worker");
  } else if (sub === "list") {
    const ids = listNodeIds(dir);
    if (!ids.length) { console.log("(no nodes)"); return; }
    for (const id of ids) {
      const n = loadNode(dir, id);
      const alive = pidAlive(n.workerPid);
      const hb = heartbeatAgeMs(dir, id);
      const st = !alive ? "dead" : hb > 30000 ? "stale" : existsSync(join(nodeDir(dir, id), "job.json")) ? "working" : "idle";
      const exp = n.grant.expiresAt <= nowSec() ? "EXPIRED" : `until ${fmtTs(n.grant.expiresAt)}`;
      console.log(`${id.slice(0, 12)}…  ${n.name.padEnd(14)} ${st.padEnd(7)} pid=${String(n.workerPid || "-").padEnd(7)} caps=[${capsToNames(n.grant.capabilities).join(",")}] ${exp}${n.grant.parent ? ` parent=${n.grant.parent.slice(0, 8)}…` : ""}`);
    }
  } else if (sub === "stop") {
    if (!args._[2]) { console.error("usage: node stop <id|name>"); process.exit(2); }
    const id = resolveNode(dir, args._[2]);
    const n = loadNode(dir, id);
    if (n.workerPid && pidAlive(n.workerPid)) {
      process.kill(n.workerPid, "SIGTERM");
      n.workerPid = null; n.lastExit = 0; saveNode(dir, n);
      console.log(`stopped worker for ${n.name}`);
    } else console.log(`${n.name}: no live worker`);
  } else if (sub === "logs") {
    if (!args._[2]) { console.error("usage: node logs <id|name>"); process.exit(2); }
    const id = resolveNode(dir, args._[2]);
    const n = loadNode(dir, id);
    const tail = args.tail ? parseInt(args.tail, 10) : 50;
    for (const f of ["stdout.log", "stderr.log"]) {
      const p = join(nodeDir(dir, id), f);
      console.log(`--- ${n.name} ${f} ---`);
      if (!existsSync(p)) { console.log("(empty)"); continue; }
      const lines = readFileSync(p, "utf8").split("\n");
      console.log(lines.slice(-tail).join("\n"));
    }
  } else { console.error("usage: node spawn|list|stop|logs"); process.exit(2); }
}

// ---------------------------------------------------------------- job

function cmdJob(args) {
  const sub = args._[1];
  const dir = dirOf(args);
  ensureStateDir(dir);
  if (sub === "submit") {
    const planFile = need(args, "plan");
    const plan = JSON.parse(readFileSync(resolve(String(planFile)), "utf8"));
    if (!plan || !Array.isArray(plan.steps)) { console.error("plan file must be JSON with steps[]"); process.exit(2); }
    const job = {
      id: newJobId(),
      name: String(args.name || `job-${Date.now()}`),
      plan, mind: String(args.mind || "script"),
    };
    if (args.node) job.node = resolveNode(dir, String(args.node));
    if (args.repo) job.repo = String(args.repo);
    appendEvent(dir, "submit", { job });
    console.log(`submitted ${job.id} (${job.plan.steps.length} steps, mind=${job.mind})`);
  } else if (sub === "list") {
    const jobs = [...replay(dir).values()].sort((a, b) => a.submittedAt - b.submittedAt);
    if (!jobs.length) { console.log("(no jobs)"); return; }
    for (const j of jobs) {
      console.log(`${j.id}  ${j.status.padEnd(8)} ${j.name}  node=${j.node ? j.node.slice(0, 8) + "…" : "-"}${j.summary ? `  ${j.summary.slice(0, 80)}` : ""}${j.error ? `  ERROR: ${j.error.slice(0, 80)}` : ""}`);
    }
  } else { console.error("usage: job submit|list"); process.exit(2); }
}

// ---------------------------------------------------------------- receipts

function cmdReceipts(args) {
  const sub = args._[1];
  const dir = dirOf(args);
  if (sub === "verify") {
    let ids = listNodeIds(dir);
    if (args.node) ids = [resolveNode(dir, String(args.node))];
    let allOk = true;
    for (const id of ids) {
      const n = loadNode(dir, id);
      const kp = loadKeypair(loadKeyFile(dir, id));
      const v = verifyReceipts(dir, id, kp);
      console.log(`${n.name} (${id.slice(0, 12)}…): ${v.ok ? `OK — ${v.count} receipts, chain intact` : `FAIL — ${v.error}`}`);
      if (!v.ok) allOk = false;
    }
    process.exit(allOk ? 0 : 1);
  } else { console.error("usage: receipts verify"); process.exit(2); }
}

// ---------------------------------------------------------------- main

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
try {
  if (cmd === "init") cmdInit(args);
  else if (cmd === "daemon") cmdDaemon(args);
  else if (cmd === "node") cmdNode(args);
  else if (cmd === "job") cmdJob(args);
  else if (cmd === "receipts") cmdReceipts(args);
  else {
    console.error("usage: swarm.mjs init|daemon|node|job|receipts");
    process.exit(2);
  }
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}
