/**
 * HTTP surface for KILN virtual computers.
 *
 * Operator API (bearer-gated, mounted under the operator-only gate in
 * httpapi.mjs — same trust model as /v1/compute):
 *   POST   /v1/vcomputers                     create + start {name, backend?, width?, height?, cpus?, memoryMB?, diskMB?, idleTimeoutSec?, browser?, network?}
 *   GET    /v1/vcomputers                     list
 *   GET    /v1/vcomputers/doctor              health: backends, image, per-computer problems
 *   GET    /v1/vcomputers/:id                 one computer
 *   DELETE /v1/vcomputers/:id?purge=true      remove (purge also deletes the home)
 *   POST   /v1/vcomputers/:id/start|stop
 *   GET    /v1/vcomputers/:id/screenshot      {png (base64), width, height}; ?format=png -> image/png
 *   POST   /v1/vcomputers/:id/input           {action: move|click|type|key|scroll|drag, ...}
 *   POST   /v1/vcomputers/:id/exec            {command, timeoutMs?, cwd?, stdin?, background?}
 *   GET    /v1/vcomputers/:id/jobs            background jobs
 *   GET    /v1/vcomputers/:id/jobs/:jobId     status + ?tail=bytes of output
 *   POST   /v1/vcomputers/:id/jobs/:jobId/kill
 *   POST   /v1/vcomputers/:id/handoff         {reason, instructions?, timeoutSec?} -> {handoff, url}
 *   GET    /v1/vcomputers/:id/handoff?waitMs= current hand-off (long-poll until it ends)
 *   DELETE /v1/vcomputers/:id/handoff         agent withdraws it
 *   GET    /v1/vcomputers/:id/toolcheck       pinned toolchain versions inside the machine
 *
 * Owner hand-off (NOT bearer-gated — the unguessable token in the path is
 * the capability; registered before the auth gate):
 *   GET  /handoff/:token                      the page: banner + live desktop + "hand back"
 *   POST /handoff/:token/return               {outcome: done|could_not_finish}
 *   WS   /handoff/:token/websockify           proxied to the machine's websockify
 *   GET  /handoff-assets/novnc/*              noVNC client files (public library code)
 */
import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { connect } from "node:net";
import { join, extname, sep } from "node:path";
import { randomBytes } from "node:crypto";
import {
  createComputer, listComputers, getComputer, startComputer, stopComputer, deleteComputer,
  screenshot, input, execCommand, listJobs, getJob, killJob,
  requestHandoff, getHandoff, cancelHandoff, ownerOpen, ownerReturn, ownerViewer,
  vcomputerHealth, toolcheck, VcError, HandoffError,
} from "./vcomputer.mjs";

const ID = "(vc_[0-9a-f]{12})";
const TOKEN_RE = /^\/handoff\/([A-Za-z0-9_-]{20,100})(\/return|\/websockify)?$/;

export function novncDir() {
  return process.env.KILN_VC_NOVNC_DIR || "/usr/share/novnc";
}

export function isVcError(e) {
  return e instanceof VcError || e instanceof HandoffError;
}

// ---------------------------------------------------------------- operator API

export async function handleVcomputerApi(req, res, path, url, dir, { send, readBody, baseUrl }) {
  if (path !== "/v1/vcomputers" && !path.startsWith("/v1/vcomputers/")) return false;
  try {
    const m = (re) => path.match(new RegExp(`^/v1/vcomputers/${ID}${re}$`));
    const M = req.method;
    let x;

    if (M === "POST" && path === "/v1/vcomputers") {
      return send(res, 201, await createComputer(dir, await readBody(req))), true;
    }
    if (M === "GET" && path === "/v1/vcomputers") {
      return send(res, 200, { computers: await listComputers(dir) }), true;
    }
    if (M === "GET" && path === "/v1/vcomputers/doctor") {
      return send(res, 200, await vcomputerHealth(dir)), true;
    }
    if ((x = m(""))) {
      if (M === "GET") return send(res, 200, await getComputer(dir, x[1])), true;
      if (M === "DELETE") {
        return send(res, 200, await deleteComputer(dir, x[1], { purge: url.searchParams.get("purge") === "true" })), true;
      }
    }
    if (M === "POST" && (x = m("/start"))) return send(res, 200, await startComputer(dir, x[1])), true;
    if (M === "POST" && (x = m("/stop"))) return send(res, 200, await stopComputer(dir, x[1])), true;
    if (M === "GET" && (x = m("/screenshot"))) {
      const shot = await screenshot(dir, x[1]);
      if (url.searchParams.get("format") === "png") {
        res.writeHead(200, {
          "content-type": "image/png", "content-length": shot.png.length,
          "x-kiln-width": String(shot.width), "x-kiln-height": String(shot.height),
          "cache-control": "no-store",
        });
        res.end(shot.png);
        return true;
      }
      return send(res, 200, { width: shot.width, height: shot.height, format: "png", png: shot.png.toString("base64") }), true;
    }
    if (M === "POST" && (x = m("/input"))) return send(res, 200, await input(dir, x[1], await readBody(req))), true;
    if (M === "POST" && (x = m("/exec"))) {
      const b = await readBody(req);
      return send(res, b.background ? 202 : 200, await execCommand(dir, x[1], b)), true;
    }
    if (M === "GET" && (x = m("/jobs"))) return send(res, 200, { jobs: await listJobs(dir, x[1]) }), true;
    if (M === "GET" && (x = m("/jobs/(job_[0-9a-f]{12})"))) {
      const tail = url.searchParams.has("tail") ? parseInt(url.searchParams.get("tail"), 10) : 16384;
      return send(res, 200, await getJob(dir, x[1], x[2], { tailBytes: tail })), true;
    }
    if (M === "POST" && (x = m("/jobs/(job_[0-9a-f]{12})/kill"))) return send(res, 200, await killJob(dir, x[1], x[2])), true;
    if ((x = m("/handoff"))) {
      if (M === "POST") return send(res, 201, await requestHandoff(dir, x[1], await readBody(req), { baseUrl: baseUrl() })), true;
      if (M === "GET") {
        const waitMs = url.searchParams.has("waitMs") ? parseInt(url.searchParams.get("waitMs"), 10) : 0;
        return send(res, 200, await getHandoff(dir, x[1], { waitMs })), true;
      }
      if (M === "DELETE") return send(res, 200, { handoff: await cancelHandoff(dir, x[1], "agent") }), true;
    }
    if (M === "GET" && (x = m("/toolcheck"))) return send(res, 200, await toolcheck(dir, x[1])), true;
    return send(res, 404, { error: "not found" }), true;
  } catch (e) {
    if (isVcError(e)) return send(res, e.status, { error: e.message }), true;
    throw e;
  }
}

