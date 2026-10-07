/**
 * doctor-recovery-hardening.test.mjs — regression tests for the 2026-10-07
 * recovery outage (daemon died at 05:30:17Z, the doctor's recovery failed,
 * and the doctor then skipped the dead instance forever).
 *
 * Covers:
 *  1. procCmdline / pidIsDaemon TOCTOU: a pid that vanishes between
 *     pidAlive() and the /proc read must NOT be reported as the daemon.
 *  2. processStartId: boot-relative identity for pid-recycling fences.
 *  3. supervisor.tick(): a FAILED recovery is retried with backoff
 *     (bounded), not permanently skipped; exhaustion raises a loud alarm.
 *  4. Recovery-authority fence (doctor.mjs): a daemon started outside the
 *     doctor is fenced (reported down) instead of adopted.
 *
 * Never touches the live daemon: scratch state dirs only; any daemon the
 * tests start binds apiPort 0 (ephemeral) and is SIGTERMed in cleanup.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeStateDir } from "./helpers.mjs";
import { pidIsDaemon, procCmdline, processStartId } from "../lib/state.mjs";
import { daemonHealth, doctorTick } from "../lib/doctor.mjs";
import { Supervisor } from "../lib/doctor-core/supervisor.mjs";
import { readDoctorState, writeDoctorState } from "../lib/doctor-core/helpers.mjs";

const cleanupPids = [];
after(() => {
  for (const pid of cleanupPids) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
});

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Spawn a short-lived child and wait until it is fully reaped. */
async function reapedPid() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
  const pid = child.pid;
  child.kill("SIGKILL");
  await new Promise((r) => child.on("exit", r));
  for (let i = 0; i < 100 && existsSync(`/proc/${pid}`); i++) await sleep(20);
  return pid;
}

describe("pid identity hardening (state.mjs)", () => {
  it("procCmdline reports 'vanished' for a reaped pid (the TOCTOU window)", async () => {
    const pid = await reapedPid();
    assert.ok(!existsSync(`/proc/${pid}`), "precondition: /proc entry gone");
    const r = procCmdline(pid);
    assert.equal(r.status, "vanished");
  });

  it("pidIsDaemon returns false for a vanished pid even if pidAlive raced true", async () => {
    const dir = makeStateDir();
    const pid = await reapedPid();
    // Either the early pidAlive check or the vanished-cmdline branch must
    // reject it — the old code returned TRUE from the catch-all.
    assert.equal(pidIsDaemon(pid, dir), false);
  });

  it("pidIsDaemon rejects a live non-daemon pid (impostor)", () => {
    const dir = makeStateDir();
    assert.equal(pidIsDaemon(process.pid, dir), false);
  });

  it("pidIsDaemon accepts a genuine daemon-shaped process", async () => {
    const dir = makeStateDir();
    const probePath = join(mkdtempSync(join(tmpdir(), "kiln-hardprobe-")), "probe-daemon.mjs");
    writeFileSync(probePath, "setInterval(() => {}, 60000);\n");
    const child = spawn(process.execPath, [probePath], {
      env: { ...process.env, KILN_SWARM_DIR: dir },
      stdio: "ignore",
    });
    cleanupPids.push(child.pid);
    await sleep(500);
    try {
      assert.equal(pidIsDaemon(child.pid, dir), true);
    } finally {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }
  });

  it("processStartId returns pid:ticks for a live process, null when gone", async () => {
    const id = processStartId(process.pid);
    assert.match(id, /^\d+:\d+$/, `expected pid:ticks, got ${id}`);
    const dead = await reapedPid();
    assert.equal(processStartId(dead), null);
    assert.equal(processStartId(null), null);
    assert.equal(processStartId(0), null);
  });
});

