/**
 * Ticket E2: the daemon can die silently (twice in ~40 min with no log line).
 * `daemon status` must report true health (pid alive AND API answering) and
 * exit non-zero when down; `daemon watchdog` must restart a dead daemon and
 * refuse to spin on a crash loop.
 *
 * Runs the real CLI as a subprocess against scratch state dirs. The restart
 * test uses apiPort 0 (ephemeral) so it never touches the live daemon's port.
 * Never touches the live daemon.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeStateDir } from "./helpers.mjs";

const CLI = new URL("../swarm.mjs", import.meta.url).pathname;

function cli(dir, ...args) {
  const r = spawnSync("node", [CLI, ...args, "--dir", dir], { encoding: "utf8", timeout: 30000 });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

/**
 * Async variant: the event loop keeps running while the child works, so a
 * fake /health server hosted in THIS process can answer the child's fetch.
 * (spawnSync would block the loop and the fetch would time out.)
 */
function cliAsync(dir, ...args) {
  return new Promise((resolve, reject) => {
    const p = spawn("node", [CLI, ...args, "--dir", dir], { encoding: "utf8" });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => { stdout += d; });
    p.stderr.on("data", (d) => { stderr += d; });
    p.on("error", reject);
    const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("cliAsync timed out")); }, 25000);
    p.on("close", (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

function deadDaemonJson(dir) {
  writeFileSync(
    join(dir, "daemon.json"),
    JSON.stringify({ pid: 999999, startedAt: "2026-09-19T00:00:00.000Z", apiPort: 19999, apiUrl: "http://127.0.0.1:19999" }) + "\n"
  );
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Pids of daemons this file started, so after() can clean them up. */
const spawnedDaemons = [];
after(() => {
  for (const pid of spawnedDaemons) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  }
});

describe("daemon status (true health)", () => {
  it("reports DOWN with exit 1 when the pid is dead", () => {
    const dir = makeStateDir();
    deadDaemonJson(dir);
    const r = cli(dir, "daemon", "status");
    assert.equal(r.status, 1, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    assert.match(r.stdout, /DOWN/);
    assert.match(r.stdout, /999999 is not alive/);
    assert.match(r.stdout, /daemon start/); // names the fix
  });

  it("reports DOWN with exit 1 when the daemon was never started", () => {
    const dir = makeStateDir();
    const r = cli(dir, "daemon", "status");
    assert.equal(r.status, 1);
    assert.match(r.stdout, /never started/);
  });

  it("reports running with exit 0 when pid is alive AND the API answers", async () => {
    const dir = makeStateDir();
    const server = createServer((req, res) => {
      if (req.url === "/health") { res.writeHead(200); res.end("{}"); }
      else { res.writeHead(404); res.end(); }
    });
    await new Promise((res) => server.listen(0, "127.0.0.1", res));
    const port = server.address().port;
    writeFileSync(
      join(dir, "daemon.json"),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), apiPort: port, apiUrl: `http://127.0.0.1:${port}` }) + "\n"
    );
    try {
      const r = await cliAsync(dir, "daemon", "status");
      assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
      assert.match(r.stdout, new RegExp(`running pid=${process.pid}`));
    } finally {
      server.close();
    }
  });

  it("reports DOWN when the pid is alive but the API is wedged", async () => {
    const dir = makeStateDir();
    // Real alive pid (this test process), dead port: pid ok, API unreachable.
    writeFileSync(
      join(dir, "daemon.json"),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), apiPort: 19999, apiUrl: "http://127.0.0.1:19999" }) + "\n"
    );
    const r = await cliAsync(dir, "daemon", "status");
    assert.equal(r.status, 1);
    assert.match(r.stdout, /API not responding/);
  });
});

describe("daemon watchdog", () => {
  it("stays silent and exits 0 when the daemon is healthy", async () => {
    const dir = makeStateDir();
    const server = createServer((req, res) => {
      if (req.url === "/health") { res.writeHead(200); res.end("{}"); }
      else { res.writeHead(404); res.end(); }
    });
    await new Promise((res) => server.listen(0, "127.0.0.1", res));
    const port = server.address().port;
    writeFileSync(
      join(dir, "daemon.json"),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), apiPort: port, apiUrl: `http://127.0.0.1:${port}` }) + "\n"
    );
    try {
      const r = await cliAsync(dir, "daemon", "watchdog");
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.equal(r.stdout.trim(), "", "healthy watchdog must stay silent");
    } finally {
      server.close();
    }
  });

  it("restarts a dead daemon and verifies it is up", () => {
    const dir = makeStateDir();
    deadDaemonJson(dir);
    // Ephemeral port so the restart never collides with the live daemon.
    const cfgPath = join(dir, "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    cfg.apiPort = 0;
    writeFileSync(cfgPath, JSON.stringify(cfg) + "\n");

    const r = cli(dir, "daemon", "watchdog");
    assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    assert.match(r.stdout, /daemon restarted pid=/);

    const dj = JSON.parse(readFileSync(join(dir, "daemon.json"), "utf8"));
    assert.ok(pidAlive(dj.pid), "restarted daemon pid must be alive");
    spawnedDaemons.push(dj.pid);

    const health = spawnSync("curl", ["-s", "--max-time", "5", dj.apiUrl + "/health"], { encoding: "utf8" });
    assert.match(health.stdout, /"ok":true/);
    assert.ok(existsSync(join(dir, "watchdog.log")), "watchdog must log the restart");
    const wlog = readFileSync(join(dir, "watchdog.log"), "utf8");
    assert.match(wlog, /restarting/);
    assert.match(wlog, /restarted ok/);
  });

  it("refuses to restart when a crash loop is suspected", () => {
    const dir = makeStateDir();
    deadDaemonJson(dir);
    const now = Date.now();
    writeFileSync(
      join(dir, "watchdog.json"),
      JSON.stringify({ restarts: [now - 60000, now - 120000, now - 180000, now - 240000, now - 300000] }) + "\n"
    );
    const r = cli(dir, "daemon", "watchdog");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /crash loop/i);
    // daemon.json must be untouched — no restart was attempted.
    const dj = JSON.parse(readFileSync(join(dir, "daemon.json"), "utf8"));
    assert.equal(dj.pid, 999999);
  });
});
