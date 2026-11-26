/**
 * Hand-off state machine (pure): transitions, expiry, token handling,
 * and the views that must never carry the token or its hash.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createHandoff, applyHandoffEvent, expireIfDue, isOpen, tokenMatches, publicHandoff,
  hashToken, HandoffError, MIN_TIMEOUT_SEC, MAX_TIMEOUT_SEC, DEFAULT_TIMEOUT_SEC,
} from "../lib/vcomputer-handoff.mjs";

const T0 = 1_800_000_000_000;
const mk = (o = {}) => createHandoff({ reason: "Sign in to GitHub", now: T0, ...o });
const status = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof HandoffError, e.message); return e.status; } return 0; };

test("create: pending, token returned once, only its hash stored", () => {
  const { handoff: h, token } = mk({ instructions: "Enter the device code" });
  assert.equal(h.state, "pending");
  assert.ok(isOpen(h));
  assert.match(h.id, /^ho_[0-9a-f]{16}$/);
  assert.ok(token.length >= 40);
  assert.equal(h.tokenHash, hashToken(token));
  assert.ok(!JSON.stringify(h).includes(token), "record never holds the raw token");
  assert.equal(h.expiresAt, T0 + DEFAULT_TIMEOUT_SEC * 1000);
  const pub = publicHandoff(h);
  assert.equal(pub.tokenHash, undefined, "views drop the hash");
  assert.ok(!JSON.stringify(pub).includes(h.tokenHash));
});

test("create: validates reason, instructions, timeout", () => {
  assert.equal(status(() => createHandoff({ now: T0 })), 400, "reason required");
  assert.equal(status(() => mk({ reason: "   " })), 400);
  assert.equal(status(() => mk({ reason: 42 })), 400);
  assert.equal(status(() => mk({ reason: "x".repeat(201) })), 400);
  assert.equal(status(() => mk({ instructions: "x".repeat(2001) })), 400);
  assert.equal(status(() => mk({ timeoutSec: MIN_TIMEOUT_SEC - 1 })), 400);
  assert.equal(status(() => mk({ timeoutSec: MAX_TIMEOUT_SEC + 1 })), 400);
  assert.equal(status(() => mk({ timeoutSec: 90.5 })), 400);
  assert.equal(mk({ timeoutSec: 120 }).handoff.expiresAt, T0 + 120_000);
  // control characters are stripped from what the page will render
  assert.equal(mk({ reason: "Sign\u0007 in\u0000" }).handoff.reason, "Sign in");
});

test("tokens: constant-time match, wrong/empty/malformed tokens rejected", () => {
  const { handoff: h, token } = mk();
  assert.equal(tokenMatches(h, token), true);
  assert.equal(tokenMatches(h, token + "x"), false);
  assert.equal(tokenMatches(h, ""), false);
  assert.equal(tokenMatches(h, undefined), false);
  assert.equal(tokenMatches({ ...h, tokenHash: "" }, token), false);
  assert.equal(tokenMatches(null, token), false);
  const other = mk();
  assert.notEqual(other.token, token, "tokens are random per hand-off");
});

test("open: pending -> active, repeat opens counted", () => {
  const { handoff: h } = mk();
  applyHandoffEvent(h, { type: "open" }, T0 + 1000);
  assert.equal(h.state, "active");
  assert.equal(h.openedAt, T0 + 1000);
  applyHandoffEvent(h, { type: "open" }, T0 + 2000);
  assert.equal(h.state, "active");
  assert.equal(h.openedAt, T0 + 1000, "first open time kept");
  assert.equal(h.opens, 2);
});

test("return: from pending or active, outcome validated, terminal", () => {
  const a = mk().handoff;
  applyHandoffEvent(a, { type: "return" }, T0 + 5);
  assert.deepEqual([a.state, a.outcome, a.endedBy], ["returned", "done", "owner"]);
  assert.ok(!isOpen(a));

  const b = mk().handoff;
  applyHandoffEvent(b, { type: "open" }, T0 + 1);
  applyHandoffEvent(b, { type: "return", outcome: "could_not_finish" }, T0 + 2);
  assert.equal(b.outcome, "could_not_finish");

  const c = mk().handoff;
  assert.equal(status(() => applyHandoffEvent(c, { type: "return", outcome: "password=hunter2" }, T0)), 400);
  assert.equal(c.state, "pending", "a rejected event changes nothing");

  // terminal: nothing moves it again
  assert.equal(status(() => applyHandoffEvent(a, { type: "return" }, T0 + 10)), 410);
  assert.equal(status(() => applyHandoffEvent(a, { type: "open" }, T0 + 10)), 410);
  assert.equal(status(() => applyHandoffEvent(a, { type: "cancel" }, T0 + 10)), 410);
});

test("cancel: by agent or operator", () => {
  const a = mk().handoff;
  applyHandoffEvent(a, { type: "cancel" }, T0 + 1);
  assert.deepEqual([a.state, a.endedBy], ["cancelled", "agent"]);
  const b = mk().handoff;
  applyHandoffEvent(b, { type: "cancel", by: "operator" }, T0 + 1);
  assert.equal(b.endedBy, "operator");
});

test("expiry: due hand-offs expire, and events after expiry are refused", () => {
  const h = mk({ timeoutSec: 60 }).handoff;
  assert.equal(expireIfDue(h, T0 + 59_999), false);
  assert.ok(isOpen(h));
  assert.equal(expireIfDue(h, T0 + 60_000), true);
  assert.deepEqual([h.state, h.outcome, h.endedBy], ["expired", "expired", "timeout"]);
  assert.equal(expireIfDue(h, T0 + 70_000), false, "expires once");

  const late = mk({ timeoutSec: 60 }).handoff;
  assert.equal(status(() => applyHandoffEvent(late, { type: "return" }, T0 + 61_000)), 410);
  assert.equal(late.state, "expired", "a late return finds it expired, not returned");
});

test("unknown events and missing hand-offs", () => {
  const h = mk().handoff;
  assert.equal(status(() => applyHandoffEvent(h, { type: "steal" }, T0)), 400);
  assert.equal(status(() => applyHandoffEvent(null, { type: "open" }, T0)), 404);
  assert.equal(publicHandoff(null), null);
});
