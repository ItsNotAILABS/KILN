/**
 * KILN Memory phase 3: the vector recall tier (lib/memory-vectors.mjs).
 *
 * The ref stays the source of truth; vectors live in the same
 * rebuildable sidecar as the FTS5 index and are synced only through
 * the signature-verified read path. These tests pin the contract:
 *   - the default embedder (hashing-v1) is deterministic, unit-norm,
 *     and lexical: near for shared tokens/n-grams, far for unrelated
 *     text, null for no signal;
 *   - fusion re-ranks lexical hits and adds eligible vector-only hits
 *     (via: "vector"), with provenance (`fusion` block, `vectorScore`)
 *     and the base engine still named;
 *   - eligibility parity: the vector tier never returns a doc the
 *     lexical paths would filter (superseded facts, since/until,
 *     tags, kinds) and never serves a chain signature verification
 *     would reject;
 *   - KILN_MEMORY_VECTORS=off, an unknown embedder id, or a throwing
 *     embedder all fall back to the untouched lexical result.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeStateDir } from "./helpers.mjs";
import { createRepo, repoPath } from "../lib/git.mjs";
import { canon } from "../lib/canon.mjs";
import { MEMORY_REF, remember, assertFact, supersedeFact, recall, memoryStats, loadMemory } from "../lib/memory.mjs";
import { computeEventHash } from "../lib/memory-signing.mjs";
import {
  activeEmbedder, registerEmbedder, memoryVectorsEnabled,
  syncMemoryVectors, memoryVectorsInfo, VECTOR_WEIGHT,
} from "../lib/memory-vectors.mjs";

const R = ["auro", "memvec"];
function freshRepo() {
  const dir = makeStateDir();
  createRepo(dir, "auro", "memvec");
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

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}
const vectorsOff = (fn) => withEnv({ KILN_MEMORY_VECTORS: "off" }, fn);

/** Oracle embedder: hand-set 2-axis vectors (mammal?, sleeps?) so fusion
 *  behavior is testable independent of the hashing embedder's quality. */
registerEmbedder({
  id: "oracle-v1",
  dim: 2,
  embed(text) {
    const t = String(text).toLowerCase();
    const m = /quokka|marsupial/.test(t) ? 1 : 0;
    const s = /sleeps|sleep|rest/.test(t) ? 1 : 0;
    if (!m && !s) return null;
    const n = Math.hypot(m, s);
    return [m / n, s / n];
  },
});
const withOracle = (fn) => withEnv({ KILN_MEMORY_EMBEDDER: "oracle-v1" }, fn);

describe("memory-vectors: hashing-v1 embedder", () => {
  const emb = () => activeEmbedder();
  const cos = (a, b) => {
    const x = emb().embed(a), y = emb().embed(b);
    return x.reduce((s, v, i) => s + v * y[i], 0);
  };

  it("is the default, deterministic and unit-norm", () => {
    assert.equal(emb().id, "hashing-v1");
    assert.deepEqual(emb().embed("postgres billing invoices"), emb().embed("postgres billing invoices"));
    const v = emb().embed("postgres billing invoices");
    assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-9);
  });

  it("scores shared-token text far above unrelated text (lexical, not magic)", () => {
    const near = cos("postgres database invoices", "postgres database billing");
    const far = cos("postgres database invoices", "tacos weather dallas lunch");
    assert.ok(near > 0.4, `near pair should be strongly positive, got ${near}`);
    assert.ok(far < near / 4, `unrelated pair should be near zero, got ${far}`);
  });

  it("character trigrams bridge morphology: deploy ~ deployment, invoice ~ invoices", () => {
    assert.ok(cos("deployment", "deploying the service") > 0.05);
    assert.ok(cos("invoice", "stores invoices in postgres") > 0.03);
  });

  it("returns null for text with no usable tokens", () => {
    assert.equal(emb().embed("!!! ???"), null);
    assert.equal(emb().embed(""), null);
  });
});

