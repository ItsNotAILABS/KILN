/**
 * SwarmClient — use the KILN swarm AS A FEATURE from any project.
 * Plain .mjs, zero dependencies (global fetch only).
 *
 *   import { SwarmClient } from "<kiln>/swarm/lib/client.mjs";
 *   const swarm = await SwarmClient.connect({ dir: process.env.KILN_SWARM_DIR });
 *   const { id } = await swarm.submitJob({ name: "nightly", plan: { steps: [...] } });
 *   const job = await swarm.waitForJob(id, { timeoutMs: 120000 });
 *
 * Auth: bearer token read from <stateDir>/api.token (0600). The daemon API
 * binds 127.0.0.1 only — this client never talks to a remote host.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export class SwarmError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class SwarmClient {
  constructor({ baseUrl, token }) {
    if (!baseUrl) throw new Error("SwarmClient: baseUrl is required");
    if (!token) throw new Error("SwarmClient: token is required");
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
  }

  /**
   * Connect via a state dir: reads daemon.json (api port) + api.token.
   * Throws loudly if the daemon isn't running — never guesses.
   */
  static async connect({ dir } = {}) {
    const d = dir || process.env.KILN_SWARM_DIR || join(homedir(), ".kiln-swarm");
    const djPath = join(d, "daemon.json");
    if (!existsSync(djPath)) throw new Error(`SwarmClient: no daemon.json in ${d} — is the daemon running?`);
    const dj = JSON.parse(readFileSync(djPath, "utf8"));
    if (!dj.apiUrl) throw new Error("SwarmClient: daemon.json has no apiUrl — daemon predates the HTTP API; restart it");
    let alive = false;
    try { process.kill(dj.pid, 0); alive = true; } catch { alive = false; }
    if (!alive) throw new Error(`SwarmClient: daemon pid ${dj.pid} is not alive — stale daemon.json`);
    const tokPath = join(d, "api.token");
    if (!existsSync(tokPath)) throw new Error(`SwarmClient: no api.token in ${d}`);
    return new SwarmClient({ baseUrl: dj.apiUrl, token: readFileSync(tokPath, "utf8").trim() });
  }

  async _req(method, path, body) {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = {};
    try { data = await res.json(); } catch { /* keep {} */ }
    if (!res.ok) throw new SwarmError(res.status, data.error || `HTTP ${res.status}`);
    return data;
  }

  // ---- jobs ----
  async submitJob({ name, plan, mind, node, repo }) {
    if (!plan || !Array.isArray(plan.steps)) throw new Error("submitJob: plan.steps[] is required");
    return this._req("POST", "/jobs", { name, plan, mind, node, repo });
  }
  async listJobs() { return (await this._req("GET", "/jobs")).jobs; }
  async getJob(id) { return (await this._req("GET", `/jobs/${id}`)).job; }

  /**
   * Poll until the job is done or failed. Resolves with the job on done;
   * THROWS on failed (error includes job.error) or on timeout — never
   * returns a maybe.
   */
  async waitForJob(id, { timeoutMs = 120000, pollMs = 1000 } = {}) {
    const t0 = Date.now();
    for (;;) {
      const job = await this.getJob(id);
      if (job.status === "done") return job;
      if (job.status === "failed") {
        const e = new Error(`job ${id} failed: ${job.error || "unknown"}`);
        e.job = job;
        throw e;
      }
      if (Date.now() - t0 > timeoutMs) throw new Error(`waitForJob: timed out after ${timeoutMs}ms waiting for ${id}`);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  // ---- nodes ----
  async spawnNode({ name, caps, ttlSec, repo, mind, policy, maxRestarts }) {
    if (!name) throw new Error("spawnNode: name is required");
    return this._req("POST", "/nodes", { name, caps, ttlSec, repo, mind, policy, maxRestarts });
  }
  async listNodes() { return (await this._req("GET", "/nodes")).nodes; }
  async stopNode(id) { return this._req("POST", `/nodes/${id}/stop`); }
  async nodeLogs(id, { tail = 50, stream = "stdout" } = {}) {
    return this._req("GET", `/nodes/${id}/logs?tail=${tail}&stream=${stream}`);
  }

  // ---- receipts ----
  async verifyReceipts(node) {
    return this._req("POST", "/receipts/verify", node ? { node } : {});
  }

  async health() {
    const res = await fetch(this.baseUrl + "/health");
    return res.json();
  }
}
