/**
 * ComputeClient — use KILN as serverless compute from any repo.
 * Zero dependencies (global fetch only). Extends SwarmClient with the
 * /v1/compute surface: functions, parallel map, and app hosting.
 *
 *   import { ComputeClient } from "<kiln>/swarm/lib/compute-client.mjs";
 *   const kiln = await ComputeClient.connect(); // KILN_SWARM_DIR or ~/.kiln-swarm
 *
 *   // 1. Run a function (sync — blocks until done, up to waitMs)
 *   const r = await kiln.invoke({
 *     code: `export async function main(args) { return args.x * 2; }`,
 *     args: { x: 21 },
 *     waitMs: 60000,
 *   });
 *   console.log(r.result); // 42
 *
 *   // 2. Fan out over items (the supercomputer bit)
 *   const m = await kiln.map({
 *     code: `export async function main(n) { return n * n; }`,
 *     items: [1, 2, 3, 4],
 *   });
 *   const done = await kiln.waitMap(m.mapId);
 *   console.log(done.results.map((x) => x.result));
 *
 *   // 3. Pop an app: deploy a repo as a persistent supervised service
 *   const app = await kiln.deployApp({
 *     name: "my-api", repo: "http://127.0.0.1:18787/git/auro/my-api",
 *     command: "node", args: ["server.mjs"], port: 8901,
 *   });
 *
 * Auth: same Bearer <api.token> as SwarmClient. The daemon API binds
 * 127.0.0.1 only — this client never talks to a remote host.
 */
import { SwarmClient } from "./client.mjs";

export class ComputeClient extends SwarmClient {
  /**
   * Run a JS function on the swarm. code must export main(args).
   * Without waitMs: returns {invocationId, jobId, status:"pending"} (201).
   * With waitMs: blocks until done/failed or the wait elapses, then returns
   * the full invocation view {status, ok, result, error, logs, durationMs}.
   */
  async invoke({ code, args, timeoutMs, name, waitMs } = {}) {
    if (typeof code !== "string" || !code.trim()) throw new Error("invoke: code is required");
    return this._req("POST", "/v1/compute/invoke", { code, args, timeoutMs, name, waitMs });
  }

  /** Fetch one invocation's current view (status + result when done). */
  async invocation(invocationId) {
    return this._req("GET", `/v1/compute/invocations/${invocationId}`);
  }

  /**
   * Poll until the invocation is done or failed. Resolves with the view;
   * THROWS on failed (error includes the function's error) or on timeout.
   */
  async waitInvocation(invocationId, { timeoutMs = 120000, pollMs = 1000 } = {}) {
    const t0 = Date.now();
    for (;;) {
      const v = await this.invocation(invocationId);
      if (v.status === "done") {
        if (v.ok === false) {
          const e = new Error(`invocation ${invocationId} failed: ${v.error || "unknown"}`);
          e.invocation = v;
          throw e;
        }
        return v;
      }
      if (v.status === "failed") {
        const e = new Error(`invocation ${invocationId} failed: ${v.error || "unknown"}`);
        e.invocation = v;
        throw e;
      }
      if (Date.now() - t0 > timeoutMs) {
        throw new Error(`waitInvocation: timed out after ${timeoutMs}ms waiting for ${invocationId}`);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  /**
   * Fan `code` out over `items` — one job per item, spread across workers.
   * Returns {mapId, invocationIds, count}.
   */
  async map({ code, items, timeoutMs, name } = {}) {
    if (typeof code !== "string" || !code.trim()) throw new Error("map: code is required");
    if (!Array.isArray(items) || !items.length) throw new Error("map: items[] is required");
    return this._req("POST", "/v1/compute/map", { code, items, timeoutMs, name });
  }

  /** Current aggregate view of a map: counts + per-item results. */
  async mapStatus(mapId) {
    return this._req("GET", `/v1/compute/map/${mapId}`);
  }

  /**
   * Poll until every item in the map is done/failed. Resolves with the
   * aggregate view. THROWS if any item failed or on timeout.
   */
  async waitMap(mapId, { timeoutMs = 300000, pollMs = 1500 } = {}) {
    const t0 = Date.now();
    for (;;) {
      const m = await this.mapStatus(mapId);
      const pending = (m.counts.pending || 0) + (m.counts.assigned || 0) + (m.counts.unknown || 0);
      if (pending === 0) {
        const failed = m.results.filter((r) => r.status === "failed" || r.ok === false);
        if (failed.length) {
          const e = new Error(`map ${mapId}: ${failed.length}/${m.results.length} items failed`);
          e.map = m;
          throw e;
        }
        return m;
      }
      if (Date.now() - t0 > timeoutMs) throw new Error(`waitMap: timed out after ${timeoutMs}ms waiting for ${mapId}`);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  /**
   * Deploy a repo as a persistent supervised service. The worker boots
   * `command` on (re)start and restarts it on crash; logs stream to app.log.
   * Returns {appId, name, status}.
   */
  async deployApp({ name, repo, command, args, env, port } = {}) {
    if (!name || !repo || !command) throw new Error("deployApp: name, repo, command are required");
    return this._req("POST", "/v1/compute/apps", { name, repo, command, args, env, port });
  }

  async listApps() {
    return (await this._req("GET", "/v1/compute/apps")).apps;
  }

  async appLogs(appId, { tail = 100 } = {}) {
    return this._req("GET", `/v1/compute/apps/${appId}/logs?tail=${tail}`);
  }

  /** Stop an app for good: worker SIGTERMed (kills the app child), never respawned. */
  async undeployApp(appId) {
    return this._req("DELETE", `/v1/compute/apps/${appId}`);
  }
}
