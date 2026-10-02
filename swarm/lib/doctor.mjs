#!/usr/bin/env node
/**
 * Doctor: diagnostic supervisor for the swarm daemon.
 *
 * The daemon dies silently from time to time (no fatal exception in
 * daemon.log, no OOM evidence) and the plain watchdog restarts it blindly —
 * which keeps the swarm up but never finds WHY. The doctor owns daemon
 * supervision instead:
 *
 *  - Own poll loop (~15s): checks true daemon health (pid alive AND api
 *    answering, via the same honest checks as `daemon status`).
 *  - ON DEATH, BEFORE restarting: captures a forensic bundle
 *    (~/.kiln-swarm/doctor/deaths/<utc-ts>.json) — daemon.log tail, ps,
 *    memory, dmesg OOM grep, lock state, per-node heartbeat ages, the dead
 *    daemon's uptime, recent watchdog outcomes.
 *  - Recovers through the EXISTING `daemon watchdog` restart path (shared,
 *    not duplicated), then verifies with a health check.
 *  - Journals every death+recovery to deaths.jsonl; `diagnose()` mines the
 *    journal for median death interval, time-of-day clustering, stale-
 *    heartbeat correlation and memory trends, and emits a leading hypothesis.
 *    Below 3 recorded deaths it returns "insufficient data" — it never
 *    fabricates a root cause.
 *
 * Quiet by design: deaths are journaled, not announced. The 5-minute cron
 * runs `doctor check`, which surfaces worker-report lines only when a death
 * was handled or a NEW hypothesis/pattern emerged; the agent layer turns
 * those into tracking entries and (per the cron's alert rules) user alerts.
 * The doctor process itself never calls out to chat.
 *
 * Layout (under <stateDir>/doctor/):
 *   doctor.json   {pid, startedAt} — the doctor's own pidfile
 *   doctor.lock   exclusive-create single-instance lock
 *   tick.lock     serializes the poll-loop tick vs an inline `check` tick
 *   doctor.log    the doctor's own log
 *   state.json    {lastHealthyTs, lastHandledDeathId, lastCheckTs,
 *                  lastHypothesisNotified}
 *   deaths.jsonl  one JSON object per death/recovery event
 *   deaths/<utc-ts>.json  forensic bundles
 */
import { spawn, execSync } from "node:child_process";
import {
  openSync, closeSync, readFileSync, writeFileSync, appendFileSync,
  existsSync, mkdirSync, readdirSync, unlinkSync, statSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  pidAlive, pidIsDaemon, heartbeatAgeMs, listNodeIds, loadNode, loadApiToken,
} from "./state.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SWARM_MJS = join(HERE, "..", "swarm.mjs");

export const DOCTOR_POLL_MS = 15000;
const TICK_LOCK_STALE_MS = 120000;
const MIN_DEATHS_FOR_DIAGNOSIS = 3;

export function doctorDir(dir) { return join(dir, "doctor"); }
function doctorJsonPath(dir) { return join(doctorDir(dir), "doctor.json"); }
function doctorLockPath(dir) { return join(doctorDir(dir), "doctor.lock"); }
function tickLockPath(dir) { return join(doctorDir(dir), "tick.lock"); }
function doctorLogPath(dir) { return join(doctorDir(dir), "doctor.log"); }
function doctorStatePath(dir) { return join(doctorDir(dir), "state.json"); }
function deathsDir(dir) { return join(doctorDir(dir), "deaths"); }
function journalPath(dir) { return join(doctorDir(dir), "deaths.jsonl"); }

export function ensureDoctorDir(dir) {
  mkdirSync(deathsDir(dir), { recursive: true });
  return doctorDir(dir);
}

