/**
 * VIVAX decision core — pure-function tests for the stay-alive protocol's
 * branching, including the 2026-10-17 fence-aware hand-back. No I/O, no
 * live state: decideVivax() must never act outside its two chartered
 * states (down ∧ exhausted, foreign-alive ∧ exhausted).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideVivax } from "../vivax.mjs";

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
