/**
 * transfer.mjs — KILN agent-to-agent file transfer (SDK).
 *
 *   import { startReceiver, sendFile } from "<kiln>/swarm/lib/transfer.mjs";
 *   const rx = await startReceiver({ outDir: "/tmp/in", keypair });   // rx.port, rx.publicKey
 *   const r  = await sendFile("big.zip", { host: "127.0.0.1", port: rx.port, keypair: myKp });
 *
 * Design (Solana-inspired, all off-chain):
 *  - the file is cut into chunks; k chunks + m Reed-Solomon parity shards
 *    form a stripe (Turbine's FEC set); any k shards rebuild the stripe;
 *  - every chunk's SHA-256 is in a content-addressed manifest signed with
 *    the sender's ed25519 (Solana-format) key; bad shards are dropped;
 *  - shards of each stripe are spread across N parallel connections, so a
 *    dropped connection costs at most a few shards per stripe;
 *  - the receiver keeps a stripe bitmap on disk; a re-send of the same
 *    manifest skips finished stripes (resume);
 *  - both sides stream from/to disk with bounded buffers: memory does not
 *    grow with file size, so there is no size limit beyond disk.
 */
import { randomBytes, createHash } from "node:crypto";
import { open, rename, mkdir, unlink, stat, rm, readFile } from "node:fs/promises";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { join, resolve as resolvePath, basename, dirname, posix } from "node:path";
import { tmpdir, availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { spawn } from "node:child_process";
import { TRANSPORTS, T, jsonPayload, parseJson, shardHeader } from "./transfer-wire.mjs";
import {
  clientHandshake, serverHandshake, finishHandshake, deriveCiphers,
  requireEncryptOrLoopback, isLoopback,
} from "./transfer-crypto.mjs";
import {
  buildManifest, signManifest, verifySignedManifest, geometry, stripeK, chunkLen, DEFAULTS, safeName,
} from "./transfer-manifest.mjs";
import { encodeParity, reconstructData } from "./transfer-rs.mjs";
import { signBytes, verifyBytes, loadOrCreateKeypair } from "./transfer-identity.mjs";
import { writeFileAtomicSync } from "./state.mjs";

export { buildManifest, signManifest, verifySignedManifest } from "./transfer-manifest.mjs";
export { generateKeypair, loadOrCreateKeypair, loadKeypairFile } from "./transfer-identity.mjs";
export { buildMemoReceipt, submitMemoReceipt, verifyMemoReceipt } from "./transfer-receipt.mjs";
export { FrameCipher, isLoopback, requireEncryptOrLoopback } from "./transfer-crypto.mjs";

export class TransferError extends Error {}

export function identityPath(stateDir) { return join(stateDir, "transfer", "id.json"); }
export function loadIdentity(stateDir) { return loadOrCreateKeypair(identityPath(stateDir)); }

function welcomeMessage(nonce, id) { return Buffer.from(`kiln-transfer/1:welcome:${nonce}:${id}`); }
const bitGet = (bm, i) => (bm[i >> 3] >> (i & 7)) & 1;
const bitSet = (bm, i) => { bm[i >> 3] |= 1 << (i & 7); };

// ---------------------------------------------------------------- parity pool

class ParityPool {
  constructor(size) {
    this.workers = []; this.idle = []; this.queue = []; this.pending = new Map(); this.seq = 0;
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL("./transfer-parity-worker.mjs", import.meta.url));
      w.on("message", (msg) => {
        const p = this.pending.get(msg.id); this.pending.delete(msg.id);
        p.resolve({ buf: Buffer.from(msg.buf), parity: msg.parity.map((b) => Buffer.from(b)) });
        this.idle.push(w); this._pump();
      });
      w.on("error", (e) => { for (const p of this.pending.values()) p.reject(e); this.pending.clear(); });
      w.unref();
      this.workers.push(w); this.idle.push(w);
    }
  }
  run(buf, lens, m, shardLen) {
    return new Promise((resolve, reject) => {
      this.queue.push({ buf, lens, m, shardLen, resolve, reject }); this._pump();
    });
  }
  _pump() {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop(), job = this.queue.shift(), id = ++this.seq;
      this.pending.set(id, job);
      const ab = job.buf.buffer.byteLength === job.buf.length && job.buf.byteOffset === 0
        ? job.buf.buffer : job.buf.buffer.slice(job.buf.byteOffset, job.buf.byteOffset + job.buf.length);
      w.postMessage({ id, buf: ab, lens: job.lens, m: job.m, shardLen: job.shardLen }, [ab]);
    }
  }
  close() { return Promise.all(this.workers.map((w) => w.terminate())); }
}

// ---------------------------------------------------------------- sender

