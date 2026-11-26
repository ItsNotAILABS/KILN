/**
 * KILN virtual computers — a persistent, per-agent machine with a real
 * desktop and browser that agents drive, and that the owner can take over
 * for the parts only a human can do (sign-ins, device codes, 2FA,
 * captchas). Modeled on the agent box KILN's own operators run on.
 *
 * One record per computer at <stateDir>/vcomputers/<id>/computer.json;
 * the backend (vcomputer-backends.mjs) owns the actual machine. This
 * module is the control plane: lifecycle, screenshot / input / shell
 * exec / background jobs, hand-off (vcomputer-handoff.mjs), idle
 * shutdown, disk accounting, and health for the doctor.
 *
 * Secrets rule: text the agent types (`type`) is passed to xdotool on
 * stdin and never logged (the activity log records only its length);
 * nothing the owner types during a hand-off ever passes through KILN
 * (VNC -> X server); the hand-off token is stored only as a sha256; the
 * one-time VNC password lives in daemon memory and a file x11vnc deletes
 * on read. While a hand-off is open the agent is locked out (423) of
 * screenshot, input and exec so it can't read a code off the screen.
 */
import {
  existsSync, mkdirSync, readFileSync, readdirSync, appendFileSync, statSync, renameSync, rmSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { writeFileAtomicSync } from "./state.mjs";
import {
  VcError, makeBackends, shellArgv, JOB_WRAPPER, JOB_STATUS_SCRIPT, JOB_KILL_SCRIPT,
} from "./vcomputer-backends.mjs";
import {
  createHandoff, applyHandoffEvent, expireIfDue, isOpen, publicHandoff, tokenMatches,
  HandoffError,
} from "./vcomputer-handoff.mjs";

export { VcError, HandoffError };

export const VC_ID_RE = /^vc_[0-9a-f]{12}$/;
export const JOB_ID_RE = /^job_[0-9a-f]{12}$/;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const LIMITS = Object.freeze({
  width: [640, 3840], height: [480, 2160],
  cpus: [0.25, 16], memoryMB: [512, 65536], diskMB: [512, 1048576],
  idleTimeoutSec: [0, 7 * 86400], pidsLimit: [64, 32768],
  execTimeoutMs: [1000, 600000],
});
export const DEFAULTS = Object.freeze({
  width: 1280, height: 800, cpus: 2, memoryMB: 4096, diskMB: 20480,
  idleTimeoutSec: 1800, pidsLimit: 4096, browser: true, network: true,
});
const MAX_COMMAND = 64 * 1024;
const MAX_TYPE = 10000;
const MAX_JOBS_KEPT = 50;
const ACTIVITY_MAX_BYTES = 1024 * 1024;

// ---------------------------------------------------------------- module state

let BACKENDS = makeBackends();
/** For tests: swap in backends (e.g. a local backend with allow:true). */
export function setBackends(b) { BACKENDS = b; }
export function getBackends() { return BACKENDS; }

/** handoffId -> one-time VNC password (memory only; regenerated if lost). */
const vncPasswords = new Map();
/** vcId -> promise chain, serializing lifecycle operations per computer. */
const locks = new Map();

function withLock(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(id, next.finally(() => { if (locks.get(id) === next) locks.delete(id); }));
  return next;
}

// ---------------------------------------------------------------- storage

export function vcRoot(dir) { return join(dir, "vcomputers"); }
function vcBase(dir, id) { return join(vcRoot(dir), id); }
function vcPath(dir, id) { return join(vcBase(dir, id), "computer.json"); }

function checkId(id) {
  if (!VC_ID_RE.test(String(id))) throw new VcError(404, `no such virtual computer ${JSON.stringify(id)}`);
}

export function loadVc(dir, id) {
  checkId(id);
  const p = vcPath(dir, id);
  if (!existsSync(p)) throw new VcError(404, `no such virtual computer ${id}`);
  const vc = JSON.parse(readFileSync(p, "utf8"));
  vc.baseDir = vcBase(dir, id);
  return vc;
}

function saveVc(dir, vc) {
  const { baseDir, ...rec } = vc;
  writeFileAtomicSync(vcPath(dir, vc.id), JSON.stringify(rec, null, 2) + "\n", { mode: 0o600 });
}

/** Synchronous read-modify-write: never clobbers a newer record across an await. */
function updateVc(dir, id, fn) {
  const vc = loadVc(dir, id);
  const r = fn(vc);
  saveVc(dir, vc);
  return r === undefined ? vc : r;
}

export function listVcIds(dir) {
  const root = vcRoot(dir);
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((d) => VC_ID_RE.test(d) && existsSync(vcPath(dir, d))).sort();
}

export function resolveVc(dir, idOrName) {
  if (VC_ID_RE.test(String(idOrName))) return loadVc(dir, idOrName);
  for (const id of listVcIds(dir)) {
    const vc = loadVc(dir, id);
    if (vc.name === idOrName) return vc;
  }
  throw new VcError(404, `no such virtual computer ${JSON.stringify(idOrName)}`);
}

function activity(vc, entry) {
  try {
    const p = join(vc.baseDir, "activity.jsonl");
    try { if (statSync(p).size > ACTIVITY_MAX_BYTES) renameSync(p, p + ".1"); } catch {}
    appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 });
  } catch { /* activity log is best-effort, never breaks control */ }
}

