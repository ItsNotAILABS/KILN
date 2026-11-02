/**
 * KILN Memory phase 1: the FTS5 index sidecar (lib/memory-index.mjs).
 *
 * The ref stays the source of truth; the sidecar is a rebuildable
 * cache. These tests pin the contract:
 *   - recall is served by the index (engine: "index") and agrees with
 *     the v1 scan on hit sets and top hits across a query battery;
 *   - sync is incremental (new events appear without a rebuild) and
 *     self-healing (a diverged sidecar rebuilds from the ref);
 *   - fact validity windows survive the move to the index;
 *   - KILN_MEMORY_INDEX=off falls back to the scan, untouched.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { makeStateDir } from "./helpers.mjs";
import { createRepo } from "../lib/git.mjs";
import {
  remember, assertFact, supersedeFact, linkMemories, recall, memoryStats,
} from "../lib/memory.mjs";
import { syncMemoryIndex, memoryIndexInfo } from "../lib/memory-index.mjs";

const R = ["auro", "memtest"];
function freshRepo() {
  const dir = makeStateDir();
  createRepo(dir, "auro", "memtest");
  return dir;
}

function seeded() {
  const dir = freshRepo();
  const a = remember(dir, ...R, {
    title: "Database choice",
    content: "The billing service stores invoices in Postgres with row level security.",
    tags: ["billing"], actor: "test",
  }).event;
  const b = remember(dir, ...R, {
    title: "Lunch",
    content: "The team ordered tacos and talked about the weather in Dallas.",
    actor: "test",
  }).event;
  const c = remember(dir, ...R, {
    title: "Indexing note",
    content: "Invoice lookups were slow until the composite index landed.",
    tags: ["performance"], actor: "test",
  }).event;
  const f = assertFact(dir, ...R, {
    subject: "billing service", predicate: "stores invoices in", object: "Postgres",
    sourceEpisodes: [a.id], actor: "test",
  }).event;
  return { dir, a, b, c, f };
}

function scanRecall(dir, q, opts) {
  process.env.KILN_MEMORY_INDEX = "off";
  try { return recall(dir, ...R, q, opts); } finally { delete process.env.KILN_MEMORY_INDEX; }
}
const idSet = (r) => new Set(r.results.map((x) => x.id));

describe("memory-index: serves recall, agrees with the scan", () => {
  it("engine is index, top hit and hit set match the scan", () => {
    const { dir, f } = seeded();
    const ri = recall(dir, ...R, "Postgres billing invoices");
    assert.equal(ri.engine, "index");
    // In this corpus the fact outranks the episode under BOTH engines:
    // its doc text repeats the query terms (SPO + entities) in a shorter
    // doc. The contract is engine agreement, not a fixed winner.
    assert.equal(ri.results[0].id, f.id);
    const rs = scanRecall(dir, "Postgres billing invoices");
    assert.equal(rs.engine, "scan");
    assert.equal(rs.results[0].id, ri.results[0].id);
    assert.deepEqual(idSet(ri), idSet(rs));
  });

  it("hit sets agree across a query battery (episodes + facts)", () => {
    const { dir } = seeded();
    for (const q of ["Postgres", "invoices", "tacos weather", "composite index", "row level security", "billing", "Postgres billing invoices"]) {
      const ri = recall(dir, ...R, q, { limit: 10 });
      const rs = scanRecall(dir, q, { limit: 10 });
      assert.deepEqual(idSet(ri), idSet(rs), `hit set mismatch for "${q}"`);
      if (rs.results.length) assert.equal(ri.results[0].id, rs.results[0].id, `top hit mismatch for "${q}"`);
    }
  });

  it("one-hop link expansion works through the index", () => {
    const { dir, a, c } = seeded();
    linkMemories(dir, ...R, { from: a.id, to: c.id, relation: "follow-up", actor: "test" });
    const r = recall(dir, ...R, "Postgres billing invoices", { limit: 10 });
    assert.equal(r.engine, "index");
    const linked = r.results.find((x) => x.id === c.id);
    assert.ok(linked, "linked episode must appear via graph expansion");
    assert.match(linked.via, /^link:follow-up:/);
  });

  it("empty memory recalls empty through the index", () => {
    const dir = freshRepo();
    const r = recall(dir, ...R, "anything");
    assert.equal(r.results.length, 0);
  });
});

describe("memory-index: sync semantics", () => {
  it("incremental: a new episode is recallable on the next call, no rebuild", () => {
    const { dir } = seeded();
    recall(dir, ...R, "Postgres"); // prime the sidecar
    const before = memoryIndexInfo(dir, ...R);
    const d = remember(dir, ...R, {
      title: "Zebra", content: "A zebra visited the observatory at midnight.", actor: "test",
    }).event;
    const r = recall(dir, ...R, "zebra observatory");
    assert.equal(r.engine, "index");
    assert.ok(r.results.some((x) => x.id === d.id), "new episode must be indexed incrementally");
    const after = memoryIndexInfo(dir, ...R);
    assert.equal(after.docs, before.docs + 1);
    assert.equal(after.lastSeq, before.lastSeq + 1);
  });

  it("self-healing: a diverged sidecar (lying meta) rebuilds from the ref", () => {
    const { dir, f } = seeded();
    recall(dir, ...R, "Postgres");
    const db = new DatabaseSync(join(dir, "memory-index", "auro__memtest.sqlite"));
    db.prepare("UPDATE meta SET v = 'deadbeef' WHERE k = 'lastHash'").run();
    db.prepare("UPDATE meta SET v = '0' WHERE k = 'tip'").run();
    db.close();
    const r = recall(dir, ...R, "Postgres billing invoices");
    assert.equal(r.engine, "index");
    assert.equal(r.results[0].id, f.id);
    const info = memoryIndexInfo(dir, ...R);
    assert.ok(info.docs >= 4, "rebuild restored the doc set");
  });

  it("fact validity windows are honored: supersede removes, includeSuperseded restores", () => {
    const { dir, f } = seeded();
    let r = recall(dir, ...R, "Postgres invoices", { limit: 10 });
    assert.ok(r.results.some((x) => x.id === f.id && x.kind === "fact"), "fact recallable while valid");
    supersedeFact(dir, ...R, { fact: f.id, reason: "moved to ClickHouse", actor: "test" });
    r = recall(dir, ...R, "Postgres invoices", { limit: 10 });
    assert.equal(r.engine, "index");
    assert.ok(!r.results.some((x) => x.id === f.id), "superseded fact excluded after sync");
    r = recall(dir, ...R, "Postgres invoices", { limit: 10, includeSuperseded: true });
    const sup = r.results.find((x) => x.id === f.id);
    assert.ok(sup, "superseded fact visible on request");
    assert.equal(sup.superseded, true);
  });

  it("syncMemoryIndex reports the tip it indexed; stats expose the sidecar", () => {
    const { dir } = seeded();
    const s = syncMemoryIndex(dir, ...R);
    assert.ok(s.tip && s.docs === 4);
    const stats = memoryStats(dir, ...R);
    assert.ok(stats.index && stats.index.docs === 4, "memoryStats carries the index block");
  });
});

describe("memory-index: fallback", () => {
  it("KILN_MEMORY_INDEX=off → scan engine, same top hit", () => {
    const { dir, f } = seeded();
    const rs = scanRecall(dir, "Postgres billing invoices");
    assert.equal(rs.engine, "scan");
    assert.equal(rs.results[0].id, f.id);
  });
});
