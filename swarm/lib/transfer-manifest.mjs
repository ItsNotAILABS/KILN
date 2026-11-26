/**
 * transfer-manifest.mjs — content-addressed, ed25519-signed manifests.
 *
 * A file is cut into fixed-size chunks (data shards). Consecutive chunks are
 * grouped into stripes of k data shards; each stripe also gets m Reed-Solomon
 * parity shards on the wire. The manifest lists the SHA-256 of every data
 * chunk plus `root`, the SHA-256 over all chunk hashes. Parity shards are not hashed:
 * anything rebuilt from parity is checked against the data-chunk hashes, so
 * corrupt parity is caught the same way corrupt data is.
 *
 * Manifest id = SHA-256 of the canonical JSON (sorted keys, no spaces).
 * The sender signs the UTF-8 bytes of "kiln-transfer/1:" + id with its
 * ed25519 key; the signature and the sender's base58 public key travel with
 * the manifest. File bytes never go anywhere but the transfer streams.
 */
import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { basename } from "node:path";
import { Worker } from "node:worker_threads";
import { availableParallelism } from "node:os";
import { signBytes, verifyBytes } from "./transfer-identity.mjs";

import { checkParams } from "./transfer-rs.mjs";

export const MANIFEST_TYPE = "kiln.transfer/1";
export const DEFAULTS = Object.freeze({ chunkSize: 1 << 20, dataShards: 16, parityShards: 2 });
export const MAX_CHUNK = 16 << 20;

export function canonicalJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(v).sort().filter((k) => v[k] !== undefined)
    .map((k) => JSON.stringify(k) + ":" + canonicalJson(v[k])).join(",") + "}";
}

export function manifestId(manifest) {
  return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}

export function sigMessage(id) { return Buffer.from(`kiln-transfer/1:${id}`, "utf8"); }

export function safeName(name) {
  const b = basename(String(name || "")).replace(/[\u0000-\u001f/\\]/g, "_");
  if (!b || b === "." || b === "..") return "file";
  return b.slice(0, 255);
}

export function geometry(m) {
  const chunks = m.size === 0 ? 0 : Math.ceil(m.size / m.chunkSize);
  const stripes = Math.ceil(chunks / m.dataShards);
  return { chunks, stripes };
}

/** Data-shard count of stripe s (the last stripe may be short). */
export function stripeK(m, s) {
  const { chunks } = geometry(m);
  return Math.min(m.dataShards, chunks - s * m.dataShards);
}

/** Byte length of chunk c (the last chunk may be short). */
export function chunkLen(m, c) {
  return Math.min(m.chunkSize, m.size - c * m.chunkSize);
}

/** root = SHA-256 over the concatenated raw chunk hashes. */
export function chunkRoot(chunks) {
  const h = createHash("sha256");
  for (const c of chunks) h.update(Buffer.from(c, "hex"));
  return h.digest("hex");
}

async function hashRange(path, chunkSize, size, from, to) {
  const fh = await open(path, "r");
  const out = [];
  try {
    const buf = Buffer.allocUnsafe(chunkSize);
    for (let c = from; c < to; c++) {
      const pos = c * chunkSize, want = Math.min(chunkSize, size - pos);
      let got = 0;
      while (got < want) {
        const { bytesRead } = await fh.read(buf, got, want - got, pos + got);
        if (bytesRead === 0) throw new Error(`${path} shrank while hashing`);
        got += bytesRead;
      }
      out.push(createHash("sha256").update(buf.subarray(0, want)).digest("hex"));
    }
  } finally { await fh.close(); }
  return out;
}

/**
 * Hash a file from disk in chunkSize pieces (constant memory per worker) and
 * build its manifest. Large files are split across `workers` threads, each
 * hashing a contiguous range of chunks.
 */
