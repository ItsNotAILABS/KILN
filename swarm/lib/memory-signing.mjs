/**
 * KILN Memory phase 2 — signed events (Ed25519, node:crypto only).
 *
 * Every memory event appended through lib/memory.mjs is signed by the
 * state dir's memory key: a per-state-dir Ed25519 keypair generated on
 * first use and stored at <stateDir>/memory-signing.key (mode 0600,
 * JSON — the lib/keys.mjs stored shape). The key NEVER lives in the
 * repo or in git; what travels with the chain is the public half,
 * embedded in every signed event:
 *
 *   signer    sha256(raw public key) — the keys.mjs node-id form
 *   signerKey the SPKI public key, base64 (self-contained verify)
 *   sig       Ed25519 signature (hex) over the event's hash
 *
 * `signer` and `signerKey` are part of the hashed event body (the hash
 * chain covers WHO claims to have written the event); `sig` is not —
 * it signs the hash. Verification therefore needs no key server and
 * no state dir: any copy of the chain (including the GitHub copy that
 * phase 5 promote replays) verifies standalone.
 *
 * The signing epoch — the legacy boundary:
 *   History written before phase 2 is unsigned, and it stays readable
 *   forever. A chain's signing epoch opens at the first event that
 *   carries a `sig`. From that event on, EVERY event must carry a
 *   valid signature: a missing signature after the epoch, a signature
 *   that does not verify, or a signerKey that does not hash to the
 *   claimed signer is a loud error, never a silent trust. Events
 *   before the epoch classify as "unsigned-legacy". New writes
 *   through the library always sign, so a chain born after phase 2
 *   has its epoch at seq 0.
 *
 * Key replacement is not rotation machinery: if the key file is lost
 * and regenerated, the new key signs subsequent events (each event
 * names and carries its own signer key, so old events still verify).
 * The chain is the record of which keys signed what.
 */
import { existsSync, readFileSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { createPublicKey, verify } from "node:crypto";
import { sha256hex, sha256hexOfCanon } from "./canon.mjs";
import { newKeypair, loadKeypair } from "./keys.mjs";

export const MEMORY_SIGNING_KEY_FILE = "memory-signing.key";

const keyCache = new Map(); // stateDir -> signing handle (process-lifetime)

export function memorySigningKeyPath(dir) {
  return join(dir, MEMORY_SIGNING_KEY_FILE);
}

function readStoredKey(path) {
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) {
    throw new Error(
      `memory signing: ${path} must be mode 0600 (found 0${mode.toString(8)}) — ` +
      "a group/world-readable private key makes every signature meaningless; tighten it and retry");
  }
  let stored;
  try { stored = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error(`memory signing: ${path} is not valid JSON`); }
  if (!stored || typeof stored.pubSpkiB64 !== "string" || typeof stored.privPkcs8B64 !== "string") {
    throw new Error(`memory signing: ${path} does not hold a keypair`);
  }
  return stored;
}

function handleFromStored(stored) {
  const kp = loadKeypair(stored); // throws on malformed key material
  return {
    signer: kp.id,
    pubRawHex: kp.pubRawHex,
    pubSpkiB64: stored.pubSpkiB64,
    signText: kp.signText,
  };
}

/** The state dir's signing key, or null when none exists yet. Never creates. */
export function loadMemoryKey(dir) {
  if (keyCache.has(dir)) return keyCache.get(dir);
  const path = memorySigningKeyPath(dir);
  if (!existsSync(path)) return null;
  const handle = handleFromStored(readStoredKey(path));
  keyCache.set(dir, handle);
  return handle;
}

/**
 * The state dir's signing key, generating and persisting a fresh
 * keypair (mode 0600) on first use. Writers call this — a memory
 * write that cannot sign fails loudly here rather than landing
 * unsigned after the epoch has opened.
 */