// ---------------------------------------------------------------- validation

function num(v, [lo, hi], what, { int = true } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n) || (int && !Number.isInteger(n)) || n < lo || n > hi) {
    throw new VcError(400, `${what} must be ${int ? "an integer" : "a number"} in ${lo}..${hi}`);
  }
  return n;
}

export function normalizeSpec(spec = {}) {
  const name = spec.name;
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new VcError(400, "name must be 1-40 chars of a-z, 0-9 and '-', starting with a letter or digit");
  }
  const backend = spec.backend ?? process.env.KILN_VC_BACKEND ?? "docker";
  if (!["docker", "local"].includes(backend)) throw new VcError(400, "backend must be docker or local");
  const pick = (k, opts) => (spec[k] === undefined ? DEFAULTS[k] : num(spec[k], LIMITS[k], k, opts));
  const bool = (k) => {
    if (spec[k] === undefined) return DEFAULTS[k];
    if (typeof spec[k] !== "boolean") throw new VcError(400, `${k} must be a boolean`);
    return spec[k];
  };
  return {
    name, backend,
    config: {
      width: pick("width"), height: pick("height"),
      cpus: pick("cpus", { int: false }), memoryMB: pick("memoryMB"), diskMB: pick("diskMB"),
      idleTimeoutSec: pick("idleTimeoutSec"), pidsLimit: pick("pidsLimit"),
      browser: bool("browser"), network: bool("network"),
    },
  };
}

// ---------------------------------------------------------------- views

export function vcView(vc, status) {
  const h = vc.handoff ? publicHandoff(vc.handoff) : null;
  const backend = BACKENDS[vc.backend];
  return {
    id: vc.id, name: vc.name, backend: vc.backend,
    isolation: backend ? backend.isolation : "unknown",
    status: status ?? vc.status,
    desired: vc.desired,
    config: vc.config,
    createdAt: vc.createdAt, startedAt: vc.startedAt ?? null, stoppedAt: vc.stoppedAt ?? null,
    stoppedReason: vc.stoppedReason ?? null,
    lastActivityAt: vc.lastActivityAt,
    usage: vc.usage || { diskBytes: null, measuredAt: null, overQuota: false },
    control: h && isOpen(h) ? "owner" : "agent",
    handoff: h,
  };
}

async function liveStatus(vc) {
  const b = BACKENDS[vc.backend];
  if (!b) return "unknown";
  let live;
  try { live = await b.status(vc); } catch { return "unknown"; }
  if (vc.status === "stopping") return "stopping";
  return live;
}

// ---------------------------------------------------------------- lifecycle

export async function createComputer(dir, spec) {
  const s = normalizeSpec(spec);
  for (const id of listVcIds(dir)) {
    if (loadVc(dir, id).name === s.name) throw new VcError(409, `a virtual computer named ${s.name} already exists`);
  }
  const b = BACKENDS[s.backend];
  const av = b.available();
  if (!av.ok) throw new VcError(503, av.reason);
  const id = "vc_" + randomBytes(6).toString("hex");
  mkdirSync(vcBase(dir, id), { recursive: true, mode: 0o700 });
  const now = Date.now();
  const vc = {
    id, name: s.name, backend: s.backend, config: s.config,
    status: "stopped", desired: "running",
    createdAt: now, startedAt: null, stoppedAt: null, stoppedReason: null,
    lastActivityAt: now, runtime: {}, usage: { diskBytes: 0, measuredAt: null, overQuota: false },
    handoff: null, handoffHistory: [], jobs: [],
  };
  saveVc(dir, vc);
  activity({ ...vc, baseDir: vcBase(dir, id) }, { action: "create", backend: s.backend });
  return startComputer(dir, id);
}

