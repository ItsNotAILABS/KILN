/**
 * Tick instrumentation + stall self-abort for the swarm daemon.
 *
 * The daemon's tick loop can wedge: it stops making progress without being
 * killed, so nothing looks like a crash. This module makes that observable
 * (tick.json, read by `swarm.mjs daemon status` and by the external
 * supervisor) and self-terminating (an independent watchdog timer aborts
 * the process when no tick has completed for too long).
 *
 * Pure logic lives here so it is unit-testable without importing
 * daemon.mjs (which runs main() on import).
 */
import { join } from "node:path";

export const TICK_JSON_NAME = "tick.json";
export const DEFAULT_TICK_STALL_ABORT_MS = 600000; // 10 minutes

/** `<stateDir>/tick.json` — the tick-stats contract. */
export function tickJsonPath(dir) {
  return join(dir, TICK_JSON_NAME);
}

/**
 * Stall-abort threshold in ms. Env KILN_TICK_STALL_MS wins when set to a
 * valid positive integer; otherwise config.json `tickStallAbortMs`; else
 * the 10-minute default. Invalid values are ignored (fall through), never
 * fatal.
 */
export function resolveTickStallMs(cfg) {
  const envRaw = process.env.KILN_TICK_STALL_MS;
  if (envRaw !== undefined && envRaw !== "") {
    const n = parseInt(envRaw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const cfgRaw = cfg ? cfg.tickStallAbortMs : undefined;
  if (Number.isFinite(cfgRaw) && cfgRaw > 0) return cfgRaw;
  return DEFAULT_TICK_STALL_ABORT_MS;
}

/**
 * Pure stall predicate. Stall = the last completed tick is older than the
 * threshold AND the daemon has been up longer than the threshold.
 *
 * Grace rules (both conservative by design):
 *  - lastTickEndMs null (no tick has completed yet) → never stalled.
 *  - uptime shorter than the threshold → never stalled, even if the first
 *    tick is slow.
 * Boundary is strict: exactly thresholdMs is NOT a stall.
 */
export function tickStalled({ lastTickEndMs, bootMs, nowMs, thresholdMs }) {
  if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) return false;
  if (lastTickEndMs == null) return false; // no completed tick yet
  if (!Number.isFinite(lastTickEndMs) || !Number.isFinite(bootMs) || !Number.isFinite(nowMs)) return false;
  return nowMs - lastTickEndMs > thresholdMs && nowMs - bootMs > thresholdMs;
}

/** Fresh per-process tick stats accumulator. */
export function newTickStats() {
  return {
    tickCount: 0,
    totalMs: 0,
    maxTickMs: 0,
    lastTickStartMs: null,
    lastTickEndMs: null,
    writeFailures: 0,
  };
}
