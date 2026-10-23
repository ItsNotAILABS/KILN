/**
 * VIVAX decision core — pure-function tests for the stay-alive protocol's
 * branching, including the 2026-10-17 fence-aware hand-back. No I/O, no
 * live state: decideVivax() must never act outside its two chartered
 * states (down ∧ exhausted, foreign-alive ∧ exhausted).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideVivax, planLatchClear } from "../vivax.mjs";

const base = {
  healthy: true,
  medicusReadable: true,
  liveBootId: "boot-A",
  expectedBootId: "boot-A",
  exhausted: false,
};

describe("vivax decide", () => {
  it("healthy + fence match → healthy", () => {
    assert.equal(decideVivax(base).action, "healthy");
  });

  it("healthy + fence un-stamped (expected null) → healthy, never foreign", () => {
    const d = decideVivax({ ...base, expectedBootId: null, exhausted: true });
    assert.equal(d.action, "healthy");
    assert.equal(d.foreign, false);
  });

  it("healthy + no live bootId readable → healthy", () => {
    assert.equal(decideVivax({ ...base, liveBootId: null }).action, "healthy");
  });

  it("foreign-alive + Medicus has budget → stand down (budget runs first)", () => {
    const d = decideVivax({ ...base, liveBootId: "boot-FOREIGN", exhausted: false });
    assert.equal(d.action, "stand-down");
    assert.equal(d.reason, "foreign-alive-medicus-working");
    assert.equal(d.foreign, true);
  });

  it("foreign-alive + exhausted → act-fence (the 2026-10-16 blind spot)", () => {
    const d = decideVivax({ ...base, liveBootId: "boot-FOREIGN", exhausted: true });
    assert.equal(d.action, "act-fence");
    assert.equal(d.reason, "fence-handback");
  });

  it("down + Medicus recovering → stand down", () => {
    const d = decideVivax({ ...base, healthy: false, exhausted: false });
    assert.equal(d.action, "stand-down");
    assert.equal(d.reason, "medicus-recovering");
  });

  it("down + exhausted → act-down (the original proven state)", () => {
    const d = decideVivax({ ...base, healthy: false, exhausted: true });
    assert.equal(d.action, "act-down");
  });

  it("down + Medicus state unreadable → fail loud, touch nothing", () => {
    const d = decideVivax({ ...base, healthy: false, medicusReadable: false, exhausted: true });
    assert.equal(d.action, "fail");
    assert.equal(d.reason, "medicus-state-unreadable");
  });
});

describe("vivax planLatchClear", () => {
  const st = {
    recoveryExhausted: true,
    recoveryAttempts: 8,
    nextRecoveryRetryTs: 1792270000000,
    recoveryExhaustedTs: "2026-10-17T22:52:56.116Z",
    expectedBootId: "boot-DEAD",
    expectedStartId: "1725:1",
    lastHandledDeathId: "1725|2026-10-17T22:06:26.489Z",
    otherField: "kept",
  };

  it("down mode: clears the latch and nulls the fence (the proven set)", () => {
    const c = planLatchClear(st, "down", null);
    assert.equal(c.recoveryExhausted, false);
    assert.equal(c.recoveryAttempts, 0);
    assert.equal(c.nextRecoveryRetryTs, 0);
    assert.equal("recoveryExhaustedTs" in c, false);
    assert.equal(c.expectedBootId, null);
    assert.equal(c.expectedStartId, null);
  });

  it("fence mode: clears the latch and re-stamps the fence onto the live Daemon", () => {
    const c = planLatchClear(st, "fence", { bootId: "boot-FOREIGN", startId: "1725:9" });
    assert.equal(c.recoveryExhausted, false);
    assert.equal(c.recoveryAttempts, 0);
    assert.equal(c.nextRecoveryRetryTs, 0);
    assert.equal("recoveryExhaustedTs" in c, false);
    assert.equal(c.expectedBootId, "boot-FOREIGN");
    assert.equal(c.expectedStartId, "1725:9");
  });

  it("fence mode: a missing startId stamps null, mirroring stampFence", () => {
    const c = planLatchClear(st, "fence", { bootId: "boot-FOREIGN", startId: undefined });
    assert.equal(c.expectedBootId, "boot-FOREIGN");
    assert.equal(c.expectedStartId, null);
  });

  it("both modes: unrelated fields survive and the input is not mutated", () => {
    const before = JSON.stringify(st);
    for (const mode of ["down", "fence"]) {
      const c = planLatchClear(st, mode, { bootId: "boot-FOREIGN", startId: "1:1" });
      assert.equal(c.lastHandledDeathId, st.lastHandledDeathId);
      assert.equal(c.otherField, "kept");
    }
    assert.equal(JSON.stringify(st), before);
  });
});
