/**
 * Ticket #1: `swarm.mjs repo list` / `repo create` must not fail with a bare
 * "error: fetch failed" when the daemon isn't running.
 *
 * Expected behavior:
 *  - repo list/create fall back to the local state dir (the daemon's own
 *    create/list paths are the same lib/git.mjs functions, so the result is
 *    identical), and say so.
 *  - The stderr/stdout notes name the situation and tell the user how to
 *    start the daemon.
 *  - A duplicate create still fails honestly with "repo exists", never
 *    "fetch failed".
 *
 * Runs the real CLI as a subprocess against scratch state dirs whose
 * daemon.json points at a dead port. Never touches the live daemon.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeStateDir } from "./helpers.mjs";

const CLI = new URL("../swarm.mjs", import.meta.url).pathname;
// A port nothing listens on (checked: connection refused, not filtered).
const DEAD_PORT = 19999;

function deadDaemonDir(withPid) {
  const dir = makeStateDir();
  const dj = { apiPort: DEAD_PORT, apiUrl: `http://127.0.0.1:${DEAD_PORT}` };
  if (withPid) {
    dj.pid = 999999; // no such process; simulates a daemon that died
    dj.startedAt = "2026-09-19T00:00:00.000Z";
  }
  writeFileSync(join(dir, "daemon.json"), JSON.stringify(dj) + "\n");
  return dir;
}

function cli(dir, ...args) {
  const r = spawnSync("node", [CLI, ...args, "--dir", dir], { encoding: "utf8" });
  return {
    status: r.status,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
  };
}

describe("repo commands with the daemon down", () => {
  it("repo list on an empty state dir succeeds locally (no fetch failed)", () => {
    const dir = deadDaemonDir(false);
    const r = cli(dir, "repo", "list");
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /\(no repos\)/);
    assert.doesNotMatch(r.stderr, /fetch failed/i);
  });

  it("repo create falls back locally and says how to start the daemon", () => {
    const dir = deadDaemonDir(false);
    const r = cli(dir, "repo", "create", "--owner", "auro", "--repo", "dogfood");
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /created repo auro\/dogfood/);
    assert.match(r.stdout, /daemon not running/);
    assert.match(r.stdout, /node swarm\.mjs daemon start/);
    assert.match(r.stdout, new RegExp(`http://127\\.0\\.0\\.1:${DEAD_PORT}/git/auro/dogfood`));
    assert.ok(existsSync(join(dir, "git", "auro", "dogfood.git", "kiln.json")),
      "bare repo created on disk with kiln metadata");
    assert.doesNotMatch(r.stderr, /fetch failed/i);
  });

  it("repo list afterwards shows the locally-created repo", () => {
    const dir = deadDaemonDir(false);
    cli(dir, "repo", "create", "--owner", "auro", "--repo", "dogfood");
    const r = cli(dir, "repo", "list");
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /auro\/dogfood/);
    assert.match(r.stderr, /daemon not running/);
  });

  it("duplicate create fails honestly with 'repo exists', not 'fetch failed'", () => {
    const dir = deadDaemonDir(false);
    cli(dir, "repo", "create", "--owner", "auro", "--repo", "dogfood");
    const r = cli(dir, "repo", "create", "--owner", "auro", "--repo", "dogfood");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /repo exists: auro\/dogfood/);
    assert.doesNotMatch(r.stderr, /fetch failed/i);
  });

  it("a dead daemon with a recorded pid is reported as possibly-died", () => {
    const dir = deadDaemonDir(true);
    const r = cli(dir, "repo", "create", "--owner", "auro", "--repo", "ghost");
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /was started as pid 999999/);
    assert.match(r.stdout, /isn't responding/);
  });

  it("invalid repo names are still rejected locally", () => {
    const dir = deadDaemonDir(false);
    const r = cli(dir, "repo", "create", "--owner", "auro", "--repo", "not valid!");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /invalid owner\/repo name/);
  });
});