function waitFrame(conn, types, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new TransferError(`timed out waiting for ${types.join("/")}`)), timeoutMs);
    conn.onFrame((type, payload) => {
      if (types.includes(type) || type === T.ERROR) {
        clearTimeout(t);
        if (type === T.ERROR) reject(new TransferError(parseJson(payload).error));
        else resolve({ type, payload });
      }
    });
    conn.onClose((e) => { clearTimeout(t); reject(new TransferError(`connection closed${e ? `: ${e.message}` : ""}`)); });
  });
}

/** A one-shot reader of "the next frame of these types". */
function frameQueue(conn) {
  const q = []; const waiters = []; let closed = null;
  conn.onFrame((type, payload) => {
    const f = { type, payload };
    if (waiters.length) waiters.shift().resolve(f); else q.push(f);
  });
  conn.onClose((e) => { closed = new TransferError(`control connection closed${e ? `: ${e.message}` : ""}`); while (waiters.length) waiters.shift().reject(closed); });
  return (timeoutMs = 120000) => {
    if (q.length) return Promise.resolve(q.shift());
    if (closed) return Promise.reject(closed);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new TransferError("timed out waiting for receiver")), timeoutMs);
      waiters.push({ resolve: (f) => { clearTimeout(t); resolve(f); }, reject: (e) => { clearTimeout(t); reject(e); } });
    });
  };
}

async function readFull(fh, buf, len, pos) {
  let got = 0;
  while (got < len) {
    const { bytesRead } = await fh.read(buf, got, len - got, pos + got);
    if (bytesRead === 0) throw new TransferError("file shrank during send");
    got += bytesRead;
  }
}

/**
 * Send one regular file. Resolves with stats once the receiver confirms
 * every stripe is on disk and verified.
 */
