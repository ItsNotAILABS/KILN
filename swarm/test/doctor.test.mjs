/**
 * Doctor tests: diagnose() against synthetic journals, death-bundle capture
 * against a fake state dir, stale-lock probing, and an end-to-end doctorTick
 * recovery against a scratch dir with an ephemeral-port daemon.
 *
 * Never touches the live daemon: every test uses a scratch state dir, and
 * any daemon the tests start binds apiPort 0 (ephemeral) and is SIGTERMed
 * in cleanup.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { makeStateDir } from "./helpers.mjs";
import { ensureStateDir } from "../lib/state.mjs";
import {
  journalEvent, readJournal, diagnose, captureDeathBundle, lockState,
  daemonHealth, doctorTick, doctorStart, doctorStop, doctorAlive, doctorDir,
} from "../lib/doctor.mjs";

const CLI = new URL("../swarm.mjs", import.meta.url).pathname;
const cleanupPids = [];

function cli(dir, ...args) {
  const r = spawnSync("node", [CLI, ...args, "--dir", dir], { encoding: "utf8", timeout: 60000 });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

/** Scratch dir whose daemon (if ever started) binds an ephemeral API port. */
function scratchDir() {
  const dir = makeStateDir();
  const cfgPath = join(dir, "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  cfg.apiPort = 0;
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  return dir;
}

function deadDaemonJson(dir, pid = 99999999) {
  writeFileSync(
    join(dir, "daemon.json"),
    JSON.stringify({ pid, startedAt: "2026-09-19T00:00:00.000Z", apiPort: 9, apiUrl: "http://127.0.0.1:9" }) + "\n"
  );
}

/** Synthetic death events written straight to the journal. */
function seedDeaths(dir, deaths) {
  for (const d of deaths) {
    journalEvent(dir, {
      ts: d.ts, type: "death", pid: 1000 + Math.floor(Math.random() * 9000),
      startedAt: "2026-09-19T00:00:00.000Z",
      reason: "pid 1234 is not alive",
      uptimeSec: 18000,
      memAvailableMb: d.memAvailableMb ?? 4000,
      preDeathStaleWorkers: d.stale || [],
      oomEvidence: d.oom || false,
    });
  }
}

const H = 3600_000;
function iso(base, plusMs) { return new Date(base + plusMs).toISOString(); }

after(() => {
  for (const pid of cleanupPids) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
});

describe("diagnose()", () => {
  it("detects a regular death interval", () => {
    const dir = scratchDir();
    const base = Date.parse("2026-09-20T00:00:00.000Z");
    // 4 deaths, 6h apart, +/-2min jitter
    seedDeaths(dir, [0, 1, 2, 3].map((i) => ({
      ts: iso(base, i * 6 * H + (i % 2 ? 120_000 : -120_000)),
    })));
    const dg = diagnose(dir);
    assert.equal(dg.verdict, "hypothesis");
    assert.equal(dg.deaths, 4);
    assert.ok(Math.abs(dg.medianIntervalMs - 6 * H) < 5 * 60_000,
      `median interval ~6h, got ${dg.medianIntervalMs}`);
    assert.match(dg.hypothesis, /6h/);
  });

  it("detects time-of-day clustering", () => {
    const dir = scratchDir();
    const base = Date.parse("2026-09-20T00:00:00.000Z");
    // 5 deaths, all between 02:00 and 02:50 UTC, on different days
    seedDeaths(dir, [0, 1, 2, 3, 4].map((i) => ({
      ts: iso(base, i * 24 * H + 2 * H + i * 10 * 60_000),
    })));
    const dg = diagnose(dir);
    assert.equal(dg.verdict, "hypothesis");
    assert.equal(dg.todHistogram[2], 5);
    assert.match(dg.hypothesis, /clustering/i);
  });

  it("correlates recurring stale-heartbeat workers with deaths", () => {
    const dir = scratchDir();
    const base = Date.parse("2026-09-20T00:00:00.000Z");
    seedDeaths(dir, [0, 1, 2, 3].map((i) => ({
      ts: iso(base, i * 7 * H),
      stale: ["nightly-kiln-workspace-2026-09-19"],
    })));
    const dg = diagnose(dir);
    assert.equal(dg.verdict, "hypothesis");
    assert.ok(dg.staleHeartbeatFraction >= 0.99);
    assert.match(dg.hypothesis, /nightly-kiln-workspace-2026-09-19/);
    assert.match(dg.hypothesis, /tick loop wedges|stale worker heartbeats/i);
  });

  it("flags OOM evidence when dmesg showed the killer", () => {
    const dir = scratchDir();
    const base = Date.parse("2026-09-20T00:00:00.000Z");
    seedDeaths(dir, [0, 1, 2].map((i) => ({ ts: iso(base, i * 5 * H), oom: true })));
    const dg = diagnose(dir);
    assert.equal(dg.verdict, "hypothesis");
    assert.match(dg.hypothesis, /OOM/i);
  });

  it("returns insufficient-data below 3 deaths and never invents a cause", () => {
    const dir = scratchDir();
    const base = Date.parse("2026-09-20T00:00:00.000Z");
    seedDeaths(dir, [0, 1].map((i) => ({ ts: iso(base, i * 6 * H) })));
    const dg = diagnose(dir);
    assert.equal(dg.verdict, "insufficient-data");
    assert.equal(dg.deaths, 2);
    assert.match(dg.hypothesis, /insufficient data/i);
    assert.doesNotMatch(dg.hypothesis, /leading hypothesis/i);
  });

  it("empty journal is insufficient data", () => {
    const dir = scratchDir();
    const dg = diagnose(dir);
    assert.equal(dg.verdict, "insufficient-data");
    assert.equal(dg.deaths, 0);
  });
});

describe("forensics", () => {
  it("captureDeathBundle records the expected evidence shape", () => {
    const dir = scratchDir();
    deadDaemonJson(dir);
    writeFileSync(join(dir, "daemon.log"), Array.from({ length: 50 }, (_, i) => `[daemon] line ${i}`).join("\n") + "\n");
    // a node with a stale heartbeat
    const ndir = join(dir, "nodes", "abc123");
    mkdirSync(ndir, { recursive: true });
    writeFileSync(join(ndir, "node.json"), JSON.stringify({ id: "abc123", name: "nightly-x", workerPid: 99999998 }) + "\n");
    writeFileSync(join(ndir, "heartbeat"), String(Date.now() - 600_000)); // 10 min stale
    const death = {
      ts: "2026-10-01T12:00:00.000Z", pid: 99999999,
      startedAt: "2026-09-19T00:00:00.000Z", reason: "pid 99999999 is not alive", uptimeSec: 60,
    };
    const { path, bundle } = captureDeathBundle(dir, death);
    assert.ok(existsSync(path), "bundle file written");
    assert.equal(bundle.death.reason, "pid 99999999 is not alive");
    assert.equal(bundle.daemonLogTail.length, 50);
    assert.ok(bundle.daemonLogTail[0].includes("line 0"));
    assert.equal(bundle.nodes.length, 1);
    assert.equal(bundle.nodes[0].name, "nightly-x");
    assert.equal(bundle.nodes[0].workerAlive, false);
    assert.deepEqual(bundle.preDeathStaleWorkers, [], "dead pid => not stale-alive");
    assert.ok("memAvailableMb" in bundle);
    assert.ok(bundle.lock && typeof bundle.lock.held === "boolean");
    assert.ok(Array.isArray(bundle.ps));
    assert.ok(bundle.dmesgOom && typeof bundle.dmesgOom.available === "boolean");
  });

  it("lockState reports a stale lock when the recorded pid is dead", () => {
    const dir = scratchDir();
    deadDaemonJson(dir, 99999998);
    writeFileSync(join(dir, "daemon.lock"), "");
    const lk = lockState(dir);
    assert.equal(lk.held, true);
    assert.equal(lk.stale, true);
    assert.equal(lk.liveDaemon, false);
  });

  it("lockState reports free when no lock file exists", () => {
    const dir = scratchDir();
    deadDaemonJson(dir);
    const lk = lockState(dir);
    assert.equal(lk.held, false);
  });

  it("lockState recognizes a live daemon via pidIsDaemon (pid-reuse safe)", async () => {
    const dir = scratchDir();
    // A real process whose cmdline contains "daemon.mjs" and whose env
    // carries this state dir — indistinguishable from the real daemon to
    // pidIsDaemon, which is exactly what the probe must detect.
    const probePath = join(mkdtempSync(join(tmpdir(), "kiln-docprobe-")), "probe-daemon.mjs");
    writeFileSync(probePath, "setInterval(() => {}, 60000);\n");
    const child = spawn(process.execPath, [probePath], {
      env: { ...process.env, KILN_SWARM_DIR: dir },
      stdio: "ignore",
    });
    cleanupPids.push(child.pid);
    await new Promise((r) => setTimeout(r, 500));
    try {
      writeFileSync(join(dir, "daemon.json"), JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString(), apiUrl: "http://127.0.0.1:9" }) + "\n");
      writeFileSync(join(dir, "daemon.lock"), "");
      const lk = lockState(dir);
      assert.equal(lk.held, true);
      assert.equal(lk.liveDaemon, true);
      assert.equal(lk.stale, false);
      const st = await daemonHealth(dir);
      // pid is the "daemon" but no API answers on a fake dir — the health
      // check must report the API failure, not claim health.
      assert.equal(st.up, false);
      assert.match(st.reason, /API not responding/);
    } finally {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }
  });

  it("daemonHealth reports a dead pid honestly", async () => {
    const dir = scratchDir();
    deadDaemonJson(dir);
    const st = await daemonHealth(dir);
    assert.equal(st.up, false);
    assert.match(st.reason, /is not alive/);
  });
});

