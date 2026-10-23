/**
 * State-dir layout and node records.
 * Default: ~/.kiln-swarm, override with KILN_SWARM_DIR.
 *
 *   <dir>/config.json
 *   <dir>/daemon.json            {pid, startedAt}
 *   <dir>/daemon.lock            (exclusive create = single instance)
 *   <dir>/queue.jsonl            (append-only job events)
 *   <dir>/nodes/<nodeId>/node.json
 *   <dir>/nodes/<nodeId>/key.json        (0600)
 *   <dir>/nodes/<nodeId>/work/           (jailed working dir = git clone)
 *   <dir>/nodes/<nodeId>/job.json        (assigned job, if any)
 *   <dir>/nodes/<nodeId>/heartbeat       (touched by worker)
 *   <dir>/nodes/<nodeId>/stdout.log
 *   <dir>/nodes/<nodeId>/stderr.log
 *   <dir>/nodes/<nodeId>/receipts.jsonl
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, chmodSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";

export function stateDir() {
  return process.env.KILN_SWARM_DIR || join(homedir(), ".kiln-swarm");
}

export function ensureStateDir(dir) {
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "nodes"), { recursive: true });
  const cfg = join(dir, "config.json");
  if (!existsSync(cfg)) {
    writeFileSync(
      cfg,
      JSON.stringify(
        {
          version: 1,
          autospawn: true,
          maxNodes: 8,
          workerDefaults: { caps: 15, ttlSec: 86400, mind: "script", restartPolicy: "on-failure", maxRestarts: 3 },
          heartbeatTimeoutMs: 30000,
          tickMs: 2000,
          apiPort: 18787, // 0 = ephemeral; override with KILN_SWARM_API_PORT
          // Stall self-abort: the daemon exits(1) if no tick completes for
          // this long (ms). Env KILN_TICK_STALL_MS overrides when set.
          tickStallAbortMs: 600000,
          // Public previews (Caffeine-style URLs for compute apps). Absent =
          // previews unavailable (apps still deploy privately). See
          // docs/KILN_PREVIEW.md for the full shape.
          preview: null,
        },
        null,
        2
      ) + "\n"
    );
  }
  // Local API bearer token (0600). Minimal honest auth: local-only bind + token.
  const tok = join(dir, "api.token");
  if (!existsSync(tok)) {
    writeFileSync(tok, randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
    try { chmodSync(tok, 0o600); } catch { /* best effort */ }
  }
  return dir;
}

export function loadApiToken(dir) {
  return readFileSync(join(dir, "api.token"), "utf8").trim();
}

export function loadConfig(dir) {
  return JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
}

export function nodeDir(dir, id) {
  return join(dir, "nodes", id);
}

export function nodeJsonPath(dir, id) {
  return join(nodeDir(dir, id), "node.json");
}

export function loadNode(dir, id) {
  return JSON.parse(readFileSync(nodeJsonPath(dir, id), "utf8"));
}

export function saveNode(dir, record) {
  writeFileSync(nodeJsonPath(dir, record.id), JSON.stringify(record, null, 2) + "\n");
}

