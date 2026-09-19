#!/usr/bin/env node
/**
 * release.mjs — CAP_RELEASE-gated release workers for registered KILN projects.
 *
 * Reads ../projects/registry.json (canonical project list) and
 * nightly.config.json (per-project local checkout + optional `release`
 * command). For a registered project WITH a real configured release
 * command, it spawns a worker node (CAP_RELEASE and nothing else),
 * submits the release as a project.release tool call, waits, verifies
 * receipts, and reports.
 *
 * If the project has no `release` command configured, this script REFUSES
 * to run — release commands are never invented. Add the project's real
 * release command to nightly.config.json first.
 *
 * Usage:
 *   node release.mjs --project ID [--dir STATE_DIR] [--config FILE]
 *
 * Exit code: 0 on released, 1 on failure/refusal.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SwarmClient } from "./lib/client.mjs";
import { CAP_RELEASE } from "./lib/grant.mjs";
import { expandPath, loadJson, whichBin } from "./nightly.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SWARM_MJS = join(HERE, "swarm.mjs");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") args.dir = argv[++i];
    else if (a === "--config") args.config = argv[++i];
    else if (a === "--project") args.project = argv[++i];
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

async function waitForNodeUp(swarm, nodeId, timeoutMs = 120000) {
  const t0 = Date.now();
  for (;;) {
    const nodes = await swarm.listNodes();
    const node = nodes.find((n) => n.id === nodeId);
    if (node && (node.status === "idle" || node.status === "working")) return node;
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`release: node ${nodeId.slice(0, 12)}… never came up`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.project) {
    console.log("usage: node release.mjs --project ID [--dir STATE_DIR] [--config FILE]");
    process.exit(args.help ? 0 : 2);
  }
  const id = args.project;

  const registry = loadJson(join(HERE, "..", "projects", "registry.json"));
  const registered = new Map((registry.projects || []).map((p) => [p.id, p]));
  if (!registered.has(id)) {
    console.error(`release: "${id}" is not in projects/registry.json — refusing to release an unregistered project`);
    process.exit(1);
  }
  const config = loadJson(args.config ? resolve(args.config) : join(HERE, "nightly.config.json"));
  const pcfg = (config.projects || {})[id];
  if (!pcfg) {
    console.error(`release: "${id}" is not in nightly.config.json`);
    process.exit(1);
  }
  const local = expandPath(pcfg.local || "");
  if (!local || !existsSync(local)) {
    console.error(`release: local checkout not found (${pcfg.local}) — nothing to release`);
    process.exit(1);
  }
  const rel = pcfg.release;
  if (!rel || !rel.command) {
    console.error(`release: "${id}" has no release command configured in nightly.config.json — refusing to invent one.`);
    console.error(`release: add projects.${id}.release = { command, args } with the repo's REAL release command, then re-run.`);
    process.exit(1);
  }
  if (!whichBin(rel.command)) {
    console.error(`release: release binary "${rel.command}" not on PATH — install it or fix nightly.config.json`);
    process.exit(1);
  }

  let swarm;
  try {
    swarm = await SwarmClient.connect(args.dir ? { dir: resolve(args.dir) } : {});
  } catch (e) {
    console.error(`release: SWARM DAEMON IS NOT REACHABLE — ${e.message}`);
    console.error(`release: fix: node ${SWARM_MJS} daemon start${args.dir ? ` --dir ${args.dir}` : ""}`);
    process.exit(1);
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const nodeName = `release-${id}-${stamp}`;
  console.log(`release: ${id} — spawning ${nodeName} with CAP_RELEASE only (clone of ${local})`);
  const { id: nodeId } = await swarm.spawnNode({
    name: nodeName, caps: CAP_RELEASE, ttlSec: 86400, repo: local, mind: "script",
  });
  await waitForNodeUp(swarm, nodeId);

  const plan = {
    steps: [
      {
        tool: "project.release",
        args: { command: rel.command, args: rel.args || [], timeoutMs: rel.timeoutMs || 600000 },
      },
    ],
  };
  const { id: jobId } = await swarm.submitJob({ name: `release-${id}-${stamp}`, plan, mind: "script", node: nodeId });
  console.log(`release: ${id} — job ${jobId} submitted, waiting…`);
  try {
    const job = await swarm.waitForJob(jobId, { timeoutMs: 900000, pollMs: 5000 });
    const receipts = await swarm.verifyReceipts(nodeId);
    console.log(`release: ${id} — DONE: ${job.summary}`);
    console.log(`release: receipts verified: ${JSON.stringify(receipts.results?.[0] ?? receipts)}`);
  } catch (e) {
    console.log(`release: ${id} — FAILED: ${e.message}`);
    process.exit(1);
  }
}

const isMain = (() => {
  try {
    return resolve(process.argv[1] || "") === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isMain) {
  main().catch((e) => {
    console.error(`release: fatal: ${e.message}`);
    process.exit(1);
  });
}