describe("memory-vectors: fusion over the lexical result", () => {
  it("fused recall names its provenance and keeps every lexical hit", () => {
    const { dir, a, f } = seeded();
    const base = vectorsOff(() => recall(dir, ...R, "Postgres billing invoices", { limit: 10 }));
    const r = recall(dir, ...R, "Postgres billing invoices", { limit: 10 });
    assert.equal(r.engine, "index", "base engine still named");
    assert.ok(r.fusion, "fusion provenance block present");
    assert.equal(r.fusion.embedder, "hashing-v1");
    assert.equal(r.fusion.dim, 256);
    assert.equal(r.fusion.weight, VECTOR_WEIGHT);
    assert.match(r.fusion.signal, /not semantic/);
    const baseIds = new Set(base.results.map((x) => x.id));
    for (const id of baseIds) {
      assert.ok(r.results.some((x) => x.id === id), `lexical hit ${id} survives fusion`);
    }
    assert.equal(r.results[0].id, f.id, "the fact still leads after fusion");
    const hitA = r.results.find((x) => x.id === a.id);
    assert.equal(hitA.via, "search", "lexical hits keep their via");
    assert.equal(typeof hitA.vectorScore, "number", "lexical hits gain a vectorScore");
  });

  it("vector-only hits enter via morphology the tokenizer misses (invoice → invoices)", () => {
    const { dir, a, c } = seeded();
    const off = vectorsOff(() => recall(dir, ...R, "invoice", { limit: 10 }));
    assert.deepEqual(off.results.map((x) => x.id), [c.id], "lexically, only the exact-token doc hits");
    const on = recall(dir, ...R, "invoice", { limit: 10 });
    const va = on.results.find((x) => x.id === a.id);
    assert.ok(va, "the 'invoices' episode joins through the vector tier");
    assert.equal(va.via, "vector");
    assert.ok(va.vectorScore > 0);
  });

  it("fusion composes with the scan engine too (index off)", () => {
    const { dir } = seeded();
    const r = withEnv({ KILN_MEMORY_INDEX: "off" }, () =>
      recall(dir, ...R, "Postgres billing invoices", { limit: 10 }));
    assert.equal(r.engine, "scan");
    assert.ok(r.fusion, "fusion applies over the scan result as well");
  });

  it("empty memory and empty-signal queries stay unfused and quiet", () => {
    const dir = freshRepo();
    const r = recall(dir, ...R, "anything");
    assert.equal(r.results.length, 0);
    const { dir: dir2 } = seeded();
    const r2 = recall(dir2, ...R, "!!!", { limit: 10 });
    assert.equal(r2.fusion, undefined, "no query signal → no fusion block");
  });
});

describe("memory-vectors: oracle embedder proves the fusion math", () => {
  it("a zero-lexical-overlap doc with a parallel vector is recalled via vector", () => {
    const dir = freshRepo();
    const q = remember(dir, ...R, {
      title: "Nap", content: "The quokka sleeps at noon.", actor: "test",
    }).event;
    remember(dir, ...R, {
      title: "Db", content: "Postgres stores invoices for billing.", actor: "test",
    });
    const off = vectorsOff(() => recall(dir, ...R, "marsupial rest habits", { limit: 10 }));
    assert.equal(off.results.length, 0, "lexically there is nothing to find");
    const r = withOracle(() => recall(dir, ...R, "marsupial rest habits", { limit: 10 }));
    assert.equal(r.fusion.embedder, "oracle-v1");
    const hit = r.results.find((x) => x.id === q.id);
    assert.ok(hit, "the quokka episode is recalled by vector alone");
    assert.equal(hit.via, "vector");
    assert.ok(Math.abs(hit.vectorScore - 1) < 0.01, `parallel vectors → cosine ~1, got ${hit.vectorScore}`);
  });
});

