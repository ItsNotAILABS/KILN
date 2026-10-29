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
 *   GET  /git                         list repos (auth required; account
 *                                     principals see only their namespace)
 *   GET  /git/:owner/:repo/info/refs?service=...   (auth required)
 *   POST /git/:owner/:repo/git-upload-pack          (auth required — clone/fetch)
 *   POST /git/:owner/:repo/git-receive-pack         (auth required — push,
 *                                     operator token only)
 *   Reads are principal-gated by the architect's rule (2026-10-28): only
 *   our accounts see the forge. CI status/latest/log under /git/.../ci/
 *   are gated the same way — a CI log can carry code.
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
 *   GET  /memory/recall?q=…                  cross-repo recall (phase 6):
 *                                    fused hits with per-repo provenance;
 *                                    unverifiable chains excluded + named
 * Sites (first-class sites: frontend repo + backend repo + artifact + app):
 *   POST /v1/sites                  {name, frontend:"o/r", backend:"o/r",
 *                                    artifact?, computeApp?} -> {ok, site}
 *                                    (also writes linkage core blocks into
 *                                    both repos' KILN Memory on create)
 *   GET  /v1/sites                  -> {sites:[...]} (registry records)
 *   GET  /v1/sites/:id              -> aggregated live status (repo HEADs,
 *                                    compute app status, memory linkage)
 *   DELETE /v1/sites/:id            -> {ok:true, id} (registry entry only)
 * Workspaces (first-class grouping: member repos + linked sites, one owner):
 *   POST /v1/workspaces             {owner, slug, name, description?,
 *                                    repos?:["o/r",…], siteIds?:["site_…"]}
 *                                    -> 201 {ok, workspace} (also writes a
 *                                    `workspace` core block into each member
 *                                    repo's KILN Memory)
 *   GET  /v1/workspaces?owner=      -> {workspaces:[...]} (registry records)
 *   GET  /v1/workspaces/:id         -> aggregated live status (member repo
 *                                    HEADs + branches, linked sites, memory
 *                                    linkage)
 *   PATCH /v1/workspaces/:id        {name?, description?, addRepos?,
 *                                    removeRepos?, linkSites?, unlinkSites?,
 *                                    setParent?:"<id>"|null}
 *                                    -> {ok, workspace} (setParent present =
 *                                    reparent; cycles refused with 400)
 *   DELETE /v1/workspaces/:id       {confirm:"<slug>"} -> {ok:true, id}
 *                                    (guarded; registry entry only;
 *                                    children reparent to its parent)
 *   GET  /v1/workspaces?tree=1      -> {workspaces:[roots with nested
 *                                    children]} (see GET list above)
 * Project details (live per-repo facts + editable description/topics):
 *   GET  /v1/repos/:owner/:repo/details -> project details object
 *   PATCH /v1/repos/:owner/:repo/details {description?, topics?}
 *                                    -> {ok, details}
 * Forge (the GitHub-shaped repo surface, lib/forge.mjs; operator = root,
 * account/agent principals walled to their own namespace, agents need
 * the "forge" scope; every write authenticated, audited, rate-limited):
 *   GET  /v1/repos/:owner/:repo/branches · POST (create) · DELETE /:name
 *   GET  /v1/repos/:owner/:repo/tree?ref&path
 *   GET  /v1/repos/:owner/:repo/contents?path&ref (&raw=1 = raw bytes)
 *   PUT  /v1/repos/:owner/:repo/contents {path, content, encoding?,
 *        message, branch?, sha?} -> a REAL git commit by the principal
 *   DELETE /v1/repos/:owner/:repo/contents {path, message, branch?, sha?}
 *   GET  /v1/repos/:owner/:repo/commits(?ref&limit&path) · /commits/:sha
 *   GET  /v1/repos/:owner/:repo/compare?base&head (ahead/behind, files,
 *        capped patch)
 *   POST /v1/repos/:owner/:repo/pulls {title, body?, head, base}
 *   GET  /v1/repos/:owner/:repo/pulls(?state) · GET/PATCH /pulls/:n
 *   POST /v1/repos/:owner/:repo/pulls/:n/comments {body}
 *   POST /v1/repos/:owner/:repo/pulls/:n/reviews {state, body?}
 *   POST /v1/repos/:owner/:repo/pulls/:n/merge {method?, message?}
 *        (fast-forward or merge-commit; conflicts -> 409; CI enqueued
 *        on the base branch after merge, best-effort like pushes)
 *   GET  /v1/repos/:owner/:repo/tags
 *   POST /v1/repos/:owner/:repo/releases {tag, name?, notes?, target?}
 *   GET  /v1/repos/:owner/:repo/releases · GET/PATCH/DELETE /releases/:tag
 * Packages (lib/packages.mjs; immutable versions, blobs on disk):
 *   GET  /v1/packages(?owner) · GET /v1/packages/:owner/:name
 *   GET  /v1/packages/:owner/:name/:version
 *   GET  /v1/packages/:owner/:name/:version/:filename (raw download)
 *   PUT  /v1/packages/:owner/:name/:version/:filename (raw bytes publish;
 *        same version+file with different bytes -> 409)
 * Accounts + agent identities (lib/accounts.mjs). Principals resolve
 * operator -> account session -> agent token; account/agent principals
 * are owner-scoped (see the guard after the auth gate):
 *   POST /v1/accounts               {email, name, owner, password}
 *                                   -> 201 {ok, account}   (public bootstrap)
 *   POST /v1/accounts/login         {email, password}
 *                                   -> {ok, account, sessionToken, expiresAt}
 *   GET  /v1/accounts/me            -> {ok, account, principal}
 *   POST /v1/accounts/me/agents     {name, scopes?}  (session only)
 *                                   -> 201 {ok, agent, token}  (token shown once)
 *   GET  /v1/accounts/me/agents     -> {agents:[...]}  (session only)
 *   DELETE /v1/accounts/me/agents/:id -> {ok, agent}   (session only, revoke)
 * Discovery (bearer-gated like every /v1 route):
 *   GET  /v1/capabilities           -> {version, abilities, openapi, docs}
 *   GET  /v1/openapi.json           -> OpenAPI 3.1 document (lib/openapi.mjs)
 */
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
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
import { createRepo, listRepos, repoExists, repoPath, serveGitHttp, validRepoName } from "./git.mjs";
import { promoteRepo } from "./promote.mjs";
import {
  remember, assertFact, supersedeFact, linkMemories, setCore,
  proposeMemory, resolveProposal,
  loadMemory, factsAt, recall, recallCrossRepo, buildContext, memoryStats, verifyMemory, agentAwareness,
} from "./memory.mjs";
import { memorySigningPubkey, signatureSummary } from "./memory-signing.mjs";
import {
  snapshotRefs, loadRepoConfig, enqueueCiJob, readResult, readLatest, readLog,
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
import {
  SitesError, createSite, listSites, deleteSite, siteStatus,
} from "./sites.mjs";
import {
  WorkspacesError, createWorkspace, listWorkspaces, workspaceTree,
  updateWorkspace, deleteWorkspace, workspaceStatus, resolveWorkspace,
} from "./workspaces.mjs";
import {
  RepoDetailsError, repoDetails, updateRepoDetails,
} from "./repodetails.mjs";
import {
  ForgeError, actorOf, appendAudit, listBranches, createBranch, deleteBranch,
  readTree, readContents, writeFile, listCommits, getCommit, compareRefs,
  listTags, listReleases, createRelease, updateRelease, deleteRelease,
  createPull, listPulls, getPull, updatePull, commentPull, reviewPull, mergePull,
} from "./forge.mjs";
import {
  PackagesError, publishPackage, listPackages, getPackage, getPackageVersion,
  readPackageFile, PACKAGE_MAX_BYTES,
} from "./packages.mjs";
import {
  AccountsError, accountPublic, agentPublic, createAccount, login,
  createAgent, listAgents, revokeAgent, resolveAccountToken,
} from "./accounts.mjs";
import { buildCapabilities, buildOpenApiDocument } from "./openapi.mjs";

// 4MB: the forge contents API carries base64-encoded files (1MB raw
// file ≈ 1.4MB encoded) plus PR/release prose in one JSON body.
const MAX_BODY = 4 * 1024 * 1024;

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

/** Raw-body reader for package publishes — bytes, not JSON, with a hard cap. */
function readRawBody(req, cap) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > cap) { reject(new Error(`body too large (>${cap} bytes)`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Write rate sanity for the forge surface: a fixed window per principal.
 * 120 writes/minute is far above any honest agent flow and far below
 * anything that could hammer the git plumbing. Reads are not limited.
 */
const writeWindows = new Map();
function writeRateLimited(principal) {
  const key = principal.kind === "operator" ? "operator"
    : principal.kind === "agent" ? `agt:${principal.agent.id}`
    : `sess:${principal.account.id}`;
  const now = Date.now();
  const w = writeWindows.get(key);
  if (!w || now - w.start >= 60000) {
    writeWindows.set(key, { start: now, count: 1 });
    return 0;
  }
  w.count += 1;
  if (w.count > 120) return Math.ceil((w.start + 60000 - now) / 1000);
  return 0;
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
        return send(res, 200, { ok: true, version: 1, service: "kiln-swarm" });
      }

      // ---- git hosting: read routes are HELD for the auth gate below ----
      // (architect's rule, 2026-10-28: only our accounts see the forge —
      // repo list, clone/fetch and CI reads all require a principal).
      let gitList = false;
      if (req.method === "GET" && path === "/git") gitList = true;
      // CI status, GitHub commit-status style — gated like clone/fetch.
      // ci/log/:sha serves the run's retained FULL log as text/plain
      // (the status doc's logTail is only the last 120 lines).
      let ciRoute = null;
      {
        const m = path.match(/^\/git\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/ci\/(status|latest|log)(?:\/([0-9a-f]{4,40}))?$/);
        if (req.method === "GET" && m) {
          ciRoute = { owner: m[1], repo: m[2], which: m[3], sha: m[4] || null };
        }
      }
      // gitReceive is set for receive-pack; served after the auth gate below.
      // NOTE: only paths WITH a trailing smart-http segment are intercepted
      // here; bare /git/:owner/:repo (repo create) falls through to auth.
      let gitReceive = null;
      let gitRead = null;
      let memoryRoute = null;
      {
        const m = path.match(/^\/git\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(\/.*)?$/);
        // CI paths also match this shape — they are held as ciRoute above
        // and must not fall into the smart-http kind check (404) here.
        if (m && m[3] && !ciRoute) {
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
            gitRead = { owner, repo };
          }
          }
        }
      }

      // ---- auth (everything below here) ----
      // Principal resolution, in order: the operator token (root,
      // unchanged), then an account session (kiln_sess_…), then an
      // agent token (kiln_agt_…) owned by an account. Signup + login
      // are public bootstrap routes — they authenticate by password.
      let principal = null;
      if (checkAuth(req, token)) {
        principal = { kind: "operator" };
      } else {
        const authz = req.headers.authorization || "";
        if (authz.startsWith("Bearer ")) {
          const resolved = resolveAccountToken(dir, authz.slice(7));
          if (resolved) {
            principal = resolved.kind === "agent"
              ? { kind: "agent", account: resolved.account, agent: resolved.agent }
              : { kind: "session", account: resolved.account };
          }
        }
      }
      const isBootstrap = req.method === "POST" &&
        (path === "/v1/accounts" || path === "/v1/accounts/login");

      // ---- accounts: public bootstrap (signup + login) ----
      if (req.method === "POST" && path === "/v1/accounts") {
        const b = await readBody(req);
        try {
          // An unclaimed namespace that already carries forge content
          // belongs to the operator's world: only an operator-signed
          // signup may claim it (e.g. the architect claiming his own).
          if (!principal || principal.kind !== "operator") {
            const hasContent =
              listRepos(dir).some((r) => r.owner === b.owner) ||
              listWorkspaces(dir, { owner: b.owner }).length > 0;
            if (hasContent) {
              throw new AccountsError(409,
                `the owner namespace "${b.owner}" already has forge content and is reserved — pick another owner, or have the operator claim it for you`);
            }
          }
          const account = createAccount(dir, {
            email: b.email, name: b.name, owner: b.owner, password: b.password,
          });
          return send(res, 201, { ok: true, account });
        } catch (e) {
          if (e instanceof AccountsError) return send(res, e.status, { error: e.message });
          throw e;
        }
      }
      if (req.method === "POST" && path === "/v1/accounts/login") {
        const b = await readBody(req);
        try {
          const r = login(dir, { email: b.email, password: b.password });
          return send(res, 200, {
            ok: true, account: r.account, sessionToken: r.sessionToken, expiresAt: r.expiresAt,
          });
        } catch (e) {
          if (e instanceof AccountsError) return send(res, e.status, { error: e.message });
          throw e;
        }
      }

      if (!principal) {
        return unauthorized(res);
      }
      // Git pushes stay operator-only in this slice: account and agent
      // tokens are API principals, not git credentials (yet).
      if (gitReceive && principal.kind !== "operator") {
        return unauthorized(res);
      }

      // ---- git reads: held above, served now that a principal exists ----
      // Operator reads everything. Account/agent principals read only
      // their own owner namespace — "only our accounts see it", with the
      // account boundary as the wall (403, self-describing, otherwise).
      const gitScopeDenied = (owner) =>
        principal.kind !== "operator" && principal.account?.owner !== owner;
      const gitScopeError = (owner) => ({
        error: `account principals may read only their own namespace ("${principal.account?.owner}") — "${owner}" is not yours`,
      });
      if (gitList) {
        const all = listRepos(dir);
        return send(res, 200, {
          repos: principal.kind === "operator"
            ? all
            : all.filter((r) => r.owner === principal.account?.owner),
        });
      }
      if (ciRoute) {
        const { owner, repo, which, sha } = ciRoute;
        if (!validRepoName(owner) || !validRepoName(repo) || !repoExists(dir, owner, repo)) {
          return send(res, 404, { error: "no such repo" });
        }
        if (gitScopeDenied(owner)) return send(res, 403, gitScopeError(owner));
        if (which === "log") {
          const text = sha ? readLog(dir, owner, repo, sha) : null;
          if (text === null) return send(res, 404, { error: "no CI log" });
          res.writeHead(200, {
            "content-type": "text/plain; charset=utf-8",
            "content-length": Buffer.byteLength(text),
          });
          res.end(text);
          return;
        }
        const doc = which === "status"
          ? (sha ? readResult(dir, owner, repo, sha) : null)
          : readLatest(dir, owner, repo, url.searchParams.get("branch") || undefined);
        if (!doc) return send(res, 404, { error: "no CI result" });
        return send(res, 200, doc);
      }
      if (gitRead) {
        if (gitScopeDenied(gitRead.owner)) {
          return send(res, 403, gitScopeError(gitRead.owner));
        }
        await serveGitHttp(dir, req, res);
        return;
      }

      // ---- accounts: self routes ----
      if (req.method === "GET" && path === "/v1/accounts/me") {
        if (principal.kind === "operator") {
          return send(res, 403, { error: "the operator token is not an account — /v1/accounts/me is for account sessions and agent tokens" });
        }
        return send(res, 200, {
          ok: true,
          account: accountPublic(principal.account),
          principal: principal.kind === "agent"
            ? { kind: "agent", agent: agentPublic(principal.agent) }
            : { kind: "session" },
        });
      }
      if (path === "/v1/accounts/me/agents" || path.startsWith("/v1/accounts/me/agents/")) {
        if (principal.kind !== "session") {
          return send(res, 403, { error: "agent identities are managed by the account owner — sign in with the account (a session), not an agent token or the operator token" });
        }
        try {
          if (req.method === "POST" && path === "/v1/accounts/me/agents") {
            const b = await readBody(req);
            const r = createAgent(dir, principal.account.id, { name: b.name, scopes: b.scopes });
            // The raw token is shown exactly once, in this response.
            return send(res, 201, { ok: true, agent: r.agent, token: r.token });
          }
          if (req.method === "GET" && path === "/v1/accounts/me/agents") {
            return send(res, 200, { agents: listAgents(dir, principal.account.id) });
          }
          const am = path.match(/^\/v1\/accounts\/me\/agents\/([A-Za-z0-9_.-]+)$/);
          if (req.method === "DELETE" && am) {
            const agent = revokeAgent(dir, principal.account.id, am[1]);
            return send(res, 200, { ok: true, agent });
          }
        } catch (e) {
          if (e instanceof AccountsError) return send(res, e.status, { error: e.message });
          throw e;
        }
        return send(res, 404, { error: "not found" });
      }

      // ---- account/agent scope guard ----
      // Non-operator principals may reach only: discovery, workspaces,
      // repo project-details, and their own account routes (handled
      // above). Everything else under the gate is operator-only. Agent
      // tokens additionally need the matching ability in their scopes.
      // Owner-level checks live in the route blocks themselves.
      if (principal.kind !== "operator") {
        const forgeRepoRoute = /^\/v1\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(branches|tree|contents|commits|compare|pulls|tags|releases)(\/.*)?$/.test(path);
        const packageRoute = path === "/v1/packages" || path.startsWith("/v1/packages/");
        const allowed =
          path === "/v1/capabilities" || path === "/v1/openapi.json" ||
          path === "/v1/workspaces" || path.startsWith("/v1/workspaces/") ||
          /^\/v1\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/details$/.test(path) ||
          forgeRepoRoute || packageRoute;
        if (!allowed) {
          return send(res, 403, { error: "this surface is operator-only — account and agent tokens cover workspaces, project details, the forge (branches/contents/pulls/releases/packages), and their own account routes (see swarm/docs/ACCOUNTS.md)" });
        }
        if (principal.kind === "agent") {
          const ability = path.startsWith("/v1/workspaces") ? "workspaces"
            : (forgeRepoRoute || packageRoute) ? "forge"
            : path.startsWith("/v1/repos/") ? "project-details" : null;
          if (ability && !principal.agent.scopes.includes(ability)) {
            return send(res, 403, { error: `this agent token lacks the "${ability}" scope` });
          }
        }
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

      // ---- cross-repo memory recall (phase 6; authenticated) ----
      // Read-time fan-out over every repo chain in the state dir;
      // unverifiable chains are excluded and named in the envelope.
      if (req.method === "GET" && path === "/memory/recall") {
        try {
          const r = recallCrossRepo(dir, url.searchParams.get("q") || "", {
            limit: parseInt(url.searchParams.get("limit") || "10", 10) || 10,
            kinds: (url.searchParams.get("kinds") || "").split(",").filter(Boolean),
            tags: (url.searchParams.get("tags") || "").split(",").filter(Boolean),
            asOf: url.searchParams.get("asOf") || undefined,
            since: url.searchParams.get("since") || undefined,
            until: url.searchParams.get("until") || undefined,
            includeSuperseded: url.searchParams.get("includeSuperseded") === "1",
          });
          return send(res, 200, r);
        } catch (e) {
          return send(res, 400, { error: e.message });
        }
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
          if (req.method === "POST" && rest === "/memory/propose") {
            const b = await readBody(req);
            const r = proposeMemory(dir, owner, repo, b);
            return send(res, 201, { ok: true, event: r.event, proposal: r.event, commit: r.commit });
          }
          if (req.method === "GET" && rest === "/memory/proposals") {
            const st = loadMemory(dir, owner, repo);
            const want = url.searchParams.get("status");
            const proposals = want ? st.proposals.filter((x) => x.status === want) : st.proposals;
            return send(res, 200, { proposals });
          }
          if (req.method === "POST" && rest === "/memory/proposals/resolve") {
            const b = await readBody(req);
            const r = resolveProposal(dir, owner, repo, b);
            return send(res, 200, { ok: true, proposal: r.proposal, decision: r.decision, materialized: r.materialized, statusEvent: r.statusEvent, commit: r.commit });
          }
          if (req.method === "GET" && rest === "/memory/stats") {
            return send(res, 200, memoryStats(dir, owner, repo));
          }
          if (req.method === "POST" && rest === "/memory/verify") {
            return send(res, 200, verifyMemory(dir, owner, repo));
          }
          if (req.method === "GET" && rest === "/memory/pubkey") {
            // Phase 2 discovery: the state dir's memory signing key
            // (public half) + this repo's signature posture. Creates
            // the key on first use, like a first write would.
            const pub = memorySigningPubkey(dir, { create: true });
            const st = loadMemory(dir, owner, repo);
            return send(res, 200, { ...pub, repo: `${owner}/${repo}`, signatures: signatureSummary(st.events) });
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
        });
        const status = receipt.ok ? 200
          : receipt.error.stage === "repo_not_found" || receipt.error.stage === "github_repo_not_found" ? 404
          : receipt.error.stage === "no_target" || receipt.error.stage === "bad_target" ? 400
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
          args: b.args, env: b.env, port: b.port, memoryMB: b.memoryMB,
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

      // ---- sites: frontend repo + backend repo + artifact + compute app ----
      if (req.method === "POST" && path === "/v1/sites") {
        const b = await readBody(req);
        try {
          const site = createSite(dir, {
            name: b.name, frontend: b.frontend, backend: b.backend,
            artifact: b.artifact, computeApp: b.computeApp, actor: "api",
          });
          return send(res, 201, { ok: true, site });
        } catch (e) {
          if (e instanceof SitesError) return send(res, e.status, { error: e.message });
          throw e;
        }
      }
      if (req.method === "GET" && path === "/v1/sites") {
        return send(res, 200, { sites: listSites(dir) });
      }
      {
        const m = path.match(/^\/v1\/sites\/([A-Za-z0-9_.-]+)$/);
        if (req.method === "GET" && m) {
          try {
            return send(res, 200, await siteStatus(dir, m[1]));
          } catch (e) {
            if (e instanceof SitesError) return send(res, e.status, { error: e.message });
            throw e;
          }
        }
        if (req.method === "DELETE" && m) {
          try {
            return send(res, 200, deleteSite(dir, m[1]));
          } catch (e) {
            if (e instanceof SitesError) return send(res, e.status, { error: e.message });
            throw e;
          }
        }
      }

      // ---- workspaces: member repos + linked sites under one owner ----
      if (req.method === "POST" && path === "/v1/workspaces") {
        const b = await readBody(req);
        // Owner scoping: account/agent principals create only under
        // their own namespace.
        if (principal.kind !== "operator" && b.owner !== principal.account.owner) {
          return send(res, 403, { error: `account principals may only create workspaces under their own owner namespace ("${principal.account.owner}")` });
        }
        try {
          const workspace = createWorkspace(dir, {
            owner: b.owner, slug: b.slug, name: b.name,
            description: b.description, repos: b.repos, siteIds: b.siteIds,
            parentId: b.parentId,
            actor: "api",
          });
          return send(res, 201, { ok: true, workspace });
        } catch (e) {
          if (e instanceof WorkspacesError) return send(res, e.status, { error: e.message });
          throw e;
        }
      }
      if (req.method === "GET" && path === "/v1/workspaces") {
        // Owner scoping: account/agent principals see only their own.
        const owner = principal.kind === "operator"
          ? (url.searchParams.get("owner") || undefined)
          : principal.account.owner;
        if (url.searchParams.get("tree") === "1") {
          return send(res, 200, { workspaces: workspaceTree(dir, { owner }) });
        }
        return send(res, 200, { workspaces: listWorkspaces(dir, { owner }) });
      }
      {
        const m = path.match(/^\/v1\/workspaces\/([A-Za-z0-9_.-]+)$/);
        if (req.method === "GET" && m) {
          try {
            if (principal.kind !== "operator" &&
                resolveWorkspace(dir, m[1]).owner !== principal.account.owner) {
              return send(res, 403, { error: "this workspace belongs to another account" });
            }
            return send(res, 200, workspaceStatus(dir, m[1]));
          } catch (e) {
            if (e instanceof WorkspacesError) return send(res, e.status, { error: e.message });
            throw e;
          }
        }
        if (req.method === "PATCH" && m) {
          const b = await readBody(req);
          try {
            if (principal.kind !== "operator" &&
                resolveWorkspace(dir, m[1]).owner !== principal.account.owner) {
              return send(res, 403, { error: "this workspace belongs to another account" });
            }
            const patch = {
              name: b.name, description: b.description,
              addRepos: b.addRepos, removeRepos: b.removeRepos,
              linkSites: b.linkSites, unlinkSites: b.unlinkSites,
            };
            // setParent is presence-sensitive in the lib (absent =
            // unchanged, null = clear) — only forward it when the body
            // actually carries the key.
            if (Object.prototype.hasOwnProperty.call(b, "setParent")) patch.setParent = b.setParent;
            const workspace = updateWorkspace(dir, m[1], patch, { actor: "api" });
            return send(res, 200, { ok: true, workspace });
          } catch (e) {
            if (e instanceof WorkspacesError) return send(res, e.status, { error: e.message });
            throw e;
          }
        }
        if (req.method === "DELETE" && m) {
          const b = await readBody(req);
          try {
            if (principal.kind !== "operator" &&
                resolveWorkspace(dir, m[1]).owner !== principal.account.owner) {
              return send(res, 403, { error: "this workspace belongs to another account" });
            }
            return send(res, 200, deleteWorkspace(dir, m[1], { confirm: b.confirm }));
          } catch (e) {
            if (e instanceof WorkspacesError) return send(res, e.status, { error: e.message });
            throw e;
          }
        }
      }

      // ---- project details: live per-repo facts + editable metadata ----
      {
        const m = path.match(/^\/v1\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/details$/);
        if (req.method === "GET" && m) {
          try {
            return send(res, 200, repoDetails(dir, m[1], m[2]));
          } catch (e) {
            if (e instanceof RepoDetailsError) return send(res, e.status, { error: e.message });
            throw e;
          }
        }
        if (req.method === "PATCH" && m) {
          const b = await readBody(req);
          // Owner scoping: describing a repo is a write on its namespace.
          if (principal.kind !== "operator" && m[1] !== principal.account.owner) {
            return send(res, 403, { error: "account principals may only describe repos under their own owner namespace" });
          }
          try {
            const details = updateRepoDetails(dir, m[1], m[2], {
              description: b.description, topics: b.topics,
            });
            return send(res, 200, { ok: true, details });
          } catch (e) {
            if (e instanceof RepoDetailsError) return send(res, e.status, { error: e.message });
            throw e;
          }
        }
      }

      // ---- forge: branches / contents / commits / pulls / releases ----
      // The GitHub-shaped surface (lib/forge.mjs). Operator = root;
      // account/agent principals are walled to their own namespace,
      // exactly like git reads. The actor writes under its own identity.
      {
        const fm = path.match(/^\/v1\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(branches|tree|contents|commits|compare|pulls|tags|releases)(\/.*)?$/);
        if (fm) {
          const [, fOwner, fRepo, kind, rest] = fm;
          const actor = actorOf(principal);
          try {
            if (principal.kind !== "operator" && fOwner !== principal.account.owner) {
              return send(res, 403, { error: `account principals may use the forge only under their own namespace ("${principal.account.owner}")` });
            }
            if (req.method !== "GET") {
              const retry = writeRateLimited(principal);
              if (retry) return send(res, 429, { error: "forge write rate limit (120/min per principal) — slow down" }, { "retry-after": String(retry) });
            }
            const gd = () => {
              if (!validRepoName(fOwner) || !validRepoName(fRepo) || !repoExists(dir, fOwner, fRepo)) {
                throw new ForgeError(404, `no such repo: ${fOwner}/${fRepo}`);
              }
              return repoPath(dir, fOwner, fRepo);
            };
            if (kind === "branches") {
              if (req.method === "GET" && !rest) return send(res, 200, { branches: listBranches(gd()) });
              if (req.method === "POST" && !rest) {
                const b = await readBody(req);
                const br = createBranch(gd(), b.name, b.from);
                appendAudit(dir, actor, "branch.create", `${fOwner}/${fRepo}:${b.name}`, {});
                return send(res, 201, { ok: true, branch: br });
              }
              const bm = (rest || "").match(/^\/([A-Za-z0-9._/-]+)$/);
              if (req.method === "DELETE" && bm) {
                const r = deleteBranch(gd(), decodeURIComponent(bm[1]));
                appendAudit(dir, actor, "branch.delete", `${fOwner}/${fRepo}:${bm[1]}`, {});
                return send(res, 200, r);
              }
            }
            if (kind === "tree" && req.method === "GET" && !rest) {
              return send(res, 200, readTree(gd(), url.searchParams.get("ref") || undefined, url.searchParams.get("path") || ""));
            }
            if (kind === "contents" && !rest) {
              if (req.method === "GET") {
                const c = readContents(gd(), url.searchParams.get("ref") || undefined, url.searchParams.get("path") || "");
                if (url.searchParams.get("raw") === "1") {
                  res.writeHead(200, { "content-type": "application/octet-stream", "content-length": c.buffer.length, "x-kiln-sha": c.sha });
                  res.end(c.buffer);
                  return;
                }
                return send(res, 200, { path: c.path, ref: c.ref, commit: c.commit, sha: c.sha, size: c.size, encoding: "base64", content: c.buffer.toString("base64") });
              }
              if (req.method === "PUT") {
                const b = await readBody(req);
                const r = writeFile(dir, fOwner, fRepo, actor, {
                  path: b.path, content: b.content, encoding: b.encoding, message: b.message, branch: b.branch, sha: b.sha,
                });
                return send(res, 201, { ok: true, ...r });
              }
              if (req.method === "DELETE") {
                const b = await readBody(req);
                const r = writeFile(dir, fOwner, fRepo, actor, {
                  path: b.path, message: b.message, branch: b.branch, sha: b.sha, deleteFile: true,
                });
                return send(res, 200, { ok: true, ...r });
              }
            }
            if (kind === "commits") {
              if (req.method === "GET" && !rest) {
                return send(res, 200, listCommits(gd(), {
                  ref: url.searchParams.get("ref") || undefined,
                  limit: url.searchParams.get("limit") || undefined,
                  path: url.searchParams.get("path") || undefined,
                }));
              }
              const cm = (rest || "").match(/^\/([0-9a-f]{4,64})$/);
              if (req.method === "GET" && cm) return send(res, 200, getCommit(gd(), cm[1]));
            }
            if (kind === "compare" && req.method === "GET" && !rest) {
              return send(res, 200, compareRefs(gd(), url.searchParams.get("base") || "", url.searchParams.get("head") || ""));
            }
            if (kind === "tags" && req.method === "GET" && !rest) {
              return send(res, 200, { tags: listTags(gd()) });
            }
            if (kind === "releases") {
              if (req.method === "GET" && !rest) return send(res, 200, { releases: listReleases(dir, fOwner, fRepo) });
              if (req.method === "POST" && !rest) {
                const b = await readBody(req);
                const rel = createRelease(dir, fOwner, fRepo, actor, { tag: b.tag, name: b.name, notes: b.notes, target: b.target });
                return send(res, 201, { ok: true, release: rel });
              }
              const rm = (rest || "").match(/^\/([^/]+)$/);
              if (rm) {
                const tag = decodeURIComponent(rm[1]);
                if (req.method === "GET") {
                  const rel = listReleases(dir, fOwner, fRepo).find((r) => r.tag === tag);
                  if (!rel) return send(res, 404, { error: `no such release: ${tag}` });
                  return send(res, 200, { release: rel });
                }
                if (req.method === "PATCH") {
                  const b = await readBody(req);
                  return send(res, 200, { ok: true, release: updateRelease(dir, fOwner, fRepo, actor, tag, { name: b.name, notes: b.notes }) });
                }
                if (req.method === "DELETE") {
                  const b = await readBody(req).catch(() => ({}));
                  return send(res, 200, deleteRelease(dir, fOwner, fRepo, actor, tag, { deleteTag: !!b.deleteTag }));
                }
              }
            }
            if (kind === "pulls") {
              if (req.method === "GET" && !rest) {
                return send(res, 200, { pulls: listPulls(dir, fOwner, fRepo, { state: url.searchParams.get("state") || undefined }) });
              }
              if (req.method === "POST" && !rest) {
                const b = await readBody(req);
                const pull = createPull(dir, fOwner, fRepo, actor, { title: b.title, body: b.body, head: b.head, base: b.base });
                return send(res, 201, { ok: true, pull });
              }
              const pm = (rest || "").match(/^\/(\d+)(\/(comments|reviews|merge))?$/);
              if (pm) {
                const n = parseInt(pm[1], 10);
                const sub = pm[3];
                if (req.method === "GET" && !sub) return send(res, 200, { pull: getPull(dir, fOwner, fRepo, n) });
                if (req.method === "PATCH" && !sub) {
                  const b = await readBody(req);
                  return send(res, 200, { ok: true, pull: updatePull(dir, fOwner, fRepo, actor, n, { title: b.title, body: b.body, state: b.state }) });
                }
                if (req.method === "POST" && sub === "comments") {
                  const b = await readBody(req);
                  return send(res, 201, { ok: true, comment: commentPull(dir, fOwner, fRepo, actor, n, { body: b.body }) });
                }
                if (req.method === "POST" && sub === "reviews") {
                  const b = await readBody(req);
                  return send(res, 201, { ok: true, review: reviewPull(dir, fOwner, fRepo, actor, n, { state: b.state, body: b.body }) });
                }
                if (req.method === "POST" && sub === "merge") {
                  const b = await readBody(req);
                  const r = mergePull(dir, fOwner, fRepo, actor, n, { method: b.method, message: b.message });
                  return send(res, 200, { ok: true, ...r });
                }
              }
            }
          } catch (e) {
            if (e instanceof ForgeError) return send(res, e.status, { error: e.message });
            throw e;
          }
          return send(res, 404, { error: "not found" });
        }
      }

      // ---- packages: publish / list / resolve / download ----
      {
        const pm = path.match(/^\/v1\/packages(?:\/([A-Za-z0-9_.-]+)(?:\/([A-Za-z0-9_.-]+)(?:\/([0-9][^/]*)(?:\/([^/]+))?)?)?)?$/);
        if (pm && (path === "/v1/packages" || path.startsWith("/v1/packages/"))) {
          const actor = actorOf(principal);
          const [, pOwner, pName, pVersion, pFile] = pm;
          try {
            if (req.method === "GET" && !pOwner) {
              const owner = principal.kind === "operator"
                ? (url.searchParams.get("owner") || undefined)
                : principal.account.owner;
              return send(res, 200, { packages: listPackages(dir, { owner }) });
            }
            if (pOwner) {
              if (principal.kind !== "operator" && pOwner !== principal.account.owner) {
                return send(res, 403, { error: `account principals may use packages only under their own namespace ("${principal.account.owner}")` });
              }
              if (req.method === "GET" && pOwner && !pName) {
                return send(res, 200, { packages: listPackages(dir, { owner: pOwner }) });
              }
              if (req.method === "GET" && pName && !pVersion) {
                return send(res, 200, { package: getPackage(dir, pOwner, pName) });
              }
              if (req.method === "GET" && pName && pVersion && !pFile) {
                return send(res, 200, getPackageVersion(dir, pOwner, decodeURIComponent(pName), decodeURIComponent(pVersion)));
              }
              if (req.method === "GET" && pName && pVersion && pFile) {
                const { buffer, file } = readPackageFile(dir, pOwner, decodeURIComponent(pName), decodeURIComponent(pVersion), decodeURIComponent(pFile));
                res.writeHead(200, {
                  "content-type": file.contentType,
                  "content-length": buffer.length,
                  "x-kiln-sha256": file.sha256,
                });
                res.end(buffer);
                return;
              }
              if (req.method === "PUT" && pName && pVersion && pFile) {
                const retry = writeRateLimited(principal);
                if (retry) return send(res, 429, { error: "forge write rate limit (120/min per principal) — slow down" }, { "retry-after": String(retry) });
                let buffer;
                try {
                  buffer = await readRawBody(req, PACKAGE_MAX_BYTES);
                } catch (e) {
                  return send(res, 413, { error: e.message });
                }
                const r = publishPackage(dir, actor, pOwner, decodeURIComponent(pName), decodeURIComponent(pVersion), decodeURIComponent(pFile), buffer, {
                  description: url.searchParams.get("description") || undefined,
                  repo: url.searchParams.get("repo") || undefined,
                  contentType: req.headers["content-type"] || undefined,
                });
                return send(res, r.idempotent ? 200 : 201, { ok: true, ...r });
              }
            }
          } catch (e) {
            if (e instanceof PackagesError) return send(res, e.status, { error: e.message });
            throw e;
          }
          return send(res, 404, { error: "not found" });
        }
      }

      // ---- discovery: capabilities + OpenAPI (bearer-gated, like /v1) ----
      if (req.method === "GET" && path === "/v1/capabilities") {
        return send(res, 200, buildCapabilities());
      }
      if (req.method === "GET" && path === "/v1/openapi.json") {
        return send(res, 200, buildOpenApiDocument());
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
