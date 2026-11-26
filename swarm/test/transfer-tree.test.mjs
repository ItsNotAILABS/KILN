/**
 * Multi-receiver Turbine-style tree fan-out: one origin, a breadth-first
 * tree, each hop hash-verifies then forwards under an origin-signed hop
 * grant. Compared against N unicast sends on the same box.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startReceiver, sendTree, sendUnicastAll, generateKeypair, buildTree } from "../lib/transfer.mjs";

const dirs = [], receivers = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "kiln-tree-")); dirs.push(d); return d; };
const sha = (b) => createHash("sha256").update(b).digest("hex");
after(async () => {
  for (const rx of receivers) await rx.close().catch(() => {});
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("buildTree", () => {
  it("builds a breadth-first tree with the requested fanout", () => {
    const targets = Array.from({ length: 8 }, (_, i) => ({ host: "127.0.0.1", port: 1000 + i, publicKey: "pk" + i }));
    const roots = buildTree(targets, 2);
    assert.equal(roots.length, 2);
    assert.equal(roots[0].children.length, 2);
    assert.equal(roots[1].children.length, 2);
    const count = (n) => 1 + (n.children || []).reduce((s, c) => s + count(c), 0);
    assert.equal(roots.reduce((s, r) => s + count(r), 0), 8);
  });
});

describe("transfer: tree fan-out", { timeout: 180000 }, () => {
  it("delivers a byte-exact file to 8 receivers and is benchmarked against unicast", async () => {
    const origin = generateKeypair();
    const rxs = [];
    for (let i = 0; i < 8; i++) {
      const out = tmp();
      const rk = generateKeypair();
      const rx = await startReceiver({ outDir: out, keypair: rk });
      receivers.push(rx);
      rxs.push({ rx, out, rk, publicKey: rk.publicKey, host: "127.0.0.1", port: rx.port });
    }
    const data = randomBytes(2 * 1024 * 1024);
    const p = join(tmp(), "tree.bin");
    writeFileSync(p, data);
    const want = sha(data);
    const targets = rxs.map((t) => ({ host: t.host, port: t.port, publicKey: t.publicKey }));
    const tree = await sendTree(p, targets, {
      keypair: origin, fanout: 2, encrypt: true,
      chunkSize: 64 * 1024, dataShards: 8, parityShards: 2, streams: 2,
    });
    assert.equal(tree.receivers, 8);
    assert.equal(tree.fanout, 2);
    for (const t of rxs) {
      assert.equal(sha(readFileSync(join(t.out, "tree.bin"))), want, `mismatch at ${t.out}`);
    }

    // Fresh receivers for the unicast baseline (same file, same coding).
    const uni = [];
    for (let i = 0; i < 8; i++) {
      const out = tmp();
      const rk = generateKeypair();
      const rx = await startReceiver({ outDir: out, keypair: rk });
      receivers.push(rx);
      uni.push({ host: "127.0.0.1", port: rx.port, publicKey: rk.publicKey, out });
    }
    const unicast = await sendUnicastAll(p, uni, {
      keypair: origin, encrypt: true,
      chunkSize: 64 * 1024, dataShards: 8, parityShards: 2, streams: 2,
    });
    for (const t of uni) assert.equal(sha(readFileSync(join(t.out, "tree.bin"))), want);

    console.log(`# tree 8×2 MiB fanout=2: wall ${tree.totalSeconds.toFixed(2)}s, aggregate ${tree.throughputMBps.toFixed(1)} MiB/s, origin ${tree.originThroughputMBps.toFixed(1)} MiB/s`);
    console.log(`# unicast 8×2 MiB: wall ${unicast.totalSeconds.toFixed(2)}s, aggregate ${unicast.throughputMBps.toFixed(1)} MiB/s`);
    // Origin only talks to `fanout` first-level nodes.
    assert.equal(tree.branches.length, 2);
  });

  it("rejects a hop that presents a stranger's identity mid-tree", async () => {
    const origin = generateKeypair();
    const out = tmp();
    const rk = generateKeypair();
    const rx = await startReceiver({ outDir: out, keypair: rk });
    receivers.push(rx);
    const p = join(tmp(), "deny.bin");
    writeFileSync(p, randomBytes(4096));
    const hop = generateKeypair();
    const grant = (await import("../lib/transfer-manifest.mjs")).signHopGrant(origin, {
      manifestId: "c".repeat(64), hop: hop.publicKey, children: [rk.publicKey],
    });
    // sendFile as a hop: hsSender is `hop`, manifest.sender is origin, grant is for a different manifest id.
    const { sendFile, buildManifest, signManifest } = await import("../lib/transfer.mjs");
    const env = signManifest(await buildManifest(p, { sender: origin.publicKey, chunkSize: 4096, dataShards: 2, parityShards: 0 }), origin);
    await assert.rejects(
      () => sendFile(p, { port: rx.port, keypair: hop, envelope: env, hopAuth: grant, expectReceiver: rk.publicKey, encrypt: true }),
      /hop grant/,
    );
  });
});
