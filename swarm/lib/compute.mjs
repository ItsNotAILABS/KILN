/**
 * KILN Compute: serverless functions, parallel map, and app hosting on the swarm.
 *
 * Three primitives, all real:
 *
 *   invoke  — run a JS function on a swarm worker and get the result back.
 *             POST /v1/compute/invoke {code, args?, timeoutMs?, name?, waitMs?,
 *                                     memoryMB?, network?, retries?}
 *             code is a JS module that MUST export `main(args)`. It runs
 *             inside the KILN Linux sandbox (fresh mount/pid/uts/ipc
 *             namespaces, net only when network:true, /home /root hidden,
 *             JS heap capped at memoryMB, RSS SIGKILL past 2x, wall-clock
 *             timeout with SIGTERM-then-SIGKILL teeth), stdout captured as
 *             logs, and the return value JSON-serialized back to the caller.
 *             waitMs blocks until done. Admission is bounded (429 +
 *             Retry-After at capacity); one automatic retry covers
 *             sandbox-infra failures only. GET shows metrics + billing
 *             (GB-seconds) per invocation.
 *
 *   capacity— GET /v1/compute/capacity: arrival rate, p50 service time, and
 *             the Little's-law concurrency target (see getCapacity).
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
import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import os from "node:os";
import { createConnection } from "node:net";
import { appendEvent, newJobId, replay, readEvents } from "./queue.mjs";
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

// ---------------------------------------------------------------- scheduler
//
// Admission + capacity, derived from Little's law (L = lambda * W):
// the sustainable concurrent invocations are bounded by MAX_CONCURRENT;
// /v1/compute/capacity reports the observed arrival rate, service time,
// and the Little's-law staffing target so callers can see real headroom.
// State is in-process (the daemon is single-process; workers are children).
//
// Estimator (per the researched design):
//   required_workers =
//     clamp(min_warm, max_workers, ceil(arrival_rate_ewma * service_time_p95 * safety_factor))
//   - arrival_rate_ewma: EWMA (alpha 0.3) over inter-completion gaps.
//     Completions approximate arrivals in steady state.
//   - service_time_p95: 95th percentile of the completion ring, not the
//     mean — tail latency is what breaks a staffing target.
//   - safety_factor 1.5: burst headroom (at exactly L = λW the system is at
//     100% utilization; 1.5x keeps steady-state near 67%).
//   - hysteresis: the reported desiredWorkers scales up promptly but scales
//     down only when the raw target drops a full worker below it — no
//     flapping on noise.
// Honest scope: this is telemetry + the 429 admission bound, NOT an
// autoscaler. Nothing in the daemon spawns or stops workers from the
// target; enforcement is admission control (429 + Retry-After). Autoscale
// actuation is a scoped-out future step (see docs/KILN_COMPUTE_RUNTIME.md).

const MAX_CONCURRENT = Math.max(1, Number(process.env.KILN_COMPUTE_MAX_CONCURRENT) || 8);
const MIN_WARM = Math.max(0, Number(process.env.KILN_COMPUTE_MIN_WARM) || 1);
const SCHED_SAFETY = 1.5;
const EWMA_ALPHA = 0.3;
let inflight = 0;
const settledIds = new Set();
const completions = []; // [{at: ms epoch, durationMs}] ring, cap 500
const COMPLETION_CAP = 500;
let arrivalEwma = 0; // invocations/sec, EWMA over inter-completion gaps
let lastCompletionAt = 0;
let desiredWorkers = MIN_WARM; // hysteresis-applied staffing target

function noteCompletion(durationMs) {
  const now = Date.now();
  completions.push({ at: now, durationMs: Math.max(0, Math.round(durationMs)) });
  if (completions.length > COMPLETION_CAP) completions.splice(0, completions.length - COMPLETION_CAP);
  if (lastCompletionAt > 0) {
    const gapSec = Math.max(0.001, (now - lastCompletionAt) / 1000);
    const inst = 1 / gapSec;
    arrivalEwma = arrivalEwma > 0 ? EWMA_ALPHA * inst + (1 - EWMA_ALPHA) * arrivalEwma : inst;
  }
  lastCompletionAt = now;
}

function p95DurationMs() {
  if (!completions.length) return 0;
  const ds = completions.map((c) => c.durationMs).sort((a, b) => a - b);
  return ds[Math.min(ds.length - 1, Math.floor(0.95 * ds.length))];
}

function admit() {
  if (inflight >= MAX_CONCURRENT) {
    throw new ComputeError(429,
      `compute at capacity: ${inflight}/${MAX_CONCURRENT} invocations in flight — retry shortly`);
  }
  inflight += 1;
}

/**
 * Atomic multi-slot admission: all n slots or a 429 — never partial.
 * Used by map so a 64-item fan-out can't strand a half-admitted map.
 */