export function listNodeIds(dir) {
  const ndir = join(dir, "nodes");
  if (!existsSync(ndir)) return [];
  return readdirSync(ndir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/** Resolve a node id prefix or name to a full id. Throws if ambiguous/missing. */
export function resolveNode(dir, idOrName) {
  const ids = listNodeIds(dir);
  if (ids.includes(idOrName)) return idOrName;
  const byPrefix = ids.filter((id) => id.startsWith(idOrName));
  if (byPrefix.length === 1) return byPrefix[0];
  if (byPrefix.length > 1) throw new Error(`node: ambiguous prefix "${idOrName}"`);
  for (const id of ids) {
    try {
      if (loadNode(dir, id).name === idOrName) return id;
    } catch { /* skip unreadable */ }
  }
  throw new Error(`node: no such node "${idOrName}"`);
}

export function writeKeyFile(dir, id, stored) {
  const p = join(nodeDir(dir, id), "key.json");
  writeFileSync(p, JSON.stringify(stored, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(p, 0o600); } catch { /* best effort */ }
}

export function loadKeyFile(dir, id) {
  return JSON.parse(readFileSync(join(nodeDir(dir, id), "key.json"), "utf8"));
}

export function touchHeartbeat(dir, id) {
  writeFileSync(join(nodeDir(dir, id), "heartbeat"), String(Date.now()));
}

export function heartbeatAgeMs(dir, id) {
  const p = join(nodeDir(dir, id), "heartbeat");
  if (!existsSync(p)) return Infinity;
  const raw = readFileSync(p, "utf8").trim();
  const t = parseInt(raw, 10);
  if (!Number.isFinite(t)) return Infinity;
  return Date.now() - t;
}

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

/// True if pid is a live process running the swarm daemon for `dir` — not a
/// pid-reuse impostor. kill(pid,0) alone is racy: a dead daemon's pid can be
/// recycled by an unrelated process, making a stale lock / stale daemon.json
/// look live (seen 2026-09-21: watchdog restart refused while no daemon ran).
/// On non-Linux (/proc unavailable) falls back to trusting pidAlive.
export function pidIsDaemon(pid, dir) {
  if (!pidAlive(pid)) return false;
  const r = procCmdline(pid);
  if (r.status === "vanished") return false; // TOCTOU: died between the checks
  if (r.status === "unreadable") return pidAlive(pid); // non-Linux fallback
  const cmd = r.cmd;
  if (!cmd.includes("daemon.mjs")) return false;
  // Same script could serve another state dir — check the env marker too.
  try {
    const env = readFileSync(`/proc/${pid}/environ`, "utf8");
    if (!env.includes(`KILN_SWARM_DIR=${dir}\0`)) return false;
  } catch { /* environ unreadable — cmdline match is enough */ }
  return true;
}

/// True if pid is a live process running a swarm WORKER for `dir` — not a
/// pid-reuse impostor. kill(pid,0) alone is racy: a dead worker's pid can be
/// recycled by an unrelated process, which reconcile() would then "adopt" as
/// a live worker instead of respawning the real one (seen 2026-10-02: a
/// test daemon inherited a dead app worker's pid; both apps went dark while
/// the daemon insisted their workers were alive). Mirrors pidIsDaemon,
/// including its TOCTOU semantics via procCmdline. On non-Linux
/// (/proc unavailable) falls back to trusting pidAlive.
///
/// When `nodeId` is given, the check is per-node: the process's argv must
/// be `worker.mjs <nodeId>` exactly. The any-worker check alone is NOT
/// enough — a dead worker's pid recycled by ANOTHER node's worker passes
/// it, and reconcile() then adopts the stranger as this node's live worker
/// while the real one never respawns (seen 2026-10-22: ShopStream +
/// Launchpad app nodes wedged in "starting" ~25 min behind a
/// sibling-worker pid). Callers that know the node id MUST pass it.
export function pidIsWorker(pid, dir, nodeId) {
  if (!pidAlive(pid)) return false;
  const r = procCmdline(pid);
  if (r.status === "vanished") return false; // TOCTOU: died between the checks
  if (r.status === "unreadable") return pidAlive(pid); // non-Linux fallback
  if (!r.cmd.includes("worker.mjs")) return false;
  if (nodeId) {
    const tokens = r.cmd.split(/\s+/);
    const wi = tokens.findIndex((t) => t.endsWith("worker.mjs"));
    if (wi < 0 || tokens[wi + 1] !== nodeId) return false;
  }
  // Same script could serve another state dir — check the env marker too.
  try {
    const env = readFileSync(`/proc/${pid}/environ`, "utf8");
    if (!env.includes(`KILN_SWARM_DIR=${dir}\0`)) return false;
  } catch { /* environ unreadable — cmdline match is enough */ }
  return true;
}

/**
 * Read /proc/<pid>/cmdline, distinguishing the three outcomes that matter
 * for pid-identity checks. Never throws.
 *
 *   { status: "ok", cmd }         — process is there and cmdline was read
 *   { status: "vanished" }        — /proc/<pid> is gone (ENOENT): the process
 *                                   died between pidAlive() and this read.
 *                                   This is the TOCTOU window that made
 *                                   pidIsDaemon() return TRUE for a dead pid
 *                                   (its old catch-all returned true), which
 *                                   self-aborted the 2026-10-07T05:30:27Z
 *                                   daemon recovery with "lock held by live
 *                                   pid" while no daemon was running.
 *   { status: "unreadable" }      — /proc itself is unavailable (non-Linux)
 *                                   or the read failed another way; callers
 *                                   fall back to pidAlive().
 */
export function procCmdline(pid) {
  try {
    const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
    return { status: "ok", cmd };
  } catch (e) {
    if (e.code === "ENOENT" && existsSync("/proc")) return { status: "vanished" };
    return { status: "unreadable" };
  }
}

/**
 * Boot-relative process start identity: "<pid>:<starttime ticks>".
 *
 * A recycled pid gets a NEW starttime, so comparing a recorded startId
 * against the live /proc/<pid>/stat fences pid reuse: the lock and
 * daemon.json can no longer be fooled by an unrelated process that
 * inherited a dead daemon's pid. Returns null when the process is gone
 * or /proc is unavailable.
 */
export function processStartId(pid) {
  if (!pid) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Field 22 (1-based) is starttime in clock ticks since boot. comm may
    // contain spaces/parens, so split from the last ")".
    const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
    const starttime = fields[19]; // fields 3..22 → index 19
    if (!starttime || !/^\d+$/.test(starttime)) return null;
    return `${pid}:${starttime}`;
  } catch {
    return null;
  }
}

export function readJobFile(dir, id) {
  const p = join(nodeDir(dir, id), "job.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

export function writeJobFile(dir, id, job) {
  writeFileSync(join(nodeDir(dir, id), "job.json"), JSON.stringify(job, null, 2) + "\n");
}

export function clearJobFile(dir, id) {
  try {
    unlinkSync(join(nodeDir(dir, id), "job.json"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}