export async function listComputers(dir) {
  const out = [];
  for (const id of listVcIds(dir)) {
    const vc = loadVc(dir, id);
    out.push(vcView(vc, await liveStatus(vc)));
  }
  return out;
}

export async function getComputer(dir, id) {
  const vc = loadVc(dir, id);
  expireIfDue(vc.handoff);
  return vcView(vc, await liveStatus(vc));
}

function takenDisplays(dir, exceptId) {
  const s = new Set();
  for (const id of listVcIds(dir)) {
    if (id === exceptId) continue;
    const d = loadVc(dir, id).runtime?.display;
    if (d) s.add(d);
  }
  return s;
}

export function startComputer(dir, id) {
  checkId(id);
  return withLock(id, async () => {
    const vc = loadVc(dir, id);
    if (vc.usage?.overQuota) {
      throw new VcError(507, `${vc.name} is over its ${vc.config.diskMB}MB disk quota — free space (exec still works) or raise diskMB before starting`);
    }
    const b = BACKENDS[vc.backend];
    const runtime = await b.start(vc, { takenDisplays: takenDisplays(dir, id) });
    updateVc(dir, id, (v) => {
      v.runtime = { ...v.runtime, ...runtime };
      v.status = "running"; v.desired = "running";
      v.startedAt = Date.now(); v.stoppedReason = null; v.lastActivityAt = Date.now();
    });
    activity(vc, { action: "start" });
    return getComputer(dir, id);
  });
}

export function stopComputer(dir, id, { reason = "requested" } = {}) {
  checkId(id);
  return withLock(id, async () => {
    const vc = loadVc(dir, id);
    if (vc.handoff && isOpen(vc.handoff)) {
      endHandoffSync(dir, id, { type: "cancel", by: "operator" });
      vncPasswords.delete(vc.handoff.id);
    }
    // Record intent first so a concurrent reader sees "stopping" with its
    // reason, never a dead session that looks like a crash.
    updateVc(dir, id, (v) => {
      v.status = "stopping"; v.stoppedReason = reason;
      v.desired = reason === "idle" ? "running" : "stopped";
    });
    try {
      await BACKENDS[vc.backend].stop(vc);
    } catch (e) {
      updateVc(dir, id, (v) => { v.status = "running"; });
      throw e;
    }
    updateVc(dir, id, (v) => {
      v.status = "stopped"; v.desired = reason === "idle" ? "running" : "stopped";
      v.stoppedAt = Date.now(); v.stoppedReason = reason;
      if (v.runtime) delete v.runtime.vnc;
    });
    activity(vc, { action: "stop", reason });
    return getComputer(dir, id);
  });
}

export function deleteComputer(dir, id, { purge = false } = {}) {
  checkId(id);
  return withLock(id, async () => {
    const vc = loadVc(dir, id);
    await BACKENDS[vc.backend].destroy(vc, { purge });
    if (vc.handoff) vncPasswords.delete(vc.handoff.id);
    if (purge) {
      rmSync(vcBase(dir, id), { recursive: true, force: true });
    } else {
      // Keep the home (local dir / docker volume) recoverable; retire the record.
      renameSync(vcPath(dir, id), vcPath(dir, id) + `.deleted-${Date.now()}`);
    }
    return { ok: true, id, purged: purge };
  });
}

// ---------------------------------------------------------------- control

/** Load a computer the AGENT may drive right now: running, not handed off. */
async function forAgent(dir, id) {
  const vc = loadVc(dir, id);
  if (vc.handoff && expireIfDue(vc.handoff)) {
    await finishHandoff(dir, id);
  } else if (vc.handoff && isOpen(vc.handoff)) {
    throw new VcError(423, `the owner has control of ${vc.name} (hand-off ${vc.handoff.id}: "${vc.handoff.reason}") — wait with GET /v1/vcomputers/${id}/handoff?waitMs=60000`);
  }
  const fresh = loadVc(dir, id);
  if ((await liveStatus(fresh)) !== "running") {
    throw new VcError(409, `${fresh.name} is not running — POST /v1/vcomputers/${id}/start first`);
  }
  updateVc(dir, id, (v) => { v.lastActivityAt = Date.now(); });
  return fresh;
}

