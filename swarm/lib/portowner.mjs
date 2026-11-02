/**
 * Port ownership from /proc — who is LISTENING on a TCP port, derived
 * from the socket table, not from any supervisor's bookkeeping.
 *
 * Why this exists (COMPUTE-SUPERVISION-FIX, 2026-10-31): a compute
 * worker kills its app child only on a graceful SIGTERM. A hard
 * worker death (SIGKILL-class host events, OOM, write-fault windows)
 * leaves the child orphaned at ppid 1, still holding its port. The
 * next worker's child then crashes EADDRINUSE every ~30s — the
 * registry reads pid null with restarts climbing into the thousands
 * while the orphan serves. Two consumers:
 *   - lib/worker.mjs: before booting an app, reap a stale listener
 *     that provably belongs to a previous incarnation of THIS node
 *     (same working directory), so the new child can bind.
 *   - lib/compute.mjs: reconcile the registry — report the socket
 *     table's pid beside the recorded runtime pid, so a pid that
 *     disagrees with reality is visible instead of silent.
 *
 * Identity discipline (real-or-loud, never guess-and-kill): the
 * reaper signals a listener ONLY when the process's cwd is exactly
 * the app's workdir — the fingerprint every incarnation of this
 * node's app child carries. Anything else is reported as foreign
 * and left alone.
 */
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

const LISTEN_STATE = "0A"; // /proc/net/tcp state for LISTEN

/**
 * Parse /proc/net/tcp{,6} content → the set of socket inodes (strings)
 * LISTENing on `port`. Pure — the caller supplies file contents.
 */
export function parseListeners(text, port) {
  const inodes = new Set();
  if (!text) return inodes;
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  for (const line of String(text).split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 10) continue;
    const local = cols[1] || "";
    if (!local.endsWith(`:${hexPort}`)) continue;
    if (cols[3] !== LISTEN_STATE) continue;
    if (cols[9] && cols[9] !== "0") inodes.add(cols[9]);
  }
  return inodes;
}

/**
 * pid → ppid for the whole system, from /proc stat files.
 * (Same parse as lib/worker.mjs's procParents — comm may contain
 * spaces/parens, so ppid follows the LAST ")".)
 */
export function readProcParents(procRoot = "/proc") {
  const ppid = new Map();
  let entries = [];
  try { entries = readdirSync(procRoot).filter((e) => /^\d+$/.test(e)); } catch { return ppid; }
  for (const e of entries) {
    try {
      const stat = readFileSync(join(procRoot, e, "stat"), "utf8");
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      ppid.set(Number(e), Number(rest[1]));
    } catch { /* vanished mid-scan */ }
  }
  return ppid;
}

/** True when `pid` is `ancestor` itself or descends from it. */
export function isSelfOrDescendant(ppid, pid, ancestor) {
  let cur = pid;
  const seen = new Set();
  while (cur && cur > 1 && !seen.has(cur)) {
    if (cur === ancestor) return true;
    seen.add(cur);
    cur = ppid.get(cur);
  }
  return false;
}

/**
 * The pids LISTENing on `port`, per the live socket table.
 * I/O is injectable for tests; defaults read the real /proc.
 */
export function findListenerPids({ port, procRoot = "/proc", readFile = readFileSync, readdir = readdirSync, readlink = readlinkSync } = {}) {
  const inodes = new Set();
  for (const name of ["tcp", "tcp6"]) {
    try { for (const i of parseListeners(readFile(join(procRoot, "net", name), "utf8"), port)) inodes.add(i); } catch { /* v6 table may not exist */ }
  }
  if (!inodes.size) return [];
  const pids = new Set();
  let entries = [];
  try { entries = readdir(procRoot).filter((e) => /^\d+$/.test(e)); } catch { return []; }
  for (const e of entries) {
    let fds = [];
    try { fds = readdir(join(procRoot, e, "fd")); } catch { continue; /* not ours / vanished */ }
    for (const fd of fds) {
      let target = "";
      try { target = readlink(join(procRoot, e, "fd", fd)); } catch { continue; }
      const m = /^socket:\[(\d+)\]$/.exec(target);
      if (m && inodes.has(m[1])) { pids.add(Number(e)); break; }
    }
  }
  return [...pids];
}

/** The cwd of a pid ("" when unreadable). */
export function pidCwd(pid, { procRoot = "/proc", readlink = readlinkSync } = {}) {
  try { return readlink(join(procRoot, String(pid), "cwd")); } catch { return ""; }
}

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Reap a stale listener on `port` before a new app child binds.
 *
 * A listener is reapable ONLY when it is (a) not this process or its
 * descendant, and (b) its cwd is exactly `workdir` — a previous
 * incarnation of this node's app child. Foreign listeners are
 * reported, never signalled. After SIGTERM the port is polled until
 * free; a holder that outlives `graceMs` gets SIGKILL and one more
 * poll window.
 *
 * Returns one of:
 *   { action: "free" }                          — nobody was listening
 *   { action: "reaped", pid, signal }           — stale own-child cleared
 *   { action: "foreign", pid }                  — someone else's port; untouched
 *   { action: "stuck", pid }                    — own-child ignored SIGKILL polls
 */
export async function reapStaleListener({
  port, workdir, selfPid = process.pid,
  graceMs = 5000, pollMs = 200,
  findPids = findListenerPids,
  cwdOf = pidCwd,
  parentsOf = readProcParents,
  kill = (pid, sig) => process.kill(pid, sig),
  sleep = sleepReal,
} = {}) {
  if (!port) return { action: "free" };
  const holders = findPids({ port }).filter((pid) => pid !== selfPid);
  if (!holders.length) return { action: "free" };
  const ppid = parentsOf();
  for (const pid of holders) {
    if (isSelfOrDescendant(ppid, pid, selfPid)) continue; // our own live child — not stale
    if (cwdOf(pid) !== workdir) return { action: "foreign", pid };
    // Provably a previous incarnation of this node's app: reap it.
    try { kill(pid, "SIGTERM"); } catch { /* already gone */ }
    let waited = 0;
    while (waited < graceMs) {
      await sleep(pollMs); waited += pollMs;
      if (!findPids({ port }).includes(pid)) return { action: "reaped", pid, signal: "SIGTERM" };
    }
    try { kill(pid, "SIGKILL"); } catch { /* already gone */ }
    waited = 0;
    while (waited < 2000) {
      await sleep(pollMs); waited += pollMs;
      if (!findPids({ port }).includes(pid)) return { action: "reaped", pid, signal: "SIGKILL" };
    }
    return { action: "stuck", pid };
  }
  return { action: "free" };
}