describe("supervisor.tick() failed-recovery retry", () => {
  const START = "2026-10-07T00:00:00.000Z";

  function fakePlugin(dir, hooks) {
    return {
      name: "test-daemon",
      subject: "daemon",
      dir,
      verifyWaitMs: 0,
      recoveryRetry: { maxAttempts: 3, delaysMs: [0, 0, 0] },
      healthCheck: () => hooks.health(),
      recover: () => hooks.recover(),
      collectors: {},
    };
  }

  function downHealth() {
    return { up: false, pid: 111, startedAt: START, reason: "down" };
  }

  it("retries a failed recovery with backoff instead of skipping forever", async () => {
    const dir = makeStateDir();
    let recoverCalls = 0;
    let captureCalls = 0;
    let up = false;
    const plugin = fakePlugin(dir, {
      health: async () => (up
        ? { up: true, pid: 111, startedAt: START }
        : downHealth()),
      recover: async () => {
        recoverCalls++;
        if (recoverCalls >= 2) up = true; // second attempt fixes it
        return { ok: true, pid: 111, method: "test" };
      },
    });
    const sup = new Supervisor({ plugin, dir });
    const origCapture = sup.agents.coroner.capture.bind(sup.agents.coroner);
    sup.agents.coroner.capture = async (st) => { captureCalls++; return origCapture(st); };

    const r1 = await sup.tick();
    assert.equal(r1.healthy, false);
    assert.equal(r1.recovered, false);
    assert.equal(recoverCalls, 1);
    let st = readDoctorState(dir);
    assert.equal(st.recoveryAttempts, 1);

    // Same dead instance, same outage — the old code returned
    // { alreadyHandled: true } here forever. Now it must retry.
    const r2 = await sup.tick();
    assert.equal(r2.retried, true);
    assert.equal(r2.recovered, true, `expected retry recovery, got: ${JSON.stringify(r2)}`);
    assert.equal(recoverCalls, 2);
    assert.equal(captureCalls, 1, "forensics captured once, not re-captured per retry");
    st = readDoctorState(dir);
    assert.equal(st.recoveryAttempts, 2);

    // Healthy again: the retry state resets.
    const r3 = await sup.tick();
    assert.equal(r3.healthy, true);
    st = readDoctorState(dir);
    assert.equal(st.recoveryExhausted, false);
  });

  it("raises a loud alarm when the retry budget is exhausted", async () => {
    const dir = makeStateDir();
    const plugin = fakePlugin(dir, {
      health: async () => downHealth(),
      recover: async () => ({ ok: false, method: "test", reason: "boom" }),
    });
    const sup = new Supervisor({ plugin, dir });

    await sup.tick(); // attempt 1
    await sup.tick(); // attempt 2 (retry)
    await sup.tick(); // attempt 3 (retry)
    const r = await sup.tick(); // budget spent → alarm
    assert.equal(r.recoveryExhausted, true);
    assert.equal(r.alreadyHandled, true);
    const st = readDoctorState(dir);
    assert.equal(st.recoveryExhausted, true);
    assert.equal(st.recoveryAttempts, 3);
    const log = readFileSync(join(dir, "doctor", "doctor.log"), "utf8");
    assert.match(log, /ALARM.*recovery exhausted/);

    // check() surfaces the alarm loudly (exit 1) instead of going silent.
    // Fake a live doctor loop so check() doesn't try to start one.
    const docJs = join(mkdtempSync(join(tmpdir(), "kiln-fakedoc-")), "doctor.js");
    writeFileSync(docJs, "setInterval(() => {}, 60000);\n");
    const docChild = spawn(process.execPath, [docJs, "_run"], {
      env: { ...process.env, DOCTOR_DIR: dir },
      stdio: "ignore",
    });
    cleanupPids.push(docChild.pid);
    await sleep(300);
    writeFileSync(
      join(dir, "doctor", "doctor.json"),
      JSON.stringify({ pid: docChild.pid, startedAt: new Date().toISOString() }) + "\n"
    );
    const chk = await sup.check();
    assert.equal(chk.exitCode, 1);
    assert.ok(chk.lines.some((l) => l.includes("ALARM")), `expected ALARM line, got: ${chk.lines.join(" | ")}`);
  });

  it("a new death after a handled one resets the retry budget", async () => {
    const dir = makeStateDir();
    let up = false;
    const plugin = fakePlugin(dir, {
      health: async () => (up
        ? { up: true, pid: 111, startedAt: START }
        : downHealth()),
      recover: async () => ({ ok: false, method: "test" }),
    });
    const sup = new Supervisor({ plugin, dir });
    await sup.tick(); // attempt 1 (fails)
    let st = readDoctorState(dir);
    assert.equal(st.recoveryAttempts, 1);
    // The daemon comes back on its own with a NEW startedAt → new deathId.
    up = true;
    const r = await sup.tick();
    assert.equal(r.healthy, true);
    st = readDoctorState(dir);
    assert.equal(st.recoveryAttempts, 0);
  });
});

describe("recovery authority fence (doctor.mjs)", () => {
  it("fences a daemon started outside the recovery authority", { timeout: 120000 }, async () => {
    const dir = makeStateDir();
    const cfgPath = join(dir, "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    cfg.apiPort = 0;
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
    writeFileSync(
      join(dir, "daemon.json"),
      JSON.stringify({ pid: 99999999, startedAt: "2026-09-19T00:00:00.000Z", apiPort: 9, apiUrl: "http://127.0.0.1:9" }) + "\n"
    );
    const res = await doctorTick(dir);
    assert.equal(res.healthy, true, `expected watchdog recovery, got: ${JSON.stringify(res)}`);
    const dj = JSON.parse(readFileSync(join(dir, "daemon.json"), "utf8"));
    assert.ok(dj.bootId, "daemon.json carries bootId");
    assert.ok(dj.startId, "daemon.json carries startId");
    cleanupPids.push(dj.pid);
    await sleep(500);

    // The recovery stamped the fence.
    const st = readDoctorState(dir);
    assert.equal(st.expectedBootId, dj.bootId, "recovery stamped the fence");

    // Simulate an out-of-band start (different boot): fenced, not adopted.
    writeDoctorState(dir, { ...st, expectedBootId: "bogus-out-of-band-boot" });
    const bad = await daemonHealth(dir);
    assert.equal(bad.up, false);
    assert.match(bad.reason, /fenced/);

    // Restore the fenced identity → healthy again.
    writeDoctorState(dir, { ...st, expectedBootId: dj.bootId });
    const good = await daemonHealth(dir);
    assert.equal(good.up, true, `expected healthy, got: ${JSON.stringify(good)}`);

    try { process.kill(dj.pid, "SIGTERM"); } catch { /* already gone */ }
  });
});