describe("memory-vectors: eligibility parity with the lexical paths", () => {
  function oracleSeeded() {
    const dir = freshRepo();
    const e = remember(dir, ...R, {
      title: "Animal", content: "The quokka sleeps in the sun.", tags: ["animals"],
      eventDate: "2020-06-01T00:00:00Z", actor: "test",
    }).event;
    const f = assertFact(dir, ...R, {
      subject: "quokka", predicate: "is a", object: "marsupial",
      sourceEpisodes: [e.id], actor: "test",
    }).event;
    return { dir, e, f };
  }

  it("superseded facts are excluded from vector additions; includeSuperseded restores them", () => {
    const { dir, f } = oracleSeeded();
    let r = withOracle(() => recall(dir, ...R, "marsupial", { limit: 10 }));
    assert.ok(r.results.some((x) => x.id === f.id), "fact recallable while valid");
    supersedeFact(dir, ...R, { fact: f.id, reason: "reclassified", actor: "test" });
    r = withOracle(() => recall(dir, ...R, "marsupial", { limit: 10 }));
    assert.ok(!r.results.some((x) => x.id === f.id), "superseded fact must not return via the vector tier");
    r = withOracle(() => recall(dir, ...R, "marsupial", { limit: 10, includeSuperseded: true }));
    const sup = r.results.find((x) => x.id === f.id);
    assert.ok(sup && sup.superseded === true, "superseded fact visible on request, marked as such");
  });

  it("since window, tag filter and kinds filter all bind vector additions", () => {
    const { dir, e } = oracleSeeded();
    let r = withOracle(() => recall(dir, ...R, "quokka marsupial", { limit: 10 }));
    assert.ok(r.results.some((x) => x.id === e.id), "baseline: episode found");
    r = withOracle(() => recall(dir, ...R, "quokka marsupial", { limit: 10, since: "2021-01-01" }));
    assert.ok(!r.results.some((x) => x.id === e.id), "episode before `since` excluded");
    r = withOracle(() => recall(dir, ...R, "quokka marsupial", { limit: 10, tags: ["plants"] }));
    assert.ok(!r.results.some((x) => x.id === e.id), "tag mismatch excluded");
    r = withOracle(() => recall(dir, ...R, "quokka marsupial", { limit: 10, kinds: ["fact"] }));
    assert.ok(!r.results.some((x) => x.id === e.id), "kinds filter excludes episodes");
    r = withOracle(() => recall(dir, ...R, "quokka marsupial", { limit: 10, kinds: ["episode"] }));
    assert.ok(r.results.some((x) => x.id === e.id), "kinds filter admits episodes");
  });

  it("a chain signature verification rejects is never served by the fused path", () => {
    const { dir } = oracleSeeded(); // all writes signed — epoch open
    const state = loadMemory(dir, ...R);
    const last = state.events[state.events.length - 1];
    // Forge an UNSIGNED post-epoch episode with a correct hash chain.
    const forged = {
      v: 1, id: "mem_forgedvec", seq: state.events.length, prev: last.hash,
      type: "episode", ts: Math.floor(Date.now() / 1000), actor: "forger",
      kind: "note", title: "Forged", content: "The quokka marsupial sleeps forged.",
      tags: [], entities: [], eventDate: null, source: null, salience: 1,
    };
    forged.hash = computeEventHash(forged);
    const gd = repoPath(dir, ...R);
    const tip = spawnSync("git", ["--git-dir", gd, "rev-parse", "-q", "--verify", MEMORY_REF], { encoding: "utf8" }).stdout.trim();
    const env = {
      ...process.env, GIT_AUTHOR_NAME: "forge", GIT_AUTHOR_EMAIL: "forge@kiln.local",
      GIT_COMMITTER_NAME: "forge", GIT_COMMITTER_EMAIL: "forge@kiln.local",
    };
    const g = (args, opts = {}) => execFileSync("git", ["--git-dir", gd, ...args], { encoding: "utf8", env, ...opts }).trim();
    const blob = g(["hash-object", "-w", "--stdin"], { input: canon(forged) });
    const idxDir = mkdtempSync(join(tmpdir(), "kiln-vec-forge-"));
    const ienv = { ...env, GIT_INDEX_FILE: join(idxDir, "index") };
    execFileSync("git", ["--git-dir", gd, "read-tree", tip], { env: ienv });
    execFileSync("git", ["--git-dir", gd, "update-index", "--add", "--cacheinfo",
      `100644,${blob},events/${String(forged.seq).padStart(8, "0")}-${forged.id}.json`], { env: ienv });
    const tree = execFileSync("git", ["--git-dir", gd, "write-tree"], { encoding: "utf8", env: ienv }).trim();
    const commit = g(["commit-tree", tree, "-m", `memory: episode ${forged.id}`, "-p", tip]);
    execFileSync("git", ["--git-dir", gd, "update-ref", MEMORY_REF, commit, tip], { env });
    assert.throws(() => recall(dir, ...R, "quokka"), /no signature but the signing epoch/);
    assert.throws(() => withOracle(() => recall(dir, ...R, "quokka")), /no signature but the signing epoch/);
  });
});

