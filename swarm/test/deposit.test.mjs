/**
 * depositCode: the agent code-deposit primitive, end to end against a REAL
 * daemon. A temp git repo is the deposit target; the daemon spawns a fresh
 * CAP_COMMIT node that really clones it, writes files, and commits.
 * Plus the refusal case: a node WITHOUT CAP_COMMIT fails the deposit and
 * creates NO commit.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SwarmClient } from "../lib/client.mjs";
import { makeStateDir, makeGitRepo, makeNode, gitLog } from "./helpers.mjs";
import { nodeDir, writeJobFile } from "../lib/state.mjs";
import { readEvents } from "../lib/queue.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON = join(HERE, "..", "swarm.mjs"); // CLI: `daemon start`
const WORKER = join(HERE, "..", "lib", "worker.mjs");

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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

async function waitForEvent(dir, jobId, timeoutMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    for (const e of readEvents(dir)) {
      if ((e.type === "done" || e.type === "fail") && e.jobId === jobId) return e;
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for job ${jobId}`);
}

let daemonPid = null;

after(async () => {
  // Kill the REAL daemon pid from daemon.json — NOT the `daemon start` starter
  // child, which exits right after spawning the detached daemon. Killing the
  // starter leaks the daemon (seen: 4 scratch daemons surviving full runs).
  if (daemonPid) { try { process.kill(daemonPid, "SIGTERM"); } catch {} daemonPid = null; }
});

describe("depositCode (real daemon, real clone, real commit)", () => {
  it("deposits files into a temp repo: real commit, matching contents, verified receipts", async () => {
    const dir = makeStateDir();
    const starter = spawn(process.execPath, [DAEMON, "daemon", "start"], {
      env: { ...process.env, KILN_SWARM_DIR: dir, KILN_SWARM_API_PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    starter.on("error", () => {});
    await waitForDaemonJson(dir);
    daemonPid = JSON.parse(readFileSync(join(dir, "daemon.json"), "utf8")).pid;
    const client = await SwarmClient.connect({ dir });

    const repo = makeGitRepo();
    const result = await client.depositCode({
      repo,
      files: [
        { path: "agents/hello.txt", content: "deposited by a kiln swarm worker\n" },
        { path: "agents/notes.md", content: "# deposit notes\n" },
      ],
      message: "deposit: agent hello files",
      name: "test-deposit",
      nodeTimeoutMs: 60000,
    });

    // A real short hash came back — parsed from the worker's git output.
    assert.match(result.commitHash, /^[0-9a-f]{7,40}$/);

    // The commit REALLY exists in the node's clone, with the message.
    const work = join(nodeDir(dir, result.nodeId), "work");
    const log = gitLog(work, 3);
    assert.ok(log.includes("deposit: agent hello files"), `commit missing from clone log:\n${log}`);
    assert.ok(log.includes(result.commitHash.slice(0, 7)), `hash missing from clone log:\n${log}`);

    // File contents match exactly.
    assert.equal(readFileSync(join(work, "agents/hello.txt"), "utf8"), "deposited by a kiln swarm worker\n");
    assert.equal(readFileSync(join(work, "agents/notes.md"), "utf8"), "# deposit notes\n");

    // Signed receipts verify: 2 writes + 1 commit.
    assert.equal(result.receipts.allOk, true);
    const mine = result.receipts.results.find((r) => r.node === result.nodeId);
    assert.ok(mine && mine.ok && mine.count >= 3, `receipts: ${JSON.stringify(result.receipts)}`);

    // The node ran with ONLY CAP_COMMIT.
    const nodes = await client.listNodes();
    const me = nodes.find((n) => n.id === result.nodeId);
    assert.deepEqual(me.capNames, ["commit"]);

    await client.stopNode(result.nodeId);
    try { process.kill(daemonPid, "SIGTERM"); } catch {}
    daemonPid = null;
  });

  it("refuses loudly without CAP_COMMIT: no commit is created", async () => {
    const dir = makeStateDir();
    // A node with zero capabilities — like a worker that was never granted commit.
    const { node } = await makeNode(dir, { name: "no-commit", caps: 0 });

    const jobId = "job_deposit_refused";
    writeJobFile(dir, node.id, {
      id: jobId,
      name: "deposit-refused",
      mind: "script",
      plan: {
        steps: [
          { tool: "fs.write", args: { path: "evil.txt", content: "should not be committed\n" } },
          { tool: "git.commit", args: { message: "deposit: should never land" } },
        ],
      },
    });

    const worker = spawn(process.execPath, [WORKER, node.id], {
      env: { ...process.env, KILN_SWARM_DIR: dir },
      stdio: ["ignore", "ignore", "ignore"],
    });
    try {
      const event = await waitForEvent(dir, jobId, 60000);
      assert.equal(event.type, "fail", `expected job failure, got: ${JSON.stringify(event)}`);
      assert.match(String(event.error || ""), /CAP_COMMIT|capabilit|grant/i);

      // The write happened (fs.write needs no caps) but NO commit was created.
      const work = join(nodeDir(dir, node.id), "work");
      assert.ok(existsSync(join(work, "evil.txt")), "the file itself was written");
      const log = gitLog(work, 5);
      assert.ok(!log.includes("deposit: should never land"), `phantom commit landed:\n${log}`);
      assert.equal(log.split("\n").length, 1, `expected only the seed commit:\n${log}`);
    } finally {
      worker.kill("SIGTERM");
    }
  });
});
