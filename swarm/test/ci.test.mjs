/**
 * KILN-native CI: push a commit, verify a verification job runs and the
 * status endpoints report it honestly.
 *
 * Real git round trip against the daemon's HTTP API (no mocks): create a
 * repo, seed ci/repos.json with a trivially-passing command, push a commit,
 * wait for the detached runner, then check /ci/status/:sha and /ci/latest.
 * Also proves a push to a repo WITHOUT ci config enqueues nothing.
 *
 * NOTE: async spawn, never spawnSync — the API server under test lives in
 * this same event loop, and spawnSync would deadlock it (git waits for the
 * server; the server can't run while the loop is blocked).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { makeStateDir } from "./helpers.mjs";
import { loadApiToken } from "../lib/state.mjs";
import { startApiServer } from "../lib/httpapi.mjs";
import {
  snapshotRefs, readLatest, readResult, readQueueJobs, reconcileCiQueue,
  kickRunner, runnerLockLive, runnerLockPath,
} from "../lib/ci.mjs";
import { repoPath } from "../lib/git.mjs";

const dir = makeStateDir();
const token = loadApiToken(dir);
let api = null;

/** Async git — keeps the event loop alive for the in-process API server. */
function git(cwd, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`git ${args.join(" ")} exited ${code}: ${stderr.slice(0, 300)}`));
      else resolve(stdout.trim());
    });
  });
}

async function apiGet(path) {
  const res = await fetch(`http://127.0.0.1:${api.port}${path}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function waitFor(cond, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

describe("kiln CI", () => {
  it("push triggers verification and status endpoints report it", async () => {
    api = await startApiServer(dir, { apiPort: 0 });
    const auth = { Authorization: `Bearer ${token}` };

    // Create repo via API.
    let res = await fetch(`http://127.0.0.1:${api.port}/git/auro/ci-probe`, {
      method: "POST", headers: auth,
    });
    assert.equal(res.status, 201);

    // Enroll it in CI with a fast always-pass command that emits more
    // lines than the 120-line logTail (proving FULL log retention) plus
    // two SUITE_RESULT verdict lines (proving per-suite persistence).
    mkdirSync(join(dir, "ci"), { recursive: true });
    writeFileSync(join(dir, "ci", "repos.json"), JSON.stringify({
      "auro/ci-probe": {
        command: "node -e \"for(let i=1;i<=150;i++) console.log('line '+i); console.log('SUITE_RESULT\\talpha\\tpass\\t12'); console.log('SUITE_RESULT\\tbeta suite\\tpass\\t34')\"",
        timeoutMs: 30000,
      },
    }));

    // Push a real commit through smart HTTP (async — see NOTE above).
    const work = mkdtempSync(join(tmpdir(), "kiln-ci-test-"));
    const url = `http://oauth2:${token}@127.0.0.1:${api.port}/git/auro/ci-probe`;
    await git(work, ["init", "-q", "-b", "main", "src"]);
    writeFileSync(join(work, "src", "NOTE.md"), "ci probe\n");
    await git(join(work, "src"), ["add", "."]);
    await git(join(work, "src"), ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "probe"]);
    const sha = await git(join(work, "src"), ["rev-parse", "HEAD"]);
    await git(join(work, "src"), ["push", "-q", url, "main"]);

    // The detached runner should verify it.
    await waitFor(async () => {
      const doc = readLatest(dir, "auro", "ci-probe", "main");
      return doc && doc.sha === sha;
    }, 60000, "ci result");

    const doc = readLatest(dir, "auro", "ci-probe", "main");
    assert.equal(doc.status, "pass");
    assert.equal(doc.sha, sha);

    // Full-log retention: the doc points at the stored <sha>.log and the
    // stored log holds the WHOLE run (line 1 and line 150), not a tail.
    assert.equal(doc.log.file, `${sha}.log`);
    assert.equal(doc.log.truncated, false);
    assert.ok(doc.log.bytes > 1000);
    const storedLog = readFileSync(
      join(dir, "ci", "results", "auro", "ci-probe", doc.log.file), "utf8"
    );
    assert.match(storedLog, /^line 1$/m);
    assert.match(storedLog, /^line 150$/m);

    // Per-suite verdicts persisted on the result doc.
    assert.deepEqual(doc.suites, [
      { name: "alpha", status: "pass", durationMs: 12 },
      { name: "beta suite", status: "pass", durationMs: 34 },
    ]);

    // Public status endpoints.
    const s1 = await apiGet(`/git/auro/ci-probe/ci/status/${sha}`);
    assert.equal(s1.status, 200);
    assert.equal(s1.body.status, "pass");
    const s2 = await apiGet(`/git/auro/ci-probe/ci/latest?branch=main`);
    assert.equal(s2.status, 200);
    assert.equal(s2.body.sha, sha);
    const s3 = await apiGet(`/git/auro/ci-probe/ci/status/deadbeef`);
    assert.equal(s3.status, 404);
  });

  it("push to a repo without CI config enqueues nothing", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    let res = await fetch(`http://127.0.0.1:${api.port}/git/auro/ci-bare`, {
      method: "POST", headers: auth,
    });
    assert.equal(res.status, 201);
    const work = mkdtempSync(join(tmpdir(), "kiln-ci-test-"));
    const url = `http://oauth2:${token}@127.0.0.1:${api.port}/git/auro/ci-bare`;
    await git(work, ["init", "-q", "-b", "main", "src"]);
    writeFileSync(join(work, "src", "N.md"), "x\n");
    await git(join(work, "src"), ["add", "."]);
    await git(join(work, "src"), ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x"]);
    await git(join(work, "src"), ["push", "-q", url, "main"]);
    await new Promise((r) => setTimeout(r, 3000)); // let any runner finish
    assert.equal(readLatest(dir, "auro", "ci-bare"), null);
    const s = await apiGet(`/git/auro/ci-bare/ci/latest`);
    assert.equal(s.status, 404);
  });

  it("snapshotRefs sees pushed branches", async () => {
    const refs = snapshotRefs(dir, "auro", "ci-probe");
    assert.ok(refs["refs/heads/main"], "main ref present");
    assert.match(refs["refs/heads/main"], /^[0-9a-f]{40}$/);
  });
});

