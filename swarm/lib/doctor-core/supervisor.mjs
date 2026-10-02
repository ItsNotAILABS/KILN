/**
 * supervisor.mjs — the Doctor core.
 *
 * Owns the poll loop and the tick lock (serializing the loop tick vs an
 * inline `check` tick, with stale-lock reclaim). Each tick runs
 * watcher → (on a NEW death) coroner → medic → verify.
 *
 * It also supervises the four agents: every agent method runs inside
 * try/catch with a per-agent error count. On failure the agent is
 * re-instantiated and the call retried once; after MAX_AGENT_RESTARTS (5)
 * the agent is retired LOUDLY (dlog + state.json) while the loop itself
 * stays alive — a broken forensics collector must never stop recovery.
 *
 * Public surface used by the CLI:
 *   start()   daemonize the loop (pidfile + exclusive lock)
 *   stop()    SIGTERM the loop
 *   alive()   pid + cmdline verification (pid-reuse safe)
 *   check()   ensure-alive + one inline tick + new-events report
 *   status()  doctor alive? subject health? death count
 *   report()  journal summary (last 5 deaths) + current diagnosis
 *   tick()    one supervision pass
 *   run()     the detached poll loop (the `_run` child)
 */
import { spawn } from "node:child_process";
import { openSync, closeSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DOCTOR_POLL_MS,
  ensureDoctorDir, dlog, sleep,
  readDoctorJson, readDoctorState, writeDoctorState,
  doctorJsonPath, doctorLockPath,
  acquireExclusive, acquireTickLock, releaseTickLock,
  journalSince, readJournal, pidAlive,
} from "./helpers.mjs";
import { validatePlugin } from "./plugin.mjs";
import { Watcher } from "./watcher.mjs";
import { Coroner } from "./coroner.mjs";
import { Detective } from "./detective.mjs";
import { Medic } from "./medic.mjs";

export const MAX_AGENT_RESTARTS = 5;

const BIN_PATH = fileURLToPath(new URL("../bin/doctor.js", import.meta.url));

export class Supervisor {
  constructor({ plugin, dir, configPath }) {
    this.plugin = validatePlugin(plugin);
    this.dir = dir || plugin.dir;
    if (!this.dir || typeof this.dir !== "string") {
      throw new Error("doctor: no state dir — pass --dir or set plugin.dir");
    }
    this.configPath = configPath || null;
    this.stopping = false;
    this.agentErrors = {};
    this.agentDead = {};
    this.agentFactories = {
      watcher: () => new Watcher({ plugin: this.plugin, dir: this.dir }),
      coroner: () => new Coroner({ plugin: this.plugin, dir: this.dir }),
      detective: () => new Detective({ dir: this.dir }),
      medic: () => new Medic({ plugin: this.plugin, dir: this.dir }),
    };
    this.agents = {};
    for (const [name, factory] of Object.entries(this.agentFactories)) {
      this.agents[name] = factory();
    }
  }

  log(...a) { dlog(this.dir, ...a); }

  get subject() { return this.plugin.subject; }

  get logHint() {
    return this.plugin.logHint || join(this.dir, `${this.plugin.subject}.log`);
  }

  persistAgentState() {
    const st = readDoctorState(this.dir);
    writeDoctorState(this.dir, { ...st, agentErrors: this.agentErrors, agentDead: this.agentDead });
  }

  /**
   * Run one agent method under supervision. Returns null when the agent is
   * retired or the call failed twice in a row — the loop survives either way.
   */
  async callAgent(name, method, ...args) {
    if (this.agentDead[name]) {
      this.log(`doctor: agent ${name} is retired after ${MAX_AGENT_RESTARTS} failures — skipping, loop stays alive`);
      return null;
    }
    try {
      return await this.agents[name][method](...args);
    } catch (e) {
      this.agentErrors[name] = (this.agentErrors[name] || 0) + 1;
      const n = this.agentErrors[name];
      this.log(`doctor: agent ${name}.${method} failed (${(e && e.message) || e}) — restarting agent (${n}/${MAX_AGENT_RESTARTS})`);
      if (n > MAX_AGENT_RESTARTS) {
        this.agentDead[name] = true;
        this.log(`doctor: AGENT DOWN: ${name} failed ${n} times — retired loudly, but the loop stays alive`);
        this.persistAgentState();
        return null;
      }
      this.persistAgentState();
      this.agents[name] = this.agentFactories[name]();
      try {
        return await this.agents[name][method](...args);
      } catch (e2) {
        this.agentErrors[name] = (this.agentErrors[name] || 0) + 1;
        this.log(`doctor: agent ${name}.${method} failed again after restart (${(e2 && e2.message) || e2})`);
        this.persistAgentState();
        return null;
      }
    }
  }

