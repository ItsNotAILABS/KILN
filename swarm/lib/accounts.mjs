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
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomicSync } from "./state.mjs";

export class AccountsError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "AccountsError";
    this.status = status;
  }
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const AGENT_SCOPES = ["workspaces", "project-details"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OWNER_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function accountsPath(dir) {
  return join(dir, "accounts.json");
}

function loadStore(dir) {
  const p = accountsPath(dir);
  if (!existsSync(p)) return { accounts: {}, sessions: {}, agents: {} };
  try {
    const s = JSON.parse(readFileSync(p, "utf8"));
    return {
      accounts: s.accounts || {},
      sessions: s.sessions || {},
      agents: s.agents || {},
    };
  } catch {
    return { accounts: {}, sessions: {}, agents: {} };
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

/** The account shape that may leave the daemon. Never the hash. */
export function accountPublic(a) {
  return {
    id: a.id, email: a.email, name: a.name, owner: a.owner, createdAt: a.createdAt,
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
  const emailLc = email.toLowerCase();
  for (const a of Object.values(store.accounts)) {
    if (a.email.toLowerCase() === emailLc) {
      throw new AccountsError(409, "an account with this email already exists");
    }
    if (a.owner === owner) {
      throw new AccountsError(409, `the owner namespace "${owner}" is already claimed by an account`);
    }
  }
  const account = {
    id: newId("acct"),
    email,
    name: name.trim(),
    owner,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString(),
  };
  store.accounts[account.id] = account;
  saveStore(dir, store);
  return accountPublic(account);
}

/** Verify credentials; on success mint a session and return its raw token (once). */
export function login(dir, { email, password } = {}) {
  const store = loadStore(dir);
  const emailLc = typeof email === "string" ? email.toLowerCase() : "";
  const account = Object.values(store.accounts).find((a) => a.email.toLowerCase() === emailLc);
  // One error for every failure mode — never reveal which part failed.
  if (!account || typeof password !== "string" || !verifyPassword(password, account.passwordHash)) {
    throw new AccountsError(401, "invalid email or password");
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
    return account ? { kind: "session", account } : null;
  }
  if (bearer.startsWith("kiln_agt_")) {
    const hash = sha256hex(bearer);
    const agent = Object.values(store.agents).find((g) => g.tokenHash === hash);
    if (!agent || agent.revoked) return null;
    const account = store.accounts[agent.accountId];
    return account ? { kind: "agent", account, agent } : null;
  }
  return null;
}
