/**
 * KILN Memory: per-repo infinite memory on refs/kiln/memory.
 * Real git plumbing against real bare repos — no mocks.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeStateDir } from "./helpers.mjs";
import { createRepo, repoPath } from "../lib/git.mjs";
import {
  MEMORY_REF, remember, assertFact, supersedeFact, linkMemories, setCore,
  loadMemory, factsAt, recall, buildContext, memoryStats, verifyMemory, readEvents,
} from "../lib/memory.mjs";
import { SwarmClient } from "../lib/client.mjs";
import { listNodeIds, loadNode, pidAlive } from "../lib/state.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON = join(HERE, "..", "lib", "daemon.mjs");

function freshRepo() {
  const dir = makeStateDir();
  createRepo(dir, "auro", "memtest");
  return dir;
}
const R = ["auro", "memtest"];

describe("memory: episodes + provenance facts", () => {
  it("remembers an episode and derives a fact that cites it", () => {
    const dir = freshRepo();
    const { event: ep } = remember(dir, ...R, {
      title: "Build night",
      content: "We chose Postgres for the billing service after the SQLite lock incident.",
      tags: ["billing"], entities: ["billing service", "Postgres"],
      source: { type: "note", ref: "session-1" },
      actor: "test",
    });
    assert.equal(ep.type, "episode");
    assert.equal(ep.seq, 0);
    assert.equal(ep.prev, "GENESIS");

    const { event: fact } = assertFact(dir, ...R, {
      subject: "billing service", predicate: "uses database", object: "Postgres",
      sourceEpisodes: [ep.id], actor: "test",
    });
    assert.equal(fact.seq, 1);
    assert.equal(fact.prev, ep.hash);

    const state = loadMemory(dir, ...R);
    assert.equal(state.episodes.length, 1);
    assert.equal(state.episodes[0].content.includes("SQLite lock incident"), true);
    const facts = factsAt(state);
    assert.equal(facts.length, 1);
    assert.equal(facts[0].object, "Postgres");
    assert.deepEqual(facts[0].sourceEpisodes, [ep.id]);
  });

  it("refuses a fact with no provenance or a phantom source", () => {
    const dir = freshRepo();
    assert.throws(
      () => assertFact(dir, ...R, { subject: "x", predicate: "is", object: "y", sourceEpisodes: [] }),
      /provenance is mandatory/
    );
    assert.throws(
      () => assertFact(dir, ...R, { subject: "x", predicate: "is", object: "y", sourceEpisodes: ["mem_nope"] }),
      /not found/
    );
  });

  it("stores large content as a git blob and reads it back intact", () => {
    const dir = freshRepo();
    const big = "payload line about kiln memory scaling\n".repeat(500); // ~20k chars
    const { event } = remember(dir, ...R, { content: big, actor: "test" });
    assert.ok(event.contentBlob, "large content must be blob-backed");
    assert.equal(event.content, undefined);
    const state = loadMemory(dir, ...R);
    assert.equal(state.episodes[0].content, big);
  });

  it("memory lives in the repo itself, on the orphan ref", () => {
    const dir = freshRepo();
    remember(dir, ...R, { content: "ref check", actor: "test" });
    const gd = repoPath(dir, ...R);
    const tip = execFileSync("git", ["--git-dir", gd, "rev-parse", MEMORY_REF], { encoding: "utf8" }).trim();
    assert.match(tip, /^[0-9a-f]{40}$/);
    // The memory lineage is NOT the code lineage.
    const branches = execFileSync("git", ["--git-dir", gd, "branch", "-a"], { encoding: "utf8" });
    assert.equal(branches.trim(), "");
  });
});

describe("memory: supersede, never delete (bi-temporal facts)", () => {
  it("a new fact supersedes the old one atomically; as-of queries time-travel", () => {
    const dir = freshRepo();
    const { event: ep } = remember(dir, ...R, { content: "Deploys moved from Fridays to Tuesdays in March.", actor: "test" });
    const { event: f1 } = assertFact(dir, ...R, {
      subject: "team", predicate: "deploys on", object: "Friday",
      sourceEpisodes: [ep.id], validFrom: "2026-01-01T00:00:00Z", actor: "test",
    });
    const { event: f2 } = assertFact(dir, ...R, {
      subject: "team", predicate: "deploys on", object: "Tuesday",
      sourceEpisodes: [ep.id], validFrom: "2026-03-01T00:00:00Z", supersedes: [f1.id], actor: "test",
    });
    assert.ok(f2.supersedes.includes(f1.id));

    const state = loadMemory(dir, ...R);
    const now = factsAt(state);
    assert.deepEqual(now.map((f) => f.object), ["Tuesday"]);
    const feb = factsAt(state, Math.floor(Date.parse("2026-02-01T00:00:00Z") / 1000));
    assert.deepEqual(feb.map((f) => f.object), ["Friday"]);
    const all = factsAt(state, Math.floor(Date.now() / 1000), true);
    assert.equal(all.length, 2); // history is never deleted
    const stats = memoryStats(dir, ...R);
    assert.equal(stats.facts.current, 1);
    assert.equal(stats.facts.superseded, 1);
  });

  it("standalone supersede retracts a fact with a reason", () => {
    const dir = freshRepo();
    const { event: ep } = remember(dir, ...R, { content: "The staging URL was wrong in the runbook.", actor: "test" });
    const { event: f } = assertFact(dir, ...R, {
      subject: "staging", predicate: "url is", object: "staging.old.example",
      sourceEpisodes: [ep.id], actor: "test",
    });
    supersedeFact(dir, ...R, { fact: f.id, reason: "runbook was wrong", actor: "test" });
    const state = loadMemory(dir, ...R);
    assert.equal(factsAt(state).length, 0);
    assert.equal(state.facts.length, 1); // still in history
    assert.equal(state.facts[0].invalidatedBy !== null, true);
  });
});

describe("memory: recall + context packs", () => {
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
      tags: ["performance"], actor: "test", // deliberately zero term overlap with the recall query
    }).event;
    return { dir, a, b, c };
  }

  it("BM25 ranks the relevant episode first and skips the noise", () => {
    const { dir, a, b } = seeded();
    const r = recall(dir, ...R, "Postgres billing invoices");
    assert.ok(r.results.length >= 1);
    assert.equal(r.results[0].id, a.id);
    assert.ok(!r.results.some((x) => x.id === b.id) || r.results[r.results.length - 1].id === b.id);
    assert.equal(r.results[0].via, "search");
  });

  it("one-hop link expansion pulls in a linked memory with no term overlap", () => {
    const { dir, a, c } = seeded();
    linkMemories(dir, ...R, { from: a.id, to: c.id, relation: "follow-up", actor: "test" });
    const r = recall(dir, ...R, "Postgres billing invoices", { limit: 10 });
    const linked = r.results.find((x) => x.id === c.id);
    assert.ok(linked, "linked episode must appear via graph expansion");
    assert.match(linked.via, /^link:follow-up:/);
  });

  it("core blocks always lead the context pack; budget is honored and reported", () => {
    const { dir } = seeded();
    setCore(dir, ...R, { label: "project", value: "Billing service: Postgres, row-level security, invoices are sacred.", actor: "test" });
    const pack = buildContext(dir, ...R, { query: "Postgres invoices", budgetTokens: 300 });
    assert.equal(pack.core.length, 1);
    assert.equal(pack.core[0].label, "project");
    assert.match(pack.text, /^# Memory · auro\/memtest/);
    assert.ok(pack.text.indexOf("invoices are sacred") < pack.text.indexOf("Facts") || !pack.text.includes("## Facts"));
    assert.ok(pack.usedTokens <= pack.budgetTokens, `used ${pack.usedTokens} <= budget ${pack.budgetTokens}`);
    const tiny = buildContext(dir, ...R, { budgetTokens: 64 });
    assert.equal(tiny.overBudget, true); // reported, never silent
  });
});

describe("memory: integrity + isolation", () => {
  it("verify passes on a healthy chain", () => {
    const dir = freshRepo();
    const ep = remember(dir, ...R, { content: "chain me", actor: "test" }).event;
    assertFact(dir, ...R, { subject: "s", predicate: "p", object: "o", sourceEpisodes: [ep.id], actor: "test" });
    const v = verifyMemory(dir, ...R);
    assert.equal(v.ok, true);
    assert.equal(v.events, 2);
    assert.equal(v.commits, 2);
  });

  it("verify catches a forged event appended outside the library", () => {
    const dir = freshRepo();
    remember(dir, ...R, { content: "honest event", actor: "test" });
    const gd = repoPath(dir, ...R);
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "forger", GIT_AUTHOR_EMAIL: "f@x",
      GIT_COMMITTER_NAME: "forger", GIT_COMMITTER_EMAIL: "f@x",
    };
    const tip = execFileSync("git", ["--git-dir", gd, "rev-parse", MEMORY_REF], { encoding: "utf8" }).trim();
    const forged = JSON.stringify({ v: 1, id: "mem_forged", seq: 1, prev: "bogus", type: "episode", ts: 1, actor: "forger", content: "lies", hash: "deadbeef" });
    const blob = execFileSync("git", ["--git-dir", gd, "hash-object", "-w", "--stdin"], { input: forged, encoding: "utf8", env }).trim();
    // Forge a child commit on the real tip via a throwaway index — the
    // same plumbing the library uses, but with a lying event payload.
    const idxDir = mkdtempSync(join(tmpdir(), "kiln-forge-"));
    const ienv = { ...env, GIT_INDEX_FILE: join(idxDir, "index") };
    execFileSync("git", ["--git-dir", gd, "read-tree", tip], { env: ienv });
    execFileSync("git", ["--git-dir", gd, "update-index", "--add", "--cacheinfo", `100644,${blob},events/00000001-mem_forged.json`], { env: ienv });
    const tree = execFileSync("git", ["--git-dir", gd, "write-tree"], { encoding: "utf8", env: ienv }).trim();
    const commit = execFileSync("git", ["--git-dir", gd, "commit-tree", tree, "-p", tip, "-m", "forge"], { encoding: "utf8", env }).trim();
    execFileSync("git", ["--git-dir", gd, "update-ref", MEMORY_REF, commit, tip], { env });
    const v = verifyMemory(dir, ...R);
    assert.equal(v.ok, false);
  });

  it("repos cannot see each other's memory", () => {
    const dir = makeStateDir();
    createRepo(dir, "auro", "one");
    createRepo(dir, "auro", "two");
    remember(dir, "auro", "one", { content: "secret of repo one: falcon", actor: "test" });
    const r = recall(dir, "auro", "two", "falcon");
    assert.equal(r.results.length, 0);
    const s2 = memoryStats(dir, "auro", "two");
    assert.equal(s2.events, 0);
    assert.throws(() => readEvents(dir, "auro", "ghost"), /no such repo/);
  });

  it("empty memory is a first-class state, not an error", () => {
    const dir = freshRepo();
    const s = memoryStats(dir, ...R);
    assert.equal(s.events, 0);
    assert.equal(s.tip, null);
    const pack = buildContext(dir, ...R, {});
    assert.equal(pack.core.length, 0);
    assert.equal(pack.facts.length, 0);
  });
});

describe("memory: HTTP API + client SDK (real daemon)", () => {
  let dir, daemon, client;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  it("boots a daemon and round-trips memory through the SDK", async () => {
    dir = makeStateDir();
    daemon = spawn(process.execPath, [DAEMON], {
      env: { ...process.env, KILN_SWARM_DIR: dir, KILN_SWARM_API_PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const t0 = Date.now();
    for (;;) {
      const p = join(dir, "daemon.json");
      if (existsSync(p)) {
        try { if (JSON.parse(readFileSync(p, "utf8")).apiPort) break; } catch { /* writing */ }
      }
      if (Date.now() - t0 > 20000) throw new Error("daemon api never came up");
      await sleep(200);
    }
    client = await SwarmClient.connect({ dir });
    await client.createRepo({ owner: "auro", repo: "apimem" });

    const { event: ep } = await client.memoryRemember("auro", "apimem", {
      title: "API episode", content: "The API stores memory per repo.", actor: "api-test",
    });
    assert.ok(ep.id.startsWith("mem_"));
    const { fact } = await client.memoryFact("auro", "apimem", {
      subject: "api", predicate: "stores", object: "per-repo memory", sourceEpisodes: [ep.id],
    });
    assert.equal(fact.object, "per-repo memory");
    const rec = await client.memoryRecall("auro", "apimem", "per-repo memory");
    assert.ok(rec.results.length >= 1);
    const pack = await client.memoryContext("auro", "apimem", { query: "memory", budgetTokens: 500 });
    assert.match(pack.text, /Memory · auro\/apimem/);
    const v = await client.memoryVerify("auro", "apimem");
    assert.equal(v.ok, true);
    const stats = await client.memoryStats("auro", "apimem");
    assert.equal(stats.events, 2);

    // Unauthenticated memory access is refused.
    const dj = JSON.parse(readFileSync(join(dir, "daemon.json"), "utf8"));
    const res = await fetch(`${dj.apiUrl}/git/auro/apimem/memory/stats`);
    assert.equal(res.status, 401);
  });

  after(async () => {
    if (daemon && pidAlive(daemon.pid)) {
      daemon.kill("SIGTERM");
      await new Promise((r) => { daemon.on("exit", r); setTimeout(r, 5000); });
    }
    if (dir) {
      for (const id of listNodeIds(dir)) {
        const n = loadNode(dir, id);
        assert.ok(!pidAlive(n.workerPid), `worker ${n.name} must be stopped after test`);
      }
    }
  });
});