describe("doctorTick end-to-end", () => {
  it("captures a bundle, journals death+recovery, and restarts via the watchdog path", { timeout: 120000 }, async () => {
    const dir = scratchDir();
    deadDaemonJson(dir);
    writeFileSync(join(dir, "daemon.log"), "[daemon] old log line\n");
    const res = await doctorTick(dir);
    assert.equal(res.healthy, true, `expected recovery, got: ${JSON.stringify(res)}`);
    assert.equal(res.recovered, true);
    assert.ok(res.death, "death recorded");
    assert.ok(existsSync(res.death.bundle), "bundle file exists");
    const events = readJournal(dir);
    const deaths = events.filter((e) => e.type === "death");
    const recs = events.filter((e) => e.type === "recovery");
    assert.equal(deaths.length, 1);
    assert.equal(recs.length, 1);
    assert.equal(recs[0].ok, true);
    assert.equal(recs[0].method, "daemon-watchdog");
    assert.ok(res.pid, "recovered daemon pid reported");
    cleanupPids.push(res.pid);
    // second tick on the now-healthy daemon is a quiet no-op
    const res2 = await doctorTick(dir);
    assert.equal(res2.healthy, true);
    assert.equal(readJournal(dir).filter((e) => e.type === "death").length, 1, "no duplicate death");
  }, { timeout: 120000 });

  it("does not re-capture a death it already handled", async () => {
    const dir = scratchDir();
    deadDaemonJson(dir);
    // Simulate a previous failed recovery for this exact dead instance.
    const { path: bpath } = captureDeathBundle(dir, {
      ts: new Date().toISOString(), pid: 99999999,
      startedAt: "2026-09-19T00:00:00.000Z", reason: "pid 99999999 is not alive", uptimeSec: 1,
    });
    journalEvent(dir, {
      ts: new Date().toISOString(), type: "death", pid: 99999999,
      startedAt: "2026-09-19T00:00:00.000Z", reason: "pid 99999999 is not alive",
      uptimeSec: 1, memAvailableMb: null, preDeathStaleWorkers: [], oomEvidence: false, bundle: bpath,
    });
    journalEvent(dir, {
      ts: new Date().toISOString(), type: "recovery", ok: false, pid: null,
      method: "daemon-watchdog", watchdogExit: 1, watchdogCrashLoop: true, watchdogTail: "crash loop suspected",
    });
    // Mark this death as handled (as a real tick would have).
    const statePath = join(doctorDir(dir), "state.json");
    mkdirSync(doctorDir(dir), { recursive: true });
    writeFileSync(statePath, JSON.stringify({ lastHandledDeathId: "99999999|2026-09-19T00:00:00.000Z" }) + "\n");
    const bundlesBefore = readdirSync(join(doctorDir(dir), "deaths")).length;
    const res = await doctorTick(dir);
    assert.equal(res.healthy, false);
    assert.equal(res.alreadyHandled, true);
    assert.equal(readdirSync(join(doctorDir(dir), "deaths")).length, bundlesBefore, "no second bundle");
    assert.equal(readJournal(dir).filter((e) => e.type === "death").length, 1, "no second death event");
  });
});

