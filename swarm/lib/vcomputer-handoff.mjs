/**
 * Hand-off state machine for KILN virtual computers — pure, no I/O.
 *
 * A hand-off is the agent saying "a human has to do this part" (a sign-in,
 * a device code, 2FA, a captcha). While one is OPEN the agent is locked
 * out of its own machine (screenshot / input / exec answer 423), the owner
 * drives the desktop over noVNC, and the owner hands control back.
 *
 *   pending ──open──▶ active ──return──▶ returned   (terminal)
 *      │                │
 *      ├──────return────┤
 *      ├──cancel────────┴──▶ cancelled             (terminal; agent/operator)
 *      └──expire (now ≥ expiresAt) ──▶ expired      (terminal)
 *
 * The owner's capability is a random token; only its sha256 is stored,
 * compared in constant time. The token is returned exactly once (to the
 * caller that opened the hand-off, to pass to the owner) and never
 * persisted, logged, or echoed by any view. Nothing the owner types is
 * seen here: keystrokes go VNC -> X server, never through this module.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const OPEN_STATES = Object.freeze(["pending", "active"]);
export const TERMINAL_STATES = Object.freeze(["returned", "cancelled", "expired"]);
export const RETURN_OUTCOMES = Object.freeze(["done", "could_not_finish"]);

export const MIN_TIMEOUT_SEC = 60;
export const MAX_TIMEOUT_SEC = 3600;
export const DEFAULT_TIMEOUT_SEC = 900;
const MAX_REASON = 200;
const MAX_INSTRUCTIONS = 2000;

export class HandoffError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

function cleanText(v, max, what) {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw new HandoffError(400, `${what} must be a string`);
  // Strip control chars except newline/tab; the page renders it as text.
  const s = v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  if (s.length > max) throw new HandoffError(400, `${what} is longer than ${max} characters`);
  return s;
}

/**
 * New hand-off. Returns {handoff, token}; `handoff` is the persisted record
 * (tokenHash only), `token` must go to the owner and nowhere else.
 */
export function createHandoff({ reason, instructions, timeoutSec, now = Date.now(), rng = randomBytes } = {}) {
  const r = cleanText(reason, MAX_REASON, "reason");
  if (!r) throw new HandoffError(400, "reason is required — say what the owner needs to do, e.g. \"Sign in to GitHub\"");
  const ins = cleanText(instructions, MAX_INSTRUCTIONS, "instructions");
  let t = timeoutSec === undefined || timeoutSec === null ? DEFAULT_TIMEOUT_SEC : Number(timeoutSec);
  if (!Number.isInteger(t) || t < MIN_TIMEOUT_SEC || t > MAX_TIMEOUT_SEC) {
    throw new HandoffError(400, `timeoutSec must be an integer in ${MIN_TIMEOUT_SEC}..${MAX_TIMEOUT_SEC}`);
  }
  const token = rng(32).toString("base64url");
  const handoff = {
    id: "ho_" + rng(8).toString("hex"),
    state: "pending",
    reason: r,
    instructions: ins,
    createdAt: now,
    expiresAt: now + t * 1000,
    openedAt: null,
    opens: 0,
    endedAt: null,
    outcome: null,
    endedBy: null,
    tokenHash: hashToken(token),
  };
  return { handoff, token };
}

export function isOpen(h) {
  return !!h && OPEN_STATES.includes(h.state);
}

/** Constant-time check of an owner token against the stored hash. */
export function tokenMatches(h, token) {
  if (!h || typeof token !== "string" || !token) return false;
  const a = Buffer.from(hashToken(token), "hex");
  const b = Buffer.from(String(h.tokenHash || ""), "hex");
  return a.length === b.length && b.length > 0 && timingSafeEqual(a, b);
}

/** Expire in place if due. Returns true when this call expired it. */
export function expireIfDue(h, now = Date.now()) {
  if (isOpen(h) && now >= h.expiresAt) {
    h.state = "expired";
    h.endedAt = now;
    h.outcome = "expired";
    h.endedBy = "timeout";
    return true;
  }
  return false;
}

function requireOpen(h, now) {
  if (!h) throw new HandoffError(404, "no hand-off");
  expireIfDue(h, now);
  if (!isOpen(h)) {
    throw new HandoffError(410, `hand-off ${h.id} is ${h.state} — it can't change any more`);
  }
}

/**
 * Apply one event; mutates and returns the record.
 *   {type:"open"}                         owner loaded the page
 *   {type:"return", outcome}              owner hands control back
 *   {type:"cancel", by}                   agent/operator withdraws it
 */
export function applyHandoffEvent(h, event, now = Date.now()) {
  const type = event && event.type;
  switch (type) {
    case "open":
      requireOpen(h, now);
      if (h.state === "pending") { h.state = "active"; h.openedAt = now; }
      h.opens += 1;
      return h;
    case "return": {
      requireOpen(h, now);
      const outcome = event.outcome === undefined ? "done" : event.outcome;
      if (!RETURN_OUTCOMES.includes(outcome)) {
        throw new HandoffError(400, `outcome must be one of ${RETURN_OUTCOMES.join(", ")}`);
      }
      h.state = "returned";
      h.outcome = outcome;
      h.endedAt = now;
      h.endedBy = "owner";
      return h;
    }
    case "cancel":
      requireOpen(h, now);
      h.state = "cancelled";
      h.outcome = "cancelled";
      h.endedAt = now;
      h.endedBy = event.by === "operator" ? "operator" : "agent";
      return h;
    default:
      throw new HandoffError(400, `unknown hand-off event ${JSON.stringify(type)}`);
  }
}

/** What any API caller may see: never the token hash. */
export function publicHandoff(h) {
  if (!h) return null;
  const { tokenHash, ...rest } = h;
  return rest;
}
