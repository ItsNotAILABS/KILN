/**
 * doctor-probe-budget.test.mjs — regression tests for the 2026-11-01
 * false-DOWN incident: the doctor's fixed 5s probe budget timed out
 * against a live daemon answering in 5–11s under post-reboot load
 * (loadavg 27–54), declared it DOWN, and ran watchdog recoveries against
 * the live pid.
 *
 * Covers:
 *  1. probeBudget() stretches with load (loadavg/cores) and respects caps.
 *  2. A slow-but-alive daemon under simulated high load is NOT declared
 *     down (the stretched per-attempt budget absorbs the slow answer).
 *  3. The same slow daemon under a small budget IS declared down — but
 *     only after consecutive failed probes spanning the full window
 *     (sustained non-response), never on a single budget miss.
 *  4. A truly dead daemon is still detected instantly (dead pid never
 *     waits on the window) and doctorTick recovery proceeds end-to-end.
 *  5. doctorTick against a slow-but-alive daemon under load journals NO
 *     death and attempts NO recovery.
 *
 * Never touches the live daemon: scratch state dirs only; the fake
 * "daemon" is a small HTTP server in a daemon-shaped process (cmdline
 * contains daemon.mjs, env carries KILN_SWARM_DIR) so pidIsDaemon accepts
 * it, exactly like the fixtures in doctor.test.mjs.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync, readFileSync, writeFileSync, mkdtempSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeStateDir } from "./helpers.mjs";
import {
  daemonHealth, doctorTick, probeBudget, readJournal, doctorDir, ensureDoctorDir,
} from "../lib/doctor.mjs";

const cleanupPids = [];
after(() => {
  for (const pid of cleanupPids) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
});

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Scratch dir whose real daemon (if a recovery starts one) binds port 0. */
function scratchDir() {
  const dir = makeStateDir();
  const cfgPath = join(dir, "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  cfg.apiPort = 0;
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  return dir;
}

const FAKE_DAEMON_SRC = `
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
const delayMs = Number(process.env.FAKE_DELAY_MS || 0);
const server = createServer((req, res) => {
  if (req.url === "/health") {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    }, delayMs);
  } else { res.writeHead(404); res.end(); }
});
server.listen(0, "127.0.0.1", () => {
  writeFileSync(process.env.FAKE_PORT_FILE, String(server.address().port));
});
setInterval(() => {}, 60000);
`;

/**
 * Spawn a daemon-shaped process serving /health after `delayMs`, and point
 * the scratch dir's daemon.json at it. Returns the child process.
 */
async function fakeSlowDaemon(dir, delayMs) {
  const tmp = mkdtempSync(join(tmpdir(), "kiln-slowdaemon-"));
  const script = join(tmp, "slow-daemon.mjs"); // cmdline must contain "daemon.mjs"
  const portFile = join(tmp, "port");
  writeFileSync(script, FAKE_DAEMON_SRC);
  const child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      KILN_SWARM_DIR: dir,
      FAKE_DELAY_MS: String(delayMs),
      FAKE_PORT_FILE: portFile,
    },
    stdio: "ignore",
  });
  cleanupPids.push(child.pid);
  let port = null;
  for (let i = 0; i < 100 && !port; i++) {
    try { port = parseInt(readFileSync(portFile, "utf8"), 10) || null; } catch { /* not listening yet */ }
    if (!port) await sleep(50);
  }
  assert.ok(port, "fake daemon reported its port");
  // Give /proc/<pid>/environ a beat to be the spawned env (pidIsDaemon reads it).
  await sleep(200);
  writeFileSync(join(dir, "daemon.json"), JSON.stringify({
    pid: child.pid, startedAt: new Date().toISOString(), apiUrl: `http://127.0.0.1:${port}`,
  }) + "\n");
  return child;
}

describe("probeBudget (load-aware scaling)", () => {
  it("probe budget stretches with load and respects caps", () => {
    const idle = probeBudget({ load: { load1: 1.5, cores: 4, perCore: 0.375, factor: 1 } });
    assert.equal(idle.attemptTimeoutMs, 5000, "no stretch at factor 1");
    assert.equal(idle.windowMs, 15000);
    assert.equal(idle.minAttempts, 3);

    const loaded = probeBudget({ load: { load1: 8, cores: 2, perCore: 4, factor: 4 } });
    assert.equal(loaded.attemptTimeoutMs, 20000, "attempt timeout scales 4x");
    assert.equal(loaded.windowMs, 60000, "window scales to its cap");
    assert.ok(loaded.minAttempts >= 2);

    // The 2026-11-01 incident shape: loadavg 54 on a 2-core box.
    const saturated = probeBudget({ load: { load1: 54, cores: 2, perCore: 27, factor: 27 } });
    assert.equal(saturated.attemptTimeoutMs, 45000, "attempt timeout capped, not unbounded");
    assert.equal(saturated.windowMs, 60000, "window capped, not unbounded");
    assert.ok(saturated.minAttempts >= 2, "a DOWN verdict always needs consecutive failures");

    const mid = probeBudget({ load: { load1: 16, cores: 2, perCore: 8, factor: 8 } });
    assert.ok(mid.attemptTimeoutMs > loaded.attemptTimeoutMs, "monotonic in load");
  });
});