export async function sendFile(path, opts = {}) {
  const {
    host = "127.0.0.1", port, keypair, streams = 8, transport = "tcp", expectReceiver, name,
    chunkSize = DEFAULTS.chunkSize, dataShards = DEFAULTS.dataShards, parityShards = DEFAULTS.parityShards,
    workers = Math.max(1, Math.min(4, availableParallelism() - 1)), envelope: givenEnv,
    onProgress, _hooks = {}, encrypt = true,
  } = opts;
  if (!keypair) throw new TransferError("sendFile: keypair is required");
  if (!port) throw new TransferError("sendFile: port is required");
  requireEncryptOrLoopback(encrypt, host, "sendFile");
  const tp = TRANSPORTS[transport];
  if (!tp) throw new TransferError(`unknown transport ${transport}`);
  const t0 = performance.now();
  const env = givenEnv || signManifest(await buildManifest(path, { name, chunkSize, dataShards, parityShards, sender: keypair.publicKey, workers: Math.max(1, workers) }), keypair);
  const m = env.manifest;
  const tHashed = performance.now();
  const { stripes } = geometry(m);
  // Small files (one stripe) go over the control connection alone: no extra
  // handshakes, no worker threads. Big files fan out over `streams` sockets.
  const dataStreams = stripes <= 1 ? 0 : Math.max(0, Math.min(64, streams));

  const ctrl = await tp.connect({ host, port });
  const nextCtrl = frameQueue(ctrl);
  const conns = [];
  let pool = null, fh = null;
  const stats = { id: env.id, name: m.name, bytes: m.size, stripes, skippedStripes: 0, sentStripes: 0, repairRounds: 0,
    shardsSent: 0, wireBytes: 0, streams: Math.max(1, dataStreams), transport: tp.name, encrypt };
  try {
    if (encrypt) {
      const hs = clientHandshake(keypair);
      ctrl.send(T.HS, jsonPayload(hs.payload));
      const ok = await nextCtrl(30000);
      if (ok.type === T.ERROR) throw new TransferError(`receiver refused: ${parseJson(ok.payload).error}`);
      if (ok.type !== T.HS_OK) throw new TransferError(`unexpected frame ${ok.type}`);
      const fin = finishHandshake(hs.eph, hs.nonce, parseJson(ok.payload), { expectReceiver });
      const ciphers = deriveCiphers({
        shared: fin.shared, clientEph: hs.eph.publicKeyBytes, serverEph: fin.serverEph,
        clientId: keypair.publicKey, serverId: fin.receiver, nonce: hs.nonce, context: "ctrl", side: "client",
      });
      ctrl.installCipher(ciphers.send, ciphers.recv);
      stats.receiver = fin.receiver;
    }
    if (_hooks.tamperCiphertext) ctrl._tamperNext = true;
    const nonce = randomBytes(16).toString("hex");
    ctrl.send(T.HELLO, jsonPayload({ envelope: env, streams: dataStreams, nonce }));
    const w = await nextCtrl(60000);
    if (w.type === T.ERROR) throw new TransferError(`receiver refused: ${parseJson(w.payload).error}`);
    if (w.type !== T.WELCOME) throw new TransferError(`unexpected frame ${w.type}`);
    const welcome = parseJson(w.payload);
    if (!verifyBytes(welcome.receiver, welcomeMessage(nonce, env.id), Buffer.from(welcome.sig, "base64"))) {
      throw new TransferError("receiver signature on WELCOME is invalid");
    }
    if (expectReceiver && welcome.receiver !== expectReceiver) throw new TransferError(`receiver is ${welcome.receiver}, expected ${expectReceiver}`);
    stats.receiver = welcome.receiver;
    const have = Buffer.from(welcome.have || "", "base64");
    for (let s = 0; s < stripes; s++) if (bitGet(have, s)) stats.skippedStripes++;

    if (welcome.status !== "complete") {
      // open data connections
      const joins = [];
      for (let i = 0; i < dataStreams; i++) {
        joins.push((async () => {
          const c = await tp.connect({ host, port });
          const p = waitFrame(c, [T.JOINED]);
          if (encrypt) {
            const hs = clientHandshake(keypair, { session: welcome.session });
            c.send(T.JOIN, jsonPayload({ session: welcome.session, ephPub: hs.payload.ephPub, nonce: hs.payload.nonce, sig: hs.payload.sig, v: 1 }));
            const joined = await p;
            const fin = finishHandshake(hs.eph, hs.nonce, parseJson(joined.payload), { session: welcome.session, expectReceiver: welcome.receiver });
            const ciphers = deriveCiphers({
              shared: fin.shared, clientEph: hs.eph.publicKeyBytes, serverEph: fin.serverEph,
              clientId: keypair.publicKey, serverId: fin.receiver, nonce: hs.nonce, context: "data:" + welcome.session, side: "client",
            });
            c.installCipher(ciphers.send, ciphers.recv);
          } else {
            c.send(T.JOIN, jsonPayload({ session: welcome.session }));
            await p;
          }
          return c;
        })());
      }
      for (const r of await Promise.allSettled(joins)) if (r.status === "fulfilled") conns.push(r.value);
      if (!conns.length) conns.push(ctrl);
      const alive = () => { const a = conns.filter((c) => !c.closed); return a.length ? a : [ctrl]; };

      fh = await open(path, "r");
      if (m.parityShards > 0 && workers > 0 && stripes > 2) pool = new ParityPool(workers);
      const send = async (conn, s, idx, body, repair = false) => {
        let shard = body;
        const hook = _hooks.onShard && _hooks.onShard({ stripe: s, index: idx, conn, conns, repair });
        if (hook === "drop") return;
        if (hook === "corrupt") { shard = Buffer.from(body); shard[0] ^= 0xff; }
        if (conn.closed) conn = alive()[0];
        if (hook === "tamper-wire") conn._tamperNext = true;
        stats.shardsSent++; stats.wireBytes += body.length;
        if (!conn.send(T.SHARD, shardHeader(s, idx), shard)) await conn.drained();
      };

      const sendStripe = async (s, { parity = true, via, repair = false } = {}) => {
        const k = stripeK(m, s);
        const first = s * m.dataShards;
        const off = first * m.chunkSize;
        const lens = []; let total = 0;
        for (let j = 0; j < k; j++) { const l = chunkLen(m, first + j); lens.push(l); total += l; }
        let buf = Buffer.allocUnsafeSlow(total);
        await readFull(fh, buf, total, off);
        let par = [];
        if (parity && m.parityShards > 0) {
          if (pool) ({ buf, parity: par } = await pool.run(buf, lens, m.parityShards, m.chunkSize));
          else {
            const data = []; let o = 0; for (const l of lens) { data.push(buf.subarray(o, o + l)); o += l; }
            par = encodeParity(data, m.parityShards, m.chunkSize);
          }
        }
        const shards = []; let o = 0;
        for (const l of lens) { shards.push(buf.subarray(o, o + l)); o += l; }
        shards.push(...par);
        const a = via ? [via] : alive();
        // Turbine-style spread: shard j of stripe s goes to connection (s + j) mod N.
        const sends = shards.map((body, j) => send(a[(s + j) % a.length], s, j, body, repair));
        await Promise.all(sends);
        stats.sentStripes++;
        if (onProgress) onProgress({ stripe: s, stripes, sentStripes: stats.sentStripes });
      };

      // pipeline: keep `depth` stripes in flight (read + parity + send)
      const depth = opts.pipelineDepth || (pool ? workers + 2 : 3);
      const todo = [];
      for (let s = 0; s < stripes; s++) if (!bitGet(have, s)) todo.push(s);
      let next = 0, sentCount = 0;
      const runners = Array.from({ length: Math.min(depth, todo.length) }, async () => {
        while (next < todo.length) {
          const s = todo[next++];
          await sendStripe(s);
          sentCount++;
          if (_hooks.abortAfterStripes && sentCount >= _hooks.abortAfterStripes) {
            for (const c of conns) c.destroy();
            ctrl.destroy();
            throw new TransferError("aborted by test hook");
          }
        }
      });
      await Promise.all(runners);
      for (const c of conns) if (c !== ctrl && !c.closed) { c.send(T.CONN_END); }
      await Promise.all(conns.map((c) => c.drained()));

      // finish / repair rounds over the control connection
      for (let round = 0; ; round++) {
        ctrl.send(T.END);
        const f = await nextCtrl(600000);
        if (f.type === T.COMPLETE) { stats.result = parseJson(f.payload); break; }
        if (f.type === T.ERROR) throw new TransferError(`receiver: ${parseJson(f.payload).error}`);
        if (f.type !== T.MISSING) throw new TransferError(`unexpected frame ${f.type}`);
        if (round >= 8) throw new TransferError("receiver still missing stripes after 8 repair rounds");
        stats.repairRounds++;
        const need = Buffer.from(parseJson(f.payload).need, "base64");
        for (let s = 0; s < stripes; s++) {
          if (bitGet(need, s)) { await sendStripe(s, { parity: false, via: ctrl, repair: true }); }
        }
        await ctrl.drained();
      }
    } else {
      stats.result = welcome.result || { status: "complete" };
    }
  } finally {
    if (fh) await fh.close().catch(() => {});
    if (pool) await pool.close();
    for (const c of conns) if (c !== ctrl) c.destroy();
    ctrl.end(); setTimeout(() => ctrl.destroy(), 1000).unref();
  }
  const t1 = performance.now();
  stats.hashSeconds = (tHashed - t0) / 1000;
  stats.transferSeconds = (t1 - tHashed) / 1000;
  stats.totalSeconds = (t1 - t0) / 1000;
  stats.throughputMBps = m.size / 1048576 / Math.max(stats.transferSeconds, 1e-9);
  stats.peakRssMB = Math.round(process.resourceUsage().maxRSS / 1024);
  return stats;
}

