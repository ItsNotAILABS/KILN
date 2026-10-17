/**
 * Local HTTP API for the swarm daemon.
 *
 * Security invariants:
 * - Binds 127.0.0.1 only.
 * - GET /health and read-only Git listing/clone are the only unauthenticated surfaces.
 * - Context retrieval is authenticated and node-bound; callers cannot provide arbitrary filesystem paths.
 * - Repository content is never executed by the context subsystem.
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
import { buildContextIndex, loadIndex, queryContextIndex } from "./context-index.mjs";
import { appendContextReceipt, verifyContextReceipts } from "./context-receipts.mjs";

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
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

function unauthorized(res) {
  return send(
    res,
    401,
    { error: "unauthorized: valid token required (Bearer header or Basic password)" },
    { "www-authenticate": 'Basic realm="kiln-swarm", Bearer realm="kiln-swarm"' }
  );
}

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

function contextIndexDir(dir) {
  const p = join(dir, "context-indexes");
  mkdirSync(p, { recursive: true, mode: 0o700 });
  return p;
}

function contextNode(dir, raw) {
  const id = resolveNode(dir, String(raw));
  const node = loadNode(dir, id);
  if (!node.workdir || !existsSync(node.workdir)) throw new Error("node has no available workdir");
  if (!existsSync(join(node.workdir, ".git"))) throw new Error("node workdir is not a Git checkout");
  return { id, node };
}

export function startApiServer(dir, cfg) {
  const token = loadApiToken(dir);
  let apiPort = 0;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      const path = url.pathname;

      if (req.method === "GET" && path === "/health") {
        return send(res, 200, { ok: true, version: 2, service: "kiln-swarm", contextFabric: "v2" });
      }

      if (req.method === "GET" && path === "/git") {
        return send(res, 200, { repos: listRepos(dir) });
      }

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
          if (kind === "receive") gitReceive = { owner, repo };
          else { await serveGitHttp(dir, req, res); return; }
        }
      }

      if (!checkAuth(req, token)) return unauthorized(res);

      if (gitReceive) {
        await serveGitHttp(dir, req, res);
        return;
      }

      {
        const m = path.match(/^\/git\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
        if (req.method === "POST" && m) {
          try {
            const r = createRepo(dir, m[1], m[2]);
            return send(res, 201, {
              ok: true, owner: r.owner, repo: r.repo,
              cloneUrl: `http://127.0.0.1:${apiPort}/git/${r.owner}/${r.repo}`,
            });
          } catch (e) {
            if (e.code === "EXISTS") return send(res, 409, { error: e.message });
            return send(res, 400, { error: e.message });
          }
        }
      }

      // ---- Context Fabric: node-bound local retrieval ----
      {
        const m = path.match(/^\/context\/([A-Za-z0-9_.-]+)\/index$/);
        if (req.method === "POST" && m) {
          let bound;
          try { bound = contextNode(dir, m[1]); }
          catch (e) { return send(res, 404, { error: e.message }); }
          const b = await readBody(req);
          const index = buildContextIndex(bound.node.workdir, contextIndexDir(dir), {
            chunkLines: b.chunkLines,
            overlap: b.overlap,
          });
          const receipt = appendContextReceipt(dir, {
            operation: "index",
            node: bound.id,
            indexDigest: index.digest,
            revision: index.revision,
            worktreeDigest: index.worktreeDigest,
          });
          return send(res, 200, {
            node: bound.id,
            receipt,
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
      }
      {
        const m = path.match(/^\/context\/([A-Za-z0-9_.-]+)\/query$/);
        if (req.method === "POST" && m) {
          let bound;
          try { bound = contextNode(dir, m[1]); }
          catch (e) { return send(res, 404, { error: e.message }); }
          const b = await readBody(req);
          if (!b.query || !String(b.query).trim()) return send(res, 400, { error: "query is required" });
          const indexDir = contextIndexDir(dir);
          let index = loadIndex(indexDir, bound.node.workdir);
          if (!index || b.refresh !== false) {
            index = buildContextIndex(bound.node.workdir, indexDir, {
              chunkLines: b.chunkLines,
              overlap: b.overlap,
            });
          }
          const pack = queryContextIndex(index, String(b.query), {
            maxBytes: b.maxBytes,
            maxChunks: b.maxChunks,
            mmrLambda: b.mmrLambda,
            knownHashes: b.knownHashes,
          });
          const receipt = appendContextReceipt(dir, {
            operation: "query",
            node: bound.id,
            query: b.query,
            indexDigest: index.digest,
            packDigest: pack.digest,
            revision: pack.revision,
            worktreeDigest: pack.worktreeDigest,
            emittedBytes: pack.stats.emittedBytes,
            emittedChunks: pack.stats.emittedChunks,
            unchangedChunks: pack.stats.unchangedChunks,
          });
          return send(res, 200, { node: bound.id, receipt, pack });
        }
      }
      {
        const m = path.match(/^\/context\/([A-Za-z0-9_.-]+)\/status$/);
        if (req.method === "GET" && m) {
          let bound;
          try { bound = contextNode(dir, m[1]); }
          catch (e) { return send(res, 404, { error: e.message }); }
          const index = loadIndex(contextIndexDir(dir), bound.node.workdir);
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
      }

      if (req.method === "POST" && path === "/jobs") {
        const b = await readBody(req);
        if (!b.plan || !Array.isArray(b.plan.steps)) return send(res, 400, { error: "plan.steps[] is required" });
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

      if (req.method === "POST" && path === "/nodes") {
        const b = await readBody(req);
        if (!b.name) return send(res, 400, { error: "name is required" });
        let caps;
        try { caps = parseCaps(b.caps ?? 15); } catch (e) { return send(res, 400, { error: e.message }); }
        const ttl = parseInt(b.ttlSec ?? 86400, 10);
        if (!(ttl > 0)) return send(res, 400, { error: "ttlSec must be positive seconds" });
        const node = await createNode(dir, {
          name: String(b.name), caps, expiresAt: nowSec() + ttl,
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
          const log = existsSync(p) ? readFileSync(p, "utf8").split("\n").slice(-tail).join("\n") : "";
          return send(res, 200, { stream: stream.replace(".log", ""), tail, log });
        }
      }

      if (req.method === "POST" && path === "/context/receipts/verify") {
        const result = verifyContextReceipts(dir);
        return send(res, result.ok ? 200 : 409, result);
      }

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

      return send(res, 404, { error: "not found" });
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  });

  const wanted = process.env.KILN_SWARM_API_PORT !== undefined
    ? parseInt(process.env.KILN_SWARM_API_PORT, 10)
    : (cfg.apiPort ?? 18787);
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(wanted, "127.0.0.1", () => {
      const port = server.address().port;
      apiPort = port;
      resolve({ server, port, url: `http://127.0.0.1:${port}` });
    });
  });
}
