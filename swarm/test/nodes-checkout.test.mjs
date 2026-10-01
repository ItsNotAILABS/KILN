/**
 * Deploy-race regression tests (first-deploy ticket, 2026-09-27).
 *
 * `git clone` exits 0 with NO working tree when the remote's HEAD points at
 * a branch that doesn't exist (auro/launchpad: HEAD said `main`, the repo
 * only had `master`) — the worker then booted `node server.mjs` into a
 * directory containing only `.git` and crash-looped with MODULE_NOT_FOUND.
 *
 * ensureCheckout() (swarm/lib/nodes.mjs) gates node creation on a real
 * checkout and self-heals the unborn-HEAD case; createNode() refuses the
 * deploy loudly when nothing resolves.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const { ensureCheckout } = await import("../lib/nodes.mjs");

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function freshDir() {
  return mkdtempSync(join(tmpdir(), "kiln-checkout-test-"));
}

/** A bare origin whose HEAD points at a branch that does not exist. */
function makeBrokenHeadOrigin() {
  const dir = freshDir();
  const origin = join(dir, "origin.git");
  const src = join(dir, "src");
  mkdirSync(src, { recursive: true });
  git(dir, ["init", "--bare", "origin.git"]);
  git(src, ["init", "-b", "master"]);
  git(src, ["config", "user.email", "t@kiln.local"]);
  git(src, ["config", "user.name", "t"]);
  execFileSync("sh", ["-c", "echo hi > f.txt"], { cwd: src });
  git(src, ["add", "."]);
  git(src, ["commit", "-m", "init"]);
  git(src, ["remote", "add", "origin", origin]);
  git(src, ["push", "origin", "master"]);
  // Break HEAD: point it at `main`, which was never pushed.
  git(dir, ["--git-dir=origin.git", "symbolic-ref", "HEAD", "refs/heads/main"]);
  return origin;
}

describe("ensureCheckout (deploy-race gate)", () => {
  it("heals an unborn HEAD by checking out the remote's real default branch", () => {
    const dir = freshDir();
    const origin = makeBrokenHeadOrigin();
    const cloneDir = join(dir, "work");
    let out;
    try {
      out = execFileSync("git", ["clone", origin, cloneDir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      out = e.stdout || "";
    }
    void out;
    // The clone "succeeds" (exit 0) but checks out nothing — the bug.
    assert.throws(() => git(cloneDir, ["rev-parse", "--verify", "HEAD"]),
      "precondition: clone left HEAD unborn");

    const co = ensureCheckout(cloneDir);
    assert.equal(co.ok, true);
    assert.equal(co.repaired, true);
    assert.equal(co.branch, "master");
    const head = git(cloneDir, ["rev-parse", "--verify", "HEAD"]).trim();
    assert.match(head, /^[0-9a-f]{40}$/);
    assert.equal(
      execFileSync("sh", ["-c", "cat f.txt"], { cwd: cloneDir, encoding: "utf8" }).trim(),
      "hi",
      "working tree actually checked out",
    );
  });

  it("is a fast no-op on a healthy clone", () => {
    const dir = freshDir();
    const origin = makeBrokenHeadOrigin();
    // Fix HEAD first so the clone is healthy.
    execFileSync("git", ["--git-dir=" + origin, "symbolic-ref", "HEAD", "refs/heads/master"]);
    const cloneDir = join(dir, "work");
    execFileSync("git", ["clone", origin, cloneDir], { stdio: ["ignore", "pipe", "pipe"] });
    const co = ensureCheckout(cloneDir);
    assert.equal(co.ok, true);
    assert.equal(co.repaired, undefined);
  });

  it("fails loudly when the remote has branches but none are check-out-able", () => {
    const dir = freshDir();
    const origin = join(dir, "origin.git");
    const src = join(dir, "src");
    mkdirSync(src, { recursive: true });
    execFileSync("git", ["init", "--bare", "origin.git"], { cwd: dir });
    execFileSync("git", ["init", "-b", "weird-branch"], { cwd: src });
    execFileSync("git", ["config", "user.email", "t@kiln.local"], { cwd: src });
    execFileSync("git", ["config", "user.name", "t"], { cwd: src });
    execFileSync("sh", ["-c", "echo hi > f.txt"], { cwd: src });
    execFileSync("git", ["add", "."], { cwd: src });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: src });
    execFileSync("git", ["remote", "add", "origin", origin], { cwd: src });
    execFileSync("git", ["push", "-q", "origin", "weird-branch"], { cwd: src });
    // HEAD points at `main` (missing); only `weird-branch` exists remotely.
    // master/main don't exist either, so nothing resolves.
    execFileSync("git", ["--git-dir=" + origin, "symbolic-ref", "HEAD", "refs/heads/main"]);
    const cloneDir = join(dir, "work");
    try {
      execFileSync("git", ["clone", origin, cloneDir], { stdio: ["ignore", "pipe", "pipe"] });
    } catch { /* clone warns but continues */ }
    const co = ensureCheckout(cloneDir);
    assert.equal(co.ok, false, "no resolvable branch — deploy must fail loudly");
  });

  it("treats a truly empty remote (no refs) as OK — first push is legitimate", () => {
    const dir = freshDir();
    const origin = join(dir, "empty.git");
    execFileSync("git", ["init", "--bare", "empty.git"], { cwd: dir });
    const cloneDir = join(dir, "work");
    execFileSync("git", ["clone", origin, cloneDir], { stdio: ["ignore", "pipe", "pipe"] });
    const co = ensureCheckout(cloneDir);
    assert.equal(co.ok, true, "empty remote: nothing to check out, not a broken deploy");
    assert.equal(co.empty, true);
  });
});