// ---------------------------------------------------------------- receiver

class RecvSession {
  constructor(rx, env, id, ctrl, streams) {
    this.rx = rx; this.env = env; this.m = env.manifest; this.id = id; this.ctrl = ctrl;
    this.expectStreams = Math.max(0, Math.min(64, Number(streams) || 0));
    this.session = randomBytes(16).toString("hex");
    this.geo = geometry(this.m);
    this.dir = join(rx.outDir, ".kiln-recv");
    this.partPath = join(this.dir, `${id}.part`);
    this.statePath = join(this.dir, `${id}.json`);
    this.have = Buffer.alloc(Math.ceil(this.geo.stripes / 8));
    this.tracks = new Map();
    this.conns = new Set(); this.ended = new Set();
    this.pendingBytes = 0; this.pending = new Set();
    this.paused = false; this.mismatches = 0; this.saveTimer = null; this.done = false;
    this.joinWaiters = [];
  }
  async open() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    if (existsSync(this.statePath) && existsSync(this.partPath)) {
      try {
        const st = JSON.parse(await readFile(this.statePath, "utf8"));
        if (st.id === this.id) Buffer.from(st.have, "base64").copy(this.have);
      } catch { /* corrupt state: start over */ }
    }
    this.fh = await open(this.partPath, existsSync(this.partPath) ? "r+" : "w+", 0o600);
    await this.fh.truncate(this.m.size);
  }
  doneCount() { let n = 0; for (let s = 0; s < this.geo.stripes; s++) n += bitGet(this.have, s); return n; }
  track(s) {
    let t = this.tracks.get(s);
    if (!t) {
      const k = stripeK(this.m, s);
      t = { k, got: new Uint8Array(k + this.m.parityShards), written: 0, parity: new Map() };
      this.tracks.set(s, t);
    }
    return t;
  }
  saveSoon() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.saveNow(); }, 250);
  }
  saveNow() {
    if (this.done) return;
    try { writeFileAtomicSync(this.statePath, JSON.stringify({ id: this.id, name: this.m.name, have: this.have.toString("base64") }), { mode: 0o600 }); } catch {}
  }
  flow() {
    const hi = 64 << 20, lo = 16 << 20;
    if (!this.paused && this.pendingBytes > hi) { this.paused = true; for (const c of this.conns) c.pause(); }
    else if (this.paused && this.pendingBytes < lo) { this.paused = false; for (const c of this.conns) c.resume(); }
  }
  onShard(payload) {
    const s = payload.readUInt32BE(0), idx = payload.readUInt16BE(4);
    const body = payload.subarray(6);
    if (s >= this.geo.stripes || bitGet(this.have, s)) return;
    const t = this.track(s);
    if (idx >= t.k + this.m.parityShards || t.got[idx]) return;
    if (idx >= t.k) {
      if (body.length !== this.m.chunkSize) { this.mismatches++; return; }
      t.got[idx] = 1; t.parity.set(idx, body); return;
    }
    const c = s * this.m.dataShards + idx;
    if (body.length !== chunkLen(this.m, c) ||
        createHash("sha256").update(body).digest("hex") !== this.m.chunks[c]) { this.mismatches++; return; }
    t.got[idx] = 1;
    this.write(body, c * this.m.chunkSize, () => {
      t.written++;
      if (t.written === t.k) this.finishStripe(s);
    });
  }
  write(buf, pos, after) {
    this.pendingBytes += buf.length; this.flow();
    const p = this.fh.write(buf, 0, buf.length, pos).then(() => {
      this.pending.delete(p); this.pendingBytes -= buf.length; this.flow(); after();
    }, (e) => { this.pending.delete(p); this.fail(`disk write failed: ${e.message}`); });
    this.pending.add(p);
  }
  finishStripe(s) {
    bitSet(this.have, s); this.tracks.delete(s); this.saveSoon();
  }
  async drainWrites() { while (this.pending.size) await Promise.allSettled([...this.pending]); }
  async waitDataConns() {
    // Wait until every joined data connection has sent CONN_END or closed.
    // Connections that never joined get a short grace period.
    const t0 = Date.now();
    for (;;) {
      const live = [...this.conns].filter((c) => !this.ended.has(c) && !c.closed);
      if (!live.length && (this.conns.size >= this.expectStreams || Date.now() - t0 > 2000)) return;
      if (Date.now() - t0 > 30000) return;
      await new Promise((r) => setTimeout(r, 2));
    }
  }
  /** Rebuild stripes that are short of data but have >= k shards. */
  async recover() {
    for (const [s, t] of this.tracks) {
      const count = t.got.reduce((a, b) => a + b, 0);
      if (count < t.k || t.written === t.k) continue;
      const shards = new Map();
      const first = s * this.m.dataShards;
      for (let j = 0; j < t.k; j++) {
        if (!t.got[j]) continue;
        const len = chunkLen(this.m, first + j);
        const b = Buffer.alloc(len);
        await this.fh.read(b, 0, len, (first + j) * this.m.chunkSize);
        shards.set(j, b);
      }
      for (const [i, b] of t.parity) shards.set(i, b);
      let rebuilt;
      try { rebuilt = reconstructData(shards, t.k, this.m.parityShards, this.m.chunkSize); } catch { continue; }
      let ok = true;
      for (const [j, b] of rebuilt) {
        const c = first + j, len = chunkLen(this.m, c);
        const data = b.subarray(0, len);
        if (createHash("sha256").update(data).digest("hex") !== this.m.chunks[c]) { ok = false; break; }
        rebuilt.set(j, data);
      }
      if (!ok) { // a parity shard was bad: forget parity, ask for the stripe again
        for (const i of t.parity.keys()) t.got[i] = 0;
        t.parity.clear(); this.mismatches++;
        continue;
      }
      for (const [j, data] of rebuilt) {
        const c = first + j;
        await this.fh.write(data, 0, data.length, c * this.m.chunkSize);
        t.got[j] = 1;
      }
      this.rx.stats.recoveredStripes++;
      this.finishStripe(s);
    }
  }
  async onEnd() {
    await this.waitDataConns();
    await this.drainWrites();
    await this.recover();
    await this.drainWrites();
    const need = Buffer.alloc(this.have.length);
    let missing = 0;
    for (let s = 0; s < this.geo.stripes; s++) if (!bitGet(this.have, s)) { bitSet(need, s); missing++; }
    if (missing) {
      for (const t of this.tracks.values()) t.parity.clear();
      this.saveNow();
      this.ctrl.send(T.MISSING, jsonPayload({ need: need.toString("base64"), missing }));
      return;
    }
    const result = await this.finalize();
    this.ctrl.send(T.COMPLETE, jsonPayload(result));
  }
  async finalize() {
    this.done = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    await this.fh.sync(); await this.fh.close(); this.fh = null;
    if (this.rx.verifyFile) {
      // Re-read the finished file and check every chunk against the manifest.
      const fh = await open(this.partPath, "r");
      const buf = Buffer.allocUnsafe(this.m.chunkSize);
      try {
        for (let c = 0; c < this.geo.chunks; c++) {
          const len = chunkLen(this.m, c);
          await fh.read(buf, 0, len, c * this.m.chunkSize);
          if (createHash("sha256").update(buf.subarray(0, len)).digest("hex") !== this.m.chunks[c]) {
            throw new TransferError(`verify: chunk ${c} on disk does not match the manifest`);
          }
        }
      } finally { await fh.close(); }
    }
    let dest = join(this.rx.outDir, safeName(this.m.name));
    if (existsSync(dest) && !this.rx.overwrite) dest = join(this.rx.outDir, `${safeName(this.m.name)}.${this.id.slice(0, 8)}`);
    await rename(this.partPath, dest);
    await unlink(this.statePath).catch(() => {});
    const result = { status: "complete", id: this.id, name: this.m.name, path: dest, bytes: this.m.size,
      sender: this.m.sender, root: this.m.root, mismatchesDropped: this.mismatches,
      receiverPeakRssMB: Math.round(process.resourceUsage().maxRSS / 1024) };
    this.rx.sessions.delete(this.session); this.rx.active.delete(this.id);
    this.rx.stats.completed++;
    if (this.rx.onComplete) {
      try { const extra = await this.rx.onComplete(result, this.env); if (extra) Object.assign(result, extra); }
      catch (e) { result.postError = e.message; }
    }
    return result;
  }
  fail(msg) {
    if (!this.ctrl.closed) this.ctrl.send(T.ERROR, jsonPayload({ error: msg }));
    this.close();
  }
  close() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (!this.done) {
      const flush = async () => { await this.drainWrites(); this.saveNow(); if (this.fh) { await this.fh.close().catch(() => {}); this.fh = null; } };
      this.rx.closing.set(this.id, flush().finally(() => this.rx.closing.delete(this.id)));
    }
    for (const c of this.conns) c.destroy();
    this.rx.sessions.delete(this.session); this.rx.active.delete(this.id);
  }
}

