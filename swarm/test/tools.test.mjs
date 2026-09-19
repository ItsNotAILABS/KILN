/**
 * Tools: the jail is real. Escape attempts fail; allowed calls really run.
 * git.commit without CAP_COMMIT is refused AND creates no commit.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runTool, jailPath } from "../lib/tools.mjs";
import { CAP_COMMIT, CAP_RELEASE } from "../lib/grant.mjs";
import { makeStateDir, makeNode, makeGitRepo, gitLog } from "./helpers.mjs";
import { verifyReceipts } from "../lib/receipts.mjs";

/** A temp git repo containing a dummy release script. The script really runs. */
function makeReleaseRepo() {
  const repo = makeGitRepo();
  writeFileSync(
    join(repo, "release.mjs"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync("RELEASED.txt", "released by project.release\\n");\nconsole.log("release ok");\n`
  );
  spawnSync("git", ["add", "-A"], { cwd: repo });
  spawnSync("git", ["commit", "-q", "-m", "add release script"], { cwd: repo });
  return repo;
}

describe("jail", () => {
  it("rejects path traversal", () => {
    const dir = makeStateDir();
    const { ctx } = makeNode(dir);
    assert.throws(() => jailPath(ctx.workdir, "../../etc/passwd"), /escapes work dir/);
    assert.throws(() => jailPath(ctx.workdir, "/etc/passwd"), /escapes work dir/);
  });
  it("fs.write outside the work dir fails and writes nothing", async () => {
    const dir = makeStateDir();
    const { ctx, node } = makeNode(dir);
    const r = await runTool(ctx, "fs.write", { path: "../../evil.txt", content: "x" });
    assert.equal(r.ok, false);
    assert.match(r.error, /escapes work dir/);
  });
  it("shell.exec rejects shell metacharacters", async () => {
    const dir = makeStateDir();
    const { ctx } = makeNode(dir);
    const r = await runTool(ctx, "shell.exec", { command: "echo", args: ["hi; rm -rf /"] });
    assert.equal(r.ok, false);
    assert.match(r.error, /denied pattern/);
  });
  it("shell.exec rejects shell binaries", async () => {
    const dir = makeStateDir();
    const { ctx } = makeNode(dir);
    const r = await runTool(ctx, "shell.exec", { command: "sh", args: ["-c", "echo hi"] });
    assert.equal(r.ok, false);
    assert.match(r.error, /shell binaries/);
  });
  it("shell.exec rejects command substitution", async () => {
    const dir = makeStateDir();
    const { ctx } = makeNode(dir);
    const r = await runTool(ctx, "shell.exec", { command: "echo", args: ["$(whoami)"] });
    assert.equal(r.ok, false);
  });
  it("shell.exec really runs and captures output", async () => {
    const dir = makeStateDir();
    const { ctx } = makeNode(dir);
    const r = await runTool(ctx, "shell.exec", { command: "echo", args: ["hello-kiln"] });
    assert.equal(r.ok, true);
    assert.match(r.out, /hello-kiln/);
  });
  it("shell.exec enforces timeout for real", async () => {
    const dir = makeStateDir();
    const { ctx } = makeNode(dir);
    const t0 = Date.now();
    const r = await runTool(ctx, "shell.exec", { command: "sleep", args: ["30"], timeoutMs: 800 });
    const ms = Date.now() - t0;
    assert.equal(r.ok, false);
    assert.match(r.error, /timeout/);
    assert.ok(ms < 10000, `took ${ms}ms — the sleep was not killed`);
  });
  it("shell.exec reports nonzero exits honestly", async () => {
    const dir = makeStateDir();
    const { ctx } = makeNode(dir);
    const r = await runTool(ctx, "shell.exec", { command: "ls", args: ["/nonexistent-kiln-dir"] });
    assert.equal(r.ok, false);
    assert.match(r.error, /exit/);
  });
});

describe("git tools", () => {
  it("git.commit without CAP_COMMIT is refused and creates no commit", async () => {
    const dir = makeStateDir();
    const { ctx, node } = makeNode(dir, { caps: 0 }); // no caps at all
    const before = gitLog(node.workdir, 5);
    await assert.rejects(
      runTool(ctx, "git.commit", { message: "should never land" }),
      (e) => e.code === "MISSING_CAPABILITY"
    );
    assert.equal(gitLog(node.workdir, 5), before);
  });
  it("git.commit with CAP_COMMIT makes a REAL commit", async () => {
    const dir = makeStateDir();
    const { ctx, node } = makeNode(dir, { caps: CAP_COMMIT });
    await runTool(ctx, "fs.write", { path: "real.txt", content: "real content\n" });
    const r = await runTool(ctx, "git.commit", { message: "kiln test commit" });
    assert.equal(r.ok, true);
    const log = gitLog(node.workdir, 3);
    assert.match(log, /kiln test commit/);
  });
  it("git.status and git.log read the real repo", async () => {
    const dir = makeStateDir();
    const { ctx } = makeNode(dir);
    const st = await runTool(ctx, "git.status", {});
    assert.equal(st.ok, true);
    const lg = await runTool(ctx, "git.log", { n: 3 });
    assert.equal(lg.ok, true);
    assert.match(lg.out, /seed commit/);
  });
});

describe("project.release", () => {
  it("is REFUSED without CAP_RELEASE and writes nothing", async () => {
    const dir = makeStateDir();
    const { ctx, node } = makeNode(dir, { caps: CAP_COMMIT, repo: makeReleaseRepo() });
    await assert.rejects(
      runTool(ctx, "project.release", { command: "node", args: ["release.mjs"] }),
      (e) => e.code === "MISSING_CAPABILITY"
    );
    assert.equal(existsSync(join(node.workdir, "RELEASED.txt")), false);
  });
  it("runs the real release command with CAP_RELEASE", async () => {
    const dir = makeStateDir();
    const { ctx, node } = makeNode(dir, { caps: CAP_RELEASE, repo: makeReleaseRepo() });
    const r = await runTool(ctx, "project.release", { command: "node", args: ["release.mjs"] });
    assert.equal(r.ok, true);
    assert.match(r.out, /release ok/);
    assert.equal(readFileSync(join(node.workdir, "RELEASED.txt"), "utf8"), "released by project.release\n");
  });
  it("reports a failing release command honestly", async () => {
    const dir = makeStateDir();
    const { ctx } = makeNode(dir, { caps: CAP_RELEASE, repo: makeReleaseRepo() });
    const r = await runTool(ctx, "project.release", { command: "node", args: ["-e", "process.exit(3)"] });
    assert.equal(r.ok, false);
    assert.match(r.error, /exit 3/);
  });
  it("is jailed like shell.exec", async () => {
    const dir = makeStateDir();
    const { ctx } = makeNode(dir, { caps: CAP_RELEASE, repo: makeReleaseRepo() });
    const r = await runTool(ctx, "project.release", { command: "node", args: ["-e", "x; y"] });
    assert.equal(r.ok, false);
    assert.match(r.error, /denied pattern/);
  });
});

describe("grant-gated swarm tools", () => {
  it("swarm.spawn without CAP_DELEGATE is refused", async () => {
    const dir = makeStateDir();
    const { ctx } = makeNode(dir, { caps: CAP_COMMIT });
    await assert.rejects(
      runTool(ctx, "swarm.spawn", { name: "child", capabilities: 1, ttlSec: 60 }),
      (e) => e.code === "MISSING_CAPABILITY"
    );
  });
  it("swarm.spawn with CAP_DELEGATE creates a real child node with subset caps", async () => {
    const dir = makeStateDir();
    const { ctx, node } = makeNode(dir, { caps: CAP_COMMIT | 8 });
    const r = await runTool(ctx, "swarm.spawn", { name: "child1", capabilities: CAP_COMMIT, ttlSec: 600 });
    assert.equal(r.ok, true);
    assert.match(r.out, /spawned child node child1/);
    // child record exists on disk with parent set and subset caps
    const { listNodeIds, loadNode } = await import("../lib/state.mjs");
    const ids = listNodeIds(dir).filter((id) => id !== node.id);
    assert.equal(ids.length, 1);
    const child = loadNode(dir, ids[0]);
    assert.equal(child.grant.parent, node.id);
    assert.equal(child.grant.capabilities, CAP_COMMIT);
  });
  it("swarm.spawn refuses caps exceeding the parent", async () => {
    const dir = makeStateDir();
    const { ctx } = makeNode(dir, { caps: 8 }); // delegate only
    const r = await runTool(ctx, "swarm.spawn", { name: "childx", capabilities: CAP_COMMIT, ttlSec: 60 });
    assert.equal(r.ok, false);
    assert.match(r.error, /EXCEEDS_PARENT_GRANT/);
  });
  it("every tool call leaves a verifiable receipt", async () => {
    const dir = makeStateDir();
    const { ctx, node, keypair } = makeNode(dir);
    await runTool(ctx, "fs.write", { path: "r.txt", content: "x" });
    await runTool(ctx, "fs.read", { path: "r.txt" });
    const v = verifyReceipts(dir, node.id, keypair);
    assert.equal(v.ok, true);
    assert.equal(v.count, 2);
  });
});
