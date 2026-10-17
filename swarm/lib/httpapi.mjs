/**
 * Local HTTP API for the swarm daemon — so anything built in the forge
 * (a model service, a protocol daemon, an AI agent) can use the swarm
 * as a feature, not just the CLI.
 *
 *  - Binds 127.0.0.1 ONLY. Never 0.0.0.0.
 *  - Bearer token from <stateDir>/api.token (0600). Compared with
 *    timingSafeEqual. GET /health is the only unauthenticated route.
 *  - Port: config.apiPort, KILN_SWARM_API_PORT wins, 0 = ephemeral.
 *
 * Routes:
 *   GET  /health
 *   POST /jobs                      {name, plan{steps[]}, mind?, node?, repo?} -> {id}
 *   GET  /jobs                      -> {jobs:[...]}
 *   GET  /jobs/:id                  -> {job} | 404
 *   POST /nodes                     {name, caps, ttlSec, repo?, mind?, policy?} -> {id,name}
 *   GET  /nodes                     -> {nodes:[...]}
 *   POST /nodes/:id/stop            -> {ok:true}
 *   GET  /nodes/:id/logs?tail=N&stream=stdout|stderr -> {stream, log}
 *   POST /receipts/verify           {node?} -> {results:[...]}
 * Compute — serverless functions, parallel map, app hosting:
 *   POST /v1/compute/invoke         {name?, code, args?, timeoutMs?, waitMs?}
 *                                     waitMs omitted -> 201 {invocationId, jobId, status}
 *                                     waitMs set     -> 200 full result (blocks)
 *   GET  /v1/compute/invocations/:id -> {invocationId, status, ok?, result?, error?, logs?}
 *   POST /v1/compute/map            {name?, code, items[], timeoutMs?} -> {mapId, invocationIds}
 *   GET  /v1/compute/map/:mapId      -> {mapId, counts, results[]}
 *   POST /v1/compute/apps           {name, repo, command, args?, env?, port?, public?} -> {appId, name}
 *   GET  /v1/compute/apps           -> {apps:[...]} (each with previewUrl + preview)
 *   GET  /v1/compute/apps/:id       -> {app, previewUrl, preview}
 *   POST /v1/compute/apps/:id/preview   -> enable public preview (503 when no relay configured)
 *   DELETE /v1/compute/apps/:id/preview -> disable public preview
 *   GET  /v1/compute/apps/:id/logs?tail=N -> {appId, log}
 *   DELETE /v1/compute/apps/:id     -> {ok:true}
 * Git hosting (KILN-native repos, served via git http-backend CGI):
 *   POST /git/:owner/:repo            create repo (auth required)
 *   GET  /git                         list repos (public)
 *   GET  /git/:owner/:repo/info/refs?service=...   (public)
 *   POST /git/:owner/:repo/git-upload-pack          (public — clone/fetch)
 *   POST /git/:owner/:repo/git-receive-pack         (auth required — push)
 * Promotion (KILN-native repos -> GitHub, Git Data API rebuild):
 *   POST /v1/promote                {repo:"owner/repo", github?:"owner/repo",
 *                                    branch?, rebase?, force?} -> receipt
 * Per-repo memory (auth required; memory lives on refs/kiln/memory):
 *   POST /git/:owner/:repo/memory/episodes   {content, title?, tags?, …} -> {event}
 *   POST /git/:owner/:repo/memory/facts      {subject, predicate, object, sourceEpisodes[]} -> {fact}
 *   POST /git/:owner/:repo/memory/supersede  {fact, reason?}
 *   POST /git/:owner/:repo/memory/links      {from, to, relation}
 *   POST /git/:owner/:repo/memory/core       {label, value, description?}
 *   GET  /git/:owner/:repo/memory/core|facts|recall|context|stats
 *   POST /git/:owner/:repo/memory/verify     -> {ok, events, commits}
 */
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import {
  listNodeIds, loadNode, saveNode, resolveNode, pidAlive,
  heartbeatAgeMs, nodeDir, loadApiToken,
} from "./state.mjs";
import { appendEvent, replay, newJobId } from "./queue.mjs";
import { createNode } from "./nodes.mjs";
import { parseCaps, capsToNames, nowSec } from "./grant.mjs";
import { verifyReceipts } from "./receipts.mjs";
import { loadKeypair } from "./keys.mjs";
import { loadKeyFile } from "./state.mjs";
import { createRepo, listRepos, repoExists, serveGitHttp, validRepoName } from "./git.mjs";
import { promoteRepo } from "./promote.mjs";
import { buildContextIndex, loadIndex, queryContextIndex } from "./context-index.mjs";
import { appendContextReceipt, verifyContextReceipts } from "./context-receipts.mjs";
import { boundContextRequest, contextLimits } from "./context-policy.mjs";
import { recordContextMetric, loadContextMetrics, contextMetricsSummary } from "./context-metrics.mjs";
import {
  remember, assertFact, supersedeFact, linkMemories, setCore,
  loadMemory, factsAt, recall, buildContext, memoryStats, verifyMemory, agentAwareness,
} from "./memory.mjs";
import {
  snapshotRefs, loadRepoConfig, enqueueCiJob, readResult, readLatest,
} from "./ci.mjs";
import {
  ComputeError, submitInvocation, getInvocation, waitInvocation,
  submitMap, getMap, deployApp, listApps, appStatus, appLogs, undeployApp,
  getCapacity,
} from "./compute.mjs";
import {
  withPreview, enablePreview, disablePreview, teardownPreview,
  startPreviewReconciler,
} from "./preview.mjs";

