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
import {
  stateDir, loadNode, loadKeyFile, touchHeartbeat,
  readJobFile, clearJobFile, heartbeatAgeMs,
} from "./state.mjs";
import { loadKeypair } from "./keys.mjs";
import { checkGrant, GrantError } from "./grant.mjs";
import { appendEvent } from "./queue.mjs";
import { runScriptMind, runHttpMind } from "./minds.mjs";

const HEARTBEAT_MS = 5000;
const POLL_MS = 2000;

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

  let stopping = false;
  process.on("SIGTERM", () => { log("SIGTERM — stopping after current step"); stopping = true; });
  process.on("SIGINT", () => { stopping = true; });

  touchHeartbeat(dir, nodeId);
  const hb = setInterval(() => {
    try { touchHeartbeat(dir, nodeId); } catch (e) { log("heartbeat failed:", e.message); }
  }, HEARTBEAT_MS);

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
      clearInterval(hb);
      process.exit(3);
    }
    console.error("worker: unexpected crash:", e);
    clearInterval(hb);
    process.exit(1);
  }
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
