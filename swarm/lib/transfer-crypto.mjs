/**
 * transfer-crypto.mjs — authenticated encryption for the transfer wire.
 *
 * Handshake: each side generates an ephemeral X25519 key and signs it
 * (plus a nonce, and on the data path the session id) with its long-term
 * ed25519 identity. A shared secret is HKDF-SHA-256'd into two
 * AES-256-GCM keys, one per direction, bound to both identities and both
 * ephemerals. Frame nonces are a 64-bit counter that never wraps
 * (12-byte nonce = 4 zero bytes + u64be counter, starting at 1). A failed
 * tag, a reused or out-of-order nonce, or a wrapped counter is rejected.
 *
 * Zero dependencies (node:crypto only).
 */
import { generateKeyPairSync, diffieHellman, createPublicKey, hkdfSync, createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { signBytes, verifyBytes } from "./transfer-identity.mjs";

const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");
const NONCE_LEN = 12, TAG_LEN = 16;
const MAX_COUNTER = (2n ** 64n) - 1n;

export const NONCE_SIZE = NONCE_LEN;
export const TAG_SIZE = TAG_LEN;

export function isLoopback(host) {
  const h = String(host || "").replace(/^\[|\]$/g, "").toLowerCase();
  return h === "127.0.0.1" || h === "::1" || h === "localhost" || h === "0:0:0:0:0:0:0:1";
}

/** Throw unless encryption is on, or both sides are explicitly insecure on loopback. */
export function requireEncryptOrLoopback(encrypt, host, what) {
  if (encrypt !== false) return;
  if (!isLoopback(host)) {
    throw new Error(`${what}: --insecure / encrypt:false is only allowed on loopback (127.0.0.1, ::1, localhost), not ${host}`);
  }
}

export function generateX25519() {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(SPKI_X25519.length);
  return { privateKey, publicKeyBytes: Buffer.from(pub) };
}

export function x25519Shared(privateKey, theirPub) {
  const raw = Buffer.isBuffer(theirPub) ? theirPub : Buffer.from(theirPub);
  if (raw.length !== 32) throw new Error("x25519: public key must be 32 bytes");
  const their = createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: "der", type: "spki" });
  return diffieHellman({ privateKey, publicKey: their });
}

export function hsBytes(role, parts) {
  const chunks = [Buffer.from(`kiln-transfer/1:hs:${role}:`, "utf8")];
  for (const p of parts) chunks.push(Buffer.isBuffer(p) ? p : Buffer.from(String(p)));
  return Buffer.concat(chunks);
}

/**
 * Derive per-direction AES-256-GCM ciphers. `side` is "client" or "server"
 * and only chooses which key is used to send.
 */
export function deriveCiphers({ shared, clientEph, serverEph, clientId, serverId, nonce, context = "ctrl", side }) {
  const salt = createHash("sha256")
    .update(clientEph).update(serverEph)
    .update(String(clientId)).update(String(serverId))
    .update(nonce).update(String(context))
    .digest();
  const okm = Buffer.from(hkdfSync("sha256", shared, salt, "kiln-transfer/1:aes-256-gcm", 64));
  const c2s = new FrameCipher(okm.subarray(0, 32));
  const s2c = new FrameCipher(okm.subarray(32, 64));
  if (side === "server") return { send: s2c, recv: c2s };
  return { send: c2s, recv: s2c };
}

export class FrameCipher {
  constructor(key) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("AES-256-GCM key must be 32 bytes");
    this.key = Buffer.from(key);
    this._send = 0n;
    this._recv = 0n;
    this.sentNonces = [];
  }
  nonceFor(counter) {
    const n = Buffer.alloc(NONCE_LEN);
    n.writeBigUInt64BE(counter, 4);
    return n;
  }
  /** Encrypt `plain`. Optional `tamper` (byte index) flips a ciphertext byte after sealing — tests only. */
  seal(plain, { tamper, record = false } = {}) {
    if (this._send >= MAX_COUNTER) throw new Error("AES-GCM nonce space exhausted");
    this._send += 1n;
    const nonce = this.nonceFor(this._send);
    if (record) this.sentNonces.push(Buffer.from(nonce));
    const c = createCipheriv("aes-256-gcm", this.key, nonce, { authTagLength: TAG_LEN });
    const ct = Buffer.concat([c.update(plain), c.final()]);
    const tag = c.getAuthTag();
    if (tamper !== undefined && ct.length) ct[tamper % ct.length] ^= 0xff;
    return Buffer.concat([nonce, ct, tag]);
  }
  open(wired) {
    if (!Buffer.isBuffer(wired) || wired.length < NONCE_LEN + TAG_LEN + 1) {
      throw new Error("ciphertext rejected: short frame");
    }
    const nonce = wired.subarray(0, NONCE_LEN);
    const tag = wired.subarray(wired.length - TAG_LEN);
    const ct = wired.subarray(NONCE_LEN, wired.length - TAG_LEN);
    if (nonce[0] || nonce[1] || nonce[2] || nonce[3]) throw new Error("ciphertext rejected: bad nonce");
    const counter = nonce.readBigUInt64BE(4);
    if (counter === 0n || counter <= this._recv) throw new Error("ciphertext rejected: reused or out-of-order nonce");
    const d = createDecipheriv("aes-256-gcm", this.key, nonce, { authTagLength: TAG_LEN });
    d.setAuthTag(tag);
    let plain;
    try { plain = Buffer.concat([d.update(ct), d.final()]); }
    catch { throw new Error("ciphertext rejected: authentication tag check failed"); }
    this._recv = counter;
    return plain;
  }
  get sendCounter() { return this._send; }
}