export async function buildManifest(path, { name, chunkSize = DEFAULTS.chunkSize, dataShards = DEFAULTS.dataShards,
  parityShards = DEFAULTS.parityShards, sender, workers = Math.min(4, availableParallelism()) } = {}) {
  if (!Number.isInteger(chunkSize) || chunkSize < 1024 || chunkSize > MAX_CHUNK) throw new Error(`chunkSize must be 1KiB..${MAX_CHUNK} bytes`);
  checkParams(dataShards, parityShards);
  const st = await stat(path);
  if (!st.isFile()) throw new Error(`${path} is not a regular file`);
  const size = st.size;
  const n = size === 0 ? 0 : Math.ceil(size / chunkSize);
  let chunks;
  if (workers <= 1 || n < 64) chunks = await hashRange(path, chunkSize, size, 0, n);
  else {
    const per = Math.ceil(n / workers);
    const parts = [];
    for (let from = 0; from < n; from += per) {
      const to = Math.min(n, from + per);
      parts.push(new Promise((resolve, reject) => {
        const w = new Worker(new URL("./transfer-hash-worker.mjs", import.meta.url), { workerData: { path, chunkSize, size, from, to } });
        w.once("message", resolve); w.once("error", reject);
        w.once("exit", (code) => { if (code) reject(new Error(`hash worker exited ${code}`)); });
      }));
    }
    chunks = (await Promise.all(parts)).flat();
  }
  return {
    type: MANIFEST_TYPE,
    name: safeName(name || basename(path)),
    size,
    chunkSize,
    dataShards,
    parityShards,
    hash: "sha256",
    chunks,
    root: chunkRoot(chunks),
    sender,
    mtime: st.mtime.toISOString(),
  };
}

export function signManifest(manifest, kp) {
  if (manifest.sender !== kp.publicKey) throw new Error("signManifest: manifest.sender must be the signer's public key");
  const id = manifestId(manifest);
  return { id, manifest, signature: signBytes(kp, sigMessage(id)).toString("base64") };
}

/** Throws unless the envelope is well-formed and signed by manifest.sender. */
export function verifySignedManifest(env, { trust } = {}) {
  if (!env || typeof env !== "object" || !env.manifest) throw new Error("manifest: missing");
  const m = env.manifest;
  if (m.type !== MANIFEST_TYPE) throw new Error(`manifest: unsupported type ${m.type}`);
  if (!Number.isSafeInteger(m.size) || m.size < 0) throw new Error("manifest: bad size");
  if (!Number.isInteger(m.chunkSize) || m.chunkSize < 1024 || m.chunkSize > MAX_CHUNK) throw new Error("manifest: bad chunkSize");
  checkParams(m.dataShards, m.parityShards);
  const { chunks } = geometry(m);
  if (!Array.isArray(m.chunks) || m.chunks.length !== chunks || !m.chunks.every((h) => /^[0-9a-f]{64}$/.test(h))) {
    throw new Error("manifest: chunk hash list does not match size/chunkSize");
  }
  if (m.root !== chunkRoot(m.chunks)) throw new Error("manifest: root does not match chunk hashes");
  const id = manifestId(m);
  if (env.id && env.id !== id) throw new Error("manifest: id does not match content");
  if (typeof m.sender !== "string" || !verifyBytes(m.sender, sigMessage(id), Buffer.from(String(env.signature || ""), "base64"))) {
    throw new Error("manifest: bad signature");
  }
  if (trust && trust.length && !trust.includes(m.sender)) throw new Error(`manifest: sender ${m.sender} is not trusted`);
  return id;
}

/** Origin authorizes a hop to forward this manifest to `children`. */
export function signHopGrant(kp, { manifestId, hop, children = [] }) {
  const body = { manifestId, hop, children };
  return { ...body, sig: signBytes(kp, Buffer.from("kiln-transfer/1:hop:" + canonicalJson(body))).toString("base64") };
}

export function verifyHopGrant(originPub, grant, { manifestId, hop }) {
  if (!grant || grant.manifestId !== manifestId || grant.hop !== hop) return false;
  const body = { manifestId: grant.manifestId, hop: grant.hop, children: grant.children || [] };
  return verifyBytes(originPub, Buffer.from("kiln-transfer/1:hop:" + canonicalJson(body)), Buffer.from(String(grant.sig || ""), "base64"));
}
