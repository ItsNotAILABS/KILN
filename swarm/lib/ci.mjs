/**
 * KILN-native CI: push-time verification for hosted git repos.
 *
 * On every authenticated push, the API server snapshots refs before the
 * receive-pack and diffs after; changed branches with a CI config get a job
 * enqueued. A detached runner (lib/ci-runner.mjs) drains the queue: it
 * clones the pushed SHA into a temp dir, runs the repo's configured test
 * command, and writes a result JSON. Results are served publicly, GitHub
 * commit-status style. Each run's FULL output is retained beside its
 * result JSON (<sha>.log, served at /ci/log/:sha) under the
 * ciLogMaxBytes() cap — the result's logTail is only a display tail.
 *
 * Trust model: test commands come ONLY from <stateDir>/ci/repos.json, which
 * is operator-written. A pushed repo can never inject its own CI command —
 * the runner executes repo code (that's the point of tests), but only for
 * repos the operator explicitly enrolled.
 */
import { spawn, execFileSync } from "node:child_process";
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync,
  openSync, closeSync, statSync, unlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { repoPath } from "./git.mjs";
import { pidAlive, writeFileAtomicSync } from "./state.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, "ci-runner.mjs");

export function ciDir(dir) {
  return join(dir, "ci");
}

export function ensureCiDir(dir) {
  mkdirSync(ciDir(dir), { recursive: true });
  mkdirSync(join(ciDir(dir), "results"), { recursive: true });
}

/** { "auro/minutely": { command, timeoutMs, venv? }, ... } — operator config. */
export function loadRepoConfig(dir) {
  try {
    return JSON.parse(readFileSync(join(ciDir(dir), "repos.json"), "utf8"));
  } catch {
    return {};
  }
}

