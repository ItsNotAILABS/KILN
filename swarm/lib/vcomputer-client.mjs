/**
 * VComputerClient — the agent SDK for KILN virtual computers.
 *
 *   import { VComputerClient } from "<kiln>/swarm/lib/vcomputer-client.mjs";
 *   const kiln = await VComputerClient.connect();          // KILN_SWARM_DIR or ~/.kiln-swarm
 *   const pc = await kiln.createComputer({ name: "agent-1" });
 *   const shot = await kiln.screenshot(pc.id);             // {png: Buffer, width, height}
 *   await kiln.click(pc.id, { nx: 0.5, ny: 0.1 });
 *   await kiln.type(pc.id, "hello");
 *   const r = await kiln.exec(pc.id, "git --version");     // {exitCode, stdout, stderr, timedOut}
 *   const ho = await kiln.handoff(pc.id, { reason: "Sign in to GitHub", instructions: "…" });
 *   // give ho.url to the owner, then:
 *   const done = await kiln.waitForHandBack(pc.id);        // resolves when they hand back
 *
 * Errors throw SwarmError {status, message}: 423 = the owner has the
 * screen (wait), 409 = not running, 507 = over disk quota.
 */
import { SwarmClient } from "./client.mjs";

export class VComputerClient extends SwarmClient {
  createComputer(spec) { return this._req("POST", "/v1/vcomputers", spec); }
  async listComputers() { return (await this._req("GET", "/v1/vcomputers")).computers; }
  getComputer(id) { return this._req("GET", `/v1/vcomputers/${id}`); }
  startComputer(id) { return this._req("POST", `/v1/vcomputers/${id}/start`); }
  stopComputer(id) { return this._req("POST", `/v1/vcomputers/${id}/stop`); }
  deleteComputer(id, { purge = false } = {}) { return this._req("DELETE", `/v1/vcomputers/${id}${purge ? "?purge=true" : ""}`); }
  doctor() { return this._req("GET", "/v1/vcomputers/doctor"); }

  async screenshot(id) {
    const r = await this._req("GET", `/v1/vcomputers/${id}/screenshot`);
    return { width: r.width, height: r.height, png: Buffer.from(r.png, "base64") };
  }
  input(id, action) { return this._req("POST", `/v1/vcomputers/${id}/input`, action); }
  move(id, at) { return this.input(id, { action: "move", ...at }); }
  click(id, at = {}, opts = {}) { return this.input(id, { action: "click", ...at, ...opts }); }
  type(id, text, at = {}) { return this.input(id, { action: "type", text, ...at }); }
  key(id, keys) { return this.input(id, { action: "key", keys }); }
  scroll(id, { dx, dy, ...at }) { return this.input(id, { action: "scroll", dx, dy, ...at }); }

  exec(id, command, opts = {}) { return this._req("POST", `/v1/vcomputers/${id}/exec`, { command, ...opts }); }
  startJob(id, command, opts = {}) { return this._req("POST", `/v1/vcomputers/${id}/exec`, { command, ...opts, background: true }); }
  async jobs(id) { return (await this._req("GET", `/v1/vcomputers/${id}/jobs`)).jobs; }
  job(id, jobId, { tail } = {}) { return this._req("GET", `/v1/vcomputers/${id}/jobs/${jobId}${tail !== undefined ? `?tail=${tail}` : ""}`); }
  killJob(id, jobId) { return this._req("POST", `/v1/vcomputers/${id}/jobs/${jobId}/kill`); }

  handoff(id, { reason, instructions, timeoutSec } = {}) {
    return this._req("POST", `/v1/vcomputers/${id}/handoff`, { reason, instructions, timeoutSec });
  }
  handoffStatus(id, { waitMs = 0 } = {}) { return this._req("GET", `/v1/vcomputers/${id}/handoff?waitMs=${waitMs}`); }
  cancelHandoff(id) { return this._req("DELETE", `/v1/vcomputers/${id}/handoff`); }

  /** Block until the open hand-off ends; resolves with it (state returned|cancelled|expired). */
  async waitForHandBack(id, { timeoutMs = 3600000 } = {}) {
    const t0 = Date.now();
    for (;;) {
      const r = await this.handoffStatus(id, { waitMs: Math.min(60000, Math.max(0, timeoutMs - (Date.now() - t0))) });
      if (r.control === "agent") return r.handoff;
      if (Date.now() - t0 >= timeoutMs) throw new Error(`waitForHandBack: owner still has ${id} after ${timeoutMs}ms`);
    }
  }
}