function admitN(n) {
  if (inflight + n > MAX_CONCURRENT) {
    throw new ComputeError(429,
      `compute at capacity: ${inflight}/${MAX_CONCURRENT} in flight, need ${n} slots — retry shortly`);
  }
  inflight += n;
}

function release() {
  inflight = Math.max(0, inflight - 1);
}

function releaseN(n) {
  inflight = Math.max(0, inflight - n);
}

/**
 * Capacity snapshot: arrival rate (trailing-60s mean + EWMA), service time
 * (p50 + p95), and the Little's-law staffing target with hysteresis.
 */
export function getCapacity() {
  const now = Date.now();
  const windowMs = 60000;
  const recent = completions.filter((c) => now - c.at < windowMs);
  const arrivalPerSec = recent.length / (windowMs / 1000);
  const ds = recent.map((c) => c.durationMs).sort((a, b) => a - b);
  const p50 = ds.length ? ds[Math.floor(ds.length * 0.5)] : 0;
  const p95 = p95DurationMs();
  const rawTarget = Math.ceil(arrivalEwma * (p95 / 1000) * SCHED_SAFETY);
  const clamped = Math.min(MAX_CONCURRENT, Math.max(MIN_WARM, rawTarget));
  // Hysteresis: adopt increases immediately; decreases only when the target
  // falls a full worker below the current desire.
  if (clamped > desiredWorkers) desiredWorkers = clamped;
  else if (clamped < desiredWorkers - 1) desiredWorkers = clamped;
  return {
    cpuCount: os.cpus().length,
    memTotalMB: Math.round(os.totalmem() / 1048576),
    maxConcurrent: MAX_CONCURRENT,
    minWarm: MIN_WARM,
    inflight,
    arrivalPerSec: Math.round(arrivalPerSec * 1000) / 1000,
    arrivalRateEwma: Math.round(arrivalEwma * 1000) / 1000,
    completedLastMin: recent.length,
    p50DurationMs: Math.round(p50),
    p95DurationMs: Math.round(p95),
    littleTargetWorkers: clamped,
    desiredWorkers,
    safetyFactor: SCHED_SAFETY,
    sampleCount: completions.length,
    // The scheduler computes the staffing target; it does not actuate.
    // Enforcement is the 429 admission bound. Autoscaling workers from this
    // target is scoped out — see docs/KILN_COMPUTE_RUNTIME.md §5.
    autoscaling: false,
  };
}

function computePath(dir) {
  return join(dir, COMPUTE_FILE);
}

function loadStore(dir) {
  const p = computePath(dir);
  if (!existsSync(p)) return { invocations: {}, maps: {}, previews: {}, settleSeq: 0 };
  try {
    const s = JSON.parse(readFileSync(p, "utf8"));
    return {
      invocations: s.invocations || {},
      maps: s.maps || {},
      // previews: { [appId]: {slug, relayPort, enabled, updatedAt} } —
      // owned by lib/preview.mjs; kept here so one atomic store covers it.
      previews: s.previews || {},
      // settleSeq: high-water event seq the settlement sweep has consumed.
      settleSeq: s.settleSeq || 0,
    };
  } catch {
    return { invocations: {}, maps: {}, previews: {} };
  }
}

/** Atomic store write (tmp + rename). */
function saveStore(dir, store) {
  const p = computePath(dir);
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n");
  renameSync(tmp, p);
}

// Exported for lib/preview.mjs (single store, no duplication).
export { loadStore, saveStore };

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

function needRetries(v) {
  if (v === undefined) return 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 2) throw new ComputeError(400, "retries must be an integer 0..2");
  return n;
}

