/**
 * plugin.mjs — the Plugin interface.
 *
 * A doctor plugin is a plain ES module that default-exports an object shaped
 * like this:
 *
 *   export default {
 *     // Identity ---------------------------------------------------------
 *     name: "my-daemon",          // plugin name (for logs)
 *     subject: "daemon",          // the thing being supervised; used in
 *                                 // CLI output lines ("daemon death recorded…")
 *     dir: "/var/lib/my-daemon",  // state dir (CLI --dir overrides this)
 *
 *     // Tuning ------------------------------------------------------------
 *     pollMs: 15000,              // health probe interval (default 15000)
 *     logHint: "/var/log/my-daemon.log",
 *                                 // path shown in the crash-loop warning;
 *                                 // default: "<dir>/<subject>.log"
 *     courtesyWaitMs: 10000,      // lock-courtesy re-probe wait (default)
 *     verifyWaitMs: 4000,         // post-recover settle before verify (default)
 *
 *     // The honest health probe -------------------------------------------
 *     // Must answer the REAL question: is the subject alive AND itself AND
 *     // answering? pid-alive alone is racy (pid reuse); cmdline/env checks
 *     // make it pid-reuse safe. Never log credentials used for the probe.
 *     async healthCheck(dir) {
 *       return { up: true, pid: 123, startedAt: "<iso>", apiUrl: "…" };
 *       // or { up: false, pid, startedAt, reason: "why it looks down" }
 *     },
 *
 *     // Forensic collectors --------------------------------------------------
 *     // Run on every NEW death, BEFORE recovery. Each returns anything
 *     // JSON-serializable; results land in the bundle under their key.
 *     // Reserved keys the coroner/detective understand:
 *     //   oom        -> { available: bool, lines: [] }  => bundle.oomEvidence
 *     //   heartbeats -> [{ name, workerAlive, heartbeatFresh }]
 *     //                                            => preDeathStaleWorkers
 *     //   tick       -> { lastTickStartMs, lastTickEndMs, … }
 *     //                                            => death.lastTickAgeMs
 *     //   memory     -> number (MiB available)      => death.memAvailableMb
 *     collectors: {
 *       logTail: (dir, deathCtx) => tailLines(join(dir, "daemon.log"), 200),
 *       ps:      (dir, deathCtx) => psFiltered(),
 *     },
 *
 *     // Recovery --------------------------------------------------------------
 *     // Bring the subject back. Return { ok, pid?, method?, detail?, ... }.
 *     // The medic verifies with healthCheck afterwards; journaled ok reflects
 *     // the VERIFICATION, with your ok kept as recoverOk. Pass through
 *     // crashLoop: true when your restart path reports a restart storm.
 *     async recover(dir) {
 *       return { ok: true, pid: 456, method: "systemctl-restart" };
 *     },
 *
 *     // Optional courtesy -------------------------------------------------------
 *     // If a live subject holds its lock, the medic waits courtesyWaitMs and
 *     // re-probes health instead of restarting blindly. Return null to skip.
 *     lockProbe(dir) { return { held: true, stale: false, live: true }; },
 *   };
 *
 * Zero dependencies: node:fs / node:path / node:os / node:child_process only.
 */
import { pathToFileURL } from "node:url";

/** Load a plugin from a doctor.config.mjs path (default export). */
export async function loadPlugin(configPath) {
  const mod = await import(pathToFileURL(configPath).href);
  const plugin = mod.default ?? mod.plugin;
  if (!plugin || typeof plugin !== "object") {
    throw new Error(`doctor: ${configPath} must export a plugin object (default export)`);
  }
  return plugin;
}

/** Validate a plugin object. Throws a descriptive Error on the first problem. */
export function validatePlugin(p) {
  const fail = (msg) => { throw new Error(`doctor: invalid plugin — ${msg}`); };
  if (!p || typeof p !== "object") fail("must be an object");
  if (typeof p.name !== "string" || !p.name) fail("name must be a non-empty string");
  if (typeof p.subject !== "string" || !p.subject) fail("subject must be a non-empty string");
  if (p.dir !== undefined && typeof p.dir !== "string") fail("dir must be a string");
  if (typeof p.healthCheck !== "function") fail("healthCheck(dir) must be a function");
  if (typeof p.recover !== "function") fail("recover(dir) must be a function");
  if (p.collectors !== undefined) {
    if (!p.collectors || typeof p.collectors !== "object" || Array.isArray(p.collectors)) {
      fail("collectors must be an object mapping names to functions");
    }
    for (const [k, fn] of Object.entries(p.collectors)) {
      if (typeof fn !== "function") fail(`collectors.${k} must be a function`);
    }
  }
  if (p.lockProbe !== undefined && typeof p.lockProbe !== "function") {
    fail("lockProbe(dir) must be a function");
  }
  if (p.pollMs !== undefined && !(Number.isFinite(p.pollMs) && p.pollMs > 0)) {
    fail("pollMs must be a positive number");
  }
  if (p.courtesyWaitMs !== undefined && !(Number.isFinite(p.courtesyWaitMs) && p.courtesyWaitMs >= 0)) {
    fail("courtesyWaitMs must be a non-negative number");
  }
  if (p.verifyWaitMs !== undefined && !(Number.isFinite(p.verifyWaitMs) && p.verifyWaitMs >= 0)) {
    fail("verifyWaitMs must be a non-negative number");
  }
  if (p.logHint !== undefined && typeof p.logHint !== "string") fail("logHint must be a string");
  return p;
}

/** Validate one health-check result. Throws on a dishonest shape. */
export function validateHealth(h) {
  if (!h || typeof h !== "object" || typeof h.up !== "boolean") {
    throw new Error("doctor: healthCheck must resolve to { up: boolean, ... }");
  }
  return h;
}
