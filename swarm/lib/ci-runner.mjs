#!/usr/bin/env node
/**
 * ci-runner.mjs — detached KILN CI queue drainer.
 *
 * Usage: node ci-runner.mjs <stateDir>
 *
 * Drains <stateDir>/ci/queue.jsonl: for each job, clones the bare repo at
 * the pushed SHA into a temp dir, runs the repo's configured command from
 * <stateDir>/ci/repos.json, and writes the result via lib/ci.mjs. The
 * run's FULL output streams to a transcript file that lib/ci.mjs stores
 * beside the result (the result JSON still carries a 120-line tail for
 * quick display). Removes the runner lock when the queue is empty.
 * The lock is claimed by PID LIVENESS, not age: a lock whose recorded
 * pid is dead is reaped immediately (a runner killed with the daemon
 * must never wedge CI), and a lock held by a live pid means another
 * runner owns the drain — this one yields.
 *
 * Runs detached from the API server so a slow test suite can never block
 * pushes or the daemon tick.
 */
import { spawn } from "node:child_process";
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync,
  mkdtempSync, rmSync, statSync, createWriteStream, openSync, closeSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  ciDir, loadRepoConfig, parseSuiteResults, writeResult, readResult,
  readRunnerLock, runnerLockPath,
} from "./ci.mjs";
import { pidAlive } from "./state.mjs";
import { repoPath } from "./git.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STALE_LOCK_MS = 30 * 60 * 1000;
const LOG_TAIL_LINES = 120;

function log(...a) {
  console.log(`[ci-runner ${new Date().toISOString()}]`, ...a);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Claim the runner lock for THIS process, or yield (return false) when
 * a live runner already holds it. Liveness decides: a lock naming a
 * dead pid is reaped whatever its age; a lock naming a live pid that
 * isn't us means another runner owns the drain. When kickRunner spawns
 * us it creates the lock file a moment before writing our pid into it,
 * so an unreadable-but-young lock gets a short grace of re-reads before
 * the age fallback applies.
 */
async function claimLock(dir) {
  const lock = runnerLockPath(dir);
  let existing = readRunnerLock(dir);
  for (let i = 0; !existing && existsSync(lock) && i < 20; i++) {
    await sleep(100); // the spawner may still be writing our pid in
    existing = readRunnerLock(dir);
  }
  if (existing) {
    if (existing.pid === process.pid) return true; // kickRunner's lock, for us
    if (pidAlive(existing.pid)) return false; // another live runner owns it
    log(`reaping dead runner's lock (pid ${existing.pid})`);
    try { unlinkSync(lock); } catch {}
  } else if (existsSync(lock)) {
    try {
      if (Date.now() - statSync(lock).mtimeMs <= STALE_LOCK_MS) return false;
      unlinkSync(lock); // unreadable AND old — garbage, reap by age
    } catch { return false; }
  }
  try {
    const fd = openSync(lock, "wx");
    writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    closeSync(fd);
    return true;
  } catch (e) {
    if (e.code === "EEXIST") return false; // another kick won the race
    throw e;
  }
}

function readQueue(dir) {
  const p = join(ciDir(dir), "queue.jsonl");
  try {
    return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function writeQueue(dir, jobs) {
  writeFileSync(join(ciDir(dir), "queue.jsonl"), jobs.map((j) => JSON.stringify(j)).join("\n") + (jobs.length ? "\n" : ""));
}

/**
 * Run argv in cwd with a wall-clock timeout. Resolves
 * { exitCode, timedOut, tail }. The in-memory tail (last
 * LOG_TAIL_LINES lines) is what the result JSON carries for quick
 * display; when logStream is given, the FULL output also streams to
 * it — that file becomes the run's retained log (lib/ci.mjs stores
 * it beside the result), so a failure is diagnosable from more
 * than its last 120 lines.
 */
function runCmd(argv, cwd, timeoutMs, logStream = null) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    // SUITE_RESULT verdict lines are collected line-buffered, independent
    // of the 200KB in-memory tail cap, and land in the result doc's
    // `suites` array (see parseSuiteResults in lib/ci.mjs).
    let pendingLine = "";
    const suites = [];
    const collectSuites = (text, flush = false) => {
      pendingLine += text;
      const lines = pendingLine.split("\n");
      pendingLine = flush ? "" : lines.pop();
      for (const line of lines) suites.push(...parseSuiteResults(line));
    };
    const cap = (d) => {
      if (logStream) { try { logStream.write(d); } catch { /* log loss must not fail the run */ } }
      const text = d.toString();
      collectSuites(text);
      out += text; if (out.length > 200000) out = out.slice(-200000);
    };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch {}
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(t);
      collectSuites("", true);
      const lines = out.split("\n");
      resolve({
        exitCode: code ?? 1,
        timedOut,
        tail: lines.slice(-LOG_TAIL_LINES).join("\n"),
        suites,
      });
    });
    child.on("error", (e) => {
      clearTimeout(t);
      collectSuites("", true);
      if (logStream) { try { logStream.write(`spawn failed: ${e.message}\n`); } catch {} }
      resolve({ exitCode: 1, timedOut: false, tail: `spawn failed: ${e.message}`, suites });
    });
  });
}