describe("doctor CLI", () => {
  it("status reports not-running and exits 1 when the doctor is down", () => {
    const dir = scratchDir();
    const r = cli(dir, "doctor", "status");
    assert.equal(r.status, 1);
    assert.match(r.stdout, /doctor: not running/);
  });

  it("report on an empty journal says insufficient data", () => {
    const dir = scratchDir();
    const r = cli(dir, "doctor", "report");
    assert.equal(r.status, 0);
    assert.match(r.stdout, /insufficient-data/);
  });

  it("start then stop round-trips the doctor loop", { timeout: 30000 }, async () => {
    const dir = scratchDir();
    const r1 = cli(dir, "doctor", "start");
    assert.equal(r1.status, 0);
    assert.match(r1.stdout, /doctor starting pid=/);
    const pid = parseInt(r1.stdout.match(/pid=(\d+)/)[1], 10);
    cleanupPids.push(pid);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(doctorAlive(dir), true, "doctor loop is alive");
    const r2 = cli(dir, "doctor", "status");
    assert.equal(r2.status, 0);
    assert.match(r2.stdout, /doctor: running/);
    const r3 = cli(dir, "doctor", "stop");
    assert.equal(r3.status, 0);
    assert.match(r3.stdout, /stop signaled/);
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(doctorAlive(dir), false, "doctor loop stopped");
  }, { timeout: 30000 });
});