function needMemoryMB(v) {
  if (v === undefined) return 256;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 64 || n > 2048) {
    throw new ComputeError(400, "memoryMB must be an integer in 64..2048");
  }
  return n;
}

function needNetwork(v) {
  if (v === undefined) return false;
  if (typeof v !== "boolean") throw new ComputeError(400, "network must be a boolean");
  return v;
}

// ---------------------------------------------------------------- runner

/**
 * The harness that runs inside the KILN Linux sandbox (lib/sandbox.mjs):
 * fresh mount/pid/uts/ipc namespaces (net only when network:true), the
 * invocation dir bind-mounted as the only writable path, /home /root
 * (/etc when offline) hidden, JS heap capped at memoryMB, RSS supervisor
 * SIGKILLs past 2x, wall-clock timeout with SIGTERM-then-SIGKILL teeth.
 * Sibling files: fn.mjs, args.json (written by the plan), result.json
 * (output), metrics.json (self-metering: wallMs, cpuMs, peakRssBytes).
 * The sandbox parent writes sandbox.json (signal/timedOut/rssKilled/
 * heapOom) — getInvocation merges both into view.metrics, and billing
 * derives from them. CPU time is metered, not capped (see sandbox.mjs).
 */
export function runnerSource() {
  return `import { readFileSync, writeFileSync } from "node:fs";
const here = new URL(".", import.meta.url);
const read = (n) => readFileSync(new URL(n, here), "utf8");
const wallStart = Date.now();
const cpuStart = process.cpuUsage();
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
try {
  const cpu = process.cpuUsage(cpuStart);
  writeFileSync(new URL("./metrics.json", here), JSON.stringify({
    wallMs: Date.now() - wallStart,
    cpuMs: Math.round((cpu.user + cpu.system) / 1000),
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
  }));
} catch {}
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
 * The exec step runs inside the Linux sandbox (memoryMB heap cap,
 * network policy); the sandbox outcome lands in sandbox.json.
 */
export function compileInvokePlan({ invId, code, args, timeoutMs, memoryMB = 256, network = false }) {
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
        {
          tool: "shell.exec",
          args: {
            command: "node",
            args: [`${base}/runner.mjs`],
            timeoutMs: t,
            sandbox: { memoryMB, network, metricsFile: `${base}/sandbox.json` },
          },
        },
      ],
    },
  };
}

// ---------------------------------------------------------------- invoke

function resultPath(dir, nodeId, invId) {
  return join(nodeDir(dir, nodeId), "work", ".kiln_compute", invId, "result.json");
}

function sandboxPath(dir, nodeId, invId) {
  return join(nodeDir(dir, nodeId), "work", ".kiln_compute", invId, "sandbox.json");
}

function metricsPath(dir, nodeId, invId) {
  return join(nodeDir(dir, nodeId), "work", ".kiln_compute", invId, "metrics.json");
}

function readJsonFile(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Submit one function invocation. Admits against MAX_CONCURRENT first:
 * when the box is full the caller gets a 429 (with Retry-After at the
 * HTTP layer) instead of an unbounded queue.
 */
export function submitInvocation(dir, { name, code, args, timeoutMs, memoryMB, network, retries, kind = "invoke", mapId = null, _admitted = false }) {
  const memMB = needMemoryMB(memoryMB);
  const net = needNetwork(network);
  const maxRetries = needRetries(retries);
  if (!_admitted) {
    // Reconcile before deciding: jobs that completed since the last tick
    // free their slots here, so a submit right after a wait doesn't see
    // stale capacity. (The tick remains the primary settler; this is a
    // just-in-time reconciliation, idempotent and poll-free.)
    settleComputeJobs(dir);
    admit();
  }
  const invId = newInvocationId();
  let plan, t;
  try {
    ({ plan, timeoutMs: t } = compileInvokePlan({ invId, code, args, timeoutMs, memoryMB: memMB, network: net }));
  } catch (e) {
    if (!_admitted) release();
    throw e;
  }
  const job = {
    id: newJobId(),
    name: String(name || `invoke-${invId.slice(4, 10)}`),
    plan,
    mind: "script",
    compute: { invId, kind, timeoutMs: t },
  };
  const submitEv = appendEvent(dir, "submit", { job });
  const store = loadStore(dir);
  store.invocations[invId] = {
    jobId: job.id,
    name: job.name,
    kind,
    mapId,
    timeoutMs: t,
    submittedAt: submitEv.ts,
    memoryMB: memMB,
    network: net,
    retriesLeft: maxRetries,
    attempt: 1,
    createdAt: Math.floor(Date.now() / 1000),
  };
  saveStore(dir, store);
  return { invocationId: invId, jobId: job.id };
}

/** Errors worth one automatic retry: sandbox infra failed, never the function. */
function isInfraError(msg) {
  return /sandbox setup failed/i.test(String(msg || ""));
}

/**
 * Resubmit a failed invocation (attempt+1), reusing the invocation id.
 * Admission is the CALLER's job: the settlement sweep admits before calling,
 * so the retry never double-counts a slot and never jumps the queue.
 */
function retryInvocation(dir, store, invId, rec, nodeId) {
  const { plan, timeoutMs: t } = compileInvokePlan({
    invId, // reuse the invocation id; files are rewritten by the new job
    code: readFileSync(
      join(nodeDir(dir, nodeId), "work", ".kiln_compute", invId, "fn.mjs"), "utf8"),
    args: JSON.parse(readFileSync(
      join(nodeDir(dir, nodeId), "work", ".kiln_compute", invId, "args.json"), "utf8")),
    timeoutMs: rec.timeoutMs,
    memoryMB: rec.memoryMB,
    network: rec.network,
  });
  const job = {
    id: newJobId(),
    name: `${rec.name}#${rec.attempt + 1}`,
    plan,
    mind: "script",
    compute: { invId, kind: rec.kind, timeoutMs: t },
  };
  appendEvent(dir, "submit", { job });
  rec.jobId = job.id;
  rec.attempt += 1;
  rec.retriesLeft -= 1;
  rec.retryDeferred = false;
  rec.settledKey = null; // the new attempt settles on its own terminal state
  saveStore(dir, store);
}

