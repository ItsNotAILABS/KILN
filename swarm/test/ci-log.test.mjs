/**
 * KILN CI full-log retention.
 *
 * Results used to keep only a 120-line tail of a run's output, which
 * made real failures undiagnosable (the failing line had scrolled
 * past the tail). These tests pin the fix:
 *   - unit: writeResult stores the runner's streamed transcript
 *     beside the result JSON (doc.log metadata), readLog reads it
 *     back, and the retention cap truncates WITH an in-band marker
 *     and honest droppedBytes — never silently;
 *   - e2e: a real push whose command prints 300 lines and fails —
 *     the stored log and the public /ci/log/:sha endpoint carry
 *     line 1, not just the tail; a passing run retains its log too.
 *
 * NOTE: async spawn, never spawnSync — same event-loop deadlock
 * warning as ci.test.mjs.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeStateDir } from "./helpers.mjs";
import { loadApiToken } from "../lib/state.mjs";
import { startApiServer } from "../lib/httpapi.mjs";
import { writeResult, readLatest, readLog, ciLogMaxBytes } from "../lib/ci.mjs";

const SHA = "a".repeat(40);
const JOB = { owner: "auro", repo: "unit", ref: "refs/heads/main", sha: SHA };

describe("ci full-log retention (unit)", () => {
  it("stores the full log beside the result and references it from doc.log", () => {
    const dir = makeStateDir();
    const src = join(dir, "transcript.log");
    const text = "first line\n" + "middle\n".repeat(50) + "last line\n";
    writeFileSync(src, text);
    const doc = writeResult(dir, JOB, { status: "fail", logTail: "last line", logFile: src });
    assert.equal(doc.logFile, undefined, "temp path never reaches the stored doc");
    assert.equal(doc.log.truncated, false);
    assert.equal(doc.log.droppedBytes, 0);
    assert.equal(doc.log.bytes, Buffer.byteLength(text));
    assert.equal(readLog(dir, "auro", "unit", SHA), text);
  });

  it("truncates at the cap with a marker and honest droppedBytes", () => {
    const dir = makeStateDir();
    const src = join(dir, "big.log");
    const text = "line\n".repeat(50000); // 250_000 bytes
    writeFileSync(src, text);
    process.env.KILN_CI_LOG_MAX_BYTES = "65536";
    try {
      assert.equal(ciLogMaxBytes(), 65536);
      const doc = writeResult(dir, JOB, { status: "fail", logTail: "line", logFile: src });
      assert.equal(doc.log.truncated, true);
      assert.equal(doc.log.droppedBytes, 250000 - 65536);
      const stored = readLog(dir, "auro", "unit", SHA);
      assert.ok(stored.length <= 65536 + 200, "stored log is cap + marker, not the whole firehose");
      assert.match(stored, /\[kiln-ci\] log truncated: 184464 bytes dropped/);
    } finally {
      delete process.env.KILN_CI_LOG_MAX_BYTES;
    }
  });

  it("ciLogMaxBytes has a 64KB floor; a result without a log stays log-less", () => {
    process.env.KILN_CI_LOG_MAX_BYTES = "1";
    try {
      assert.equal(ciLogMaxBytes(), 64 * 1024);
    } finally {
      delete process.env.KILN_CI_LOG_MAX_BYTES;
    }
    const dir = makeStateDir();
    const doc = writeResult(dir, JOB, { status: "skipped", reason: "no CI config for repo" });
    assert.equal(doc.log, undefined);
    assert.equal(readLog(dir, "auro", "unit", SHA), null);
  });
});

// ------------------------------------------------------------ e2e

const dir = makeStateDir();
const token = loadApiToken(dir);
let api = null;

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

async function waitFor(cond, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function pushProbe(repo, command) {
  const auth = { Authorization: `Bearer ${token}` };
  const res = await fetch(`http://127.0.0.1:${api.port}/git/auro/${repo}`, {
    method: "POST", headers: auth,
  });
  assert.equal(res.status, 201);
  mkdirSync(join(dir, "ci"), { recursive: true });
  const cfgPath = join(dir, "ci", "repos.json");
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(cfgPath, "utf8")); } catch { /* first probe */ }
  cfg[`auro/${repo}`] = { command, timeoutMs: 60000 };
  writeFileSync(cfgPath, JSON.stringify(cfg));
  const work = mkdtempSync(join(tmpdir(), "kiln-ci-log-test-"));
  const url = `http://oauth2:${token}@127.0.0.1:${api.port}/git/auro/${repo}`;
  await git(work, ["init", "-q", "-b", "main", "src"]);
  writeFileSync(join(work, "src", "NOTE.md"), "ci log probe\n");
  await git(join(work, "src"), ["add", "."]);
  await git(join(work, "src"), ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "probe"]);
  const sha = await git(join(work, "src"), ["rev-parse", "HEAD"]);
  await git(join(work, "src"), ["push", "-q", url, "main"]);
  await waitFor(() => {
    const doc = readLatest(dir, "auro", repo, "main");
    return doc && doc.sha === sha;
  }, 90000, `ci result for ${repo}`);
  return sha;
}

describe("ci full-log retention (e2e)", () => {
  it("a failing 300-line run keeps its FIRST line in the stored log and the HTTP endpoint", async () => {
    api = await startApiServer(dir, { apiPort: 0 });
    const sha = await pushProbe(
      "ci-log-fail",
      "node -e \"for (let i = 1; i <= 300; i++) console.log('ci-line-' + i); process.exit(1)\"",
    );
    const doc = readLatest(dir, "auro", "ci-log-fail", "main");
    assert.equal(doc.status, "fail");
    // The tail alone could NOT diagnose this: it holds only the last lines.
    const tailLines = doc.logTail.split("\n");
    assert.ok(tailLines.includes("ci-line-300"));
    assert.ok(!tailLines.includes("ci-line-1"), "tail really is just a tail");
    // The retained full log has the whole transcript, from line 1.
    assert.equal(doc.log.truncated, false);
    assert.ok(doc.log.bytes > 3000);
    const stored = readLog(dir, "auro", "ci-log-fail", sha);
    const storedLines = stored.split("\n");
    assert.ok(storedLines.includes("ci-line-1"), "first line retained");
    assert.ok(storedLines.includes("ci-line-300"));
    assert.match(stored, /\[kiln-ci\] \$ git clone/);
    // And it is served publicly, like status.
    const res = await fetch(`http://127.0.0.1:${api.port}/git/auro/ci-log-fail/ci/log/${sha}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/plain/);
    const body = await res.text();
    assert.ok(body.split("\n").includes("ci-line-1"));
    const missing = await fetch(`http://127.0.0.1:${api.port}/git/auro/ci-log-fail/ci/log/deadbeef`);
    assert.equal(missing.status, 404);
  });

  it("a passing run retains its full log too", async () => {
    const sha = await pushProbe(
      "ci-log-pass",
      "node -e \"for (let i = 1; i <= 50; i++) console.log('ok-line-' + i)\"",
    );
    const doc = readLatest(dir, "auro", "ci-log-pass", "main");
    assert.equal(doc.status, "pass");
    assert.ok(doc.log && doc.log.bytes > 0);
    const stored = readLog(dir, "auro", "ci-log-pass", sha);
    assert.ok(stored.split("\n").includes("ok-line-1"));
    assert.ok(stored.split("\n").includes("ok-line-50"));
  });
});

after(async () => {
  if (api) { try { api.server.close(); } catch {} }
});