/**
 * Listen for incoming transfers. Files land in outDir (partials live in
 * outDir/.kiln-recv until every stripe verifies).
 */
export async function startReceiver(opts = {}) {
  const { outDir, host = "127.0.0.1", port = 0, keypair, trust, transport = "tcp", overwrite = false,
    verifyFile = false, onComplete, maxSize = Infinity, encrypt = true } = opts;
  if (!outDir) throw new TransferError("startReceiver: outDir is required");
  if (!keypair) throw new TransferError("startReceiver: keypair is required");
  requireEncryptOrLoopback(encrypt, host, "startReceiver");
  const tp = TRANSPORTS[transport];
  if (!tp) throw new TransferError(`unknown transport ${transport}`);
  await mkdir(outDir, { recursive: true });
  const rx = { outDir: resolvePath(outDir), overwrite, verifyFile, onComplete, sessions: new Map(), active: new Map(), closing: new Map(),
    stats: { completed: 0, recoveredStripes: 0 }, encrypt, requireEncrypt: encrypt };

  const onConnection = (conn) => {
    let sess = null, role = null, hsSender = null;
    conn.onFrame(async (type, payload) => {
      if (!role && type === T.HS) {
        try {
          const reply = serverHandshake(keypair, parseJson(payload));
          conn.send(T.HS_OK, jsonPayload(reply.payload));
          const ciphers = deriveCiphers({
            shared: reply.shared, clientEph: reply.clientEph, serverEph: reply.serverEph,
            clientId: reply.sender, serverId: keypair.publicKey, nonce: reply.nonce, context: "ctrl", side: "server",
          });
          conn.installCipher(ciphers.send, ciphers.recv);
          hsSender = reply.sender;
        } catch (e) {
          conn.send(T.ERROR, jsonPayload({ error: e.message })); conn.end();
        }
        return;
      }
      if (rx.requireEncrypt && !conn._recvC && type !== T.JOIN) {
        conn.send(T.ERROR, jsonPayload({ error: "encryption required" })); conn.end(); return;
      }
      if (type === T.PING) { conn.send(T.PONG, payload); return; }
      if (!role && type === T.HELLO) {
        role = "ctrl";
        let hello;
        try {
          hello = parseJson(payload);
          const id = verifySignedManifest(hello.envelope, { trust });
          if (hsSender && hello.envelope.manifest.sender !== hsSender) throw new Error("manifest sender does not match handshake identity");
          if (hello.envelope.manifest.size > maxSize) throw new Error(`file exceeds this receiver's max size`);
          if (rx.active.has(id)) throw new Error("this manifest is already being received");
          sess = new RecvSession(rx, hello.envelope, id, conn, hello.streams);
          rx.active.set(id, sess);
          rx.sessions.set(sess.session, sess);
          if (rx.closing.has(id)) await rx.closing.get(id);
          await sess.open();
        } catch (e) {
          if (sess) { rx.active.delete(sess.id); rx.sessions.delete(sess.session); }
          conn.send(T.ERROR, jsonPayload({ error: e.message })); conn.end(); return;
        }
        const sig = signBytes(keypair, welcomeMessage(hello.nonce, sess.id)).toString("base64");
        conn.send(T.WELCOME, jsonPayload({
          session: sess.session, receiver: keypair.publicKey, sig, have: sess.have.toString("base64"),
          status: "need", haveStripes: sess.doneCount(),
        }));
        return;
      }
      if (!role && type === T.JOIN) {
        let j; try { j = parseJson(payload); } catch { conn.destroy(); return; }
        sess = rx.sessions.get(j.session);
        if (!sess) { conn.send(T.ERROR, jsonPayload({ error: "unknown session" })); conn.end(); return; }
        if (rx.requireEncrypt || j.ephPub) {
          try {
            const reply = serverHandshake(keypair, j, { session: j.session, expectedSender: sess.m.sender });
            conn.send(T.JOINED, jsonPayload(reply.payload));
            const ciphers = deriveCiphers({
              shared: reply.shared, clientEph: reply.clientEph, serverEph: reply.serverEph,
              clientId: sess.m.sender, serverId: keypair.publicKey, nonce: reply.nonce, context: "data:" + j.session, side: "server",
            });
            conn.installCipher(ciphers.send, ciphers.recv);
          } catch (e) {
            conn.send(T.ERROR, jsonPayload({ error: e.message })); conn.end(); return;
          }
        } else {
          if (rx.requireEncrypt) { conn.send(T.ERROR, jsonPayload({ error: "encryption required" })); conn.end(); return; }
          conn.send(T.JOINED);
        }
        role = "data"; sess.conns.add(conn);
        if (sess.paused) conn.pause();
        return;
      }
      if (!sess) { conn.destroy(); return; }
      if (type === T.SHARD) sess.onShard(payload);
      else if (type === T.CONN_END && role === "data") sess.ended.add(conn);
      else if (type === T.END && role === "ctrl") {
        try { await sess.onEnd(); } catch (e) { sess.fail(e.message); }
      }
    });
    conn.onClose(() => {
      if (!sess) return;
      if (role === "data") sess.ended.add(conn);
      else if (role === "ctrl" && !sess.done) sess.close();
    });
  };
  const srv = await tp.listen({ host, port, onConnection });
  return { port: srv.port, host, publicKey: keypair.publicKey, outDir: rx.outDir, stats: rx.stats, encrypt,
    close: async () => { for (const s of [...rx.sessions.values()]) s.close(); await srv.close(); } };
}