export async function screenshot(dir, id) {
  const vc = await forAgent(dir, id);
  const { width, height } = vc.config;
  const r = await BACKENDS[vc.backend].exec(vc, [
    "ffmpeg", "-loglevel", "error", "-f", "x11grab", "-video_size", `${width}x${height}`,
    "-i", vc.runtime.display, "-frames:v", "1", "-f", "image2", "-c:v", "png", "-",
  ], { timeoutMs: 20000, binary: true, maxBytes: 64 * 1024 * 1024 });
  if (r.code !== 0 || !r.stdout.length) {
    throw new VcError(500, `screenshot failed: ${r.stderr.trim().slice(0, 300) || "no image"}`);
  }
  activity(vc, { action: "screenshot" });
  return { png: r.stdout, width, height };
}

function coord(a, kx, kn, size) {
  if (a[kx] !== undefined) {
    const v = Number(a[kx]);
    if (!Number.isInteger(v) || v < 0 || v >= size) throw new VcError(400, `${kx} must be an integer pixel in 0..${size - 1}`);
    return v;
  }
  if (a[kn] !== undefined) {
    const v = Number(a[kn]);
    // SCREEN-KERNEL convention (vLaptop): 0..1 of the visible frame; outside is refused.
    if (!Number.isFinite(v) || v < 0 || v > 1) throw new VcError(400, `${kn} must be in 0..1`);
    return Math.round(v * (size - 1));
  }
  return undefined;
}

function point(a, { width, height }, suffix = "") {
  const x = coord(a, "x" + suffix, "nx" + suffix, width);
  const y = coord(a, "y" + suffix, "ny" + suffix, height);
  if ((x === undefined) !== (y === undefined)) throw new VcError(400, `give both x${suffix}/y${suffix} (or nx${suffix}/ny${suffix})`);
  return x === undefined ? null : [x, y];
}

const KEY_RE = /^[A-Za-z0-9_]+(\+[A-Za-z0-9_]+)*$/;
const BUTTONS = { left: 1, middle: 2, right: 3 };

/**
 * Pure: an input action -> the xdotool argv (and stdin) that performs it.
 *   move {x,y|nx,ny}
 *   click {x,y?, button?: left|middle|right, count?: 1..3}
 *   type {text}            text goes on stdin, never argv / logs
 *   key {keys: "ctrl+l" | ["ctrl+l","Return"]}
 *   scroll {x,y?, dx?, dy?}  wheel notches (dy>0 = down)
 *   drag {x,y -> x2,y2}
 */
