/**
 * KILN Compute: serverless functions, parallel map, and app hosting on the swarm.
 *
 * Three primitives, all real:
 *
 *   invoke  — run a JS function on a swarm worker and get the result back.
 *             POST /v1/compute/invoke {code, args?, timeoutMs?, name?, waitMs?}
 *             code is a JS module that MUST export `main(args)`. It runs
 *             jailed in the worker's work dir (same jail as shell.exec) with
 *             a timeout, stdout captured as logs, and the return value
 *             JSON-serialized back to the caller. waitMs blocks until done.
 *
 *   map     — fan one function out over many items (the supercomputer bit).
 *             POST /v1/compute/map {code, items[], timeoutMs?, name?}
 *             Each item becomes its own job; the daemon spreads them across
 *             idle workers and autospawns up to maxNodes.
 *
 *   apps    — deploy a repo as a persistent, supervised service ("pop" an app).
 *             POST /v1/compute/apps {name, repo, command, args?, env?, port?}
 *             The repo is cloned into a persistent node (restartPolicy=always);
 *             the worker supervises `command` for the node's lifetime, logs to
 *             app.log, restarts on crash. Survives daemon restarts and VM
 *             recycles via the normal watchdog path.
 *
 * Auth model: unchanged from the swarm API — Bearer <api.token>, 127.0.0.1 only.
 * Anyone holding the token can already run arbitrary binaries via POST /jobs,
 * so invoke() does not widen the trust boundary; it just makes it ergonomic.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { appendEvent, newJobId, replay } from "./queue.mjs";
import { createNode } from "./nodes.mjs";
import { nodeDir, loadNode, saveNode, listNodeIds } from "./state.mjs";
import { nowSec } from "./grant.mjs";
import { checkShellArgs } from "./tools.mjs";

export class ComputeError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const COMPUTE_FILE = "compute.json";
const MAX_CODE_CHARS = 262144; // 256KB
const MAX_ITEMS = 64;
const MAX_RESULT_BYTES = 1000000;

function computePath(dir) {
  return join(dir, COMPUTE_FILE);
}

function loadStore(dir) {
  const p = computePath(dir);
  if (!existsSync(p)) return { invocations: {}, maps: {} };
  try {
    const s = JSON.parse(readFileSync(p, "utf8"));
    return { invocations: s.invocations || {}, maps: s.maps || {} };
  } catch {
    return { invocations: {}, maps: {} };
  }
}

/** Atomic store write (tmp + rename). */
function saveStore(dir, store) {
  const p = computePath(dir);
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n");
  renameSync(tmp, p);
}

export function newInvocationId() {
  return "inv_" + randomBytes(6).toString("hex");
}

export function newMapId() {
  return "map_" + randomBytes(6).toString("hex");
}

function needTimeoutMs(v, what) {
  const t = v === undefined ? 30000 : v;
  if (typeof t !== "number" || !Number.isFinite(t) || t < 100 || t > 300000) {
    throw new ComputeError(400, `${what}: timeoutMs must be a number in 100..300000`);
  }
  return Math.floor(t);
}

function checkCode(code) {
  if (typeof code !== "string" || !code.trim()) {
    throw new ComputeError(400, "code must be a non-empty JS module string exporting main(args)");
  }
  if (code.length > MAX_CODE_CHARS) {
    throw new ComputeError(400, `code exceeds ${MAX_CODE_CHARS} chars`);
  }
}

function checkArgs(args) {
  if (args === undefined) return {};
  try {
    JSON.stringify(args);
  } catch {
    throw new ComputeError(400, "args must be JSON-serializable");
  }
  return args;
}

// ---------------------------------------------------------------- runner

/**
 * The harness that runs inside the worker's work dir next to the user code.
 * Sibling files: fn.mjs, args.json (written by the plan), result.json (output).
 */
export function runnerSource() {
  return `import { readFileSync, writeFileSync } from "node:fs";
const here = new URL(".", import.meta.url);
const read = (n) => readFileSync(new URL(n, here), "utf8");
const logs = [];
const capLog = (...a) => { if (logs.length < 200) logs.push(a.map((x) => String(x)).join(" ")); };
console.log = capLog;
console.error = (...a) => capLog("[stderr]", ...a);
let out;
try {
  const args = JSON.parse(read("./args.json"));
  const fn = await import("./fn.mjs");
  if (typeof fn.main !== "function") throw new Error("compute: fn.mjs must export function main(args)");
  const result = await fn.main(args);
  JSON.stringify(result);
  out = { ok: true, result };
} catch (e) {
  out = { ok: false, error: String((e && e.message) || e).slice(0, 4000) };
}
out.logs = logs;
let json = JSON.stringify(out);
if (json.length > ${MAX_RESULT_BYTES}) {
  json = JSON.stringify({ ok: out.ok, result: null, error: out.error || null, logs: [], truncated: true, note: "result exceeded 1MB and was not returned" });
}
try {
  writeFileSync(new URL("./result.json", here), json);
} catch (e) {
  process.stderr.write("compute runner: cannot write result.json: " + e.message);
  process.exit(1);
}
`;
}