/** Round-trip a small payload on an open connection (latency probe). */
export async function pingLatency({ host = "127.0.0.1", port, count = 200, size = 64, transport = "tcp", keypair, expectReceiver, encrypt = true }) {
  requireEncryptOrLoopback(encrypt, host, "pingLatency");
  if (encrypt && !keypair) throw new TransferError("pingLatency: keypair is required when encryption is on");
  const conn = await TRANSPORTS[transport].connect({ host, port });
  if (encrypt) {
    const hs = clientHandshake(keypair);
    const ok = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new TransferError("timed out waiting for handshake")), 15000);
      conn.onFrame((type, payload) => {
        if (type === T.HS_OK || type === T.ERROR) { clearTimeout(t); resolve({ type, payload }); }
      });
      conn.onClose((e) => { clearTimeout(t); reject(new TransferError(`connection closed${e ? ": " + e.message : ""}`)); });
      conn.send(T.HS, jsonPayload(hs.payload));
    });
    if (ok.type === T.ERROR) throw new TransferError(parseJson(ok.payload).error);
    const fin = finishHandshake(hs.eph, hs.nonce, parseJson(ok.payload), { expectReceiver });
    const ciphers = deriveCiphers({
      shared: fin.shared, clientEph: hs.eph.publicKeyBytes, serverEph: fin.serverEph,
      clientId: keypair.publicKey, serverId: fin.receiver, nonce: hs.nonce, context: "ctrl", side: "client",
    });
    conn.installCipher(ciphers.send, ciphers.recv);
  }
  const payload = randomBytes(size);
  const lat = [];
  let resolveFn = null;
  conn.onFrame((type) => { if (type === T.PONG && resolveFn) { const r = resolveFn; resolveFn = null; r(); } });
  for (let i = 0; i < count; i++) {
    const a = performance.now();
    await new Promise((r) => { resolveFn = r; conn.send(T.PING, payload); });
    lat.push(performance.now() - a);
  }
  conn.destroy();
  lat.sort((a, b) => a - b);
  const q = (p) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))];
  return { count, size, p50: q(0.5), p90: q(0.9), p99: q(0.99), min: lat[0], max: lat[lat.length - 1] };
}