function dlog(dir, ...a) {
  const line = `[doctor ${new Date().toISOString()}] ${a.map(String).join(" ")}\n`;
  try { appendFileSync(doctorLogPath(dir), line); } catch { /* best effort */ }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function tailLines(path, n) {
  try {
    const lines = readFileSync(path, "utf8").split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-n);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- own lifecycle

function readDoctorJson(dir) {
  try { return JSON.parse(readFileSync(doctorJsonPath(dir), "utf8")); }
  catch { return null; }
}

/** True if pid is a live doctor process for this state dir (pid-reuse safe). */
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

export function doctorAlive(dir) {
  const d = readDoctorJson(dir);
  return !!(d && d.pid && pidIsDoctor(d.pid, dir));
}

function acquireExclusive(path) {
  try {
    const fd = openSync(path, "wx");
    closeSync(fd);
    return true;
  } catch (e) {
    if (e.code === "EEXIST") return false;
    throw e;
  }
}

export function doctorStart(dir) {
  ensureDoctorDir(dir);
  if (doctorAlive(dir)) {
    const d = readDoctorJson(dir);
    return { already: true, pid: d.pid };
  }
  // Reclaim a stale lock the same way the daemon does.
  if (!acquireExclusive(doctorLockPath(dir))) {
    try { unlinkSync(doctorLockPath(dir)); } catch { /* best effort */ }
    if (!acquireExclusive(doctorLockPath(dir))) {
      throw new Error("doctor: could not acquire doctor.lock");
    }
    dlog(dir, "reclaimed stale doctor lock");
  }
  const out = openSync(doctorLogPath(dir), "a");
  const child = spawn(process.execPath, [SWARM_MJS, "doctor", "_run", "--dir", dir], {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, KILN_SWARM_DIR: dir },
  });
  child.unref();
  closeSync(out);
  writeFileSync(doctorJsonPath(dir), JSON.stringify({
    pid: child.pid,
    startedAt: new Date().toISOString(),
  }) + "\n");
  dlog(dir, `doctor started pid=${child.pid}`);
  return { already: false, pid: child.pid };
}

export function doctorStop(dir) {
  const d = readDoctorJson(dir);
  if (!d || !d.pid || !pidIsDoctor(d.pid, dir)) return { stopped: false, reason: "doctor not running" };
  try { process.kill(d.pid, "SIGTERM"); } catch { /* already gone */ }
  try { unlinkSync(doctorLockPath(dir)); } catch { /* the loop removes it on exit */ }
  dlog(dir, `doctor stop signaled pid=${d.pid}`);
  return { stopped: true, pid: d.pid };
}

// ---------------------------------------------------------------- daemon health (shared honest check)

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
  if (!existsSync(lp)) return { held: false, stale: false, liveDaemon: false, recordedPid: null };
  const d = daemonJson(dir);
  const pid = d && d.pid ? d.pid : null;
  const live = pid ? pidIsDaemon(pid, dir) : false;
  return { held: true, stale: !live, liveDaemon: live, recordedPid: pid };
}

// ---------------------------------------------------------------- forensics

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

function memAvailableMb() {
  try {
    const m = readFileSync("/proc/meminfo", "utf8").match(/MemAvailable:\s+(\d+)\s+kB/);
    if (m) return Math.round(parseInt(m[1], 10) / 1024);
  } catch { /* non-Linux */ }
  return null;
}

function dmesgOom() {
  try {
    const out = execSync("dmesg 2>/dev/null | grep -iE 'oom-killer|killed process|out of memory' | tail -20", {
      encoding: "utf8", timeout: 10000,
    });
    const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
    return { available: true, lines };
  } catch {
    return { available: false, lines: [] };
  }
}

