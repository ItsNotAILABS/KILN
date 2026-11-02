/**
 * Branch protection — per-branch merge rules enforced in mergePull,
 * the forge's single merge door. Lib-level against a real state dir
 * and real git repos (mirrors the forge HTTP suite's fixtures, minus
 * the server). The contract under test:
 *   - an unruled branch behaves exactly as the forge always has;
 *   - requiredApprovals counts distinct non-author approvers whose
 *     LATEST review is "approved";
 *   - requireCiPass demands a recorded "pass" verdict for the head
 *     commit (missing and non-pass verdicts block, named);
 *   - the operator override holds unless the rule forbids it — and
 *     when it forbids it, the operator is bound like everyone,
 *     including by a standing changes_requested.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeStateDir } from "./helpers.mjs";
import { createRepo, repoPath } from "../lib/git.mjs";
import { writeResult } from "../lib/ci.mjs";
import {
  ForgeError, writeFile, createBranch, listBranches, createPull, reviewPull, mergePull,
  setBranchProtection, getBranchProtection, listBranchProtection, deleteBranchProtection,
} from "../lib/forge.mjs";

const OP = { kind: "operator", label: "operator", name: "KILN Operator", email: "operator@kiln.local", owner: null };
const ALICE = { kind: "session", label: "account:alice", name: "Alice", email: "alice@kiln.local", owner: "alice" };
const BOB = { kind: "session", label: "account:bob", name: "Bob", email: "bob@kiln.local", owner: "bob" };
const CAROL = { kind: "agent", label: "agent:carol/bot", name: "bot", email: "carol@kiln.local", owner: "carol" };

let seq = 0;
/** Fresh repo with main + feature and an open PR (authored by Alice). */
function makePr(dir) {
  const repo = `prot${++seq}`;
  createRepo(dir, "auro", repo);
  const gd = repoPath(dir, "auro", repo);
  writeFile(dir, "auro", repo, OP, { path: "README.md", content: "# t\n", message: "seed" });
  createBranch(gd, "feature", "main");
  writeFile(dir, "auro", repo, ALICE, { path: "src.js", content: "export const x = 1;\n", message: "feature work", branch: "feature" });
  const pull = createPull(dir, "auro", repo, ALICE, { title: "feature", head: "feature", base: "main" });
  const headSha = listBranches(gd).find((b) => b.name === "feature").sha;
  return { repo, pull, headSha };
}

function blocked(fn, pattern) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ForgeError, `expected ForgeError, got ${e}`);
    assert.equal(e.status, 409, e.message);
    if (pattern) assert.match(e.message, pattern);
    return;
  }
  assert.fail("expected the merge to be blocked (409)");
}

