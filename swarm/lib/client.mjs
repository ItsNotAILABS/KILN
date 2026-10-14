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
import { CAP_COMMIT } from "./grant.mjs";

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
    return new this({ baseUrl: dj.apiUrl, token: readFileSync(tokPath, "utf8").trim() });
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

  // ---- repos (KILN-native git hosting) ----
  async listRepos() { return (await this._req("GET", "/git")).repos; }
  async createRepo({ owner, repo }) {
    if (!owner || !repo) throw new Error("createRepo: owner and repo are required");
    return this._req("POST", `/git/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
  }

  // ---- per-repo memory (refs/kiln/memory; see lib/memory.mjs) ----
  _memBase(owner, repo) {
    return `/git/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/memory`;
  }
  /** Store a raw episode. Returns {event, commit}. */
  async memoryRemember(owner, repo, opts) {
    return this._req("POST", `${this._memBase(owner, repo)}/episodes`, opts);
  }
  /** Assert a fact; opts.sourceEpisodes[] is mandatory provenance. Returns {event, fact, commit}. */
  async memoryFact(owner, repo, opts) {
    return this._req("POST", `${this._memBase(owner, repo)}/facts`, opts);
  }
  async memorySupersede(owner, repo, opts) {
    return this._req("POST", `${this._memBase(owner, repo)}/supersede`, opts);
  }
  async memoryLink(owner, repo, opts) {
    return this._req("POST", `${this._memBase(owner, repo)}/links`, opts);
  }
  async memorySetCore(owner, repo, opts) {
    return this._req("POST", `${this._memBase(owner, repo)}/core`, opts);
  }
  async memoryCore(owner, repo) {
    return (await this._req("GET", `${this._memBase(owner, repo)}/core`)).core;
  }
  async memoryFacts(owner, repo, { asOf, includeSuperseded } = {}) {
    const qs = new URLSearchParams();
    if (asOf) qs.set("asOf", asOf);
    if (includeSuperseded) qs.set("includeSuperseded", "1");
    const s = qs.toString();
    return (await this._req("GET", `${this._memBase(owner, repo)}/facts${s ? "?" + s : ""}`)).facts;
  }
  /** Ranked recall: {repo, query, results[]}. */
  async memoryRecall(owner, repo, q, opts = {}) {
    const qs = new URLSearchParams({ q: String(q || "") });
    if (opts.limit) qs.set("limit", String(opts.limit));
    if (opts.kinds && opts.kinds.length) qs.set("kinds", opts.kinds.join(","));
    if (opts.tags && opts.tags.length) qs.set("tags", opts.tags.join(","));
    if (opts.asOf) qs.set("asOf", opts.asOf);
    if (opts.includeSuperseded) qs.set("includeSuperseded", "1");
    return this._req("GET", `${this._memBase(owner, repo)}/recall?${qs}`);
  }
  /** Budgeted context pack: {core, facts, episodes, text, usedTokens, budgetTokens, overBudget}. */
  async memoryContext(owner, repo, { query, budgetTokens, asOf } = {}) {
    const qs = new URLSearchParams();
    if (query) qs.set("q", query);
    if (budgetTokens) qs.set("budget", String(budgetTokens));
    if (asOf) qs.set("asOf", asOf);
    const s = qs.toString();
    return this._req("GET", `${this._memBase(owner, repo)}/context${s ? "?" + s : ""}`);
  }
  async memoryStats(owner, repo) {
    return this._req("GET", `${this._memBase(owner, repo)}/stats`);
  }
  async memoryVerify(owner, repo) {
    return this._req("POST", `${this._memBase(owner, repo)}/verify`);
  }

  // ---- receipts ----
  async verifyReceipts(node) {
    return this._req("POST", "/receipts/verify", node ? { node } : {});
  }

  async health() {
    const res = await fetch(this.baseUrl + "/health");
    return res.json();
  }

  /**
   * depositCode — THE primitive for agents contributing code into KILN.
   * Spawns a fresh node with ONLY CAP_COMMIT (minimal grant), which really
   * git-clones `repo`, writes each file, and commits with `message`.
   * Returns {nodeId, nodeName, jobId, commitHash, summary, receipts}.
   *
   * The commit hash is parsed from the worker's real `git commit` output;
   * receipts are the node's own signed receipts for the deposit. If the
   * node lacked CAP_COMMIT, git.commit would be refused before running
   * and no commit would be created — depositCode never invents a hash.
   */
  async depositCode({ repo, files, message, name, ttlSec = 86400, nodeTimeoutMs = 90000 } = {}) {
    if (!repo || typeof repo !== "string") throw new Error("depositCode: repo is required (path or URL the worker clones)");
    if (!Array.isArray(files) || !files.length) throw new Error("depositCode: files[] is required");
    for (const f of files) {
      if (!f || typeof f.path !== "string" || typeof f.content !== "string") {
        throw new Error("depositCode: each file needs {path, content} strings");
      }
    }
    if (!message || !String(message).trim()) throw new Error("depositCode: message is required");

    const nodeName = name || `deposit-${Date.now().toString(36)}`;
    const { id: nodeId } = await this.spawnNode({
      name: nodeName, caps: CAP_COMMIT, ttlSec, repo, mind: "script",
    });

    // Wait for the daemon to start the worker (its next tick).
    const t0 = Date.now();
    for (;;) {
      const nodes = await this.listNodes();
      const node = nodes.find((n) => n.id === nodeId);
      if (node && (node.status === "idle" || node.status === "working")) break;
      if (Date.now() - t0 > nodeTimeoutMs) {
        throw new Error(`depositCode: node ${nodeName} never came up (status=${node ? node.status : "missing"})`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    const plan = {
      steps: [
        ...files.map((f) => ({ tool: "fs.write", args: { path: f.path, content: f.content } })),
        { tool: "git.commit", args: { message: String(message) } },
      ],
    };
    const { id: jobId } = await this.submitJob({
      name: `${nodeName}-deposit`, plan, mind: "script", node: nodeId,
    });
    const job = await this.waitForJob(jobId);
    const commitHash = parseCommitHash(job.summary);
    const receipts = await this.verifyReceipts(nodeId);
    return { nodeId, nodeName, jobId, commitHash, summary: job.summary, receipts };
  }
}

/** Pull the short hash out of `git commit` output: "[main c081437] msg". */
function parseCommitHash(summary) {
  const m = /\[.*\b([0-9a-f]{7,40})\]/.exec(String(summary || ""));
  return m ? m[1] : null;
}
