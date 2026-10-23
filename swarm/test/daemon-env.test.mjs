/**
 * daemon-env: the persistent per-state-dir env file (<stateDir>/daemon.env)
 * that configures the daemon child on every boot path (direct start,
 * watchdog, Doctor medic → watchdog), lib/daemon-env.mjs + the
 * daemonStart() wiring in swarm.mjs.
 *
 * Pinned here:
 *   - the parser is NOT a shell: blanks/comments ignored, keys
 *     validated, values literal (no $ expansion, no command
 *     substitution), quotes stripped verbatim, malformed lines
 *     reported and skipped — never fatal;
 *   - precedence: explicit process env (even empty) > daemon.env, and
 *     KILN_SWARM_DIR is always forced to the state dir being started;
 *   - the file applies only to the spawned daemon child — building
 *     the spawn env never mutates the caller's process.env;
 *   - end to end: a real `daemon start` on a scratch dir carries the
 *     file's values in the child's /proc environ, an explicit CLI env
 *     value beats the file, and the daemon still boots healthy when
 *     the file selects minilm-l6-v2 with its runtime cache missing
 *     (the memory tier is lazy; a vanished embedder must not crash
 *     boot — recall fallback itself is pinned in memory-vectors.test).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeStateDir } from "./helpers.mjs";
import {
  parseDaemonEnv, readDaemonEnv, buildDaemonSpawnEnv, daemonEnvPath,
} from "../lib/daemon-env.mjs";

const CLI = new URL("../swarm.mjs", import.meta.url).pathname;
const spawnedDaemons = [];
after(() => {
  for (const pid of spawnedDaemons) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  }
});

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe("daemon-env: parser", () => {
  it("reads KEY=VALUE, ignores blanks and comments", () => {
    const { env, problems } = parseDaemonEnv(
      "# a comment\n\n  \nKILN_MEMORY_EMBEDDER=minilm-l6-v2\n  # indented comment\nOTHER = spaced \n",
    );
    assert.deepEqual(env, { KILN_MEMORY_EMBEDDER: "minilm-l6-v2", OTHER: "spaced" });
    assert.deepEqual(problems, []);
  });

  it("accepts an optional export prefix and matching quotes, verbatim", () => {
    const { env, problems } = parseDaemonEnv(
      'export A="hello world"\nB=\'single quoted\'\nC="unterminated\n',
    );
    assert.equal(env.A, "hello world");
    assert.equal(env.B, "single quoted");
    assert.equal(env.C, '"unterminated', "unmatched quote is kept literal, not stripped");
    assert.deepEqual(problems, []);
  });

  it("never interprets the shell: $VAR, backticks and $(...) stay literal", () => {
    const { env } = parseDaemonEnv("A=$HOME/$(whoami)/`id`\nB=pre$FIX\n");
    assert.equal(env.A, "$HOME/$(whoami)/`id`");
    assert.equal(env.B, "pre$FIX");
  });

  it("a # inside a value is part of the value (no inline comments)", () => {
    const { env } = parseDaemonEnv("URL=http://127.0.0.1:18787/#frag\n");
    assert.equal(env.URL, "http://127.0.0.1:18787/#frag");
  });

  it("empty values are set, duplicate keys take the last line, CRLF is fine", () => {
    const { env } = parseDaemonEnv("EMPTY=\r\nDUP=first\r\nDUP=second\r\n");
    assert.equal(env.EMPTY, "");
    assert.equal(env.DUP, "second");
  });

  it("skips malformed lines and invalid keys, reporting each — never throws", () => {
    const { env, problems } = parseDaemonEnv(
      "no equals here\n1BAD=x\nBAD-NAME=x\nGOOD=ok\n=nothing\n",
    );
    assert.deepEqual(env, { GOOD: "ok" });
    assert.equal(problems.length, 4);
    assert.deepEqual(problems.map((p) => p.line), [1, 2, 3, 5]);
    assert.match(problems[1].reason, /invalid variable name/);
  });
});

describe("daemon-env: file reading and spawn-env merging", () => {
  it("a missing file is the normal case: empty env, no problems", () => {
    const dir = makeStateDir();
    const r = readDaemonEnv(dir);
    assert.equal(r.exists, false);
    assert.equal(r.path, daemonEnvPath(dir));
    assert.deepEqual(r.env, {});
    assert.deepEqual(r.problems, []);
  });

  it("the file supplies what the process env lacks", () => {
    const dir = makeStateDir();
    writeFileSync(daemonEnvPath(dir), "KILN_MEMORY_EMBEDDER=minilm-l6-v2\nFROM_FILE=1\n");
    const { env, applied } = buildDaemonSpawnEnv(dir, { PATH: "/usr/bin" });
    assert.equal(env.KILN_MEMORY_EMBEDDER, "minilm-l6-v2");
    assert.equal(env.FROM_FILE, "1");
    assert.deepEqual(applied.sort(), ["FROM_FILE", "KILN_MEMORY_EMBEDDER"]);
  });

  it("explicit process env wins over the file — even when set empty", () => {
    const dir = makeStateDir();
    writeFileSync(daemonEnvPath(dir), "KILN_MEMORY_EMBEDDER=minilm-l6-v2\nPINNED=file\nBLANKED=file\n");
    const { env, applied } = buildDaemonSpawnEnv(dir, {
      PINNED: "process",
      BLANKED: "",
    });
    assert.equal(env.PINNED, "process", "explicit value beats the file");
    assert.equal(env.BLANKED, "", "an explicitly empty value still beats the file");
    assert.equal(env.KILN_MEMORY_EMBEDDER, "minilm-l6-v2", "unspecified keys still come from the file");
    assert.deepEqual(applied, ["KILN_MEMORY_EMBEDDER"]);
  });

  it("KILN_SWARM_DIR is always forced to the dir being started", () => {
    const dir = makeStateDir();
    writeFileSync(daemonEnvPath(dir), "KILN_SWARM_DIR=/somewhere/else\n");
    const { env } = buildDaemonSpawnEnv(dir, { KILN_SWARM_DIR: "/also/wrong" });
    assert.equal(env.KILN_SWARM_DIR, dir);
  });

  it("building the spawn env never mutates the caller's environment", () => {
    const dir = makeStateDir();
    writeFileSync(daemonEnvPath(dir), "KILN_DAEMON_ENV_LEAK_CHECK=from-file\n");
    const before = process.env.KILN_DAEMON_ENV_LEAK_CHECK;
    buildDaemonSpawnEnv(dir); // defaults to process.env as the base
    assert.equal(process.env.KILN_DAEMON_ENV_LEAK_CHECK, before);
  });

  it("a malformed file degrades to the good lines, with problems, not a throw", () => {
    const dir = makeStateDir();
    writeFileSync(daemonEnvPath(dir), "garbage line\nGOOD=ok\n");
    const { env, problems } = buildDaemonSpawnEnv(dir, {});
    assert.equal(env.GOOD, "ok");
    assert.equal(problems.length, 1);
  });
});

describe("daemon-env: real daemon start (scratch dir, ephemeral port)", () => {
  it("child carries the file's env, explicit env beats it, and boot survives a missing embedder cache", async () => {
    const dir = makeStateDir();
    const cfgPath = join(dir, "config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    cfg.apiPort = 0; // ephemeral — never the live daemon's port
    writeFileSync(cfgPath, JSON.stringify(cfg) + "\n");
    const emptyEmbedderHome = mkdtempSync(join(tmpdir(), "kiln-embedder-gone-"));
    writeFileSync(daemonEnvPath(dir), [
      "# select the neural embedder — its cache is deliberately absent below",
      "KILN_MEMORY_EMBEDDER=minilm-l6-v2",
      `KILN_MEMORY_EMBEDDER_HOME=${emptyEmbedderHome}`,
      "KILN_DAEMON_ENV_MARKER=from-file",
      "KILN_DAEMON_ENV_OVERRIDE=from-file",
      "",
    ].join("\n"));

    const r = spawnSync("node", [CLI, "daemon", "start", "--dir", dir], {
      encoding: "utf8",
      timeout: 30000,
      env: { ...process.env, KILN_DAEMON_ENV_OVERRIDE: "from-process" },
    });
    assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    assert.match(r.stdout, /daemon starting pid=/);

    // Wait for the daemon to write daemon.json and answer /health —
    // the boot must succeed even though minilm's runtime is missing
    // (nothing at boot touches the lazy memory vector tier).
    let dj = null;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try {
        const cur = JSON.parse(readFileSync(join(dir, "daemon.json"), "utf8"));
        if (cur.pid && pidAlive(cur.pid)) {
          const res = await fetch(cur.apiUrl + "/health", { signal: AbortSignal.timeout(2000) }).catch(() => null);
          if (res && res.ok) { dj = cur; break; }
        }
      } catch { /* not written yet */ }
      await new Promise((res) => setTimeout(res, 250));
    }
    assert.ok(dj, "daemon must boot healthy with a vanished embedder cache");
    spawnedDaemons.push(dj.pid);
    assert.ok(existsSync(`/proc/${dj.pid}/environ`), "test needs /proc to inspect the child env");
    const childEnv = Object.fromEntries(
      readFileSync(`/proc/${dj.pid}/environ`, "utf8").split("\0").filter(Boolean)
        .map((kv) => { const i = kv.indexOf("="); return [kv.slice(0, i), kv.slice(i + 1)]; }),
    );
    assert.equal(childEnv.KILN_MEMORY_EMBEDDER, "minilm-l6-v2", "file value reached the daemon child");
    assert.equal(childEnv.KILN_DAEMON_ENV_MARKER, "from-file");
    assert.equal(childEnv.KILN_DAEMON_ENV_OVERRIDE, "from-process", "explicit env beat the file in the real spawn");
    assert.equal(childEnv.KILN_SWARM_DIR, dir);
  });
});
