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
import {
  OAUTH_PROVIDERS, buildAuthorizationUrl, exchangeCodeForIdentity,
  makePkce, oauthProviderConfig,
} from "./oauth.mjs";

export class AccountsError extends Error {
  constructor(status, message, opts = {}) {
    super(message);
    this.name = "AccountsError";
    this.status = status;
    // Optional machine-readable reason (e.g. "wallet_not_linked") the
    // app lane switches on; httpapi surfaces it as {reason, code}
    // alongside {error} when present. Absent for every other error.
    if (opts.reason) { this.reason = opts.reason; this.code = opts.reason; }
    // OAuth not-configured errors name the provider so the app can
    // render the honest per-provider state.
    if (opts.provider) this.provider = opts.provider;
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
    return { accounts: {}, sessions: {}, agents: {}, wallets: {}, walletChallenges: {}, walletBackups: {}, walletSignInChallenges: {}, oauthStates: {}, oauthPending: {}, oauthHandoffs: {} };
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
      walletSignInChallenges: s.walletSignInChallenges || {},
      oauthStates: s.oauthStates || {},
      oauthPending: s.oauthPending || {},
      oauthHandoffs: s.oauthHandoffs || {},
    };
  } catch {
    return { accounts: {}, sessions: {}, agents: {}, wallets: {}, walletChallenges: {}, walletBackups: {}, walletSignInChallenges: {}, oauthStates: {}, oauthPending: {}, oauthHandoffs: {} };
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
    // kind: "human" | "agent" (ORGS-DESIGN §4). Legacy records predate
    // the field and are human. An agent account is a FIRST-CLASS
    // account — own namespace, own principal — sponsored by another
    // account; the link below is visibility, never control.
    kind: a.kind || "human",
    email: binding ? binding.emailMasked : (a.email ?? null),
    emailBound: !!binding,
    emailMasked: binding ? binding.emailMasked : (a.email ? maskEmail(a.email) : null),
    name: a.name, owner: a.owner, createdAt: a.createdAt,
    // The sponsor link, readable from the child's own shape (the
    // parent reads the same link from its sponsored list). Null for
    // unsponsored accounts (every human account today).
    sponsor: a.sponsorAccountId
      ? { accountId: a.sponsorAccountId, owner: a.sponsorOwner }
      : null,
    // Free-form label the agent chose at onboarding ("claude",
    // "research-agent", a framework name) — the forge never gates on
    // it; it is display metadata the agent supplied about itself.
    modelLabel: a.modelLabel ?? null,
    // OAuth provider links bound to this account (provider +
    // provider-side subject + when). No tokens ever ride here —
    // a link is an identity pointer, not a credential.
    oauthLinks: (a.oauthLinks || []).map((l) => ({
      provider: l.provider, subject: l.subject, linkedAt: l.linkedAt,
    })),
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
    kind: "human",
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
  const minted = mintSession(store, account);
  saveStore(dir, store);
  return { account: accountPublic(account), sessionToken: minted.sessionToken, expiresAt: minted.expiresAt };
}

/**
 * Mint a normal session for an account INSIDE an already-loaded
 * store (the caller saves). Every login door — password and wallet
 * signature — mints through here, so a session is a session: same
 * kiln_sess_ shape, same 30-day TTL, same sha256-at-rest.
 */
export function mintSession(store, account) {
  const token = `kiln_sess_${randomBytes(24).toString("hex")}`;
  const now = Date.now();
  const expiresAt = new Date(now + SESSION_TTL_MS).toISOString();
  store.sessions[sha256hex(token)] = {
    accountId: account.id,
    createdAt: new Date(now).toISOString(),
    expiresAt,
  };
  return { sessionToken: token, expiresAt };
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

// ------------------------------------------------------- agent accounts
//
// An agent account is a full account with kind "agent" (ORGS-DESIGN
// §4a): its OWN namespace, its OWN repos, its OWN delegated agent
// tokens — not a borrowed login and not one of the delegated token
// records above (store.agents), which keep working exactly as
// before for human accounts. It is created under a SPONSOR (another
// account, human or agent — a sub-agent of an agent is an agent
// account sponsored by the first agent's account): the link is
// asserted at creation by the sponsor's session (or by invite
// redemption, lib/agentinvites.mjs, where the invite itself is the
// sponsor's assertion) and is VISIBILITY, never control — the
// sponsor sees the child on its surfaces; it gains no reads of the
// child's private repos, cannot mint the child's tokens, and cannot
// delete the child's anything.
//
// An agent account has NO email and NO password — deliberately, not
// by omission: there is no deliverable address to invent, and a
// password door would be a secret the sponsor holds over the agent.
// Its doors are (1) agent tokens minted for the account itself —
// the token issued at creation/redemption is its standing
// credential and resolves, through resolveAccountToken, to the
// agent account as its own principal — and (2) wallet sign-in once
// a wallet is linked (verifyWalletSignIn resolves the OWNING
// account; it is kind-agnostic, so an agent account signs in with
// its wallet exactly like a human account). passwordHash rests as
// null: password login against the account answers the generic 401
// (verifyPassword fails clean on a non-scrypt value).

const MODEL_LABEL_MAX = 120;

function validateModelLabel(v) {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || v.length > MODEL_LABEL_MAX) {
    throw new AccountsError(400, `modelLabel must be a string of at most ${MODEL_LABEL_MAX} characters (a free-form label for the agent's model/framework — it gates nothing)`);
  }
  return v.trim() || null;
}