/**
 * Compile {code, args} into a real job plan. Files are namespaced per
 * invocation so many invokes can share one worker without clobbering.
 */
export function compileInvokePlan({ invId, code, args, timeoutMs }) {
  checkCode(code);
  const cleanArgs = checkArgs(args);
  const t = needTimeoutMs(timeoutMs, "invoke");
  const base = `.kiln_compute/${invId}`;
  return {
    timeoutMs: t,
    plan: {
      steps: [
        { tool: "fs.write", args: { path: `${base}/fn.mjs`, content: code } },
        { tool: "fs.write", args: { path: `${base}/args.json`, content: JSON.stringify(cleanArgs) } },
        { tool: "fs.write", args: { path: `${base}/runner.mjs`, content: runnerSource() } },
        { tool: "shell.exec", args: { command: "node", args: [`${base}/runner.mjs`], timeoutMs: t } },
      ],
    },
  };
}

// ---------------------------------------------------------------- invoke

function resultPath(dir, nodeId, invId) {
  return join(nodeDir(dir, nodeId), "work", ".kiln_compute", invId, "result.json");
}

export function submitInvocation(dir, { name, code, args, timeoutMs, kind = "invoke", mapId = null }) {
  const invId = newInvocationId();
  const { plan, timeoutMs: t } = compileInvokePlan({ invId, code, args, timeoutMs });
  const job = {
    id: newJobId(),
    name: String(name || `invoke-${invId.slice(4, 10)}`),
    plan,
    mind: "script",
    compute: { invId, kind, timeoutMs: t },
  };
  appendEvent(dir, "submit", { job });
  const store = loadStore(dir);
  store.invocations[invId] = {
    jobId: job.id,
    name: job.name,
    kind,
    mapId,
    createdAt: Math.floor(Date.now() / 1000),
  };
  saveStore(dir, store);
  return { invocationId: invId, jobId: job.id };
}

function readResultFile(dir, nodeId, invId) {
  try {
    return JSON.parse(readFileSync(resultPath(dir, nodeId, invId), "utf8"));
  } catch {
    return null;
  }
}

export function getInvocation(dir, invId) {
  const store = loadStore(dir);
  const rec = store.invocations[invId];
  if (!rec) throw new ComputeError(404, "no such invocation");
  const job = replay(dir).get(rec.jobId);
  const status = job ? job.status : "unknown";
  const view = {
    invocationId: invId,
    jobId: rec.jobId,
    name: rec.name,
    kind: rec.kind,
    status,
  };
  if (job && job.submittedAt) {
    const end = job.finishedAt || Math.floor(Date.now() / 1000);
    view.durationMs = (end - job.submittedAt) * 1000;
  }
  if (status === "done") {
    const r = job.node ? readResultFile(dir, job.node, invId) : null;
    if (!r) {
      view.ok = false;
      view.error = "compute: job done but result.json is missing from the worker dir";
    } else {
      view.ok = r.ok;
      view.result = r.result;
      view.error = r.error || null;
      view.logs = r.logs || [];
      view.truncated = !!r.truncated;
    }
  } else if (status === "failed") {
    view.ok = false;
    view.error = (job && job.error) || "job failed";
  }
  return view;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll until the invocation is terminal or waitMs elapses. Never throws on timeout. */
export async function waitInvocation(dir, invId, waitMs) {
  const w = Math.min(Math.max(waitMs, 1000), 300000);
  const t0 = Date.now();
  let view = getInvocation(dir, invId);
  while ((view.status === "pending" || view.status === "assigned" || view.status === "unknown") &&
         Date.now() - t0 < w) {
    await sleep(250);
    view = getInvocation(dir, invId);
  }
  return view;
}

// ---------------------------------------------------------------- map

export function submitMap(dir, { name, code, items, timeoutMs }) {
  checkCode(code);
  if (!Array.isArray(items) || !items.length) {
    throw new ComputeError(400, "items must be a non-empty array");
  }
  if (items.length > MAX_ITEMS) {
    throw new ComputeError(400, `items exceeds max ${MAX_ITEMS} (raise it deliberately, not by accident)`);
  }
  const t = needTimeoutMs(timeoutMs, "map");
  const mapId = newMapId();
  const invocationIds = [];
  for (let i = 0; i < items.length; i++) {
    checkArgs(items[i]);
    const { invocationId } = submitInvocation(dir, {
      name: `${name || "map"}[${i}]`,
      code,
      args: items[i],
      timeoutMs: t,
      kind: "map-item",
      mapId,
    });
    invocationIds.push(invocationId);
  }
  const store = loadStore(dir);
  store.maps[mapId] = {
    name: String(name || `map-${mapId.slice(4, 10)}`),
    invocationIds,
    createdAt: Math.floor(Date.now() / 1000),
  };
  saveStore(dir, store);
  return { mapId, invocationIds };
}

export function getMap(dir, mapId) {
  const store = loadStore(dir);
  const rec = store.maps[mapId];
  if (!rec) throw new ComputeError(404, "no such map");
  const results = rec.invocationIds.map((id) => {
    try {
      return getInvocation(dir, id);
    } catch (e) {
      return { invocationId: id, status: "error", error: e.message };
    }
  });
  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  return { mapId, name: rec.name, counts, results };
}

// ---------------------------------------------------------------- apps

const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

function checkAppName(name) {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new ComputeError(400, "name must match [A-Za-z0-9_.-]{1,64}");
  }
}