describe("daemonHealth under load", () => {
  it("a slow-but-alive daemon under simulated high load is NOT declared down", { timeout: 60000 }, async () => {
    const dir = scratchDir();
    ensureDoctorDir(dir);
    // Answers /health in 8s — beyond the OLD fixed 5s budget, which is
    // exactly what produced the false DOWN verdicts on 2026-11-01.
    await fakeSlowDaemon(dir, 8000);
    const st = await daemonHealth(dir, {
      load: { load1: 54, cores: 2, perCore: 27, factor: 27 }, // the incident's load shape
    });
    assert.equal(st.up, true, `expected UP under stretched budget, got: ${JSON.stringify(st)}`);
    assert.equal(st.probe.attempts, 1, "one slow-but-successful probe, no retries needed");
    assert.equal(st.probe.attemptTimeoutMs, 45000, "budget stretched to the cap under load");
    assert.ok(st.probe.elapsedMs >= 7000, `probe really waited for the slow answer (${st.probe.elapsedMs}ms)`);
    // (c) the probe logged latency + load at probe time into doctor.log.
    const log = readFileSync(join(doctorDir(dir), "doctor.log"), "utf8");
    assert.match(log, /probe pid=\d+ attempt=1 result=up latencyMs=\d+ load1=54\.00 cores=2/);
  });

  it("a daemon slower than the budget is declared down only after sustained failure across the window", { timeout: 60000 }, async () => {
    const dir = scratchDir();
    ensureDoctorDir(dir);
    await fakeSlowDaemon(dir, 8000); // slower than every attempt below
    const st = await daemonHealth(dir, {
      probe: { attemptTimeoutMs: 1500, windowMs: 4500, retryGapMs: 200, minAttempts: 3 },
    });
    assert.equal(st.up, false, `expected DOWN after the window, got: ${JSON.stringify(st)}`);
    assert.match(st.reason, /API not responding/);
    assert.match(st.reason, /sustained over \d+ consecutive failed probe/);
    assert.ok(st.probe.attempts >= 3, `needed consecutive failures, got ${st.probe.attempts}`);
    assert.ok(st.probe.elapsedMs >= 4500,
      `verdict waited out the full window (${st.probe.elapsedMs}ms), not a single miss`);
    const log = readFileSync(join(doctorDir(dir), "doctor.log"), "utf8");
    assert.match(log, /DOWN verdict after \d+ attempt\(s\) spanning \d+ms/);
  });
});

describe("real death still detected + recovered", () => {
  it("a truly dead daemon is detected instantly and doctorTick recovery proceeds", { timeout: 120000 }, async () => {
    const dir = scratchDir();
    writeFileSync(join(dir, "daemon.json"), JSON.stringify({
      pid: 99999999, startedAt: "2026-09-19T00:00:00.000Z", apiPort: 9, apiUrl: "http://127.0.0.1:9",
    }) + "\n");

    const t0 = Date.now();
    const st = await daemonHealth(dir);
    const elapsed = Date.now() - t0;
    assert.equal(st.up, false);
    assert.match(st.reason, /is not alive/);
    assert.ok(elapsed < 3000, `dead pid detected without burning the probe window (${elapsed}ms)`);

    const res = await doctorTick(dir);
    assert.equal(res.healthy, true, `expected recovery, got: ${JSON.stringify(res)}`);
    assert.equal(res.recovered, true);
    if (res.pid) cleanupPids.push(res.pid);
    const events = readJournal(dir);
    assert.equal(events.filter((e) => e.type === "death").length, 1, "death journaled (format preserved)");
    const recs = events.filter((e) => e.type === "recovery");
    assert.equal(recs.length, 1);
    assert.equal(recs[0].ok, true);
    assert.equal(recs[0].method, "daemon-watchdog");
  });
});

describe("doctorTick vs slow-but-alive daemon", () => {
  it("journals no death and attempts no recovery for a slow-but-alive daemon under load", { timeout: 90000 }, async () => {
    const dir = scratchDir();
    ensureDoctorDir(dir);
    await fakeSlowDaemon(dir, 8000); // would false-DOWN under the old 5s budget
    // Operator/test knob: the same stretch probeBudget applies under load.
    process.env.KILN_DOCTOR_PROBE_ATTEMPT_MS = "20000";
    process.env.KILN_DOCTOR_PROBE_WINDOW_MS = "30000";
    try {
      const res = await doctorTick(dir);
      assert.equal(res.healthy, true, `expected a quiet healthy tick, got: ${JSON.stringify(res)}`);
    } finally {
      delete process.env.KILN_DOCTOR_PROBE_ATTEMPT_MS;
      delete process.env.KILN_DOCTOR_PROBE_WINDOW_MS;
    }
    const events = readJournal(dir);
    assert.equal(events.filter((e) => e.type === "death").length, 0, "no false death journaled");
    assert.equal(events.filter((e) => e.type === "recovery").length, 0, "no pointless recovery attempted");
    assert.ok(existsSync(join(doctorDir(dir), "doctor.log")), "doctor.log written");
    const log = readFileSync(join(doctorDir(dir), "doctor.log"), "utf8");
    assert.match(log, /tick: durationMs=\d+ healthy=true/, "tick duration logged");
    assert.match(log, /probe pid=\d+ attempt=1 result=up/, "probe latency logged");
  });
});
