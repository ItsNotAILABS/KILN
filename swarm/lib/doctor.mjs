#!/usr/bin/env node
/**
 * Doctor: diagnostic supervisor for the swarm daemon — KILN adapter.
 *
 * Thin KILN-specific layer over the vendored generic doctor core
 * (swarm/lib/doctor-core/, snapshot of ItsNotAILABS/doctor; see
 * doctor-core/VERSION and doctor-core/sync-from-doctor.sh — do not edit the
 * core here).
 *
 * The generic core owns the agent architecture — watcher (health probing),
 * coroner (forensic capture before recovery), detective (journal mining +
 * diagnose()), medic (recovery) — supervised by a core that restarts any
 * crashed agent. This file only holds what is KILN-specific:
 *
 *  - the KILN plugin: honest daemon health check (pid alive AND genuinely
 *    the swarm daemon AND the HTTP API answering), KILN forensic
 *    collectors, recovery through the existing `daemon watchdog` path;
 *  - KILN lifecycle: the doctor loop runs as `swarm.mjs doctor _run`
 *    (matched pid-reuse-safe via KILN_SWARM_DIR, like the daemon itself).
 *
 * Quiet by design: deaths are journaled, not announced — see
 * docs/KILN_DOCTOR.md.
 */
import { spawn } from "node:child_process";
import {
  openSync, closeSync, readFileSync, unlinkSync,
} from "node:fs";
import { loadavg, cpus } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  pidAlive, pidIsDaemon, procCmdline, heartbeatAgeMs, listNodeIds, loadNode, loadApiToken,
  writeFileAtomicSync,
} from "./state.mjs";
import { Supervisor } from "./doctor-core/supervisor.mjs";
import { diagnose } from "./doctor-core/detective.mjs";
import {
  DOCTOR_POLL_MS,
  doctorDir,
  ensureDoctorDir,
  doctorJsonPath,
  doctorLockPath,
  acquireExclusive,
  readDoctorJson,
  readDoctorState,
  writeDoctorState,
  deathsDir,
  tailLines,
  memAvailableMb,
  dmesgOom,
  psFiltered,
  dlog,
  sleep,
} from "./doctor-core/helpers.mjs";

export {
  DOCTOR_POLL_MS, doctorDir, ensureDoctorDir,
  readDoctorState,
};
export {
  journalEvent, readJournal, journalSince,
} from "./doctor-core/helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SWARM_MJS = join(HERE, "..", "swarm.mjs");

// ---------------------------------------------------------------- KILN health (the honest check)

function daemonJson(dir) {
  try { return JSON.parse(readFileSync(join(dir, "daemon.json"), "utf8")); }
  catch { return null; }
}

// ---------------------------------------------------------------- load-aware probe budget
//
// Why: 2026-11-01 the doctor returned repeated FALSE "daemon still DOWN"
// verdicts against a live daemon. Independent probes showed the daemon
// answering in 5–11s while the fixed 5s probe budget timed out under
// post-reboot load (loadavg 27–54 on a small box). The doctor then ran
// watchdog recoveries against the live pid. Two fixes, both here in the
// probe (the vendored core only ever sees the verdict):
//
//  (a) The probe budget SCALES WITH SYSTEM LOAD: loadavg relative to core
//      count stretches both the per-attempt timeout and the confirmation
//      window, proportionally, with sane caps (worst case ≈ 106s, inside
//      the core's 120s tick-lock stale window).
//  (b) A live pid + slow API is never declared down on a single budget
//      miss: the API must fail CONSECUTIVE probes spanning the whole
//      (stretched) window before daemonHealth reports up:false. A dead pid
//      is still detected instantly — the pid checks run before the API
//      stage and never wait on the window.

export const PROBE_BASE_ATTEMPT_MS = 5000;
export const PROBE_MAX_ATTEMPT_MS = 45000;
export const PROBE_BASE_WINDOW_MS = 15000;
export const PROBE_MAX_WINDOW_MS = 60000;
export const PROBE_RETRY_GAP_MS = 1000;
export const PROBE_HARD_MAX_ATTEMPTS = 12;

/** Load snapshot: 1-minute loadavg relative to core count. */
export function systemLoad() {
  const cores = Math.max(1, cpus().length || 1);
  const l1 = loadavg()[0] || 0;
  const perCore = l1 / cores;
  return { load1: l1, cores, perCore, factor: Math.max(1, perCore) };
}