export function loadOrCreateMemoryKey(dir) {
  const existing = loadMemoryKey(dir);
  if (existing) return existing;
  const path = memorySigningKeyPath(dir);
  const kp = newKeypair();
  const stored = {
    v: 1,
    pubSpkiB64: kp.pubSpkiB64,
    privPkcs8B64: kp.privPkcs8B64,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(path, JSON.stringify(stored, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600); // mode at create is umask-filtered; make it exact
  const handle = handleFromStored(stored);
  keyCache.set(dir, handle);
  return handle;
}

/**
 * The discoverable public half of the state dir's memory key:
 * { signer, pubRawHex, pubSpkiB64 }. Creates the key on first use
 * when `create` is set (the `memory pubkey` surface); otherwise
 * returns null when no key exists yet.
 */
export function memorySigningPubkey(dir, { create = false } = {}) {
  const key = create ? loadOrCreateMemoryKey(dir) : loadMemoryKey(dir);
  if (!key) return null;
  return { signer: key.signer, pubRawHex: key.pubRawHex, pubSpkiB64: key.pubSpkiB64 };
}

// ------------------------------------------------------------ event signing

/** The event body its hash covers: everything except `hash` and `sig`. */
export function unsignedEventBody(ev) {
  const { hash, sig, ...rest } = ev;
  return rest;
}

export function computeEventHash(ev) {
  return sha256hexOfCanon(unsignedEventBody(ev));
}

/** sha256(raw ed25519 public key) — the signer id a signerKey must hash to. */
export function signerIdOfKey(pubSpkiB64) {
  const der = Buffer.from(pubSpkiB64, "base64");
  if (der.length < 32) throw new Error("memory signing: signerKey is not an ed25519 SPKI key");
  return sha256hex(der.subarray(der.length - 32));
}

function verifyWithKey(pubSpkiB64, text, sigHex) {
  try {
    const pub = createPublicKey({ key: Buffer.from(pubSpkiB64, "base64"), format: "der", type: "spki" });
    return verify(null, Buffer.from(text, "utf8"), pub, Buffer.from(sigHex, "hex"));
  } catch {
    return false; // malformed key or signature bytes = invalid, not a crash
  }
}

/**
 * Verify ONE event's signature in isolation (no epoch logic): the
 * signerKey must hash to the claimed signer, and `sig` must verify
 * over the event's stored hash under that key. Returns false for an
 * unsigned event — callers decide whether unsigned is acceptable
 * (pre-epoch) or a violation (post-epoch, see verifyEventSignatures).
 */
export function verifyEventSignature(ev) {
  if (typeof ev.sig !== "string" || !ev.sig) return false;
  if (typeof ev.signer !== "string" || typeof ev.signerKey !== "string") return false;
  let bound;
  try { bound = signerIdOfKey(ev.signerKey) === ev.signer; } catch { return false; }
  if (!bound) return false;
  return verifyWithKey(ev.signerKey, String(ev.hash || ""), ev.sig);
}

/**
 * The signature-epoch walk over parsed events in chain order. Assumes
 * each event's hash/prev have already been checked (readEvents does;
 * verifyEventChain below does both). Returns:
 *   { signed, legacy, epochStart (seq | null), signers: [signerIds] }
 * Throws a precise Error on the first signature violation:
 *   - an event at/after the epoch carries no signature
 *   - a signature that fails binding or verification
 */
export function verifyEventSignatures(events) {
  let signed = 0;
  let epochStart = null;
  const signers = new Set();
  for (const ev of events) {
    const hasSig = typeof ev.sig === "string" && !!ev.sig;
    if (hasSig && epochStart === null) epochStart = ev.seq;
    if (!hasSig) {
      if (epochStart !== null) {
        throw new Error(
          `memory: event ${ev.id} (seq ${ev.seq}) has no signature but the signing epoch ` +
          `opened at seq ${epochStart} — unsigned writes are only valid before the epoch`);
      }
      continue;
    }
    if (!verifyEventSignature(ev)) {
      throw new Error(
        `memory: signature verification failed for event ${ev.id} (seq ${ev.seq}) — ` +
        "the event was altered after signing, or its signerKey does not match its signer");
    }
    signed++;
    signers.add(ev.signer);
  }
  return { signed, legacy: events.length - signed, epochStart, signers: [...signers] };
}

/**
 * Full authenticity walk over parsed events in chain order: prev
 * linkage, hash recompute, then the signature epoch rules. Used by
 * the promote replay path (lib/promote.mjs listMemoryCommits), which
 * reads events outside lib/memory.mjs's readEvents. Returns the same
 * summary as verifyEventSignatures; throws on the first violation of
 * any kind.
 */
export function verifyEventChain(events) {
  let prevHash = "GENESIS";
  for (const ev of events) {
    if (ev.prev !== prevHash) {
      throw new Error(`memory: hash chain broken at event ${ev.id} (seq ${ev.seq})`);
    }
    if (computeEventHash(ev) !== ev.hash) {
      throw new Error(`memory: event hash mismatch at event ${ev.id} (seq ${ev.seq})`);
    }
    prevHash = ev.hash;
  }
  return verifyEventSignatures(events);
}

/** Counts only (no verification): { signed, legacy, epochStart, signers }. */
export function signatureSummary(events) {
  let signed = 0;
  let epochStart = null;
  const signers = new Set();
  for (const ev of events) {
    if (typeof ev.sig === "string" && ev.sig) {
      signed++;
      if (epochStart === null) epochStart = ev.seq;
      if (typeof ev.signer === "string") signers.add(ev.signer);
    }
  }
  return { signed, legacy: events.length - signed, epochStart, signers: [...signers] };
}
