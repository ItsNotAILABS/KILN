/**
 * KILN-native GitHub promotion (lib/promote.mjs): the network-free core.
 *
 * Builds a real bare repo + working clone in a temp dir, seeds it with
 * tools/promote.conf and several commits (add / modify / delete), then
 * proves: conf parsing, source-branch resolution, diff-entry extraction,
 * target resolution order (flags > conf), and the honest no-credential
 * receipt with the full plan attached. The GitHub write path itself needs
 * a real token and is exercised operationally, never mocked here — the
 * swarm rule is real-or-loud, and a mocked GitHub would be neither.
 *
 * Phase 5 adds the network-free memory core on the same terms: a real
 * memory chain written through lib/memory.mjs (small episode, fact,
 * blob-backed episode), listed and replay-planned locally, plus the
 * node-clone gating that fetches refs/kiln/memory only when it exists.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeStateDir } from "./helpers.mjs";
import { createRepo, repoPath } from "../lib/git.mjs";
import {
  parsePromoteConf, loadGithubToken, resolveSourceBranch, diffEntries, promoteRepo,
  listMemoryCommits, planMemoryReplay,
} from "../lib/promote.mjs";
import { remember, assertFact } from "../lib/memory.mjs";
import { gitClone } from "../lib/nodes.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const dir = makeStateDir();
let bare;
let headSha;
let rootSha;
let memBare;
let memCommits;
let memEvents;

before(() => {
  const savedToken = process.env.KILN_GITHUB_TOKEN;
  delete process.env.KILN_GITHUB_TOKEN;
  assert.equal(loadGithubToken(dir), null, "temp state dir must have no GitHub credential");
  if (savedToken !== undefined) process.env.KILN_GITHUB_TOKEN = savedToken;

  createRepo(dir, "auro", "promo-test");
  bare = repoPath(dir, "auro", "promo-test");
  const work = mkdtempSync(join(tmpdir(), "kiln-promo-work-"));
  git(work, ["clone", "-q", bare, "."]);
  git(work, ["config", "user.email", "test@kiln.local"]);
  git(work, ["config", "user.name", "kiln-test"]);

  // commit 1 (root): conf + a file
  mkdirSync(join(work, "tools"));
  writeFileSync(join(work, "tools", "promote.conf"),
    "# dest\nowner=ExampleOwner\nrepo=example-repo\nbranch=main\n");
  writeFileSync(join(work, "a.txt"), "alpha\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", "root commit"]);
  rootSha = git(work, ["rev-parse", "HEAD"]);

  // commit 2: modify a.txt, add b.txt
  writeFileSync(join(work, "a.txt"), "alpha v2\n");
  writeFileSync(join(work, "b.txt"), "bravo\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", "second commit"]);

  // commit 3: delete b.txt
  rmSync(join(work, "b.txt"));
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", "third commit"]);
  headSha = git(work, ["rev-parse", "HEAD"]);

  git(work, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
});

describe("parsePromoteConf", () => {
  it("parses key=value, skips comments and blanks", () => {
    const conf = parsePromoteConf("# hi\nowner=Foo\nrepo=bar\n\nbranch=dev\n");
    assert.deepEqual(conf, { owner: "Foo", repo: "bar", branch: "dev" });
  });
  it("tolerates empty input", () => {
    assert.deepEqual(parsePromoteConf(""), {});
    assert.deepEqual(parsePromoteConf(null), {});
  });
});

describe("git plumbing over the seeded bare repo", () => {
  it("resolves the source branch", async () => {
    assert.equal(await resolveSourceBranch(bare), "main");
  });
  it("extracts root-commit entries against the empty tree", async () => {
    const entries = await diffEntries(bare, "4b825dc642cb6eb9a060e54bf8d69288fbee4904", rootSha);
    const paths = entries.map((e) => e.path).sort();
    assert.deepEqual(paths, ["a.txt", "tools/promote.conf"]);
    assert.ok(entries.every((e) => e.type === "blob" && e.localSha));
  });
  it("extracts modify + add, then a deletion with null sha", async () => {
    const list = execFileSync("git", ["--git-dir", bare, "rev-list", "--reverse", "HEAD"], { encoding: "utf8" })
      .trim().split("\n");
    assert.equal(list.length, 3);
    const e2 = await diffEntries(bare, list[0], list[1]);
    assert.deepEqual(e2.map((e) => e.path).sort(), ["a.txt", "b.txt"]);
    const e3 = await diffEntries(bare, list[1], list[2]);
    assert.equal(e3.length, 1);
    assert.equal(e3[0].path, "b.txt");
    assert.equal(e3[0].localSha, null);
  });
});

describe("promoteRepo without a credential", () => {
  it("returns the full plan and the precise blocker, never throws", async () => {
    const savedToken = process.env.KILN_GITHUB_TOKEN;
    delete process.env.KILN_GITHUB_TOKEN;
    try {
      const r = await promoteRepo(dir, "auro", "promo-test", {});
      assert.equal(r.ok, false);
      assert.equal(r.error.stage, "no_github_credential");
      assert.equal(r.github, "ExampleOwner/example-repo"); // from tools/promote.conf
      assert.equal(r.branch, "main");
      assert.equal(r.sourceBranch, "main");
      assert.equal(r.sourceTip, headSha);
      assert.equal(r.commitsTotal, 3);
      assert.equal(r.commitsPlanned, 3);
    } finally {
      if (savedToken !== undefined) process.env.KILN_GITHUB_TOKEN = savedToken;
    }
  });
  it("explicit flags beat the conf", async () => {
    const savedToken = process.env.KILN_GITHUB_TOKEN;
    delete process.env.KILN_GITHUB_TOKEN;
    try {
      const r = await promoteRepo(dir, "auro", "promo-test", { githubOwner: "Other", githubRepo: "elsewhere", branch: "dev" });
      assert.equal(r.github, "Other/elsewhere");
      assert.equal(r.branch, "dev");
    } finally {
      if (savedToken !== undefined) process.env.KILN_GITHUB_TOKEN = savedToken;
    }
  });
  it("unknown KILN repo is a clean receipt, not a crash", async () => {
    const r = await promoteRepo(dir, "auro", "no-such-repo", {});
    assert.equal(r.ok, false);
    assert.equal(r.error.stage, "repo_not_found");
  });
});

describe("memory chain core (phase 5)", () => {
  before(async () => {
    createRepo(dir, "auro", "promo-memory");
    memBare = repoPath(dir, "auro", "promo-memory");
    const r1 = remember(dir, "auro", "promo-memory", {
      actor: "promo-test", content: "a small episode worth keeping",
    });
    const rf = assertFact(dir, "auro", "promo-memory", {
      actor: "promo-test",
      subject: "promo-memory", predicate: "runs on", object: "port 8904",
      sourceEpisodes: [r1.event.id],
    });
    // 8000 chars > INLINE_MAX (4096): content goes to a git blob.
    const r3 = remember(dir, "auro", "promo-memory", {
      actor: "promo-test", content: "big ".repeat(2000),
    });
    memEvents = [r1.event, rf.event, r3.event];
    memCommits = await listMemoryCommits(memBare);
  });

  it("lists the chain oldest -> newest with ids, types, parents, author", () => {
    assert.equal(memCommits.length, 3);
    assert.deepEqual(memCommits.map((c) => c.id), memEvents.map((e) => e.id));
    assert.deepEqual(memCommits.map((c) => c.type), ["episode", "fact", "episode"]);
    assert.equal(memCommits[0].parent, null);
    assert.equal(memCommits[1].parent, memCommits[0].sha);
    assert.equal(memCommits[2].parent, memCommits[1].sha);
    for (const c of memCommits) {
      // lib/memory.mjs actorEnv: author name is the actor verbatim,
      // email is the fixed memory@kiln.local.
      assert.equal(c.author.name, "promo-test");
      assert.equal(c.author.email, "memory@kiln.local");
      assert.ok(c.message.startsWith(`memory: ${c.type} ${c.id}`), c.message);
      assert.ok(c.sha.length === 40);
    }
  });

  it("surfaces the content blob oid for the large episode only", () => {
    assert.equal(memCommits[0].contentBlobOid, null);
    assert.equal(memCommits[1].contentBlobOid, null);
    const oid = memCommits[2].contentBlobOid;
    assert.match(oid, /^[0-9a-f]{40}$/);
    assert.equal(oid, memEvents[2].contentBlob.oid);
    const t = execFileSync("git", ["--git-dir", memBare, "cat-file", "-t", oid], { encoding: "utf8" }).trim();
    assert.equal(t, "blob");
  });

  it("returns [] for a repo with no memory ref", async () => {
    assert.deepEqual(await listMemoryCommits(bare), []);
  });

  it("plans create / incremental / up-to-date from remote id prefixes", () => {
    const ids = memCommits.map((c) => c.id);
    const create = planMemoryReplay(memCommits, null);
    assert.equal(create.mode, "create");
    assert.equal(create.commits.length, 3);
    const inc = planMemoryReplay(memCommits, [ids[0]]);
    assert.equal(inc.mode, "incremental");
    assert.deepEqual(inc.commits.map((c) => c.id), [ids[1], ids[2]]);
    const current = planMemoryReplay(memCommits, ids);
    assert.equal(current.mode, "up-to-date");
    assert.deepEqual(current.commits, []);
  });

  it("plans diverged for anything that is not a clean prefix", () => {
    const ids = memCommits.map((c) => c.id);
    for (const remote of [["mem_bogus"], [...ids, "mem_extra"], [ids[0], "mem_bogus"], []]) {
      const plan = planMemoryReplay(memCommits, remote);
      assert.equal(plan.mode, "diverged", JSON.stringify(remote));
      assert.deepEqual(plan.commits, []);
    }
  });
});

describe("node clone memory gating (phase 5)", () => {
  const status = (cwd, args) => spawnSync("git", args, { cwd, encoding: "utf8" }).status;

  it("clone of a memory-ful repo carries refs/kiln/memory; plain fetch stays healthy", async () => {
    const dest = join(mkdtempSync(join(tmpdir(), "kiln-clone-mem-")), "clone");
    await gitClone(memBare, dest, 30000);
    const tip = execFileSync("git", ["rev-parse", "--verify", "refs/kiln/memory"],
      { cwd: dest, encoding: "utf8" }).trim();
    assert.equal(tip, memCommits[2].sha);
    // The persisted refspec is what makes this plain fetch safe.
    const cfg = execFileSync("git", ["config", "--get-all", "remote.origin.fetch"],
      { cwd: dest, encoding: "utf8" });
    assert.ok(cfg.includes("+refs/kiln/memory:refs/kiln/memory"));
    assert.equal(status(dest, ["fetch", "origin"]), 0);
  });

  it("clone of a memory-less repo gains no memory ref and fetch exits 0", async () => {
    const dest = join(mkdtempSync(join(tmpdir(), "kiln-clone-plain-")), "clone");
    await gitClone(bare, dest, 30000);
    assert.notEqual(status(dest, ["rev-parse", "--verify", "refs/kiln/memory"]), 0);
    const cfg = execFileSync("git", ["config", "--get-all", "remote.origin.fetch"],
      { cwd: dest, encoding: "utf8" });
    assert.ok(!cfg.includes("refs/kiln/memory"));
    // The 128 trap: an exact refspec for an absent ref would fail here.
    assert.equal(status(dest, ["fetch", "origin"]), 0);
  });
});