function psFiltered() {
  try {
    const out = execSync("ps aux 2>/dev/null", { encoding: "utf8", timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
    const lines = out.split("\n");
    const kept = lines.filter((l, i) => i === 0 || /node|swarm|daemon/i.test(l));
    return kept.slice(0, 60);
  } catch {
    return [];
  }
}

/**
 * Capture a forensic bundle for a dead daemon. Runs BEFORE any restart, so
 * the evidence reflects the death, not the recovery.
 */
export function captureDeathBundle(dir, death) {
  ensureDoctorDir(dir);
  const nodes = nodeHeartbeats(dir);
  const dmesg = dmesgOom();
  const bundle = {
    capturedAt: new Date().toISOString(),
    death: {
      ts: death.ts,
      pid: death.pid,
      startedAt: death.startedAt,
      reason: death.reason,
      uptimeSec: death.uptimeSec,
    },
    daemonLogTail: tailLines(join(dir, "daemon.log"), 200),
    watchdogLogTail: tailLines(join(dir, "watchdog.log"), 20),
    ps: psFiltered(),
    memAvailableMb: memAvailableMb(),
    dmesgOom: dmesg,
    oomEvidence: dmesg.available && dmesg.lines.length > 0,
    lock: lockState(dir),
    nodes,
    preDeathStaleWorkers: nodes.filter((n) => n.workerAlive && !n.heartbeatFresh).map((n) => n.name),
  };
  const fname = death.ts.replace(/[:.]/g, "-") + ".json";
  const path = join(deathsDir(dir), fname);
  writeFileSync(path, JSON.stringify(bundle, null, 2) + "\n");
  dlog(dir, `captured death bundle ${path}`);
  return { path, bundle };
}

// ---------------------------------------------------------------- journal + diagnosis

export function journalEvent(dir, event) {
  ensureDoctorDir(dir);
  appendFileSync(journalPath(dir), JSON.stringify(event) + "\n");
}

export function readJournal(dir) {
  if (!existsSync(journalPath(dir))) return [];
  const events = [];
  for (const line of readFileSync(journalPath(dir), "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { events.push(JSON.parse(t)); } catch { /* skip corrupt lines */ }
  }
  return events;
}

export function journalSince(dir, sinceTs) {
  return readJournal(dir).filter((e) => {
    const t = Date.parse(e.ts);
    return Number.isFinite(t) && t > sinceTs;
  });
}

function medianOf(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 72) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * Mine the death journal for patterns. Returns a verdict:
 *  - "insufficient-data" when fewer than 3 deaths are recorded (never
 *    fabricates a root cause from thin evidence),
 *  - "hypothesis" with computed signals and a clearly-labeled leading
 *    hypothesis (a hypothesis, not a conclusion).
 */
export function diagnose(dir) {
  const deaths = readJournal(dir)
    .filter((e) => e.type === "death" && Number.isFinite(Date.parse(e.ts)))
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  if (deaths.length < MIN_DEATHS_FOR_DIAGNOSIS) {
    return {
      verdict: "insufficient-data",
      deaths: deaths.length,
      hypothesis: `insufficient data — need at least ${MIN_DEATHS_FOR_DIAGNOSIS} recorded deaths to form a hypothesis (have ${deaths.length}). The doctor keeps watching; every death is journaled.`,
    };
  }
  const ts = deaths.map((e) => Date.parse(e.ts));
  const intervals = ts.slice(1).map((t, i) => t - ts[i]);
  const medianIntervalMs = medianOf(intervals);

  const tod = new Array(24).fill(0);
  for (const t of ts) tod[new Date(t).getUTCHours()]++;
  const peakHour = tod.indexOf(Math.max(...tod));
  const clustered = tod[peakHour] >= Math.ceil(deaths.length * 0.6);

  const withStale = deaths.filter((e) => (e.preDeathStaleWorkers || []).length > 0);
  const staleFrac = withStale.length / deaths.length;
  const nameCounts = {};
  for (const e of deaths) {
    for (const n of e.preDeathStaleWorkers || []) nameCounts[n] = (nameCounts[n] || 0) + 1;
  }
  const recurring = Object.entries(nameCounts)
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([n, c]) => `${n} x${c}`);

  const mems = deaths.map((e) => e.memAvailableMb).filter((m) => Number.isFinite(m));
  const memTrendMb = mems.length >= 2 ? mems[mems.length - 1] - mems[0] : null;
  const oomDeaths = deaths.filter((e) => e.oomEvidence);

  const parts = [];
  parts.push(`${deaths.length} deaths recorded; median interval ${fmtDur(medianIntervalMs)}.`);
  parts.push(clustered
    ? `Time-of-day clustering: ${tod[peakHour]}/${deaths.length} deaths fell in the ${String(peakHour).padStart(2, "0")}:00 UTC hour.`
    : "No strong time-of-day clustering.");
  parts.push(staleFrac >= 0.5
    ? `${withStale.length}/${deaths.length} deaths were preceded by stale worker heartbeats${recurring.length ? ` (recurring: ${recurring.join(", ")})` : ""}.`
    : "Stale worker heartbeats did not consistently precede deaths.");
  parts.push(oomDeaths.length
    ? `dmesg showed OOM-killer activity in the capture window of ${oomDeaths.length} death(s).`
    : "No OOM-killer evidence in dmesg at any death.");
  if (memTrendMb !== null) {
    parts.push(`Available memory trend across deaths: ${memTrendMb >= 0 ? "+" : ""}${memTrendMb} MB (first to last).`);
  }

  let lead;
  if (oomDeaths.length > 0) {
    lead = "Leading hypothesis: the OOM killer is terminating the daemon under memory pressure. Recommend: raise VM memory or cap worker concurrency, then watch whether deaths stop.";
  } else if (staleFrac >= 2 / 3) {
    lead = "Leading hypothesis: the daemon's tick loop wedges (stale worker heartbeats precede death, no OOM evidence) — the process stops making progress without being killed. Recommend: instrument tick duration and add an internal self-abort when ticks stall.";
  } else if (clustered) {
    lead = "Leading hypothesis: an external scheduled actor (cron, host maintenance) kills the daemon at a fixed hour. Recommend: correlate death times with host cron/at logs.";
  } else {
    lead = "No single dominant signal — deaths look irregular. Recommend: keep collecting; each new death sharpens the picture.";
  }
  return {
    verdict: "hypothesis",
    deaths: deaths.length,
    medianIntervalMs,
    todHistogram: tod,
    staleHeartbeatFraction: staleFrac,
    recurringStaleWorkers: recurring,
    memTrendMb,
    oomDeaths: oomDeaths.length,
    hypothesis: parts.join(" ") + " " + lead,
  };
}

// ---------------------------------------------------------------- tick (the supervision loop body)

function readDoctorState(dir) {
  try { return JSON.parse(readFileSync(doctorStatePath(dir), "utf8")); }
  catch { return {}; }
}

function writeDoctorState(dir, state) {
  try { writeFileSync(doctorStatePath(dir), JSON.stringify(state, null, 2) + "\n"); }
  catch { /* best effort */ }
}

/** Serialize the loop tick vs an inline `check` tick. Loop skips when busy. */
function acquireTickLock(dir) {
  const p = tickLockPath(dir);
  if (acquireExclusive(p)) return true;
  try {
    const age = Date.now() - statSync(p).mtimeMs;
    if (age > TICK_LOCK_STALE_MS) {
      try { unlinkSync(p); } catch { /* best effort */ }
      return acquireExclusive(p);
    }
  } catch { /* ignore */ }
  return false;
}

function releaseTickLock(dir) {
  try { unlinkSync(tickLockPath(dir)); } catch { /* best effort */ }
}

/**
 * Recover through the EXISTING `daemon watchdog` restart path — shared via
 * the CLI, not duplicated. Returns the watchdog's outcome.
 */
function runWatchdogRestart(dir) {
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
      resolve({ status: -1, stdout, stderr: stderr + String(e.message), crashLoop: false, timedOut, spawnError: true });
    });
    p.on("close", (status) => {
      clearTimeout(timer);
      const out = stdout + stderr;
      resolve({
        status,
        stdout,
        stderr,
        crashLoop: status !== 0 && /crash loop/i.test(out),
        timedOut,
      });
    });
  });
}

