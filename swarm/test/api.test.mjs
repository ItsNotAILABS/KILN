/**
 * HTTP API + client SDK, end to end against a REAL daemon process:
 * submit a job through the SDK, a worker runs it for real, receipts verify.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SwarmClient } from "../lib/client.mjs";
import { makeStateDir, makeGitRepo, gitLog } from "./helpers.mjs";
import { listNodeIds, loadNode, pidAlive } from "../lib/state.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON = join(HERE, "..", "lib", "daemon.mjs");

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForApi(dir, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const p = join(dir, "daemon.json");
    if (existsSync(p)) {
      try {
        const dj = JSON.parse(readFileSync(p, "utf8"));
        if (dj.apiPort) return dj;
      } catch { /* still writing */ }
    }
    await sleep(200);
  }
  throw new Error("timed out waiting for daemon api");
}

describe("swarm HTTP API + SDK (real daemon)", () => {
  let dir, daemon, client;

  it("boots a daemon with a local-only API", async () => {
    dir = makeStateDir();
    daemon = spawn(process.execPath, [DAEMON], {
      env: { ...process.env, KILN_SWARM_DIR: dir, KILN_SWARM_API_PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    daemon.on("error", (e) => { throw e; });
    const dj = await waitForApi(dir);
    assert.ok(dj.apiPort > 0, "ephemeral port assigned");
    assert.ok(dj.apiUrl.startsWith("http://127.0.0.1:"), `local-only URL: ${dj.apiUrl}`);
    client = await SwarmClient.connect({ dir });
    const h = await client.health();
    assert.equal(h.ok, true);
  });

  it("rejects unauthenticated requests", async () => {
    const dj = JSON.parse(readFileSync(join(dir, "daemon.json"), "utf8"));
    const res = await fetch(`${dj.apiUrl}/jobs`);
    assert.equal(res.status, 401);
    const bad = await fetch(`${dj.apiUrl}/jobs`, { headers: { authorization: "Bearer wrong" } });
    assert.equal(bad.status, 401);
  });

  it("SDK submits a job; a real worker runs it (write file + real commit)", async () => {
    const repo = makeGitRepo();
    const { id } = await client.submitJob({
      name: "api-e2e",
      repo,
      plan: {
        steps: [
          { tool: "fs.write", args: { path: "API_REPORT.md", content: "# via http api\n" } },
          { tool: "git.commit", args: { message: "api e2e commit" } },
        ],
      },
    });
    assert.ok(id.startsWith("job_"));
    const job = await client.waitForJob(id, { timeoutMs: 120000, pollMs: 1000 });
    assert.equal(job.status, "done");
    assert.match(job.summary, /2\/2 steps ok/);

    // The worker ran against a real clone: find it and check the commit.
    const nodes = await client.listNodes();
    assert.ok(nodes.length >= 1);
    const workerNode = nodes.find((n) => n.name.startsWith("job-"));
    assert.ok(workerNode, "autospawned job node exists");
    const rec = loadNode(dir, workerNode.id);
    assert.match(gitLog(rec.workdir, 3), /api e2e commit/);

    // Receipts verify through the API too.
    const vr = await client.verifyReceipts(workerNode.id);
    assert.equal(vr.allOk, true);
    assert.ok(vr.results[0].count >= 2);
  });

  it("spawns and lists nodes through the API", async () => {
    const { id, name } = await client.spawnNode({ name: "api-node", caps: "commit,delegate", ttlSec: 3600 });
    assert.ok(id);
    const nodes = await client.listNodes();
    assert.ok(nodes.some((n) => n.id === id && n.name === name));
    const logs = await client.nodeLogs("api-node", { tail: 20 });
    assert.ok(typeof logs.log === "string");
  });

  after(async () => {
    if (client) {
      try {
        const nodes = await client.listNodes();
        for (const n of nodes) {
          if (n.status !== "dead") await client.stopNode(n.id).catch(() => {});
        }
      } catch { /* daemon may be gone */ }
    }
    if (daemon && pidAlive(daemon.pid)) {
      daemon.kill("SIGTERM");
      await new Promise((r) => { daemon.on("exit", r); setTimeout(r, 5000); });
    }
    if (dir) {
      for (const id of listNodeIds(dir)) {
        const n = loadNode(dir, id);
        assert.ok(!pidAlive(n.workerPid), `worker ${n.name} must be stopped after test`);
      }
    }
  });
});