  // ------------------------------------------------------------ own lifecycle

  /** True if pid is a live doctor loop for this state dir (pid-reuse safe). */
  pidIsDoctor(pid) {
    if (!pidAlive(pid)) return false;
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
      if (!cmd.includes("doctor.js") || !cmd.includes("_run")) return false;
      try {
        const env = readFileSync(`/proc/${pid}/environ`, "utf8");
        if (!env.includes(`DOCTOR_DIR=${this.dir}\0`)) return false;
      } catch { /* environ unreadable — cmdline match is enough */ }
      return true;
    } catch {
      return pidAlive(pid); // /proc unavailable: fall back
    }
  }

  alive() {
    const d = readDoctorJson(this.dir);
    return !!(d && d.pid && this.pidIsDoctor(d.pid));
  }

  /** Daemonize the poll loop. No-op (returns {already:true}) when running. */
  start() {
    ensureDoctorDir(this.dir);
    if (this.alive()) {
      const d = readDoctorJson(this.dir);
      return { already: true, pid: d.pid };
    }
    // Reclaim a stale lock left by a crashed loop.
    if (!acquireExclusive(doctorLockPath(this.dir))) {
      try { unlinkSync(doctorLockPath(this.dir)); } catch { /* best effort */ }
      if (!acquireExclusive(doctorLockPath(this.dir))) {
        throw new Error("doctor: could not acquire doctor.lock");
      }
      this.log("reclaimed stale doctor lock");
    }
    if (!this.configPath) {
      try { unlinkSync(doctorLockPath(this.dir)); } catch { /* best effort */ }
      throw new Error("doctor: start needs the plugin config path (Supervisor configPath)");
    }
    const out = openSync(join(this.dir, "doctor", "doctor.log"), "a");
    const child = spawn(process.execPath, [BIN_PATH, "_run", "--dir", this.dir, "--config", this.configPath], {
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env, DOCTOR_DIR: this.dir },
    });
    child.unref();
    closeSync(out);
    writeFileSync(doctorJsonPath(this.dir), JSON.stringify({
      pid: child.pid,
      startedAt: new Date().toISOString(),
    }) + "\n");
    this.log(`doctor started pid=${child.pid}`);
    return { already: false, pid: child.pid };
  }

  stop() {
    const d = readDoctorJson(this.dir);
    if (!d || !d.pid || !this.pidIsDoctor(d.pid)) {
      return { stopped: false, reason: "doctor not running" };
    }
    try { process.kill(d.pid, "SIGTERM"); } catch { /* already gone */ }
    try { unlinkSync(doctorLockPath(this.dir)); } catch { /* the loop removes it on exit */ }
    this.log(`doctor stop signaled pid=${d.pid}`);
    return { stopped: true, pid: d.pid };
  }

  // ------------------------------------------------------------------ the tick

  /**
   * One supervision pass: probe health; on a NEW death, forensics BEFORE
   * recovery, then verify. Returns a result object (or { skipped: true }
   * when another tick holds the lock).
   */
  async tick({ inline = false } = {}) {
    ensureDoctorDir(this.dir);
    if (!acquireTickLock(this.dir)) {
      // Another tick (loop or check) is already handling this — skip quietly.
      return { skipped: true };
    }
    try {
      const st = await this.callAgent("watcher", "probe");
      if (!st) {
        this.log("doctor: tick skipped — watcher agent unavailable");
        return { error: true, reason: "watcher unavailable" };
      }
      const dstate = readDoctorState(this.dir);
      if (st.up) {
        writeDoctorState(this.dir, { ...dstate, lastHealthyTs: Date.now() });
        return { healthy: true, pid: st.pid };
      }
      const deathId = `${st.pid ?? "none"}|${st.startedAt ?? "none"}`;
      if (dstate.lastHandledDeathId === deathId) {
        // Same dead instance we already handled — don't re-capture or spin.
        return { healthy: false, alreadyHandled: true, reason: st.reason };
      }
      // NEW death: the coroner captures forensics BEFORE any recovery.
      const death = await this.callAgent("coroner", "capture", st);
      if (death) this.log(`${this.subject} death recorded: ${st.reason} (bundle ${death.bundle})`);
      else this.log(`${this.subject} death detected but coroner unavailable — recovering anyway`);

      // The medic recovers (lock courtesy → recover → verify).
      const rec = await this.callAgent("medic", "recover", death);
      const ok = !!(rec && rec.ok);
      writeDoctorState(this.dir, { ...dstate, lastHandledDeathId: deathId, lastRecoveryAttemptTs: Date.now() });
      this.log(`recovery: ${ok ? `ok pid=${rec.pid}` : `FAILED (${rec ? rec.reason : "medic unavailable"})`} crashLoop=${!!(rec && rec.crashLoop)}`);
      return {
        healthy: ok,
        death: death || null,
        recovered: ok,
        pid: rec ? rec.pid ?? null : null,
        reason: ok ? null : (rec ? rec.reason : "medic unavailable"),
        crashLoop: !!(rec && rec.crashLoop),
      };
    } finally {
      releaseTickLock(this.dir);
    }
  }

  // ----------------------------------------------------------------- commands

  /**
   * The cron entry point. Ensures the doctor is alive, runs one inline tick
   * (serialized against the loop's tick), then reports what's new since the
   * last check: deaths, recoveries, and any NEW diagnosis.
   *
   * Silent (exit 0, no lines) when healthy and nothing new. Exit 1 when the
   * subject is still DOWN or a crash loop was reported.
   */
  async check() {
    ensureDoctorDir(this.dir);
    const lines = [];
    const dstate = readDoctorState(this.dir);
    if (!this.alive()) {
      const r = this.start();
      lines.push(`doctor: was down, started pid=${r.pid}`);
    }
    const tickRes = await this.tick({ inline: true });

    const since = dstate.lastCheckTs || 0;
    const newEvents = journalSince(this.dir, since);
    const dstate2 = { ...readDoctorState(this.dir), lastCheckTs: Date.now() };
    let sawCrashLoop = false;
    for (const e of newEvents) {
      if (e.type === "death") {
        lines.push(`doctor: ${this.subject} death recorded at ${e.ts} (${e.reason})`);
      } else if (e.type === "recovery") {
        lines.push(`doctor: recovery ${e.ok ? "ok" : "FAILED"} at ${e.ts} via ${e.method || "?"}` +
          (e.ok && e.pid ? ` pid=${e.pid}` : ""));
        if (e.watchdogCrashLoop || e.crashLoop) sawCrashLoop = true;
      }
    }
    if (tickRes && tickRes.crashLoop) sawCrashLoop = true;

    const dg = await this.callAgent("detective", "diagnose");
    if (dg && dg.verdict === "hypothesis" && dg.hypothesis !== dstate2.lastHypothesisNotified) {
      lines.push(`doctor: NEW DIAGNOSIS: ${dg.hypothesis}`);
      dstate2.lastHypothesisNotified = dg.hypothesis;
    }
    writeDoctorState(this.dir, dstate2);

    let exitCode = 0;
    // Final honest verification, whatever path handled the recovery.
    let st = await this.callAgent("watcher", "probe");
    if ((!st || !st.up) && tickRes && tickRes.skipped) {
      // The loop is mid-tick — give it a beat before judging.
      await sleep(15000);
      st = await this.callAgent("watcher", "probe");
    }
    if (sawCrashLoop) {
      lines.push(`doctor: crash-loop warning — the ${this.subject} keeps dying, investigate ${this.logHint} manually`);
      exitCode = 1;
    } else if (!st || !st.up) {
      lines.push(`doctor: ${this.subject} still DOWN after recovery attempt (${st ? st.reason : "watcher unavailable"})`);
      exitCode = 1;
    }
    return { lines, exitCode };
  }

  /** Doctor alive? Subject health? Death count + last death. Exit 1 when down. */
  async status() {
    const lines = [];
    const d = readDoctorJson(this.dir);
    const alive = this.alive();
    lines.push(alive
      ? `doctor: alive (pid=${d.pid}, since ${d.startedAt})`
      : "doctor: down");
    const h = await this.callAgent("watcher", "probe");
    if (h) {
      lines.push(h.up
        ? `doctor: ${this.subject} health: UP${h.pid ? ` (pid=${h.pid})` : ""}`
        : `doctor: ${this.subject} health: DOWN (${h.reason})`);
    } else {
      lines.push(`doctor: ${this.subject} health: unknown (watcher unavailable)`);
    }
    const deaths = readJournal(this.dir).filter((e) => e.type === "death");
    const last = deaths[deaths.length - 1];
    lines.push(`doctor: deaths recorded: ${deaths.length}${last ? ` (last ${last.ts})` : ""}`);
    const errs = Object.entries(this.agentErrors).filter(([, n]) => n > 0);
    if (errs.length) {
      lines.push(`doctor: agent errors: ${errs.map(([n, c]) => `${n}=${c}${this.agentDead[n] ? " (retired)" : ""}`).join(", ")}`);
    }
    return { lines, exitCode: alive ? 0 : 1 };
  }

  /** Journal summary (last 5 deaths) + current diagnosis. */
  async report() {
    const lines = [`doctor: report for ${this.subject} (${this.dir})`];
    const deaths = readJournal(this.dir).filter((e) => e.type === "death").slice(-5);
    lines.push(`doctor: last ${deaths.length} recorded death(s):`);
    for (const e of deaths) {
      const stale = (e.preDeathStaleWorkers || []).join(",");
      lines.push(`  - ${e.ts} pid=${e.pid ?? "?"} uptime=${e.uptimeSec ?? "?"}s mem=${e.memAvailableMb ?? "?"}MB stale=[${stale}] oom=${!!e.oomEvidence} — ${e.reason}`);
    }
    const dg = await this.callAgent("detective", "diagnose");
    lines.push(`doctor: diagnosis: ${dg ? dg.verdict : "unavailable (detective down)"}`);
    if (dg) lines.push(`doctor: ${dg.hypothesis}`);
    return lines;
  }

  /** The detached poll loop. Logs loudly on fatal errors but stays alive. */
  async run() {
    ensureDoctorDir(this.dir);
    this.log(`doctor loop starting pid=${process.pid} dir=${this.dir} subject=${this.subject}`);
    let timer;
    const onStop = () => {
      if (this.stopping) return;
      this.stopping = true;
      this.log("doctor loop stopping");
      clearInterval(timer);
      try { unlinkSync(doctorLockPath(this.dir)); } catch { /* best effort */ }
      process.exit(0);
    };
    process.on("SIGTERM", onStop);
    process.on("SIGINT", onStop);
    process.on("uncaughtException", (err) => {
      try { this.log(`FATAL uncaughtException (staying alive): ${err && err.stack ? err.stack : err}`); } catch { /* ignore */ }
    });
    process.on("unhandledRejection", (reason) => {
      try { this.log(`FATAL unhandledRejection (staying alive): ${reason && reason.stack ? reason.stack : reason}`); } catch { /* ignore */ }
    });
    const pollMs = this.plugin.pollMs ?? DOCTOR_POLL_MS;
    timer = setInterval(async () => {
      if (this.stopping) return;
      try { await this.tick(); } catch (e) { this.log(`tick error: ${e.message}`); }
    }, pollMs);
    try { await this.tick(); } catch (e) { this.log(`tick error: ${e.message}`); }
  }
}
