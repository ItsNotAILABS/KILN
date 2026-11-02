/**
 * KILN Memory phase 4 — consolidation proposals (2026-10-17).
 *
 * A consolidation pass proposes; it never writes silently. Pins:
 *  - proposals are events, validated like direct writes (provenance!)
 *  - pending proposals are invisible to recall and to factsAt
 *  - ratify materializes the real fact/link/core (marked viaProposal)
 *  - reject materializes nothing; double-resolution is refused
 *  - the whole lifecycle verifies in the hash chain + shows in stats
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  remember, assertFact, proposeMemory, resolveProposal,
  loadMemory, factsAt, recall, memoryStats, verifyMemory,
} from "../lib/memory.mjs";
import { createRepo } from "../lib/git.mjs";
import { makeStateDir } from "./helpers.mjs";

const R = ["auro", "memtest"];

function seeded() {
  const dir = makeStateDir();
  createRepo(dir, ...R);
  const a = remember(dir, ...R, {
    title: "Database choice", kind: "decision",
    content: "The billing service stores invoices in Postgres with row level security.",
    tags: ["billing"], actor: "test",
  }).event;
  const b = remember(dir, ...R, {
    title: "Lunch", content: "Tacos near the office again.", actor: "test",
  }).event;
  return { dir, a, b };
}

const FACT = (a) => ({
  subject: "billing service", predicate: "stores invoices in", object: "Postgres",
  sourceEpisodes: [a.id],
});

describe("memory proposals: propose → ratify/reject", () => {
  it("a pending proposal is invisible: no fact, no recall hit, stats show it parked", () => {
    const { dir, a } = seeded();
    const p = proposeMemory(dir, ...R, { kind: "fact", payload: FACT(a), rationale: "stated verbatim in the episode", actor: "consolidator" }).event;
    assert.equal(p.type, "proposal");
    const st = loadMemory(dir, ...R);
    assert.equal(st.facts.length, 0, "no fact materialized yet");
    assert.equal(st.proposals.length, 1);
    assert.equal(st.proposals[0].status, "pending");
    const r = recall(dir, ...R, "Postgres billing invoices");
    assert.equal(r.results.filter((x) => x.kind === "fact").length, 0, "proposal not recallable");
    assert.equal(memoryStats(dir, ...R).proposals.pending, 1);
  });

  it("ratify materializes the fact (viaProposal) and the fact recalls", () => {
    const { dir, a } = seeded();
    const p = proposeMemory(dir, ...R, { kind: "fact", payload: FACT(a), actor: "consolidator" }).event;
    const out = resolveProposal(dir, ...R, { proposal: p.id, decision: "ratified", actor: "architect" });
    assert.equal(out.materialized.type, "fact");
    assert.equal(out.materialized.viaProposal, p.id);
    const st = loadMemory(dir, ...R);
    assert.equal(st.facts.length, 1);
    assert.equal(st.proposals[0].status, "ratified");
    assert.equal(st.proposals[0].decidedBy, "architect");
    assert.equal(st.proposals[0].materializedId, out.materialized.id);
    assert.equal(factsAt(st).length, 1);
    const r = recall(dir, ...R, "Postgres billing invoices");
    assert.equal(r.results[0].kind, "fact");
    // Double-resolution is refused, loudly.
    assert.throws(() => resolveProposal(dir, ...R, { proposal: p.id, decision: "ratified" }), /already ratified/);
    assert.ok(verifyMemory(dir, ...R).ok, "chain still verifies");
  });

  it("reject materializes nothing and is terminal", () => {
    const { dir, a } = seeded();
    const p = proposeMemory(dir, ...R, { kind: "fact", payload: FACT(a), actor: "consolidator" }).event;
    const out = resolveProposal(dir, ...R, { proposal: p.id, decision: "rejected", reason: "too trivial", actor: "architect" });
    assert.equal(out.materialized, null);
    const st = loadMemory(dir, ...R);
    assert.equal(st.facts.length, 0);
    assert.equal(st.proposals[0].status, "rejected");
    assert.equal(st.proposals[0].decisionReason, "too trivial");
    assert.throws(() => resolveProposal(dir, ...R, { proposal: p.id, decision: "ratified" }), /already rejected/);
  });

  it("link and core proposals ratify through the same door", () => {
    const { dir, a, b } = seeded();
    const lp = proposeMemory(dir, ...R, { kind: "link", payload: { from: a.id, to: b.id, relation: "contrasts" }, actor: "consolidator" }).event;
    const cp = proposeMemory(dir, ...R, { kind: "core", payload: { label: "project", value: "billing on Postgres" }, actor: "consolidator" }).event;
    assert.equal(loadMemory(dir, ...R).links.length, 0);
    resolveProposal(dir, ...R, { proposal: lp.id, decision: "ratified" });
    resolveProposal(dir, ...R, { proposal: cp.id, decision: "ratified" });
    const st = loadMemory(dir, ...R);
    assert.equal(st.links.length, 1);
    assert.equal(st.links[0].viaProposal, lp.id);
    assert.equal(st.core.find((c) => c.label === "project").value, "billing on Postgres");
    assert.ok(verifyMemory(dir, ...R).ok);
  });

  it("invalid proposals are refused at propose time, never parked", () => {
    const { dir, a } = seeded();
    // Fact without provenance.
    assert.throws(
      () => proposeMemory(dir, ...R, { kind: "fact", payload: { subject: "x", predicate: "y", object: "z", sourceEpisodes: [] } }),
      /provenance is mandatory/,
    );
    // Fact sourced from a non-episode.
    const f = assertFact(dir, ...R, FACT(a)).event;
    assert.throws(
      () => proposeMemory(dir, ...R, { kind: "fact", payload: { subject: "x", predicate: "y", object: "z", sourceEpisodes: [f.id] } }),
      /not an episode/,
    );
    // Link to a ghost.
    assert.throws(
      () => proposeMemory(dir, ...R, { kind: "link", payload: { from: a.id, to: "mem_nope", relation: "x" } }),
      /not found/,
    );
    // Unknown kind.
    assert.throws(() => proposeMemory(dir, ...R, { kind: "guess", payload: {} }), /fact\|link\|core/);
    // Nothing was parked by any of the failures.
    assert.equal(loadMemory(dir, ...R).proposals.length, 0);
  });

  it("ratifying an unknown proposal is a loud error", () => {
    const { dir } = seeded();
    assert.throws(() => resolveProposal(dir, ...R, { proposal: "mem_ghost", decision: "ratified" }), /not found/);
  });
});