/**
 * CI resilience: draining must survive daemon/runner death.
 *
 * The 2026-10-23 incident: a runner died with the daemon leaving its
 * lock behind; the lock's mere existence vetoed the next push's kick,
 * the recovered daemon never scanned the queue, and a queued job sat
 * undrained forever. A second job was dequeued-then-lost mid-run and
 * no reconciliation ever noticed. These tests pin the recovery paths:
 * reconcileCiQueue is the daemon's boot/tick entry point.
 */
describe("kiln CI reconciliation", () => {
  const rdir = makeStateDir();
  const bare = repoPath(rdir, "auro", "ci-recon");
  let sha1 = null;
  let sha2 = null;
  let work = null;

  async function deadPid() {
    const child = spawn(process.execPath, ["-e", ""]);
    await new Promise((r) => child.on("close", r));
    return child.pid;
  }

  it("setup: bare repo with one commit, enrolled in CI", async () => {
    mkdirSync(dirname(bare), { recursive: true });
    await git(rdir, ["init", "--bare", "-q", "-b", "main", bare]);
    mkdirSync(join(rdir, "ci"), { recursive: true });
    writeFileSync(join(rdir, "ci", "repos.json"), JSON.stringify({
      "auro/ci-recon": { command: "node -e \"console.log('recon ok')\"", timeoutMs: 30000 },
    }));
    work = mkdtempSync(join(tmpdir(), "kiln-ci-recon-"));
    await git(work, ["init", "-q", "-b", "main", "src"]);
    writeFileSync(join(work, "src", "A.md"), "a\n");
    await git(join(work, "src"), ["add", "."]);
    await git(join(work, "src"), ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "one"]);
    sha1 = await git(join(work, "src"), ["rev-parse", "HEAD"]);
    await git(join(work, "src"), ["push", "-q", bare, "main"]);
    assert.ok(sha1);
  });

  it("queued job stranded behind a dead runner's lock drains on reconcile", async () => {
    // The incident state: job in the queue, lock held by a DEAD pid.
    const job = {
      id: "recon-job-1", owner: "auro", repo: "ci-recon",
      ref: "refs/heads/main", sha: sha1, queuedAt: new Date().toISOString(),
    };
    writeFileSync(join(rdir, "ci", "queue.jsonl"), JSON.stringify(job) + "\n");
    writeFileSync(runnerLockPath(rdir), JSON.stringify({
      pid: await deadPid(), startedAt: new Date().toISOString(),
    }));
    assert.equal(runnerLockLive(rdir), false); // dead pid: NOT live

    // What the daemon now runs on boot (and every minute).
    const r = reconcileCiQueue(rdir, { graceMs: 0 });
    assert.equal(r.kicked, true);
    assert.equal(r.enqueued.length, 0); // already queued — no duplicate

    await waitFor(() => readResult(rdir, "auro", "ci-recon", sha1), 60000, "recon result");
    const doc = readResult(rdir, "auro", "ci-recon", sha1);
    assert.equal(doc.status, "pass");
    assert.equal(readQueueJobs(rdir).length, 0);
    assert.equal(existsSync(runnerLockPath(rdir)), false); // runner cleaned up
  });

  it("kickRunner refuses while a LIVE runner holds the lock", async () => {
    writeFileSync(runnerLockPath(rdir), JSON.stringify({
      pid: process.pid, startedAt: new Date().toISOString(),
    }));
    try {
      assert.equal(runnerLockLive(rdir), true);
      assert.equal(kickRunner(rdir), false);
      const r = reconcileCiQueue(rdir, { graceMs: 0 });
      assert.equal(r.runnerLive, true); // reconcile yields to the live drain
      assert.equal(r.kicked, false);
    } finally {
      try { unlinkSync(runnerLockPath(rdir)); } catch {}
    }
  });

  it("consumed-but-unwritten job is re-queued by tip reconciliation", async () => {
    // A second commit lands on the branch with NO queue entry and NO
    // result — exactly what a runner dying mid-run leaves behind.
    writeFileSync(join(work, "src", "B.md"), "b\n");
    await git(join(work, "src"), ["add", "."]);
    await git(join(work, "src"), ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "two"]);
    sha2 = await git(join(work, "src"), ["rev-parse", "HEAD"]);
    await git(join(work, "src"), ["push", "-q", bare, "main"]);
    assert.equal(readResult(rdir, "auro", "ci-recon", sha2), null);
    assert.equal(readQueueJobs(rdir).length, 0);

    const r = reconcileCiQueue(rdir, { graceMs: 0 });
    assert.equal(r.enqueued.length, 1);
    const queued = readQueueJobs(rdir);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].sha, sha2);
    assert.equal(queued[0].reconciled, true);
    assert.equal(r.kicked, true);

    await waitFor(() => readResult(rdir, "auro", "ci-recon", sha2), 60000, "re-queued result");
    assert.equal(readResult(rdir, "auro", "ci-recon", sha2).status, "pass");
  });

  it("already-recorded SHA is dropped from the queue, never re-run", async () => {
    const before = readResult(rdir, "auro", "ci-recon", sha2);
    assert.ok(before);
    // A duplicate enqueue for the recorded SHA (e.g. push kick racing a
    // reconcile) must be a no-op.
    const dup = {
      id: "recon-job-dup", owner: "auro", repo: "ci-recon",
      ref: "refs/heads/main", sha: sha2, queuedAt: new Date().toISOString(),
    };
    writeFileSync(join(rdir, "ci", "queue.jsonl"), JSON.stringify(dup) + "\n");
    const r = reconcileCiQueue(rdir, { graceMs: 0 });
    assert.deepEqual(r.droppedRecorded, ["recon-job-dup"]);
    assert.equal(r.enqueued.length, 0);
    assert.equal(r.kicked, false); // nothing left to drain
    assert.equal(readQueueJobs(rdir).length, 0);
    const afterDoc = readResult(rdir, "auro", "ci-recon", sha2);
    assert.equal(afterDoc.recordedAt, before.recordedAt); // untouched: not re-run
  });
});

after(async () => {
  if (api) { try { api.server.close(); } catch {} }
});
