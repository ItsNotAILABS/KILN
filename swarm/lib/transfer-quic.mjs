/**
 * transfer-quic.mjs — optional QUIC transport behind the same interface
 * as parallel TCP (see transfer-wire.mjs).
 *
 * Node 24 has no `node:quic`. This loads `@matrixai/quic` (quiche via
 * N-API) when present: from `KILN_QUIC_DIR/node_modules/@matrixai/quic`,
 * or a normal import. It is NOT a required KILN dependency. `--transport
 * quic` is opt-in; TCP+AEAD stays the default. Measurements and the
 * reason it is not the default are in docs/KILN_AGENT_TRANSFER.md.
 *
 * One QUIC connection is shared per (host,port); later connect() calls
 * open additional bidirectional streams (the same shape as extra TCP
 * sockets in the TCP transport). Our own X25519+AES-256-GCM handshake
 * still runs on every stream — encryption stays on.
 */
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { webcrypto, randomBytes } from "node:crypto";
import { FramedConn, registerTransport, TRANSPORTS } from "./transfer-wire.mjs";

const GB = 1 << 30;
export const QUIC_CONFIG = Object.freeze({
  initialMaxData: GB,
  initialMaxStreamDataBidiLocal: GB,
  initialMaxStreamDataBidiRemote: GB,
  initialMaxStreamDataUni: GB,
  initialMaxStreamsBidi: 256,
  initialMaxStreamsUni: 256,
  readableChunkSize: 1 << 20,
  maxRecvUdpPayloadSize: 65527,
  maxSendUdpPayloadSize: 65527,
  verifyPeer: false,
  keepAliveIntervalTime: 10_000,
  enableEarlyData: true,
});

const silentLogger = {
  getChild() { return this; },
  setLevel() { return this; },
  debug() {}, info() {}, warn() {}, error() {}, verbose() {}, silly() {},
  log() {}, trace() {}, fatal() {},
};

export class TransferQuicUnavailable extends Error {
  constructor(cause) {
    super(`QUIC transport is unavailable: install @matrixai/quic (optional) or set KILN_QUIC_DIR to a prefix that has node_modules/@matrixai/quic. (${cause})`);
    this.cause = cause;
  }
}

export async function loadQuicModule() {
  const candidates = [];
  if (process.env.KILN_QUIC_DIR) {
    candidates.push(pathToFileURL(join(process.env.KILN_QUIC_DIR, "node_modules/@matrixai/quic/dist/index.js")).href);
  }
  candidates.push("@matrixai/quic");
  let last;
  for (const c of candidates) {
    try { return await import(c); } catch (e) { last = e; }
  }
  throw new TransferQuicUnavailable(last?.message || "not found");
}

function makeOps() {
  const imp = (k, u) => webcrypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, [u]);
  return {
    randomBytes: async (b) => { webcrypto.getRandomValues(new Uint8Array(b)); },
    sign: async (k, data) => webcrypto.subtle.sign("HMAC", await imp(k, "sign"), data),
    verify: async (k, data, sig) => webcrypto.subtle.verify("HMAC", await imp(k, "verify"), sig, data),
  };
}

function ephemeralCert() {
  const d = mkdtempSync(join(tmpdir(), "kiln-quic-cert-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
    "-nodes", "-days", "1", "-subj", "/CN=kiln-transfer",
    "-addext", "subjectAltName=IP:127.0.0.1,IP:::1,DNS:localhost",
    "-keyout", join(d, "key.pem"), "-out", join(d, "cert.pem")], { stdio: "ignore" });
  const key = readFileSync(join(d, "key.pem"), "utf8");
  const cert = readFileSync(join(d, "cert.pem"), "utf8");
  rmSync(d, { recursive: true, force: true });
  return { key, cert };
}

