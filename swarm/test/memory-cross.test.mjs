/**
 * KILN Memory phase 6: cross-repo recall (lib/memory-cross.mjs).
 *
 * The contract pinned here:
 *   - one query fans out over every repo chain in the state dir and
 *     returns fused hits, each carrying explicit provenance (repo,
 *     engine/tier, chain signing posture, raw in-repo score);
 *   - merging normalizes per repo (max-normalization), so a large
 *     corpus cannot drown a small one on corpus statistics alone;
 *   - a chain that fails phase-2 signature verification is EXCLUDED
 *     and named in the envelope (repos[] + excluded[]) — never
 *     silently skipped, never allowed to contribute hits;
 *   - eligibility (kinds / tags / factsAt / supersession) matches
 *     single-repo recall per repo, by construction and by test;
 *   - single-repo recall is byte-for-byte the old behavior, and the
 *     KILN_MEMORY_CROSSREPO=off kill switch fails loudly.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeStateDir } from "./helpers.mjs";
import { createRepo, repoPath } from "../lib/git.mjs";
import { canon } from "../lib/canon.mjs";
import {
  MEMORY_REF, remember, assertFact, recall, recallCrossRepo,
} from "../lib/memory.mjs";
import { computeEventHash } from "../lib/memory-signing.mjs";
import { SwarmClient } from "../lib/client.mjs";
import { listNodeIds, loadNode, pidAlive } from "../lib/state.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SWARM = join(HERE, "..", "swarm.mjs");
const DAEMON = join(HERE, "..", "lib", "daemon.mjs");

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test-forge", GIT_AUTHOR_EMAIL: "forge@kiln.local",
  GIT_COMMITTER_NAME: "test-forge", GIT_COMMITTER_EMAIL: "forge@kiln.local",
};
function g(gd, args, opts = {}) {
  return execFileSync("git", ["--git-dir", gd, ...args], { encoding: "utf8", env: GIT_ENV, ...opts }).trim();
}
/** Append a hand-built event with raw plumbing (the forgery path). */
function appendRawEvent(dir, owner, repo, ev) {
  const gd = repoPath(dir, owner, repo);
  let tip = null;
  try { tip = g(gd, ["rev-parse", "-q", "--verify", MEMORY_REF]); } catch { /* genesis */ }
  const blob = g(gd, ["hash-object", "-w", "--stdin"], { input: canon(ev) });
  const idxDir = mkdtempSync(join(tmpdir(), "kiln-cross-forge-"));
  const ienv = { ...GIT_ENV, GIT_INDEX_FILE: join(idxDir, "index") };
  if (tip) execFileSync("git", ["--git-dir", gd, "read-tree", tip], { env: ienv });
  else execFileSync("git", ["--git-dir", gd, "read-tree", "--empty"], { env: ienv });
  const name = `events/${String(ev.seq).padStart(8, "0")}-${ev.id}.json`;
  execFileSync("git", ["--git-dir", gd, "update-index", "--add", "--cacheinfo", `100644,${blob},${name}`], { env: ienv });
  const tree = execFileSync("git", ["--git-dir", gd, "write-tree"], { encoding: "utf8", env: ienv }).trim();
  const cargs = ["commit-tree", tree, "-m", `memory: ${ev.type} ${ev.id}`];
  if (tip) cargs.push("-p", tip);
  const commit = execFileSync("git", ["--git-dir", gd, ...cargs], { encoding: "utf8", env: GIT_ENV }).trim();
  execFileSync("git", ["--git-dir", gd, "update-ref", MEMORY_REF, commit, tip || "0".repeat(40)], { env: GIT_ENV });
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

/**
 * A five-repo world: alpha (small, strong falcon content + a fact),
 * beta (9-episode corpus, one falcon mention), gamma (another owner),
 * empty (repo, no memory), forged (honest signed episode + a
 * stale-signature append carrying a unique token).
 */
function seedWorld() {
  const dir = makeStateDir();
  createRepo(dir, "auro", "alpha");
  createRepo(dir, "auro", "beta");
  createRepo(dir, "ops", "gamma");
  createRepo(dir, "auro", "empty");
  createRepo(dir, "auro", "forged");

  const aEp = remember(dir, "auro", "alpha", {
    title: "Falconry notes",
    content: "falcon falcon falcon — the falcon is the fastest bird in a dive",
    tags: ["birds"], actor: "test",
  }).event;
  const aFact = assertFact(dir, "auro", "alpha", {
    subject: "falcon", predicate: "is", object: "fastest bird",
    sourceEpisodes: [aEp.id], actor: "test",
  }).event;

  for (let i = 0; i < 8; i++) {
    remember(dir, "auro", "beta", {
      content: `deployment checklist item ${i}: restart the worker pool and drain queues`,
      actor: "test",
    });
  }
  const bEp = remember(dir, "auro", "beta", {
    content: "a falcon appeared in the release notes", actor: "test",
  }).event;

  const gEp = remember(dir, "ops", "gamma", {
    content: "falcon monitoring dashboard for the observatory", actor: "test",
  }).event;
  const gFuture = assertFact(dir, "ops", "gamma", {
    subject: "falcon", predicate: "will be", object: "tracked by satellite",
    sourceEpisodes: [gEp.id], validFrom: "2999-01-01T00:00:00Z", actor: "test",
  }).event;

  const fEp = remember(dir, "auro", "forged", {
    content: "honest falcon note", actor: "test",
  }).event;
  const forgedEv = {
    ...fEp, id: "mem_forgedx", seq: 1, prev: fEp.hash,
    content: "quixoticzebra forged falcon claim",
  };
  delete forgedEv.hash; delete forgedEv.sig;
  forgedEv.hash = computeEventHash(forgedEv); // hash chain intact…
  forgedEv.sig = fEp.sig;                     // …signature stale
  appendRawEvent(dir, "auro", "forged", forgedEv);

  return { dir, aEp, aFact, bEp, gEp, gFuture, fEp, forgedEv };
}

describe("memory cross-repo: fusion + provenance", () => {
  let W;
  before(() => { W = seedWorld(); });

  it("fans out over every repo and tags each hit with provenance", () => {
    const r = recallCrossRepo(W.dir, "falcon", { limit: 20 });
    assert.equal(r.crossRepo, true);
    const reposHit = new Set(r.results.map((x) => x.repo));
    assert.ok(reposHit.has("auro/alpha"), "alpha contributes");
    assert.ok(reposHit.has("auro/beta"), "beta contributes");
    assert.ok(reposHit.has("ops/gamma"), "gamma contributes");
    assert.ok(!reposHit.has("auro/forged"), "forged repo contributes nothing");
    for (const x of r.results) {
      assert.equal(typeof x.repo, "string");
      assert.ok(["index", "scan"].includes(x.engine), `engine named, got ${x.engine}`);
      assert.equal(typeof x.repoScore, "number");
      assert.ok(x.score >= 0 && x.score <= 1, "merged scores are normalized to [0,1]");
      assert.ok(Array.isArray(x.signing.signers), "chain signing posture on the hit");
      assert.ok(x.signing.signed >= 1, "chains here are signed");
    }
    // Merged ranking is sorted by normalized score.
    for (let i = 1; i < r.results.length; i++) {
      assert.ok(r.results[i - 1].score >= r.results[i].score, "sorted desc");
    }
    // Each contributing repo's best hit max-normalizes to exactly 1.
    for (const name of reposHit) {
      const top = Math.max(...r.results.filter((x) => x.repo === name).map((x) => x.score));
      assert.equal(top, 1, `${name}'s top hit normalizes to 1`);
    }
    const status = Object.fromEntries(r.repos.map((s) => [s.repo, s.status]));
    assert.deepEqual(status, {
      "auro/alpha": "ok", "auro/beta": "ok", "auro/empty": "empty",
      "auro/forged": "excluded", "ops/gamma": "ok",
    });
  });

  it("per-repo engine + fusion provenance matches the single-repo envelope", () => {
    const single = recall(W.dir, "auro", "alpha", "falcon");
    const cross = recallCrossRepo(W.dir, "falcon", { limit: 20 });
    const hit = cross.results.find((x) => x.repo === "auro/alpha" && x.id === W.aEp.id);
    assert.ok(hit, "alpha episode present in cross results");
    assert.equal(hit.engine, single.engine);
    assert.equal(hit.fusion?.embedder, single.fusion?.embedder);
    assert.equal(hit.repoScore, single.results.find((x) => x.id === W.aEp.id)?.score);
  });
});

describe("memory cross-repo: forged-chain exclusion", () => {
  let W;
  before(() => { W = seedWorld(); });

  it("excludes the forged repo loudly in the envelope and never serves its content", () => {
    const r = recallCrossRepo(W.dir, "falcon", { limit: 20 });
    assert.equal(r.excluded.length, 1);
    assert.equal(r.excluded[0].repo, "auro/forged");
    assert.match(r.excluded[0].error, /signature verification failed/);
    const st = r.repos.find((s) => s.repo === "auro/forged");
    assert.equal(st.status, "excluded");
    assert.match(st.error, /signature verification failed/);
    assert.ok(!r.results.some((x) => x.repo === "auro/forged"));
    // Even the forged event's unique token cannot surface — and the
    // honest repos still answer the same query.
    const r2 = recallCrossRepo(W.dir, "quixoticzebra", { limit: 20 });
    assert.ok(!r2.results.some((x) => (x.text || "").includes("quixoticzebra")));
    assert.ok(!r2.results.some((x) => x.repo === "auro/forged"));
    assert.equal(r2.excluded.length, 1);
    // The honest episode in the forged repo is collateral: the whole
    // chain is untrusted once verification fails (per-repo boundary).
    const r3 = recallCrossRepo(W.dir, "honest falcon note", { limit: 20 });
    assert.ok(!r3.results.some((x) => x.id === W.fEp.id));
  });
});

describe("memory cross-repo: eligibility parity with single-repo recall", () => {
  let W;
  before(() => { W = seedWorld(); });

  it("kinds filter applies per repo; the future-validFrom fact is not yet eligible", () => {
    const cross = recallCrossRepo(W.dir, "falcon", { kinds: ["fact"], limit: 20 });
    assert.ok(cross.results.every((x) => x.kind === "fact"));
    assert.ok(cross.results.some((x) => x.id === W.aFact.id), "alpha fact found");
    assert.ok(!cross.results.some((x) => x.id === W.gFuture.id), "future fact withheld, factsAt parity");
    // Same id sets as single-repo recall, per repo.
    for (const [o, rp] of [["auro", "alpha"], ["auro", "beta"], ["ops", "gamma"]]) {
      const single = recall(W.dir, o, rp, "falcon", { kinds: ["fact"], limit: 20 });
      const mine = cross.results.filter((x) => x.repo === `${o}/${rp}`).map((x) => x.id).sort();
      assert.deepEqual(mine, single.results.map((x) => x.id).sort(), `${o}/${rp} fact id set parity`);
    }
  });

  it("tags filter applies per repo (episodes), exactly as single-repo", () => {
    const cross = recallCrossRepo(W.dir, "falcon", { tags: ["birds"], limit: 20 });
    assert.ok(cross.results.length >= 1);
    assert.ok(cross.results.every((x) => x.repo === "auro/alpha"), "only alpha has birds-tagged episodes");
    assert.ok(cross.results.some((x) => x.id === W.aEp.id));
  });

  it("supersession parity: default hides, includeSuperseded shows — same ids as single-repo", () => {
    const dir = makeStateDir();
    createRepo(dir, "auro", "solo");
    const ep = remember(dir, "auro", "solo", {
      content: "the deploy target is the lunar registry service", actor: "test",
    }).event;
    const f1 = assertFact(dir, "auro", "solo", {
      subject: "deploy target", predicate: "is", object: "lunar registry",
      sourceEpisodes: [ep.id], actor: "test",
    }).event;
    const f2 = assertFact(dir, "auro", "solo", {
      subject: "deploy target", predicate: "is", object: "orbital registry",
      sourceEpisodes: [ep.id], supersedes: [f1.id], actor: "test",
    }).event;

    const def = recallCrossRepo(dir, "deploy target", { kinds: ["fact"] });
    assert.ok(def.results.some((x) => x.id === f2.id));
    assert.ok(!def.results.some((x) => x.id === f1.id), "superseded fact hidden by default");
    const inc = recallCrossRepo(dir, "deploy target", { kinds: ["fact"], includeSuperseded: true });
    const old = inc.results.find((x) => x.id === f1.id);
    assert.ok(old, "superseded fact visible on request");
    assert.equal(old.superseded, true);
    const single = recall(dir, "auro", "solo", "deploy target", { kinds: ["fact"], includeSuperseded: true });
    assert.deepEqual(
      inc.results.map((x) => x.id).sort(), single.results.map((x) => x.id).sort(),
      "cross-repo id set equals single-repo id set for the same repo");
  });

  it("a bad global date option throws once — it is not a per-repo exclusion", () => {
    assert.throws(() => recallCrossRepo(W.dir, "falcon", { asOf: "not-a-date" }), /asOf is not a valid date/);
    assert.throws(() => recallCrossRepo(W.dir, "falcon", { since: "junk" }), /since is not a valid date/);
  });
});

describe("memory cross-repo: mode discipline", () => {
  let W;
  before(() => { W = seedWorld(); });

  it("recall(owner '*') is the cross mode; single-repo recall is untouched", () => {
    const viaStar = recall(W.dir, "*", "*", "falcon", { limit: 20 });
    assert.equal(viaStar.crossRepo, true);
    const direct = recallCrossRepo(W.dir, "falcon", { limit: 20 });
    assert.deepEqual(
      viaStar.results.map((x) => `${x.repo}:${x.id}`).sort(),
      direct.results.map((x) => `${x.repo}:${x.id}`).sort());
    assert.deepEqual(
      viaStar.repos.map((s) => `${s.repo}:${s.status}`).sort(),
      direct.repos.map((s) => `${s.repo}:${s.status}`).sort());

    const single = recall(W.dir, "auro", "alpha", "falcon");
    assert.equal(single.repo, "auro/alpha");
    assert.ok(!("crossRepo" in single), "single-repo envelope has no crossRepo marker");
    for (const x of single.results) {
      assert.ok(!("repo" in x), "single-repo hits carry no repo tag");
      assert.ok(!("repoScore" in x), "single-repo hits carry no repoScore");
    }
  });

  it("KILN_MEMORY_CROSSREPO=off fails loudly; single-repo recall is unaffected", () => {
    withEnv({ KILN_MEMORY_CROSSREPO: "off" }, () => {
      assert.throws(() => recallCrossRepo(W.dir, "falcon"), /cross-repo recall is disabled/);
      assert.throws(() => recall(W.dir, "*", "*", "falcon"), /cross-repo recall is disabled/);
      const single = recall(W.dir, "auro", "alpha", "falcon");
      assert.ok(single.results.length >= 1, "single-repo recall still serves");
    });
  });

  it("an empty state dir returns an honest empty envelope", () => {
    const dir = makeStateDir();
    const r = recallCrossRepo(dir, "anything");
    assert.equal(r.crossRepo, true);
    assert.deepEqual(r.results, []);
    assert.deepEqual(r.repos, []);
    assert.deepEqual(r.excluded, []);
  });
});

describe("memory cross-repo: CLI surface", () => {
  let W;
  before(() => { W = seedWorld(); });
  const run = (args) => spawnSync(process.execPath, [SWARM, ...args], { encoding: "utf8" });

  it("recall-all prints repo-tagged hits and reports the exclusion on stderr", () => {
    const r = run(["memory", "recall-all", "--q", "falcon", "--dir", W.dir]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /auro\/alpha/);
    assert.match(r.stdout, /ops\/gamma/);
    assert.match(r.stderr, /EXCLUDED auro\/forged/);
    assert.match(r.stderr, /signature verification failed/);
  });

  it("recall --repo '*' selects the same mode; --json emits the envelope", () => {
    const r = run(["memory", "recall", "--repo", "*", "--q", "falcon", "--json", "--dir", W.dir]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.crossRepo, true);
    assert.equal(out.excluded[0].repo, "auro/forged");
    assert.ok(out.results.some((x) => x.repo === "auro/alpha"));
  });
});

describe("memory cross-repo: HTTP API + client SDK (real daemon)", () => {
  let dir, daemon, client;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  it("boots a daemon and serves cross-repo recall through the SDK", async () => {
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
    await client.createRepo({ owner: "auro", repo: "xone" });
    await client.createRepo({ owner: "auro", repo: "xtwo" });
    await client.memoryRemember("auro", "xone", {
      title: "One", content: "the falcon nests on the north cliff", actor: "api-test",
    });
    await client.memoryRemember("auro", "xtwo", {
      title: "Two", content: "falcon telemetry arrives every minute", actor: "api-test",
    });

    const r = await client.memoryRecallAll("falcon");
    assert.equal(r.crossRepo, true);
    const reposHit = new Set(r.results.map((x) => x.repo));
    assert.ok(reposHit.has("auro/xone") && reposHit.has("auro/xtwo"), "both repos contribute");
    for (const x of r.results) {
      assert.ok(x.signing && Array.isArray(x.signing.signers), "provenance over the wire");
    }
    assert.deepEqual(r.excluded, []);

    // Unauthenticated cross-repo recall is refused.
    const dj = JSON.parse(readFileSync(join(dir, "daemon.json"), "utf8"));
    const res = await fetch(`${dj.apiUrl}/memory/recall?q=falcon`);
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
