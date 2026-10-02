/**
 * Tick instrumentation + stall self-abort tests.
 *
 *  - tick.json is written by a real daemon on a scratch state dir with the
 *    exact contract shape the external supervisor reads.
 *  - tickStalled() / resolveTickStallMs() unit tests (pure, in tickwatch.mjs).
 *  - Self-abort end-to-end: a real daemon wedged via the test-only
 *    KILN_TICK_WEDGE_TEST hook must exit(1) with a loud TICK STALL line.
 *  - `daemon status` prints the tick summary line (and "no tick data yet"
 *    before the first tick completes).
 *
 * Never touches the live daemon: every test uses a scratch state dir and
 * ephemeral apiPort 0; daemons are SIGTERMed in cleanup.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { makeStateDir } from "./helpers.mjs";
import {
  tickStalled, resolveTickStallMs, tickJsonPath, DEFAULT_TICK_STALL_ABORT_MS,
} from "../lib/tickwatch.mjs";

const DAEMON = new URL("../lib/daemon.mjs", import.meta.url).pathname;
const CLI = new URL("../swarm.mjs", import.meta.url).pathname;

const children = [];
after(() => { for (const c of children) { try { c.kill("SIGKILL"); } catch {} } });

/** Scratch dir whose daemon (if ever started) binds an ephemeral API port. */
function scratchDir(tickMs = 50) {
  const dir = makeStateDir();
  const cfgPath = join(dir, "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  cfg.apiPort = 0;
  cfg.tickMs = tickMs;
  cfg.autospawn = false;
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  return dir;
}

function spawnDaemon(dir, extraEnv = {}) {
  const child = spawn(process.execPath, [DAEMON], {
    env: { ...process.env, KILN_SWARM_DIR: dir, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return child;
}

function waitFor(cond, timeoutMs, label) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const iv = setInterval(() => {
      let ok = false;
      try { ok = cond(); } catch { ok = false; }
      if (ok) { clearInterval(iv); resolve(); }
      else if (Date.now() - t0 > timeoutMs) { clearInterval(iv); reject(new Error(`timeout: ${label}`)); }
    }, 100);
  });
}

async function stopDaemon(child) {
  child.kill("SIGTERM");
  await new Promise((r) => child.on("close", r));
}

describe("tickStalled()", () => {
  const T = 600000;
  it("is not stalled when the last tick is recent", () => {
    const now = Date.now();
    assert.equal(tickStalled({ lastTickEndMs: now - 1000, bootMs: now - 3600000, nowMs: now, thresholdMs: T }), false);
  });
  it("is stalled when the last tick is older than the threshold", () => {
    const now = Date.now();
    assert.equal(tickStalled({ lastTickEndMs: now - 700000, bootMs: now - 7200000, nowMs: now, thresholdMs: T }), true);
  });
  it("grace: never stalled before the daemon has been up longer than the threshold", () => {
    const now = Date.now();
    // last tick also old, but the daemon itself just booted
    assert.equal(tickStalled({ lastTickEndMs: now - 700000, bootMs: now - 300000, nowMs: now, thresholdMs: T }), false);
  });
  it("grace: never stalled before the first tick completes (null lastTickEndMs)", () => {
    const now = Date.now();
    assert.equal(tickStalled({ lastTickEndMs: null, bootMs: now - 7200000, nowMs: now, thresholdMs: T }), false);
  });
  it("boundary: exactly the threshold is not a stall; one ms past is", () => {
    assert.equal(tickStalled({ lastTickEndMs: 400000, bootMs: 0, nowMs: 1000000, thresholdMs: 600000 }), false);
    assert.equal(tickStalled({ lastTickEndMs: 399999, bootMs: 0, nowMs: 1000000, thresholdMs: 600000 }), true);
  });
  it("invalid threshold never stalls", () => {
    const now = Date.now();
    assert.equal(tickStalled({ lastTickEndMs: 0, bootMs: 0, nowMs: now, thresholdMs: 0 }), false);
    assert.equal(tickStalled({ lastTickEndMs: 0, bootMs: 0, nowMs: now, thresholdMs: -1 }), false);
    assert.equal(tickStalled({ lastTickEndMs: 0, bootMs: 0, nowMs: now, thresholdMs: NaN }), false);
  });
});

describe("resolveTickStallMs()", () => {
  const OLD = process.env.KILN_TICK_STALL_MS;
  after(() => {
    if (OLD === undefined) delete process.env.KILN_TICK_STALL_MS;
    else process.env.KILN_TICK_STALL_MS = OLD;
  });
  it("defaults to 10 minutes", () => {
    delete process.env.KILN_TICK_STALL_MS;
    assert.equal(resolveTickStallMs({}), DEFAULT_TICK_STALL_ABORT_MS);
    assert.equal(resolveTickStallMs({}), 600000);
  });
  it("reads config.json tickStallAbortMs", () => {
    delete process.env.KILN_TICK_STALL_MS;
    assert.equal(resolveTickStallMs({ tickStallAbortMs: 120000 }), 120000);
  });
  it("env KILN_TICK_STALL_MS wins over config", () => {
    process.env.KILN_TICK_STALL_MS = "1500";
    assert.equal(resolveTickStallMs({ tickStallAbortMs: 120000 }), 1500);
  });
  it("invalid env is ignored (falls back to config/default)", () => {
    process.env.KILN_TICK_STALL_MS = "bogus";
    assert.equal(resolveTickStallMs({ tickStallAbortMs: 120000 }), 120000);
    process.env.KILN_TICK_STALL_MS = "-5";
    assert.equal(resolveTickStallMs({}), 600000);
    process.env.KILN_TICK_STALL_MS = "";
    assert.equal(resolveTickStallMs({ tickStallAbortMs: 120000 }), 120000);
  });
});

describe("tick.json instrumentation", () => {
  it("writes tick.json with the exact contract shape and sane values after ticks", async () => {
    const dir = scratchDir(50);
    const child = spawnDaemon(dir);
    try {
      await waitFor(() => existsSync(tickJsonPath(dir)), 10000, "tick.json to appear");
      await new Promise((r) => setTimeout(r, 400)); // let several ticks accumulate
      const t = JSON.parse(readFileSync(tickJsonPath(dir), "utf8"));
      // Exact contract key set the external supervisor reads.
      assert.deepEqual(
        Object.keys(t).sort(),
        ["avgTickMs", "lastTickEndMs", "lastTickStartMs", "maxTickMs", "tickCount", "updatedAt"]
      );
      assert.ok(t.tickCount >= 2, `tickCount=${t.tickCount}, want >= 2`);
      const ageMs = Date.now() - t.lastTickEndMs;
      assert.ok(ageMs >= 0 && ageMs < 2000, `lastTickEndMs age ${ageMs}ms, want < 2000ms`);
      assert.ok(Number.isFinite(t.lastTickStartMs) && t.lastTickStartMs <= t.lastTickEndMs);
      assert.ok(Number.isFinite(t.avgTickMs) && t.avgTickMs >= 0);
      assert.ok(Number.isFinite(t.maxTickMs) && t.maxTickMs >= t.avgTickMs);
      assert.ok(!Number.isNaN(Date.parse(t.updatedAt)), `updatedAt=${t.updatedAt}`);
    } finally {
      await stopDaemon(child);
    }
  });
});

describe("stall self-abort", () => {
  it("exits(1) with a loud TICK STALL line when the tick loop wedges", async () => {
    const dir = scratchDir(100);
    let stdout = "";
    const child = spawnDaemon(dir, { KILN_TICK_STALL_MS: "1500", KILN_TICK_WEDGE_TEST: "1" });
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stdout += d; });
    const t0 = Date.now();
    const code = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("daemon did not self-abort within 90s")), 90000);
      child.on("exit", (c) => { clearTimeout(to); resolve(c); });
    });
    const elapsedMs = Date.now() - t0;
    assert.equal(code, 1, `exit code ${code} (want 1); stdout tail: ${stdout.slice(-600)}`);
    assert.ok(stdout.includes("TICK STALL"), "stdout must contain the loud TICK STALL line");
    assert.match(stdout, /no completed tick for \d+ms/, "stall line names the stall age");
    assert.match(stdout, /threshold 1500ms/, "stall line names the configured threshold");
    // The 30s in-process watchdog is the only abort path here: the abort
    // must not happen before it fires.
    assert.ok(elapsedMs >= 25000, `aborted after ${elapsedMs}ms — want >= 25s (the 30s watchdog)`);
    // tick.json froze at the last completed tick; the wedge never completes.
    const t = JSON.parse(readFileSync(tickJsonPath(dir), "utf8"));
    assert.equal(t.tickCount, 1, `tickCount=${t.tickCount}, want exactly 1 (only the first tick completed)`);
  });
});

