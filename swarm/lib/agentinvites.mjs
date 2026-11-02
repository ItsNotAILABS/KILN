/**
 * Agent invite links — the bootstrap door for agent accounts.
 *
 * The architect's order (2026-11-01): "I should be sending the links
 * to my agents — any of them, any type of the models — and they
 * should be able to use the app." A sponsor (an account, human or
 * agent) mints an invite link; ANY agent holding the link — whatever
 * model or framework it runs — redeems it UNAUTHENTICATED (the link
 * IS the bootstrap credential) by choosing its own owner handle +
 * display name, and receives a first-class agent account
 * (lib/accounts.mjs createAgentAccount, kind "agent", sponsored by
 * the minter) plus a fresh agent token, shown exactly once.
 *
 * Discipline mirrors workspace invites (lib/invites.mjs) exactly:
 *   - the token is random; only its sha256 rests in the store; the
 *     plaintext exists only in the mint response (and in the link
 *     the sponsor hands out);
 *   - 7-day expiry by default; single-use;
 *   - consumed, revoked, and unknown tokens answer 404,
 *     indistinguishably; an expired pending invite answers 410;
 *   - DELETE by the sponsor revokes a pending invite (a spent or
 *     expired one answers 409, honestly);
 *   - a redemption whose account creation fails validation (owner
 *     taken 409, malformed owner/name 400) does NOT consume the
 *     invite — the redeemer may retry with another owner.
 *
 * The invite record itself is the audit trail — sponsor owner,
 * redemption owner + account id, timestamps — and it never carries
 * a secret: no token, no hash in any response or log line.
 *
 * Storage: <stateDir>/agent-invites.json, atomic writes, mode 0600
 * (it holds token hashes, like accounts.json).
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomicSync } from "./state.mjs";
import { createAgent, createAgentAccount } from "./accounts.mjs";

export class AgentInvitesError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "AgentInvitesError";
    this.status = status;
  }
}

const INVITES_FILE = "agent-invites.json";
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, like workspace invites
const LABEL_MAX = 200;

function invitesPath(dir) {
  return join(dir, INVITES_FILE);
}

function loadStore(dir) {
  const p = invitesPath(dir);
  if (!existsSync(p)) return { invites: {} };
  try {
    const s = JSON.parse(readFileSync(p, "utf8"));
    return { invites: s.invites || {} };
  } catch {
    return { invites: {} };
  }
}

function saveStore(dir, store) {
  writeFileAtomicSync(invitesPath(dir), JSON.stringify(store, null, 2) + "\n");
  try { chmodSync(invitesPath(dir), 0o600); } catch { /* best effort */ }
}

function sha256hex(s) {
  return createHash("sha256").update(s).digest("hex");
}

/** Display status: a pending invite past its expiry reads as expired. */
function displayStatus(inv, now = Date.now()) {
  if (inv.status === "pending" && Date.parse(inv.expiresAt) <= now) return "expired";
  return inv.status;
}

/** The invite shape that may leave the daemon. Never the token or its hash. */
export function agentInvitePublic(inv) {
  const view = {
    id: inv.id,
    sponsorOwner: inv.sponsorOwner,
    label: inv.label ?? null,
    status: displayStatus(inv),
    createdBy: inv.createdBy,
    createdAt: inv.createdAt,
    expiresAt: inv.expiresAt,
  };
  if (inv.redeemedBy) {
    view.redeemedBy = inv.redeemedBy;
    view.redeemedAt = inv.redeemedAt;
    view.redeemedAccountId = inv.redeemedAccountId;
  }
  return view;
}

/**
 * Mint an invite for `sponsor` (a raw account record). Authorization
 * (whose session may mint, and for whom) is the route's job; this
 * owns the record. A sponsor may hold many pending invites — each
 * link onboards one agent. `opts.ttlMs` exists for tests; the route
 * uses the 7-day default. Returns { invite, token } — the token
 * exists in plaintext ONLY here.
 */
