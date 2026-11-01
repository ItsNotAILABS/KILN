/**
 * KILN accounts + agent identities.
 *
 * Until now the forge had exactly one principal: the operator, holding
 * the root token in <stateDir>/api.token. Accounts give the forge real
 * users — a person signs up, logs in, and mints scoped tokens for
 * THEIR agents. Three principal kinds now exist, resolved in order:
 *
 *   1. operator  — the root api.token (unchanged; root of the forge).
 *   2. session   — a person's login session, bearer `kiln_sess_…`.
 *   3. agent     — an agent identity owned by an account, bearer
 *                  `kiln_agt_…`, shown exactly once at creation.
 *
 * Storage is a disk-backed JSON store at <stateDir>/accounts.json,
 * written atomically (tmp + fsync + rename) exactly like
 * lib/workspaces.mjs's store. Secrets are hashed at rest, always:
 * passwords with scrypt (per-account salt), session and agent tokens
 * with sha256 (they are high-entropy random values; a fast hash is the
 * right tool and keeps token checks cheap). No hash, salt, or token
 * ever appears in a response or a log line.
 *
 * Owner scoping is enforced in lib/httpapi.mjs (the routes), not here:
 * this module owns identity — who you are — the routes own what a
 * principal may touch (an account acts only under its own `owner`
 * namespace). See swarm/docs/ACCOUNTS.md for the full model.
 */
import {
  createHash, createPublicKey, randomBytes, scryptSync, timingSafeEqual,
  verify as cryptoVerify,
} from "node:crypto";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomicSync } from "./state.mjs";
import {
  decryptEmail, emailHmac, makeEmailBinding, maskEmail, normalizeEmail,
} from "./emailcrypto.mjs";

