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
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeStateDir } from "./helpers.mjs";

const DAEMON = new URL("../lib/daemon.mjs", import.meta.url).pathname;
const children = [];
after(() => { for (const c of children) { try { c.kill("SIGKILL"); } catch {} } });

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

describe("daemon terminal-state log churn (E4)", () => {
  it("logs each terminally-dead node exactly once across many ticks", async () => {
    const dir = makeStateDir();
    const cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    cfg.tickMs = 100;   // ~15 ticks in the wait below
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
    // same here so the test reads the real log surface.
    const logPath = join(dir, "daemon.log");
    child.stdout.on("data", (d) => writeFileSync(logPath, d, { flag: "a" }));
    child.stderr.on("data", (d) => writeFileSync(logPath, d, { flag: "a" }));
    await new Promise((r) => setTimeout(r, 1500));
    child.kill("SIGTERM");
    await new Promise((r) => child.on("close", r));

    const daemonLog = readFileSync(join(dir, "daemon.log"), "utf8");
    const neverLines = daemonLog.split("\n").filter((l) => l.includes("churn-never") && l.includes("not respawning"));
    const maxedLines = daemonLog.split("\n").filter((l) => l.includes("churn-maxed") && l.includes("max restarts"));
    assert.equal(neverLines.length, 1, `policy=never logged ${neverLines.length}x, want exactly 1`);
    assert.equal(maxedLines.length, 1, `max-restarts logged ${maxedLines.length}x, want exactly 1`);
  });
});
