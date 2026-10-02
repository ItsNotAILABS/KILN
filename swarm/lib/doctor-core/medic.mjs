/**
 * medic.mjs — the Medic agent.
 *
 * Recovery with manners:
 *   1. Lock courtesy — if plugin.lockProbe says a LIVE subject holds the
 *      lock, the health probe may have raced a slow tick: wait
 *      courtesyWaitMs, re-probe, and stand down (journaled, no restart) when
 *      the subject is actually up.
 *   2. plugin.recover(dir) — the plugin's own restart path.
 *   3. Verify with a fresh healthCheck after verifyWaitMs. The journaled
 *      `ok` is the VERIFICATION result; the plugin's own ok is kept as
 *      `recoverOk`, and any extra fields it returned (crashLoop,
 *      watchdogExit, detail, …) pass through to the journal untouched.
 */
import { ensureDoctorDir, journalEvent, sleep } from "./helpers.mjs";
import { validateHealth } from "./plugin.mjs";

export class Medic {
  constructor({ plugin, dir }) {
    this.plugin = plugin;
    this.dir = dir;
    this.recoveries = 0;
  }

  async start() {}
  async stop() {}

  /** Health probe that never throws — a broken probe reads as "down". */
  async safeHealth() {
    try {
      return validateHealth(await this.plugin.healthCheck(this.dir));
    } catch (e) {
      return { up: false, reason: `healthCheck threw: ${(e && e.message) || e}` };
    }
  }

  /**
   * Recover the subject. `death` is the coroner's death event (may be null
   * when the coroner agent was unavailable — recovery still matters more).
   * Returns { ok, pid, method, reason, crashLoop }.
   */
  async recover(death) {
    ensureDoctorDir(this.dir);
    const plugin = this.plugin;

    // 1. Lock courtesy: never force a restart on a live subject.
    if (typeof plugin.lockProbe === "function") {
      let lk = null;
      try { lk = await plugin.lockProbe(this.dir); } catch { lk = null; }
      if (lk && lk.held && lk.live) {
        await sleep(plugin.courtesyWaitMs ?? 10000);
        const st2 = await this.safeHealth();
        if (st2.up) {
          journalEvent(this.dir, {
            ts: new Date().toISOString(),
            type: "recovery",
            ok: true,
            pid: st2.pid ?? null,
            method: "lock-reprobe",
            note: "subject alive after re-probe; no restart needed",
          });
          return { ok: true, pid: st2.pid ?? null, method: "lock-reprobe", reason: null, crashLoop: false };
        }
      }
    }

    // 2. The plugin's own recovery path.
    let res;
    try {
      res = await plugin.recover(this.dir);
    } catch (e) {
      res = { ok: false, method: "recover", detail: `recover() threw: ${(e && e.message) || e}` };
    }
    if (!res || typeof res !== "object") {
      res = { ok: false, method: "recover", detail: "recover() returned nothing usable" };
    }

    // 3. Let it settle, then verify honestly.
    await sleep(plugin.verifyWaitMs ?? 4000);
    const st3 = await this.safeHealth();
    const ok = st3.up === true;
    const method = res.method || "recover";
    const { ok: _ok, method: _method, pid: _pid, ...rest } = res;
    journalEvent(this.dir, {
      ts: new Date().toISOString(),
      type: "recovery",
      ok,
      pid: st3.pid ?? res.pid ?? null,
      method,
      recoverOk: !!res.ok,
      ...rest,
    });
    this.recoveries += 1;
    return {
      ok,
      pid: st3.pid ?? res.pid ?? null,
      method,
      reason: ok ? null : (st3.reason || "recovery completed but subject still down"),
      crashLoop: !!res.crashLoop,
    };
  }

  status() {
    return { running: true, recoveries: this.recoveries };
  }
}