export class AccountsError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "AccountsError";
    this.status = status;
  }
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const AGENT_SCOPES = ["workspaces", "project-details", "forge"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OWNER_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function accountsPath(dir) {
  return join(dir, "accounts.json");
}

function loadStore(dir) {
  const p = accountsPath(dir);
  if (!existsSync(p)) {
    return { accounts: {}, sessions: {}, agents: {}, wallets: {}, walletChallenges: {}, walletBackups: {} };
  }
  try {
    const s = JSON.parse(readFileSync(p, "utf8"));
    return {
      accounts: s.accounts || {},
      sessions: s.sessions || {},
      agents: s.agents || {},
      wallets: s.wallets || {},
      walletChallenges: s.walletChallenges || {},
      walletBackups: s.walletBackups || {},
    };
  } catch {
    return { accounts: {}, sessions: {}, agents: {}, wallets: {}, walletChallenges: {}, walletBackups: {} };
  }
}

/** Atomic store write (tmp + fsync + rename) — same discipline as lib/workspaces.mjs. */
function saveStore(dir, store) {
  writeFileAtomicSync(accountsPath(dir), JSON.stringify(store, null, 2) + "\n");
  // The store holds password/token hashes — keep it operator-only.
  try { chmodSync(accountsPath(dir), 0o600); } catch { /* best effort */ }
}

function sha256hex(s) {
  return createHash("sha256").update(s).digest("hex");
}

function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  const actual = scryptSync(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * The account shape that may leave the daemon. Never the hash — and,
 * once an email is bound, never the address itself: `email` carries
 * the masked form ("a•••@example.com") and `emailBound` says a
 * binding exists (see the encrypted email binding section below).
 * A legacy record that still carries a plaintext address (pre-binding
 * era) reports it until its first login or bind migrates it — the
 * migration paths are login() and bindAccountEmail().
 */
export function accountPublic(a) {
  const binding = a.emailBinding || null;
  return {
    id: a.id,
    email: binding ? binding.emailMasked : (a.email ?? null),
    emailBound: !!binding,
    emailMasked: binding ? binding.emailMasked : (a.email ? maskEmail(a.email) : null),
    name: a.name, owner: a.owner, createdAt: a.createdAt,
  };
}

/** The agent shape that may leave the daemon. Never the token or its hash. */
export function agentPublic(g) {
  return {
    id: g.id, accountId: g.accountId, name: g.name, scopes: [...g.scopes],
    createdAt: g.createdAt, revoked: !!g.revoked,
  };
}

function newId(prefix) {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

/**
 * Create an account. Validation is explicit and errors are verbatim —
 * they say what to fix. Namespace-content reservation (an owner that
 * already has repos/workspaces) is the caller's job (httpapi), because
 * it needs the git/workspace registries; uniqueness among accounts is
 * enforced here.
 */
export function createAccount(dir, { email, name, owner, password } = {}) {
  if (typeof email !== "string" || !EMAIL_RE.test(email)) {
    throw new AccountsError(400, "email must be a valid email address");
  }
  if (typeof name !== "string" || !name.trim() || name.length > 120) {
    throw new AccountsError(400, "name is required (max 120 chars)");
  }
  if (typeof owner !== "string" || !OWNER_RE.test(owner)) {
    throw new AccountsError(400, "owner must match [a-z0-9][a-z0-9-]{0,63} — it is your namespace on the forge");
  }
  if (typeof password !== "string" || password.length < 10) {
    throw new AccountsError(400, "password must be at least 10 characters");
  }
  const store = loadStore(dir);
  const emailKey = emailHmac(dir, email);
  const emailNorm = normalizeEmail(email);
  for (const a of Object.values(store.accounts)) {
    // Uniqueness by lookup tag (bound accounts) or normalized compare
    // (legacy plaintext records) — the address itself is never stored
    // for a new account, so there is nothing plaintext to compare.
    if (a.emailBinding?.emailHmac === emailKey ||
        (typeof a.email === "string" && normalizeEmail(a.email) === emailNorm)) {
      throw new AccountsError(409, "an account with this email already exists");
    }
    if (a.owner === owner) {
      throw new AccountsError(409, `the owner namespace "${owner}" is already claimed by an account`);
    }
  }
  const account = {
    id: newId("acct"),
    name: name.trim(),
    owner,
    passwordHash: hashPassword(password),
    // The signup address goes through the same encrypted binding path
    // as every email on the forge (lib/emailcrypto.mjs): at rest there
    // is only AES-256-GCM ciphertext + an HMAC lookup tag + the masked
    // form. Login matches by HMAC — nothing is decrypted to find it.
    emailBinding: { ...makeEmailBinding(dir, email), boundAt: new Date().toISOString() },
    createdAt: new Date().toISOString(),
  };
  store.accounts[account.id] = account;
  saveStore(dir, store);
  return accountPublic(account);
}

/** Verify credentials; on success mint a session and return its raw token (once). */
export function login(dir, { email, password } = {}) {
  const store = loadStore(dir);
  const emailKey = typeof email === "string" ? emailHmac(dir, email) : null;
  const emailNorm = normalizeEmail(email);
  let account = emailKey
    ? Object.values(store.accounts).find((a) => a.emailBinding?.emailHmac === emailKey)
    : undefined;
  if (!account && emailNorm) {
    // Legacy records (pre-binding era) still carry a plaintext
    // address — they match here, once, and migrate below.
    account = Object.values(store.accounts).find(
      (a) => typeof a.email === "string" && normalizeEmail(a.email) === emailNorm);
  }
  // One error for every failure mode — never reveal which part failed.
  if (!account || typeof password !== "string" || !verifyPassword(password, account.passwordHash)) {
    throw new AccountsError(401, "invalid email or password");
  }
  if (typeof account.email === "string" && !account.emailBinding) {
    // Migrate on the first successful login: the plaintext address
    // becomes an encrypted binding and the plaintext is deleted, in
    // the same store write that mints the session below.
    account.emailBinding = { ...makeEmailBinding(dir, account.email), boundAt: new Date().toISOString() };
    delete account.email;
  }
  const token = `kiln_sess_${randomBytes(24).toString("hex")}`;
  const now = Date.now();
  store.sessions[sha256hex(token)] = {
    accountId: account.id,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
  };
  saveStore(dir, store);
  return { account: accountPublic(account), sessionToken: token, expiresAt: store.sessions[sha256hex(token)].expiresAt };
}

/**
 * Mint an agent identity for an account. The raw token is returned
 * exactly once, here; only its sha256 is stored. Scopes gate ability
 * families at the routes ("workspaces", "project-details").
 */
export function createAgent(dir, accountId, { name, scopes } = {}) {
  if (typeof name !== "string" || !name.trim() || name.length > 120) {
    throw new AccountsError(400, "agent name is required (max 120 chars)");
  }
  let sc = AGENT_SCOPES;
  if (scopes !== undefined) {
    if (!Array.isArray(scopes) || scopes.some((s) => !AGENT_SCOPES.includes(s))) {
      throw new AccountsError(400, `scopes must be a subset of: ${AGENT_SCOPES.join(", ")}`);
    }
    sc = [...new Set(scopes)];
  }
  const store = loadStore(dir);
  const account = store.accounts[accountId];
  if (!account) throw new AccountsError(404, "no such account");
  const token = `kiln_agt_${randomBytes(24).toString("hex")}`;
  const agent = {
    id: newId("agt"),
    accountId,
    name: name.trim(),
    scopes: sc,
    tokenHash: sha256hex(token),
    createdAt: new Date().toISOString(),
    revoked: false,
  };
  store.agents[agent.id] = agent;
  saveStore(dir, store);
  return { agent: agentPublic(agent), token };
}

export function listAgents(dir, accountId) {
  const store = loadStore(dir);
  return Object.values(store.agents)
    .filter((g) => g.accountId === accountId)
    .map(agentPublic);
}

/** Revoke an agent identity. The record stays (audit), the token dies. */
export function revokeAgent(dir, accountId, agentId) {
  const store = loadStore(dir);
  const agent = store.agents[agentId];
  if (!agent || agent.accountId !== accountId) {
    throw new AccountsError(404, "no such agent");
  }
  agent.revoked = true;
  saveStore(dir, store);
  return agentPublic(agent);
}

/**
 * The in-memory account copy a principal carries: for a bound
 * account, the decrypted address rides along as `.email` for
 * INTERNAL consumers (the forge's commit authorship). It is never
 * persisted (this store instance is discarded) and never serialized:
 * accountPublic() masks whenever a binding exists.
 */
function withPlainEmail(dir, account) {
  if (!account || typeof account.email === "string" || !account.emailBinding) return account;
  const plain = decryptEmail(dir, account.emailBinding.emailEnc);
  return plain ? { ...account, email: plain } : account;
}

/**
 * Resolve a bearer token to a principal:
 *   { kind: "session", account } | { kind: "agent", account, agent } | null
 * The operator token is NOT resolved here — httpapi checks it first.
 */
export function resolveAccountToken(dir, bearer) {
  if (typeof bearer !== "string") return null;
  const store = loadStore(dir);
  if (bearer.startsWith("kiln_sess_")) {
    const s = store.sessions[sha256hex(bearer)];
    if (!s) return null;
    if (Date.parse(s.expiresAt) <= Date.now()) return null;
    const account = store.accounts[s.accountId];
    return account ? { kind: "session", account: withPlainEmail(dir, account) } : null;
  }
  if (bearer.startsWith("kiln_agt_")) {
    const hash = sha256hex(bearer);
    const agent = Object.values(store.agents).find((g) => g.tokenHash === hash);
    if (!agent || agent.revoked) return null;
    const account = store.accounts[agent.accountId];
    return account ? { kind: "agent", account: withPlainEmail(dir, account), agent } : null;
  }
  return null;
}

// ------------------------------------------------------- encrypted email binding
//
// The architect's order (2026-10-31): an account can be tied to its
// email "for business users if they want more — but encrypt my email
// and stuff". The binding is the ONLY storage an address gets
// (lib/emailcrypto.mjs): AES-256-GCM ciphertext + HMAC lookup tag +
// masked form, on the account record as `emailBinding`. Signup runs
// through this same path (createAccount above), PUT
// /v1/accounts/me/email rebinds, and workspace invites bind on accept
// (acceptInviteBinding). Matching is always by HMAC — login included
// — so no flow ever decrypts to FIND an account, and no endpoint
// returns the full address once a binding exists (accountPublic
// masks). A legacy plaintext `email` field (pre-binding accounts) is
// deleted the moment a binding lands or a login migrates it.

/** The account's stored email binding ({emailHmac, emailEnc, emailMasked, boundAt}) or null. */
export function getEmailBinding(dir, accountId) {
  const store = loadStore(dir);
  return store.accounts[accountId]?.emailBinding || null;
}

/**
 * Bind (or rebind) an account's email — session act, route-gated.
 * One address ties to exactly ONE account: a different account
 * holding it (bound, or legacy-plaintext) answers 409. Returns
 * { account (public shape), bindingChanged } — the mailer welcomes
 * only on a change, so re-saving the same address stays quiet.
 */
export function bindAccountEmail(dir, accountId, email) {
  if (typeof email !== "string" || !EMAIL_RE.test(email.trim())) {
    throw new AccountsError(400, "email must be a valid email address");
  }
  const store = loadStore(dir);
  const account = store.accounts[accountId];
  if (!account) throw new AccountsError(404, "no such account");
  const key = emailHmac(dir, email);
  for (const a of Object.values(store.accounts)) {
    if (a.id === accountId) continue;
    if (a.emailBinding?.emailHmac === key ||
        (typeof a.email === "string" && emailHmac(dir, a.email) === key)) {
      throw new AccountsError(409, "this email is already tied to another account");
    }
  }
  const bindingChanged = account.emailBinding?.emailHmac !== key;
  account.emailBinding = { ...makeEmailBinding(dir, email), boundAt: new Date().toISOString() };
  delete account.email; // a legacy plaintext address is replaced, never kept alongside
  saveStore(dir, store);
  return { account: accountPublic(account), bindingChanged };
}

/**
 * The invite-accept half of binding (lib/invites.mjs): the invite's
 * encrypted binding is ADOPTED by the accepting account — copied, not
 * decrypted. Rules: an account already bound to a DIFFERENT address
 * is refused (409 — an invite never silently re-ties an account); a
 * legacy plaintext address must hash to the invite's tag or the same
 * 409 answers; no email at all → adopt. Returns { account (raw
 * record), bindingChanged }.
 */
export function acceptInviteBinding(dir, accountId, invite) {
  const store = loadStore(dir);
  const account = store.accounts[accountId];
  if (!account) throw new AccountsError(404, "no such account");
  if (account.emailBinding) {
    if (account.emailBinding.emailHmac !== invite.emailHmac) {
      throw new AccountsError(409, "this invite was issued to a different email than the one tied to your account — sign in with the invited address, or ask for a new invite to your address");
    }
    return { account, bindingChanged: false };
  }
  if (typeof account.email === "string" && emailHmac(dir, account.email) !== invite.emailHmac) {
    throw new AccountsError(409, "this invite was issued to a different email than the one tied to your account — sign in with the invited address, or ask for a new invite to your address");
  }
  account.emailBinding = {
    emailHmac: invite.emailHmac,
    emailEnc: invite.emailEnc,
    emailMasked: invite.emailMasked,
    boundAt: new Date().toISOString(),
  };
  delete account.email;
  saveStore(dir, store);
  return { account, bindingChanged: true };
}

// ------------------------------------------------------- wallet identity binding
//
// The app's generated wallet starts life as a browser-LOCAL key with
// no binding to the daemon account — a second browser would mint a
// NEW wallet and strand the first. This section is the daemon half of
// the fix (the architect's report, 2026-10-31):
//
//   - An account LINKS wallet addresses (kind "local" = the app's
//     generated key, "phantom" = a Phantom wallet) by proving key
//     ownership: the server issues a short-TTL, single-use challenge,
//     the wallet signs it (ed25519), the server verifies before the
//     link exists. An address links to exactly ONE account.
//   - The account stores an ENCRYPTED backup of the local secret:
//     the client encrypts in the browser with a password-derived key
//     and PUTs an opaque blob + KDF metadata. The server never sees
//     plaintext, never logs the blob, and returns it only to the
//     owning account's session — so a fresh browser signs in and
//     restores the SAME wallet instead of generating a new one.
//   - /v1/accounts/me exposes the links + per-wallet hasBackup, the
//     restore surface a new browser renders from.
//
// Address handling: EVM-style 0x addresses normalize to lowercase;
// anything else (Solana base58) keeps its case. When an address
// base58-decodes to exactly 32 bytes it IS an ed25519 public key
// (the Phantom case) and the presented public key must equal it —
// for 0x addresses the pair (address, publicKey) is bound as
// presented, since a 0x address is not derived from an ed25519 key.

export const WALLET_KINDS = ["local", "phantom"];
const WALLET_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const BACKUP_MAX_BLOB_CHARS = 16384;
const BACKUP_MAX_KDF_CHARS = 1024;

/**
 * Normalize a wallet address for storage/uniqueness, or null when the
 * value cannot be an address at all.
 */
export function normalizeWalletAddress(a) {
  if (typeof a !== "string") return null;
  const s = a.trim();
  if (s.length < 8 || s.length > 128 || /[\s/\\]/.test(s)) return null;
  return /^0x/i.test(s) ? s.toLowerCase() : s;
}

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58 decode → Buffer, or null when the string is not base58. */
function base58Decode(s) {
  const bytes = [0];
  for (const ch of s) {
    const v = B58_ALPHABET.indexOf(ch);
    if (v < 0) return null;
    let carry = v;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  const body = Buffer.from(bytes.reverse());
  return zeros ? Buffer.concat([Buffer.alloc(zeros), body]) : body;
}

/** Decode hex / base64 / base64url bytes; null when undecodable. */
function decodeBytes(v) {
  if (typeof v !== "string" || !v) return null;
  const s = v.trim();
  if (/^(0x)?[0-9a-fA-F]+$/.test(s) && s.replace(/^0x/i, "").length % 2 === 0) {
    return Buffer.from(s.replace(/^0x/i, ""), "hex");
  }
  try {
    const b = Buffer.from(s, "base64url");
    return b.length ? b : null;
  } catch {
    return null;
  }
}

function verifyEd25519(message, signature, publicKeyRaw) {
  try {
    const key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: publicKeyRaw.toString("base64url") },
      format: "jwk",
    });
    return cryptoVerify(null, Buffer.from(message, "utf8"), key, signature);
  } catch {
    return false;
  }
}

/** The wallet shape that may leave the daemon (the public key is public). */
export function walletPublic(w, hasBackup = false) {
  return {
    address: w.address, kind: w.kind, publicKey: w.publicKey,
    createdAt: w.createdAt, hasBackup,
  };
}

function pruneChallenges(store, now) {
  for (const [id, c] of Object.entries(store.walletChallenges)) {
    if (Date.parse(c.expiresAt) <= now) delete store.walletChallenges[id];
  }
}

/**
 * Issue a link challenge for (account, address). The returned message
 * is the exact string the wallet must sign. One live challenge per
 * account+address — re-issuing replaces the previous one.
 * `opts.ttlMs` exists for tests; the HTTP route uses the default.
 */
export function issueWalletChallenge(dir, accountId, address, opts = {}) {
  const addr = normalizeWalletAddress(address);
  if (!addr) throw new AccountsError(400, "address must be a wallet address string (8–128 chars, no spaces)");
  const store = loadStore(dir);
  if (!store.accounts[accountId]) throw new AccountsError(404, "no such account");
  const now = Date.now();
  pruneChallenges(store, now);
  for (const [id, c] of Object.entries(store.walletChallenges)) {
    if (c.accountId === accountId && c.address === addr) delete store.walletChallenges[id];
  }
  const account = store.accounts[accountId];
  const id = `wch_${randomBytes(9).toString("hex")}`;
  const nonce = randomBytes(24).toString("hex");
  const expiresAt = new Date(now + (opts.ttlMs || WALLET_CHALLENGE_TTL_MS)).toISOString();
  const message = [
    "kiln-wallet-link",
    `account:${account.owner}`,
    `address:${addr}`,
    `nonce:${nonce}`,
    `expires:${expiresAt}`,
  ].join("\n");
  store.walletChallenges[id] = { id, accountId, address: addr, message, expiresAt, createdAt: new Date(now).toISOString() };
  saveStore(dir, store);
  return { challengeId: id, message, expiresAt };
}

/**
 * Verify a signed challenge and link the wallet. The challenge is
 * consumed by ANY attempt — success, bad signature, or mismatch —
 * so a captured (challenge, signature) pair can never be replayed.
 * Order is deliberate: proof first, conflict last (an address's link
 * state is never revealed to someone who cannot sign for it).
 */
export function linkWallet(dir, accountId, { address, kind, publicKey, challengeId, signature } = {}) {
  const addr = normalizeWalletAddress(address);
  if (!addr) throw new AccountsError(400, "address must be a wallet address string (8–128 chars, no spaces)");
  if (!WALLET_KINDS.includes(kind)) {
    throw new AccountsError(400, `kind must be one of: ${WALLET_KINDS.join(", ")}`);
  }
  const pub = decodeBytes(publicKey);
  if (!pub || pub.length !== 32) {
    throw new AccountsError(400, "publicKey must be a 32-byte ed25519 public key (hex, base64, or base64url)");
  }
  const sig = decodeBytes(signature);
  if (!sig || sig.length !== 64) {
    throw new AccountsError(400, "signature must be a 64-byte ed25519 signature (hex, base64, or base64url)");
  }
  if (typeof challengeId !== "string" || !challengeId) {
    throw new AccountsError(400, "challengeId is required — request one from POST /v1/accounts/me/wallets/challenge first");
  }
  const store = loadStore(dir);
  if (!store.accounts[accountId]) throw new AccountsError(404, "no such account");
  const challenge = store.walletChallenges[challengeId];
  if (!challenge || challenge.accountId !== accountId) {
    throw new AccountsError(404, "challenge not found (never issued, already used, or another account's)");
  }
  // Consume now — every outcome below burns the challenge.
  delete store.walletChallenges[challengeId];
  if (Date.parse(challenge.expiresAt) <= Date.now()) {
    saveStore(dir, store);
    throw new AccountsError(410, "challenge expired — request a fresh one and sign again");
  }
  if (challenge.address !== addr) {
    saveStore(dir, store);
    throw new AccountsError(400, "address does not match the challenged address");
  }
  const decoded = base58Decode(addr);
  if (decoded && decoded.length === 32 && !decoded.equals(pub)) {
    saveStore(dir, store);
    throw new AccountsError(400, "publicKey does not match this address (a base58 address IS its ed25519 public key)");
  }
  if (!verifyEd25519(challenge.message, sig, pub)) {
    saveStore(dir, store);
    throw new AccountsError(403, "signature does not verify against the claimed public key");
  }
  const existing = store.wallets[addr];
  if (existing && existing.accountId !== accountId) {
    saveStore(dir, store);
    throw new AccountsError(409, "this wallet address is already linked to another account");
  }
  const record = existing && existing.accountId === accountId
    ? { ...existing, kind, publicKey: pub.toString("base64url") }
    : {
        address: addr, accountId, kind,
        publicKey: pub.toString("base64url"),
        createdAt: new Date().toISOString(),
      };
  store.wallets[addr] = record;
  saveStore(dir, store);
  return walletPublic(record, !!store.walletBackups[accountId] && record.kind === "local");
}

/** The account's linked wallets, each with its restore flag. */
export function listWallets(dir, accountId) {
  const store = loadStore(dir);
  const hasBackup = !!store.walletBackups[accountId];
  return Object.values(store.wallets)
    .filter((w) => w.accountId === accountId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((w) => walletPublic(w, hasBackup && w.kind === "local"));
}

/** Unlink one of the account's wallets. Another account's link reads as missing. */
export function unlinkWallet(dir, accountId, address) {
  const addr = normalizeWalletAddress(address);
  if (!addr) throw new AccountsError(400, "address must be a wallet address string");
  const store = loadStore(dir);
  const w = store.wallets[addr];
  if (!w || w.accountId !== accountId) {
    throw new AccountsError(404, "no such linked wallet on your account");
  }
  delete store.wallets[addr];
  saveStore(dir, store);
  return walletPublic(w, !!store.walletBackups[accountId] && w.kind === "local");
}

// ------------------------------------------------------- encrypted wallet backup
//
// The blob is OPAQUE: produced by the client encrypting the local
// secret with a password-derived key in the browser. The server
// stores blob + the client's KDF metadata verbatim and returns them
// only to the owning account's session. The blob is never written to
// a log line, an audit record, or any other response.

export function putWalletBackup(dir, accountId, { blob, kdf } = {}) {
  if (typeof blob !== "string" || !blob || blob.length > BACKUP_MAX_BLOB_CHARS) {
    throw new AccountsError(400, `blob must be a non-empty string of at most ${BACKUP_MAX_BLOB_CHARS} characters (the client-encrypted secret)`);
  }
  if (kdf === undefined || kdf === null || typeof kdf !== "object" || Array.isArray(kdf)) {
    throw new AccountsError(400, "kdf metadata is required (a small JSON object: algorithm, salt, parameters — the server stores it opaquely)");
  }
  if (JSON.stringify(kdf).length > BACKUP_MAX_KDF_CHARS) {
    throw new AccountsError(400, `kdf metadata exceeds ${BACKUP_MAX_KDF_CHARS} characters`);
  }
  for (const v of Object.values(kdf)) {
    if (!["string", "number", "boolean"].includes(typeof v)) {
      throw new AccountsError(400, "kdf metadata values must be strings, numbers, or booleans");
    }
  }
  const store = loadStore(dir);
  if (!store.accounts[accountId]) throw new AccountsError(404, "no such account");
  const record = { blob, kdf, updatedAt: new Date().toISOString() };
  store.walletBackups[accountId] = record;
  saveStore(dir, store);
  return { updatedAt: record.updatedAt };
}

/** The account's backup record ({blob, kdf, updatedAt}) or null. */
export function getWalletBackup(dir, accountId) {
  const store = loadStore(dir);
  return store.walletBackups[accountId] || null;
}
