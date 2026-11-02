/**
 * helpers.mjs — shared guts for the doctor engine.
 *
 * State layout, journal IO, the tick lock, and the honest forensic
 * primitives (tail, ps, memory, dmesg OOM grep, pid probing) that plugins
 * reuse in their collectors. Zero dependencies: node:fs / node:path /
 * node:os / node:child_process only.
 */
import {
  openSync, closeSync, readFileSync, appendFileSync,
  existsSync, mkdirSync, unlinkSync, statSync,
  writeSync, fsyncSync, renameSync, chmodSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";

export const DOCTOR_POLL_MS = 15000;
export const TICK_LOCK_STALE_MS = 120000;

/**
 * Atomic file replacement: write the full payload to a temp file in the
 * SAME directory, fsync it, rename over the target, then fsync the
 * directory (best effort) so the rename itself is durable.
 *
 * The ONLY way doctor state files may be written. A plain writeFileSync
 * truncates the target in place: a host write fault (or a kill) mid-write
 * leaves a 0-byte / torn file behind — and the doctor's own state
 * (doctor/state.json carries the recovery fence: expectedBootId /
 * expectedStartId / recoveryExhausted) is the worst possible file to
 * lose that way; a torn read silently resets the fence. With tmp+rename
 * a faulted write leaves either the old complete file or the new
 * complete file — never a truncated one.
 *
 * opts.mode: applied at tmp creation AND chmod'd after the rename
 * (creation mode is umask-filtered; the chmod makes it exact).
 *
 * TEST-ONLY fault hook: DOCTOR_ATOMIC_WRITE_FAULT=1 writes half the
 * payload to the temp file and then throws, simulating a host write
 * fault mid-save. Never set in production; exists solely so tests can
 * prove the target survives a faulted save byte-intact.
 */
export function atomicWriteSync(path, data, opts = {}) {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    const fd = openSync(tmp, "w", opts.mode ?? 0o666);
    try {
      if (process.env.DOCTOR_ATOMIC_WRITE_FAULT === "1") {
        const half = typeof data === "string" ? data.slice(0, Math.ceil(data.length / 2)) : data.subarray(0, Math.ceil(data.length / 2));
        writeSync(fd, half);
        throw new Error("simulated host write fault mid-save (DOCTOR_ATOMIC_WRITE_FAULT)");
      }
      writeSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    if (opts.mode) { try { chmodSync(path, opts.mode); } catch { /* best effort */ } }
    try {
      const dfd = openSync(dirname(path), "r");
      try { fsyncSync(dfd); } finally { closeSync(dfd); }
    } catch { /* directory fsync unsupported here — rename still atomic */ }
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* already renamed or never created */ }
    throw e;
  }
}

// ---------------------------------------------------------------- state layout

export function doctorDir(dir) { return join(dir, "doctor"); }
export function doctorJsonPath(dir) { return join(doctorDir(dir), "doctor.json"); }
export function doctorLockPath(dir) { return join(doctorDir(dir), "doctor.lock"); }
export function tickLockPath(dir) { return join(doctorDir(dir), "tick.lock"); }
export function doctorLogPath(dir) { return join(doctorDir(dir), "doctor.log"); }
export function doctorStatePath(dir) { return join(doctorDir(dir), "state.json"); }
export function deathsDir(dir) { return join(doctorDir(dir), "deaths"); }
export function journalPath(dir) { return join(doctorDir(dir), "deaths.jsonl"); }
export function heartbeatPath(dir) { return join(doctorDir(dir), "heartbeat.json"); }

export function ensureDoctorDir(dir) {
  mkdirSync(deathsDir(dir), { recursive: true });
  return doctorDir(dir);
}

export function dlog(dir, ...a) {
  const line = `[doctor ${new Date().toISOString()}] ${a.map(String).join(" ")}\n`;
  try { appendFileSync(doctorLogPath(dir), line); } catch { /* best effort */ }
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export function tailLines(path, n) {
  try {
    const lines = readFileSync(path, "utf8").split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-n);
  } catch {
    return [];
  }
}

export function readDoctorJson(dir) {
  try { return JSON.parse(readFileSync(doctorJsonPath(dir), "utf8")); }
  catch { return null; }
}

export function readDoctorState(dir) {
  try { return JSON.parse(readFileSync(doctorStatePath(dir), "utf8")); }
  catch { return {}; }
}

export function writeDoctorState(dir, state) {
  try { atomicWriteSync(doctorStatePath(dir), JSON.stringify(state, null, 2) + "\n"); }
  catch { /* best effort */ }
}

export function acquireExclusive(path) {
  try {
    const fd = openSync(path, "wx");
    closeSync(fd);
    return true;
  } catch (e) {
    if (e.code === "EEXIST") return false;
    throw e;
  }
}

/**
 * Serialize the poll-loop tick vs an inline `check` tick. Whoever loses the
 * lock skips quietly; a stale lock (older than TICK_LOCK_STALE_MS) is
 * reclaimed, so a crashed tick can never wedge the doctor forever.
 */
export function acquireTickLock(dir) {
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

export function releaseTickLock(dir) {
  try { unlinkSync(tickLockPath(dir)); } catch { /* best effort */ }
}

// ---------------------------------------------------------------- journal

/** Append one event to deaths.jsonl (one JSON object per line). */
export function journalEvent(dir, event) {
  ensureDoctorDir(dir);
  appendFileSync(journalPath(dir), JSON.stringify(event) + "\n");
}

/** Read every journal event, skipping corrupt lines rather than dying. */
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

/** Events with a parseable ts newer than sinceTs (ms epoch). */
export function journalSince(dir, sinceTs) {
  return readJournal(dir).filter((e) => {
    const t = Date.parse(e.ts);
    return Number.isFinite(t) && t > sinceTs;
  });
}

// ---------------------------------------------------------------- forensic primitives

/** kill(pid, 0) probe — EPERM means "exists but not ours". */
export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === "ESRCH") return false;
    if (e.code === "EPERM") return true; // exists, we can't signal it
    return false;
  }
}

/** MiB available per /proc/meminfo; null off-Linux. */
export function memAvailableMb() {
  try {
    const m = readFileSync("/proc/meminfo", "utf8").match(/MemAvailable:\s+(\d+)\s+kB/);
    if (m) return Math.round(parseInt(m[1], 10) / 1024);
  } catch { /* non-Linux */ }
  return null;
}

/** dmesg OOM-killer sightings (coarse: no per-death kernel timestamps). */
export function dmesgOom() {
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

/** ps filtered to process-looking lines, capped at 60. */
export function psFiltered() {
  try {
    const out = execSync("ps aux 2>/dev/null", { encoding: "utf8", timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
    const lines = out.split("\n");
    const kept = lines.filter((l, i) => i === 0 || /node|python|daemon|worker/i.test(l));
    return kept.slice(0, 60);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- math for the detective

export function medianOf(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 72) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
