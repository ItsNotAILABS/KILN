/**
 * transfer-identity.mjs — Solana-compatible ed25519 identities for KILN
 * agent transfer. Zero dependencies (node:crypto only).
 *
 * - Public keys are 32-byte ed25519 keys printed in base58 (the same
 *   alphabet/encoding Solana uses for addresses).
 * - Keypair files use the `solana-keygen` JSON format: an array of 64
 *   numbers, the 32-byte seed followed by the 32-byte public key. A key
 *   made by `solana-keygen new` loads here, and one made here loads there.
 */
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomicSync } from "./state.mjs";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_MAP = new Map([...B58].map((c, i) => [c, i]));

export function b58encode(bytes) {
  const b = Buffer.from(bytes);
  let zeros = 0;
  while (zeros < b.length && b[zeros] === 0) zeros++;
  let n = BigInt("0x" + (b.length ? b.toString("hex") : "0"));
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  return "1".repeat(zeros) + out;
}

export function b58decode(str) {
  if (typeof str !== "string") throw new Error("base58: expected a string");
  let n = 0n;
  for (const c of str) {
    const v = B58_MAP.get(c);
    if (v === undefined) throw new Error(`base58: invalid character ${JSON.stringify(c)}`);
    n = n * 58n + BigInt(v);
  }
  let hex = n === 0n ? "" : n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  let zeros = 0;
  while (zeros < str.length && str[zeros] === "1") zeros++;
  return Buffer.concat([Buffer.alloc(zeros), Buffer.from(hex, "hex")]);
}

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Build a keypair object from a 32-byte seed. */
export function keypairFromSeed(seed) {
  seed = Buffer.from(seed);
  if (seed.length !== 32) throw new Error("ed25519 seed must be 32 bytes");
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(SPKI_ED25519_PREFIX.length);
  return { seed, publicKeyBytes: Buffer.from(pub), publicKey: b58encode(pub), privateKey, keyObject: publicKey };
}

export function generateKeypair() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(PKCS8_ED25519_PREFIX.length);
  return keypairFromSeed(seed);
}

/** solana-keygen format: JSON array [seed(32) ++ pubkey(32)]. */
export function keypairToSolanaJson(kp) {
  return JSON.stringify([...kp.seed, ...kp.publicKeyBytes]);
}

export function keypairFromSolanaJson(text) {
  const arr = JSON.parse(text);
  if (!Array.isArray(arr) || arr.length !== 64) throw new Error("keypair file must be a JSON array of 64 bytes (solana-keygen format)");
  const kp = keypairFromSeed(Buffer.from(arr.slice(0, 32)));
  if (!kp.publicKeyBytes.equals(Buffer.from(arr.slice(32)))) throw new Error("keypair file: public key does not match seed");
  return kp;
}

export function loadKeypairFile(path) { return keypairFromSolanaJson(readFileSync(path, "utf8")); }

/** Load the keypair at path, creating it (0600) on first use. */
export function loadOrCreateKeypair(path) {
  if (existsSync(path)) return loadKeypairFile(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const kp = generateKeypair();
  writeFileAtomicSync(path, keypairToSolanaJson(kp), { mode: 0o600 });
  return kp;
}

export function signBytes(kp, data) { return sign(null, Buffer.from(data), kp.privateKey); }

/** Verify an ed25519 signature against a base58 (or raw 32-byte) public key. */
export function verifyBytes(pubkey, data, sig) {
  const raw = typeof pubkey === "string" ? b58decode(pubkey) : Buffer.from(pubkey);
  if (raw.length !== 32) return false;
  const sigBuf = typeof sig === "string" ? b58decode(sig) : Buffer.from(sig);
  if (sigBuf.length !== 64) return false;
  const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: "der", type: "spki" });
  try { return verify(null, Buffer.from(data), key, sigBuf); } catch { return false; }
}