async function runJob(dir, job) {
  const cfg = loadRepoConfig(dir)[`${job.owner}/${job.repo}`];
  if (!cfg || !cfg.command) {
    return { status: "skipped", reason: "no CI config for repo" };
  }
  const work = mkdtempSync(join(tmpdir(), "kiln-ci-"));
  // The run's full transcript (clone + checkout + test command) streams
  // here — OUTSIDE the work dir, which is deleted below. writeResult
  // stores it beside the result JSON as the retained full log.
  const logFile = join(tmpdir(), `kiln-ci-log-${job.id}.log`);
  const logStream = createWriteStream(logFile, { flags: "w" });
  logStream.on("error", () => { /* a lost log must not fail the run */ });
  const section = (s) => { try { logStream.write(`\n[kiln-ci] $ ${s}\n`); } catch {} };
  const startedMs = Date.now();
  try {
    const bare = repoPath(dir, job.owner, job.repo);
    if (!existsSync(bare)) {
      return { status: "error", reason: "repo vanished mid-queue" };
    }
    // Clone the exact pushed SHA from the local bare repo — no network.
    section(`git clone -q ${bare} src`);
    const clone = await runCmd(
      ["git", "clone", "-q", bare, work + "/src"], tmpdir(), 60000, logStream
    );
    if (clone.exitCode !== 0) {
      return { status: "error", reason: "clone failed", logTail: clone.tail, logFile, suites: [] };
    }
    const src = work + "/src";
    section(`git -C src checkout -q ${job.sha}`);
    const co = await runCmd(["git", "-C", src, "checkout", "-q", job.sha], tmpdir(), 30000, logStream);
    if (co.exitCode !== 0) {
      return { status: "error", reason: `checkout ${job.sha.slice(0, 12)} failed`, logTail: co.tail, logFile, suites: [] };
    }
    // argv-split the configured command (no shell — the operator wrote it,
    // but shell interpolation would still be a footgun).
    const argv = cfg.command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g).map((s) =>
      s.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1")
    );
    const timeoutMs = cfg.timeoutMs || 600000;
    section(cfg.command);
    const r = await runCmd(argv, src, timeoutMs, logStream);
    const durationMs = Date.now() - startedMs;
    return {
      status: r.timedOut ? "timeout" : r.exitCode === 0 ? "pass" : "fail",
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      durationMs,
      command: cfg.command,
      logTail: r.tail,
      logFile,
      suites: r.suites,
    };
  } finally {
    await new Promise((res) => logStream.end(res));
    try { rmSync(work, { recursive: true, force: true }); } catch {}
  }
}

async function main() {
  const dir = process.argv[2];
  if (!dir) { console.error("ci-runner: missing <stateDir>"); process.exit(2); }
  const lock = runnerLockPath(dir);
  if (!(await claimLock(dir))) {
    log("another live runner holds the lock — not draining");
    return;
  }
  log(`draining queue for ${dir}`);
  for (;;) {
    const jobs = readQueue(dir);
    if (!jobs.length) break;
    const job = jobs[0];
    // Dequeue first: if this runner dies mid-job, the job is gone from
    // the queue — but lib/ci.mjs reconcileCiQueue (daemon boot + tick)
    // re-queues any branch tip whose verdict never landed, so a crash
    // delays a verdict instead of erasing it.
    writeQueue(dir, jobs.slice(1));
    // Idempotent by SHA: a verdict that already exists is never re-run,
    // so a duplicated enqueue (push kick racing a reconcile) is a no-op.
    if (readResult(dir, job.owner, job.repo, job.sha)) {
      log(`job ${job.id}: ${job.sha.slice(0, 12)} already recorded — skipping`);
      continue;
    }
    log(`job ${job.id}: ${job.owner}/${job.repo}@${job.sha.slice(0, 12)} (${job.ref})`);
    let result;
    try {
      result = await runJob(dir, job);
    } catch (e) {
      result = { status: "error", reason: `runner exception: ${e.message}` };
    }
    try {
      const doc = writeResult(dir, job, result);
      // The temp transcript has been stored beside the result; drop it.
      if (doc?.log && result.logFile) { try { unlinkSync(result.logFile); } catch {} }
    } catch (e) {
      log(`result write failed: ${e.message}`);
    }
    log(`job ${job.id}: ${result.status}`);
  }
  try { unlinkSync(lock); } catch {}
  log("queue drained");
}

main();
