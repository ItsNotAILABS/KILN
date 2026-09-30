/**
 * KILN public previews — Caffeine-style public URLs for compute apps.
 *
 * Every public app gets a URL: https://<slug>.<domain>, served through a
 * relay box the architect controls (his VPS). This VM has no inbound path
 * from the public internet, so the direction is always inside-out:
 *
 *   ssh mode (production):
 *     one supervised `ssh -N` bundle carries ALL of the daemon's preview
 *     tunnels at once:
 *       -R 127.0.0.1:<relayPort>:127.0.0.1:<appPort>   (per public app)
 *       -L 127.0.0.1:<adminLocal>:127.0.0.1:19191       (relay admin channel)
 *     The relay's admin API (token-auth, reached through the -L forward)
 *     maps slug -> relayPort; Caddy on the VPS terminates TLS (on-demand)
 *     for *.<domain> and reverse-proxies to the admin's built-in proxy.
 *
 *   direct mode (TEST ONLY — loopback validation on one box):
 *     the "bundle" is a tiny Node TCP pipe relayPort -> appPort per app,
 *     and relayAdminUrl points straight at a locally-running relay admin.
 *     The ssh hop is the one untested link in this mode; it is commodity
 *     `ssh -R`, exercised by hand on first VPS setup.
 *
 * Supervision: a reconciler (started by httpapi, every 10s) ensures the
 * bundle child matches the desired set. Desired state lives in the compute
 * store's `previews` key (compute.json): { [appId]: {slug, relayPort,
 * enabled, updatedAt} }. Sidecar children carry KILN_PREVIEW_SIDECAR=<nonce>
 * in their environ so a new daemon boot can tell its own children from
 * orphans (pidIsDaemon-style check) and reap the orphans.
 *
 * Stdlib only. Never logs the relay admin token.
 */
