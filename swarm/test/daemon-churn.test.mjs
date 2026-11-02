/**
 * Ticket E4: the supervisor runs on every tick, so a terminally-dead node
 * (policy=never, or max restarts reached) got its "not respawning / leaving
 * dead" line re-logged every 2s — ~25k lines and a 10MB daemon.log in a day
 * on the live daemon. Each distinct terminal state must be logged exactly
 * once per daemon lifetime.
 *
 * Runs the real daemon (lib/daemon.mjs) against a scratch state dir with a
 * fast tick, two terminally-dead nodes, then counts the terminal lines in
 * daemon.log. Never touches the live daemon.
 *
 * Flake history (round 2): the original test slept a fixed 1500ms, SIGTERMed,
 * and asserted. Under load the daemon may not have ticked enough — or its
 * stdout/stderr chunks may not have been flushed to daemon.log — in that
 * window, so a correct daemon failed with 0 lines. This version never
 * asserts on a wall-clock guess: it polls (50ms, 25s deadline) until BOTH
 * terminal lines are present in the log AND tick.json proves the daemon
 * kept ticking well past their first appearance — at least MIN_TICKS ticks
 * overall, plus at least OBSERVE_TICKS more ticks and OBSERVE_MS more time
 * after the first evidence — so a per-tick duplicate would have had many
 * chances to appear before the exactly-once assertions run. On timeout it
 * fails with the tick count and a daemon.log excerpt, not a bare count.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeStateDir } from "./helpers.mjs";
import { tickJsonPath } from "../lib/tickwatch.mjs";

const DAEMON = new URL("../lib/daemon.mjs", import.meta.url).pathname;
const children = [];
after(() => { for (const c of children) { try { c.kill("SIGKILL"); } catch {} } });

// Poll cadence / evidence thresholds. tickMs is 100, so MIN_TICKS alone is
// ~2.5s of ticking — already more than the old fixed 1500ms window — and
// the post-evidence observation window adds ~1s / 10 more ticks on top.
const POLL_MS = 50;
const DEADLINE_MS = 25_000;
const MIN_TICKS = 25;
const OBSERVE_TICKS = 10;
const OBSERVE_MS = 1_000;
const STOP_DEADLINE_MS = 10_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function deadNode(id, name, extra = {}) {
  return {
    id,
    name,
    pubSpkiB64: "MCowBQYDK2VwAyEA7m9tZXhhbXBsZXhhbXBsZXhhbXBsZXhhbXBsZXhhbXBsZTA=",
    grant: { capabilities: 15, expiresAt: Math.floor(Date.now() / 1000) + 3600, parent: null },
    repo: null,
    mind: "script",
    workdir: `/tmp/kiln-churn-test/${id}/work`,
    createdAt: Math.floor(Date.now() / 1000),
    autostart: true,
    restartPolicy: "never",
    maxRestarts: 3,
    restarts: 0,
    workerPid: 2147483647, // no such pid — node is dead
    lastExit: 1,
    ...extra,
  };
}

function countTerminalLines(logText, name, phrase) {
  return logText.split("\n").filter((l) => l.includes(name) && l.includes(phrase)).length;
}

function readDaemonLog(logPath) {
  try { return readFileSync(logPath, "utf8"); } catch { return ""; }
}

/** tickCount from tick.json; 0 while absent or mid-write (unparseable). */
function readTickCount(dir) {
  try {
    const t = JSON.parse(readFileSync(tickJsonPath(dir), "utf8"));
    return Number.isFinite(t.tickCount) ? t.tickCount : 0;
  } catch { return 0; }
}

function logExcerpt(logText) {
  const tail = logText.slice(-4000).trim();
  return tail || "(daemon.log empty or missing)";
}

/** SIGTERM the daemon and wait for close, bounded; SIGKILL past the deadline. */
async function stopDaemon(child) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  const closed = new Promise((r) => child.once("close", () => r(true)));
  // Bounded wait whose timer is always cleared — a losing sleep() left
  // pending would keep the test process's event loop alive for its full
  // duration after the daemon already closed.
  const bounded = async (ms) => {
    let timer;
    const timeout = new Promise((r) => { timer = setTimeout(() => r(false), ms); });
    const result = await Promise.race([closed, timeout]);
    clearTimeout(timer);
    return result;
  };
  try { child.kill("SIGTERM"); } catch {}
  if (await bounded(STOP_DEADLINE_MS)) return true;
  try { child.kill("SIGKILL"); } catch {}
  return bounded(5_000);
}