/**
 * Create an agent account under `sponsor` (a raw account record).
 * Owner uniqueness spans ALL accounts (a namespace names one
 * account, human or agent). Namespace-content reservation (an owner
 * that already has repos/workspaces) is the caller's job, exactly
 * like createAccount. Returns the public shape.
 */
export function createAgentAccount(dir, sponsor, { owner, name, modelLabel } = {}) {
  if (!sponsor || !sponsor.id) throw new AccountsError(404, "no such sponsor account");
  if (typeof name !== "string" || !name.trim() || name.length > 120) {
    throw new AccountsError(400, "name is required (max 120 chars)");
  }
  if (typeof owner !== "string" || !OWNER_RE.test(owner)) {
    throw new AccountsError(400, "owner must match [a-z0-9][a-z0-9-]{0,63} — it is the agent account's namespace on the forge");
  }
  const label = validateModelLabel(modelLabel);
  const store = loadStore(dir);
  if (!store.accounts[sponsor.id]) throw new AccountsError(404, "no such sponsor account");
  for (const a of Object.values(store.accounts)) {
    if (a.owner === owner) {
      throw new AccountsError(409, `the owner namespace "${owner}" is already claimed by an account`);
    }
  }
  const account = {
    id: newId("acct"),
    kind: "agent",
    name: name.trim(),
    owner,
    passwordHash: null,
    emailBinding: null,
    sponsorAccountId: sponsor.id,
    sponsorOwner: sponsor.owner,
    modelLabel: label,
    createdAt: new Date().toISOString(),
  };
  store.accounts[account.id] = account;
  saveStore(dir, store);
  return accountPublic(account);
}

/** An account's public shape by id, or null when absent. */
export function accountPublicById(dir, accountId) {
  const a = loadStore(dir).accounts[accountId];
  return a ? accountPublic(a) : null;
}

/** Find an account record by its owner namespace (internal; null when absent). */
export function accountByOwner(dir, owner) {
  const store = loadStore(dir);
  return Object.values(store.accounts).find((a) => a.owner === owner) || null;
}

