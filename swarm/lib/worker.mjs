#!/usr/bin/env node
/**
 * Worker: ONE ENTIRE OS PROCESS per node. Spawned detached by the daemon
 * (or run directly for tests). Heartbeats via heartbeat-file mtime.
 *
 *   node worker.mjs <nodeId>
 *
 * Env: KILN_SWARM_DIR. Exit codes: 0 clean/idle-stop, 2 job failed (worker
 * stays alive), 3 grant expired, 1 unexpected crash (restart policy applies).
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import {
  stateDir, loadNode, loadKeyFile, touchHeartbeat, nodeDir,
  readJobFile, clearJobFile, heartbeatAgeMs,
} from "./state.mjs";
import { loadKeypair } from "./keys.mjs";
import { checkGrant, GrantError } from "./grant.mjs";
import { checkShellArgs } from "./tools.mjs";
import { appendEvent } from "./queue.mjs";
import { runScriptMind, runHttpMind } from "./minds.mjs";

const HEARTBEAT_MS = 5000;
const POLL_MS = 2000;

let stopping = false;
let appChild = null;

function killApp() {
  if (appChild) {
    try { appChild.kill("SIGTERM"); } catch { /* already gone */ }
    appChild = null;
  }
}

function appJsonPath(dir, nodeId) {
  return join(nodeDir(dir, nodeId), "app.json");
}

/**
 * App hosting: if this node has app.json, supervise its command for the
 * worker's whole lifetime — start on boot, restart on crash with backoff,
 * logs to app.log. This is what makes a deployed app survive daemon
 * restarts and VM recycles: the daemon respawns the worker (policy=always),
 * the worker re-reads app.json and boots the app again.
 * Runs as a background task; never throws out.
 */
async function superviseApp(dir, nodeId) {
  let backoffMs = 2000;
  for (;;) {
    if (stopping) return;
    let app;
    try {
      app = JSON.parse(readFileSync(appJsonPath(dir, nodeId), "utf8"));
    } catch {
      return; // no app configured for this node
    }
    if (!app || typeof app.command !== "string" || !app.command.trim()) {
      log("app: bad app.json — not supervising");
      return;
    }
    try {
      checkShellArgs(app.command, app.args || []);
    } catch (e) {
      log(`app: command rejected (${e.message}) — not supervising`);
      return;
    }
    let workdir;
    try {
      workdir = loadNode(dir, nodeId).workdir;
    } catch (e) {
      log(`app: cannot load node: ${e.message}`);
      return;
    }
    if (!existsSync(workdir)) {
      log("app: workdir missing — not supervising");
      return;
    }
    const logFd = openSync(join(nodeDir(dir, nodeId), "app.log"), "a");
    log(`app: starting ${app.command} ${(app.args || []).join(" ")}`);
    const child = spawn(app.command, (app.args || []).map(String), {
      cwd: workdir,
      env: { ...process.env, ...(app.env || {}) },
      stdio: ["ignore", logFd, logFd],
    });
    closeSync(logFd);
    appChild = child;
    const code = await new Promise((resolve) => child.on("exit", resolve));
    appChild = null;
    if (stopping) { log("app: stopped"); return; }
    log(`app: exited (code ${code}) — restarting in ${backoffMs}ms`);
    await sleep(backoffMs);
    backoffMs = Math.min(backoffMs * 2, 30000);
  }
}

function log(...a) {
  console.log(`[worker ${new Date().toISOString()}]`, ...a);
}

async function main() {
  const dir = stateDir();
  const nodeId = process.argv[2];
  if (!nodeId) { console.error("worker: node id required"); process.exit(1); }

  let node = loadNode(dir, nodeId);
  const keypair = loadKeypair(loadKeyFile(dir, nodeId));
  if (keypair.id !== nodeId) {
    console.error("worker: keypair does not match node id — refusing to run");
    process.exit(1);
  }
  try {
    checkGrant(node.grant, 0, "worker start");
  } catch (e) {
    console.error(`worker: ${e.message} — exiting`);
    process.exit(3);
  }

  log(`up: ${node.name} (${nodeId.slice(0, 12)}…) mind=${node.mind} work=${node.workdir}`);

  process.on("SIGTERM", () => { log("SIGTERM — stopping after current step"); stopping = true; killApp(); });
  process.on("SIGINT", () => { stopping = true; killApp(); });

  touchHeartbeat(dir, nodeId);
  const hb = setInterval(() => {
    try { touchHeartbeat(dir, nodeId); } catch (e) { log("heartbeat failed:", e.message); }
  }, HEARTBEAT_MS);

  // App hosting runs alongside the job loop, not instead of it.
  superviseApp(dir, nodeId).catch((e) => log("app supervisor error:", e.message));

  const ctx = {
    dir, nodeId, keypair,
    get grant() { return loadNode(dir, nodeId).grant; }, // always fresh
    get workdir() { return loadNode(dir, nodeId).workdir; },
    node,
  };

  try {
    while (!stopping) {
      const job = readJobFile(dir, nodeId);
      if (job) await runJob(ctx, dir, nodeId, job);
      await sleep(POLL_MS);
      if (stopping) break;
    }
  } catch (e) {
    if (e instanceof GrantError && e.code === "GRANT_EXPIRED") {
      console.error(`worker: grant expired mid-run — exiting: ${e.message}`);
      killApp();
      clearInterval(hb);
      process.exit(3);
    }
    console.error("worker: unexpected crash:", e);
    killApp();
    clearInterval(hb);
    process.exit(1);
  }
  killApp();
  clearInterval(hb);
  log("clean stop");
  process.exit(0);
}

async function runJob(ctx, dir, nodeId, job) {
  const node = loadNode(dir, nodeId);
  log(`job ${job.id} (${job.name}) via ${job.mind || node.mind}`);
  const t0 = Date.now();
  try {
    checkGrant(ctx.grant, 0, `job ${job.id}`);
    const mind = job.mind || node.mind || "script";
    let summary;
    if (mind === "script") summary = await runScriptMind(ctx, job.plan);
    else if (mind === "http") summary = await runHttpMind(ctx, { brief: `${job.name}: ${JSON.stringify(job.plan).slice(0, 2000)}` });
    else throw new Error(`unknown mind "${mind}"`);
    const ms = Date.now() - t0;
    appendEvent(dir, "done", { jobId: job.id, node: nodeId, summary: `${summary} (${ms}ms)` });
    log(`job ${job.id} done in ${ms}ms`);
  } catch (e) {
    const msg = e.code ? `${e.code}: ${e.message}` : e.message;
    appendEvent(dir, "fail", { jobId: job.id, node: nodeId, error: msg.slice(0, 2000) });
    log(`job ${job.id} FAILED: ${msg}`);
    if (e instanceof GrantError && e.code === "GRANT_EXPIRED") throw e;
  } finally {
    clearJobFile(dir, nodeId);
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

main();