import { spawn } from "node:child_process";
import { existsSync, statSync, readdirSync, readFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { loadStore, saveStore, appConfig, ComputeError } from "./compute.mjs";
import { pidAlive } from "./state.mjs";

const SIDECAR_ENV = "KILN_PREVIEW_SIDECAR";
export const RECONCILE_MS = 10000;
const ADMIN_REMOTE_PORT = 19191; // relay admin's port on the VPS (setup.sh default)
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// ---------------------------------------------------------------- config

function parsePortRange(s) {
  const m = /^(\d+)-(\d+)$/.exec(String(s || "").trim());
  if (!m) throw new ComputeError(400, `preview.portRange must look like "19000-19099"`);
  const lo = Number(m[1]), hi = Number(m[2]);
  if (lo < 1 || hi > 65535 || lo > hi || hi - lo > 1000) {
    throw new ComputeError(400, `preview.portRange out of bounds: ${s}`);
  }
  return { lo, hi };
}

function parseAdminUrl(s) {
  let port = ADMIN_REMOTE_PORT;
  try {
    const u = new URL(String(s));
    if (u.protocol !== "http:") throw new Error("must be http://");
    port = u.port ? Number(u.port) : 80;
  } catch (e) {
    throw new ComputeError(400, `preview.relayAdminUrl invalid: ${e.message || e}`);
  }
  return { url: String(s).replace(/\/+$/, ""), localPort: port };
}

/** ssh://user@host[:port] (also accepts bare user@host). */
function parseSshTarget(s) {
  let t = String(s || "").trim();
  if (!t) throw new ComputeError(400, `preview.relay must be an ssh target like "ssh://user@host"`);
  if (t.startsWith("ssh://")) t = t.slice(6);
  const m = /^(?:([^@:/\s]+)@)?([^:/\s]+)(?::(\d+))?$/.exec(t);
  if (!m || !m[2]) throw new ComputeError(400, `preview.relay: cannot parse ssh target ${JSON.stringify(s)}`);
  const port = m[3] ? Number(m[3]) : 22;
  if (port < 1 || port > 65535) throw new ComputeError(400, "preview.relay: bad ssh port");
  return { user: m[1] || "root", host: m[2], port };
}

function checkKeyFile(path) {
  if (!existsSync(path)) {
    throw new ComputeError(503, `preview ssh key not found: ${path}`);
  }
  let mode = 0;
  try { mode = statSync(path).mode & 0o777; } catch (e) {
    throw new ComputeError(503, `preview ssh key unreadable: ${path}: ${e.message}`);
  }
  // ssh itself refuses group/world-readable keys ("bad permissions"); fail
  // here with the actionable message instead of a cryptic ssh exit.
  if (mode & 0o077) {
    throw new ComputeError(503,
      `preview ssh key ${path} has mode ${mode.toString(8)} — must be 0600 or 0400 (ssh refuses anything looser)`);
  }
}

/**
 * Normalized preview config, or null when the `preview` key is absent
 * (previews unavailable; apps still deploy privately). Throws 400 when the
 * key is present but invalid.
 */
export function previewConfig(cfg) {
  const p = cfg && cfg.preview;
  if (!p || typeof p !== "object") return null;
  const mode = p.mode || "ssh";
  if (mode !== "ssh" && mode !== "direct") {
    throw new ComputeError(400, `preview.mode must be "ssh" or "direct", got ${JSON.stringify(p.mode)}`);
  }
  const domain = String(p.domain || "").trim().toLowerCase();
  if (!/^[a-z0-9]([a-z0-9.-]{0,61}[a-z0-9])?$/.test(domain)) {
    throw new ComputeError(400, "preview.domain is required (e.g. \"preview.example.com\")");
  }
  const admin = parseAdminUrl(p.relayAdminUrl || `http://127.0.0.1:${ADMIN_REMOTE_PORT}`);
  const token = String(p.relayAdminToken || "");
  if (!token) throw new ComputeError(400, "preview.relayAdminToken is required");
  const out = {
    mode,
    domain,
    portRange: parsePortRange(p.portRange || "19000-19099"),
    relayAdminUrl: admin.url,
    relayAdminLocalPort: admin.localPort,
    relayAdminToken: token, // never logged
  };
  if (mode === "ssh") {
    out.ssh = parseSshTarget(p.relay);
    out.key = String(p.key || "");
    if (!out.key) throw new ComputeError(400, "preview.key (ssh private key path) is required in ssh mode");
    checkKeyFile(out.key);
  }
  return out;
}

// ---------------------------------------------------------------- store helpers

function allocSlug(store, appName) {
  const taken = new Set(Object.values(store.previews || {}).map((r) => r.slug));
  let base = String(appName || "app").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "app";
  if (!/^[a-z0-9]/.test(base)) base = "app-" + base;
  let slug = base, i = 2;
  while (taken.has(slug) || !SLUG_RE.test(slug)) {
    slug = `${base.slice(0, 48)}-${i++}`;
  }
  return slug;
}

function portFreeLocal(port) {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

async function allocPort(store, range) {
  const taken = new Set(Object.values(store.previews || {}).map((r) => r.relayPort).filter(Boolean));
  for (let p = range.lo; p <= range.hi; p++) {
    if (taken.has(p)) continue;
    // eslint-disable-next-line no-await-in-loop
    if (await portFreeLocal(p)) return p;
  }
  throw new ComputeError(503, `preview relay port range ${range.lo}-${range.hi} exhausted`);
}

function probeTcp(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const sock = createConnection({ host: "127.0.0.1", port, timeout: timeoutMs });
    const done = (ok) => { try { sock.destroy(); } catch {} resolve(ok); };
    sock.on("connect", () => done(true));
    sock.on("timeout", () => done(false));
    sock.on("error", () => done(false));
  });
}

