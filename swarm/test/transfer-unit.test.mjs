/**
 * KILN agent transfer — unit tests: base58 / Solana keypairs, Reed-Solomon
 * erasure recovery, chunk geometry + manifest hashing, signed-manifest
 * verification and rejection, and the memo receipt.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  b58encode, b58decode, generateKeypair, keypairToSolanaJson, keypairFromSolanaJson, signBytes, verifyBytes,
} from "../lib/transfer-identity.mjs";
import { encodeParity, reconstructData } from "../lib/transfer-rs.mjs";
import {
  buildManifest, signManifest, verifySignedManifest, geometry, stripeK, chunkLen, manifestId, canonicalJson, safeName,
} from "../lib/transfer-manifest.mjs";
import { buildMemoReceipt, verifyMemoReceipt, checkRpcUrl, MEMO_PROGRAM_ID } from "../lib/transfer-receipt.mjs";
import { FrameCipher, deriveCiphers, clientHandshake, serverHandshake, finishHandshake, requireEncryptOrLoopback } from "../lib/transfer-crypto.mjs";


const tmp = () => mkdtempSync(join(tmpdir(), "kiln-tx-unit-"));

describe("identity: base58 + Solana keypairs", () => {
  it("base58 matches Solana's well-known addresses", () => {
    assert.equal(b58encode(Buffer.alloc(32)), "11111111111111111111111111111111"); // system program
    assert.equal(b58decode(MEMO_PROGRAM_ID).length, 32);
    assert.equal(b58encode(b58decode(MEMO_PROGRAM_ID)), MEMO_PROGRAM_ID);
    for (let i = 0; i < 50; i++) {
      const b = Buffer.concat([Buffer.alloc(i % 3), randomBytes(i)]);
      assert.deepEqual(b58decode(b58encode(b)), b);
    }
    assert.throws(() => b58decode("0OIl"), /invalid character/);
  });
  it("solana-keygen JSON round-trips and rejects a mismatched public key", () => {
    const kp = generateKeypair();
    assert.equal(b58decode(kp.publicKey).length, 32);
    const json = keypairToSolanaJson(kp);
    assert.equal(JSON.parse(json).length, 64);
    assert.equal(keypairFromSolanaJson(json).publicKey, kp.publicKey);
    const arr = JSON.parse(json); arr[40] ^= 1;
    assert.throws(() => keypairFromSolanaJson(JSON.stringify(arr)), /does not match/);
  });
  it("ed25519 signatures verify only for the right key and message", () => {
    const a = generateKeypair(), b = generateKeypair();
    const sig = signBytes(a, "hello");
    assert.equal(verifyBytes(a.publicKey, "hello", sig), true);
    assert.equal(verifyBytes(a.publicKey, "hellp", sig), false);
    assert.equal(verifyBytes(b.publicKey, "hello", sig), false);
    assert.equal(verifyBytes(a.publicKey, "hello", Buffer.alloc(10)), false);
  });
});

describe("reed-solomon erasure coding", () => {
  it("rebuilds data from any k of k+m shards", () => {
    for (const [k, m, len] of [[4, 2, 1000], [16, 2, 4096], [10, 4, 333], [1, 1, 64], [32, 8, 128]]) {
      const data = Array.from({ length: k }, () => randomBytes(len));
      const parity = encodeParity(data, m, len);
      for (let trial = 0; trial < 10; trial++) {
        const all = [...data, ...parity].map((b, i) => [i, b]);
        // drop m random shards
        const drop = new Set();
        while (drop.size < m) drop.add(Math.floor(Math.random() * (k + m)));
        const shards = new Map(all.filter(([i]) => !drop.has(i)));
        const rebuilt = reconstructData(shards, k, m, len);
        for (const i of drop) if (i < k) assert.deepEqual(rebuilt.get(i), data[i], `k=${k} m=${m} shard ${i}`);
      }
    }
  });
  it("handles short (zero-padded) last data shards", () => {
    const data = [randomBytes(100), randomBytes(100), randomBytes(37)];
    const parity = encodeParity(data, 2, 100);
    const r = reconstructData(new Map([[0, data[0]], [3, parity[0]], [4, parity[1]]]), 3, 2, 100);
    assert.deepEqual(r.get(2).subarray(0, 37), data[2]);
    assert.ok(r.get(2).subarray(37).every((x) => x === 0));
    assert.deepEqual(r.get(1), data[1]);
  });
  it("refuses with fewer than k shards", () => {
    const data = Array.from({ length: 4 }, () => randomBytes(16));
    const p = encodeParity(data, 2, 16);
    assert.throws(() => reconstructData(new Map([[0, data[0]], [4, p[0]], [5, p[1]]]), 4, 2, 16), /need 4 shards/);
  });
});

describe("chunking + manifest", () => {
  it("geometry covers edge sizes", () => {
    const base = { chunkSize: 1024, dataShards: 4 };
    const g = (size) => geometry({ ...base, size });
    assert.deepEqual(g(0), { chunks: 0, stripes: 0 });
    assert.deepEqual(g(1), { chunks: 1, stripes: 1 });
    assert.deepEqual(g(1024), { chunks: 1, stripes: 1 });
    assert.deepEqual(g(1025), { chunks: 2, stripes: 1 });
    assert.deepEqual(g(4 * 1024 + 1), { chunks: 5, stripes: 2 });
    const m = { ...base, size: 4 * 1024 + 1 };
    assert.equal(stripeK(m, 0), 4); assert.equal(stripeK(m, 1), 1);
    assert.equal(chunkLen(m, 0), 1024); assert.equal(chunkLen(m, 4), 1);
  });
  it("hashes every chunk; parallel and single-thread hashing agree", async () => {
    const d = tmp(); const p = join(d, "f.bin");
    const data = randomBytes(1024 * 300 + 17);
    writeFileSync(p, data);
    const kp = generateKeypair();
    const one = await buildManifest(p, { chunkSize: 1024, sender: kp.publicKey, workers: 1 });
    const many = await buildManifest(p, { chunkSize: 1024, sender: kp.publicKey, workers: 4 });
    assert.equal(one.chunks.length, 301);
    assert.deepEqual(one.chunks, many.chunks);
    assert.equal(one.root, many.root);
    for (const c of [0, 150, 300]) {
      assert.equal(one.chunks[c], createHash("sha256").update(data.subarray(c * 1024, (c + 1) * 1024)).digest("hex"));
    }
  });
  it("canonical JSON and ids are stable and content-addressed", () => {
    assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
    assert.equal(manifestId({ a: 1, b: 2 }), manifestId({ b: 2, a: 1 }));
    assert.notEqual(manifestId({ a: 1 }), manifestId({ a: 2 }));
  });
  it("sanitizes names", () => {
    assert.equal(safeName("../../etc/passwd"), "passwd");
    assert.equal(safeName(".."), "file");
    assert.equal(safeName("a\u0000b"), "a_b");
  });
});

describe("signed manifests", () => {
  async function signed() {
    const d = tmp(); const p = join(d, "x.zip"); writeFileSync(p, randomBytes(5000));
    const kp = generateKeypair();
    return { kp, env: signManifest(await buildManifest(p, { chunkSize: 1024, sender: kp.publicKey }), kp) };
  }
  it("accepts a valid envelope", async () => {
    const { env } = await signed();
    assert.equal(verifySignedManifest(env), env.id);
  });
  it("rejects tampering, foreign signatures, bad hashes and untrusted senders", async () => {
    const { env, kp } = await signed();
    const clone = () => JSON.parse(JSON.stringify(env));
    let e = clone(); e.manifest.size += 1;
    assert.throws(() => verifySignedManifest(e), /chunk hash list|id does not match|signature/);
    e = clone(); e.manifest.chunks[0] = "0".repeat(64);
    assert.throws(() => verifySignedManifest(e), /root does not match/);
    e = clone(); delete e.id; e.manifest.name = "evil.sh";
    assert.throws(() => verifySignedManifest(e), /bad signature/);
    const other = generateKeypair();
    e = clone(); e.signature = signBytes(other, `kiln-transfer/1:${env.id}`).toString("base64");
    assert.throws(() => verifySignedManifest(e), /bad signature/);
    assert.throws(() => verifySignedManifest(env, { trust: [other.publicKey] }), /not trusted/);
    assert.equal(verifySignedManifest(env, { trust: [kp.publicKey] }), env.id);
    assert.throws(() => signManifest({ ...env.manifest, sender: other.publicKey }, kp), /sender must be/);
  });
});

describe("memo receipt (offline)", () => {
  it("builds a signed Memo-program tx naming the manifest id", () => {
    const kp = generateKeypair();
    const id = "cd".repeat(32);
    const r = buildMemoReceipt({ keypair: kp, manifestId: id, recentBlockhash: b58encode(Buffer.alloc(32, 9)) });
    assert.equal(r.memo, `kiln-transfer:${id}`);
    assert.equal(verifyMemoReceipt(r.transaction, id), true);
    assert.equal(verifyMemoReceipt(r.transaction, "ef".repeat(32)), false);
    const tx = Buffer.from(r.transaction, "base64"); tx[tx.length - 1] ^= 1;
    assert.equal(verifyMemoReceipt(tx.toString("base64"), id), false);
  });
  it("never targets mainnet", () => {
    for (const u of ["https://api.mainnet-beta.solana.com", "https://example.com/rpc", "http://10.0.0.5:8899"]) {
      assert.throws(() => checkRpcUrl(u), /never mainnet/);
    }
    for (const u of ["https://api.devnet.solana.com", "http://127.0.0.1:8899", "http://localhost:8899/"]) checkRpcUrl(u);
  });
});


describe("wire encryption (AES-256-GCM + X25519)", () => {
  it("round-trips a frame and rejects a flipped ciphertext byte", () => {
    const key = randomBytes(32);
    const send = new FrameCipher(key);
    const recv = new FrameCipher(key);
    const plain = Buffer.concat([Buffer.from([4]), randomBytes(1000)]);
    const ok = recv.open(send.seal(plain, { record: true }));
    assert.deepEqual(ok, plain);
    const boxed = send.seal(plain, { record: true });
    const bad = Buffer.from(boxed); bad[20] ^= 0x01;
    assert.throws(() => recv.open(bad), /authentication tag/);
  });
  it("issues unique, strictly increasing nonces and refuses reuse", () => {
    const key = randomBytes(32);
    const send = new FrameCipher(key);
    const recv = new FrameCipher(key);
    const seen = new Set();
    for (let i = 0; i < 1000; i++) {
      const w = send.seal(Buffer.from([1, i % 256]), { record: true });
      const n = w.subarray(0, 12).toString("hex");
      assert.equal(seen.has(n), false, `nonce repeated at ${i}`);
      seen.add(n);
      recv.open(w);
    }
    assert.equal(seen.size, 1000);
    assert.equal(send.sendCounter, 1000n);
    // replay of the last frame
    const last = send.seal(Buffer.from([1]), { record: true });
    recv.open(last);
    assert.throws(() => recv.open(last), /reused or out-of-order nonce/);
    // a lower counter, even with a valid-looking layout
    const low = Buffer.from(last);
    low.writeBigUInt64BE(1n, 4);
    assert.throws(() => recv.open(low), /reused or out-of-order nonce|authentication tag/);
  });
  it("binds derived keys to the signed identities (swapping the id changes the key)", () => {
    const a = generateKeypair(), b = generateKeypair(), c = generateKeypair();
    const hs = clientHandshake(a);
    const srv = serverHandshake(b, hs.payload);
    const fin = finishHandshake(hs.eph, hs.nonce, srv.payload, { expectReceiver: b.publicKey });
    const right = deriveCiphers({ shared: fin.shared, clientEph: hs.eph.publicKeyBytes, serverEph: fin.serverEph, clientId: a.publicKey, serverId: b.publicKey, nonce: hs.nonce, side: "client" });
    const wrong = deriveCiphers({ shared: fin.shared, clientEph: hs.eph.publicKeyBytes, serverEph: fin.serverEph, clientId: a.publicKey, serverId: c.publicKey, nonce: hs.nonce, side: "server" });
    const w = right.send.seal(Buffer.from([9, 8, 7]));
    assert.throws(() => wrong.recv.open(w), /authentication tag/);
    assert.throws(() => finishHandshake(hs.eph, hs.nonce, srv.payload, { expectReceiver: c.publicKey }), /expected/);
  });
  it("refuses an insecure mode off loopback", () => {
    assert.throws(() => requireEncryptOrLoopback(false, "8.8.8.8", "sendFile"), /only allowed on loopback/);
    requireEncryptOrLoopback(false, "127.0.0.1", "sendFile");
    requireEncryptOrLoopback(true, "8.8.8.8", "sendFile");
  });
});