describe("daemon terminal-state log churn (E4)", () => {
  it("logs each terminally-dead node exactly once across many ticks", async () => {
    const dir = makeStateDir();
    const cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    cfg.tickMs = 100;   // MIN_TICKS ticks ≈ 2.5s of ticking, polled not slept
    cfg.apiPort = 0;    // ephemeral — never touches the live daemon's port
    cfg.autospawn = false;
    writeFileSync(join(dir, "config.json"), JSON.stringify(cfg));

    const id1 = "a".repeat(64), id2 = "b".repeat(64);
    mkdirSync(join(dir, "nodes", id1), { recursive: true });
    mkdirSync(join(dir, "nodes", id2), { recursive: true });
    writeFileSync(join(dir, "nodes", id1, "node.json"), JSON.stringify(deadNode(id1, "churn-never")));
    writeFileSync(
      join(dir, "nodes", id2, "node.json"),
      JSON.stringify(deadNode(id2, "churn-maxed", { restartPolicy: "always", restarts: 3 })),
    );

    const child = spawn(process.execPath, [DAEMON], {
      env: { ...process.env, KILN_SWARM_DIR: dir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    // daemon start normally redirects stdout/stderr to daemon.log; do the
    // same here so the test reads the real log surface. appendFileSync per
    // chunk: a synchronous O_APPEND write of the whole chunk — 'data'
    // callbacks are serialized by the event loop, and append mode means no
    // chunk can truncate or overwrite another stream's chunk.
    const logPath = join(dir, "daemon.log");
    child.stdout.on("data", (d) => appendFileSync(logPath, d));
    child.stderr.on("data", (d) => appendFileSync(logPath, d));

    // Poll-with-deadline for positive evidence instead of a fixed sleep.
    // Ready = both terminal lines observed, daemon has ticked at least
    // MIN_TICKS times, and it kept ticking (OBSERVE_TICKS more ticks over
    // at least OBSERVE_MS) after the lines first appeared — duplicates
    // re-logged per tick would show up inside that window.
    const deadline = Date.now() + DEADLINE_MS;
    let evidenceAtMs = null;
    let evidenceTickCount = 0;
    let tickCount = 0;
    let daemonLog = "";
    let ready = false;
    while (Date.now() <= deadline) {
      daemonLog = readDaemonLog(logPath);
      tickCount = readTickCount(dir);
      const hasNever = countTerminalLines(daemonLog, "churn-never", "not respawning") >= 1;
      const hasMaxed = countTerminalLines(daemonLog, "churn-maxed", "max restarts") >= 1;
      if (hasNever && hasMaxed) {
        if (evidenceAtMs === null) {
          evidenceAtMs = Date.now();
          evidenceTickCount = tickCount;
        }
        if (
          tickCount >= MIN_TICKS &&
          tickCount - evidenceTickCount >= OBSERVE_TICKS &&
          Date.now() - evidenceAtMs >= OBSERVE_MS
        ) {
          ready = true;
          break;
        }
      }
      if (child.exitCode !== null) break; // daemon died — fail below with the log
      await sleep(POLL_MS);
    }

    const stopped = await stopDaemon(child);
    assert.ok(stopped, `daemon did not exit within ${STOP_DEADLINE_MS}ms of SIGTERM`);
    if (!ready) {
      assert.fail(
        `daemon-churn evidence not ready within ${DEADLINE_MS}ms: ` +
        `tickCount=${tickCount} (want >= ${MIN_TICKS}, plus ${OBSERVE_TICKS} ticks / ` +
        `${OBSERVE_MS}ms after first evidence), child exitCode=${child.exitCode}, ` +
        `state dir=${dir}\ndaemon.log excerpt:\n${logExcerpt(readDaemonLog(logPath))}`,
      );
    }

    // 'close' has fired, so every stdout/stderr chunk has been delivered to
    // the handlers above and synchronously appended — this read is final.
    daemonLog = readDaemonLog(logPath);
    assert.ok(existsSync(logPath), "daemon.log must exist");
    const neverLines = countTerminalLines(daemonLog, "churn-never", "not respawning");
    const maxedLines = countTerminalLines(daemonLog, "churn-maxed", "max restarts");
    assert.equal(
      neverLines, 1,
      `policy=never logged ${neverLines}x across ${tickCount} ticks, want exactly 1\n` +
      `daemon.log excerpt:\n${logExcerpt(daemonLog)}`,
    );
    assert.equal(
      maxedLines, 1,
      `max-restarts logged ${maxedLines}x across ${tickCount} ticks, want exactly 1\n` +
      `daemon.log excerpt:\n${logExcerpt(daemonLog)}`,
    );
  });
});
