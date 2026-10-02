#!/usr/bin/env node
/**
 * ci-runner.mjs — detached KILN CI queue drainer.
 *
 * Usage: node ci-runner.mjs <stateDir>
 *
 * Drains <stateDir>/ci/queue.jsonl: for each job, clones the bare repo at
 * the pushed SHA into a temp dir, runs the repo's configured command from
 * <stateDir>/ci/repos.json, and writes the result via lib/ci.mjs. Removes
 * the runner lock when the queue is empty. Stale locks (>30 min) are
 * reaped — a crashed runner must not wedge CI forever.
 *
 * Runs detached from the API server so a slow test suite can never block
 * pushes or the daemon tick.
 */
import { spawn } from "node:child_process";
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync,
  mkdtempSync, rmSync, statSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { ciDir, loadRepoConfig, writeResult } from "./ci.mjs";
import { repoPath } from "./git.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STALE_LOCK_MS = 30 * 60 * 1000;
const LOG_TAIL_LINES = 120;

function log(...a) {
  console.log(`[ci-runner ${new Date().toISOString()}]`, ...a);
}

function reapStaleLock(dir) {
  const lock = join(ciDir(dir), "runner.lock");
  try {
    const st = statSync(lock);
    if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
      log("reaping stale runner lock");
      unlinkSync(lock);
      return true;
    }
  } catch { /* no lock or unreadable */ }
  return false;
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

/** Run argv in cwd with a wall-clock timeout. Resolves { exitCode, timedOut, tail }. */
function runCmd(argv, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const cap = (d) => { out += d.toString(); if (out.length > 200000) out = out.slice(-200000); };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch {}
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(t);
      const lines = out.split("\n");
      resolve({
        exitCode: code ?? 1,
        timedOut,
        tail: lines.slice(-LOG_TAIL_LINES).join("\n"),
      });
    });
    child.on("error", (e) => {
      clearTimeout(t);
      resolve({ exitCode: 1, timedOut: false, tail: `spawn failed: ${e.message}` });
    });
  });
}

async function runJob(dir, job) {
  const cfg = loadRepoConfig(dir)[`${job.owner}/${job.repo}`];
  if (!cfg || !cfg.command) {
    return { status: "skipped", reason: "no CI config for repo" };
  }
  const work = mkdtempSync(join(tmpdir(), "kiln-ci-"));
  const startedMs = Date.now();
  try {
    const bare = repoPath(dir, job.owner, job.repo);
    if (!existsSync(bare)) {
      return { status: "error", reason: "repo vanished mid-queue" };
    }
    // Clone the exact pushed SHA from the local bare repo — no network.
    const clone = await runCmd(
      ["git", "clone", "-q", bare, work + "/src"], tmpdir(), 60000
    );
    if (clone.exitCode !== 0) {
      return { status: "error", reason: "clone failed", logTail: clone.tail };
    }
    const src = work + "/src";
    const co = await runCmd(["git", "-C", src, "checkout", "-q", job.sha], tmpdir(), 30000);
    if (co.exitCode !== 0) {
      return { status: "error", reason: `checkout ${job.sha.slice(0, 12)} failed`, logTail: co.tail };
    }
    // argv-split the configured command (no shell — the operator wrote it,
    // but shell interpolation would still be a footgun).
    const argv = cfg.command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g).map((s) =>
      s.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1")
    );
    const timeoutMs = cfg.timeoutMs || 600000;
    const r = await runCmd(argv, src, timeoutMs);
    const durationMs = Date.now() - startedMs;
    return {
      status: r.timedOut ? "timeout" : r.exitCode === 0 ? "pass" : "fail",
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      durationMs,
      command: cfg.command,
      logTail: r.tail,
    };
  } finally {
    try { rmSync(work, { recursive: true, force: true }); } catch {}
  }
}

async function main() {
  const dir = process.argv[2];
  if (!dir) { console.error("ci-runner: missing <stateDir>"); process.exit(2); }
  const lock = join(ciDir(dir), "runner.lock");
  log(`draining queue for ${dir}`);
  for (;;) {
    const jobs = readQueue(dir);
    if (!jobs.length) break;
    const job = jobs[0];
    writeQueue(dir, jobs.slice(1)); // dequeue first: a crash re-runs nothing twice
    log(`job ${job.id}: ${job.owner}/${job.repo}@${job.sha.slice(0, 12)} (${job.ref})`);
    let result;
    try {
      result = await runJob(dir, job);
    } catch (e) {
      result = { status: "error", reason: `runner exception: ${e.message}` };
    }
    try {
      writeResult(dir, job, result);
    } catch (e) {
      log(`result write failed: ${e.message}`);
    }
    log(`job ${job.id}: ${result.status}`);
  }
  try { unlinkSync(lock); } catch {}
  log("queue drained");
}

main();
