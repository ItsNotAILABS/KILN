/**
 * daemon-status-probe.test.mjs — the `daemon status` / `daemon watchdog`
 * CLI paths run on the same load-aware probe budget as the Doctor
 * (lib/doctor.mjs probeBudget, shared verbatim).
 *
 * The defect: daemonStatus() probed /health with a fixed 5s budget —
 * the same class the Doctor fix (2026-11-01) eliminated in the Doctor.
 * Under post-reboot load a live daemon answering in 5–11s read as DOWN,
 * and the watchdog then "recovered" a daemon that was never down.
 *
 * Covers:
 *  1. A daemon answering in 6s is UP via `daemon status` (the old fixed
 *     5s budget said DOWN). The budget is driven through probeBudget's
 *     env knobs, standing in for the load stretch (probeBudget's own
 *     load scaling is unit-proven in doctor-probe-budget.test.mjs).
 *  2. A hung API is declared DOWN only after consecutive failed probes
 *     spanning the whole window — the verdict names the sustained
 *     evidence, and watchdog.log carries the probe trail.
 *  3. A dead pid is DOWN instantly — the window is never spent on it.
 *  4. `daemon watchdog` leaves a slow-but-alive daemon alone: exit 0,
 *     no restart, pid untouched.
 *  5. `daemon watchdog` also leaves alone a daemon that misses one
 *     attempt but answers inside the window (busy, then caught up).
 *
 * Never touches the live daemon: scratch state dirs only; the fake
 * "daemon" is a small HTTP server in a daemon-shaped process (cmdline
 * contains daemon.mjs, env carries KILN_SWARM_DIR), exactly like the
 * fixtures in doctor-probe-budget.test.mjs. A sixth test pins the
 * failure classification: a REFUSED port (no listener) is DOWN after
 * the short no-listener grace even with a 30s window configured —
 * the watchdog.test.mjs contract — while silence (test 2) spans the
 * window.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync, readFileSync, writeFileSync, mkdtempSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeStateDir } from "./helpers.mjs";

const CLI = new URL("../swarm.mjs", import.meta.url).pathname;

const cleanupPids = [];
after(() => {
  for (const pid of cleanupPids) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
});

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// /health answers after FAKE_DELAY_MS — or, with FAKE_DELAY_FIRST=1, only
// the FIRST /health request is delayed (a daemon that was busy, then
// caught up: the shape a load spike actually takes).
const FAKE_DAEMON_SRC = `
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
const delayMs = Number(process.env.FAKE_DELAY_MS || 0);
const delayFirst = process.env.FAKE_DELAY_FIRST === "1";
let seen = 0;
const server = createServer((req, res) => {
  res.on("error", () => {});
  if (req.url === "/health") {
    seen += 1;
    const d = delayFirst && seen > 1 ? 0 : delayMs;
    setTimeout(() => {
      if (res.destroyed) return;
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    }, d);
  } else { res.writeHead(404); res.end(); }
});
server.listen(0, "127.0.0.1", () => {
  writeFileSync(process.env.FAKE_PORT_FILE, String(server.address().port));
});
setInterval(() => {}, 60000);
`;

/** Spawn a daemon-shaped process and point the scratch dir's daemon.json at it. */
async function fakeDaemon(dir, { delayMs = 0, delayFirst = false } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "kiln-clistatus-"));
  const script = join(tmp, "slow-daemon.mjs"); // cmdline must contain "daemon.mjs"
  const portFile = join(tmp, "port");
  writeFileSync(script, FAKE_DAEMON_SRC);
  const child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      KILN_SWARM_DIR: dir,
      FAKE_DELAY_MS: String(delayMs),
      FAKE_DELAY_FIRST: delayFirst ? "1" : "0",
      FAKE_PORT_FILE: portFile,
    },
    stdio: "ignore",
  });
  cleanupPids.push(child.pid);
  let port = null;
  // 30s of patience: this box runs hot enough that a node child can take
  // >5s to boot under load — the wait is for the fixture, not the probe.
  for (let i = 0; i < 600 && !port; i++) {
    if (child.exitCode !== null) break;
    try { port = parseInt(readFileSync(portFile, "utf8"), 10) || null; } catch { /* not listening yet */ }
    if (!port) await sleep(50);
  }
  assert.ok(port, `fake daemon reported its port (child exitCode=${child.exitCode})`);
  // A beat so the child's listener is fully accepting before probes start.
  await sleep(200);
  writeFileSync(join(dir, "daemon.json"), JSON.stringify({
    pid: child.pid, startedAt: new Date().toISOString(), apiUrl: `http://127.0.0.1:${port}`,
  }) + "\n");
  return child;
}

function cli(dir, env, ...args) {
  const t0 = Date.now();
  const r = spawnSync("node", [CLI, ...args, "--dir", dir], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 90000,
  });
  return {
    status: r.status,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    elapsedMs: Date.now() - t0,
  };
}

