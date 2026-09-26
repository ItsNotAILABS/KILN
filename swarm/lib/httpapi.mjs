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
 *   POST /v1/compute/apps           {name, repo, command, args?, env?, port?} -> {appId, name}
 *   GET  /v1/compute/apps           -> {apps:[...]}
 *   GET  /v1/compute/apps/:id/logs?tail=N -> {appId, log}
 *   DELETE /v1/compute/apps/:id     -> {ok:true}
 * Git hosting (KILN-native repos, served via git http-backend CGI):
 *   POST /git/:owner/:repo            create repo (auth required)
 *   GET  /git                         list repos (public)
 *   GET  /git/:owner/:repo/info/refs?service=...   (public)
 *   POST /git/:owner/:repo/git-upload-pack          (public — clone/fetch)
 *   POST /git/:owner/:repo/git-receive-pack         (auth required — push)
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
import { createRepo, listRepos, repoExists, serveGitHttp, validRepoName } from "./git.mjs";
import {
  ComputeError, submitInvocation, getInvocation, waitInvocation,
  submitMap, getMap, deployApp, listApps, appLogs, undeployApp,
} from "./compute.mjs";

const MAX_BODY = 1024 * 1024;

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
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      const path = url.pathname;

      if (req.method === "GET" && path === "/health") {
        return send(res, 200, { ok: true, version: 1, service: "kiln-swarm" });
      }

      // ---- git hosting: public routes (list/clone/fetch need no token) ----
      if (req.method === "GET" && path === "/git") {
        return send(res, 200, { repos: listRepos(dir) });
      }
      // gitReceive is set for receive-pack; served after the auth gate below.
      // NOTE: only paths WITH a trailing smart-http segment are intercepted
      // here; bare /git/:owner/:repo (repo create) falls through to auth.
      let gitReceive = null;
      {
        const m = path.match(/^\/git\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(\/.*)?$/);
        if (m && m[3]) {
          const owner = m[1], repo = m[2], rest = m[3] || "";
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

      // ---- auth (everything below here) ----
      if (!checkAuth(req, token)) {
        return unauthorized(res);
      }

      // Authenticated push path — the token was verified BEFORE the backend
      // runs, so an unauthenticated push never reaches git at all.
      if (gitReceive) {
        await serveGitHttp(dir, req, res);
        return;
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

      // ---- compute: serverless functions ----
      if (req.method === "POST" && path === "/v1/compute/invoke") {
        const b = await readBody(req);
        const { invocationId, jobId } = submitInvocation(dir, {
          name: b.name, code: b.code, args: b.args, timeoutMs: b.timeoutMs,
        });
        if (b.waitMs !== undefined) {
          const w = Number(b.waitMs);
          if (!Number.isFinite(w) || w < 1000 || w > 300000) {
            return send(res, 400, { error: "waitMs must be a number in 1000..300000" });
          }
          return send(res, 200, await waitInvocation(dir, invocationId, w));
        }
        return send(res, 201, { invocationId, jobId, status: "pending" });
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
        const r = submitMap(dir, { name: b.name, code: b.code, items: b.items, timeoutMs: b.timeoutMs });
        return send(res, 201, { ...r, count: r.invocationIds.length });
      }
      {
        const m = path.match(/^\/v1\/compute\/map\/([A-Za-z0-9_.-]+)$/);
        if (req.method === "GET" && m) {
          return send(res, 200, getMap(dir, m[1]));
        }
      }

      // ---- compute: app hosting ----
      if (req.method === "POST" && path === "/v1/compute/apps") {
        const b = await readBody(req);
        const r = await deployApp(dir, {
          name: b.name, repo: b.repo, command: b.command,
          args: b.args, env: b.env, port: b.port,
        });
        return send(res, 201, r);
      }
      if (req.method === "GET" && path === "/v1/compute/apps") {
        return send(res, 200, { apps: listApps(dir) });
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
