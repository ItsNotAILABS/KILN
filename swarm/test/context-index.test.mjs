import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildContextIndex, loadIndex, queryContextIndex } from "../lib/context-index.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kiln-index-"));
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  execFileSync("git", ["-C", root, "config", "user.name", "KILN Test"]);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "policy.js"), [
    "export function mayPromote(actor, target) {",
    "  return actor.approved && target.organization === 'ItsNotAILABS';",
    "}",
    "export const githubPushRequiresApproval = true;",
  ].join("\n"));
  writeFileSync(join(root, "src", "math.js"), "export const add = (a,b) => a+b;\n");
  writeFileSync(join(root, ".env"), "SUPER_SECRET=do-not-index\n");
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
  return root;
}

test("persistent index filters secret paths and retrieves relevant code", () => {
  const root = fixture();
  const state = mkdtempSync(join(tmpdir(), "kiln-index-state-"));
  try {
    const index = buildContextIndex(root, state);
    assert.equal(index.schema, "kiln.context-index.v1");
    assert.equal(index.files.some((x) => x.path === ".env"), false);
    assert.equal(index.skipped.some((x) => x.path === ".env" && x.reason === "secret-path-policy"), true);
    assert.equal(index.files.some((x) => x.path === "src/policy.js"), true);
    const pack = queryContextIndex(index, "github promotion approval", { maxBytes: 4096, maxChunks: 4 });
    assert.equal(pack.schema, "kiln.context-pack.v2");
    assert.equal(pack.items[0].path, "src/policy.js");
    assert.match(pack.items[0].excerpt, /githubPushRequiresApproval|mayPromote/);
    assert.ok(pack.stats.emittedBytes <= 4096);
    assert.equal(pack.items[0].sha256.length, 64);
    assert.equal(pack.digest.length, 64);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test("unchanged files are reused and delta query suppresses known file payload", () => {
  const root = fixture();
  const state = mkdtempSync(join(tmpdir(), "kiln-index-state-"));
  try {
    const first = buildContextIndex(root, state);
    const second = buildContextIndex(root, state);
    assert.ok(second.stats.reusedFiles >= 2);
    const initial = queryContextIndex(first, "github approval", { maxBytes: 4096 });
    const knownHashes = Object.fromEntries(initial.items.map((x) => [x.path, x.sha256]));
    const delta = queryContextIndex(second, "github approval", { maxBytes: 4096, knownHashes });
    assert.equal(delta.items.length, 0);
    assert.ok(delta.unchanged.length >= 1);

    writeFileSync(join(root, "src", "policy.js"), readFileSync(join(root, "src", "policy.js"), "utf8") + "\nexport const gateVersion = 2;\n");
    const third = buildContextIndex(root, state);
    assert.ok(third.stats.rebuiltFiles >= 1);
    assert.notEqual(third.worktreeDigest, second.worktreeDigest);
    const changed = queryContextIndex(third, "github approval gateVersion", { maxBytes: 4096, knownHashes });
    assert.ok(changed.items.some((x) => x.path === "src/policy.js"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test("pack is byte bounded and index survives reload", () => {
  const root = fixture();
  const state = mkdtempSync(join(tmpdir(), "kiln-index-state-"));
  try {
    const index = buildContextIndex(root, state, { chunkLines: 20, overlap: 4 });
    const loaded = loadIndex(state, root);
    assert.equal(loaded.digest, index.digest);
    const pack = queryContextIndex(loaded, "export function approval github", { maxBytes: 512, maxChunks: 20 });
    assert.ok(pack.stats.emittedBytes <= 512);
    assert.ok(pack.items.length >= 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});
