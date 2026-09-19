/**
 * Node factory: creates a persistent node identity + working dir.
 * A node is a directory with a keypair, a grant, and a jailed work dir
 * (a real git clone when `repo` is given).
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { newKeypair } from "./keys.mjs";
import { nowSec } from "./grant.mjs";
import {
  nodeDir, saveNode, writeKeyFile, touchHeartbeat,
} from "./state.mjs";

/**
 * Async `git clone` with a timeout. MUST be async (never spawnSync): the
 * daemon serves git smart-HTTP itself, so a synchronous clone of a
 * KILN-native URL would block the daemon's own event loop — a guaranteed
 * self-deadlock plus a 120s API freeze for everyone else. Async keeps the
 * loop alive so the clone's own HTTP requests get answered.
 */
function gitClone(repo, workdir, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["clone", repo, workdir], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => reject(new Error(`nodes: git clone failed to start: ${e.message}`)));
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error(`nodes: git clone timed out after ${timeoutMs}ms: ${(err || out).trim().slice(0, 300)}`));
    }, timeoutMs);
    // Don't let the timer hold the event loop open on its own.
    if (timer.unref) timer.unref();
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`nodes: git clone failed: ${(err || out).trim().slice(0, 500) || `signal ${signal}`}`));
      } else resolve();
    });
  });
}

export async function createNode(dir, opts) {
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
    cloneTimeoutMs = 120000,
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
    try {
      await gitClone(repo, workdir, cloneTimeoutMs);
    } catch (e) {
      // Don't leave an orphaned node dir: the tick would spam ENOENT on the
      // missing node.json every 2s (seen in the wild via ticket E2).
      try { rmSync(ndir, { recursive: true, force: true }); } catch {}
      throw e;
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
