#!/usr/bin/env node
/**
 * kiln-relay-admin — the public-preview relay that runs on the architect's VPS.
 *
 * One process, Node stdlib only, no npm:
 *
 *   admin API  (127.0.0.1:$RELAY_PORT, default 19191, Bearer token):
 *     POST /register        {slug, port}   -> map slug.$DOMAIN to 127.0.0.1:port
 *     DELETE /register/:slug               -> remove the mapping (idempotent)
 *     GET  /routes                         -> [{slug, port, updatedAt}] (debug)
 *     GET  /ask?domain=...                 -> 200 if the domain may get a cert
 *                                            (Caddy on-demand TLS ask hook)
 *     GET  /health                         -> {ok:true} (no auth)
 *
 *   proxy      (127.0.0.1:$PROXY_PORT, default 8080, plain HTTP):
 *     Host: <slug>.$DOMAIN -> 127.0.0.1:<port>. Unknown slug -> 404 with a
 *     friendly page. WebSocket upgrades are forwarded too.
 *
 * Caddy (installed by setup.sh) terminates TLS with on-demand certificates
 * for *.$DOMAIN on 443 and reverse-proxies to the proxy port. The KILN
 * daemon reaches the admin API through its ssh -L forward, so the admin
 * port is never exposed — 127.0.0.1 only, always.
 *
 * Env:
 *   DOMAIN          (required) e.g. preview.example.com
 *   TOKEN_FILE      path to the bearer token file (default ./admin.token)
 *   REGISTRY_FILE   path to the JSON registry (default ./registry.json)
 *   RELAY_PORT      admin API port (default 19191)
 *   PROXY_PORT      proxy port (default 8080)
 */
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";

const DOMAIN = (process.env.DOMAIN || "").trim().toLowerCase();
if (!DOMAIN) { console.error("kiln-relay-admin: DOMAIN env is required"); process.exit(1); }
const RELAY_PORT = Number(process.env.RELAY_PORT || 19191);
const PROXY_PORT = Number(process.env.PROXY_PORT || 8080);
const TOKEN_FILE = resolve(process.env.TOKEN_FILE || "./admin.token");
const REGISTRY_FILE = resolve(process.env.REGISTRY_FILE || "./registry.json");
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

let TOKEN;
try {
  TOKEN = readFileSync(TOKEN_FILE, "utf8").trim();
} catch (e) {
  console.error(`kiln-relay-admin: cannot read token file ${TOKEN_FILE}: ${e.message}`);
  process.exit(1);
}
if (!TOKEN) { console.error(`kiln-relay-admin: token file ${TOKEN_FILE} is empty`); process.exit(1); }

// ---------------------------------------------------------------- registry

function loadRegistry() {
  try {
    const r = JSON.parse(readFileSync(REGISTRY_FILE, "utf8"));
    if (r && typeof r === "object" && r.slugs && typeof r.slugs === "object") return r;
  } catch { /* fresh */ }
  return { slugs: {} };
}

function saveRegistry(reg) {
  mkdirSync(dirname(REGISTRY_FILE), { recursive: true });
  const tmp = REGISTRY_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(reg, null, 2) + "\n");
  renameSync(tmp, REGISTRY_FILE);
}

let registry = loadRegistry();

