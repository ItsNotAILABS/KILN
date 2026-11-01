/**
 * Encrypted email storage — the ONLY way an email address may rest in
 * the swarm's state dir.
 *
 * The architect's rule (2026-10-31): an account can be tied to its
 * email for business users, "but encrypt my email and stuff". So:
 *
 *   - At rest an email exists ONLY as an AES-256-GCM ciphertext plus
 *     an HMAC-SHA256 lookup tag over the normalized address. Matching
 *     (login, invite acceptance, duplicate checks) compares HMACs —
 *     nothing is ever decrypted to find a record.
 *   - The master key lives in <stateDir>/email.key (mode 0600,
 *     generated on first use, never committed, never logged). The
 *     encryption and HMAC keys are HKDF-derived from it under
 *     separate info labels, so the two uses never share key material.
 *   - Decryption exists for exactly two internal purposes: comparing
 *     a legacy plaintext address during migration, and git commit
 *     authorship (the forge's actor identity, in-memory only). No
 *     endpoint returns a decrypted address — the public shape of an
 *     email is its masked form ("a•••@example.com").
 *   - Normalization is trim + lowercase, the same rule login has
 *     always applied to address matching.
 */
import {
  createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes,
} from "node:crypto";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomicSync } from "./state.mjs";

const KEY_FILE = "email.key";
const ENC_VERSION = "v1";

// One master key per state dir, cached in-process (the daemon is the
// only writer; the file never changes under a running process).
const keyCache = new Map();

function loadMasterKey(dir) {
  if (keyCache.has(dir)) return keyCache.get(dir);
  const p = join(dir, KEY_FILE);
  let master;
  if (existsSync(p)) {
    master = Buffer.from(readFileSync(p, "utf8").trim(), "base64");
    if (master.length !== 32) {
      throw new Error(`${KEY_FILE} is corrupt (expected 32 bytes of base64) — refusing to guess a new key and orphan every stored email`);
    }
  } else {
    master = randomBytes(32);
    writeFileAtomicSync(p, master.toString("base64") + "\n", { mode: 0o600 });
    try { chmodSync(p, 0o600); } catch { /* best effort */ }
  }
  keyCache.set(dir, master);
  return master;
}

function derivedKeys(dir) {
  const master = loadMasterKey(dir);
  return {
    encKey: Buffer.from(hkdfSync("sha256", master, "kiln-email-v1", "aes-256-gcm", 32)),
    hmacKey: Buffer.from(hkdfSync("sha256", master, "kiln-email-v1", "hmac-sha256", 32)),
  };
}

/** Trim + lowercase — the canonical form every match runs against. */
export function normalizeEmail(email) {
  if (typeof email !== "string") return null;
  const n = email.trim().toLowerCase();
  return n || null;
}

/** The masked public shape: first local char + "•••" + "@domain". */
export function maskEmail(email) {
  const n = normalizeEmail(email);
  if (!n) return null;
  const at = n.lastIndexOf("@");
  if (at <= 0) return null;
  return `${n[0]}•••@${n.slice(at + 1)}`;
}

/** HMAC-SHA256 lookup tag for a (normalized) address. */
export function emailHmac(dir, email) {
  const n = normalizeEmail(email);
  if (!n) return null;
  const { hmacKey } = derivedKeys(dir);
  return createHmac("sha256", hmacKey).update(n, "utf8").digest("hex");
}

/**
 * Generic AES-256-GCM text encryption under the same key — the
 * mailer stores an invite's token this way in the outbox, so a
 * secret never rests in plaintext there either.
 * Format: "v1.<base64 iv|tag|ciphertext>".
 */
export function encryptText(dir, text) {
  if (typeof text !== "string" || !text) return null;
  const { encKey } = derivedKeys(dir);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encKey, iv);
  const ct = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_VERSION}.${Buffer.concat([iv, tag, ct]).toString("base64")}`;
}

/** Decrypt an encryptText value. INTERNAL ONLY. Null on any failure. */
export function decryptText(dir, enc) {
  if (typeof enc !== "string" || !enc.startsWith(`${ENC_VERSION}.`)) return null;
  try {
    const raw = Buffer.from(enc.slice(ENC_VERSION.length + 1), "base64");
    if (raw.length < 12 + 16 + 1) return null;
    const { encKey } = derivedKeys(dir);
    const decipher = createDecipheriv("aes-256-gcm", encKey, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** AES-256-GCM encrypt of the normalized address. */
export function encryptEmail(dir, email) {
  const n = normalizeEmail(email);
  if (!n) return null;
  return encryptText(dir, n);
}

/**
 * Decrypt a stored email ciphertext. INTERNAL ONLY — the result
 * feeds migration comparisons, in-memory git authorship, and the
 * mailer's send step, never a response body. Null on any failure.
 */
export function decryptEmail(dir, emailEnc) {
  return decryptText(dir, emailEnc);
}

/**
 * The full stored binding for an address: lookup tag + ciphertext +
 * masked public form. This exact shape rides on account records
 * (accounts.mjs) and workspace invite records (invites.mjs).
 */
export function makeEmailBinding(dir, email) {
  const enc = encryptEmail(dir, email);
  if (!enc) return null;
  return {
    emailHmac: emailHmac(dir, email),
    emailEnc: enc,
    emailMasked: maskEmail(email),
  };
}
