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
  openSync, closeSync, readFileSync, writeFileSync, unlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  pidAlive, pidIsDaemon, heartbeatAgeMs, listNodeIds, loadNode, loadApiToken,
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
  deathsDir,
  tailLines,
  memAvailableMb,
  dmesgOom,
  psFiltered,
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

/**
 * True daemon health: pid alive AND genuinely the swarm daemon (pid-reuse
 * safe) AND the HTTP API answering. Mirrors `daemon status` semantics.
 */
export async function daemonHealth(dir) {
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
  try {
    const res = await fetch(apiUrl + "/health", {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) return { up: true, pid: d.pid, startedAt: d.startedAt, apiUrl };
    return { up: false, pid: d.pid, startedAt: d.startedAt, reason: `pid ${d.pid} alive but API returned HTTP ${res.status}` };
  } catch {
    return { up: false, pid: d.pid, startedAt: d.startedAt, reason: `pid ${d.pid} alive but API not responding at ${apiUrl}` };
  }
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
    recover: (d) => kilnRecover(d || dir),
  };
}

// ---------------------------------------------------------------- KILN lifecycle

/** True if pid is a live doctor loop for this state dir (pid-reuse safe). */
export function pidIsDoctor(pid, dir) {
  if (!pidAlive(pid)) return false;
  try {
    const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
    if (!cmd.includes("swarm.mjs") || !cmd.includes("doctor")) return false;
    try {
      const env = readFileSync(`/proc/${pid}/environ`, "utf8");
      if (!env.includes(`KILN_SWARM_DIR=${dir}\0`)) return false;
    } catch { /* environ unreadable — cmdline match is enough */ }
    return true;
  } catch {
    return pidAlive(pid); // /proc unavailable: fall back
  }
}

class KilnSupervisor extends Supervisor {
  pidIsDoctor(pid) {
    return pidIsDoctor(pid, this.dir);
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
    writeFileSync(doctorJsonPath(this.dir), JSON.stringify({
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
  writeFileSync(path, JSON.stringify(bundle, null, 2) + "\n");
  // NOTE: unlike the generic core's coroner, this does NOT journal the death
  // event — the old KILN contract journals in the tick path (doctorTick),
  // and callers (including tests) journal explicitly when they need to.
  return { path, bundle };
}