/** refname -> sha for all refs in the bare repo. Never throws ({} on error). */
export function snapshotRefs(dir, owner, repo) {
  try {
    const p = repoPath(dir, owner, repo);
    const out = execFileSync(
      "git", ["--git-dir", p, "for-each-ref", "--format=%(refname) %(objectname)"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    const m = {};
    for (const line of out.split("\n")) {
      const i = line.indexOf(" ");
      if (i > 0) m[line.slice(0, i)] = line.slice(i + 1).trim();
    }
    return m;
  } catch {
    return {};
  }
}

function queuePath(dir) {
  return join(ciDir(dir), "queue.jsonl");
}

function newJobId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** All queued CI jobs, oldest first. Unparseable lines are dropped. */
export function readQueueJobs(dir) {
  try {
    return readFileSync(queuePath(dir), "utf8")
      .split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function writeQueueJobs(dir, jobs) {
  ensureCiDir(dir);
  writeFileAtomicSync(queuePath(dir), jobs.map((j) => JSON.stringify(j)).join("\n") + (jobs.length ? "\n" : ""));
}

function appendQueueJob(dir, job) {
  ensureCiDir(dir);
  appendFileSync(queuePath(dir), JSON.stringify(job) + "\n");
  return job;
}

/**
 * Enqueue one CI job and kick the detached runner. Best-effort by design:
 * CI must never break or slow a push — the push response already went out
 * by the time this runs.
 */
export function enqueueCiJob(dir, { owner, repo, ref, sha }) {
  const job = appendQueueJob(dir, {
    id: newJobId(),
    owner, repo, ref, sha,
    queuedAt: new Date().toISOString(),
  });
  kickRunner(dir);
  return job;
}

// ------------------------------------------------------------- runner lock

export function runnerLockPath(dir) {
  return join(ciDir(dir), "runner.lock");
}

/** Parsed runner lock { pid, startedAt }, or null when absent/unreadable. */
export function readRunnerLock(dir) {
  try {
    const d = JSON.parse(readFileSync(runnerLockPath(dir), "utf8"));
    return d && typeof d.pid === "number" ? d : null;
  } catch {
    return null;
  }
}

/**
 * True only when a runner is genuinely draining: the lock exists AND its
 * recorded pid is alive. Lock EXISTENCE alone proved nothing — on
 * 2026-10-23 a dead runner's leftover lock (pid 20377, killed with the
 * daemon) vetoed the one push-time kick for hours and stranded a queued
 * job permanently. Liveness is the only honest signal.
 */
export function runnerLockLive(dir) {
  const lock = readRunnerLock(dir);
  return !!(lock && pidAlive(lock.pid));
}

/** Age fallback for a lock whose contents are unusable (no readable pid). */
const STALE_LOCK_MS = 30 * 60 * 1000;

/**
 * Spawn the detached queue drainer unless a LIVE runner already holds
 * the lock. A lock whose pid is dead is reaped on the spot, by liveness:
 * a crashed or daemon-killed runner must never wedge CI. An unreadable
 * lock falls back to the old age rule rather than trusting garbage.
 * Returns true when a runner was spawned.
 */
export function kickRunner(dir) {
  ensureCiDir(dir);
  const lock = runnerLockPath(dir);
  const existing = readRunnerLock(dir);
  if (existing) {
    if (pidAlive(existing.pid)) return false; // genuinely draining
    try { unlinkSync(lock); } catch {} // dead runner's lock — reap by liveness
  } else if (existsSync(lock)) {
    try {
      if (Date.now() - statSync(lock).mtimeMs <= STALE_LOCK_MS) return false;
      unlinkSync(lock);
    } catch { return false; }
  }
  try {
    const fd = openSync(lock, "wx");
    const child = spawn(process.execPath, [RUNNER, dir], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });
    child.unref();
    // The runner removes the lock when the queue is drained; if it dies
    // first, the lock's dead pid is reaped by the next kick/reconcile.
    writeFileSync(lock, JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }));
    closeSync(fd);
    return true;
  } catch (e) {
    if (e.code !== "EEXIST") throw e; // lost a race with another kick — fine
    return false;
  }
}

export function resultPath(dir, owner, repo, sha) {
  return join(ciDir(dir), "results", owner, repo, `${sha}.json`);
}

export function writeResult(dir, job, result) {
  ensureCiDir(dir);
  const rdir = join(ciDir(dir), "results", job.owner, job.repo);
  mkdirSync(rdir, { recursive: true });
  // A run's full log streams to a temp file (result.logFile); it is
  // stored beside the result JSON and referenced from doc.log. The
  // temp path itself never reaches the stored doc.
  const { logFile, suites: explicitSuites, ...rest } = result;
  const doc = {
    schema: "kiln.ci-result.v1",
    ...rest,
    owner: job.owner,
    repo: job.repo,
    ref: job.ref,
    sha: job.sha,
    recordedAt: new Date().toISOString(),
  };
  if (logFile) {
    const log = storeLogFile(dir, job, logFile);
    if (log) doc.log = log;
  }
  // Structured per-suite results. Precedence, so nothing is ever
  // double-counted: an explicit suites array (the runner's streaming
  // collection — the authoritative source) wins verbatim; only when
  // the caller supplied none do we fall back to parsing the run's
  // actual stored log text (never the doc.log metadata), and then the
  // display tail. No source at all means an honest empty list.
  if (Array.isArray(explicitSuites)) {
    doc.suites = normalizeSuites(explicitSuites);
  } else {
    doc.suites = doc.log ? parseSuiteResults(readLog(dir, job.owner, job.repo, job.sha) || "") : [];
    if (!doc.suites.length && typeof rest.logTail === "string") {
      doc.suites = parseSuiteResults(rest.logTail);
    }
  }
  writeFileAtomicSync(join(rdir, `${job.sha}.json`), JSON.stringify(doc, null, 2) + "\n");
  writeFileAtomicSync(join(rdir, "latest.json"), JSON.stringify(doc, null, 2) + "\n");
  // Per-branch pointer: refs/heads/main -> latest for that branch.
  const branch = job.ref.startsWith("refs/heads/") ? job.ref.slice("refs/heads/".length) : null;
  if (branch && /^[a-zA-Z0-9._-]+$/.test(branch)) {
    writeFileAtomicSync(join(rdir, `latest-${branch}.json`), JSON.stringify(doc, null, 2) + "\n");
  }
  return doc;
}

export function readResult(dir, owner, repo, sha) {
  try {
    return JSON.parse(readFileSync(resultPath(dir, owner, repo, sha), "utf8"));
  } catch {
    return null;
  }
}

export function readLatest(dir, owner, repo, branch) {
  const name = branch ? `latest-${branch}.json` : "latest.json";
  try {
    return JSON.parse(readFileSync(join(ciDir(dir), "results", owner, repo, name), "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------- reconciliation

/** Committer time (ms) of a SHA in the bare repo, or 0 when unreadable. */
function tipCommitMs(dir, owner, repo, sha) {
  try {
    const out = execFileSync(
      "git", ["--git-dir", repoPath(dir, owner, repo), "log", "-1", "--format=%ct", sha],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    const sec = Number(out.trim());
    return Number.isFinite(sec) && sec > 0 ? sec * 1000 : 0;
  } catch {
    return 0;
  }
}

/**
 * CI queue reconciliation — the recovery path push-time kicking lacks.
 *
 * Draining used to be triggered ONLY by enqueueCiJob (a push) and vetoed
 * by runner.lock existence alone. Three ways a verdict was lost forever:
 *   1. The kick was swallowed by a dead runner's leftover lock (the lock
 *      was removed by hand hours later — and nothing ever re-kicked).
 *   2. The daemon was recovered by the Doctor with a queue still holding
 *      jobs: the new boot never looked at the CI queue at all.
 *   3. A runner dequeued a job (dequeue-first) and died mid-run: the job
 *      vanished from the queue with no result doc.
 *
 * The daemon calls this on boot and on a periodic tick; it can also be
 * invoked directly. It is idempotent and safe to run any time:
 *   - queued jobs whose verdict already exists are dropped (no re-run);
 *   - while a runner's lock pid is LIVE, a drain is in progress — no-op;
 *   - each enrolled repo's branch tips are compared against recorded
 *     results: a tip with no verdict, not already queued, past the grace
 *     window is (re-)queued — this is what resurrects case 3, whose only
 *     surviving trace is "the branch moved and no verdict ever landed";
 *   - if anything is queued, the (liveness-aware) runner is kicked.
 * The grace window (default 5 min, KILN_CI_RECONCILE_GRACE_MS) is timed
 * from the newest evidence for the branch — the latest recorded verdict
 * or the tip's own commit time — so a push whose legitimate drain is
 * still in flight is never duplicated; the runner's own already-recorded
 * skip makes even a raced duplicate a no-op.
 */
export function reconcileCiQueue(dir, opts = {}) {
  const graceMs = opts.graceMs ?? (Number(process.env.KILN_CI_RECONCILE_GRACE_MS) || 5 * 60 * 1000);
  const now = Date.now();
  const out = { droppedRecorded: [], enqueued: [], kicked: false, queued: 0, runnerLive: false };
  ensureCiDir(dir);

  // (1) Drop queued jobs whose verdict already exists.
  let jobs = readQueueJobs(dir);
  const keep = [];
  for (const j of jobs) {
    if (readResult(dir, j.owner, j.repo, j.sha)) out.droppedRecorded.push(j.id);
    else keep.push(j);
  }
  if (keep.length !== jobs.length) writeQueueJobs(dir, keep);
  jobs = keep;

  // (2) A live runner owns the queue; never double-drain.
  if (runnerLockLive(dir)) {
    out.runnerLive = true;
    out.queued = jobs.length;
    return out;
  }

  // (3) Tip reconciliation: re-queue branch tips with no recorded verdict.
  const cfg = loadRepoConfig(dir);
  for (const key of Object.keys(cfg)) {
    if (!cfg[key] || !cfg[key].command) continue;
    const slash = key.indexOf("/");
    if (slash <= 0) continue;
    const owner = key.slice(0, slash);
    const repo = key.slice(slash + 1);
    let refs = {};
    try { refs = snapshotRefs(dir, owner, repo); } catch { refs = {}; }
    for (const [ref, sha] of Object.entries(refs)) {
      if (!ref.startsWith("refs/heads/")) continue;
      if (readResult(dir, owner, repo, sha)) continue;
      if (jobs.some((j) => j.owner === owner && j.repo === repo && j.sha === sha)) continue;
      const branch = ref.slice("refs/heads/".length);
      const latest = readLatest(dir, owner, repo, branch);
      const newest = Math.max(
        latest && latest.recordedAt ? Date.parse(latest.recordedAt) || 0 : 0,
        tipCommitMs(dir, owner, repo, sha)
      );
      if (newest && now - newest < graceMs) continue; // too fresh — may still be in flight
      const job = appendQueueJob(dir, {
        id: newJobId(), owner, repo, ref, sha,
        queuedAt: new Date().toISOString(), reconciled: true,
      });
      jobs.push(job);
      out.enqueued.push(job.id);
    }
  }

  out.queued = jobs.length;
  // (4) Drain whatever is queued, oldest first (the runner's own order).
  if (jobs.length) out.kicked = kickRunner(dir);
  return out;
}

// ------------------------------------------------------------------ logs

/**
 * Full-log retention cap for one CI run, in bytes. Mirrors rotlog's
 * env-tunable pattern (floor 64KB, default 10MB). The runner streams
 * a run's whole output (clone, checkout, test command) to a file;
 * writeResult stores it beside the result JSON, truncated at this
 * cap with an in-band marker — never silently. Before this, results
 * kept only a 120-line tail, which made real failures undiagnosable
 * (a red badge whose cause had scrolled past the tail).
 */
export function ciLogMaxBytes() {
  return Math.max(64 * 1024, Number(process.env.KILN_CI_LOG_MAX_BYTES) || 10 * 1024 * 1024);
}

export function logPath(dir, owner, repo, sha) {
  return join(ciDir(dir), "results", owner, repo, `${sha}.log`);
}

function truncationMarker(dropped, cap) {
  return `\n[kiln-ci] log truncated: ${dropped} bytes dropped at the ${cap}-byte retention cap (KILN_CI_LOG_MAX_BYTES)\n`;
}

/**
 * Store a run's streamed log file beside its result JSON, enforcing
 * the retention cap. Returns { file, bytes, truncated, droppedBytes,
 * capBytes } describing the STORED log, or null when there is no
 * readable source log.
 */
export function storeLogFile(dir, job, sourcePath) {
  try {
    const cap = ciLogMaxBytes();
    const data = readFileSync(sourcePath);
    const rdir = join(ciDir(dir), "results", job.owner, job.repo);
    mkdirSync(rdir, { recursive: true });
    let body = data;
    let droppedBytes = 0;
    if (data.length > cap) {
      droppedBytes = data.length - cap;
      body = Buffer.concat([
        data.subarray(0, cap),
        Buffer.from(truncationMarker(droppedBytes, cap)),
      ]);
    }
    writeFileAtomicSync(join(rdir, `${job.sha}.log`), body);
    return {
      file: `${job.sha}.log`,
      bytes: body.length,
      truncated: droppedBytes > 0,
      droppedBytes,
      capBytes: cap,
    };
  } catch {
    return null;
  }
}

/** The stored full log for one run, or null. Public, like status. */
export function readLog(dir, owner, repo, sha) {
  try {
    return readFileSync(logPath(dir, owner, repo, sha), "utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------- suite verdicts

/**
 * Parse explicit per-suite verdict lines emitted by CI commands:
 *
 *   SUITE_RESULT\t<name>\t<pass|fail>\t<duration-ms>
 *
 * (tab-separated so suite names may contain spaces). CI commands opt
 * in by printing these lines — Minutely's scripts/test-all.sh emits
 * one per suite (maque, sdk, keeper, program, and every app check:*).
 * The runner collects them during the run and writeResult persists
 * them as the result doc's `suites` array, so a red run names its
 * failing suite without opening the full log.
 */
export function parseSuiteResults(log) {
  if (typeof log !== "string") return [];
  const suites = [];
  for (const raw of log.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const m = line.match(/^SUITE_RESULT\t([^\t]+)\t(pass|fail)\t(\d+)$/);
    if (!m || !m[1].trim()) continue;
    const durationMs = Number(m[3]);
    if (!Number.isSafeInteger(durationMs)) continue;
    suites.push({ name: m[1], status: m[2], durationMs });
  }
  return suites;
}

/**
 * Keep only well-formed suite entries from an explicit suites array
 * (same shape parseSuiteResults returns). Anything else is dropped —
 * a stored result never carries a half-shaped suite.
 */
function normalizeSuites(suites) {
  const out = [];
  for (const s of suites) {
    if (!s || typeof s !== "object") continue;
    const durationMs =
      typeof s.durationMs === "string" && /^\d+$/.test(s.durationMs)
        ? Number(s.durationMs)
        : s.durationMs;
    if (
      typeof s.name === "string" && s.name.trim() && !/[\t\r\n]/.test(s.name) &&
      (s.status === "pass" || s.status === "fail") &&
      Number.isSafeInteger(durationMs) && durationMs >= 0
    ) {
      out.push({ name: s.name, status: s.status, durationMs });
    }
  }
  return out;
}