export async function doctorTick(dir, { inline = false } = {}) {
  ensureDoctorDir(dir);
  if (!acquireTickLock(dir)) {
    // Another tick (loop or check) is already handling this — skip quietly.
    return { skipped: true };
  }
  try {
    const st = await daemonHealth(dir);
    const dstate = readDoctorState(dir);
    if (st.up) {
      writeDoctorState(dir, { ...dstate, lastHealthyTs: Date.now() });
      return { healthy: true, pid: st.pid };
    }
    const deathId = `${st.pid ?? "none"}|${st.startedAt ?? "none"}`;
    if (dstate.lastHandledDeathId === deathId) {
      // Same dead instance we already handled — don't re-capture or spin;
      // the watchdog's own crash-loop guard paces any further restarts.
      return { healthy: false, alreadyHandled: true, reason: st.reason };
    }
    // NEW death: forensics FIRST, restart second.
    const nowIso = new Date().toISOString();
    const death = {
      ts: nowIso,
      type: "death",
      pid: st.pid ?? null,
      startedAt: st.startedAt ?? null,
      reason: st.reason,
      uptimeSec: st.startedAt ? Math.max(0, Math.round((Date.now() - Date.parse(st.startedAt)) / 1000)) : null,
      memAvailableMb: memAvailableMb(),
    };
    const { path: bundlePath, bundle } = captureDeathBundle(dir, death);
    death.preDeathStaleWorkers = bundle.preDeathStaleWorkers;
    death.oomEvidence = bundle.oomEvidence;
    death.bundle = bundlePath;
    journalEvent(dir, death);
    dlog(dir, `daemon death recorded: ${st.reason} (bundle ${bundlePath})`);

    // Stale-lock courtesy: if a live daemon holds the lock we misdiagnosed —
    // wait a beat and re-probe rather than force anything.
    const lk = lockState(dir);
    if (lk.held && lk.liveDaemon) {
      dlog(dir, "lock held by live daemon on re-probe — waiting 10s");
      await sleep(10000);
      const st2 = await daemonHealth(dir);
      if (st2.up) {
        journalEvent(dir, { ts: new Date().toISOString(), type: "recovery", ok: true, pid: st2.pid, method: "lock-reprobe", note: "daemon alive after re-probe; no restart needed" });
        writeDoctorState(dir, { ...dstate, lastHandledDeathId: deathId, lastHealthyTs: Date.now() });
        return { healthy: true, pid: st2.pid, death };
      }
    }

    const rec = await runWatchdogRestart(dir);
    // Give the restarted daemon a moment, then verify honestly.
    await sleep(4000);
    const st3 = await daemonHealth(dir);
    const ok = st3.up;
    journalEvent(dir, {
      ts: new Date().toISOString(),
      type: "recovery",
      ok,
      pid: st3.pid ?? null,
      method: "daemon-watchdog",
      watchdogExit: rec.status,
      watchdogCrashLoop: rec.crashLoop,
      watchdogTail: (rec.stdout + rec.stderr).slice(-600),
    });
    writeDoctorState(dir, { ...dstate, lastHandledDeathId: deathId, lastRecoveryAttemptTs: Date.now() });
    dlog(dir, `recovery via watchdog: ${ok ? `ok pid=${st3.pid}` : `FAILED (${st3.reason})`} crashLoop=${rec.crashLoop}`);
    return { healthy: ok, death, recovered: ok, pid: st3.pid ?? null, reason: ok ? null : st3.reason, crashLoop: rec.crashLoop };
  } finally {
    releaseTickLock(dir);
  }
}