function envMs(name) {
  const v = parseInt(process.env[name] || "", 10);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Resolve the probe budget. `opts.load` injects a load snapshot (tests);
 * `opts.attemptTimeoutMs` / `opts.windowMs` / `opts.retryGapMs` /
 * `opts.minAttempts` override outright; the KILN_DOCTOR_PROBE_*_MS env
 * vars are the operator/test knob when no opts are passed.
 */
export function probeBudget(opts = {}) {
  const load = opts.load || systemLoad();
  const attemptTimeoutMs = opts.attemptTimeoutMs
    ?? envMs("KILN_DOCTOR_PROBE_ATTEMPT_MS")
    ?? Math.min(PROBE_MAX_ATTEMPT_MS, Math.round(PROBE_BASE_ATTEMPT_MS * load.factor));
  const windowMs = opts.windowMs
    ?? envMs("KILN_DOCTOR_PROBE_WINDOW_MS")
    ?? Math.min(PROBE_MAX_WINDOW_MS, Math.round(PROBE_BASE_WINDOW_MS * load.factor));
  const retryGapMs = opts.retryGapMs
    ?? envMs("KILN_DOCTOR_PROBE_GAP_MS")
    ?? PROBE_RETRY_GAP_MS;
  const minAttempts = opts.minAttempts
    ?? Math.max(2, Math.ceil(windowMs / attemptTimeoutMs));
  return {
    attemptTimeoutMs,
    windowMs,
    retryGapMs,
    minAttempts,
    maxAttempts: PROBE_HARD_MAX_ATTEMPTS,
    load1: load.load1,
    cores: load.cores,
    perCore: load.perCore,
    factor: load.factor,
  };
}

function fmtLoad(b) {
  return `load1=${Number(b.load1).toFixed(2)} cores=${b.cores} perCore=${Number(b.perCore).toFixed(2)}`;
}

/**
 * True daemon health: pid alive AND genuinely the swarm daemon (pid-reuse
 * safe) AND the HTTP API answering. Mirrors `daemon status` semantics.
 *
 * The API stage is load-aware and sustained (see probeBudget above): it
 * retries consecutive failed probes across the stretched window before
 * reporting a live pid as down, and every attempt is logged to doctor.log
 * with its latency + the load at probe time, so a future incident
 * self-classifies as slow-under-load vs truly dead. The returned object
 * carries the same evidence as `probe` diagnostics on API-stage verdicts.
 * `opts` is probeBudget()'s override surface (tests / operator knobs).
 */
export async function daemonHealth(dir, opts = {}) {
  const d = daemonJson(dir);
  if (!d || !d.pid) {
    return { up: false, reason: "no daemon.json — the daemon was never started here" };
  }
  if (!pidAlive(d.pid)) {
    return { up: false, pid: d.pid, startedAt: d.startedAt, reason: `pid ${d.pid} is not alive` };
  }
  if (!pidIsDaemon(d.pid, dir)) {
    return { up: false, pid: d.pid, startedAt: d.startedAt, reason: `pid ${d.pid} alive but is not the swarm daemon (pid reuse?)` };
  }
  const apiUrl = d.apiUrl || "http://127.0.0.1:18787";
  // The token is read for the probe and never logged or printed anywhere.
  let token = null;
  try { token = loadApiToken(dir); } catch { /* probe proceeds unauthenticated */ }

  const budget = probeBudget(opts.probe || opts);
  const t0 = Date.now();
  let attempts = 0;
  let last = null; // { kind: "http", status } | { kind: "error", message }
  const diag = () => ({
    attempts,
    elapsedMs: Date.now() - t0,
    load1: budget.load1,
    cores: budget.cores,
    perCore: budget.perCore,
    attemptTimeoutMs: budget.attemptTimeoutMs,
    windowMs: budget.windowMs,
  });
  while (true) {
    attempts += 1;
    const a0 = Date.now();
    let outcome;
    try {
      const res = await fetch(apiUrl + "/health", {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(budget.attemptTimeoutMs),
      });
      outcome = res.ok
        ? { ok: true, status: res.status }
        : { ok: false, kind: "http", status: res.status, label: `http-${res.status}` };
    } catch (e) {
      const msg = String((e && e.message) || e);
      outcome = {
        ok: false, kind: "error", message: msg,
        label: /timed out|timeout|abort/i.test(msg) ? "timeout" : "error",
      };
    }
    const latencyMs = Date.now() - a0;
    dlog(dir, `probe pid=${d.pid} attempt=${attempts} result=${outcome.ok ? "up" : outcome.label} ` +
      `latencyMs=${latencyMs} ${fmtLoad(budget)} attemptTimeoutMs=${budget.attemptTimeoutMs} windowMs=${budget.windowMs}`);
    if (outcome.ok) {
      const fenced = fenceCheck(dir, d);
      if (fenced) return { up: false, pid: d.pid, startedAt: d.startedAt, reason: fenced, probe: diag() };
      return { up: true, pid: d.pid, startedAt: d.startedAt, apiUrl, probe: diag() };
    }
    last = outcome;
    const elapsedMs = Date.now() - t0;
    if ((attempts >= budget.minAttempts && elapsedMs >= budget.windowMs)
      || attempts >= budget.maxAttempts) break;
    // Identity re-check before spending more of the window: if the pid
    // died (or was recycled) mid-window, report THAT honestly right away
    // instead of burning the budget on a stranger.
    if (!pidAlive(d.pid)) {
      dlog(dir, `probe pid=${d.pid} died mid-window after ${attempts} attempt(s) spanning ${elapsedMs}ms ${fmtLoad(budget)}`);
      return { up: false, pid: d.pid, startedAt: d.startedAt, reason: `pid ${d.pid} is not alive`, probe: diag() };
    }
    if (!pidIsDaemon(d.pid, dir)) {
      dlog(dir, `probe pid=${d.pid} stopped being the daemon mid-window after ${attempts} attempt(s) spanning ${elapsedMs}ms ${fmtLoad(budget)}`);
      return { up: false, pid: d.pid, startedAt: d.startedAt, reason: `pid ${d.pid} alive but is not the swarm daemon (pid reuse?)`, probe: diag() };
    }
    await sleep(budget.retryGapMs);
  }
  // Sustained non-response: every probe across the whole stretched window
  // failed. Only NOW is a live pid declared down.
  const elapsedMs = Date.now() - t0;
  const base = last && last.kind === "http"
    ? `pid ${d.pid} alive but API returned HTTP ${last.status}`
    : `pid ${d.pid} alive but API not responding at ${apiUrl}`;
  const reason = `${base} — sustained over ${attempts} consecutive failed probe(s) spanning ${elapsedMs}ms ` +
    `(${fmtLoad(budget)}; probe window ${budget.windowMs}ms, attempt timeout ${budget.attemptTimeoutMs}ms)`;
  dlog(dir, `probe pid=${d.pid} DOWN verdict after ${attempts} attempt(s) spanning ${elapsedMs}ms: ${reason}`);
  return { up: false, pid: d.pid, startedAt: d.startedAt, reason, probe: diag() };
}

/** Daemon lock state: held / stale / free, without forcing anything. */
export function lockState(dir) {
  const lp = join(dir, "daemon.lock");
  let exists = false;
  try { readFileSync(lp); exists = true; } catch { exists = false; }
  if (!exists) return { held: false, stale: false, liveDaemon: false, recordedPid: null };
  const d = daemonJson(dir);
  const pid = d && d.pid ? d.pid : null;
  const live = pid ? pidIsDaemon(pid, dir) : false;
  return { held: true, stale: !live, liveDaemon: live, recordedPid: pid };
}

function nodeHeartbeats(dir) {
  let timeoutMs = 30000;
  try { timeoutMs = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).heartbeatTimeoutMs || 30000; }
  catch { /* default */ }
  const out = [];
  for (const id of listNodeIds(dir)) {
    let name = id, workerPid = null;
    try {
      const n = loadNode(dir, id);
      name = n.name || id;
      workerPid = n.workerPid ?? null;
    } catch { /* unreadable node record — still report what we can */ }
    let ageMs = null;
    try {
      const a = heartbeatAgeMs(dir, id);
      ageMs = Number.isFinite(a) ? a : null;
    } catch { /* no heartbeat file */ }
    const alive = workerPid ? pidAlive(workerPid) : false;
    out.push({
      id, name, workerPid, workerAlive: alive,
      heartbeatAgeMs: ageMs,
      heartbeatFresh: ageMs !== null && ageMs < timeoutMs,
    });
  }
  return out;
}