describe("memory-vectors: fallback discipline", () => {
  it("KILN_MEMORY_VECTORS=off → lexical result untouched, tier reports disabled", () => {
    const { dir, f } = seeded();
    vectorsOff(() => {
      assert.equal(memoryVectorsEnabled(), false);
      assert.equal(syncMemoryVectors(dir, ...R), null);
      assert.equal(memoryVectorsInfo(dir, ...R), null);
      const r = recall(dir, ...R, "Postgres billing invoices", { limit: 10 });
      assert.equal(r.fusion, undefined);
      assert.equal(r.results[0].id, f.id);
    });
    const stats = vectorsOff(() => memoryStats(dir, ...R));
    assert.equal(stats.vectors, null);
  });

  it("a throwing embedder falls back silently to the lexical result", () => {
    registerEmbedder({ id: "boom-v1", dim: 2, embed() { throw new Error("embedder exploded"); } });
    const { dir, f } = seeded();
    const r = withEnv({ KILN_MEMORY_EMBEDDER: "boom-v1" }, () =>
      recall(dir, ...R, "Postgres billing invoices", { limit: 10 }));
    assert.equal(r.fusion, undefined, "no fusion block when the embedder fails");
    assert.equal(r.results[0].id, f.id, "lexical ranking intact");
  });

  it("an unknown embedder id disables the tier instead of failing recall", () => {
    const { dir, f } = seeded();
    const r = withEnv({ KILN_MEMORY_EMBEDDER: "no-such-embedder" }, () =>
      recall(dir, ...R, "Postgres billing invoices", { limit: 10 }));
    assert.equal(r.fusion, undefined);
    assert.equal(r.results[0].id, f.id);
  });
});

describe("memory-vectors: sync semantics", () => {
  it("embeds incrementally, reports through stats, and re-embeds on embedder change", () => {
    const { dir } = seeded();
    const s1 = syncMemoryVectors(dir, ...R);
    assert.equal(s1.embedder, "hashing-v1");
    assert.equal(s1.docs, 4);
    assert.equal(s1.embedded, 4);
    const s2 = syncMemoryVectors(dir, ...R);
    assert.equal(s2.embedded, 0, "second sync is a no-op");
    const d = remember(dir, ...R, {
      title: "Zebra", content: "A zebra visited the observatory at midnight.", actor: "test",
    }).event;
    const s3 = syncMemoryVectors(dir, ...R);
    assert.equal(s3.embedded, 1, "only the new doc is embedded");
    assert.ok(d.id);
    const stats = memoryStats(dir, ...R);
    assert.equal(stats.vectors.embedder, "hashing-v1");
    assert.equal(stats.vectors.vectors, 5);
    assert.match(stats.vectors.signal, /not semantic/);

    registerEmbedder({ id: "stub-v1", dim: 2, embed: () => [1, 0] });
    const s4 = withEnv({ KILN_MEMORY_EMBEDDER: "stub-v1" }, () => syncMemoryVectors(dir, ...R));
    assert.equal(s4.embedder, "stub-v1");
    assert.equal(s4.embedded, 5, "embedder change re-embeds the whole doc set");
    const info = withEnv({ KILN_MEMORY_EMBEDDER: "stub-v1" }, () => memoryVectorsInfo(dir, ...R));
    assert.equal(info.embedder, "stub-v1");
    assert.equal(info.vectors, 5);
  });
});
