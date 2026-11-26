/**
 * Daemon HTTP routes for agent transfer: start/list/cancel + receipts.
 * Operator token, same auth as the rest of the daemon.
 */
import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SwarmClient } from "../lib/client.mjs";
import { makeStateDir } from "./helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON = join(HERE, "..", "lib", "daemon.mjs");
const dirs = [];
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitForApi(dir, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const p = join(dir, "daemon.json");
    if (existsSync(p)) {
      try { const dj = JSON.parse(readFileSync(p, "utf8")); if (dj.apiPort) return dj; } catch {}
    }
    await sleep(200);
  }
  throw new Error("timed out waiting for daemon api");
}

describe("transfer HTTP API (real daemon)", { timeout: 60000, concurrency: 1 }, () => {
  let dir, daemon, client, tmp, apiUrl;
  before(async () => {
    dir = makeStateDir();
    tmp = mkdtempSync(join(tmpdir(), "kiln-txhttp-"));
    dirs.push(tmp);
    daemon = spawn(process.execPath, [DAEMON], {
      env: { ...process.env, KILN_SWARM_DIR: dir, KILN_SWARM_API_PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const dj = await waitForApi(dir);
    apiUrl = dj.apiUrl;
    client = await SwarmClient.connect({ dir });
  });
  after(async () => {
    if (daemon) daemon.kill("SIGTERM");
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("refuses unauthenticated transfer routes", async () => {
    const res = await fetch(`${apiUrl}/v1/transfers`);
    assert.equal(res.status, 401);
    const bad = await fetch(`${apiUrl}/v1/transfers`, { headers: { authorization: "Bearer wrong" } });
    assert.equal(bad.status, 401);
  });

  it("starts a recv, sends a file, lists, fetches an offline receipt, and cancels", async () => {
    const recv = await client.startTransfer({ role: "recv", outDir: join(tmp, "inbox"), host: "127.0.0.1" });
    assert.match(recv.id, /^tx_[0-9a-f]{12}$/);
    assert.equal(recv.state, "listening");
    assert.ok(recv.port > 0);
    assert.ok(recv.publicKey);

    const src = join(tmp, "hello.bin");
    writeFileSync(src, randomBytes(64 * 1024 + 9));
    const sent = await client.startTransfer({
      role: "send", path: src, to: `127.0.0.1:${recv.port}`, expect: recv.publicKey, waitMs: 20000,
    });
    assert.equal(sent.state, "complete");
    assert.equal(sent.result?.result?.status, "complete");
    assert.ok(sent.result?.bytes > 0);
    assert.equal(sent.receipt.submitted, false);
    assert.ok(sent.receipt.signature);

    const list = await client.listTransfers();
    assert.ok(list.some((t) => t.id === recv.id));
    assert.ok(list.some((t) => t.id === sent.id && t.state === "complete"));
    const got = await client.getTransfer(sent.id);
    assert.equal(got.id, sent.id);
    const rec = await client.getTransferReceipt(sent.id);
    assert.equal(rec.signature, sent.receipt.signature);

    // The first recv already completed the send; cancel a still-listening one.
    const spare = await client.startTransfer({ role: "recv", outDir: join(tmp, "inbox-2"), host: "127.0.0.1" });
    const cancelled = await client.cancelTransfer(spare.id);
    assert.equal(cancelled.state, "cancelled");
    const finished = await client.getTransfer(recv.id);
    assert.equal(finished.state, "complete");
  });

  it("starts and cancels a relay", async () => {
    const r = await client.startTransfer({ role: "relay", host: "127.0.0.1" });
    assert.equal(r.role, "relay");
    assert.equal(r.state, "listening");
    assert.ok(r.port > 0);
    const c = await client.cancelTransfer(r.id);
    assert.equal(c.state, "cancelled");
  });
});
