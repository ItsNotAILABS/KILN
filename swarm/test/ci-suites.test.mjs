/**
 * KILN CI structured suite results (SUITE_RESULT lines).
 *
 * The shipped CI design retains each run's FULL log; this pins the
 * structured layer on top of it: a test command reports per-suite
 * outcomes as tab-separated lines
 *
 *   SUITE_RESULT\t<name>\t<pass|fail>\t<duration-ms>
 *
 * and the result JSON carries them as doc.suites ALONGSIDE the
 * retained log (doc.log metadata + readLog), never instead of it.
 *
 *   - unit: parseSuiteResults — well-formed lines (multiple, names
 *     with spaces, CRLF, unterminated final line), malformed lines
 *     ignored, absent / non-string input -> [].
 *   - unit: writeResult — explicit suites persist to disk, the
 *     logFile fallback parses the run's stored log text (never the
 *     doc.log metadata), explicit suites are never merged with or
 *     duplicated by the fallback, no suites anywhere -> [].
 *   - e2e: real pushes — the runner collects suite lines DURING
 *     streaming: a line split across chunks, a stderr line landing
 *     while a stdout line is still partial, and suite lines that
 *     scroll out of the 120-line tail all land in doc.suites, with
 *     the full log retained; a failing run reports its suites too.
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
import { parseSuiteResults, writeResult, readResult, readLatest, readLog } from "../lib/ci.mjs";

const SHA = "b".repeat(40);
const JOB = { owner: "auro", repo: "unit", ref: "refs/heads/main", sha: SHA };

describe("parseSuiteResults", () => {
  it("parses well-formed lines — multiple suites, names with spaces, pass and fail", () => {
    const log = [
      "some ordinary output",
      "SUITE_RESULT\tunit tests\tpass\t120",
      "SUITE_RESULT\tmemory vectors suite\tfail\t3456",
      "SUITE_RESULT\ta\tpass\t0",
      "trailing noise",
    ].join("\n") + "\n";
    assert.deepEqual(parseSuiteResults(log), [
      { name: "unit tests", status: "pass", durationMs: 120 },
      { name: "memory vectors suite", status: "fail", durationMs: 3456 },
      { name: "a", status: "pass", durationMs: 0 },
    ]);
  });

  it("parses CRLF lines and a final line with no trailing newline", () => {
    assert.deepEqual(parseSuiteResults("SUITE_RESULT\tcrlf suite\tpass\t5\r\n"), [
      { name: "crlf suite", status: "pass", durationMs: 5 },
    ]);
    assert.deepEqual(parseSuiteResults("noise\nSUITE_RESULT\tno newline\tfail\t9"), [
      { name: "no newline", status: "fail", durationMs: 9 },
    ]);
  });

  it("ignores malformed lines and keeps the well-formed ones around them", () => {
    const log = [
      "SUITE_RESULT\tgood one\tpass\t10",
      "SUITE_RESULT missing fields",                       // no tabs at all
      "SUITE_RESULT\tonly name\tpass",                      // missing duration
      "SUITE_RESULT\tname\tpass\t10\textra",                // extra field
      "SUITE_RESULT\tname\tpassed\t10",                     // status not pass|fail
      "SUITE_RESULT\tname\tPASS\t10",                       // status is case-sensitive
      "SUITE_RESULT\tname\tpass\tabc",                      // non-numeric duration
      "SUITE_RESULT\tname\tpass\t-5",                       // negative duration
      "SUITE_RESULT\tname\tpass\t1.5",                      // non-integer duration
      "SUITE_RESULT\tname\tpass\t10 ",                      // trailing junk
      "SUITE_RESULT\t\tpass\t10",                           // empty name
      "SUITE_RESULT\t   \tpass\t10",                        // whitespace-only name
      "xSUITE_RESULT\tname\tpass\t10",                      // not at line start
      " SUITE_RESULT\tname\tpass\t10",                      // leading space
      "SUITE_RESULT name pass 10",                          // space-separated lookalike
      "SUITE_RESULT\tgood two\tfail\t20",
    ].join("\n");
    assert.deepEqual(parseSuiteResults(log), [
      { name: "good one", status: "pass", durationMs: 10 },
      { name: "good two", status: "fail", durationMs: 20 },
    ]);
  });

  it("absent or non-string input yields []", () => {
    for (const bad of [undefined, null, 42, true, {}, [], ["SUITE_RESULT\tx\tpass\t1"]]) {
      assert.deepEqual(parseSuiteResults(bad), []);
    }
    assert.deepEqual(parseSuiteResults(""), []);
    assert.deepEqual(parseSuiteResults("no suite lines here\n"), []);
  });
});

describe("writeResult suites persistence (unit)", () => {
  it("persists explicit suites to disk alongside the retained full log", () => {
    const dir = makeStateDir();
    const src = join(dir, "transcript.log");
    const text = "first line\nSUITE_RESULT\tfrom the log\tpass\t1\nlast line\n";
    writeFileSync(src, text);
    const suites = [
      { name: "runner suite one", status: "pass", durationMs: 111 },
      { name: "runner suite two", status: "fail", durationMs: 222 },
    ];
    const doc = writeResult(dir, JOB, { status: "fail", logTail: "last line", logFile: src, suites });
    assert.deepEqual(doc.suites, suites);
    // The shipped log design is untouched: metadata on doc.log, full
    // text via readLog, temp path nowhere.
    assert.equal(doc.logFile, undefined);
    assert.equal(doc.log.truncated, false);
    assert.equal(doc.log.bytes, Buffer.byteLength(text));
    assert.equal(readLog(dir, "auro", "unit", SHA), text);
    // And it is the PERSISTED doc that carries the suites.
    assert.deepEqual(readResult(dir, "auro", "unit", SHA).suites, suites);
    assert.deepEqual(readLatest(dir, "auro", "unit", "main").suites, suites);
  });

  it("explicit suites win verbatim — the log fallback never merges or duplicates", () => {
    const dir = makeStateDir();
    const src = join(dir, "transcript.log");
    writeFileSync(src, "SUITE_RESULT\tsame suite\tpass\t7\nSUITE_RESULT\tlog only suite\tpass\t8\n");
    const doc = writeResult(dir, JOB, {
      status: "pass", logFile: src,
      suites: [{ name: "same suite", status: "pass", durationMs: 7 }],
    });
    assert.deepEqual(doc.suites, [{ name: "same suite", status: "pass", durationMs: 7 }]);
  });

  it("with no explicit suites, parses the stored log text — not the doc.log metadata", () => {
    const dir = makeStateDir();
    const src = join(dir, "transcript.log");
    writeFileSync(src, "hello\nSUITE_RESULT\tstored log suite\tfail\t64\nbye\n");
    const doc = writeResult(dir, JOB, { status: "fail", logTail: "bye", logFile: src });
    assert.deepEqual(doc.suites, [{ name: "stored log suite", status: "fail", durationMs: 64 }]);
    assert.ok(doc.log && doc.log.bytes > 0, "full log still retained");
    assert.match(readLog(dir, "auro", "unit", SHA), /stored log suite/);
  });

  it("a result with no suites anywhere gets suites: []", () => {
    const dir = makeStateDir();
    const doc = writeResult(dir, JOB, { status: "skipped", reason: "no CI config for repo" });
    assert.deepEqual(doc.suites, []);
    assert.deepEqual(readResult(dir, "auro", "unit", SHA).suites, []);
  });

  it("drops half-shaped entries from an explicit suites array", () => {
    const dir = makeStateDir();
    const doc = writeResult(dir, JOB, {
      status: "pass",
      suites: [
        { name: "kept", status: "pass", durationMs: 3 },
        { name: "bad status", status: "passed", durationMs: 3 },
        { name: "bad duration", status: "pass", durationMs: -1 },
        { status: "pass", durationMs: 3 },
        "not an object",
        null,
      ],
    });
    assert.deepEqual(doc.suites, [{ name: "kept", status: "pass", durationMs: 3 }]);
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
  const work = mkdtempSync(join(tmpdir(), "kiln-ci-suites-test-"));
  const url = `http://oauth2:${token}@127.0.0.1:${api.port}/git/auro/${repo}`;
  await git(work, ["init", "-q", "-b", "main", "src"]);
  writeFileSync(join(work, "src", "NOTE.md"), "ci suites probe\n");
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

const byName = (a, b) => (a.name < b.name ? -1 : 1);

describe("ci suite results (e2e)", () => {
  it("collects chunk-split and interleaved suite lines during streaming, beyond the tail", async () => {
    api = await startApiServer(dir, { apiPort: 0 });
    // The stdout suite line is split across two writes 60ms apart;
    // while it is still partial, stderr delivers a complete suite
    // line of its own. Then 300 filler lines push both early suite
    // lines out of the 120-line tail. A shared, unbuffered, or
    // tail-scraping collector loses some or all of these.
    const script = [
      "process.stdout.write('SUITE_RESULT\\tpartial chunk suite\\tpa');",
      "process.stderr.write('SUITE_RESULT\\tstderr suite\\tfail\\t3\\n');",
      "setTimeout(() => {",
      "  process.stdout.write('ss\\t42\\n');",
      "  for (let i = 1; i <= 300; i++) console.log('fill-' + i);",
      "  process.stdout.write('SUITE_RESULT\\tfinal suite\\tpass\\t9\\n');",
      "}, 60);",
    ].join(" ");
    const sha = await pushProbe("ci-suites-pass", `node -e "${script}"`);
    const doc = readLatest(dir, "auro", "ci-suites-pass", "main");
    assert.equal(doc.status, "pass", "run status still comes from the exit code, not suite lines");
    assert.deepEqual([...doc.suites].sort(byName), [
      { name: "final suite", status: "pass", durationMs: 9 },
      { name: "partial chunk suite", status: "pass", durationMs: 42 },
      { name: "stderr suite", status: "fail", durationMs: 3 },
    ]);
    // The early suites really did scroll out of the tail — they were
    // collected during streaming, not scraped off the end.
    assert.ok(!doc.logTail.includes("partial chunk suite"), "early suite is beyond the tail");
    assert.ok(doc.logTail.includes("final suite"));
    // And the full log is retained alongside, suite lines included.
    assert.equal(doc.log.truncated, false);
    const stored = readLog(dir, "auro", "ci-suites-pass", sha);
    assert.ok(stored.split("\n").includes("fill-1"));
    assert.ok(stored.split("\n").includes("fill-300"));
    assert.match(stored, /SUITE_RESULT\tstderr suite\tfail\t3/);
    // Status endpoint consumers see the same suites.
    const res = await fetch(`http://127.0.0.1:${api.port}/git/auro/ci-suites-pass/ci/status/${sha}`);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).suites, doc.suites);
  });

  it("a failing run reports its suites too, with its full log retained", async () => {
    const script = "console.log('SUITE_RESULT\\tred suite\\tfail\\t17'); console.log('boom'); process.exit(1)";
    const sha = await pushProbe("ci-suites-fail", `node -e "${script}"`);
    const doc = readLatest(dir, "auro", "ci-suites-fail", "main");
    assert.equal(doc.status, "fail");
    assert.deepEqual(doc.suites, [{ name: "red suite", status: "fail", durationMs: 17 }]);
    const stored = readLog(dir, "auro", "ci-suites-fail", sha);
    assert.match(stored, /SUITE_RESULT\tred suite\tfail\t17/);
    assert.ok(stored.split("\n").includes("boom"));
  });
});

after(async () => {
  if (api) { try { api.server.close(); } catch {} }
});
