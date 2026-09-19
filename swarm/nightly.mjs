#!/usr/bin/env node
/**
 * nightly.mjs — nightly test workers for registered KILN projects.
 *
 * Reads ../projects/registry.json (the canonical project list) and
 * nightly.config.json (per-project local checkout + test command).
 * For each configured project that is BOTH registered and checked out
 * locally with its test binary available, it spawns a worker node
 * (CAP_COMMIT, mind=script), submits a test plan, waits, and reports.
 *
 * Only registered projects run. Anything in the config that is NOT in
 * the registry is skipped LOUDLY, never silently. Anything whose local
 * checkout or test binary is missing is skipped LOUDLY too — this script
 * never claims a project it cannot actually check out and test.
 *
 * Usage:
 *   node nightly.mjs [--dir STATE_DIR] [--config FILE] [--project ID]
 *
 *   --project limits the run to a single configured project id.
 *   Exit code: 0 when every attempted project passed, 1 if any job failed.
 */
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { SwarmClient } from "./lib/client.mjs";
import { CAP_COMMIT } from "./lib/grant.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SWARM_MJS = join(HERE, "swarm.mjs");

export function expandPath(p) {
  let s = String(p);
  if (s.startsWith("~/")) s = join(homedir(), s.slice(2));
  s = s.replace(/\$HOME|\$\{HOME\}/g, homedir());
  return s;
}

/** Resolve a binary via PATH. Returns the absolute path or null. */
export function whichBin(name) {
  if (!/^[A-Za-z0-9_./-]+$/.test(name)) return null;
  try {
    const out = execSync(`command -v ${name}`, { encoding: "utf8", timeout: 10000 }).trim().split("\n")[0];
    return out || null;
  } catch {
    return null;
  }
}

export function loadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`nightly: cannot read ${path}: ${e.message}`);
  }
}

/**
 * Build the test plan for one project. Mirrors examples/nightly-tests.json:
 * optional setup steps, the real test command, a timestamped report file
 * (the timestamp guarantees the tree changed, so git.commit lands), commit.
 * `test` = { bin (absolute), args, timeoutMs }.
 */
export function buildNightlyPlan({ project, setup = [], test, stamp }) {
  const testLine = [test.bin, ...(test.args || [])].join(" ");
  const steps = [];
  for (const [command, ...rest] of setup) {
    steps.push({ tool: "shell.exec", args: { command, args: rest, timeoutMs: 300000 } });
  }
  steps.push({
    tool: "shell.exec",
    args: { command: test.bin, args: test.args || [], timeoutMs: test.timeoutMs || 300000 },
  });
  steps.push({
    tool: "fs.write",
    args: {
      path: "TEST_REPORT.md",
      content:
        `# Nightly test report — ${project}\n\n` +
        `Command: \`${testLine}\`\n` +
        `Run at: ${stamp}\n` +
        `Run by a KILN swarm worker (script mind) from swarm/nightly.mjs.\n\n` +
        `The full command output and per-step results are in the job's signed\n` +
        `receipts and the job summary — this file marks the run.\n`,
    },
  });
  steps.push({ tool: "git.commit", args: { message: `nightly: test report for ${project}` } });
  return { steps };
}

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
      throw new Error(`nightly: node ${nodeId.slice(0, 12)}… never came up`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("usage: node nightly.mjs [--dir STATE_DIR] [--config FILE] [--project ID]");
    process.exit(0);
  }

  const registry = loadJson(join(HERE, "..", "projects", "registry.json"));
  const registered = new Map((registry.projects || []).map((p) => [p.id, p]));
  const config = loadJson(args.config ? resolve(args.config) : join(HERE, "nightly.config.json"));
  const entries = Object.entries(config.projects || {});
  const wanted = args.project ? entries.filter(([id]) => id === args.project) : entries;
  if (args.project && !wanted.length) {
    console.error(`nightly: project "${args.project}" is not in nightly.config.json`);
    process.exit(2);
  }

  // ---- daemon must be up; fail LOUDLY otherwise ----
  let swarm;
  try {
    swarm = await SwarmClient.connect(args.dir ? { dir: resolve(args.dir) } : {});
  } catch (e) {
    console.error(`nightly: SWARM DAEMON IS NOT REACHABLE — ${e.message}`);
    console.error(`nightly: fix: node ${SWARM_MJS} daemon start${args.dir ? ` --dir ${args.dir}` : ""}`);
    process.exit(1);
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const results = [];
  const skipped = [];

  for (const [id, pcfg] of wanted) {
    if (!registered.has(id)) {
      skipped.push(`${id}: not in projects/registry.json — refusing to run an unregistered project`);
      continue;
    }
    const local = expandPath(pcfg.local || "");
    if (!local || !existsSync(local)) {
      skipped.push(`${id}: local checkout not found (${pcfg.local}) — nothing to test`);
      continue;
    }
    const setup = [];
    let skipReason = null;
    for (const [command, ...rest] of pcfg.setup || []) {
      const bin = whichBin(command);
      if (!bin) {
        skipReason = `${id}: setup binary "${command}" not on PATH — install it or fix nightly.config.json`;
        break;
      }
      setup.push([bin, ...rest]);
    }
    if (skipReason) {
      skipped.push(skipReason);
      continue;
    }
    const testBin = whichBin(pcfg.test?.command || "");
    if (!testBin) {
      skipped.push(`${id}: test binary "${pcfg.test?.command}" not on PATH — install it or fix nightly.config.json`);
      continue;
    }

    const nodeName = `nightly-${id}-${stamp}`;
    console.log(`nightly: ${id} — spawning ${nodeName} (clone of ${local})`);
    try {
      const { id: nodeId } = await swarm.spawnNode({
        name: nodeName, caps: CAP_COMMIT, ttlSec: 86400, repo: local, mind: "script",
      });
      await waitForNodeUp(swarm, nodeId);
      const plan = buildNightlyPlan({
        project: id,
        setup,
        test: { bin: testBin, args: pcfg.test.args || [], timeoutMs: pcfg.test.timeoutMs || 300000 },
        stamp: new Date().toISOString(),
      });
      const { id: jobId } = await swarm.submitJob({ name: `nightly-${id}-${stamp}`, plan, mind: "script", node: nodeId });
      console.log(`nightly: ${id} — job ${jobId} submitted, waiting…`);
      const job = await swarm.waitForJob(jobId, { timeoutMs: 900000, pollMs: 5000 });
      const receipts = await swarm.verifyReceipts(nodeId);
      results.push({ id, nodeId, jobId, ok: true, summary: job.summary, receipts: receipts.results?.[0]?.count ?? null });
      console.log(`nightly: ${id} — DONE: ${job.summary}`);
    } catch (e) {
      results.push({ id, ok: false, error: e.message });
      console.log(`nightly: ${id} — FAILED: ${e.message}`);
    }
  }

  console.log("\n================ nightly summary ================");
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.id}${r.ok ? ` — ${r.summary}` : ` — ${r.error}`}`);
  }
  for (const s of skipped) console.log(`SKIP  ${s}`);
  console.log(`=================================================\n${results.filter((r) => r.ok).length} passed, ${results.filter((r) => !r.ok).length} failed, ${skipped.length} skipped`);

  const failed = results.filter((r) => !r.ok).length;
  process.exit(failed ? 1 : 0);
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
    console.error(`nightly: fatal: ${e.message}`);
    process.exit(1);
  });
}
