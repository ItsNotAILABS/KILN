/**
 * coroner.mjs — the Coroner agent.
 *
 * On a NEW death, runs every plugin collector BEFORE any recovery, writes
 * the forensic bundle to <dir>/doctor/deaths/<utc-ts>.json, and appends the
 * death event to deaths.jsonl. Evidence first, restart second — always.
 *
 * Reserved collector keys it understands (see plugin.mjs):
 *   oom        {available, lines}              -> oomEvidence
 *   heartbeats [{name, workerAlive, heartbeatFresh}] -> preDeathStaleWorkers
 *   tick       {lastTickEndMs, …}              -> lastTickAgeMs
 *   memory     number (MiB)                    -> memAvailableMb
 * A throwing collector is recorded as { __collectorError } — one bad
 * collector never sinks the bundle.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ensureDoctorDir, deathsDir, journalEvent, memAvailableMb,
} from "./helpers.mjs";

export class Coroner {
  constructor({ plugin, dir }) {
    this.plugin = plugin;
    this.dir = dir;
    this.captured = 0;
  }

  async start() {}
  async stop() {}

  /**
   * Capture a forensic bundle for a dead subject. `health` is the watcher's
   * last health record ({ up: false, pid?, startedAt?, reason? }).
   * Returns the journaled death event (with bundle path filled in).
   */
  async capture(health) {
    ensureDoctorDir(this.dir);
    const deathCtx = {
      ts: new Date().toISOString(),
      pid: health.pid ?? null,
      startedAt: health.startedAt ?? null,
      reason: health.reason ?? "health check reported down",
      uptimeSec: health.startedAt
        ? Math.max(0, Math.round((Date.now() - Date.parse(health.startedAt)) / 1000))
        : null,
    };

    const out = {};
    for (const [name, fn] of Object.entries(this.plugin.collectors || {})) {
      try {
        out[name] = await fn(this.dir, deathCtx);
      } catch (e) {
        out[name] = { __collectorError: String((e && e.message) || e) };
      }
    }

    const oom = out.oom;
    const oomEvidence = !!(oom && oom.available && Array.isArray(oom.lines) && oom.lines.length > 0);
    const hb = Array.isArray(out.heartbeats) ? out.heartbeats : [];
    const preDeathStaleWorkers = hb
      .filter((n) => n && n.workerAlive && !n.heartbeatFresh)
      .map((n) => n.name)
      .filter(Boolean);
    const tick = out.tick && typeof out.tick === "object" ? out.tick : null;
    const lastTickEndMs = tick ? tick.lastTickEndMs : null;
    const lastTickAgeMs = Number.isFinite(lastTickEndMs) ? Date.now() - lastTickEndMs : null;
    const memAvailable = Number.isFinite(out.memory) ? out.memory : memAvailableMb();

    const death = {
      ts: deathCtx.ts,
      type: "death",
      pid: deathCtx.pid,
      startedAt: deathCtx.startedAt,
      reason: deathCtx.reason,
      uptimeSec: deathCtx.uptimeSec,
      memAvailableMb: memAvailable,
      preDeathStaleWorkers,
      oomEvidence,
      lastTickAgeMs,
      bundle: null, // filled in after the bundle file is written
    };

    const bundle = {
      capturedAt: new Date().toISOString(),
      death: { ...death },
      oomEvidence,
      preDeathStaleWorkers,
      lastTickAgeMs,
      ...out,
    };
    const fname = death.ts.replace(/[:.]/g, "-") + ".json";
    const path = join(deathsDir(this.dir), fname);
    death.bundle = path;
    bundle.death.bundle = path;
    writeFileSync(path, JSON.stringify(bundle, null, 2) + "\n");

    journalEvent(this.dir, death);
    this.captured += 1;
    return death;
  }

  status() {
    return { running: true, captured: this.captured };
  }
}