/**
 * `doctor check` — the cron entry point. Ensures the doctor itself is alive,
 * runs one inline supervision tick (serialized against the loop's tick via
 * the tick lock), then reports anything new since the last check: deaths,
 * recoveries, and new diagnoses. Silent (exit 0, no output) when everything
 * is healthy and nothing new happened. Exit 1 when the daemon is still DOWN
 * or the watchdog reported a crash loop — the cron's alert conditions.
 *
 * Agent-layer contract: the worker running this command reports its stdout;
 * the handler turns death/recovery lines into tracking timeline entries and
 * surfaces NEW DIAGNOSIS lines to the user. The doctor never chats itself.
 */
export async function doctorCheck(dir) {
  ensureDoctorDir(dir);
  const lines = [];
  const dstate = readDoctorState(dir);
  if (!doctorAlive(dir)) {
    const r = doctorStart(dir);
    lines.push(`doctor: was down, started pid=${r.pid}`);
  }
  const tickRes = await doctorTick(dir, { inline: true });

  const since = dstate.lastCheckTs || 0;
  const newEvents = journalSince(dir, since);
  const dstate2 = { ...readDoctorState(dir), lastCheckTs: Date.now() };
  let sawCrashLoop = false;
  for (const e of newEvents) {
    if (e.type === "death") {
      lines.push(`doctor: daemon death recorded at ${e.ts} (${e.reason})`);
    } else if (e.type === "recovery") {
      lines.push(`doctor: recovery ${e.ok ? "ok" : "FAILED"} at ${e.ts} via ${e.method || "?"}` +
        (e.ok && e.pid ? ` pid=${e.pid}` : ""));
      if (e.watchdogCrashLoop) sawCrashLoop = true;
    }
  }
  if (tickRes && tickRes.crashLoop) sawCrashLoop = true;

  const dg = diagnose(dir);
  if (dg.verdict === "hypothesis" && dg.hypothesis !== dstate2.lastHypothesisNotified) {
    lines.push(`doctor: NEW DIAGNOSIS: ${dg.hypothesis}`);
    dstate2.lastHypothesisNotified = dg.hypothesis;
  }
  writeDoctorState(dir, dstate2);

  let exitCode = 0;
  // Final honest verification, whatever path handled the recovery.
  let st = await daemonHealth(dir);
  if (!st.up && tickRes && tickRes.skipped) {
    // The loop is mid-tick — give it a beat before judging.
    await sleep(15000);
    st = await daemonHealth(dir);
  }
  if (sawCrashLoop) {
    lines.push(`doctor: crash-loop warning — the daemon keeps dying, investigate ${join(dir, "daemon.log")} manually`);
    exitCode = 1;
  } else if (!st.up) {
    lines.push(`doctor: daemon still DOWN after recovery attempt (${st.reason})`);
    exitCode = 1;
  }
  return { lines, exitCode };
}

