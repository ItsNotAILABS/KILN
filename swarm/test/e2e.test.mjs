/**
 * End-to-end: a REAL worker OS process runs a script-mind job against a
 * real git clone — file written, command run, commit landed, receipts verify.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeStateDir, makeNode, gitLog } from "./helpers.mjs";
import { writeJobFile } from "../lib/state.mjs";
import { readEvents } from "../lib/queue.mjs";
import { verifyReceipts } from "../lib/receipts.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, "..", "lib", "worker.mjs");

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(dir, jobId, timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    for (const e of readEvents(dir)) {
      if ((e.type === "done" || e.type === "fail") && e.jobId === jobId) return e;
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for job ${jobId}`);
}

describe("worker end-to-end (real OS process)", () => {
  it("runs a multi-step job: write file, run command, real git commit", async () => {
    const dir = makeStateDir();
    const { node, keypair } = makeNode(dir, { name: "e2e", caps: 15 });

    const jobId = "job_e2e_1";
    writeJobFile(dir, node.id, {
      id: jobId,
      name: "e2e-report",
      mind: "script",
      plan: {
        steps: [
          { tool: "fs.write", args: { path: "REPORT.md", content: "# worker report\nbuilt by a real kiln worker\n" } },
          { tool: "shell.exec", args: { command: "git", args: ["log", "--oneline", "-1"] } },
          { tool: "git.commit", args: { message: "e2e: worker report" } },
        ],
      },
    });

    const worker = spawn(process.execPath, [WORKER, node.id], {
      env: { ...process.env, KILN_SWARM_DIR: dir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    worker.stderr.on("data", (c) => (stderr += c));
    const done = waitFor(dir, jobId);
    const event = await done;

    worker.kill("SIGTERM");
    await new Promise((r) => worker.on("exit", r));

    assert.equal(event.type, "done", `job failed: ${event.error || ""} stderr: ${stderr.slice(0, 500)}`);
    assert.match(event.summary, /3\/3 steps ok/);

    // REAL file on disk with the exact content
    const report = join(node.workdir, "REPORT.md");
    assert.ok(existsSync(report), "REPORT.md must exist on disk");
    assert.equal(readFileSync(report, "utf8"), "# worker report\nbuilt by a real kiln worker\n");

    // REAL commit in the clone
    const log = gitLog(node.workdir, 3);
    assert.match(log, /e2e: worker report/);

    // REAL receipts verify against the node's pubkey
    const v = verifyReceipts(dir, node.id, keypair);
    assert.equal(v.ok, true);
    assert.ok(v.count >= 3, `expected >=3 receipts, got ${v.count}`);
  });
});
