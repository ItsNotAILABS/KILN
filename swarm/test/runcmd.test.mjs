/**
 * Direct tests for runCmd() (swarm/lib/tools.mjs) — the shared process
 * runner behind shell.exec and project.release.
 *
 * Regression: a prior refactor set `done = true` in the close handler
 * before calling finish(), while finish() only resolved when `!done` —
 * so every normal command completion left the Promise pending forever.
 * finish() now owns the once-guard; these tests pin the settlement
 * contract: normal exit, nonzero exit, timeout, and SIGTERM-ignoring
 * processes (SIGTERM-then-SIGKILL teeth).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runCmd } from "../lib/tools.mjs";

const NODE = process.execPath;

describe("runCmd settlement", () => {
  it("normal exit resolves (regression: must not hang)", async () => {
    const r = await runCmd(NODE, ["-e", "console.log('kiln-runcmd-ok')"], {
      cwd: "/tmp",
      timeoutMs: 15000,
    });
    assert.equal(r.ok, true);
    assert.equal(r.code, 0);
    assert.ok(r.out.includes("kiln-runcmd-ok"), `stdout was: ${r.out}`);
    assert.equal(r.error, null);
  });

  it("nonzero exit resolves with ok:false and the real exit code", async () => {
    const r = await runCmd(NODE, ["-e", "console.error('badness'); process.exit(3);"], {
      cwd: "/tmp",
      timeoutMs: 15000,
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 3);
    assert.ok(r.error.includes("exit 3"), `error was: ${r.error}`);
    assert.ok(r.error.includes("badness"), "stderr is captured in the error");
  });

  it("a spinner past the deadline resolves timedOut (SIGTERM teeth)", async () => {
    const t0 = Date.now();
    const r = await runCmd(NODE, ["-e", "setInterval(() => {}, 100);"], {
      cwd: "/tmp",
      timeoutMs: 1000,
    });
    const ms = Date.now() - t0;
    assert.equal(r.ok, false);
    assert.equal(r.timedOut, true);
    assert.ok(r.error.includes("timeout after 1000ms"), `error was: ${r.error}`);
    assert.ok(ms < 10000, `settled in ${ms}ms (must not wait forever)`);
  });

  it("a SIGTERM-ignoring process is SIGKILLed after the grace period", async () => {
    const t0 = Date.now();
    const r = await runCmd(
      NODE,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 100);"],
      { cwd: "/tmp", timeoutMs: 1000 }
    );
    const ms = Date.now() - t0;
    assert.equal(r.ok, false);
    assert.equal(r.timedOut, true);
    assert.ok(
      r.error.includes("ignored SIGTERM, SIGKILLed"),
      `error was: ${r.error}`
    );
    // SIGTERM at 1000ms, SIGKILL at 6000ms — must settle shortly after,
    // and must never hang past a generous bound.
    assert.ok(ms >= 5000, `settled suspiciously fast (${ms}ms) — was SIGKILL actually needed?`);
    assert.ok(ms < 15000, `settled in ${ms}ms (must not wait forever)`);
  });

  it("spawn failure resolves instead of hanging", async () => {
    const r = await runCmd("definitely-not-a-real-binary-xyz", [], {
      cwd: "/tmp",
      timeoutMs: 5000,
    });
    assert.equal(r.ok, false);
    assert.ok(r.error.length > 0, "an error message is returned");
  });
});
