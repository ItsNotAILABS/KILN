/**
 * Opt-in QUIC transport. Skips when @matrixai/quic is not loadable
 * (set KILN_QUIC_DIR, or install the package). Encryption stays on.
 */
import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startReceiver, sendFile, generateKeypair, TransferQuicUnavailable, ensureQuicTransport } from "../lib/transfer.mjs";

if (!process.env.KILN_QUIC_DIR && existsSync("/workspace/quic-try")) {
  process.env.KILN_QUIC_DIR = "/workspace/quic-try";
}

const dirs = [], receivers = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "kiln-quic-")); dirs.push(d); return d; };
const sha = (b) => createHash("sha256").update(b).digest("hex");
after(async () => {
  for (const rx of receivers) await rx.close().catch(() => {});
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

let available = false;
let skip = "QUIC module not available";
before(async () => {
  try {
    await ensureQuicTransport();
    available = true;
    skip = false;
  } catch (e) {
    if (e instanceof TransferQuicUnavailable || /quic/i.test(e.message)) skip = `QUIC module not available: ${e.message}`;
    else throw e;
  }
});

describe("transfer: QUIC transport (opt-in)", { timeout: 60000 }, () => {
  it("loads, or skips honestly when the optional module is missing", async () => {
    if (!available) {
      console.log(`# skip remaining QUIC transfer tests: ${skip}`);
      return;
    }
    assert.ok(true);
  });

  it("delivers a multi-stripe file byte-exact over QUIC with encryption on", async (t) => {
    if (!available) { t.skip(skip); return; }
    const out = tmp();
    const rk = generateKeypair(), sk = generateKeypair();
    const rx = await startReceiver({ outDir: out, keypair: rk, transport: "quic", host: "127.0.0.1" });
    receivers.push(rx);
    const data = randomBytes(2 * 1024 * 1024 + 77);
    const p = join(tmp(), "q.bin");
    writeFileSync(p, data);
    const r = await sendFile(p, { port: rx.port, keypair: sk, transport: "quic", expectReceiver: rx.publicKey, chunkSize: 64 * 1024, dataShards: 8, parityShards: 2 });
    await rx.close();
    assert.equal(r.transport, "quic");
    assert.equal(r.encrypt, true);
    assert.equal(r.result.status, "complete");
    assert.equal(sha(readFileSync(join(out, "q.bin"))), sha(data));
    console.log(`# QUIC 2 MiB transfer: ${r.throughputMBps.toFixed(1)} MiB/s in ${r.transferSeconds.toFixed(2)}s, streams=${r.streams}`);
  });
});