function watchdogLog(dir) {
  const p = join(dir, "watchdog.log");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

describe("daemon status / watchdog on the load-aware probe budget", () => {
  it("status: a daemon answering in 6s is UP (the old fixed 5s budget said DOWN)", async () => {
    const dir = makeStateDir();
    await fakeDaemon(dir, { delayMs: 6000 });
    const r = cli(dir, {
      KILN_DOCTOR_PROBE_ATTEMPT_MS: "9000",
      KILN_DOCTOR_PROBE_WINDOW_MS: "15000",
      KILN_DOCTOR_PROBE_GAP_MS: "100",
    }, "daemon", "status");
    assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /daemon: running pid=/);
    assert.ok(r.elapsedMs >= 6000, `status returned in ${r.elapsedMs}ms — it never waited for the slow answer`);
  });

  it("status: a hung API is DOWN only after sustained probes spanning the window", async () => {
    const dir = makeStateDir();
    await fakeDaemon(dir, { delayMs: 30000 });
    const r = cli(dir, {
      KILN_DOCTOR_PROBE_ATTEMPT_MS: "300",
      KILN_DOCTOR_PROBE_WINDOW_MS: "1500",
      KILN_DOCTOR_PROBE_GAP_MS: "100",
    }, "daemon", "status");
    assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /daemon: DOWN \(/);
    assert.match(r.stdout, /sustained over \d+ consecutive failed probe\(s\) spanning \d+ms/);
    assert.ok(r.elapsedMs >= 1500, `DOWN verdict after ${r.elapsedMs}ms — the window was not honored`);
    assert.match(watchdogLog(dir), /DOWN verdict after \d+ attempt\(s\)/);
  });

  it("status: a dead pid is DOWN instantly — the window is never spent on it", async () => {
    const dir = makeStateDir();
    writeFileSync(join(dir, "daemon.json"), JSON.stringify({
      pid: 999999, startedAt: "2026-09-19T00:00:00.000Z", apiUrl: "http://127.0.0.1:19999",
    }) + "\n");
    const r = cli(dir, {
      KILN_DOCTOR_PROBE_ATTEMPT_MS: "5000",
      KILN_DOCTOR_PROBE_WINDOW_MS: "30000",
      KILN_DOCTOR_PROBE_GAP_MS: "100",
    }, "daemon", "status");
    assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /pid 999999 is not alive/);
    assert.ok(r.elapsedMs < 10000, `dead-pid verdict took ${r.elapsedMs}ms — it waited on the probe window`);
  });

  it("status: a refused port is DOWN after the short no-listener grace — never the full window", async () => {
    // The watchdog.test.mjs contract: pid alive (this test process),
    // port closed. A refusal means no listener — a wedged daemon still
    // accepts — so the verdict must arrive in seconds even when the
    // load-scaled window is stretched to 30s.
    const dir = makeStateDir();
    writeFileSync(join(dir, "daemon.json"), JSON.stringify({
      pid: process.pid, startedAt: new Date().toISOString(), apiUrl: "http://127.0.0.1:19999",
    }) + "\n");
    const r = cli(dir, {
      KILN_DOCTOR_PROBE_ATTEMPT_MS: "5000",
      KILN_DOCTOR_PROBE_WINDOW_MS: "30000",
      KILN_DOCTOR_PROBE_GAP_MS: "100",
    }, "daemon", "status");
    assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /API not responding/);
    assert.match(r.stdout, /no listener after \d+ probe\(s\)/);
    assert.ok(r.elapsedMs < 15000, `refused-port verdict took ${r.elapsedMs}ms — it spent the silence window on a dead socket`);
  });

  it("watchdog: a slow-but-alive daemon is left alone (no restart)", async () => {
    const dir = makeStateDir();
    const child = await fakeDaemon(dir, { delayMs: 6000 });
    const r = cli(dir, {
      KILN_DOCTOR_PROBE_ATTEMPT_MS: "9000",
      KILN_DOCTOR_PROBE_WINDOW_MS: "15000",
      KILN_DOCTOR_PROBE_GAP_MS: "100",
    }, "daemon", "watchdog");
    assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    const dj = JSON.parse(readFileSync(join(dir, "daemon.json"), "utf8"));
    assert.equal(dj.pid, child.pid, "daemon.json pid changed — the watchdog restarted a live daemon");
    assert.doesNotMatch(watchdogLog(dir), /restarting/);
  });

  it("watchdog: a daemon that misses one attempt but answers inside the window is left alone", async () => {
    const dir = makeStateDir();
    const child = await fakeDaemon(dir, { delayMs: 3000, delayFirst: true });
    const r = cli(dir, {
      KILN_DOCTOR_PROBE_ATTEMPT_MS: "1000",
      KILN_DOCTOR_PROBE_WINDOW_MS: "9000",
      KILN_DOCTOR_PROBE_GAP_MS: "200",
    }, "daemon", "watchdog");
    assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    const dj = JSON.parse(readFileSync(join(dir, "daemon.json"), "utf8"));
    assert.equal(dj.pid, child.pid, "daemon.json pid changed — the watchdog restarted a live daemon");
    assert.doesNotMatch(watchdogLog(dir), /restarting/);
    assert.match(watchdogLog(dir), /up after 2 attempt\(s\)/);
  });
});