/** The agent accounts sponsored by `sponsorAccountId`, public shapes, oldest first. */
export function listSponsoredAgentAccounts(dir, sponsorAccountId) {
  const store = loadStore(dir);
  return Object.values(store.accounts)
    .filter((a) => a.kind === "agent" && a.sponsorAccountId === sponsorAccountId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(accountPublic);
}

/** The sponsor's public shape for an account, or null when unsponsored/absent. */
export function sponsorOf(dir, account) {
  if (!account?.sponsorAccountId) return null;
  const store = loadStore(dir);
  const sponsor = store.accounts[account.sponsorAccountId];
  return sponsor ? accountPublic(sponsor) : null;
}

/**
 * Sever an account's sponsor link (the child side, or — from the
 * routes — either side: the sponsor severs by naming the child).
 * Per ORGS-DESIGN: severing keeps the child's account, namespace,
 * and repos — only the visibility link goes. Returns the child's
 * public shape with sponsor now null. 404 when there is no link.
 */
export function severSponsorLink(dir, childAccountId) {
  const store = loadStore(dir);
  const account = store.accounts[childAccountId];
  if (!account) throw new AccountsError(404, "no such account");
  if (!account.sponsorAccountId) {
    throw new AccountsError(404, "this account has no sponsor link to sever");
  }
  delete account.sponsorAccountId;
  delete account.sponsorOwner;
  saveStore(dir, store);
  return accountPublic(account);
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

// ------------------------------------------------------- wallet sign-in
//
// The second login door (the architect's ask, 2026-11-01: "what if I
// used my Phantom wallet to sign in?"): a wallet ALREADY LINKED to an
// account (the section above) can sign its owner in — challenge →
// ed25519 signature → a normal kiln_sess_ session for the OWNING
// account. One account, many doors: password and wallet signature
// resolve to the same account, the same session shape, the same /me.
//
// Semantics mirror linking exactly, because the machinery is the
// same discipline pointed the other way:
//   - challenges are short-TTL (5 min), single-use, and consumed by
//     ANY verify attempt (replay → 404, expired → 410, bad
//     signature → 403, address mismatch → 400);
//   - a base58 address IS its key (a presented publicKey must equal
//     it; omitted, the key is derived from the address); a 0x address
//     presents its key as a pair, or omits it and the LINKED wallet's
//     stored key is used;
//   - proof first, link state last: the signature verifies BEFORE
//     the link is looked up, so link state is never revealed to
//     someone who cannot sign for the address;
//   - the session is minted for the account the wallet is LINKED to.
//     Any account/owner claim in the request is ignored — there is
//     no field for it, and extra fields are never read.
// Sign-in challenges live in their OWN store map: a link challenge
// can never be replayed as a sign-in challenge or vice versa
// (purpose separation by store, reinforced by the message tag).

/** The exact machine-readable reason for an unlinked wallet. */
export const WALLET_NOT_LINKED_REASON = "wallet_not_linked";

function pruneSignInChallenges(store, now) {
  for (const [id, c] of Object.entries(store.walletSignInChallenges)) {
    if (Date.parse(c.expiresAt) <= now) delete store.walletSignInChallenges[id];
  }
}

/**
 * Issue a sign-in challenge for an address (public — no session;
 * this IS a login door). The returned message is the exact string
 * the wallet must sign. It deliberately names NO account: the owner
 * is revealed only after proof, in the session itself. One live
 * challenge per address — re-issuing replaces the previous one.
 * `opts.ttlMs` exists for tests; the HTTP route uses the default.
 */
export function issueWalletSignInChallenge(dir, address, opts = {}) {
  const addr = normalizeWalletAddress(address);
  if (!addr) throw new AccountsError(400, "address must be a wallet address string (8–128 chars, no spaces)");
  const store = loadStore(dir);
  const now = Date.now();
  pruneSignInChallenges(store, now);
  for (const [id, c] of Object.entries(store.walletSignInChallenges)) {
    if (c.address === addr) delete store.walletSignInChallenges[id];
  }
  const id = `wsc_${randomBytes(9).toString("hex")}`;
  const nonce = randomBytes(24).toString("hex");
  const expiresAt = new Date(now + (opts.ttlMs || WALLET_CHALLENGE_TTL_MS)).toISOString();
  const message = [
    "kiln-wallet-signin",
    `address:${addr}`,
    `nonce:${nonce}`,
    `expires:${expiresAt}`,
  ].join("\n");
  store.walletSignInChallenges[id] = { id, address: addr, message, expiresAt, createdAt: new Date(now).toISOString() };
  saveStore(dir, store);
  return { challengeId: id, message, expiresAt };
}

/**
 * Verify a signed sign-in challenge; on success mint a session for
 * the account the wallet is linked to. The challenge is consumed by
 * ANY attempt. Unlinked (after a VALID signature) answers 403 with
 * reason "wallet_not_linked" — the honest, machine-readable refusal
 * the app acts on (link first, from a signed-in session).
 */
export function verifyWalletSignIn(dir, { address, publicKey, challengeId, signature } = {}) {
  const addr = normalizeWalletAddress(address);
  if (!addr) throw new AccountsError(400, "address must be a wallet address string (8–128 chars, no spaces)");
  const sig = decodeBytes(signature);
  if (!sig || sig.length !== 64) {
    throw new AccountsError(400, "signature must be a 64-byte ed25519 signature (hex, base64, or base64url)");
  }
  if (typeof challengeId !== "string" || !challengeId) {
    throw new AccountsError(400, "challengeId is required — request one from POST /v1/accounts/wallet/challenge first");
  }
  // A presented key is validated for shape when present; it is not
  // yet trusted — trust comes from the signature + the link below.
  let presented = null;
  if (publicKey !== undefined && publicKey !== null && publicKey !== "") {
    presented = decodeBytes(publicKey);
    if (!presented || presented.length !== 32) {
      throw new AccountsError(400, "publicKey must be a 32-byte ed25519 public key (hex, base64, or base64url)");
    }
  }
  const store = loadStore(dir);
  const challenge = store.walletSignInChallenges[challengeId];
  if (!challenge) {
    throw new AccountsError(404, "challenge not found (never issued, already used, or not a sign-in challenge)");
  }
  // Consume now — every outcome below burns the challenge.
  delete store.walletSignInChallenges[challengeId];
  if (Date.parse(challenge.expiresAt) <= Date.now()) {
    saveStore(dir, store);
    throw new AccountsError(410, "challenge expired — request a fresh one and sign again");
  }
  if (challenge.address !== addr) {
    saveStore(dir, store);
    throw new AccountsError(400, "address does not match the challenged address");
  }
  // Resolve the key to verify against. The link record is read here
  // ONLY to source a 0x wallet's stored key when none was presented;
  // its existence decides nothing until the signature verifies.
  const linked = store.wallets[addr] || null;
  const decoded = base58Decode(addr);
  let pub;
  if (decoded && decoded.length === 32) {
    // Phantom case: the address IS the key.
    if (presented && !decoded.equals(presented)) {
      saveStore(dir, store);
      throw new AccountsError(400, "publicKey does not match this address (a base58 address IS its ed25519 public key)");
    }
    pub = decoded;
  } else if (presented) {
    pub = presented;
  } else if (linked) {
    pub = Buffer.from(linked.publicKey, "base64url");
  } else {
    saveStore(dir, store);
    throw new AccountsError(400, "publicKey is required for a 0x address (the address is not its ed25519 key) — or link the wallet first and retry");
  }
  if (!verifyEd25519(challenge.message, sig, pub)) {
    saveStore(dir, store);
    throw new AccountsError(403, "signature does not verify against the claimed public key");
  }
  // Proof is complete — only NOW does link state decide the outcome.
  if (!linked) {
    saveStore(dir, store);
    throw new AccountsError(403,
      "wallet_not_linked: this wallet address is not linked to any account — link it from a signed-in session first, then sign in with it",
      { reason: WALLET_NOT_LINKED_REASON });
  }
  if (linked.publicKey !== pub.toString("base64url")) {
    // Signed with a valid key, but not the key this address is
    // linked with — the same honest refusal, same reason: as far as
    // sign-in is concerned this key's wallet is not linked.
    saveStore(dir, store);
    throw new AccountsError(403,
      "wallet_not_linked: this wallet address is linked to a different key — sign with the linked wallet's key",
      { reason: WALLET_NOT_LINKED_REASON });
  }
  const account = store.accounts[linked.accountId];
  if (!account) {
    saveStore(dir, store);
    throw new AccountsError(403,
      "wallet_not_linked: this wallet address is not linked to any account — link it from a signed-in session first, then sign in with it",
      { reason: WALLET_NOT_LINKED_REASON });
  }
  const minted = mintSession(store, account);
  saveStore(dir, store);
  return {
    account: accountPublic(account),
    sessionToken: minted.sessionToken,
    expiresAt: minted.expiresAt,
    wallet: walletPublic(linked, !!store.walletBackups[account.id] && linked.kind === "local"),
  };
}

// ------------------------------------------------------- OAuth sign-in
//
// The third and fourth login doors (architect's re-scope,
// 2026-11-02: real OAuth, not covered buttons): Google and X sign a
// person into the SAME one account model — never a parallel
// "social account". Provider mechanics (endpoints, PKCE, code
// exchange, identity fetch) live in lib/oauth.mjs; this section owns
// the state machines and identity resolution:
//
//   start    → a random state, stored HASHED (sha256) with a 10-min
//              TTL, single-use, bound to the caller's app-relative
//              return path and to a PKCE verifier.
//   callback → the state is consumed by ANY attempt (unknown or
//              replayed → 400, expired → 410); the code is exchanged
//              server-side and identity resolves IN ORDER:
//              (1) a stored provider link (provider + subject) →
//                  that account;
//              (2) GOOGLE ONLY, and only when the provider asserts
//                  email_verified=true: the HMAC email tag matches
//                  an account → that account, and the provider link
//                  is recorded on it. An UNVERIFIED email never
//                  merges accounts — it falls through to (3);
//              (3) no match → a short-lived oauthPending record
//                  (hashed token, 15-min TTL) and the app collects a
//                  handle at POST /v1/accounts/oauth/complete.
//   matched  → the session is NEVER put in a URL: the callback
//              mints a one-time handoff code (hashed, single-use,
//              2-min TTL) and the app redeems it at
//              POST /v1/accounts/oauth/handoff for the same
//              {ok, account, sessionToken, expiresAt} shape every
//              other door returns. Handoffs are consumed by ANY
//              redemption attempt (unknown → 404, expired → 410).
//
// Emails from a provider are handled exactly like every other email
// on the forge: matching is by HMAC tag (lib/emailcrypto.mjs) and a
// pending record holds the address ONLY as an encrypted binding —
// never plaintext.
// Not configured (client id/secret absent from the daemon env) is
// an honest machine-readable 503 {error:"provider_not_configured",
// provider} — never a fake sign-in failure.

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
export const OAUTH_PENDING_TTL_MS = 15 * 60 * 1000;
export const OAUTH_HANDOFF_TTL_MS = 2 * 60 * 1000;
export const PROVIDER_NOT_CONFIGURED = "provider_not_configured";

/** App-relative return paths only — an absolute URL here would be an open redirect. */
export function validateOAuthReturnPath(p) {
  if (p === undefined || p === null || p === "") return "/login";
  if (typeof p !== "string" || p.length > 512 || !p.startsWith("/") ||
      p.startsWith("//") || p.includes("\\") || /[\s]/.test(p)) {
    throw new AccountsError(400, "return must be an app-relative path (e.g. /login or /repos)");
  }
  return p;
}

function resolveOAuthConfig(provider, opts = {}) {
  if (!OAUTH_PROVIDERS[provider]) {
    throw new AccountsError(404, `unknown OAuth provider "${provider}" — supported: ${Object.keys(OAUTH_PROVIDERS).join(", ")}`);
  }
  const config = oauthProviderConfig(provider, opts.env || process.env, opts.config || {});
  if (!config.configured) {
    throw new AccountsError(503,
      `${PROVIDER_NOT_CONFIGURED}: OAuth provider "${provider}" has no client credentials configured on the daemon`,
      { reason: PROVIDER_NOT_CONFIGURED, provider });
  }
  return config;
}

/** The provider config WITHOUT the configured gate (null for unknown providers). */
export function oauthConfigFor(provider, opts = {}) {
  if (!OAUTH_PROVIDERS[provider]) return null;
  return oauthProviderConfig(provider, opts.env || process.env, opts.config || {});
}

function pruneOAuth(store, now) {
  for (const [k, v] of Object.entries(store.oauthStates)) {
    if (Date.parse(v.expiresAt) <= now) delete store.oauthStates[k];
  }
  for (const [k, v] of Object.entries(store.oauthPending)) {
    if (Date.parse(v.expiresAt) <= now) delete store.oauthPending[k];
  }
  for (const [k, v] of Object.entries(store.oauthHandoffs)) {
    if (Date.parse(v.expiresAt) <= now) delete store.oauthHandoffs[k];
  }
}

function findAccountByEmailTag(store, dir, email) {
  const key = emailHmac(dir, email);
  if (!key) return null;
  const norm = normalizeEmail(email);
  return Object.values(store.accounts).find((a) =>
    a.emailBinding?.emailHmac === key ||
    (typeof a.email === "string" && normalizeEmail(a.email) === norm)) || null;
}

function findAccountByOAuthLink(store, provider, subject) {
  return Object.values(store.accounts).find((a) =>
    (a.oauthLinks || []).some((l) => l.provider === provider && l.subject === subject)) || null;
}

function recordOAuthLink(account, provider, subject) {
  account.oauthLinks = account.oauthLinks || [];
  if (!account.oauthLinks.some((l) => l.provider === provider && l.subject === subject)) {
    account.oauthLinks.push({ provider, subject, linkedAt: new Date().toISOString() });
  }
}

function mintHandoff(store, accountId, ttlMs = OAUTH_HANDOFF_TTL_MS) {
  const code = `kiln_oauth_${randomBytes(24).toString("hex")}`;
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  store.oauthHandoffs[sha256hex(code)] = { accountId, expiresAt, createdAt: new Date().toISOString() };
  return code;
}

/**
 * Begin a sign-in: store the hashed state and return the provider
 * authorization URL to 302 to. Throws 503 provider_not_configured
 * when the provider has no credentials on the daemon, 404 for an
 * unknown provider, 400 for a non-relative return path.
 * `opts.stateTtlMs` exists for tests; the route uses the default.
 */
export function startOAuth(dir, provider, { returnPath } = {}, opts = {}) {
  const config = resolveOAuthConfig(provider, opts);
  const ret = validateOAuthReturnPath(returnPath);
  const store = loadStore(dir);
  const now = Date.now();
  pruneOAuth(store, now);
  const state = randomBytes(32).toString("base64url");
  const pkce = makePkce();
  const expiresAt = new Date(now + (opts.stateTtlMs || OAUTH_STATE_TTL_MS)).toISOString();
  store.oauthStates[sha256hex(state)] = {
    provider, returnPath: ret, codeVerifier: pkce.verifier,
    expiresAt, createdAt: new Date(now).toISOString(),
  };
  saveStore(dir, store);
  return {
    authorizationUrl: buildAuthorizationUrl(config, { state, codeChallenge: pkce.challenge }),
    expiresAt,
  };
}

/**
 * The callback half. Consumes the state, exchanges the code, and
 * resolves the identity. Returns one of:
 *   { kind: "handoff", account, handoffCode, returnPath }
 *   { kind: "pending", pendingToken, returnPath, provider }
 * The caller (httpapi) turns these into 302s with the code/token in
 * the URL FRAGMENT — a session token never appears here at all.
 */
export async function handleOAuthCallback(dir, provider, { code, state } = {}, opts = {}) {
  const config = resolveOAuthConfig(provider, opts);
  if (typeof code !== "string" || !code || typeof state !== "string" || !state) {
    throw new AccountsError(400, "callback requires both code and state");
  }
  const store = loadStore(dir);
  const key = sha256hex(state);
  const record = store.oauthStates[key];
  if (!record || record.provider !== provider) {
    throw new AccountsError(400, "OAuth state not recognized (never issued, already used, or for a different provider)");
  }
  // Consume now — every outcome below burns the state.
  delete store.oauthStates[key];
  if (Date.parse(record.expiresAt) <= Date.now()) {
    saveStore(dir, store);
    throw new AccountsError(410, "OAuth state expired — start the sign-in again");
  }
  let identity;
  try {
    identity = await exchangeCodeForIdentity(
      config, { code, codeVerifier: record.codeVerifier }, opts.fetchImpl || fetch);
  } catch (e) {
    saveStore(dir, store);
    throw new AccountsError(502, `OAuth sign-in failed at the provider: ${e.message}`);
  }

  // (1) A stored provider link resolves first — it is the strongest
  //     claim: this provider subject already belongs to an account.
  let account = findAccountByOAuthLink(store, provider, identity.subject);
  // (2) Google ONLY, verified email ONLY: HMAC match, then link.
  if (!account && provider === "google" && identity.email && identity.emailVerified) {
    account = findAccountByEmailTag(store, dir, identity.email);
    if (account) recordOAuthLink(account, provider, identity.subject);
  }
  if (account) {
    const handoffCode = mintHandoff(store, account.id, opts.handoffTtlMs || OAUTH_HANDOFF_TTL_MS);
    saveStore(dir, store);
    return { kind: "handoff", account: accountPublic(account), handoffCode, returnPath: record.returnPath };
  }

  // (3) No match → pending. The provider's email (Google) rests ONLY
  //     as an encrypted binding; an unverified address is recorded
  //     as a binding candidate but is NEVER bound at completion —
  //     only a verified one becomes the new account's email binding.
  const pendingToken = `kiln_oauthp_${randomBytes(24).toString("hex")}`;
  const expiresAt = new Date(Date.now() + (opts.pendingTtlMs || OAUTH_PENDING_TTL_MS)).toISOString();
  store.oauthPending[sha256hex(pendingToken)] = {
    provider, subject: identity.subject,
    username: identity.username || null,
    providerName: identity.name || null,
    emailBinding: identity.email ? makeEmailBinding(dir, identity.email) : null,
    emailVerified: !!identity.emailVerified,
    expiresAt, createdAt: new Date().toISOString(),
  };
  saveStore(dir, store);
  return { kind: "pending", pendingToken, returnPath: record.returnPath, provider };
}

/**
 * Redeem a handoff code for a session. Consumed by ANY attempt:
 * unknown (or replayed) → 404, expired → 410. Success returns the
 * exact shape wallet verify returns: {account, sessionToken,
 * expiresAt} (httpapi adds {ok}).
 */
export function redeemOAuthHandoff(dir, { code } = {}) {
  if (typeof code !== "string" || !code) {
    throw new AccountsError(400, "code is required");
  }
  const store = loadStore(dir);
  const key = sha256hex(code);
  const record = store.oauthHandoffs[key];
  if (!record) throw new AccountsError(404, "handoff code not found (never issued or already used)");
  delete store.oauthHandoffs[key]; // consumed by any attempt
  if (Date.parse(record.expiresAt) <= Date.now()) {
    saveStore(dir, store);
    throw new AccountsError(410, "handoff code expired — sign in again");
  }
  const account = store.accounts[record.accountId];
  if (!account) {
    saveStore(dir, store);
    throw new AccountsError(404, "handoff code not found (never issued or already used)");
  }
  const minted = mintSession(store, account);
  saveStore(dir, store);
  return { account: accountPublic(account), sessionToken: minted.sessionToken, expiresAt: minted.expiresAt };
}

/**
 * Complete a pending OAuth sign-up: pick the handle, create the ONE
 * account, record the provider link, mint a session. Validation
 * mirrors password signup (name required ≤120, owner the namespace
 * regex) minus password/email — the provider identity IS the
 * credential. The pending record is consumed by any attempt EXCEPT
 * an owner-already-claimed 409, which leaves it alive so the person
 * can retry with a different handle (spec'd behavior).
 */
export function completeOAuth(dir, { pendingToken, owner, name } = {}) {
  if (typeof pendingToken !== "string" || !pendingToken) {
    throw new AccountsError(400, "pendingToken is required");
  }
  const store = loadStore(dir);
  const key = sha256hex(pendingToken);
  const pending = store.oauthPending[key];
  if (!pending) {
    throw new AccountsError(404, "pending OAuth sign-up not found (never issued or already used)");
  }
  if (Date.parse(pending.expiresAt) <= Date.now()) {
    delete store.oauthPending[key];
    saveStore(dir, store);
    throw new AccountsError(410, "pending OAuth sign-up expired — sign in again");
  }
  // Owner-claimed is checked BEFORE consumption: a 409 here keeps
  // the pending record alive for a retry (spec'd exception).
  if (typeof owner === "string" &&
      Object.values(store.accounts).some((a) => a.owner === owner)) {
    throw new AccountsError(409, `the owner namespace "${owner}" is already claimed by an account`);
  }
  // Every other attempt consumes the pending record.
  delete store.oauthPending[key];
  if (typeof name !== "string" || !name.trim() || name.length > 120) {
    saveStore(dir, store);
    throw new AccountsError(400, "name is required (max 120 chars)");
  }
  if (typeof owner !== "string" || !OWNER_RE.test(owner)) {
    saveStore(dir, store);
    throw new AccountsError(400, "owner must match [a-z0-9][a-z0-9-]{0,63} — it is your namespace on the forge");
  }
  // A VERIFIED Google email becomes the account's encrypted binding
  // — unless another account claimed that address in the meantime,
  // in which case the account is still created (the provider link
  // resolves its sign-ins) but the address is not double-bound.
  let emailBinding = null;
  if (pending.provider === "google" && pending.emailVerified && pending.emailBinding) {
    const taken = Object.values(store.accounts).some((a) =>
      a.emailBinding?.emailHmac === pending.emailBinding.emailHmac ||
      (typeof a.email === "string" && emailHmac(dir, a.email) === pending.emailBinding.emailHmac));
    if (!taken) {
      emailBinding = { ...pending.emailBinding, boundAt: new Date().toISOString() };
    }
  }
  const account = {
    id: newId("acct"),
    kind: "human",
    name: name.trim(),
    owner,
    passwordHash: null,
    emailBinding,
    oauthLinks: [{
      provider: pending.provider, subject: pending.subject,
      linkedAt: new Date().toISOString(),
    }],
    createdAt: new Date().toISOString(),
  };
  store.accounts[account.id] = account;
  const minted = mintSession(store, account);
  saveStore(dir, store);
  return { account: accountPublic(account), sessionToken: minted.sessionToken, expiresAt: minted.expiresAt };
}