/** A net.Socket-shaped adapter over a QUIC web-stream pair, for FramedConn. */
class QuicSock extends EventEmitter {
  constructor(stream) {
    super();
    this.stream = stream;
    this.writableLength = 0;
    this._writer = stream.writable.getWriter();
    this._closed = false;
    this._pump();
    stream.readable.closed?.catch?.(() => {});
    stream.writable.closed?.catch?.(() => {});
  }
  setNoDelay() {}
  cork() {}
  uncork() {}
  pause() { /* web streams use pull-based backpressure */ }
  resume() {}
  write(buf, _enc, cb) {
    if (this._closed) { if (typeof cb === "function") cb(new Error("closed")); return false; }
    const u = buf instanceof Uint8Array ? buf : Buffer.from(buf);
    this.writableLength += u.byteLength;
    this._writer.write(u).then(() => {
      this.writableLength = Math.max(0, this.writableLength - u.byteLength);
      this.emit("drain");
      if (typeof cb === "function") cb();
    }, (e) => { this._shut(e); if (typeof cb === "function") cb(e); });
    return this.writableLength < (8 << 20);
  }
  end(cb) {
    if (this._closed) { if (typeof cb === "function") cb(); return; }
    this._writer.close().catch(() => {}).finally(() => { this._shut(null); if (typeof cb === "function") cb(); });
  }
  destroy(err) {
    try { this._writer.abort?.(err).catch(() => {}); } catch { /* already closed */ }
    try { this.stream.destroy?.({ force: true }); } catch { /* */ }
    this._shut(err || null);
  }
  async _pump() {
    const r = this.stream.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await r.read();
        if (done) break;
        if (value && value.byteLength) this.emit("data", Buffer.from(value));
      }
    } catch (e) { this._shut(e); return; }
    this._shut(null);
  }
  _shut(err) {
    if (this._closed) return;
    this._closed = true;
    if (err) this.emit("error", err);
    this.emit("close");
  }
}

async function ensureHmacKey() {
  const key = await webcrypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, true, ["sign", "verify"]);
  return webcrypto.subtle.exportKey("raw", key);
}

/**
 * Build and register the `quic` transport. Throws TransferQuicUnavailable
 * if the optional native module cannot be loaded.
 */
export async function ensureQuicTransport() {
  if (TRANSPORTS.quic) return TRANSPORTS.quic;
  const quic = await loadQuicModule();
  const { QUICServer, QUICClient, events } = quic;
  const ops = makeOps();
  const hmac = await ensureHmacKey();
  const { key, cert } = ephemeralCert();
  const cfg = { ...QUIC_CONFIG, key, cert, verifyPeer: false };
  const clients = new Map(); // host:port -> { client, ready }

  const transport = {
    name: "quic",
    async listen({ host = "127.0.0.1", port = 0, onConnection }) {
      const server = new QUICServer({
        crypto: { key: hmac, ops },
        config: { ...cfg, key, cert },
        logger: silentLogger,
      });
      server.addEventListener(events.EventQUICServerConnection.name, (e) => {
        const conn = e.detail;
        conn.addEventListener(events.EventQUICConnectionStream.name, (se) => {
          onConnection(new FramedConn(new QuicSock(se.detail)));
        });
      });
      await server.start({ host, port });
      return {
        port: server.port,
        host,
        close: async () => { await server.stop({ force: true }); },
      };
    },
    async connect({ host = "127.0.0.1", port }) {
      const k = `${host}:${port}`;
      let slot = clients.get(k);
      if (!slot) {
        slot = { ready: null, client: null };
        slot.ready = QUICClient.createQUICClient({
          host, port,
          crypto: { ops: { randomBytes: ops.randomBytes } },
          config: { ...QUIC_CONFIG, verifyPeer: false },
          logger: silentLogger,
        }).then((c) => { slot.client = c; return c; });
        clients.set(k, slot);
      }
      const client = await slot.ready;
      const stream = client.connection.newStream();
      const framed = new FramedConn(new QuicSock(stream));
      const origDestroy = framed.destroy.bind(framed);
      framed.destroy = () => origDestroy();
      return framed;
    },
    async _shutdown() {
      for (const slot of clients.values()) {
        try { const c = await slot.ready; await c.destroy({ force: true }); } catch { /* */ }
      }
      clients.clear();
    },
  };
  return registerTransport("quic", transport);
}
