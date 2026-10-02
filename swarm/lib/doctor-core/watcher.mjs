/**
 * watcher.mjs — the Watcher agent.
 *
 * Probes plugin.healthCheck on the supervisor's poll interval, tracks
 * consecutive failures, and keeps the last health record. The probe result
 * IS the unhealthy event the supervisor acts on: { up: false, reason, … }.
 *
 * A throwing or misshapen healthCheck is an agent failure — it propagates so
 * the supervisor can restart the watcher rather than misread a dead subject.
 */
import { validateHealth } from "./plugin.mjs";

export class Watcher {
  constructor({ plugin, dir }) {
    this.plugin = plugin;
    this.dir = dir;
    this.checks = 0;
    this.consecutiveFailures = 0;
    this.lastHealth = null;
  }

  async start() { /* nothing to open; the supervisor drives probe() */ }
  async stop() { /* nothing to close */ }

  /** One honest probe. Resets the failure streak when the subject is up. */
  async probe() {
    const h = await this.plugin.healthCheck(this.dir);
    const v = validateHealth(h);
    this.checks += 1;
    this.lastHealth = v;
    if (v.up) this.consecutiveFailures = 0;
    else this.consecutiveFailures += 1;
    return v;
  }

  status() {
    return {
      running: true,
      checks: this.checks,
      consecutiveFailures: this.consecutiveFailures,
      lastHealth: this.lastHealth,
      pollMs: this.plugin.pollMs ?? 15000,
    };
  }
}