export function createAgentInvite(dir, sponsor, { label } = {}, opts = {}) {
  if (!sponsor || !sponsor.id) throw new AgentInvitesError(404, "no such sponsor account");
  let cleanLabel = null;
  if (label !== undefined && label !== null && label !== "") {
    if (typeof label !== "string" || label.length > LABEL_MAX) {
      throw new AgentInvitesError(400, `label must be a string of at most ${LABEL_MAX} characters (a note for the sponsor, e.g. "for my research agent")`);
    }
    cleanLabel = label.trim() || null;
  }
  const store = loadStore(dir);
  const now = Date.now();
  const token = `kiln_ainv_${randomBytes(24).toString("base64url")}`;
  const record = {
    id: `ainv_${randomBytes(6).toString("hex")}`,
    sponsorAccountId: sponsor.id,
    sponsorOwner: sponsor.owner,
    label: cleanLabel,
    tokenHash: sha256hex(token),
    status: "pending",
    createdBy: sponsor.owner,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + (opts.ttlMs || INVITE_TTL_MS)).toISOString(),
  };
  store.invites[record.id] = record;
  saveStore(dir, store);
  return { invite: agentInvitePublic(record), token };
}

/** The sponsor's invites (every status), oldest first, public shapes. */
export function listAgentInvites(dir, sponsorAccountId) {
  return Object.values(loadStore(dir).invites)
    .filter((inv) => inv.sponsorAccountId === sponsorAccountId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(agentInvitePublic);
}

/** Revoke one of the sponsor's pending invites. Another sponsor's reads as missing. */
export function revokeAgentInvite(dir, sponsorAccountId, inviteId) {
  const store = loadStore(dir);
  const inv = store.invites[inviteId];
  if (!inv || inv.sponsorAccountId !== sponsorAccountId) {
    throw new AgentInvitesError(404, `no such agent invite: ${inviteId}`);
  }
  const status = displayStatus(inv);
  if (status !== "pending") {
    throw new AgentInvitesError(409, `invite is already ${status} — only a pending invite can be revoked`);
  }
  inv.status = "revoked";
  saveStore(dir, store);
  return agentInvitePublic(inv);
}

/**
 * Redeem an invite by its plaintext token — UNAUTHENTICATED by
 * design: the link is the bootstrap credential. The redeemer chooses
 * { owner, name, modelLabel? } (the link does not care what model or
 * framework the agent runs; modelLabel is the agent's own free-form
 * description of itself). On success: the sponsored agent account is
 * created, its first agent token is minted (returned exactly once —
 * it is the agent's standing credential), and the invite is
 * consumed. Validation failures from account creation (AccountsError
 * 400/409) propagate and leave the invite pending.
 */
export function redeemAgentInvite(dir, token, { owner, name, modelLabel } = {}) {
  if (typeof token !== "string" || !token) {
    throw new AgentInvitesError(404, "invite not found (never issued, already used, or revoked)");
  }
  const store = loadStore(dir);
  const hash = sha256hex(token);
  const inv = Object.values(store.invites).find((i) => i.tokenHash === hash);
  // Consumed and revoked invites read exactly like unknown tokens:
  // single-use means single-use, and the answer leaks nothing.
  if (!inv || inv.status !== "pending") {
    throw new AgentInvitesError(404, "invite not found (never issued, already used, or revoked)");
  }
  if (Date.parse(inv.expiresAt) <= Date.now()) {
    throw new AgentInvitesError(410, "this invite has expired — ask your sponsor for a fresh link");
  }
  // Hand createAgentAccount the recorded sponsor identity — it
  // re-validates the sponsor against the accounts store itself
  // (accounts cannot be deleted, so a missing sponsor is
  // unreachable in practice and would answer 404 there).
  const sponsor = { id: inv.sponsorAccountId, owner: inv.sponsorOwner };
  const account = createAgentAccount(dir, sponsor, { owner, name, modelLabel });
  // The account's first credential: a delegated-token record owned by
  // the agent account itself, so resolveAccountToken lands on the
  // agent account as its own principal. Minted before the invite is
  // consumed; its inputs were validated by createAgentAccount above.
  const minted = createAgent(dir, account.id, { name: account.name });
  const fresh = loadStore(dir);
  const record = fresh.invites[inv.id];
  record.status = "accepted";
  record.redeemedBy = account.owner;
  record.redeemedAccountId = account.id;
  record.redeemedAt = new Date().toISOString();
  saveStore(dir, fresh);
  return { account, agent: minted.agent, token: minted.token, invite: agentInvitePublic(record) };
}