// ---------------------------------------------------------------- helpers

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function sendHtml(res, code, title, msg) {
  const body = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
    `<style>body{font-family:system-ui,sans-serif;background:#0b0e14;color:#e6edf3;display:flex;` +
    `align-items:center;justify-content:center;min-height:90vh;margin:0}` +
    `.card{max-width:520px;padding:40px;text-align:center}` +
    `h1{font-size:22px;margin-bottom:12px}p{color:#8b949e;line-height:1.6}` +
    `code{background:#161b22;padding:2px 8px;border-radius:6px}</style></head>` +
    `<body><div class="card"><h1>${title}</h1><p>${msg}</p></div></body></html>`;
  res.writeHead(code, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function checkAuth(req) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return false;
  const p = auth.slice(7);
  return p.length === TOKEN.length && timingSafeEqual(Buffer.from(p), Buffer.from(TOKEN));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 65536) { reject(new Error("body too large")); req.destroy(); return; }
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

/** "foo.preview.example.com" -> "foo"; null when the host isn't ours. */
function slugOfHost(host) {
  const h = String(host || "").split(":")[0].toLowerCase();
  const suffix = "." + DOMAIN;
  if (!h.endsWith(suffix)) return null;
  const slug = h.slice(0, -suffix.length);
  return slug && SLUG_RE.test(slug) ? slug : null;
}

// ---------------------------------------------------------------- admin API

const admin = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    const path = url.pathname;

    if (req.method === "GET" && path === "/health") {
      return sendJson(res, 200, { ok: true, service: "kiln-relay-admin", domain: DOMAIN });
    }
    // Caddy on-demand TLS ask hook: GET /ask?domain=<fqdn> -> 200 = allowed.
    // Only registered slugs get certificates (no certs for strangers).
    if (req.method === "GET" && path === "/ask") {
      const slug = slugOfHost(url.searchParams.get("domain"));
      if (slug && registry.slugs[slug]) return sendJson(res, 200, { ok: true, slug });
      return sendJson(res, 404, { error: "domain not allowed" });
    }

    if (!checkAuth(req)) {
      return sendJson(res, 401, { error: "unauthorized" });
    }

    if (req.method === "POST" && path === "/register") {
      const b = await readBody(req);
      const slug = String(b.slug || "").toLowerCase();
      const port = Number(b.port);
      if (!SLUG_RE.test(slug)) return sendJson(res, 400, { error: "slug must match [a-z0-9-]{1,63}" });
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return sendJson(res, 400, { error: "port must be 1..65535" });
      }
      registry.slugs[slug] = { port, updatedAt: new Date().toISOString() };
      saveRegistry(registry);
      console.log(`[relay ${new Date().toISOString()}] register ${slug} -> 127.0.0.1:${port}`);
      return sendJson(res, 200, { ok: true, slug, port });
    }
    {
      const m = path.match(/^\/register\/([a-z0-9-]+)$/);
      if (req.method === "DELETE" && m) {
        const removed = m[1] in registry.slugs;
        delete registry.slugs[m[1]];
        if (removed) saveRegistry(registry);
        console.log(`[relay ${new Date().toISOString()}] unregister ${m[1]} (was present: ${removed})`);
        return sendJson(res, 200, { ok: true, removed });
      }
    }
    if (req.method === "GET" && path === "/routes") {
      const routes = Object.entries(registry.slugs).map(([slug, r]) => ({ slug, port: r.port, updatedAt: r.updatedAt }));
      return sendJson(res, 200, { routes });
    }
    return sendJson(res, 404, { error: "not found" });
  } catch (e) {
    return sendJson(res, 500, { error: e.message });
  }
});

// ---------------------------------------------------------------- proxy

function proxyRequest(clientReq, clientRes) {
  const slug = slugOfHost(clientReq.headers.host);
  const target = slug ? registry.slugs[slug] : null;
  if (!target) {
    return sendHtml(clientRes, 404, "No such preview",
      `Nothing is published at <code>${String(clientReq.headers.host || "").replace(/</g, "&lt;")}</code> on ${DOMAIN} right now. ` +
      `If you just enabled it, give the tunnel a few seconds — then it shows up here.`);
  }
  const headers = { ...clientReq.headers };
  headers.host = `127.0.0.1:${target.port}`;
  headers["x-forwarded-host"] = clientReq.headers.host || "";
  headers["x-forwarded-proto"] = "https";
  const proxy = httpRequest({
    host: "127.0.0.1", port: target.port,
    method: clientReq.method, path: clientReq.url, headers,
    timeout: 30000,
  }, (proxyRes) => {
    clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(clientRes);
  });
  proxy.on("timeout", () => { proxy.destroy(); });
  proxy.on("error", () => {
    if (!clientRes.headersSent) {
      sendHtml(clientRes, 502, "Preview tunnel is down",
        `The app behind <code>${slug}.${DOMAIN}</code> isn't answering its tunnel right now. ` +
        `The publisher's machine may be offline or restarting — try again in a bit.`);
    }
  });
  clientReq.pipe(proxy);
}

const proxy = createServer(proxyRequest);

proxy.on("upgrade", (clientReq, clientSocket, head) => {
  const slug = slugOfHost(clientReq.headers.host);
  const target = slug ? registry.slugs[slug] : null;
  if (!target) { clientSocket.destroy(); return; }
  const targetSocket = connect(target.port, "127.0.0.1", () => {
    // Re-emit the upgrade request head, then splice the sockets.
    const lines = [`${clientReq.method} ${clientReq.url} HTTP/1.1`];
    for (const [k, v] of Object.entries(clientReq.headers)) {
      if (k.toLowerCase() === "host") { lines.push(`host: 127.0.0.1:${target.port}`); continue; }
      lines.push(`${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
    }
    targetSocket.write(lines.join("\r\n") + "\r\n\r\n");
    if (head && head.length) targetSocket.write(head);
    clientSocket.pipe(targetSocket);
    targetSocket.pipe(clientSocket);
  });
  const kill = () => { try { clientSocket.destroy(); } catch {} try { targetSocket.destroy(); } catch {} };
  clientSocket.on("error", kill);
  targetSocket.on("error", kill);
});

admin.listen(RELAY_PORT, "127.0.0.1", () => {
  console.log(`kiln-relay-admin: admin on 127.0.0.1:${RELAY_PORT}, proxy on 127.0.0.1:${PROXY_PORT}, domain *.${DOMAIN}`);
});
proxy.listen(PROXY_PORT, "127.0.0.1");