function checkAppEnv(env) {
  if (env === undefined) return {};
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw new ComputeError(400, "env must be an object of string->string");
  }
  const keys = Object.keys(env);
  if (keys.length > 32) throw new ComputeError(400, "env exceeds 32 entries");
  for (const k of keys) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof env[k] !== "string") {
      throw new ComputeError(400, `env: bad entry ${JSON.stringify(k)}`);
    }
  }
  return env;
}

/**
 * Deploy a repo as a persistent supervised service. The worker boots the
 * app's command on (re)start and restarts it on crash; logs go to app.log.
 */
export async function deployApp(dir, { name, repo, command, args: cmdArgs, env, port }) {
  checkAppName(name);
  if (typeof repo !== "string" || !repo.trim()) throw new ComputeError(400, "repo is required");
  if (typeof command !== "string" || !command.trim()) throw new ComputeError(400, "command is required");
  const argv = cmdArgs === undefined ? [] : cmdArgs;
  if (!Array.isArray(argv) || !argv.every((a) => typeof a === "string")) {
    throw new ComputeError(400, "args must be string[]");
  }
  // Same jail philosophy as shell.exec: no shell binaries, no metacharacters.
  try {
    checkShellArgs(command, argv);
  } catch (e) {
    throw new ComputeError(400, `app command rejected: ${e.message}`);
  }
  const cleanEnv = checkAppEnv(env);
  let p = null;
  if (port !== undefined) {
    p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new ComputeError(400, "port must be 1..65535");
  }
  const node = await createNode(dir, {
    name: `app-${name}`,
    caps: 15,
    expiresAt: nowSec() + 365 * 24 * 3600,
    repo: repo.trim(),
    mind: "script",
    restartPolicy: "always",
    maxRestarts: 100,
    autostart: true,
  });
  const appCfg = {
    name,
    command: command.trim(),
    args: argv,
    env: cleanEnv,
    port: p,
    deployedAt: new Date().toISOString(),
  };
  writeFileSync(join(nodeDir(dir, node.id), "app.json"), JSON.stringify(appCfg, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(join(nodeDir(dir, node.id), "app.json"), 0o600); } catch { /* best effort */ }
  return { appId: node.id, name, status: "deploying" };
}

export function appConfig(dir, appId) {
  const p = join(nodeDir(dir, appId), "app.json");
  if (!existsSync(p)) throw new ComputeError(404, "no such app");
  return JSON.parse(readFileSync(p, "utf8"));
}

export function listApps(dir) {
  return listNodeIds(dir)
    .filter((id) => existsSync(join(nodeDir(dir, id), "app.json")))
    .map((id) => {
      const cfg = JSON.parse(readFileSync(join(nodeDir(dir, id), "app.json"), "utf8"));
      let status = "unknown";
      try {
        const node = loadNode(dir, id);
        status = node.workerPid ? "running" : "stopped";
      } catch { /* ignore */ }
      return { appId: id, name: cfg.name, command: cfg.command, port: cfg.port, status };
    });
}

export function appLogs(dir, appId, tail = 100) {
  appConfig(dir, appId); // 404 if unknown
  const p = join(nodeDir(dir, appId), "app.log");
  if (!existsSync(p)) return { appId, log: "" };
  const lines = readFileSync(p, "utf8").split("\n");
  const n = Math.min(Math.max(tail, 1), 1000);
  return { appId, log: lines.slice(-n).join("\n") };
}

/** Stop an app: never respawn, SIGTERM the worker (which kills the app child). */
export function undeployApp(dir, appId) {
  appConfig(dir, appId); // 404 if unknown
  const node = loadNode(dir, appId);
  node.restartPolicy = "never";
  node.autostart = false;
  saveNode(dir, node);
  try {
    if (node.workerPid) process.kill(node.workerPid, "SIGTERM");
  } catch { /* already gone */ }
  return { ok: true, appId };
}