/** The detached poll loop. Logs loudly on fatal errors but stays alive. */
export async function doctorRun(dir) {
  ensureDoctorDir(dir);
  dlog(dir, `doctor loop starting pid=${process.pid} dir=${dir}`);
  let stopping = false;
  const onStop = () => {
    if (stopping) return;
    stopping = true;
    dlog(dir, "doctor loop stopping");
    clearInterval(timer);
    try { unlinkSync(doctorLockPath(dir)); } catch { /* best effort */ }
    process.exit(0);
  };
  process.on("SIGTERM", onStop);
  process.on("SIGINT", onStop);
  process.on("uncaughtException", (err) => {
    try { dlog(dir, `FATAL uncaughtException (staying alive): ${err && err.stack ? err.stack : err}`); } catch { /* ignore */ }
  });
  process.on("unhandledRejection", (reason) => {
    try { dlog(dir, `FATAL unhandledRejection (staying alive): ${reason && reason.stack ? reason.stack : reason}`); } catch { /* ignore */ }
  });
  const timer = setInterval(async () => {
    if (stopping) return;
    try { await doctorTick(dir); } catch (e) { dlog(dir, `tick error: ${e.message}`); }
  }, DOCTOR_POLL_MS);
  try { await doctorTick(dir); } catch (e) { dlog(dir, `tick error: ${e.message}`); }
}