/** The daemon's tick stats (see swarm/lib/tickwatch.mjs), if it has written any. */
function readTickJson(dir) {
  try {
    const t = JSON.parse(readFileSync(join(dir, "tick.json"), "utf8"));
    if (t && typeof t === "object") return t;
  } catch { /* no tick data yet */ }
  return null;
}

// ---------------------------------------------------------------- KILN recovery path

/**
 * Recover through the EXISTING `daemon watchdog` restart path — shared via
 * the CLI, not duplicated. Returns a result the medic journals verbatim
 * (extra fields pass through to the journal untouched).
 */
function kilnRecover(dir) {
  return new Promise((resolve) => {
    let timedOut = false;
    const p = spawn(process.execPath, [SWARM_MJS, "daemon", "watchdog", "--dir", dir], {
      env: { ...process.env, KILN_SWARM_DIR: dir },
    });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => { stdout += d; });
    p.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => {
      timedOut = true;
      try { p.kill("SIGKILL"); } catch { /* best effort */ }
    }, 90000);
    p.on("error", (e) => {
      clearTimeout(timer);
      resolve({
        ok: false, method: "daemon-watchdog", watchdogExit: -1,
        watchdogCrashLoop: false, crashLoop: false, timedOut,
        watchdogTail: String((e && e.message) || e).slice(-600), spawnError: true,
      });
    });
    p.on("close", (status) => {
      clearTimeout(timer);
      const out = stdout + stderr;
      const crashLoop = status !== 0 && /crash loop/i.test(out);
      const m = out.match(/daemon restarted pid=(\d+)/);
      resolve({
        ok: status === 0,
        pid: m ? parseInt(m[1], 10) : null,
        method: "daemon-watchdog",
        watchdogExit: status,
        watchdogCrashLoop: crashLoop,
        crashLoop,
        timedOut,
        watchdogTail: out.slice(-600),
      });
    });
  });
}

