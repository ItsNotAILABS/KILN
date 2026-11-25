/**
 * KILN agent transfer — protocol tests over real TCP on 127.0.0.1:
 * byte-exact delivery, Turbine-style erasure recovery with dropped shards,
 * hash-mismatch rejection, a dead data connection, resume after an
 * interrupted send, trust/identity pinning, directories, and vc homes.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  startReceiver, sendFile, sendPath, generateKeypair, pingLatency, receiveIntoComputer, sendFromComputer, homeRelative,
} from "../lib/transfer.mjs";
import { makeStateDir } from "./helpers.mjs";

const dirs = [], receivers = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "kiln-tx-")); dirs.push(d); return d; };
after(async () => {
  for (const rx of receivers) await rx.close().catch(() => {});
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const sha = (b) => createHash("sha256").update(b).digest("hex");
const small = { chunkSize: 64 * 1024, dataShards: 8, parityShards: 2 };

function file(bytes, name = "data.bin") {
  const d = tmp(); const p = join(d, name); const data = randomBytes(bytes);
  writeFileSync(p, data); return { p, data };
}

async function pair(rxOpts = {}) {
  const out = tmp();
  const rk = generateKeypair();
  const rx = await startReceiver({ outDir: out, keypair: rk, ...rxOpts });
  receivers.push(rx);
  return { rx, out, rk, sk: generateKeypair() };
}

describe("transfer: delivery", () => {
  it("sends a multi-stripe file byte-exact over parallel streams", async () => {
    const { rx, out, sk } = await pair();
    const { p, data } = file(5 * 1024 * 1024 + 123);
    const r = await sendFile(p, { port: rx.port, keypair: sk, streams: 4, ...small });
    await rx.close();
    assert.equal(r.result.status, "complete");
    assert.equal(r.stripes, Math.ceil(Math.ceil(data.length / small.chunkSize) / 8));
    assert.equal(sha(readFileSync(join(out, "data.bin"))), sha(data));
    assert.equal(r.result.sender, sk.publicKey);
    assert.ok(!existsSync(join(out, ".kiln-recv", `${r.id}.part`)), "partial cleaned up");
  });
  it("handles empty and 1-byte files", async () => {
    const { rx, out, sk } = await pair();
    const e = file(0, "empty"); const one = file(1, "one");
    await sendFile(e.p, { port: rx.port, keypair: sk, ...small });
    await sendFile(one.p, { port: rx.port, keypair: sk, ...small });
    await rx.close();
    assert.equal(readFileSync(join(out, "empty")).length, 0);
    assert.deepEqual(readFileSync(join(out, "one")), one.data);
  });
  it("does not clobber an existing file", async () => {
    const { rx, out, sk } = await pair();
    writeFileSync(join(out, "data.bin"), "keep");
    const { p, data } = file(1000);
    const r = await sendFile(p, { port: rx.port, keypair: sk, ...small });
    await rx.close();
    assert.equal(readFileSync(join(out, "data.bin"), "utf8"), "keep");
    assert.deepEqual(readFileSync(r.result.path), data);
  });
  it("answers small-message pings in well under 50ms on loopback", async () => {
    const { rx } = await pair();
    const l = await pingLatency({ port: rx.port, count: 50 });
    await rx.close();
    assert.ok(l.p50 < 50, `p50 ${l.p50}ms`);
  });
});

describe("transfer: erasure recovery + integrity", () => {
  it("recovers stripes from parity when up to m shards per stripe are dropped (no resend)", async () => {
    const { rx, out, sk } = await pair();
    const { p, data } = file(3 * 1024 * 1024);
    const r = await sendFile(p, { port: rx.port, keypair: sk, ...small,
      _hooks: { onShard: ({ index }) => (index === 0 || index === 5 ? "drop" : undefined) } });
    await rx.close();
    assert.equal(sha(readFileSync(join(out, "data.bin"))), sha(data));
    assert.equal(r.repairRounds, 0, "parity alone was enough");
    assert.equal(rx.stats.recoveredStripes, r.stripes);
  });
  it("falls back to a repair round when more than m shards are lost", async () => {
    const { rx, out, sk } = await pair();
    const { p, data } = file(2 * 1024 * 1024);
    const r = await sendFile(p, { port: rx.port, keypair: sk, ...small,
      _hooks: { onShard: ({ stripe, index, repair }) => (!repair && stripe === 1 && index < 3 ? "drop" : undefined) } });
    await rx.close();
    assert.equal(sha(readFileSync(join(out, "data.bin"))), sha(data));
    assert.equal(r.repairRounds, 1);
  });
  it("rejects shards whose hash does not match the manifest", async () => {
    const { rx, out, sk } = await pair();
    const { p, data } = file(2 * 1024 * 1024);
    const r = await sendFile(p, { port: rx.port, keypair: sk, ...small,
      _hooks: { onShard: ({ index }) => (index === 3 ? "corrupt" : undefined) } });
    await rx.close();
    assert.ok(r.result.mismatchesDropped >= r.stripes, `dropped ${r.result.mismatchesDropped}`);
    assert.equal(sha(readFileSync(join(out, "data.bin"))), sha(data), "corrupt bytes never reach disk");
  });
  it("catches corrupt parity (rebuilt data fails its hash) and re-requests", async () => {
    const { rx, out, sk } = await pair();
    const { p, data } = file(1024 * 1024);
    const r = await sendFile(p, { port: rx.port, keypair: sk, ...small,
      _hooks: { onShard: ({ index, repair }) => (repair ? undefined : index === 2 ? "drop" : index === 8 ? "corrupt" : undefined) } });
    await rx.close();
    assert.equal(sha(readFileSync(join(out, "data.bin"))), sha(data));
    assert.ok(r.repairRounds >= 1);
  });
  it("survives a data connection dying mid-transfer", async () => {
    const { rx, out, sk } = await pair();
    const { p, data } = file(6 * 1024 * 1024);
    let killed = false;
    const r = await sendFile(p, { port: rx.port, keypair: sk, streams: 4, ...small,
      _hooks: { onShard: ({ stripe, conns }) => { if (stripe === 3 && !killed) { killed = true; conns[1].destroy(); } } } });
    await rx.close();
    assert.ok(killed);
    assert.equal(sha(readFileSync(join(out, "data.bin"))), sha(data));
  });
});

describe("transfer: resume", () => {
  it("skips stripes the receiver already has (same signed manifest)", async () => {
    const { rx, out, sk } = await pair();
    const { p, data } = file(8 * 1024 * 1024);
    const { buildManifest, signManifest } = await import("../lib/transfer-manifest.mjs");
    const envelope = signManifest(await buildManifest(p, { ...small, sender: sk.publicKey }), sk);
    await assert.rejects(sendFile(p, { port: rx.port, keypair: sk, envelope, ...small, _hooks: { abortAfterStripes: 8 } }), /aborted/);
    await new Promise((r) => setTimeout(r, 300));
    const r = await sendFile(p, { port: rx.port, keypair: sk, envelope, ...small });
    await rx.close();
    assert.ok(r.skippedStripes >= 4, `skipped ${r.skippedStripes}/${r.stripes}`);
    assert.ok(r.wireBytes < data.length, "second send moved less than the whole file");
    assert.equal(sha(readFileSync(join(out, "data.bin"))), sha(data));
  });
});

describe("transfer: identity + trust", () => {
  it("refuses senders outside the trust list", async () => {
    const { rx, sk } = await pair({ trust: [generateKeypair().publicKey] });
    const { p } = file(1000);
    await assert.rejects(sendFile(p, { port: rx.port, keypair: sk, ...small }), /not trusted/);
    await rx.close();
  });
  it("accepts a trusted sender and pins the receiver's key", async () => {
    const sk = generateKeypair();
    const { rx, rk } = await pair({ trust: [sk.publicKey] });
    const { p } = file(1000);
    const r = await sendFile(p, { port: rx.port, keypair: sk, expectReceiver: rk.publicKey, ...small });
    assert.equal(r.receiver, rk.publicKey);
    await assert.rejects(sendFile(p, { port: rx.port, keypair: sk, expectReceiver: generateKeypair().publicKey, ...small }), /expected/);
    await rx.close();
  });
});

describe("transfer: directories + vc homes", () => {
  it("sends a directory as a tar", async () => {
    const { rx, out, sk } = await pair();
    const src = join(tmp(), "pkg"); mkdirSync(join(src, "sub"), { recursive: true });
    writeFileSync(join(src, "a.txt"), "A"); writeFileSync(join(src, "sub", "b.txt"), "B");
    const r = await sendPath(src, { port: rx.port, keypair: sk, ...small });
    await rx.close();
    assert.equal(r.packed, "tar"); assert.equal(r.name, "pkg.tar");
    const x = tmp();
    assert.equal(spawnSync("tar", ["-xf", join(out, "pkg.tar"), "-C", x]).status, 0);
    assert.equal(readFileSync(join(x, "pkg", "sub", "b.txt"), "utf8"), "B");
  });
  it("refuses paths that escape a computer's home", () => {
    assert.equal(homeRelative("inbox/x"), "inbox/x");
    assert.equal(homeRelative("/abs/x"), "abs/x");
    assert.throws(() => homeRelative("../etc"), /escapes/);
    assert.throws(() => homeRelative("a/../../etc"), /escapes/);
  });
  it("receives into and sends out of a local-backend vc home", async () => {
    const dir = makeStateDir();
    const id = "vc_" + "a1".repeat(6);
    const base = join(dir, "vcomputers", id);
    mkdirSync(join(base, "home"), { recursive: true });
    writeFileSync(join(base, "computer.json"), JSON.stringify({ id, name: "tx-local", backend: "local", status: "stopped", config: {} }));
    const rx = await receiveIntoComputer(dir, "tx-local", { subdir: "inbox", keypair: generateKeypair() });
    receivers.push(rx);
    const { p, data } = file(300 * 1024, "report.zip");
    const r = await sendFile(p, { port: rx.port, keypair: generateKeypair(), ...small });
    await rx.close();
    assert.equal(r.result.homePath, "~/inbox/report.zip");
    assert.deepEqual(readFileSync(join(base, "home", "inbox", "report.zip")), data);
    // and back out of the home
    const back = await pair();
    const r2 = await sendFromComputer(dir, id, "inbox/report.zip", { port: back.rx.port, keypair: generateKeypair(), ...small });
    await back.rx.close();
    assert.equal(r2.result.status, "complete");
    assert.deepEqual(readFileSync(join(back.out, "report.zip")), data);
  });
});
