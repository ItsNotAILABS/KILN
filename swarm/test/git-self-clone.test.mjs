/**
 * E3 regression: spawnNode({ repo }) with a KILN-native URL served by the
 * SAME daemon must not deadlock.
 *
 * Root cause: createNode() used spawnSync("git", ["clone", ...]) with a 120s
 * timeout. That blocked the daemon's entire event loop — so a clone of a repo
 * the daemon itself serves could never complete: the clone's HTTP requests
 * to the daemon queued behind the blocked loop until spawnSync killed git at
 * 120s. Worse, every other API request hung for those 120s too.
 *
 * Fix: the clone is async (spawn + await), so the loop stays alive and the
 * daemon answers its own git smart-HTTP mid-clone.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { SwarmClient } from "../lib/client.mjs";
import { nodeDir } from "../lib/state.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "swarm.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeStateDir() {
  const dir = mkdtempSync(join(tmpdir(), "kiln-swarm-test-"));
  // Ephemeral port: never collide with the live daemon on 18787.
  writeFileSync(join(dir, "config.json"), JSON.stringify({ apiPort: 0 }) + "\n");
  spawnSync(process.execPath, [CLI, "daemon", "start", "--dir", dir], { encoding: "utf8", timeout: 15000 });
  return dir;
}

async function waitForDaemonJson(dir, timeoutMs = 20000) {
  const p = join(dir, "daemon.json");
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (existsSync(p)) {
      try { return JSON.parse(readFileSync(p, "utf8")); } catch { /* mid-write */ }
    }
    await sleep(250);
  }
  throw new Error("daemon.json never appeared — daemon failed to start");
}

function git(cwd, args, extraEnv = {}) {
  const r = spawnSync("git", args, {
    cwd, encoding: "utf8", timeout: 30000,
    env: { ...process.env, ...extraEnv },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || "").slice(0, 300)}`);
  return (r.stdout || "").trim();
}

let daemonPid = null;
after(async () => {
  // Real pid from daemon.json, not the starter child (see deposit.test.mjs).
  if (daemonPid) { try { process.kill(daemonPid, "SIGTERM"); } catch {} daemonPid = null; }
});

describe("E3: node spawn with a self-hosted KILN-native repo", () => {
  it("clones from the same daemon without deadlocking it", async () => {
    const dir = makeStateDir();
    const dj = await waitForDaemonJson(dir);
    daemonPid = dj.pid;
    const client = await SwarmClient.connect({ dir });
    const token = readFileSync(join(dir, "api.token"), "utf8").trim();

    // A real KILN-native repo on THIS daemon, with a real seed commit.
    const created = await client.createRepo({ owner: "auro", repo: "selfclone" });
    const cloneUrl = created.cloneUrl || `${dj.apiUrl}/git/auro/selfclone`;
    const seed = mkdtempSync(join(tmpdir(), "kiln-seed-"));
    git(seed, ["init", "-q"]);
    git(seed, ["config", "user.email", "e3@test.local"]);
    git(seed, ["config", "user.name", "e3"]);
    const fs = await import("node:fs");
    fs.writeFileSync(join(seed, "SEED.md"), "# e3 seed\n");
    git(seed, ["add", "."]);
    git(seed, ["commit", "-qm", "e3 seed commit"]);
    git(seed, ["remote", "add", "origin", cloneUrl]);
    git(seed, ["push", "-q", "origin", "HEAD:refs/heads/main"], {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
    });

    // The daemon must stay responsive DURING the clone. Poll /health in the
    // background; any gap > 10s means the event loop blocked (old behavior:
    // 120s of silence).
    let maxGapMs = 0;
    let lastOk = Date.now();
    let stopPoll = false;
    const poller = (async () => {
      while (!stopPoll) {
        try {
          const res = await fetch(dj.apiUrl + "/health", { signal: AbortSignal.timeout(3000) });
          if (res.ok) {
            const now = Date.now();
            maxGapMs = Math.max(maxGapMs, now - lastOk);
            lastOk = now;
          }
        } catch { /* gap grows; measured below */ }
        await sleep(1000);
      }
    })();

    let nodeId = null;
    try {
      // Old code: this POST blocked 120s (spawnSync) then failed with
      // "git clone failed". New code: returns once the clone lands.
      const t0 = Date.now();
      const spawned = await client.spawnNode({
        name: "e3-self", caps: 1, ttlSec: 600,
        repo: cloneUrl, mind: "script", policy: "never",
      });
      const elapsed = Date.now() - t0;
      nodeId = spawned.id;
      assert.ok(elapsed < 60000, `spawnNode took ${elapsed}ms — clone deadlocked the daemon`);
      assert.ok(
        existsSync(join(nodeDir(dir, nodeId), "work", "SEED.md")),
        "the node's workdir must contain the cloned seed file",
      );
    } finally {
      stopPoll = true;
      await poller;
      if (nodeId) { try { await client.stopNode(nodeId); } catch {} }
    }

    assert.ok(
      maxGapMs < 10000,
      `daemon event loop stalled for ${maxGapMs}ms during a self-clone — E3 is back`,
    );
  });
});
