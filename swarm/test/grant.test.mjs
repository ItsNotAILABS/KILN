/** Grant enforcement + delegation, mirroring contracts/KilnOwnershipRegistry.sol. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CAP_COMMIT, CAP_RELEASE, CAP_PROPOSE, CAP_DELEGATE,
  checkGrant, delegateGrant, parseCaps, capsToNames, nowSec, GrantError,
} from "../lib/grant.mjs";

const live = (caps) => ({ capabilities: caps, expiresAt: nowSec() + 3600, parent: null });

describe("checkGrant", () => {
  it("allows a live grant with the required cap", () => {
    checkGrant(live(CAP_COMMIT | CAP_DELEGATE), CAP_COMMIT, "git.commit");
  });
  it("refuses when the cap is missing", () => {
    assert.throws(() => checkGrant(live(CAP_COMMIT), CAP_DELEGATE, "swarm.spawn"),
      (e) => e instanceof GrantError && e.code === "MISSING_CAPABILITY");
  });
  it("refuses an expired grant", () => {
    const g = { capabilities: 15, expiresAt: nowSec() - 1, parent: null };
    assert.throws(() => checkGrant(g, CAP_COMMIT, "x"),
      (e) => e instanceof GrantError && e.code === "GRANT_EXPIRED");
  });
  it("refuses a missing grant", () => {
    assert.throws(() => checkGrant(null, CAP_COMMIT, "x"),
      (e) => e instanceof GrantError && e.code === "NO_GRANT");
  });
  it("requires ALL bits when several are required", () => {
    assert.throws(() => checkGrant(live(CAP_COMMIT), CAP_COMMIT | CAP_DELEGATE, "x"),
      (e) => e.code === "MISSING_CAPABILITY");
    checkGrant(live(CAP_COMMIT | CAP_DELEGATE), CAP_COMMIT | CAP_DELEGATE, "x");
  });
});

describe("delegateGrant (mirrors KilnOwnershipRegistry.delegateGrant)", () => {
  it("delegates a strict subset with capped expiry", () => {
    const parent = live(CAP_COMMIT | CAP_DELEGATE);
    const child = delegateGrant(parent, "parent-id", CAP_COMMIT, nowSec() + 60);
    assert.equal(child.capabilities, CAP_COMMIT);
    assert.equal(child.parent, "parent-id");
    assert.ok(child.expiresAt <= parent.expiresAt);
  });
  it("refuses when parent lacks CAP_DELEGATE", () => {
    assert.throws(() => delegateGrant(live(CAP_COMMIT), "p", CAP_COMMIT, nowSec() + 60),
      (e) => e.code === "MISSING_CAPABILITY");
  });
  it("refuses caps exceeding the parent (subset rule)", () => {
    assert.throws(() => delegateGrant(live(CAP_COMMIT | CAP_DELEGATE), "p", CAP_COMMIT | CAP_PROPOSE, nowSec() + 60),
      (e) => e.code === "EXCEEDS_PARENT_GRANT");
  });
  it("refuses expiry beyond the parent expiry", () => {
    const parent = { capabilities: CAP_DELEGATE, expiresAt: nowSec() + 100, parent: null };
    assert.throws(() => delegateGrant(parent, "p", 0, nowSec() + 3600),
      (e) => e.code === "EXCEEDS_PARENT_GRANT");
  });
  it("refuses when the parent grant is expired", () => {
    const parent = { capabilities: CAP_DELEGATE, expiresAt: nowSec() - 5, parent: null };
    assert.throws(() => delegateGrant(parent, "p", 0, nowSec() + 60),
      (e) => e.code === "GRANT_EXPIRED");
  });
  it("refuses a non-future child expiry", () => {
    assert.throws(() => delegateGrant(live(CAP_DELEGATE), "p", 0, nowSec() - 1),
      (e) => e.code === "GRANT_EXPIRED");
  });
  it("allows delegating zero caps (fully restricted child)", () => {
    const child = delegateGrant(live(CAP_DELEGATE), "p", 0, nowSec() + 60);
    assert.equal(child.capabilities, 0);
  });
});

describe("cap parsing", () => {
  it("parses names and numbers", () => {
    assert.equal(parseCaps("commit"), CAP_COMMIT);
    assert.equal(parseCaps("commit,delegate"), CAP_COMMIT | CAP_DELEGATE);
    assert.equal(parseCaps("15"), 15);
    assert.equal(parseCaps(8), CAP_DELEGATE);
  });
  it("rejects unknown names", () => {
    assert.throws(() => parseCaps("root"), /unknown capability/);
  });
  it("names round-trip", () => {
    assert.deepEqual(capsToNames(CAP_COMMIT | CAP_DELEGATE), ["commit", "delegate"]);
  });
});
