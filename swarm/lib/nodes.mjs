/**
 * Node factory: creates a persistent node identity + working dir.
 * A node is a directory with a keypair, a grant, and a jailed work dir
 * (a real git clone when `repo` is given).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { newKeypair } from "./keys.mjs";
import { nowSec } from "./grant.mjs";
import {
  nodeDir, saveNode, writeKeyFile, touchHeartbeat,
} from "./state.mjs";

export function createNode(dir, opts) {
  const {
    name,
    caps,
    expiresAt,
    parent = null,
    repo = null,
    mind = "script",
    restartPolicy = "on-failure",
    maxRestarts = 3,
    autostart = true,
  } = opts;
  if (!name) throw new Error("nodes: name is required");
  if (!Number.isInteger(caps)) throw new Error("nodes: caps must be an integer bitmask");
  if (!Number.isInteger(expiresAt) || expiresAt <= nowSec()) {
    throw new Error("nodes: expiresAt must be a future unix timestamp");
  }

  const kp = newKeypair();
  const id = kp.id;
  const ndir = nodeDir(dir, id);
  mkdirSync(join(ndir, "work"), { recursive: true });

  const workdir = join(ndir, "work");
  if (repo) {
    const r = spawnSync("git", ["clone", repo, workdir], { encoding: "utf8", timeout: 120000 });
    if (r.status !== 0) {
      throw new Error(`nodes: git clone failed: ${(r.stderr || r.stdout || "").trim().slice(0, 500)}`);
    }
    // Real commits need an identity; attribute them to the node.
    spawnSync("git", ["config", "user.email", `${id.slice(0, 16)}@kiln.local`], { cwd: workdir });
    spawnSync("git", ["config", "user.name", `kiln-node/${name}`], { cwd: workdir });
  }

  const record = {
    id,
    name,
    pubSpkiB64: kp.pubSpkiB64,
    grant: { capabilities: caps >>> 0, expiresAt, parent },
    repo: repo || null,
    mind,
    workdir,
    createdAt: nowSec(),
    autostart,
    restartPolicy, // never | on-failure | always
    maxRestarts,
    restarts: 0,
    workerPid: null,
    lastExit: null,
  };
  saveNode(dir, record);
  writeKeyFile(dir, id, { privPkcs8B64: kp.privPkcs8B64, pubSpkiB64: kp.pubSpkiB64 });
  touchHeartbeat(dir, id);
  return record;
}