export function inputToXdotool(a, size) {
  if (!a || typeof a !== "object") throw new VcError(400, "body must be an input action object");
  const p = point(a, size);
  const move = p ? ["mousemove", String(p[0]), String(p[1])] : [];
  switch (a.action) {
    case "move":
      if (!p) throw new VcError(400, "move needs x,y or nx,ny");
      return { argv: ["xdotool", ...move] };
    case "click": {
      const button = BUTTONS[a.button ?? "left"];
      if (!button) throw new VcError(400, "button must be left, middle or right");
      const count = a.count === undefined ? 1 : num(a.count, [1, 3], "count");
      return { argv: ["xdotool", ...move, "click", "--repeat", String(count), "--delay", "80", String(button)] };
    }
    case "type": {
      if (typeof a.text !== "string" || !a.text.length) throw new VcError(400, "type needs non-empty text");
      if (a.text.length > MAX_TYPE) throw new VcError(400, `text is longer than ${MAX_TYPE} characters`);
      const clickFirst = p ? [...move, "click", "1"] : [];
      return {
        argv: clickFirst.length ? ["xdotool", ...clickFirst] : null,
        typeArgv: ["xdotool", "type", "--delay", "12", "--file", "-"],
        stdin: a.text,
      };
    }
    case "key": {
      const keys = Array.isArray(a.keys) ? a.keys : typeof a.keys === "string" ? a.keys.split(/\s+/).filter(Boolean) : [];
      if (!keys.length || keys.length > 20) throw new VcError(400, "key needs keys: \"ctrl+l\" or a list of up to 20 key combos");
      for (const k of keys) if (!KEY_RE.test(k)) throw new VcError(400, `bad key combo ${JSON.stringify(k)} — X keysyms joined with '+', e.g. ctrl+shift+t, Return`);
      return { argv: ["xdotool", ...move, "key", "--delay", "40", "--", ...keys] };
    }
    case "scroll": {
      const dx = a.dx === undefined ? 0 : num(a.dx, [-50, 50], "dx");
      const dy = a.dy === undefined ? 0 : num(a.dy, [-50, 50], "dy");
      if (!dx && !dy) throw new VcError(400, "scroll needs dx and/or dy (wheel notches; dy>0 scrolls down)");
      const argv = ["xdotool", ...move];
      if (dy) argv.push("click", "--repeat", String(Math.abs(dy)), "--delay", "30", dy > 0 ? "5" : "4");
      if (dx) argv.push("click", "--repeat", String(Math.abs(dx)), "--delay", "30", dx > 0 ? "7" : "6");
      return { argv };
    }
    case "drag": {
      const to = point(a, size, "2");
      if (!p || !to) throw new VcError(400, "drag needs x,y and x2,y2 (or the nx/ny forms)");
      return { argv: ["xdotool", ...move, "mousedown", "1", "sleep", "0.1", "mousemove", String(to[0]), String(to[1]), "sleep", "0.1", "mouseup", "1"] };
    }
    default:
      throw new VcError(400, "action must be one of move, click, type, key, scroll, drag");
  }
}

export async function input(dir, id, action) {
  const vc = await forAgent(dir, id);
  const plan = inputToXdotool(action, vc.config);
  const b = BACKENDS[vc.backend];
  if (plan.argv) {
    const r = await b.exec(vc, plan.argv, { timeoutMs: 15000 });
    if (r.code !== 0) throw new VcError(500, `input failed: ${r.stderr.trim().slice(0, 300)}`);
  }
  if (plan.typeArgv) {
    const r = await b.exec(vc, plan.typeArgv, { timeoutMs: 120000, input: plan.stdin });
    if (r.code !== 0) throw new VcError(500, `type failed: ${r.stderr.trim().slice(0, 200)}`);
  }
  // Never log typed text — only how much.
  activity(vc, action.action === "type"
    ? { action: "input", kind: "type", chars: action.text.length }
    : { action: "input", kind: action.action });
  return { ok: true, action: action.action };
}

// ---------------------------------------------------------------- shell exec + jobs

export async function execCommand(dir, id, body = {}) {
  const { command } = body;
  if (typeof command !== "string" || !command.trim()) throw new VcError(400, "command must be a non-empty string");
  if (command.length > MAX_COMMAND) throw new VcError(400, `command is longer than ${MAX_COMMAND} bytes`);
  if (body.cwd !== undefined && (typeof body.cwd !== "string" || !body.cwd.startsWith("/"))) {
    throw new VcError(400, "cwd must be an absolute path inside the machine");
  }
  const vc = await forAgent(dir, id);
  const b = BACKENDS[vc.backend];
  if (body.background) {
    if (vc.usage?.overQuota) throw new VcError(507, `${vc.name} is over its disk quota — free space with a foreground exec first`);
    const jobId = "job_" + randomBytes(6).toString("hex");
    await b.spawnDetached(vc, ["setsid", "bash", "-c", JOB_WRAPPER], {
      KILN_JOB_ID: jobId, KILN_JOB_CMD: command, ...(body.cwd ? { KILN_JOB_CWD: body.cwd } : {}),
    });
    updateVc(dir, id, (v) => {
      v.jobs = [...(v.jobs || []), { id: jobId, command: command.slice(0, 200), startedAt: Date.now() }].slice(-MAX_JOBS_KEPT);
    });
    activity(vc, { action: "exec", background: true, jobId, command: command.slice(0, 200) });
    return { jobId, status: "running" };
  }
  const timeoutMs = body.timeoutMs === undefined ? 60000 : num(body.timeoutMs, LIMITS.execTimeoutMs, "timeoutMs");
  const r = await b.exec(vc, shellArgv(command, timeoutMs), {
    timeoutMs: timeoutMs + 5000, cwd: body.cwd, input: typeof body.stdin === "string" ? body.stdin : undefined,
  });
  // coreutils timeout exits 124 (TERM) / 137 (KILL after -k) on expiry.
  const timedOut = r.timedOut || r.code === 124 || (r.code === 137 && r.durationMs >= timeoutMs);
  activity(vc, { action: "exec", command: command.slice(0, 200), exitCode: r.code, timedOut });
  return {
    exitCode: r.code, signal: r.signal, timedOut, truncated: r.truncated,
    stdout: r.stdout, stderr: r.stderr, durationMs: r.durationMs,
  };
}

