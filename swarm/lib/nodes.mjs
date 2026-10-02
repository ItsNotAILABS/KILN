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

function gitSync(workdir, args) {
  const r = spawnSync("git", args, { cwd: workdir, encoding: "utf8", timeout: 30000 });
  return {
    ok: r.status === 0,
    out: String(r.stdout || "").trim(),
    err: String(r.stderr || "").trim(),
  };
}

/**
 * Ensure the cloned workdir actually has a checked-out tree.
 *
 * `git clone` exits 0 even when it checks out nothing — e.g. the remote's
 * HEAD points at a branch that doesn't exist ("warning: remote HEAD refers
 * to nonexistent ref, unable to checkout"), leaving a workdir containing
 * only `.git`. Booting an app into that tree crash-loops with
 * MODULE_NOT_FOUND (first-deploy ticket, 2026-09-27: auro/launchpad's HEAD
 * said `main`, the repo only had `master`).
 *
 * When HEAD is unborn we check out the remote's default branch explicitly
 * (origin/HEAD, else origin/master, else origin/main). If nothing resolves,
 * the deploy fails LOUDLY here instead of producing a crash-looping node.
 */
export function ensureCheckout(workdir) {
  if (gitSync(workdir, ["rev-parse", "--verify", "HEAD"]).ok) return { ok: true };
  // Empty remote (no refs at all): nothing to check out. Cloning an empty
  // repo to push the first commit is legitimate — not a broken deploy —
  // so this is OK, not a failure.
  const refs = gitSync(workdir, ["for-each-ref", "--format=%(refname)", "refs/remotes/origin/"]);
  if (refs.ok && !refs.out) return { ok: true, empty: true };
  const candidates = [];
  const sym = gitSync(workdir, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (sym.ok && sym.out.startsWith("refs/remotes/origin/")) {
    candidates.push(sym.out.slice("refs/remotes/origin/".length));
  }
  for (const b of ["master", "main"]) {
    if (!candidates.includes(b)) candidates.push(b);
  }
  for (const b of candidates) {
    if (gitSync(workdir, ["checkout", "-f", b]).ok &&
        gitSync(workdir, ["rev-parse", "--verify", "HEAD"]).ok) {
      return { ok: true, branch: b, repaired: true };
    }
  }
  return { ok: false };
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
      // A clone can exit 0 with no working tree (remote HEAD -> missing
      // branch). Gate node creation on a real checkout — a deploy must
      // fail loudly here, never become a crash-looping app node.
      const co = ensureCheckout(workdir);
      if (!co.ok) {
        throw new Error(
          `nodes: git clone of ${repo} produced no checkout (remote HEAD points at a missing branch?)`);
      }
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
