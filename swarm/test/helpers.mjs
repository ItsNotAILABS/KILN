/** Shared test helpers: temp state dirs, temp git repos, node contexts. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ensureStateDir } from "../lib/state.mjs";
import { createNode } from "../lib/nodes.mjs";
import { loadKeypair } from "../lib/keys.mjs";
import { loadKeyFile } from "../lib/state.mjs";
import { nowSec } from "../lib/grant.mjs";

export function makeStateDir() {
  const dir = mkdtempSync(join(tmpdir(), "kiln-swarm-test-"));
  ensureStateDir(dir);
  return dir;
}

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || "").slice(0, 300)}`);
  return (r.stdout || "").trim();
}

/** A real temp git repo with one commit. Returns its path. */
export function makeGitRepo() {
  const repo = mkdtempSync(join(tmpdir(), "kiln-repo-test-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@kiln.local"]);
  git(repo, ["config", "user.name", "kiln-test"]);
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "seed commit"]);
  return repo;
}

export function gitLog(repo, n = 5) {
  return git(repo, ["log", "--oneline", "-n", String(n)]);
}

/** Create a real node (keypair, clone) and return a tool ctx for it. */
export async function makeNode(dir, opts = {}) {
  const repo = opts.repo === undefined ? makeGitRepo() : opts.repo;
  const node = await createNode(dir, {
    name: opts.name || "testnode",
    caps: opts.caps ?? 15,
    expiresAt: opts.expiresAt ?? nowSec() + 3600,
    parent: opts.parent || null,
    repo,
    mind: "script",
    autostart: false,
  });
  const keypair = loadKeypair(loadKeyFile(dir, node.id));
  const ctx = {
    dir,
    nodeId: node.id,
    keypair,
    node,
    get grant() { return node.grant; },
    workdir: node.workdir,
  };
  return { node, keypair, ctx };
}
