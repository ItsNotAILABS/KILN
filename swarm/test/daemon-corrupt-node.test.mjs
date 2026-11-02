/**
 * Corrupt node record isolation — regression tests for the 2026-10-23
 * wedge.
 *
 * The failure chain being pinned shut:
 *   1. A host write fault zeroed one node's node.json (saveNode used to
 *      write in place — now atomic, see atomic-write.test.mjs).
 *   2. Boot reconcile() called loadNode() unguarded; JSON.parse("")
 *      threw inside async main(); the unhandledRejection handler logged
 *      "staying alive" — but the tick interval and stall watchdog were
 *      created AFTER the reconcile line, so they never existed. Three
 *      consecutive Doctor boots served API/git/CI with node supervision
 *      silently dead.
 *   3. The stop handler referenced the not-yet-initialized timer consts,
 *      so SIGTERM during/after the failed boot threw a TDZ ReferenceError
 *      inside the handler — the wedged daemon was SIGTERM-proof.
 *
 * These tests boot a REAL daemon on a scratch state dir holding one
 * healthy autostart node and one node whose node.json is 0 bytes, and
 * require: the daemon boots, ticks run, the healthy node respawns, the
 * corrupt node is reported DEGRADED with its record left byte-identical
 * on disk, and SIGTERM exits cleanly (code 0). Plus: a SIGTERM sent
 * during early boot (before daemon.json exists) always terminates the
 * process — never a wedge.
 *
 * Never touches the live daemon: scratch state dirs, ephemeral apiPort 0.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { makeStateDir, makeNode } from "./helpers.mjs";
import { loadNode, saveNode, nodeJsonPath } from "../lib/state.mjs";
import { tickJsonPath } from "../lib/tickwatch.mjs";

const DAEMON = new URL("../lib/daemon.mjs", import.meta.url).pathname;

const children = [];
const strayPids = [];
after(() => {
  for (const c of children) { try { c.kill("SIGKILL"); } catch {} }
  for (const pid of strayPids) { try { process.kill(pid, "SIGKILL"); } catch {} }
});

function scratchDir() {
  const dir = makeStateDir();
  const cfgPath = join(dir, "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  cfg.apiPort = 0; // ephemeral
  cfg.tickMs = 50;
  cfg.autospawn = false;
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  return dir;
}

function spawnDaemon(dir) {
  const child = spawn(process.execPath, [DAEMON], {
    env: { ...process.env, KILN_SWARM_DIR: dir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  return { child, output: () => out };
}

function waitFor(cond, timeoutMs, label) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const iv = setInterval(() => {
      let ok = false;
      try { ok = cond(); } catch { ok = false; }
      if (ok) { clearInterval(iv); resolve(); }
      else if (Date.now() - t0 > timeoutMs) { clearInterval(iv); reject(new Error(`timeout: ${label}`)); }
    }, 50);
  });
}

/** Resolve with the exit code; reject if the process is still alive after timeoutMs (the wedge signature). */
function exitWithin(child, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`${label}: process did not exit within ${timeoutMs}ms — wedged`)), timeoutMs);
    child.on("close", (code) => { clearTimeout(to); resolve(code); });
  });
}

describe("daemon with a corrupt (0-byte) node record", () => {
  it("boots, ticks, respawns the healthy node, degrades the corrupt one, stops cleanly", async () => {
    const dir = scratchDir();

    // One healthy autostart node (real keypair + clone via helpers).
    const healthy = await makeNode(dir, { name: "healthy-wing" });
    const hRec = loadNode(dir, healthy.node.id);
    hRec.autostart = true;
    hRec.restartPolicy = "always";
    hRec.restarts = 0;
    hRec.maxRestarts = 3;
    hRec.workerPid = null;
    saveNode(dir, hRec);

    // One node whose record the "host fault" destroyed: exactly 0 bytes.
    const corrupt = await makeNode(dir, { name: "wing-corrupt" });
    writeFileSync(nodeJsonPath(dir, corrupt.node.id), "");
    assert.equal(readFileSync(nodeJsonPath(dir, corrupt.node.id), "utf8"), "");

    const { child, output } = spawnDaemon(dir);
    try {
      // Boot completes and the tick loop is alive and advancing.
      await waitFor(() => existsSync(tickJsonPath(dir)), 15000, "tick.json to appear");
      const ticksSeen = JSON.parse(readFileSync(tickJsonPath(dir), "utf8")).tickCount;
      await waitFor(
        () => JSON.parse(readFileSync(tickJsonPath(dir), "utf8")).tickCount > ticksSeen,
        10000,
        "tickCount to advance"
      );

      // The healthy node is respawned by reconcile despite its corrupt sibling.
      await waitFor(() => {
        const n = loadNode(dir, healthy.node.id);
        return typeof n.workerPid === "number" && n.workerPid > 0;
      }, 15000, "healthy node workerPid to be recorded");
      const workerPid = loadNode(dir, healthy.node.id).workerPid;
      strayPids.push(workerPid); // workers outlive the daemon by design; clean up

      // The corrupt node is loudly degraded, named in the log...
      await waitFor(() => output().includes("DEGRADED"), 10000, "DEGRADED line in daemon output");
      assert.match(output(), /FATAL node record unreadable/);
      assert.ok(output().includes(corrupt.node.id), "log line names the corrupt node id");

      // ...and its record on disk is left byte-identical (still 0 bytes):
      // the daemon must never "repair", overwrite, or delete the evidence.
      assert.equal(readFileSync(nodeJsonPath(dir, corrupt.node.id), "utf8"), "");

      // Stop during/after this boot exits cleanly — the TDZ wedge is gone.
      child.kill("SIGTERM");
      const code = await exitWithin(child, 10000, "SIGTERM after corrupt-node boot");
      assert.equal(code, 0, `daemon exit code ${code}, want 0`);
    } finally {
      try { child.kill("SIGKILL"); } catch {}
    }
  });

  it("SIGTERM during early boot (before daemon.json) always terminates the process", async () => {
    const dir = scratchDir();
    const { child } = spawnDaemon(dir);
    // Fire immediately: the signal lands somewhere in early boot — before
    // handlers, during handler registration, or during boot reconcile.
    // Every window must terminate; none may wedge.
    child.kill("SIGTERM");
    await exitWithin(child, 10000, "SIGTERM during early boot");
  });
});
