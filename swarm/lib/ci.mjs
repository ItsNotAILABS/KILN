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
  openSync, closeSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { repoPath } from "./git.mjs";

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

/**
 * Enqueue one CI job and kick the detached runner. Best-effort by design:
 * CI must never break or slow a push — the push response already went out
 * by the time this runs.
 */
export function enqueueCiJob(dir, { owner, repo, ref, sha }) {
  ensureCiDir(dir);
  const job = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    owner, repo, ref, sha,
    queuedAt: new Date().toISOString(),
  };
  appendFileSync(queuePath(dir), JSON.stringify(job) + "\n");
  kickRunner(dir);
}

/** Spawn the detached queue drainer unless one is already running. */
function kickRunner(dir) {
  const lock = join(ciDir(dir), "runner.lock");
  try {
    const fd = openSync(lock, "wx");
    const child = spawn(process.execPath, [RUNNER, dir], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });
    child.unref();
    // The runner removes the lock when the queue is drained; if it crashes,
    // the lock goes stale — ci-runner reaps locks older than 30 minutes.
    writeFileSync(lock, JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }));
    closeSync(fd);
  } catch (e) {
    if (e.code !== "EEXIST") throw e; // runner already draining
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
  const { logFile, ...rest } = result;
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
  writeFileSync(join(rdir, `${job.sha}.json`), JSON.stringify(doc, null, 2) + "\n");
  writeFileSync(join(rdir, "latest.json"), JSON.stringify(doc, null, 2) + "\n");
  // Per-branch pointer: refs/heads/main -> latest for that branch.
  const branch = job.ref.startsWith("refs/heads/") ? job.ref.slice("refs/heads/".length) : null;
  if (branch && /^[a-zA-Z0-9._-]+$/.test(branch)) {
    writeFileSync(join(rdir, `latest-${branch}.json`), JSON.stringify(doc, null, 2) + "\n");
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
    writeFileSync(join(rdir, `${job.sha}.log`), body);
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
  for (const line of log.split("\n")) {
    const m = line.match(/^SUITE_RESULT\t([^\t]+)\t(pass|fail)\t(\d+)$/);
    if (m) suites.push({ name: m[1], status: m[2], durationMs: Number(m[3]) });
  }
  return suites;
}