describe("daemon status tick line", () => {
  it("prints the tick summary while the daemon is up", async () => {
    const dir = scratchDir(50);
    const child = spawnDaemon(dir);
    try {
      await waitFor(() => existsSync(tickJsonPath(dir)), 10000, "tick.json to appear");
      await new Promise((r) => setTimeout(r, 300));
      const r = spawnSync(process.execPath, [CLI, "daemon", "status", "--dir", dir], { encoding: "utf8", timeout: 30000 });
      assert.equal(r.status, 0, `status exit ${r.status}: ${r.stderr}`);
      assert.match(r.stdout, /tick: last completed \d+s ago, avg=\d+ms max=\d+ms count=\d+/);
    } finally {
      await stopDaemon(child);
    }
  });

  it("prints 'no tick data yet' when up but no tick has completed", async () => {
    const dir = scratchDir(600000); // first tick far in the future
    const child = spawnDaemon(dir);
    try {
      // daemon.json is written only after the API is bound and listening.
      await waitFor(() => existsSync(join(dir, "daemon.json")), 10000, "daemon.json to appear");
      const r = spawnSync(process.execPath, [CLI, "daemon", "status", "--dir", dir], { encoding: "utf8", timeout: 30000 });
      assert.equal(r.status, 0, `status exit ${r.status}: ${r.stderr}`);
      assert.ok(r.stdout.includes("tick: no tick data yet"), `stdout:\n${r.stdout}`);
      assert.ok(!existsSync(tickJsonPath(dir)), "tick.json must not exist yet");
    } finally {
      await stopDaemon(child);
    }
  });
});
