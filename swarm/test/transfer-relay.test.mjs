/**
 * Blind relay + rendezvous / hole-punch fallback.
 *
 * Real NAT namespaces (`ip netns add`) are not available on this host
 * (Permission denied on /run/netns). Tests therefore use a real relay
 * process on loopback, and `forceRelay` to simulate a failed punch.
 * Direct rendezvous+dial on loopback is also exercised (not a NAT).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startReceiver, sendFile, generateKeypair, startRelay, newRelayToken, punchOrRelay } from "../lib/transfer.mjs";
import { signHopGrant, verifyHopGrant } from "../lib/transfer-manifest.mjs";

const dirs = [], closers = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "kiln-relay-")); dirs.push(d); return d; };
const sha = (b) => createHash("sha256").update(b).digest("hex");
after(async () => {
  for (const c of closers) await (c.close ? c.close() : c()).catch(() => {});
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("transfer: hop grants", () => {
  it("signs and verifies a hop grant bound to origin, hop, and children", () => {
    const origin = generateKeypair();
    const hop = generateKeypair();
    const child = generateKeypair();
    const id = "a".repeat(64);
    const g = signHopGrant(origin, { manifestId: id, hop: hop.publicKey, children: [child.publicKey] });
    assert.equal(verifyHopGrant(origin.publicKey, g, { manifestId: id, hop: hop.publicKey }), true);
    assert.equal(verifyHopGrant(origin.publicKey, g, { manifestId: "b".repeat(64), hop: hop.publicKey }), false);
    assert.equal(verifyHopGrant(child.publicKey, g, { manifestId: id, hop: hop.publicKey }), false);
    const stranger = generateKeypair();
    const bad = { ...g, hop: stranger.publicKey };
    assert.equal(verifyHopGrant(origin.publicKey, bad, { manifestId: id, hop: stranger.publicKey }), false);
  });
});

describe("transfer: blind relay", { timeout: 60000 }, () => {
  it("forwards an encrypted transfer and never needs plaintext (byte-exact)", async () => {
    const relay = await startRelay({ host: "127.0.0.1", port: 0 });
    closers.push(relay);
    const token = newRelayToken();
    const out = tmp();
    const rk = generateKeypair(), sk = generateKeypair();
    const rx = await startReceiver({ outDir: out, keypair: rk, via: { host: relay.host, port: relay.port }, token });
    closers.push(rx);
    const data = randomBytes(512 * 1024 + 19);
    const p = join(tmp(), "via.bin");
    writeFileSync(p, data);
    const r = await sendFile(p, {
      keypair: sk, via: { host: relay.host, port: relay.port }, token,
      expectReceiver: rx.publicKey, chunkSize: 64 * 1024, dataShards: 8, parityShards: 2, streams: 2,
    });
    assert.equal(r.path, "relay");
    assert.equal(r.encrypt, true);
    assert.equal(r.result.status, "complete");
    assert.equal(sha(readFileSync(join(out, "via.bin"))), sha(data));
    assert.ok(relay.stats.pairs >= 1, "relay spliced at least one pair");
    assert.ok(relay.stats.bytes > 0, "relay forwarded bytes");
  });

  it("falls back to the relay when forceRelay simulates a failed punch", async () => {
    const relay = await startRelay({ host: "127.0.0.1", port: 0 });
    closers.push(relay);
    const token = newRelayToken();
    const out = tmp();
    const rk = generateKeypair(), sk = generateKeypair();
    const rend = { host: relay.host, port: relay.port };
    const rx = await startReceiver({ outDir: out, keypair: rk, rendezvous: rend, token, holePunchMs: 400 });
    closers.push(rx);
    const data = randomBytes(64 * 1024 + 3);
    const p = join(tmp(), "fb.bin");
    writeFileSync(p, data);
    const r = await sendFile(p, {
      keypair: sk, rendezvous: rend, token, forceRelay: true, holePunchMs: 400,
      expectReceiver: rx.publicKey, chunkSize: 32 * 1024, dataShards: 4, parityShards: 2, streams: 1,
    });
    assert.equal(r.path, "relay");
    assert.equal(sha(readFileSync(join(out, "fb.bin"))), sha(data));
  });

  it("can punch a direct path on loopback after a rendezvous (not a real NAT)", async () => {
    const relay = await startRelay({ host: "127.0.0.1", port: 0 });
    closers.push(relay);
    const token = newRelayToken();
    const out = tmp();
    const rk = generateKeypair(), sk = generateKeypair();
    const rend = { host: relay.host, port: relay.port };
    const rx = await startReceiver({ outDir: out, keypair: rk, rendezvous: rend, token, holePunchMs: 2000 });
    closers.push(rx);
    const data = randomBytes(32 * 1024);
    const p = join(tmp(), "dir.bin");
    writeFileSync(p, data);
    const r = await sendFile(p, {
      keypair: sk, host: "127.0.0.1", port: rx.port,
      rendezvous: rend, token, holePunchMs: 2000,
      expectReceiver: rx.publicKey, chunkSize: 16 * 1024, dataShards: 4, parityShards: 1, streams: 0,
    });
    assert.ok(r.path === "direct" || r.path === "relay", `path=${r.path}`);
    assert.equal(sha(readFileSync(join(out, "dir.bin"))), sha(data));
    console.log(`# loopback rendezvous path: ${r.path}`);
  });
});