async function relayCall(pc, method, path, body) {
  let res;
  try {
    res = await fetch(pc.relayAdminUrl + path, {
      method,
      headers: {
        // The token travels in a header, never in logs or URLs.
        "authorization": `Bearer ${pc.relayAdminToken}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    throw new Error(`relay admin unreachable at ${pc.relayAdminUrl}${path}: ${e.message}`);
  }
  if (!res.ok) throw new Error(`relay admin ${method} ${path}: HTTP ${res.status}`);
  return res.json().catch(() => ({}));
}

// ---------------------------------------------------------------- sidecar supervision

let bundle = null; // {pid, nonce, signature, apps:[appId], startedAtMs, failCount, nextRetryAtMs}
let reconcilePromise = null;
let booted = false;

function bundleEnvNonce(pid, nonce) {
  try {
    const env = readFileSync(`/proc/${pid}/environ`, "utf8");
    return env.includes(`${SIDECAR_ENV}=${nonce}`);
  } catch {
    return false;
  }
}

function bundleAlive() {
  return !!(bundle && pidAlive(bundle.pid) && bundleEnvNonce(bundle.pid, bundle.nonce));
}

/** Kill any sidecar orphans from a previous daemon boot (they hold our env marker). */
function killStaleSidecars(log) {
  let killed = 0;
  try {
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      if (pid === process.pid) continue;
      try {
        const env = readFileSync(`/proc/${pid}/environ`, "utf8");
        if (env.includes(`${SIDECAR_ENV}=`)) {
          try { process.kill(pid, "SIGTERM"); killed++; } catch {}
        }
      } catch { /* raced away */ }
    }
  } catch { /* non-Linux: skip */ }
  if (killed && log) log(`preview: reaped ${killed} orphan sidecar(s) from a previous boot`);
}

function killBundle(log, why) {
  if (!bundle) return;
  try { process.kill(bundle.pid, "SIGTERM"); } catch {}
  if (log) log(`preview: sidecar bundle pid=${bundle.pid} stopped (${why})`);
  bundle = null;
}

function directPipeSource() {
  return `
const net = require("node:net");
let pairs = [];
try { pairs = JSON.parse(process.env.KILN_PREVIEW_PAIRS || "[]"); } catch (e) { console.error("bad KILN_PREVIEW_PAIRS"); process.exit(2); }
for (const [lp, tp] of pairs) {
  const srv = net.createServer((src) => {
    const dst = net.connect(tp, "127.0.0.1");
    const kill = () => { try { src.destroy(); } catch {} try { dst.destroy(); } catch {} };
    src.on("error", kill); dst.on("error", kill);
    src.pipe(dst); dst.pipe(src);
  });
  srv.on("error", (e) => { console.error("preview pipe listen failed on " + lp + ": " + e.message); process.exit(2); });
  srv.listen(lp, "127.0.0.1");
}
setInterval(() => {}, 1 << 30);
`;
}

function spawnBundle(pc, forwards, log) {
  const nonce = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const env = { ...process.env, [SIDECAR_ENV]: nonce };
  let child;
  if (pc.mode === "direct") {
    env.KILN_PREVIEW_PAIRS = JSON.stringify(forwards.map((f) => [f.relayPort, f.appPort]));
    child = spawn(process.execPath, ["-e", directPipeSource()], {
      env, stdio: ["ignore", "ignore", "ignore"],
    });
  } else {
    const a = [
      "-N", "-T",
      "-o", "BatchMode=yes",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=30",
      "-o", "ServerAliveCountMax=3",
      "-o", "ConnectTimeout=15",
      "-o", "StrictHostKeyChecking=accept-new",
      "-i", pc.key,
    ];
    if (pc.ssh.port !== 22) a.push("-p", String(pc.ssh.port));
    // Admin channel first: the daemon registers slugs through it.
    a.push("-L", `127.0.0.1:${pc.relayAdminLocalPort}:127.0.0.1:${ADMIN_REMOTE_PORT}`);
    for (const f of forwards) {
      a.push("-R", `127.0.0.1:${f.relayPort}:127.0.0.1:${f.appPort}`);
    }
    a.push(`${pc.ssh.user}@${pc.ssh.host}`);
    if (log) log(`preview: spawning ssh bundle (${forwards.length} tunnel(s)) -> ${pc.ssh.user}@${pc.ssh.host}`);
    child = spawn("ssh", a, { env, stdio: ["ignore", "ignore", "ignore"] });
  }
  child.unref();
  child.on("error", (e) => { if (log) log(`preview: sidecar spawn error: ${e.message}`); });
  return { pid: child.pid, nonce };
}

/**
 * Reconcile the sidecar bundle with desired state. Idempotent; safe to call
 * often. Returns after one pass.
 */
export async function reconcilePreviews(dir, cfg, log = null) {
  if (reconcilePromise) return reconcilePromise;
  reconcilePromise = (async () => {
    const say = log || (() => {});
    if (!booted) { killStaleSidecars(say); booted = true; }
    let pc = null;
    try {
      pc = previewConfig(cfg);
    } catch (e) {
      say(`preview: bad config (${e.message}) — previews disabled until fixed`);
      killBundle(say, "bad config");
      return;
    }
    if (!pc) { killBundle(say, "relay not configured"); return; }

    const store = loadStore(dir);
    store.previews = store.previews || {};
    // Prune records whose app is gone or portless (e.g. undeployed).
    let dirty = false;
    for (const [appId, rec] of Object.entries(store.previews)) {
      let appPort = null;
      try { appPort = appConfig(dir, appId).port || null; } catch { appPort = null; }
      if (!appPort) {
        try { await relayCall(pc, "DELETE", `/register/${rec.slug}`); } catch (e) { say(`preview: unregister ${rec.slug} failed: ${e.message}`); }
        delete store.previews[appId];
        dirty = true;
        say(`preview: dropped stale record for ${appId} (app gone or portless)`);
      }
    }
    if (dirty) saveStore(dir, store);

    const desired = [];
    for (const [appId, rec] of Object.entries(store.previews)) {
      if (!rec.enabled) continue;
      const appPort = appConfig(dir, appId).port;
      if (!rec.relayPort) {
        // eslint-disable-next-line no-await-in-loop
        rec.relayPort = await allocPort(store, pc.portRange);
        rec.updatedAt = new Date().toISOString();
        saveStore(dir, store);
      }
      desired.push({ appId, slug: rec.slug, relayPort: rec.relayPort, appPort });
    }
    desired.sort((a, b) => a.relayPort - b.relayPort);
    const signature = JSON.stringify({
      mode: pc.mode,
      target: pc.mode === "ssh" ? `${pc.ssh.user}@${pc.ssh.host}:${pc.ssh.port}` : "direct",
      fw: desired.map((d) => [d.relayPort, d.appPort]),
    });

    if (!desired.length) { killBundle(say, "no public apps"); return; }
    if (bundleAlive() && bundle.signature === signature) return; // healthy
    if (bundle && bundle.failCount >= 5 && Date.now() < (bundle.nextRetryAtMs || 0)) return; // backing off

    // (Re)spawn the bundle carrying every tunnel at once.
    const prevFail = bundle && bundle.signature === signature ? bundle.failCount : 0;
    killBundle(say, "desired set changed");
    const { pid, nonce } = spawnBundle(pc, desired, say);
    bundle = {
      pid, nonce, signature,
      apps: desired.map((d) => d.appId),
      startedAtMs: Date.now(), failCount: prevFail, nextRetryAtMs: 0,
    };
    const up = await (async () => {
      if (pc.mode === "direct") {
        await new Promise((r) => setTimeout(r, 700));
        return pidAlive(pid) && bundleEnvNonce(pid, nonce);
      }
      // ssh mode: the bundle is up when the -L admin channel answers.
      const t0 = Date.now();
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        if (await probeTcp(pc.relayAdminLocalPort, 800)) return true;
        if (!pidAlive(pid)) return false;
        if (Date.now() - t0 > 20000) return false;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 500));
      }
    })();
    if (!up) {
      bundle.failCount += 1;
      const backoffMs = Math.min(300000, 15000 * bundle.failCount);
      bundle.nextRetryAtMs = Date.now() + backoffMs;
      say(`preview: sidecar failed to come up (attempt ${bundle.failCount}) — retry in ${Math.round(backoffMs / 1000)}s`);
      try { process.kill(pid, "SIGTERM"); } catch {}
      return;
    }
    bundle.failCount = 0;

    // Converge the relay registry to the desired set (idempotent).
    try {
      const routes = await relayCall(pc, "GET", "/routes");
      const want = new Map(desired.map((d) => [d.slug, d.relayPort]));
      const have = new Map((routes.routes || []).map((r) => [r.slug, r.port]));
      for (const slug of have.keys()) {
        if (!want.has(slug)) {
          try { await relayCall(pc, "DELETE", `/register/${slug}`); say(`preview: removed stale relay route ${slug}`); }
          catch (e) { say(`preview: stale route cleanup ${slug} failed: ${e.message}`); }
        }
      }
      for (const [slug, port] of want) {
        if (have.get(slug) !== port) {
          await relayCall(pc, "POST", "/register", { slug, port });
        }
      }
      say(`preview: ${desired.length} tunnel(s) up: ${desired.map((d) => `${d.slug}->:${d.relayPort}`).join(", ")}`);
    } catch (e) {
      say(`preview: relay registration failed: ${e.message}`);
    }
  })().finally(() => { reconcilePromise = null; });
  return reconcilePromise;
}

// ---------------------------------------------------------------- API surface

function viewFor(store, pc, appId) {
  const rec = (store.previews || {})[appId];
  if (!rec) return { enabled: false, url: null, relayPort: null, wanted: false };
  const effective = !!(rec.enabled && pc && bundleAlive() && bundle.apps && bundle.apps.includes(appId));
  const url = effective ? `https://${rec.slug}.${pc.domain}` : null;
  const v = { enabled: effective, url, relayPort: rec.relayPort || null, wanted: !!rec.enabled };
  if (rec.enabled && !pc) v.note = "preview relay not configured";
  else if (rec.enabled && !effective) v.note = "tunnel down — reconciler retrying";
  return v;
}

/** Attach previewUrl + preview to an appStatus-shaped object. */
export function withPreview(dir, cfg, appObj) {
  let pc = null;
  try { pc = previewConfig(cfg); } catch { pc = null; }
  const store = loadStore(dir);
  const pv = viewFor(store, pc, appObj.appId);
  return { ...appObj, previewUrl: pv.url, preview: pv };
}

/** Enable preview for an app (POST /v1/compute/apps/:id/preview). */
export async function enablePreview(dir, cfg, appId, log = null) {
  const pc = previewConfig(cfg);
  if (!pc) throw new ComputeError(503, "preview relay not configured");
  const app = appConfig(dir, appId); // 404 if unknown
  if (!app.port) throw new ComputeError(400, "app has no port — preview needs a TCP port to forward");
  const store = loadStore(dir);
  store.previews = store.previews || {};
  const rec = store.previews[appId] || {};
  if (!rec.slug) rec.slug = allocSlug(store, app.name);
  if (!SLUG_RE.test(rec.slug)) rec.slug = allocSlug(store, app.name);
  if (!rec.relayPort) rec.relayPort = await allocPort(store, pc.portRange);
  rec.enabled = true;
  rec.updatedAt = new Date().toISOString();
  store.previews[appId] = rec;
  saveStore(dir, store);
  try {
    await reconcilePreviews(dir, cfg, log);
  } catch (e) {
    if (log) log(`preview: eager reconcile failed: ${e.message}`);
  }
  return withPreview(dir, cfg, { appId, name: app.name });
}

/** Disable preview for an app (DELETE /v1/compute/apps/:id/preview). */
export async function disablePreview(dir, cfg, appId, log = null) {
  appConfig(dir, appId); // 404 if unknown
  const store = loadStore(dir);
  store.previews = store.previews || {};
  const rec = store.previews[appId];
  if (rec) {
    let pc = null;
    try { pc = previewConfig(cfg); } catch { pc = null; }
    if (pc && bundleAlive()) {
      try { await relayCall(pc, "DELETE", `/register/${rec.slug}`); }
      catch (e) { if (log) log(`preview: unregister ${rec.slug} failed: ${e.message}`); }
    }
    delete store.previews[appId];
    saveStore(dir, store);
  }
  try {
    await reconcilePreviews(dir, cfg, log);
  } catch (e) {
    if (log) log(`preview: reconcile after disable failed: ${e.message}`);
  }
  return { ok: true, appId };
}

/** Silent variant for the undeploy path (app record may already be gone). */
export async function teardownPreview(dir, cfg, appId, log = null) {
  try {
    await disablePreview(dir, cfg, appId, log);
  } catch (e) {
    if (!(e instanceof ComputeError && e.status === 404) && log) {
      log(`preview: teardown for ${appId}: ${e.message}`);
    }
  }
}

/** Start the periodic reconciler. Call once from the API server. */
export function startPreviewReconciler(dir, cfg, log) {
  const say = (...a) => { try { (log || console.log)(...a); } catch {} };
  const timer = setInterval(() => {
    reconcilePreviews(dir, cfg, say).catch((e) => say(`preview: reconciler error: ${e.message}`));
  }, RECONCILE_MS);
  if (timer.unref) timer.unref();
  // First pass soon after boot (also reaps orphans from a previous daemon).
  setTimeout(() => {
    reconcilePreviews(dir, cfg, say).catch((e) => say(`preview: reconciler error: ${e.message}`));
  }, 3000);
  return {
    stop() {
      clearInterval(timer);
      if (bundle) { try { process.kill(bundle.pid, "SIGTERM"); } catch {} bundle = null; }
    },
  };
}

/** Test hook: current bundle state (no secrets). */
export function _bundleState() {
  return bundle ? { pid: bundle.pid, apps: bundle.apps, signature: bundle.signature, alive: bundleAlive() } : null;
}
