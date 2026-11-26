/**
 * transfer-relay.mjs — a blind forwarding relay plus a rendezvous for
 * hole punching.
 *
 * The relay never decrypts. After a short plaintext pairing header
 * (`RELAY_OPEN` / `RELAY_OK`), it copies raw bytes in both directions.
 * Peers still run the X25519 + AES-256-GCM handshake through the pipe,
 * so end-to-end authentication and confidentiality do not depend on the
 * relay.
 *
 * The same process is a rendezvous: peers announce listen addresses and
 * learn each other's observed address, then try a direct TCP dial and
 * fall back to the relay if the punch does not land in time.
 */
import net from "node:net";
import { randomBytes } from "node:crypto";
import { FramedConn, TRANSPORTS, T, jsonPayload, parseJson } from "./transfer-wire.mjs";

export const RELAY_OPEN = 30;
export const RELAY_OK = 31;
export const RELAY_ERR = 32;
export const REND_ANNOUNCE = 33;
export const REND_PEERS = 34;

export class RelayError extends Error {}

function readFrame(sock) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 4) return;
      const n = buf.readUInt32BE(0);
      if (n < 1 || n > 1 << 20) { cleanup(); reject(new RelayError(`bad relay frame ${n}`)); return; }
      if (buf.length < 4 + n) return;
      cleanup();
      const rest = buf.subarray(4 + n);
      if (rest.length) sock.unshift(rest);
      resolve({ type: buf[4], payload: buf.subarray(5, 4 + n) });
    };
    const onClose = () => { cleanup(); reject(new RelayError("relay connection closed during handshake")); };
    const cleanup = () => { sock.off("data", onData); sock.off("error", onClose); sock.off("close", onClose); };
    sock.on("data", onData); sock.on("error", onClose); sock.on("close", onClose);
  });
}

function writeFrame(sock, type, obj) {
  const payload = jsonPayload(obj);
  const h = Buffer.allocUnsafe(5 + payload.length);
  h.writeUInt32BE(1 + payload.length, 0);
  h[4] = type;
  payload.copy(h, 5);
  sock.write(h);
}

function splice(a, b) {
  const pipe = (from, to) => {
    from.on("data", (d) => { if (!to.destroyed) to.write(d); });
    from.on("close", () => { if (!to.destroyed) to.end(); });
    from.on("error", () => { if (!to.destroyed) to.destroy(); });
  };
  pipe(a, b); pipe(b, a);
}

/**
 * Start a relay/rendezvous listener. Returns { host, port, stats, close }.
 * `stats.pairs` counts successfully spliced pairs; `stats.bytes` is an
 * approximate forwarded byte count (both directions).
 */
export async function startRelay({ host = "127.0.0.1", port = 0 } = {}) {
  const waits = new Map(); // token -> array of waiting sockets (recv first)
  const rend = new Map(); // token -> { recv?: info, send?: info, waiters: [] }
  const stats = { pairs: 0, bytes: 0, announces: 0 };
  const sockets = new Set();

  function enqueue(token, sock, role) {
    const k = token + "\0" + (role === "send" ? "recv" : "send"); // look for the other role? better: two queues
    if (!waits.has(token)) waits.set(token, { recv: [], send: [] });
    const q = waits.get(token);
    const other = role === "send" ? "recv" : "send";
    const peer = q[other].shift();
    if (peer) {
      writeFrame(sock, RELAY_OK, { ok: true });
      writeFrame(peer, RELAY_OK, { ok: true });
      let n = 0;
      const count = (d) => { n += d.length; stats.bytes += d.length; };
      sock.on("data", count); peer.on("data", count);
      splice(sock, peer);
      stats.pairs++;
    } else {
      q[role].push(sock);
      sock.on("close", () => {
        const i = q[role].indexOf(sock);
        if (i >= 0) q[role].splice(i, 1);
      });
    }
  }

  function publish(token, role, info) {
    if (!rend.get(token)) rend.set(token, { waiters: [] });
    const slot = rend.get(token);
    slot[role] = info;
    stats.announces++;
    const ready = slot.recv && slot.send;
    if (ready) {
      const waiters = slot.waiters.splice(0);
      for (const w of waiters) w();
    }
    return slot;
  }

  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => {});
    readFrame(sock).then((f) => {
      let msg; try { msg = parseJson(f.payload); } catch { sock.destroy(); return; }
      const token = String(msg.token || "");
      if (!token) { writeFrame(sock, RELAY_ERR, { error: "token required" }); sock.end(); return; }
      if (f.type === RELAY_OPEN) {
        const role = msg.role === "send" ? "send" : "recv";
        enqueue(token, sock, role);
        return;
      }
      if (f.type === REND_ANNOUNCE) {
        const observed = { host: sock.remoteAddress, port: sock.remotePort };
        const info = { role: msg.role, candidates: Array.isArray(msg.candidates) ? msg.candidates : [], observed };
        const slot = publish(token, msg.role === "send" ? "send" : "recv", info);
        const reply = () => {
          const peer = msg.role === "send" ? slot.recv : slot.send;
          writeFrame(sock, REND_PEERS, { observed, peer: peer || null });
          sock.end();
        };
        if ((msg.role === "send" && slot.recv) || (msg.role === "recv" && slot.send)) reply();
        else {
          const t = setTimeout(() => { const i = slot.waiters.indexOf(reply); if (i >= 0) slot.waiters.splice(i, 1); reply(); }, Number(msg.waitMs) || 5000);
          const wrapped = () => { clearTimeout(t); reply(); };
          slot.waiters.push(wrapped);
        }
        return;
      }
      writeFrame(sock, RELAY_ERR, { error: "unknown relay frame" }); sock.end();
    }, () => sock.destroy());
  });

  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, host, () => resolve());
  });
  return {
    host, port: server.address().port, stats,
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
  };
}

