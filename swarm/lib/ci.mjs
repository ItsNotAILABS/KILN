/**
 * KILN-native CI: push-time verification for hosted git repos.
 *
 * On every authenticated push, the API server snapshots refs before the
 * receive-pack and diffs after; changed branches with a CI config get a job
 * enqueued. A detached runner (lib/ci-runner.mjs) drains the queue: it
 * clones the pushed SHA into a temp dir, runs the repo's configured test
 * command, and writes a result JSON. Results are served publicly, GitHub
 * commit-status style.
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
  const doc = {
    schema: "kiln.ci-result.v1",
    ...result,
    owner: job.owner,
    repo: job.repo,
    ref: job.ref,
    sha: job.sha,
    recordedAt: new Date().toISOString(),
  };
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