/** Settle one attempt's scheduler accounting, exactly once. */
function settleAttempt(rec, key, durationMs) {
  if (settledIds.has(key)) return false;
  settledIds.add(key);
  rec.settledKey = key;
  release();
  if (Number.isFinite(durationMs)) noteCompletion(durationMs);
  return true;
}

/**
 * Settlement sweep: reconcile compute admission slots against ACTUAL job
 * settlement — exactly once per attempt, at completion time, never on poll.
 *
 * Scans queue events since the last sweep (persisted settleSeq high-water
 * mark). For each done/fail of a compute job it releases the attempt's
 * admission slot and records the duration for the scheduler. Failed
 * attempts with retries left and a sandbox-infra error are settled and
 * marked retryDeferred; a second pass resubmits them through admission —
 * at capacity they keep retriesLeft and wait for a later sweep instead of
 * jumping the queue.
 *
 * Called from the daemon tick (the primary path: jobs only complete under
 * a running daemon). Exported so direct library use can settle manually.
 * Idempotent: re-running settles nothing twice (settledIds + settledKey,
 * both seeded from the persisted store).
 */
export function settleComputeJobs(dir) {
  const store = loadStore(dir);
  const invs = store.invocations;
  // Seed the in-memory once-guard from persisted keys (survives restarts).
  for (const rec of Object.values(invs)) {
    if (rec.settledKey) settledIds.add(rec.settledKey);
  }
  const byJobId = new Map();
  for (const [invId, rec] of Object.entries(invs)) {
    if (rec.jobId) byJobId.set(rec.jobId, invId);
  }
  let changed = false;
  const oldSeq = store.settleSeq || 0;
  let maxSeq = oldSeq;
  if (byJobId.size) {
    for (const e of readEvents(dir)) {
      if (e.seq < oldSeq) continue;
      if (e.seq > maxSeq) maxSeq = e.seq;
      if (e.type !== "done" && e.type !== "fail") continue;
      const invId = byJobId.get(e.jobId);
      if (!invId) continue;
      const rec = invs[invId];
      const key = rec.settledKey || rec.jobId;
      if (settledIds.has(key)) continue;
      const durationMs = (Number.isFinite(e.ts) && Number.isFinite(rec.submittedAt))
        ? (e.ts - rec.submittedAt) * 1000
        : NaN;
      if (e.type === "done") {
        if (settleAttempt(rec, `${invId}:done`, durationMs)) changed = true;
      } else {
        rec.lastNode = e.node || rec.lastNode;
        const errMsg = e.error || "job failed";
        if ((rec.retriesLeft || 0) > 0 && e.node && isInfraError(errMsg)) {
          // Retryable infra failure: settle this attempt (its slot is freed
          // NOW) and defer the resubmission to the admission pass below.
          if (settleAttempt(rec, `${invId}:attempt${rec.attempt}`, NaN)) {
            rec.retryDeferred = true;
            changed = true;
          }
        } else if (settleAttempt(rec, `${invId}:failed`, durationMs)) {
          changed = true;
        }
      }
    }
  }
  // Deferred retries, in invocation-id order: resubmit through admission.
  for (const invId of Object.keys(invs).sort()) {
    const rec = invs[invId];
    if (!rec.retryDeferred) continue;
    try {
      admit(); // the retry is a fresh admission, not a free slot
    } catch {
      continue; // at capacity: keep retriesLeft, try on a later sweep
    }
    try {
      retryInvocation(dir, store, invId, rec, rec.lastNode);
      changed = true;
    } catch (err) {
      // Resubmission failed (corrupt plan files): hand the slot back and
      // stop deferring — the invocation stays terminal on its failed job.
      release();
      rec.retryDeferred = false;
      changed = true;
    }
  }
  store.settleSeq = maxSeq;
  if (changed || maxSeq !== oldSeq) saveStore(dir, store);
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
    attempt: rec.attempt || 1,
    memoryMB: rec.memoryMB ?? 256,
    network: !!rec.network,
  };
  if (job && job.submittedAt) {
    const end = job.finishedAt || Math.floor(Date.now() / 1000);
    view.durationMs = (end - job.submittedAt) * 1000;
  }
  const nodeId = job && job.node;
  const sb = nodeId ? readJsonFile(sandboxPath(dir, nodeId, invId)) : null;
  const fm = nodeId ? readJsonFile(metricsPath(dir, nodeId, invId)) : null;
  if (sb || fm) {
    const wallMs = fm?.wallMs ?? sb?.wallMs ?? view.durationMs ?? null;
    view.metrics = {
      wallMs,
      cpuMs: fm?.cpuMs ?? null,
      peakRssBytes: fm?.peakRssBytes ?? null,
      timedOut: !!sb?.timedOut,
      signal: sb?.signal ?? null,
      rssKilled: !!sb?.rssKilled,
      forkBomb: !!sb?.forkBomb,
      heapOom: !!sb?.heapOom,
      sandbox: sb?.sandbox ?? null,
    };
    if (wallMs !== null) {
      const billedMs = Math.ceil(wallMs);
      view.billing = {
        billedMs,
        memoryMB: view.memoryMB,
        // GB-seconds = seconds * (MB/1024), the serverless unit.
        gbSeconds: Math.round((billedMs / 1000) * (view.memoryMB / 1024) * 1e6) / 1e6,
      };
    }
  }
  if (status === "done") {
    const r = nodeId ? readJsonFile(resultPath(dir, nodeId, invId)) : null;
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
    // Scheduler accounting settles in the daemon tick's settleComputeJobs()
    // sweep, at actual job completion — never here on poll.
  } else if (status === "failed") {
    const errMsg = (job && job.error) || "job failed";
    view.ok = false;
    view.error = errMsg;
    // A retryable infra failure resubmits from the settlement sweep; until
    // then the attempt is terminal in this view.
    if ((rec.retriesLeft || 0) > 0 && isInfraError(errMsg)) {
      view.retryPending = !!rec.retryDeferred || (rec.attempt || 1) === 1;
    }
  }
  if ((rec.attempt || 1) > 1) view.retried = true;
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