/** Build the client's first handshake frame (HS or the fields hanging off JOIN). */
export function clientHandshake(kp, { session } = {}) {
  const eph = generateX25519();
  const nonce = randomBytes(16);
  const role = session ? "j" : "c";
  const parts = session ? [eph.publicKeyBytes, nonce, session] : [eph.publicKeyBytes, nonce];
  return {
    eph, nonce,
    payload: {
      v: 1,
      ephPub: eph.publicKeyBytes.toString("base64"),
      nonce: nonce.toString("base64"),
      sender: kp.publicKey,
      session,
      sig: signBytes(kp, hsBytes(role, parts)).toString("base64"),
    },
  };
}

/** Verify the client's handshake and build HS_OK / JOINED. `expectedSender` is required on the data path. */
export function serverHandshake(kp, clientMsg, { session, expectedSender } = {}) {
  if (!clientMsg || clientMsg.v !== 1) throw new Error("handshake: unsupported version");
  const ephPub = Buffer.from(String(clientMsg.ephPub || ""), "base64");
  const nonce = Buffer.from(String(clientMsg.nonce || ""), "base64");
  if (ephPub.length !== 32 || nonce.length !== 16) throw new Error("handshake: bad ephemeral key or nonce");
  const sender = expectedSender || clientMsg.sender;
  const role = session ? "j" : "c";
  const parts = session ? [ephPub, nonce, session] : [ephPub, nonce];
  if (!sender || !verifyBytes(sender, hsBytes(role, parts), Buffer.from(String(clientMsg.sig || ""), "base64"))) {
    throw new Error("handshake signature is invalid");
  }
  const eph = generateX25519();
  const sRole = session ? "jd" : "s";
  const sParts = session ? [eph.publicKeyBytes, nonce, session, ephPub] : [eph.publicKeyBytes, nonce, ephPub];
  const shared = x25519Shared(eph.privateKey, ephPub);
  return {
    sender, nonce, clientEph: ephPub, serverEph: eph.publicKeyBytes, shared,
    payload: {
      ephPub: eph.publicKeyBytes.toString("base64"),
      receiver: kp.publicKey,
      sig: signBytes(kp, hsBytes(sRole, sParts)).toString("base64"),
    },
  };
}

/** Verify HS_OK / JOINED and compute the shared secret on the client. */
export function finishHandshake(eph, nonce, serverMsg, { session, expectReceiver } = {}) {
  if (!serverMsg || !serverMsg.ephPub || !serverMsg.receiver || !serverMsg.sig) throw new Error("handshake: truncated reply");
  if (expectReceiver && serverMsg.receiver !== expectReceiver) {
    throw new Error(`receiver is ${serverMsg.receiver}, expected ${expectReceiver}`);
  }
  const ephPub = Buffer.from(serverMsg.ephPub, "base64");
  if (ephPub.length !== 32) throw new Error("handshake: bad ephemeral key");
  const sRole = session ? "jd" : "s";
  const sParts = session ? [ephPub, nonce, session, eph.publicKeyBytes] : [ephPub, nonce, eph.publicKeyBytes];
  if (!verifyBytes(serverMsg.receiver, hsBytes(sRole, sParts), Buffer.from(serverMsg.sig, "base64"))) {
    throw new Error("handshake signature is invalid");
  }
  return { receiver: serverMsg.receiver, serverEph: ephPub, shared: x25519Shared(eph.privateKey, ephPub) };
}
