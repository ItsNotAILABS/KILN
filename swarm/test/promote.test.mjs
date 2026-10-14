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
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeStateDir } from "./helpers.mjs";
import { createRepo, repoPath } from "../lib/git.mjs";
import {
  parsePromoteConf, loadGithubToken, resolveSourceBranch, diffEntries, promoteRepo,
} from "../lib/promote.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const dir = makeStateDir();
let bare;
let headSha;
let rootSha;

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