// ---------------------------------------------------------------- the KILN plugin

function kilnPlugin(dir) {
  return {
    name: "kiln-swarm-daemon",
    subject: "daemon",
    dir,
    logHint: join(dir, "daemon.log"),
    healthCheck: (d) => daemonHealth(d || dir),
    collectors: {
      daemonLogTail: (d) => tailLines(join(d, "daemon.log"), 200),
      watchdogLogTail: (d) => tailLines(join(d, "watchdog.log"), 20),
      ps: () => psFiltered(),
      lock: (d) => lockState(d),
      nodes: (d) => nodeHeartbeats(d),
      heartbeats: (d) => nodeHeartbeats(d).map((n) => ({
        name: n.name, workerAlive: n.workerAlive, heartbeatFresh: n.heartbeatFresh,
      })),
      memory: () => memAvailableMb(),
      oom: () => dmesgOom(),
      tick: (d) => readTickJson(d),
    },
    lockProbe: (d) => {
      const lk = lockState(d || dir);
      return { held: lk.held, stale: lk.stale, live: lk.liveDaemon };
    },
    recover: async (d) => {
      const t0 = Date.now();
      const res = await kilnRecover(d || dir);
      if (res.ok) {
        // The watchdog has exited; give the fresh daemon a beat to write
        // daemon.json, then stamp the recovery fence so out-of-band starts
        // are fenced from now on.
        const tdir = d || dir;
        for (let i = 0; i < 20; i++) {
          const dj = daemonJson(tdir);
          if (dj && dj.bootId && Date.parse(dj.startedAt || 0) >= t0 - 1000) {
            stampFence(tdir);
            break;
          }
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      return res;
    },
  };
}

// ---------------------------------------------------------------- KILN lifecycle

/** True if pid is a live doctor loop for this state dir (pid-reuse safe). */
export function pidIsDoctor(pid, dir) {
  if (!pidAlive(pid)) return false;
  const r = procCmdline(pid);
  if (r.status === "vanished") return false; // TOCTOU: died between the checks
  if (r.status === "unreadable") return pidAlive(pid); // /proc unavailable: fall back
  const cmd = r.cmd;
  if (!cmd.includes("swarm.mjs") || !cmd.includes("doctor")) return false;
  try {
    const env = readFileSync(`/proc/${pid}/environ`, "utf8");
    if (!env.includes(`KILN_SWARM_DIR=${dir}\0`)) return false;
  } catch { /* environ unreadable — cmdline match is enough */ }
  return true;
}

// ---------------------------------------------------------------- single recovery authority + fencing (Grade 0)
//
// The doctor supervisor is the ONLY authority that may (re)start the daemon
// for a state dir: supervision ticks are serialized by the doctor tick lock
// and the medic is the only code path that restarts the daemon. To fence
// out-of-band starts (a human or another tool launching daemon.mjs by hand),
// every doctor-driven recovery stamps the fresh daemon's bootId into doctor
// state as expectedBootId. daemonHealth() then reports a RUNNING daemon
// whose bootId does not match as DOWN ("fenced"), so the next tick restarts
// it through the authority instead of adopting a stranger.

/** Stamp the recovery fence after a doctor-driven recovery. */
function stampFence(dir) {
  const d = daemonJson(dir);
  if (!d || !d.bootId) return;
  const st = readDoctorState(dir);
  writeDoctorState(dir, { ...st, expectedBootId: d.bootId, expectedStartId: d.startId ?? null });
}

/**
 * Fence check for a daemon that otherwise looks alive. Returns a reason
 * string when the daemon was started outside the recovery authority, or
 * null when the fence passes (or is not yet established / not applicable).
 */
function fenceCheck(dir, d) {
  const st = readDoctorState(dir);
  if (!st || !st.expectedBootId) return null; // fence not yet established
  if (!d.bootId) return null; // daemon.json predates fencing — grandfathered
  if (d.bootId !== st.expectedBootId) {
    return `fenced: daemon bootId ${d.bootId} != recovery authority's ${st.expectedBootId} — started outside the doctor`;
  }
  return null;
}

class KilnSupervisor extends Supervisor {
  pidIsDoctor(pid) {
    return pidIsDoctor(pid, this.dir);
  }

  /**
   * Tick wrapper: log every tick's duration + the load it ran under into
   * doctor.log (the core tick itself is untouched). After the 2026-11-01
   * false-DOWN incident, a tick's cost and the box's load at the time are
   * the evidence that separates slow-under-load from truly dead.
   */
  async tick(opts) {
    const t0 = Date.now();
    const res = await super.tick(opts);
    const load = systemLoad();
    this.log(`tick: durationMs=${Date.now() - t0} healthy=${!!(res && res.healthy)} ` +
      `skipped=${!!(res && res.skipped)} load1=${load.load1.toFixed(2)} cores=${load.cores} perCore=${load.perCore.toFixed(2)}`);
    return res;
  }

  /** Daemonize the poll loop as `swarm.mjs doctor _run` (KILN's CLI). */
  start() {
    ensureDoctorDir(this.dir);
    if (this.alive()) {
      const d = readDoctorJson(this.dir);
      return { already: true, pid: d.pid };
    }
    // Reclaim a stale lock left by a crashed loop.
    if (!acquireExclusive(doctorLockPath(this.dir))) {
      try { unlinkSync(doctorLockPath(this.dir)); } catch { /* best effort */ }
      if (!acquireExclusive(doctorLockPath(this.dir))) {
        throw new Error("doctor: could not acquire doctor.lock");
      }
      this.log("reclaimed stale doctor lock");
    }
    const out = openSync(join(this.dir, "doctor", "doctor.log"), "a");
    const child = spawn(process.execPath, [SWARM_MJS, "doctor", "_run", "--dir", this.dir], {
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env, KILN_SWARM_DIR: this.dir },
    });
    child.unref();
    closeSync(out);
    writeFileAtomicSync(doctorJsonPath(this.dir), JSON.stringify({
      pid: child.pid,
      startedAt: new Date().toISOString(),
    }) + "\n");
    this.log(`doctor started pid=${child.pid}`);
    return { already: false, pid: child.pid };
  }
}

function kilnSupervisor(dir) {
  return new KilnSupervisor({ plugin: kilnPlugin(dir), dir });
}

export function doctorStart(dir) { return kilnSupervisor(dir).start(); }
export function doctorStop(dir) { return kilnSupervisor(dir).stop(); }
export function doctorAlive(dir) { return kilnSupervisor(dir).alive(); }
export async function doctorRun(dir) { await kilnSupervisor(dir).run(); }
export async function doctorCheck(dir) { return kilnSupervisor(dir).check(); }
export async function doctorTick(dir, opts) { return kilnSupervisor(dir).tick(opts); }

/** Per-agent states from the loop's persisted supervision state. */
export function doctorAgents(dir) {
  const st = readDoctorState(dir);
  const errs = st.agentErrors || {};
  const dead = st.agentDead || {};
  return ["watcher", "coroner", "detective", "medic"].map((name) => ({
    name,
    state: dead[name] ? "retired" : errs[name] ? `errors:${errs[name]}` : "ok",
  }));
}

export { diagnose }; // sync — same contract as the old doctor.mjs

/**
 * Capture a forensic bundle for a dead daemon, preserving KILN's historical
 * bundle shape (dmesgOom / memAvailableMb top-level keys) and the historical
 * SYNC contract (KILN's collectors are all synchronous). The derivation
 * logic mirrors core/coroner.mjs — the generic core is canonical for new
 * code; this exists so the doctorTick path and existing callers keep working
 * unchanged. `death` is {ts, pid, startedAt, reason, uptimeSec?}.
 */
export function captureDeathBundle(dir, death) {
  ensureDoctorDir(dir);
  const plugin = kilnPlugin(dir);
  const deathCtx = {
    ts: death.ts ?? new Date().toISOString(),
    pid: death.pid ?? null,
    startedAt: death.startedAt ?? null,
    reason: death.reason ?? "health check reported down",
    uptimeSec: death.uptimeSec ?? (death.startedAt
      ? Math.max(0, Math.round((Date.now() - Date.parse(death.startedAt)) / 1000))
      : null),
  };
  const out = {};
  for (const [name, fn] of Object.entries(plugin.collectors)) {
    try { out[name] = fn(dir, deathCtx); }
    catch (e) { out[name] = { __collectorError: String((e && e.message) || e) }; }
  }
  // Derivations mirror core/coroner.mjs's reserved-key handling.
  const oom = out.oom;
  const oomEvidence = !!(oom && oom.available && Array.isArray(oom.lines) && oom.lines.length > 0);
  const hb = Array.isArray(out.heartbeats) ? out.heartbeats : [];
  const preDeathStaleWorkers = hb
    .filter((n) => n && n.workerAlive && !n.heartbeatFresh)
    .map((n) => n.name)
    .filter(Boolean);
  const tick = out.tick && typeof out.tick === "object" ? out.tick : null;
  const lastTickEndMs = tick ? tick.lastTickEndMs : null;
  const lastTickAgeMs = Number.isFinite(lastTickEndMs) ? Date.now() - lastTickEndMs : null;
  const memAvailable = Number.isFinite(out.memory) ? out.memory : memAvailableMb();

  const ev = {
    ts: deathCtx.ts,
    type: "death",
    pid: deathCtx.pid,
    startedAt: deathCtx.startedAt,
    reason: deathCtx.reason,
    uptimeSec: deathCtx.uptimeSec,
    memAvailableMb: memAvailable,
    preDeathStaleWorkers,
    oomEvidence,
    lastTickAgeMs,
    bundle: null, // filled in after the bundle file is written
  };
  const bundle = {
    capturedAt: new Date().toISOString(),
    death: { ...ev },
    daemonLogTail: out.daemonLogTail,
    watchdogLogTail: out.watchdogLogTail,
    ps: out.ps,
    memAvailableMb: memAvailable,
    dmesgOom: out.oom,
    oomEvidence,
    lock: out.lock,
    nodes: out.nodes,
    tick,
    preDeathStaleWorkers,
    lastTickAgeMs,
  };
  const fname = ev.ts.replace(/[:.]/g, "-") + ".json";
  const path = join(deathsDir(dir), fname);
  bundle.death.bundle = path;
  writeFileAtomicSync(path, JSON.stringify(bundle, null, 2) + "\n");
  // NOTE: unlike the generic core's coroner, this does NOT journal the death
  // event — the old KILN contract journals in the tick path (doctorTick),
  // and callers (including tests) journal explicitly when they need to.
  return { path, bundle };
}