export function submitMap(dir, { name, code, items, timeoutMs, memoryMB, network, retries }) {
  checkCode(code);
  if (!Array.isArray(items) || !items.length) {
    throw new ComputeError(400, "items must be a non-empty array");
  }
  if (items.length > MAX_ITEMS) {
    throw new ComputeError(400, `items exceeds max ${MAX_ITEMS} (raise it deliberately, not by accident)`);
  }
  const t = needTimeoutMs(timeoutMs, "map");
  const memMB = needMemoryMB(memoryMB);
  const net = needNetwork(network);
  const maxRetries = needRetries(retries);
  // Validate EVERY item before admission: a map is all-or-nothing.
  for (const item of items) checkArgs(item);
  // Reconcile before deciding (see submitInvocation): completed jobs free
  // their slots first so the atomic admission sees real capacity.
  settleComputeJobs(dir);
  // Atomic admission: all N slots or a 429 — never a partially-admitted map.
  admitN(items.length);
  const mapId = newMapId();
  const invocationIds = [];
  try {
    for (let i = 0; i < items.length; i++) {
      const { invocationId } = submitInvocation(dir, {
        name: `${name || "map"}[${i}]`,
        code,
        args: items[i],
        timeoutMs: t,
        memoryMB: memMB,
        network: net,
        retries: maxRetries,
        kind: "map-item",
        mapId,
        _admitted: true, // slots already taken atomically above
      });
      invocationIds.push(invocationId);
    }
  } catch (e) {
    // Mid-loop failure (nearly unreachable after pre-validation): release
    // only the slots for items never submitted. Submitted items keep their
    // slots and settle normally; they're traceable via their mapId.
    releaseN(items.length - invocationIds.length);
    throw e;
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

/**
 * TCP readiness probe: does 127.0.0.1:port accept a connection within
 * timeoutMs? Protocol-agnostic — "ready" means the app's port is actually
 * serving, not just that the worker process is alive.
 */
function probeTcp(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = createConnection({ host: "127.0.0.1", port, timeout: timeoutMs });
    const done = (ok) => { try { sock.destroy(); } catch {} resolve(ok); };
    sock.on("connect", () => done(true));
    sock.on("timeout", () => done(false));
    sock.on("error", () => done(false));
  });
}

