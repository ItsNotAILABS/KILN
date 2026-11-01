/**
 * Workspace invites BY EMAIL — the membership door for workspaces.
 *
 * The architect's order (2026-10-31): "create a workspace and be able
 * to add me by email — my account can be tied to my email for business
 * users if they want more. But encrypt my email and stuff."
 *
 * Model:
 *   - A workspace owner (or an admin member) invites an email address
 *     with a role (admin | member). The invite stores the address the
 *     way lib/emailcrypto.mjs stores every address: AES-256-GCM
 *     ciphertext + HMAC lookup tag + masked public form. The plaintext
 *     address never rests in the store, a log, or the audit.
 *   - The invite carries a random single-use token. Only its sha256
 *     is stored; the plaintext token is returned EXACTLY ONCE, in the
 *     create response, for OUT-OF-BAND delivery — the daemon has no
 *     mail sender, and this module does not pretend otherwise: whoever
 *     creates the invite hands the accept link to the invitee.
 *   - Accepting (an account session) binds identity to the invite:
 *     an account with no email takes the invite's address as its
 *     encrypted binding; an account bound to a DIFFERENT address is
 *     refused (409) — an invite can never silently re-tie an account.
 *     On success the account joins the workspace with the invite's
 *     role and the invite is consumed. Expired invites answer 410;
 *     consumed/revoked/unknown tokens answer 404, indistinguishably.
 *
 * Storage: <stateDir>/workspace-invites.json, atomic writes, mode
 * 0600 (it holds ciphertext + token hashes, like accounts.json).
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomicSync } from "./state.mjs";
import { makeEmailBinding, normalizeEmail } from "./emailcrypto.mjs";
import { acceptInviteBinding, accountPublic } from "./accounts.mjs";
import { addWorkspaceMember, resolveWorkspace } from "./workspaces.mjs";

export class InvitesError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "InvitesError";
    this.status = status;
  }
}

const INVITES_FILE = "workspace-invites.json";
export const INVITE_ROLES = ["admin", "member"];
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

/** The invite shape that may leave the daemon. Masked email only. */
export function invitePublic(inv) {
  const view = {
    id: inv.id,
    workspaceId: inv.workspaceId,
    email: inv.emailMasked,
    role: inv.role,
    status: displayStatus(inv),
    createdBy: inv.createdBy,
    createdAt: inv.createdAt,
    expiresAt: inv.expiresAt,
  };
  if (inv.acceptedBy) { view.acceptedBy = inv.acceptedBy; view.acceptedAt = inv.acceptedAt; }
  return view;
}

/**
 * Create an invite for `workspace` (a resolved workspace record).
 * Authorization (owner/admin) is the route's job; this owns the
 * record. `opts.ttlMs` exists for tests; the route uses the 7d default.
 * Returns { invite, token } — the token exists in plaintext ONLY here.
 */
export function createInvite(dir, workspace, { email, role, createdBy } = {}, opts = {}) {
  if (typeof email !== "string" || !EMAIL_RE.test(email.trim())) {
    throw new InvitesError(400, "email must be a valid email address");
  }
  if (!INVITE_ROLES.includes(role)) {
    throw new InvitesError(400, `role must be one of: ${INVITE_ROLES.join(", ")} (the workspace owner is never invited — they already own it)`);
  }
  const binding = makeEmailBinding(dir, email);
  const store = loadStore(dir);
  const now = Date.now();
  for (const inv of Object.values(store.invites)) {
    if (inv.workspaceId === workspace.id && inv.emailHmac === binding.emailHmac &&
        displayStatus(inv, now) === "pending") {
      throw new InvitesError(409, "a pending invite for this email already exists on this workspace — revoke it first, or let it expire");
    }
  }
  const token = `kiln_inv_${randomBytes(24).toString("base64url")}`;
  const record = {
    id: `inv_${randomBytes(6).toString("hex")}`,
    workspaceId: workspace.id,
    emailHmac: binding.emailHmac,
    emailEnc: binding.emailEnc,
    emailMasked: binding.emailMasked,
    role,
    tokenHash: sha256hex(token),
    status: "pending",
    createdBy: createdBy || workspace.owner,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + (opts.ttlMs || INVITE_TTL_MS)).toISOString(),
  };
  store.invites[record.id] = record;
  saveStore(dir, store);
  return { invite: invitePublic(record), token };
}

export function listInvites(dir, workspaceId) {
  return Object.values(loadStore(dir).invites)
    .filter((inv) => inv.workspaceId === workspaceId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(invitePublic);
}

/** Revoke a pending invite. A spent/expired one answers honestly. */
export function revokeInvite(dir, workspaceId, inviteId) {
  const store = loadStore(dir);
  const inv = store.invites[inviteId];
  if (!inv || inv.workspaceId !== workspaceId) {
    throw new InvitesError(404, `no such invite on this workspace: ${inviteId}`);
  }
  const status = displayStatus(inv);
  if (status !== "pending") {
    throw new InvitesError(409, `invite is already ${status} — only a pending invite can be revoked`);
  }
  inv.status = "revoked";
  saveStore(dir, store);
  return invitePublic(inv);
}

/**
 * Accept an invite by its plaintext token, as `account` (the session's
 * account record). Binding rules live in accounts.acceptInviteBinding
 * (no email → adopt the invite's; different bound email → 409). On
 * success the account is a workspace member with the invite's role —
 * unless it OWNS the workspace, in which case the invite simply
 * confirms the binding and no member row is written.
 */
export function acceptInvite(dir, token, account) {
  if (typeof token !== "string" || !token) {
    throw new InvitesError(404, "invite not found (never issued, already used, or revoked)");
  }
  const store = loadStore(dir);
  const hash = sha256hex(token);
  const inv = Object.values(store.invites).find((i) => i.tokenHash === hash);
  // Consumed and revoked invites read exactly like unknown tokens:
  // single-use means single-use, and the answer leaks nothing.
  if (!inv || inv.status !== "pending") {
    throw new InvitesError(404, "invite not found (never issued, already used, or revoked)");
  }
  if (Date.parse(inv.expiresAt) <= Date.now()) {
    throw new InvitesError(410, "this invite has expired — ask the workspace owner or an admin for a fresh one");
  }
  const workspace = resolveWorkspace(dir, inv.workspaceId); // 404 if the workspace is gone
  const { account: updated, bindingChanged } = acceptInviteBinding(dir, account.id, inv); // 409 on a different bound email
  let member = null;
  let workspaceAfter = workspace;
  if (account.owner !== workspace.owner) {
    workspaceAfter = addWorkspaceMember(dir, workspace.id, {
      owner: account.owner, accountId: account.id, role: inv.role, via: "invite",
    });
    member = { owner: account.owner, role: inv.role };
  }
  inv.status = "accepted";
  inv.acceptedBy = account.owner;
  inv.acceptedAt = new Date().toISOString();
  saveStore(dir, store);
  return {
    workspace: workspaceAfter,
    member,
    account: accountPublic(updated),
    invite: invitePublic(inv),
    bindingChanged,
  };
}

/**
 * The invite's stored email binding, for INTERNAL consumers (the
 * mailer enqueues the invite email against it). Null when the invite
 * does not exist. Never routed — responses carry invitePublic only.
 */
export function inviteBinding(dir, inviteId) {
  const inv = loadStore(dir).invites[inviteId];
  if (!inv) return null;
  return { emailHmac: inv.emailHmac, emailEnc: inv.emailEnc, emailMasked: inv.emailMasked };
}
