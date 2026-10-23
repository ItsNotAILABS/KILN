/**
 * daemon-env.mjs — persistent per-state-dir environment for the daemon.
 *
 * The daemon is (re)started by whoever happens to be around at the
 * time — a human at a shell, `swarm.mjs daemon watchdog`, or the
 * Doctor's medic invoking the watchdog — and each of those processes
 * carries a different ambient environment. Settings that must survive
 * that (the canonical example: selecting the neural memory embedder
 * with KILN_MEMORY_EMBEDDER=minilm-l6-v2) therefore cannot live only
 * in a shell export. They live in a state-dir file instead:
 *
 *   <stateDir>/daemon.env      KEY=VALUE lines, operator-owned
 *
 * This module is the ONLY reader. `daemonStart()` in swarm.mjs builds
 * the daemon child's spawn env through `buildDaemonSpawnEnv()`; no
 * other process's environment is read-mutated or written — the file
 * applies to the daemon child (and, by ordinary inheritance, the
 * workers it spawns), never to the CLI / watchdog / Doctor process
 * that happened to start it.
 *
 * Format — deliberately NOT a shell fragment:
 *   - One KEY=VALUE per line. Blank lines and lines whose first
 *     non-space character is `#` are ignored. There are no inline
 *     comments: a `#` inside a value is part of the value.
 *   - An optional leading `export ` is accepted (so a file copied
 *     from a shell snippet still parses), but nothing is ever
 *     executed, expanded, or substituted: `$VAR`, backticks and
 *     `$(...)` are literal characters in the value.
 *   - Keys must match [A-Za-z_][A-Za-z0-9_]*. Lines that are not
 *     KEY=VALUE, or whose key is invalid, are skipped and reported
 *     in `problems` — a malformed line never aborts a daemon boot.
 *   - Values are trimmed of surrounding whitespace. A value wrapped
 *     in matching single or double quotes has the outer quotes
 *     stripped; the contents are taken verbatim (no escape
 *     processing). An empty value (KEY=) sets the empty string.
 *   - A repeated key: the last line wins (noted in `problems` is
 *     unnecessary — this is the documented rule, not an error).
 *
 * Precedence (pinned by test/daemon-env.test.mjs):
 *   explicit process env  >  daemon.env  >  (daemon defaults)
 * A variable already present in the starting process's environment —
 * even set to the empty string — always wins over the file. The file
 * supplies only what the process did not specify. The one exception
 * is KILN_SWARM_DIR, which the spawn always forces to the state dir
 * being started (the pre-existing daemonStart invariant).
 *
 * Trust: daemon.env sits in the state dir beside api.token and
 * config.json and is operator config of the same standing. It is not
 * a place for secrets that must stay out of the daemon's children —
 * everything in it is passed to the daemon and its workers.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function daemonEnvPath(dir) {
  return join(dir, "daemon.env");
}

/**
 * Parse daemon.env text. Pure.
 * Returns { env: {KEY: string}, problems: [{line, text, reason}] }.
 */
export function parseDaemonEnv(text) {
  const env = {};
  const problems = [];
  const src = String(text ?? "").replace(/^﻿/, "");
  const lines = src.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = i + 1;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const body = trimmed.startsWith("export ") || trimmed.startsWith("export\t")
      ? trimmed.slice("export".length).trimStart()
      : trimmed;
    const eq = body.indexOf("=");
    if (eq <= 0) {
      problems.push({ line, text: raw, reason: "not a KEY=VALUE line" });
      continue;
    }
    const key = body.slice(0, eq).trim();
    if (!KEY_RE.test(key)) {
      problems.push({ line, text: raw, reason: `invalid variable name "${key}"` });
      continue;
    }
    let value = body.slice(eq + 1).trim();
    if (value.length >= 2) {
      const q = value[0];
      if ((q === '"' || q === "'") && value[value.length - 1] === q) {
        value = value.slice(1, -1);
      }
    }
    env[key] = value; // duplicate key: last line wins
  }
  return { env, problems };
}

/**
 * Read <dir>/daemon.env. A missing file is the normal case, not an
 * error: { env: {}, problems: [], exists: false }. An unreadable file
 * is reported as a problem with an empty env rather than thrown —
 * config trouble must never be the reason a daemon fails to boot.
 */
export function readDaemonEnv(dir) {
  const path = daemonEnvPath(dir);
  if (!existsSync(path)) return { env: {}, problems: [], path, exists: false };
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    return {
      env: {}, path, exists: true,
      problems: [{ line: 0, text: "", reason: `unreadable: ${e.message}` }],
    };
  }
  const { env, problems } = parseDaemonEnv(text);
  return { env, problems, path, exists: true };
}

/**
 * Build the daemon child's spawn environment for state dir `dir`.
 *
 *   baseEnv (default process.env) — explicit, wins over the file
 *   <dir>/daemon.env               — supplies what baseEnv lacks
 *   KILN_SWARM_DIR                 — always forced to `dir`
 *
 * Returns { env, problems, path, exists, applied } where `applied`
 * names the keys the file actually contributed (not overridden, and
 * excluding the forced KILN_SWARM_DIR).
 */
export function buildDaemonSpawnEnv(dir, baseEnv = process.env) {
  const { env: fileEnv, problems, path, exists } = readDaemonEnv(dir);
  const env = { ...fileEnv };
  const applied = [];
  for (const k of Object.keys(fileEnv)) {
    if (!Object.prototype.hasOwnProperty.call(baseEnv, k)) applied.push(k);
  }
  for (const [k, v] of Object.entries(baseEnv)) {
    if (v !== undefined) env[k] = v;
  }
  env.KILN_SWARM_DIR = dir;
  return { env, problems, path, exists, applied };
}