describe("forge: branch protection", () => {
  it("unruled branch: historic behavior — non-operator merges with no reviews", () => {
    const dir = makeStateDir();
    const { repo, pull } = makePr(dir);
    const r = mergePull(dir, "auro", repo, BOB, pull.number, {});
    assert.equal(r.pull.state, "merged");
  });

  it("requiredApprovals: blocks, author approval does not count, reviewer approval unblocks", () => {
    const dir = makeStateDir();
    const { repo, pull } = makePr(dir);
    setBranchProtection(dir, "auro", repo, OP, "main", { requiredApprovals: 1 });
    blocked(() => mergePull(dir, "auro", repo, BOB, pull.number, {}), /approving review/);
    reviewPull(dir, "auro", repo, ALICE, pull.number, { state: "approved" }); // the author — must not count
    blocked(() => mergePull(dir, "auro", repo, BOB, pull.number, {}), /approving review/);
    reviewPull(dir, "auro", repo, CAROL, pull.number, { state: "approved" });
    const r = mergePull(dir, "auro", repo, BOB, pull.number, {});
    assert.equal(r.pull.state, "merged");
  });

  it("latest review wins: approval superseded by changes_requested does not count", () => {
    const dir = makeStateDir();
    const { repo, pull } = makePr(dir);
    setBranchProtection(dir, "auro", repo, OP, "main", { requiredApprovals: 1 });
    reviewPull(dir, "auro", repo, CAROL, pull.number, { state: "approved" });
    reviewPull(dir, "auro", repo, CAROL, pull.number, { state: "changes_requested" });
    blocked(() => mergePull(dir, "auro", repo, BOB, pull.number, {}));
  });

  it("operator override holds by default on a ruled branch", () => {
    const dir = makeStateDir();
    const { repo, pull } = makePr(dir);
    setBranchProtection(dir, "auro", repo, OP, "main", { requiredApprovals: 2 });
    const r = mergePull(dir, "auro", repo, OP, pull.number, {});
    assert.equal(r.pull.state, "merged");
  });

  it("allowOperatorOverride=false binds the operator too", () => {
    const dir = makeStateDir();
    const { repo, pull } = makePr(dir);
    setBranchProtection(dir, "auro", repo, OP, "main", { requiredApprovals: 1, allowOperatorOverride: false });
    blocked(() => mergePull(dir, "auro", repo, OP, pull.number, {}), /approving review/);
    reviewPull(dir, "auro", repo, CAROL, pull.number, { state: "approved" });
    const r = mergePull(dir, "auro", repo, OP, pull.number, {});
    assert.equal(r.pull.state, "merged");
  });

  it("bound actors are blocked by a standing changes_requested", () => {
    const dir = makeStateDir();
    const { repo, pull } = makePr(dir);
    setBranchProtection(dir, "auro", repo, OP, "main", { allowOperatorOverride: false });
    reviewPull(dir, "auro", repo, CAROL, pull.number, { state: "changes_requested" });
    blocked(() => mergePull(dir, "auro", repo, OP, pull.number, {}), /changes requested/);
  });

  it("requireCiPass: no verdict blocks, a fail verdict blocks, a pass verdict unblocks", () => {
    const dir = makeStateDir();
    const { repo, pull, headSha } = makePr(dir);
    setBranchProtection(dir, "auro", repo, OP, "main", { requireCiPass: true, allowOperatorOverride: false });
    blocked(() => mergePull(dir, "auro", repo, OP, pull.number, {}), /no verdict recorded/);
    writeResult(dir, { owner: "auro", repo, ref: "refs/heads/feature", sha: headSha }, { status: "fail" });
    blocked(() => mergePull(dir, "auro", repo, OP, pull.number, {}), /"fail"/);
    writeResult(dir, { owner: "auro", repo, ref: "refs/heads/feature", sha: headSha }, { status: "pass" });
    const r = mergePull(dir, "auro", repo, OP, pull.number, {});
    assert.equal(r.pull.state, "merged");
  });

  it("rules are per-branch: protecting main does not gate a PR into dev", () => {
    const dir = makeStateDir();
    const { repo } = makePr(dir);
    const gd = repoPath(dir, "auro", repo);
    createBranch(gd, "dev", "main");
    createBranch(gd, "feature2", "main");
    writeFile(dir, "auro", repo, ALICE, { path: "b.js", content: "2\n", message: "f2", branch: "feature2" });
    const pull2 = createPull(dir, "auro", repo, ALICE, { title: "into dev", head: "feature2", base: "dev" });
    setBranchProtection(dir, "auro", repo, OP, "main", { requiredApprovals: 3 });
    const r = mergePull(dir, "auro", repo, BOB, pull2.number, {});
    assert.equal(r.pull.state, "merged");
  });

  it("rule CRUD + validation is loud", () => {
    const dir = makeStateDir();
    const { repo } = makePr(dir);
    assert.equal(getBranchProtection(dir, "auro", repo, "main"), null);
    const rule = setBranchProtection(dir, "auro", repo, OP, "main", { requiredApprovals: 1 });
    assert.equal(rule.requiredApprovals, 1);
    assert.equal(rule.allowOperatorOverride, true);
    assert.equal(listBranchProtection(dir, "auro", repo).main.requiredApprovals, 1);
    // patch semantics: touching one key keeps the others
    const patched = setBranchProtection(dir, "auro", repo, OP, "main", { requireCiPass: true });
    assert.equal(patched.requiredApprovals, 1);
    assert.equal(patched.requireCiPass, true);
    assert.throws(() => setBranchProtection(dir, "auro", repo, OP, "main", { bogus: 1 }), (e) => e.status === 400);
    assert.throws(() => setBranchProtection(dir, "auro", repo, OP, "main", { requiredApprovals: -1 }), (e) => e.status === 400);
    assert.throws(() => setBranchProtection(dir, "auro", repo, OP, "main", { requireCiPass: "yes" }), (e) => e.status === 400);
    assert.deepEqual(deleteBranchProtection(dir, "auro", repo, OP, "main"), { branch: "main", deleted: true });
    assert.equal(getBranchProtection(dir, "auro", repo, "main"), null);
    assert.throws(() => deleteBranchProtection(dir, "auro", repo, OP, "main"), (e) => e.status === 404);
  });
});