// ---------------------------------------------------------------- owner page

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const PAGE_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer", // the token is in the URL
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
};

function sendHtml(res, code, html, nonce) {
  res.writeHead(code, {
    ...PAGE_HEADERS,
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    "content-security-policy": `default-src 'self'; script-src 'self'${nonce ? ` 'nonce-${nonce}'` : ""}; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
  });
  res.end(html);
}

function endedPage(msg) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>KILN hand-off</title>
<body style="font:16px system-ui;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0"><p>${esc(msg)}</p></body>`;
}

export function handoffPage({ vc, handoff, password, token }) {
  const nonce = randomBytes(12).toString("base64");
  const cfg = JSON.stringify({
    ws: `/handoff/${token}/websockify`, ret: `/handoff/${token}/return`, password,
    expiresAt: handoff.expiresAt,
  }).replace(/</g, "\\u003c");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>KILN hand-off — ${esc(vc.name)}</title>
<style>
  html,body{margin:0;height:100%;background:#0d0d0d;color:#eee;font:15px system-ui,sans-serif}
  #bar{position:fixed;top:0;left:0;right:0;z-index:2;background:#1b2b1f;border-bottom:2px solid #3fbf6f;padding:10px 14px;display:flex;gap:14px;align-items:center;flex-wrap:wrap}
  #bar .what{flex:1 1 320px;min-width:0}
  #bar b{font-size:16px}
  #bar .ins{white-space:pre-wrap;opacity:.9;margin-top:4px}
  #bar .meta{font-size:12px;opacity:.7;margin-top:4px}
  button{font:inherit;padding:8px 14px;border-radius:6px;border:0;cursor:pointer}
  #done{background:#3fbf6f;color:#06140b;font-weight:600}
  #fail{background:#333;color:#eee}
  #screen{position:absolute;left:0;right:0;bottom:0}
  #status{font-size:12px;opacity:.75}
</style></head>
<body>
<div id="bar">
  <div class="what">
    <b>${esc(handoff.reason)}</b>
    ${handoff.instructions ? `<div class="ins">${esc(handoff.instructions)}</div>` : ""}
    <div class="meta">You're controlling <b>${esc(vc.name)}</b>. The agent is paused and can't see the screen until you hand it back. Nothing you type here is recorded by KILN. <span id="status">connecting…</span></div>
  </div>
  <button id="fail" type="button">I couldn't finish</button>
  <button id="done" type="button">Done — hand back</button>
</div>
<div id="screen"></div>
<script nonce="${nonce}" type="module">
  import RFB from "/handoff-assets/novnc/core/rfb.js";
  const C = ${cfg};
  const bar = document.getElementById("bar"), screen = document.getElementById("screen"), status = document.getElementById("status");
  const fit = () => { screen.style.top = bar.offsetHeight + "px"; };
  fit(); addEventListener("resize", fit);
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const rfb = new RFB(screen, proto + "//" + location.host + C.ws, { credentials: { password: C.password } });
  rfb.scaleViewport = true; rfb.resizeSession = false; rfb.focusOnClick = true;
  rfb.addEventListener("connect", () => { status.textContent = "connected"; rfb.focus(); });
  rfb.addEventListener("disconnect", (e) => { status.textContent = e.detail.clean ? "disconnected" : "connection lost — reload to reconnect"; });
  const left = () => Math.max(0, Math.round((C.expiresAt - Date.now()) / 60000));
  setInterval(() => { if (status.textContent === "connected") status.title = left() + " min left"; }, 10000);
  async function back(outcome) {
    for (const b of document.querySelectorAll("button")) b.disabled = true;
    try { rfb.disconnect(); } catch {}
    const r = await fetch(C.ret, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ outcome }) });
    document.body.innerHTML = r.ok
      ? '<p style="padding:40px;text-align:center">Handed back. The agent has the computer again — you can close this tab.</p>'
      : '<p style="padding:40px;text-align:center">This hand-off already ended.</p>';
  }
  document.getElementById("done").onclick = () => back("done");
  document.getElementById("fail").onclick = () => back("could_not_finish");
</script>
</body></html>`;
  return { html, nonce };
}

const MIME = { ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".html": "text/html; charset=utf-8", ".ico": "image/x-icon", ".ttf": "font/ttf", ".woff": "font/woff", ".woff2": "font/woff2" };

function serveNovnc(req, res, rel, send) {
  const root = novncDir();
  if (!existsSync(root)) return send(res, 503, { error: `noVNC is not installed (looked in ${root}; set KILN_VC_NOVNC_DIR)` });
  let full;
  try {
    const rootReal = realpathSync(root);
    full = realpathSync(join(rootReal, decodeURIComponent(rel)));
    if (!full.startsWith(rootReal + sep) || !statSync(full).isFile()) throw new Error("outside");
  } catch {
    return send(res, 404, { error: "not found" });
  }
  res.writeHead(200, {
    "content-type": MIME[extname(full)] || "application/octet-stream",
    "cache-control": "public, max-age=3600",
    "x-content-type-options": "nosniff",
  });
  createReadStream(full).pipe(res);
}

/**
 * Pre-auth routes for the owner. Returns true when it handled the request.
 * Logs nothing about the token or the request body.
 */
export async function handleHandoffPublic(req, res, path, dir, { send, readBody }) {
  if (req.method === "GET" && path.startsWith("/handoff-assets/novnc/")) {
    serveNovnc(req, res, path.slice("/handoff-assets/novnc/".length), send);
    return true;
  }
  const m = path.match(TOKEN_RE);
  if (!m) return false;
  const [, token, sub] = m;
  try {
    if (req.method === "GET" && !sub) {
      const opened = await ownerOpen(dir, token);
      const { html, nonce } = handoffPage({ ...opened, token });
      sendHtml(res, 200, html, nonce);
      return true;
    }
    if (req.method === "POST" && sub === "/return") {
      const b = await readBody(req).catch(() => ({}));
      const h = await ownerReturn(dir, token, b && b.outcome);
      res.setHeader("cache-control", "no-store");
      send(res, 200, { ok: true, state: h.state, outcome: h.outcome });
      return true;
    }
    send(res, 404, { error: "not found" });
    return true;
  } catch (e) {
    if (isVcError(e)) {
      if (req.method === "GET") sendHtml(res, e.status, endedPage(e.status === 404 ? "This hand-off link isn't valid." : "This hand-off has ended. You can close this tab."));
      else send(res, e.status, { error: e.message });
      return true;
    }
    throw e;
  }
}

/**
 * WebSocket upgrade for /handoff/:token/websockify -> the machine's
 * websockify, as a raw byte pipe (KILN never parses the RFB stream, so it
 * never sees keystrokes). Returns false when the path isn't ours.
 */
export function handleHandoffUpgrade(req, socket, head, dir) {
  const path = new URL(req.url, "http://127.0.0.1").pathname;
  const m = path.match(TOKEN_RE);
  if (!m || m[2] !== "/websockify") return false;
  const deny = (code, msg) => {
    try { socket.end(`HTTP/1.1 ${code} ${msg}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`); } catch {}
    return true;
  };
  const origin = req.headers.origin;
  if (origin) {
    let ok = false;
    try { ok = new URL(origin).host === req.headers.host; } catch {}
    if (!ok) return deny(403, "Forbidden");
  }
  let viewer;
  try { viewer = ownerViewer(dir, m[1]); } catch { viewer = null; }
  if (!viewer) return deny(404, "Not Found");
  const up = connect(viewer.wsPort, viewer.wsHost, () => {
    let h = "GET /websockify HTTP/1.1\r\n";
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i].toLowerCase();
      if (k === "host") { h += `Host: ${viewer.wsHost}:${viewer.wsPort}\r\n`; continue; }
      if (k === "origin" || k === "cookie" || k === "authorization") continue;
      h += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    up.write(h + "\r\n");
    if (head && head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  const close = () => { try { up.destroy(); } catch {} try { socket.destroy(); } catch {} };
  up.on("error", close);
  socket.on("error", close);
  up.on("close", close);
  socket.on("close", close);
  return true;
}