// ---------------------------------------------------------------- paths, directories, vc homes

function run(argv, opts = {}) {
  return new Promise((resolve) => {
    const p = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { err += d; });
    p.on("error", (e) => resolve({ code: -1, stdout: out, stderr: e.message }));
    p.on("close", (code) => resolve({ code, stdout: out, stderr: err }));
  });
}

/**
 * Send a file or a directory. Directories are streamed into a .tar in a
 * temp staging dir first (constant memory, needs free disk equal to the
 * directory size), then sent as one file. Zips and tars send as-is.
 */
export async function sendPath(path, opts = {}) {
  const st = statSync(path);
  if (st.isFile()) return sendFile(path, opts);
  if (!st.isDirectory()) throw new TransferError(`${path} is not a file or directory`);
  const stage = mkdtempSync(join(opts.stagingDir || tmpdir(), "kiln-send-"));
  const tarName = `${basename(resolvePath(path))}.tar`;
  const tarPath = join(stage, tarName);
  try {
    const r = await run(["tar", "-cf", tarPath, "-C", dirname(resolvePath(path)), basename(resolvePath(path))]);
    if (r.code !== 0) throw new TransferError(`tar failed: ${r.stderr.trim()}`);
    return { ...(await sendFile(tarPath, { ...opts, name: opts.name || tarName })), packed: "tar" };
  } finally { await rm(stage, { recursive: true, force: true }); }
}