export async function appStatus(dir, appId) {
  const cfg = appConfig(dir, appId); // 404 if unknown
  let workerAlive = false;
  try {
    const node = loadNode(dir, appId);
    workerAlive = !!node.workerPid;
  } catch { /* ignore */ }
  let ready = null;
  if (cfg.port && workerAlive) {
    ready = await probeTcp(cfg.port);
  }
  return {
    appId,
    name: cfg.name,
    command: cfg.command,
    port: cfg.port,
    deployedAt: cfg.deployedAt || null,
    workerAlive,
    // status reflects application readiness, not just process liveness:
    // "ready" = worker alive AND port accepting; "starting" = worker alive
    // but port not yet accepting; "down" = worker gone.
    status: !workerAlive ? "down" : ready === null ? "running" : ready ? "ready" : "starting",
    ready,
    readyCheck: cfg.port ? `tcp:127.0.0.1:${cfg.port}` : null,
  };
}

export async function listApps(dir) {
  const ids = listNodeIds(dir).filter((id) => existsSync(join(nodeDir(dir, id), "app.json")));
  const out = [];
  for (const id of ids) {
    try {
      out.push(await appStatus(dir, id));
    } catch { /* app vanished mid-list */ }
  }
  return out;
}

export function appLogs(dir, appId, tail = 100) {
  appConfig(dir, appId); // 404 if unknown
  const p = join(nodeDir(dir, appId), "app.log");
  if (!existsSync(p)) return { appId, log: "" };
  const lines = readFileSync(p, "utf8").split("\n");
  const n = Math.min(Math.max(tail, 1), 1000);
  return { appId, log: lines.slice(-n).join("\n") };
}

/** Stop an app: never respawn, SIGTERM the worker (which kills the app child).
 *
 * Micro-fix (2026-09-30): the app record (app.json) is removed too. Leaving
 * it behind made listApps keep reporting the undeployed app as "ready" on a
 * false-positive port probe. The node dir, workdir, and app.log are kept.
 * Preview teardown (if any) is handled by the httpapi DELETE path before
 * this runs.
 */
export function undeployApp(dir, appId) {
  appConfig(dir, appId); // 404 if unknown
  const node = loadNode(dir, appId);
  node.restartPolicy = "never";
  node.autostart = false;
  saveNode(dir, node);
  try {
    if (node.workerPid) process.kill(node.workerPid, "SIGTERM");
  } catch { /* already gone */ }
  try {
    unlinkSync(join(nodeDir(dir, appId), "app.json"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  return { ok: true, appId };
}