async function jobScript(vc, script, jobId, extra = []) {
  return BACKENDS[vc.backend].exec(vc, ["bash", "-c", script, "kiln-job", jobId, ...extra], { timeoutMs: 15000 });
}

export async function getJob(dir, id, jobId, { tailBytes = 16384 } = {}) {
  if (!JOB_ID_RE.test(String(jobId))) throw new VcError(404, "no such job");
  const vc = await forAgent(dir, id);
  const meta = (vc.jobs || []).find((j) => j.id === jobId);
  if (!meta) throw new VcError(404, `no job ${jobId} on ${vc.name}`);
  const s = await jobScript(vc, JOB_STATUS_SCRIPT, jobId);
  const [state, val] = s.stdout.trim().split(/\s+/);
  const tail = Math.max(0, Math.min(1024 * 1024, Number(tailBytes) || 0));
  const log = tail
    ? (await BACKENDS[vc.backend].exec(vc, ["bash", "-c", 'tail -c "$2" "$HOME/.kiln/jobs/$1/out.log" 2>/dev/null', "kiln-job", jobId, String(tail)], { timeoutMs: 15000 })).stdout
    : "";
  return {
    ...meta,
    status: state === "exited" ? "exited" : state === "running" ? "running" : state || "unknown",
    exitCode: state === "exited" ? parseInt(val, 10) : null,
    log,
  };
}

export async function listJobs(dir, id) {
  const vc = await forAgent(dir, id);
  const out = [];
  for (const j of vc.jobs || []) {
    const s = await jobScript(vc, JOB_STATUS_SCRIPT, j.id);
    const [state, val] = s.stdout.trim().split(/\s+/);
    out.push({ ...j, status: state || "unknown", exitCode: state === "exited" ? parseInt(val, 10) : null });
  }
  return out;
}

export async function killJob(dir, id, jobId) {
  if (!JOB_ID_RE.test(String(jobId))) throw new VcError(404, "no such job");
  const vc = await forAgent(dir, id);
  if (!(vc.jobs || []).some((j) => j.id === jobId)) throw new VcError(404, `no job ${jobId} on ${vc.name}`);
  const r = await jobScript(vc, JOB_KILL_SCRIPT, jobId);
  activity(vc, { action: "job.kill", jobId });
  return { ok: r.code === 0, jobId };
}

async function runningJobCount(vc) {
  let n = 0;
  for (const j of vc.jobs || []) {
    const s = await jobScript(vc, JOB_STATUS_SCRIPT, j.id).catch(() => ({ stdout: "" }));
    if (s.stdout.startsWith("running")) n++;
  }
  return n;
}

// ---------------------------------------------------------------- hand-off

function vncPassword() {
  // RFB auth only uses the first 8 characters.
  return randomBytes(6).toString("base64url").slice(0, 8);
}

/** Agent: "a human has to do this part." Returns the owner URL exactly once. */
export function requestHandoff(dir, id, body = {}, { baseUrl }) {
  checkId(id);
  return withLock(id, async () => {
    const vc = loadVc(dir, id);
    if (vc.handoff && isOpen(vc.handoff) && !expireIfDue(vc.handoff)) {
      throw new VcError(409, `hand-off ${vc.handoff.id} is already open on ${vc.name}`);
    }
    if ((await liveStatus(vc)) !== "running") throw new VcError(409, `${vc.name} is not running`);
    const { handoff, token } = createHandoff({
      reason: body.reason, instructions: body.instructions, timeoutSec: body.timeoutSec,
    });
    const password = vncPassword();
    const vnc = await BACKENDS[vc.backend].vncStart(vc, password);
    vncPasswords.set(handoff.id, password);
    updateVc(dir, id, (v) => {
      if (v.handoff) v.handoffHistory = [...(v.handoffHistory || []), publicHandoff(v.handoff)].slice(-20);
      v.handoff = handoff;
      v.runtime = { ...v.runtime, vnc };
      v.lastActivityAt = Date.now();
    });
    activity(vc, { action: "handoff.request", handoffId: handoff.id, reason: handoff.reason });
    return {
      handoff: publicHandoff(handoff),
      url: `${baseUrl.replace(/\/+$/, "")}/handoff/${token}`,
      note: "Give this URL to the owner only. It is shown once and is not stored. While the hand-off is open you are locked out of this computer; wait with GET …/handoff?waitMs=.",
    };
  });
}