function connectRaw({ host, port }) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    sock.once("error", reject);
    sock.once("connect", () => { sock.off("error", reject); resolve(sock); });
  });
}

/** Dial the relay, pair under `token` as role recv|send, return a FramedConn. */
export async function relayDial({ host, port, token, role = "send", timeoutMs = 30000, signal } = {}) {
  if (signal?.aborted) throw new RelayError("relay dial aborted");
  const sock = await connectRaw({ host, port });
  const abort = () => { try { sock.destroy(); } catch {} };
  signal?.addEventListener("abort", abort, { once: true });
  writeFrame(sock, RELAY_OPEN, { v: 1, token, role });
  const deadline = setTimeout(abort, timeoutMs);
  try {
    const f = await readFrame(sock);
    clearTimeout(deadline);
    signal?.removeEventListener("abort", abort);
    if (f.type === RELAY_ERR) throw new RelayError(parseJson(f.payload).error || "relay refused");
    if (f.type !== RELAY_OK) throw new RelayError(`unexpected relay frame ${f.type}`);
    return new FramedConn(sock);
  } catch (e) { clearTimeout(deadline); signal?.removeEventListener("abort", abort); sock.destroy(); throw e; }
}

/** Exchange listen/observed addresses with the rendezvous (the relay). */
export async function rendezvousExchange({ host, port, token, role, candidates, waitMs = 4000 }) {
  const sock = await connectRaw({ host, port });
  writeFrame(sock, REND_ANNOUNCE, { v: 1, token, role, candidates, waitMs });
  const f = await readFrame(sock);
  sock.end();
  if (f.type === RELAY_ERR) throw new RelayError(parseJson(f.payload).error || "rendezvous refused");
  if (f.type !== REND_PEERS) throw new RelayError(`unexpected rendezvous frame ${f.type}`);
  return parseJson(f.payload);
}

function tryDial(host, port, ms = 1500) {
  return new Promise((resolve) => {
    if (!host || !port) return resolve(null);
    const sock = net.connect({ host, port });
    const t = setTimeout(() => { sock.destroy(); resolve(null); }, ms);
    sock.once("connect", () => { clearTimeout(t); resolve(sock); });
    sock.once("error", () => { clearTimeout(t); resolve(null); });
  });
}

/**
 * Try a direct TCP path (after a rendezvous exchange), then fall back to
 * the relay. `local` is an already-listening server used to accept a
 * punch. Returns { conn, path: "direct"|"relay", closeLocal }.
 *
 * `forceRelay: true` skips the direct attempt (tests, or a known-blocked
 * path). This is how we simulate a failed punch when we cannot create
 * real NAT namespaces on this host.
 */
export async function punchOrRelay({ rendezvous, token, role, holePunchMs = 1500, forceRelay = false, listenHost = "127.0.0.1" }) {
  const incoming = [];
  const local = net.createServer((s) => incoming.push(s));
  await new Promise((r) => local.listen(0, listenHost, r));
  const listenPort = local.address().port;
  const accept = () => new Promise((resolve) => {
    if (incoming.length) return resolve(incoming.shift());
    const on = (s) => { local.off("connection", on); resolve(s); };
    local.on("connection", on);
    setTimeout(() => { local.off("connection", on); resolve(null); }, holePunchMs);
  });
  let peerInfo = null;
  try {
    peerInfo = await rendezvousExchange({
      host: rendezvous.host, port: rendezvous.port, token, role,
      candidates: [{ host: listenHost, port: listenPort }],
      waitMs: holePunchMs + 500,
    });
  } catch { /* rendezvous failed: fall through to relay */ }

  let direct = null;
  if (!forceRelay && peerInfo?.peer) {
    const cands = [...(peerInfo.peer.candidates || []), peerInfo.peer.observed].filter((c) => c && c.port);
    direct = await new Promise((resolve) => {
      let settled = false;
      const done = (s) => { if (!settled && s) { settled = true; resolve(s); } };
      setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, holePunchMs);
      accept().then(done);
      for (const c of cands) tryDial(c.host, c.port, holePunchMs).then(done);
    });
  }
  const peer = peerInfo?.peer;
  const cand = (peer?.candidates || []).find((c) => c && c.port) || peer?.observed || null;
  const peerHost = cand?.host, peerPort = cand?.port;
  await new Promise((r) => local.close(r));
  if (direct) {
    for (const s of incoming) if (s !== direct) s.destroy();
    return { conn: new FramedConn(direct), path: "direct", listenPort, peerHost, peerPort, closeLocal: async () => {} };
  }
  const conn = await relayDial({ host: rendezvous.host, port: rendezvous.port, token, role });
  return { conn, path: "relay", listenPort, peerHost, peerPort, closeLocal: async () => {} };
}

/**
 * A connect() factory that always goes through the relay under `token`.
 * Used as sendFile/startReceiver `{ via, token }`.
 */
export function viaConnect({ host, port, token, role }) {
  return () => relayDial({ host, port, token, role });
}

export function newToken() { return randomBytes(16).toString("hex"); }
