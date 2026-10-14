/**
 * Ticket (2026-10-02): pid-reuse worker adoption.
 *
 * A dead worker's pid can be recycled by an unrelated process. The daemon's
 * reconcile() used bare pidAlive() to decide a worker was live — so it
 * "adopted" the stranger as the worker instead of respawning the real one.
 * Seen live: a test daemon inherited a dead app worker's pid; the daemon
 * insisted both app workers were alive ("heartbeat stale") while their
 * HTTP servers were dark and the apps never respawned.
 *
 * The fix: nodeStatus()/reapExited() use pidIsWorker() (cmdline + env
 * verification, mirroring pidIsDaemon) instead of bare pidAlive().
 *
 * Never touches the live daemon: scratch dirs, ephemeral ports only.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeStateDir } from "./helpers.mjs";
import { pidIsWorker } from "../lib/state.mjs";

const CLI = new URL("../swarm.mjs", import.meta.url).pathname;
const cleanupPids = [];
after(() => {
  for (const pid of cleanupPids) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
});

function cli(dir, ...args) {
  const r = spawnSync("node", [CLI, ...args, "--dir", dir], { encoding: "utf8", timeout: 30000 });
  return r;
}

/** A live process that is NOT a worker: correct env, wrong cmdline. */
function spawnStranger(dir) {
  const p = spawn(process.execPath, ["-e", "setInterval(()=>{},60000);"], {
    env: { ...process.env, KILN_SWARM_DIR: dir },
    stdio: "ignore",
    detached: true,
  });
  p.unref();
  cleanupPids.push(p.pid);
  return p;
}

describe("pidIsWorker", () => {
  it("rejects a live stranger even with KILN_SWARM_DIR set", () => {
    const dir = makeStateDir();
    const stranger = spawnStranger(dir);
    assert.equal(pidIsWorker(stranger.pid, dir), false, "stranger must not count as a worker");
  });

  it("rejects a dead pid", () => {
    const dir = makeStateDir();
    assert.equal(pidIsWorker(99999998, dir), false);
  });

  it("rejects a zero/missing pid", () => {
    const dir = makeStateDir();
    assert.equal(pidIsWorker(null, dir), false);
    assert.equal(pidIsWorker(0, dir), false);
    assert.equal(pidIsWorker(undefined, dir), false);
  });
});

describe("daemon does not adopt a pid-reuse stranger", () => {
  it("treats the node as dead and respawns a real worker", async () => {
    const dir = makeStateDir();
    const cfgPath = join(dir, "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    cfg.apiPort = 0;
    cfg.tickMs = 200;
    writeFileSync(cfgPath, JSON.stringify(cfg) + "\n");

    const stranger = spawnStranger(dir);

    // Node record claiming the stranger as its worker, fresh heartbeat —
    // with the old pidAlive() check the daemon would adopt it as "idle".
    const id = "abc123def4567890";
    const ndir = join(dir, "nodes", id);
    mkdirSync(join(ndir, "work"), { recursive: true });
    const node = {
      id,
      name: "adopt-test",
      autostart: true,
      restartPolicy: "always",
      maxRestarts: 10,
      restarts: 0,
      workerPid: stranger.pid,
      lastExit: null,
      mind: "script",
      workdir: join(ndir, "work"),
      createdAt: Math.floor(Date.now() / 1000),
      grant: null,
      repo: null,
    };
    writeFileSync(join(ndir, "node.json"), JSON.stringify(node) + "\n");
    writeFileSync(join(ndir, "heartbeat"), String(Date.now()));

    const r = cli(dir, "daemon", "start");
    assert.equal(r.status, 0, `daemon start failed: ${r.stderr}`);
    // daemon.json is written by the detached daemon, not the CLI — poll for
    // it instead of reading immediately (the original test raced this and
    // died with ENOENT before the adoption assertion ever ran).
    let dj = null;
    for (let i = 0; i < 50 && !dj; i++) {
      try {
        dj = JSON.parse(readFileSync(join(dir, "daemon.json"), "utf8"));
      } catch {
        await new Promise((r2) => setTimeout(r2, 100));
      }
    }
    assert.ok(dj, "daemon.json never appeared after daemon start");
    cleanupPids.push(dj.pid);

    // Poll: the daemon must respawn — workerPid becomes a real worker.mjs pid.
    let cur = null;
    let respawned = false;
    for (let i = 0; i < 75; i++) {
      await new Promise((r2) => setTimeout(r2, 200));
      try {
        cur = JSON.parse(readFileSync(join(ndir, "node.json"), "utf8"));
      } catch { continue; }
      if (cur.workerPid && cur.workerPid !== stranger.pid) {
        let cmd = "";
        try {
          cmd = readFileSync(`/proc/${cur.workerPid}/cmdline`, "utf8").replace(/\0/g, " ");
        } catch { /* raced the respawn; keep polling */ }
        if (cmd.includes("worker.mjs")) { respawned = true; break; }
      }
    }
    assert.ok(
      respawned,
      `daemon adopted the stranger (pid ${stranger.pid}) instead of respawning ` +
      `(workerPid=${cur && cur.workerPid})`
    );

    cli(dir, "daemon", "stop");
  }, { timeout: 60000 });
});