/** Shared ending: stop the viewer, forget the password, record history. */
async function finishHandoff(dir, id) {
  const vc = loadVc(dir, id);
  if (vc.handoff) vncPasswords.delete(vc.handoff.id);
  try { await BACKENDS[vc.backend].vncStop(vc); } catch { /* machine may be down */ }
  updateVc(dir, id, (v) => {
    expireIfDue(v.handoff); // persist an expiry computed on another copy
    if (v.runtime) delete v.runtime.vnc;
    v.lastActivityAt = Date.now();
  });
  activity(vc, { action: "handoff.end", handoffId: vc.handoff?.id, state: loadVc(dir, id).handoff?.state });
}

function endHandoffSync(dir, id, event) {
  return updateVc(dir, id, (v) => publicHandoff(applyHandoffEvent(v.handoff, event)));
}

export async function cancelHandoff(dir, id, by = "agent") {
  const vc = loadVc(dir, id);
  if (!vc.handoff || !isOpen(vc.handoff)) throw new VcError(409, `${vc.name} has no open hand-off`);
  const h = endHandoffSync(dir, id, { type: "cancel", by });
  await finishHandoff(dir, id);
  return h;
}

/** Agent: current hand-off; with waitMs, block until it is no longer open. */
export async function getHandoff(dir, id, { waitMs = 0 } = {}) {
  const w = num(waitMs, [0, 300000], "waitMs");
  const t0 = Date.now();
  for (;;) {
    const vc = loadVc(dir, id);
    if (vc.handoff && expireIfDue(vc.handoff)) { saveVc(dir, vc); await finishHandoff(dir, id); continue; }
    if (!vc.handoff || !isOpen(vc.handoff) || Date.now() - t0 >= w) {
      return { control: vc.handoff && isOpen(vc.handoff) ? "owner" : "agent", handoff: publicHandoff(vc.handoff) };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** Owner side: find the open hand-off a token belongs to. */
export function findByToken(dir, token) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  for (const id of listVcIds(dir)) {
    const vc = loadVc(dir, id);
    if (vc.handoff && tokenMatches(vc.handoff, token)) return vc;
  }
  return null;
}

/**
 * Owner opened the page. Returns what the page needs: the instructions,
 * and the one-time VNC password (regenerating the viewer if the daemon
 * restarted and lost it). Throws HandoffError 410 once it has ended.
 */
export async function ownerOpen(dir, token) {
  const vc = findByToken(dir, token);
  if (!vc) throw new HandoffError(404, "this hand-off link is not valid");
  const h = updateVc(dir, vc.id, (v) => {
    if (expireIfDue(v.handoff)) return publicHandoff(v.handoff);
    return publicHandoff(applyHandoffEvent(v.handoff, { type: "open" }));
  });
  if (!isOpen(h)) { await finishHandoff(dir, vc.id); throw new HandoffError(410, `this hand-off has ${h.state === "expired" ? "expired" : "ended"}`); }
  let password = vncPasswords.get(h.id);
  if (!password) {
    password = vncPassword();
    const fresh = loadVc(dir, vc.id);
    const vnc = await BACKENDS[fresh.backend].vncStart(fresh, password);
    vncPasswords.set(h.id, password);
    updateVc(dir, vc.id, (v) => { v.runtime = { ...v.runtime, vnc }; });
  }
  return { vc: vcView(loadVc(dir, vc.id)), handoff: h, password };
}

/** The viewer endpoint for the websocket proxy (token-gated, open hand-offs only). */
export function ownerViewer(dir, token) {
  const vc = findByToken(dir, token);
  if (!vc || !isOpen(vc.handoff) || Date.now() >= vc.handoff.expiresAt) return null;
  return vc.runtime?.vnc || null;
}

/** Owner hands control back. Body is ignored beyond `outcome`. */
export async function ownerReturn(dir, token, outcome) {
  const vc = findByToken(dir, token);
  if (!vc) throw new HandoffError(404, "this hand-off link is not valid");
  const h = endHandoffSync(dir, vc.id, { type: "return", outcome });
  await finishHandoff(dir, vc.id);
  return h;
}

// ---------------------------------------------------------------- sweep (daemon tick) + health

let sweeping = false;
let lastSweep = 0;

/**
 * Housekeeping, called from the daemon tick (rate-limited to every
 * `everyMs`) and by `vc doctor`: expire hand-offs, measure disk, stop
 * idle machines. Never throws.
 */
export async function sweepComputers(dir, { now = Date.now(), everyMs = 30000, force = false } = {}) {
  if (sweeping || (!force && now - lastSweep < everyMs)) return { skipped: true };
  sweeping = true; lastSweep = now;
  const actions = [];
  try {
    for (const id of listVcIds(dir)) {
      try {
        const vc = loadVc(dir, id);
        if (vc.handoff && isOpen(vc.handoff) && now >= vc.handoff.expiresAt) {
          updateVc(dir, id, (v) => { expireIfDue(v.handoff, now); });
          await finishHandoff(dir, id);
          actions.push({ id, action: "handoff-expired" });
        }
        const status = await liveStatus(vc);
        if (status !== "running") continue;
        const measuredAt = vc.usage?.measuredAt || 0;
        if (force || now - measuredAt > 60000) {
          const bytes = await BACKENDS[vc.backend].diskUsageBytes(vc);
          const over = bytes > vc.config.diskMB * 1024 * 1024;
          updateVc(dir, id, (v) => { v.usage = { diskBytes: bytes, measuredAt: now, overQuota: over }; });
          if (over) actions.push({ id, action: "over-disk-quota", diskBytes: bytes });
        }
        const fresh = loadVc(dir, id);
        const idleMs = now - (fresh.lastActivityAt || 0);
        if (fresh.config.idleTimeoutSec > 0 && idleMs > fresh.config.idleTimeoutSec * 1000 &&
            !(fresh.handoff && isOpen(fresh.handoff))) {
          if ((await runningJobCount(fresh)) === 0) {
            await stopComputer(dir, id, { reason: "idle" });
            actions.push({ id, action: "idle-stopped", idleSec: Math.round(idleMs / 1000) });
          }
        }
      } catch (e) {
        actions.push({ id, action: "error", error: e.message });
      }
    }
  } finally {
    sweeping = false;
  }
  return { skipped: false, actions };
}

/** For the doctor: backends, image, and each computer's honest state. */
export async function vcomputerHealth(dir) {
  const backends = {};
  for (const [name, b] of Object.entries(BACKENDS)) {
    const av = b.available();
    backends[name] = { ok: av.ok, isolation: b.isolation, reason: av.reason || null, ...(b.image ? { image: b.image } : {}) };
  }
  const computers = [];
  const problems = [];
  for (const id of listVcIds(dir)) {
    const vc = loadVc(dir, id);
    const status = await liveStatus(vc);
    const view = vcView(vc, status);
    computers.push(view);
    if (vc.desired === "running" && !["running", "stopping"].includes(status) && vc.stoppedReason !== "idle") {
      problems.push(`${vc.name} (${id}) should be running but is ${status}`);
    }
    if (vc.usage?.overQuota) problems.push(`${vc.name} (${id}) is over its ${vc.config.diskMB}MB disk quota`);
    if (vc.handoff && isOpen(vc.handoff) && Date.now() >= vc.handoff.expiresAt) {
      problems.push(`${vc.name} (${id}) has an expired hand-off still open (the next sweep closes it)`);
    }
  }
  return { ok: problems.length === 0, backends, computers, problems };
}

/** Run the image's toolcheck inside one computer (pinned tool versions). */
export async function toolcheck(dir, id) {
  const vc = await forAgent(dir, id);
  const argv = vc.backend === "docker" ? ["kiln-vc-toolcheck"] : ["bash", "-c", "echo local backend uses host tools; exit 0"];
  const r = await BACKENDS[vc.backend].exec(vc, argv, { timeoutMs: 60000 });
  return { ok: r.code === 0, output: r.stdout + r.stderr };
}