/** Unpack a received .tar next to it and remove the tar. */
export async function extractTar(tarPath, destDir) {
  await mkdir(destDir, { recursive: true });
  const r = await run(["tar", "-xf", tarPath, "-C", destDir, "--no-same-owner"]);
  if (r.code !== 0) throw new TransferError(`tar -x failed: ${r.stderr.trim()}`);
  await unlink(tarPath);
  return destDir;
}

/** Resolve a path relative to a vc home, refusing anything that escapes it. */
export function homeRelative(rel) {
  const n = posix.normalize(String(rel || ".").replace(/^\/+/, ""));
  if (n === ".." || n.startsWith("../")) throw new TransferError(`path ${rel} escapes the computer's home`);
  return n;
}

async function vcContext(stateDir, ref) {
  const { resolveVc, getBackends } = await import("./vcomputer.mjs");
  const vc = resolveVc(stateDir, ref);
  const backend = getBackends()[vc.backend];
  if (!backend) throw new TransferError(`virtual computer ${vc.name} uses unknown backend ${vc.backend}`);
  return { vc, backend };
}

/**
 * Send a file or directory out of a virtual computer's home.
 * local backend: read straight from the host-side home dir.
 * docker backend: `docker cp` it to host staging, send, delete staging.
 */
export async function sendFromComputer(stateDir, ref, relPath, opts = {}) {
  const { vc, backend } = await vcContext(stateDir, ref);
  const rel = homeRelative(relPath);
  if (vc.backend === "local") return sendPath(join(vc.baseDir, "home", rel), opts);
  const stage = mkdtempSync(join(opts.stagingDir || tmpdir(), "kiln-vcout-"));
  try {
    const r = await backend.docker(["cp", `${backend.ctr(vc)}:/home/agent/${rel}`, stage + "/"], { timeoutMs: 24 * 3600e3 });
    if (r.code !== 0) throw new TransferError(`docker cp out of ${vc.name} failed: ${r.stderr.trim()}`);
    return await sendPath(join(stage, posix.basename(rel === "." ? "agent" : rel)), opts);
  } finally { await rm(stage, { recursive: true, force: true }); }
}

/**
 * Receive into a virtual computer's home (subdir relative to it).
 * Returns the startReceiver handle. local backend writes straight into the
 * home; docker backend lands files in host staging then `docker cp`s them
 * into /home/agent/<subdir> and chowns them to the agent user.
 */
export async function receiveIntoComputer(stateDir, ref, { subdir = "inbox", extract = false, ...opts } = {}) {
  const { vc, backend } = await vcContext(stateDir, ref);
  const rel = homeRelative(subdir);
  const userDone = opts.onComplete;
  if (vc.backend === "local") {
    const dest = join(vc.baseDir, "home", rel);
    return startReceiver({ ...opts, outDir: dest, onComplete: async (r, env) => {
      if (extract && r.name.endsWith(".tar")) r.extracted = await extractTar(r.path, dest);
      if (userDone) await userDone(r, env);
      return { vc: vc.id, homePath: posix.join("~", rel, r.name) };
    } });
  }
  const stage = join(stateDir, "transfer", "staging", vc.id);
  await mkdir(stage, { recursive: true, mode: 0o700 });
  return startReceiver({ ...opts, outDir: stage, onComplete: async (r, env) => {
    const ctr = backend.ctr(vc);
    const target = `/home/agent/${rel}`;
    let res = await backend.docker(["exec", "-u", "agent", ctr, "mkdir", "-p", target], { timeoutMs: 60000 });
    if (res.code !== 0) throw new TransferError(`mkdir in ${vc.name} failed: ${res.stderr.trim()}`);
    res = await backend.docker(["cp", r.path, `${ctr}:${target}/`], { timeoutMs: 24 * 3600e3 });
    await unlink(r.path).catch(() => {});
    if (res.code !== 0) throw new TransferError(`docker cp into ${vc.name} failed: ${res.stderr.trim()}`);
    const inside = posix.join(target, basename(r.path));
    await backend.docker(["exec", "-u", "root", ctr, "chown", "agent:agent", inside], { timeoutMs: 60000 });
    if (extract && inside.endsWith(".tar")) {
      res = await backend.docker(["exec", "-u", "agent", "-w", target, ctr, "sh", "-c", 'tar -xf "$1" && rm -f "$1"', "x", inside], { timeoutMs: 24 * 3600e3 });
      if (res.code !== 0) throw new TransferError(`tar -x in ${vc.name} failed: ${res.stderr.trim()}`);
    }
    if (userDone) await userDone(r, env);
    return { vc: vc.id, homePath: inside, path: undefined };
  } });
}
