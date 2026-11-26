/**
 * transfer-wire.mjs — the transport layer for KILN agent transfer.
 *
 * Interface (any transport implements it):
 *   listen({host, port, onConnection(conn)}) -> Promise<{port, close()}>
 *   connect({host, port}) -> Promise<conn>
 *   conn: send(type, payload[, body]) -> bool (false = back off),
 *         drained() -> Promise, onFrame(fn(type, payload)), onClose(fn(err)),
 *         destroy(), writableLength, closed
 *
 * The shipped transport is parallel TCP: each transfer opens N TCP
 * connections and spreads shards across them (see KILN_AGENT_TRANSFER.md for
 * why this is TCP and not QUIC on Node 24). Frames are
 *   plaintext: u32 length (of type byte + payload) | u8 type | payload
 *   encrypted (after the handshake): u32 length | nonce(12) | AES-256-GCM(type||payload) | tag(16)
 */
import net from "node:net";

export const T = Object.freeze({
  HELLO: 1, WELCOME: 2, JOIN: 3, SHARD: 4, CONN_END: 5, END: 6, MISSING: 7, COMPLETE: 8, ERROR: 9, PING: 10, PONG: 11, JOINED: 12,
  HS: 13, HS_OK: 14,
});
const MAX_FRAME = 64 << 20;

export function jsonPayload(obj) { return Buffer.from(JSON.stringify(obj)); }
export function parseJson(buf) { return JSON.parse(buf.toString("utf8")); }

/** SHARD header: u32 stripe | u16 index. Body = shard bytes. */
export function shardHeader(stripe, index) {
  const h = Buffer.allocUnsafe(6);
  h.writeUInt32BE(stripe, 0); h.writeUInt16BE(index, 4);
  return h;
}

class FramedConn {
  constructor(sock) {
    this.sock = sock;
    this.closed = false;
    this._frameFns = [];
    this._closeFns = [];
    this._bufs = []; this._have = 0; this._need = -1;
    this._sendC = null; this._recvC = null; this._tamperNext = false;
    sock.setNoDelay(true);
    sock.on("data", (d) => this._onData(d));
    let err = null;
    sock.on("error", (e) => { err = e; });
    sock.on("close", () => { this.closed = true; for (const f of this._closeFns) f(err); });
  }
  get writableLength() { return this.sock.writableLength; }
  /** Enable per-frame AES-256-GCM after a completed handshake. Further send/recv is encrypted. */
  installCipher(send, recv) { this._sendC = send; this._recvC = recv; }
  onFrame(fn) { this._frameFns.push(fn); }
  onClose(fn) { if (this.closed) fn(null); else this._closeFns.push(fn); }
  send(type, payload = Buffer.alloc(0), body) {
    if (this.closed) return false;
    if (this._sendC) {
      const plain = Buffer.allocUnsafe(1 + payload.length + (body ? body.length : 0));
      plain[0] = type;
      if (payload.length) payload.copy(plain, 1);
      if (body && body.length) body.copy(plain, 1 + payload.length);
      const tamper = this._tamperNext ? 0 : undefined;
      this._tamperNext = false;
      const sealed = this._sendC.seal(plain, tamper === undefined ? {} : { tamper });
      const h = Buffer.allocUnsafe(4);
      h.writeUInt32BE(sealed.length, 0);
      this.sock.cork();
      this.sock.write(h);
      const ok = this.sock.write(sealed);
      this.sock.uncork();
      return ok && this.sock.writableLength < (8 << 20);
    }
    const len = 1 + payload.length + (body ? body.length : 0);
    const h = Buffer.allocUnsafe(5);
    h.writeUInt32BE(len, 0); h[4] = type;
    this.sock.cork();
    this.sock.write(h);
    if (payload.length) this.sock.write(payload);
    const ok = body && body.length ? this.sock.write(body) : true;
    this.sock.uncork();
    return ok && this.sock.writableLength < (8 << 20);
  }
  drained() {
    if (this.closed || this.sock.writableLength === 0) return Promise.resolve();
    if (!this._drain) {
      this._drain = new Promise((res) => {
        const done = () => { this.sock.off("drain", done); this.sock.off("close", done); this._drain = null; res(); };
        this.sock.on("drain", done); this.sock.on("close", done);
      });
    }
    return this._drain;
  }
  pause() { this.sock.pause(); }
  resume() { this.sock.resume(); }
  end() { if (!this.closed) this.sock.end(); }
  destroy() { this.sock.destroy(); }
  _take(n) {
    // Remove exactly n bytes from the front of the buffer list.
    if (this._bufs[0].length === n) { this._have -= n; return this._bufs.shift(); }
    if (this._bufs[0].length > n) {
      const b = this._bufs[0];
      this._bufs[0] = b.subarray(n); this._have -= n;
      return b.subarray(0, n);
    }
    const out = Buffer.allocUnsafe(n);
    let off = 0;
    while (off < n) {
      const b = this._bufs[0];
      const take = Math.min(b.length, n - off);
      b.copy(out, off, 0, take); off += take;
      if (take === b.length) this._bufs.shift(); else this._bufs[0] = b.subarray(take);
    }
    this._have -= n;
    return out;
  }
  _onData(d) {
    this._bufs.push(d); this._have += d.length;
    for (;;) {
      if (this._need < 0) {
        if (this._have < 4) return;
        this._need = this._take(4).readUInt32BE(0);
        if (this._need < 1 || this._need > MAX_FRAME) { this.sock.destroy(new Error(`bad frame length ${this._need}`)); return; }
      }
      if (this._have < this._need) return;
      const frame = this._take(this._need);
      this._need = -1;
      let type, payload;
      if (this._recvC) {
        let plain;
        try { plain = this._recvC.open(frame); }
        catch (e) { this.sock.destroy(e); return; }
        type = plain[0]; payload = plain.subarray(1);
      } else {
        type = frame[0]; payload = frame.subarray(1);
      }
      for (const f of this._frameFns) {
        try { f(type, payload); } catch (e) { this.sock.destroy(e); return; }
      }
    }
  }
}

export const tcpTransport = {
  name: "tcp",
  listen({ host = "127.0.0.1", port = 0, onConnection }) {
    return new Promise((resolve, reject) => {
      const srv = net.createServer((sock) => onConnection(new FramedConn(sock)));
      srv.on("error", reject);
      srv.listen(port, host, () => {
        const sockets = new Set();
        srv.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
        resolve({
          port: srv.address().port,
          host,
          close: () => new Promise((r) => { for (const s of sockets) s.destroy(); srv.close(() => r()); }),
        });
      });
    });
  },
  connect({ host = "127.0.0.1", port }) {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host, port });
      sock.once("error", reject);
      sock.once("connect", () => { sock.off("error", reject); resolve(new FramedConn(sock)); });
    });
  },
};

export const TRANSPORTS = { tcp: tcpTransport };