const MAX_BODY = 1024 * 1024;

function contextIndexDir(dir) {
  const p = join(dir, "context-indexes");
  mkdirSync(p, { recursive: true, mode: 0o700 });
  return p;
}

function resolveContextNode(dir, raw) {
  const id = resolveNode(dir, String(raw));
  const node = loadNode(dir, id);
  if (!node.workdir || !existsSync(node.workdir)) throw new Error("node has no available workdir");
  if (!existsSync(join(node.workdir, ".git"))) throw new Error("node workdir is not a Git checkout");
  return { id, node };
}

function contextNodeRepoIdentity(repoRef) {
  const value = String(repoRef || "");
  let m = value.match(/\/git\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\.git\/?$/);
  if (m) return { owner: m[1], repo: m[2] };
  m = value.match(/\/git\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

function nodeStatus(dir, cfg, node) {
  const alive = pidAlive(node.workerPid);
  const fresh = heartbeatAgeMs(dir, node.id) < (cfg.heartbeatTimeoutMs || 30000);
  if (alive && fresh) return existsSync(join(nodeDir(dir, node.id), "job.json")) ? "working" : "idle";
  if (alive) return "stale";
  return "dead";
}

function nodeView(dir, cfg, node) {
  return {
    id: node.id,
    name: node.name,
    status: nodeStatus(dir, cfg, node),
    workerPid: node.workerPid,
    caps: node.grant.capabilities,
    capNames: capsToNames(node.grant.capabilities),
    expiresAt: node.grant.expiresAt,
    expired: node.grant.expiresAt <= nowSec(),
    parent: node.grant.parent,
    mind: node.mind,
    repo: node.repo,
    heartbeatAgeMs: Math.round(heartbeatAgeMs(dir, node.id)),
    restarts: node.restarts,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new Error("invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

function send(res, code, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

/** Preview subsystem log line (daemon.log). Never carries the relay token. */
function plog(...a) {
  console.log(`[preview ${new Date().toISOString()}]`, ...a);
}

/**
 * 401 challenge for the auth gate. RFC 7235: a 401 MUST carry
 * WWW-Authenticate, otherwise clients (notably git, which relies on the
 * 401 -> retry-with-credentials flow for userinfo URLs like
 * http://oauth2:<token>@host/...) never retry and the push dies with a
 * confusing transport error instead of authenticating.
 */
function unauthorized(res) {
  return send(
    res,
    401,
    { error: "unauthorized: valid token required (Bearer header or Basic password)" },
    { "www-authenticate": 'Basic realm="kiln-swarm", Bearer realm="kiln-swarm"' }
  );
}

/**
 * Bearer <token>, or HTTP Basic where the password is the token — that's how
 * `git` sends credentials embedded in a URL (http://oauth2:<token>@host/...).
 */
function checkAuth(req, token) {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) {
    const p = auth.slice(7);
    return p.length === token.length && timingSafeEqual(Buffer.from(p), Buffer.from(token));
  }
  if (auth.startsWith("Basic ")) {
    let decoded;
    try { decoded = Buffer.from(auth.slice(6), "base64").toString("utf8"); }
    catch { return false; }
    const i = decoded.indexOf(":");
    const pass = i >= 0 ? decoded.slice(i + 1) : decoded;
    return pass.length > 0 && pass.length === token.length &&
      timingSafeEqual(Buffer.from(pass), Buffer.from(token));
  }
  return false;
}

export function startApiServer(dir, cfg) {
  const token = loadApiToken(dir);
  let apiPort = 0; // filled in once listening; used for clone URLs
  // Public-preview sidecar reconciler: one ssh/pipe bundle for all public
  // apps, respawned on drop. No-op until cfg.preview is set.
  const previews = startPreviewReconciler(dir, cfg, plog);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      const path = url.pathname;

      if (req.method === "GET" && path === "/health") {
        return send(res, 200, { ok: true, version: 2, service: "kiln-swarm", contextFabric: "v2" });
      }

      // ---- git hosting: public routes (list/clone/fetch need no token) ----
      if (req.method === "GET" && path === "/git") {
        return send(res, 200, { repos: listRepos(dir) });
      }
      // CI status, GitHub commit-status style — public, like clone/fetch.
      {
        const m = path.match(/^\/git\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/ci\/(status|latest)(?:\/([0-9a-f]{4,40}))?$/);
        if (req.method === "GET" && m) {
          const owner = m[1], repo = m[2], which = m[3], sha = m[4] || null;
          if (!validRepoName(owner) || !validRepoName(repo) || !repoExists(dir, owner, repo)) {
            return send(res, 404, { error: "no such repo" });
          }
          const doc = which === "status"
            ? (sha ? readResult(dir, owner, repo, sha) : null)
            : readLatest(dir, owner, repo, url.searchParams.get("branch") || undefined);
          if (!doc) return send(res, 404, { error: "no CI result" });
          return send(res, 200, doc);
        }
      }
      // gitReceive is set for receive-pack; served after the auth gate below.
      // NOTE: only paths WITH a trailing smart-http segment are intercepted
      // here; bare /git/:owner/:repo (repo create) falls through to auth.
      let gitReceive = null;
      let memoryRoute = null;
      {
        const m = path.match(/^\/git\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(\/.*)?$/);
        if (m && m[3]) {
          const owner = m[1], repo = m[2], rest = m[3] || "";
          // Memory routes live under /git/:owner/:repo/memory/* but are
          // NOT git protocol — hold them for the auth gate below.
          if (rest === "/memory" || rest.startsWith("/memory/")) {
            memoryRoute = { owner, repo, rest };
          } else {
          const kind =
            req.method === "GET" && rest === "/info/refs" ? "smart"
            : req.method === "POST" && rest === "/git-upload-pack" ? "smart"
            : req.method === "POST" && rest === "/git-receive-pack" ? "receive"
            : null;
          if (!kind) return send(res, 404, { error: "not found" });
          if (!validRepoName(owner) || !validRepoName(repo) || !repoExists(dir, owner, repo)) {
            return send(res, 404, { error: "no such repo" });
          }
          if (kind === "receive") {
            gitReceive = { owner, repo };
          } else {
            await serveGitHttp(dir, req, res);
            return;
          }
          }
        }
      }

      // ---- auth (everything below here) ----
      if (!checkAuth(req, token)) {
        return unauthorized(res);
      }

      // Authenticated push path — the token was verified BEFORE the backend
      // runs, so an unauthenticated push never reaches git at all.
      if (gitReceive) {
        // CI: snapshot refs before the receive-pack so we can diff after and
        // enqueue verification for exactly the branches that moved. CI is
        // strictly best-effort — it must never break or slow the push.
        let refsBefore = null;
        try { refsBefore = snapshotRefs(dir, gitReceive.owner, gitReceive.repo); } catch {}
        await serveGitHttp(dir, req, res);
        try {
          const refsAfter = snapshotRefs(dir, gitReceive.owner, gitReceive.repo);
          const cfg = loadRepoConfig(dir);
          const key = `${gitReceive.owner}/${gitReceive.repo}`;
          if (refsBefore && cfg[key] && cfg[key].command) {
            for (const [ref, sha] of Object.entries(refsAfter)) {
              if (!ref.startsWith("refs/heads/")) continue;
              if (refsBefore[ref] !== sha) {
                enqueueCiJob(dir, { owner: gitReceive.owner, repo: gitReceive.repo, ref, sha });
              }
            }
          }
        } catch (e) { plog(`ci enqueue failed (non-fatal): ${e.message}`); }
        return;
      }

      // ---- per-repo memory (authenticated; held from the git block above) ----
      if (memoryRoute) {
        const { owner, repo, rest } = memoryRoute;
        if (!validRepoName(owner) || !validRepoName(repo) || !repoExists(dir, owner, repo)) {
          return send(res, 404, { error: "no such repo" });
        }
        try {
          if (req.method === "POST" && rest === "/memory/episodes") {
            const b = await readBody(req);
            const r = remember(dir, owner, repo, b);
            return send(res, 201, { ok: true, event: r.event, commit: r.commit });
          }
          if (req.method === "POST" && rest === "/memory/facts") {
            const b = await readBody(req);
            const r = assertFact(dir, owner, repo, b);
            return send(res, 201, { ok: true, event: r.event, fact: r.event, commit: r.commit });
          }
          if (req.method === "POST" && rest === "/memory/supersede") {
            const b = await readBody(req);
            const r = supersedeFact(dir, owner, repo, b);
            return send(res, 201, { ok: true, event: r.event, commit: r.commit });
          }
          if (req.method === "POST" && rest === "/memory/links") {
            const b = await readBody(req);
            const r = linkMemories(dir, owner, repo, b);
            return send(res, 201, { ok: true, event: r.event, commit: r.commit });
          }
          if (req.method === "POST" && rest === "/memory/core") {
            const b = await readBody(req);
            const r = setCore(dir, owner, repo, b);
            return send(res, 201, { ok: true, event: r.event, commit: r.commit });
          }
          if (req.method === "GET" && rest === "/memory/core") {
            return send(res, 200, { core: loadMemory(dir, owner, repo).core });
          }
          if (req.method === "GET" && rest === "/memory/facts") {
            const st = loadMemory(dir, owner, repo);
            const asOf = url.searchParams.get("asOf")
              ? Math.floor(Date.parse(url.searchParams.get("asOf")) / 1000)
              : Math.floor(Date.now() / 1000);
            const facts = factsAt(st, asOf, url.searchParams.get("includeSuperseded") === "1");
            return send(res, 200, { facts });
          }
          if (req.method === "GET" && rest === "/memory/recall") {
            const q = url.searchParams.get("q") || "";
            const r = recall(dir, owner, repo, q, {
              limit: parseInt(url.searchParams.get("limit") || "10", 10) || 10,
              kinds: (url.searchParams.get("kinds") || "").split(",").filter(Boolean),
              tags: (url.searchParams.get("tags") || "").split(",").filter(Boolean),
              asOf: url.searchParams.get("asOf") || undefined,
              includeSuperseded: url.searchParams.get("includeSuperseded") === "1",
            });
            return send(res, 200, r);
          }
          if (req.method === "GET" && rest === "/memory/context") {
            const pack = buildContext(dir, owner, repo, {
              query: url.searchParams.get("q") || undefined,
              budgetTokens: parseInt(url.searchParams.get("budget") || "4000", 10) || 4000,
              asOf: url.searchParams.get("asOf") || undefined,
            });
            return send(res, 200, pack);
          }
          if (req.method === "GET" && rest === "/memory/sit") {
            const brief = agentAwareness(dir, owner, repo, {
              query: url.searchParams.get("q") || undefined,
              budgetTokens: parseInt(url.searchParams.get("budget") || "1200", 10) || 1200,
              asOf: url.searchParams.get("asOf") || undefined,
            });
            return send(res, 200, brief);
          }
          if (req.method === "GET" && rest === "/memory/stats") {
            return send(res, 200, memoryStats(dir, owner, repo));
          }
          if (req.method === "POST" && rest === "/memory/verify") {
            return send(res, 200, verifyMemory(dir, owner, repo));
          }
          return send(res, 404, { error: "not found" });
        } catch (e) {
          return send(res, 400, { error: e.message });
        }
      }

      // ---- git repo create ----
      {
        const m = path.match(/^\/git\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
        if (req.method === "POST" && m) {
          try {
            const r = createRepo(dir, m[1], m[2]);
            return send(res, 201, {
              ok: true,
              owner: r.owner,
              repo: r.repo,
              cloneUrl: `http://127.0.0.1:${apiPort}/git/${r.owner}/${r.repo}`,
            });
          } catch (e) {
            if (e.code === "EXISTS") return send(res, 409, { error: e.message });
            return send(res, 400, { error: e.message });
          }
        }
      }

      // ---- Context Fabric: authenticated, node-bound local repository cognition ----
      {
        const m = path.match(/^\/v1\/context\/nodes\/([A-Za-z0-9_.-]+)\/(index|query|sit|status)$/);
        if (m) {
          let bound;
          try { bound = resolveContextNode(dir, m[1]); }
          catch (e) { return send(res, 404, { error: e.message }); }
          const action = m[2];
          const idxDir = contextIndexDir(dir);

          if (req.method === "POST" && action === "index") {
            const b = await readBody(req);
            const index = buildContextIndex(bound.node.workdir, idxDir, {
              chunkLines: b.chunkLines,
              overlap: b.overlap,
            });
            const receipt = appendContextReceipt(dir, {
              operation: "api-index",
              node: bound.id,
              indexDigest: index.digest,
              revision: index.revision,
              worktreeDigest: index.worktreeDigest,
            });
            const metric = recordContextMetric(dir, {
              kind: "index",
              indexedBytes: index.stats.indexedBytes,
              reusedFiles: index.stats.reusedFiles,
              rebuiltFiles: index.stats.rebuiltFiles,
            });
            return send(res, 200, {
              node: bound.id,
              receipt,
              metric,
              index: {
                schema: index.schema,
                digest: index.digest,
                revision: index.revision,
                dirty: index.dirty,
                worktreeDigest: index.worktreeDigest,
                generatedAt: index.generatedAt,
                stats: index.stats,
                skipped: index.skipped,
              },
            });
          }

          if (req.method === "POST" && action === "query") {
            const b = await readBody(req);
            let request;
            try { request = boundContextRequest(b, "query"); }
            catch (e) { return send(res, 400, { error: e.message }); }
            const started = Date.now();
            let index = loadIndex(idxDir, bound.node.workdir);
            if (!index || request.refresh) {
              index = buildContextIndex(bound.node.workdir, idxDir, {
                chunkLines: b.chunkLines,
                overlap: b.overlap,
              });
            }
            const pack = queryContextIndex(index, request.query, request);
            const receipt = appendContextReceipt(dir, {
              operation: "api-query",
              node: bound.id,
              query: request.query,
              indexDigest: index.digest,
              packDigest: pack.digest,
              revision: pack.revision,
              worktreeDigest: pack.worktreeDigest,
              emittedBytes: pack.stats.emittedBytes,
              emittedChunks: pack.stats.emittedChunks,
              unchangedChunks: pack.stats.unchangedChunks,
            });
            const metric = recordContextMetric(dir, {
              kind: "query",
              packDigest: pack.digest,
              stats: pack.stats,
              reusedFiles: index.stats.reusedFiles,
              rebuiltFiles: index.stats.rebuiltFiles,
              latencyMs: Date.now() - started,
            });
            return send(res, 200, { node: bound.id, receipt, metric, pack });
          }

          if (req.method === "POST" && action === "sit") {
            const b = await readBody(req);
            let request;
            try { request = boundContextRequest(b, "sit"); }
            catch (e) { return send(res, 400, { error: e.message }); }
            const started = Date.now();
            let index = loadIndex(idxDir, bound.node.workdir);
            if (!index || request.refresh) {
              index = buildContextIndex(bound.node.workdir, idxDir, {
                chunkLines: b.chunkLines,
                overlap: b.overlap,
              });
            }
            const code = queryContextIndex(index, request.query, request);
            let memory = { available: false, reason: "node is not attached to a KILN-native repository" };
            const identity = contextNodeRepoIdentity(bound.node.repo);
            if (identity) {
              try {
                memory = {
                  available: true,
                  owner: identity.owner,
                  repo: identity.repo,
                  ...agentAwareness(dir, identity.owner, identity.repo, {
                    query: request.query,
                    budgetTokens: request.memoryTokens,
                  }),
                };
              } catch (e) {
                memory = { available: false, owner: identity.owner, repo: identity.repo, reason: e.message };
              }
            }
            const receipt = appendContextReceipt(dir, {
              operation: "api-sit",
              node: bound.id,
              query: request.query,
              indexDigest: index.digest,
              packDigest: code.digest,
              revision: code.revision,
              worktreeDigest: code.worktreeDigest,
              emittedBytes: code.stats.emittedBytes,
              emittedChunks: code.stats.emittedChunks,
              unchangedChunks: code.stats.unchangedChunks,
            });
            const metric = recordContextMetric(dir, {
              kind: "sit",
              packDigest: code.digest,
              stats: code.stats,
              reusedFiles: index.stats.reusedFiles,
              rebuiltFiles: index.stats.rebuiltFiles,
              latencyMs: Date.now() - started,
            });
            return send(res, 200, {
              node: bound.id,
              receipt,
              metric,
              sit: { schema: "kiln.context-sit.v1", code, memory },
            });
          }

          if (req.method === "GET" && action === "status") {
            const index = loadIndex(idxDir, bound.node.workdir);
            if (!index) return send(res, 404, { error: "context index not built" });
            return send(res, 200, {
              node: bound.id,
              index: {
                digest: index.digest,
                revision: index.revision,
                dirty: index.dirty,
                worktreeDigest: index.worktreeDigest,
                generatedAt: index.generatedAt,
                stats: index.stats,
              },
            });
          }

          return send(res, 405, { error: "method not allowed" });
        }
      }

      if (req.method === "POST" && path === "/v1/context/receipts/verify") {
        const result = verifyContextReceipts(dir);
        return send(res, result.ok ? 200 : 409, result);
      }

      if (req.method === "GET" && path === "/v1/context/metrics") {
        return send(res, 200, {
          metrics: contextMetricsSummary(loadContextMetrics(dir)),
          limits: contextLimits(),
        });
      }

      // ---- jobs ----
      if (req.method === "POST" && path === "/jobs") {
        const b = await readBody(req);
        if (!b.plan || !Array.isArray(b.plan.steps)) {
          return send(res, 400, { error: "plan.steps[] is required" });
        }
        const job = {
          id: newJobId(),
          name: String(b.name || `job-${Date.now()}`),
          plan: b.plan,
          mind: String(b.mind || "script"),
        };
        if (b.node) job.node = resolveNode(dir, String(b.node));
        if (b.repo) job.repo = String(b.repo);
        appendEvent(dir, "submit", { job });
        return send(res, 201, { id: job.id, name: job.name });
      }
      if (req.method === "GET" && path === "/jobs") {
        const jobs = [...replay(dir).values()].sort((a, b) => a.submittedAt - b.submittedAt);
        return send(res, 200, { jobs });
      }
      {
        const m = path.match(/^\/jobs\/([A-Za-z0-9_.-]+)$/);
        if (req.method === "GET" && m) {
          const job = replay(dir).get(m[1]);
          if (!job) return send(res, 404, { error: "no such job" });
          return send(res, 200, { job });
        }
      }

      // ---- nodes ----
      if (req.method === "POST" && path === "/nodes") {
        const b = await readBody(req);
        if (!b.name) return send(res, 400, { error: "name is required" });
        let caps;
        try { caps = parseCaps(b.caps ?? 15); } catch (e) { return send(res, 400, { error: e.message }); }
        const ttl = parseInt(b.ttlSec ?? 86400, 10);
        if (!(ttl > 0)) return send(res, 400, { error: "ttlSec must be positive seconds" });
        const node = await createNode(dir, {
          name: String(b.name),
          caps,
          expiresAt: nowSec() + ttl,
          repo: b.repo ? String(b.repo) : null,
          mind: String(b.mind || "script"),
          restartPolicy: String(b.policy || "on-failure"),
          maxRestarts: b.maxRestarts ? parseInt(b.maxRestarts, 10) : 3,
        });
        return send(res, 201, { id: node.id, name: node.name });
      }
      if (req.method === "GET" && path === "/nodes") {
        const nodes = listNodeIds(dir).map((id) => nodeView(dir, cfg, loadNode(dir, id)));
        return send(res, 200, { nodes });
      }
      {
        const m = path.match(/^\/nodes\/([A-Za-z0-9_.-]+)\/stop$/);
        if (req.method === "POST" && m) {
          let id;
          try { id = resolveNode(dir, m[1]); } catch { return send(res, 404, { error: "no such node" }); }
          const node = loadNode(dir, id);
          if (node.workerPid && pidAlive(node.workerPid)) {
            try { process.kill(node.workerPid, "SIGTERM"); } catch {}
            node.workerPid = null; node.lastExit = 0; saveNode(dir, node);
          }
          return send(res, 200, { ok: true });
        }
      }
      {
        const m = path.match(/^\/nodes\/([A-Za-z0-9_.-]+)\/logs$/);
        if (req.method === "GET" && m) {
          let id;
          try { id = resolveNode(dir, m[1]); } catch { return send(res, 404, { error: "no such node" }); }
          const stream = url.searchParams.get("stream") === "stderr" ? "stderr.log" : "stdout.log";
          const tail = Math.min(Math.max(parseInt(url.searchParams.get("tail") || "50", 10) || 50, 1), 2000);
          const p = join(nodeDir(dir, id), stream);
          const log = existsSync(p)
            ? readFileSync(p, "utf8").split("\n").slice(-tail).join("\n")
            : "";
          return send(res, 200, { stream: stream.replace(".log", ""), tail, log });
        }
      }

      // ---- receipts ----
      if (req.method === "POST" && path === "/receipts/verify") {
        const b = await readBody(req);
        let ids = listNodeIds(dir);
        if (b.node) {
          try { ids = [resolveNode(dir, String(b.node))]; }
          catch { return send(res, 404, { error: "no such node" }); }
        }
        const results = ids.map((id) => {
          const n = loadNode(dir, id);
          const kp = loadKeypair(loadKeyFile(dir, id));
          const v = verifyReceipts(dir, id, kp);
          return { node: id, name: n.name, ok: v.ok, count: v.count, error: v.error || null };
        });
        return send(res, 200, { results, allOk: results.every((r) => r.ok) });
      }

      // ---- promote: KILN repo -> GitHub (receipt semantics, never throws) ----
      if (req.method === "POST" && path === "/v1/promote") {
        const b = await readBody(req);
        const splitTarget = (s) => {
          if (typeof s !== "string") return null;
          const i = s.indexOf("/");
          if (i <= 0 || i === s.length - 1) return null;
          return [s.slice(0, i), s.slice(i + 1)];
        };
        const repoParts = splitTarget(b.repo);
        if (!repoParts) return send(res, 400, { error: "repo must be 'owner/repo'" });
        let githubOwner, githubRepo;
        if (b.github !== undefined) {
          const ghParts = splitTarget(b.github);
          if (!ghParts) return send(res, 400, { error: "github must be 'owner/repo'" });
          [githubOwner, githubRepo] = ghParts;
        }
        const receipt = await promoteRepo(dir, repoParts[0], repoParts[1], {
          githubOwner,
          githubRepo,
          branch: b.branch ? String(b.branch) : undefined,
          rebase: !!b.rebase,
          force: !!b.force,
          contextEvidence: b.contextEvidence,
        });
        const status = receipt.ok ? 200
          : receipt.error.stage === "repo_not_found" || receipt.error.stage === "github_repo_not_found" ? 404
          : receipt.error.stage === "no_target" || receipt.error.stage === "bad_target" || receipt.error.stage === "bad_evidence" ? 400
          : receipt.error.stage === "not_fast_forward" || receipt.error.stage === "rebase_needs_root" ? 409
          : receipt.error.stage === "no_github_credential" ? 412
          : receipt.error.stage.startsWith("github_") ? 502
          : 500;
        return send(res, status, receipt);
      }

      // ---- compute: serverless functions ----
      if (req.method === "POST" && path === "/v1/compute/invoke") {
        const b = await readBody(req);
        try {
          const { invocationId, jobId } = submitInvocation(dir, {
            name: b.name, code: b.code, args: b.args, timeoutMs: b.timeoutMs,
            memoryMB: b.memoryMB, network: b.network, retries: b.retries,
          });
          if (b.waitMs !== undefined) {
            const w = Number(b.waitMs);
            if (!Number.isFinite(w) || w < 1000 || w > 300000) {
              return send(res, 400, { error: "waitMs must be a number in 1000..300000" });
            }
            return send(res, 200, await waitInvocation(dir, invocationId, w));
          }
          return send(res, 201, { invocationId, jobId, status: "pending" });
        } catch (e) {
          if (e instanceof ComputeError && e.status === 429) {
            return send(res, 429, { error: e.message }, { "retry-after": "2" });
          }
          throw e;
        }
      }
      {
        const m = path.match(/^\/v1\/compute\/invocations\/([A-Za-z0-9_.-]+)$/);
        if (req.method === "GET" && m) {
          return send(res, 200, getInvocation(dir, m[1]));
        }
      }

      // ---- compute: parallel map ----
      if (req.method === "POST" && path === "/v1/compute/map") {
        const b = await readBody(req);
        try {
          const r = submitMap(dir, {
            name: b.name, code: b.code, items: b.items, timeoutMs: b.timeoutMs,
            memoryMB: b.memoryMB, network: b.network, retries: b.retries,
          });
          return send(res, 201, { ...r, count: r.invocationIds.length });
        } catch (e) {
          if (e instanceof ComputeError && e.status === 429) {
            return send(res, 429, { error: e.message }, { "retry-after": "2" });
          }
          throw e;
        }
      }
      {
        const m = path.match(/^\/v1\/compute\/map\/([A-Za-z0-9_.-]+)$/);
        if (req.method === "GET" && m) {
          return send(res, 200, getMap(dir, m[1]));
        }
      }

      // ---- compute: capacity (Little's-law scheduler telemetry) ----
      if (req.method === "GET" && path === "/v1/compute/capacity") {
        return send(res, 200, getCapacity());
      }

      // ---- compute: app hosting ----
      if (req.method === "POST" && path === "/v1/compute/apps") {
        const b = await readBody(req);
        const r = await deployApp(dir, {
          name: b.name, repo: b.repo, command: b.command,
          args: b.args, env: b.env, port: b.port,
        });
        if (b.public) {
          // Caffeine-style: public:true auto-enables preview on deploy.
          // Deploy still succeeds privately when the relay isn't configured.
          try {
            const pv = await enablePreview(dir, cfg, r.appId, plog);
            r.previewUrl = pv.previewUrl;
            r.preview = pv.preview;
          } catch (e) {
            r.previewUrl = null;
            r.preview = { enabled: false, url: null, relayPort: null, wanted: true, note: e.message };
          }
        }
        return send(res, 201, r);
      }
      if (req.method === "GET" && path === "/v1/compute/apps") {
        const apps = await listApps(dir);
        return send(res, 200, { apps: apps.map((a) => withPreview(dir, cfg, a)) });
      }
      {
        const m = path.match(/^\/v1\/compute\/apps\/([A-Za-z0-9_.-]+)\/preview$/);
        if (m && req.method === "POST") {
          return send(res, 200, await enablePreview(dir, cfg, m[1], plog));
        }
        if (m && req.method === "DELETE") {
          return send(res, 200, await disablePreview(dir, cfg, m[1], plog));
        }
      }
      {
        const m = path.match(/^\/v1\/compute\/apps\/([A-Za-z0-9_.-]+)$/);
        if (req.method === "GET" && m) {
          return send(res, 200, withPreview(dir, cfg, await appStatus(dir, m[1])));
        }
      }
      {
        const m = path.match(/^\/v1\/compute\/apps\/([A-Za-z0-9_.-]+)\/logs$/);
        if (req.method === "GET" && m) {
          const tail = url.searchParams.has("tail") ? parseInt(url.searchParams.get("tail"), 10) : 100;
          return send(res, 200, appLogs(dir, m[1], Number.isFinite(tail) ? tail : 100));
        }
      }
      {
        const m = path.match(/^\/v1\/compute\/apps\/([A-Za-z0-9_.-]+)$/);
        if (req.method === "DELETE" && m) {
          await teardownPreview(dir, cfg, m[1], plog);
          return send(res, 200, undeployApp(dir, m[1]));
        }
      }

      return send(res, 404, { error: "not found" });
    } catch (e) {
      if (e instanceof ComputeError) return send(res, e.status, { error: e.message });
      return send(res, 500, { error: e.message });
    }
  });

  const wanted = process.env.KILN_SWARM_API_PORT !== undefined
    ? parseInt(process.env.KILN_SWARM_API_PORT, 10)
    : (cfg.apiPort ?? 18787); // 0 = ephemeral; ?? keeps 0, || would eat it
  server.on("close", () => { try { previews.stop(); } catch {} });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    // 127.0.0.1 ONLY — the API never binds a public interface.
    server.listen(wanted, "127.0.0.1", () => {
      const port = server.address().port;
      apiPort = port;
      resolve({ server, port, url: `http://127.0.0.1:${port}` });
    });
  });
}
