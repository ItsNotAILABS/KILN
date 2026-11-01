/**
 * Wallet identity binding + encrypted backup: real HTTP API, real
 * ed25519 keys (node:crypto), real store — no mocks. The negative
 * cases are the point: proof before link, challenges burn on any
 * attempt, one account per address, and the backup blob is opaque
 * everywhere it is stored or answered.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeStateDir } from "./helpers.mjs";
import { startApiServer } from "../lib/httpapi.mjs";
import { loadApiToken } from "../lib/state.mjs";
import { issueWalletChallenge, linkWallet } from "../lib/accounts.mjs";
import { createAccount } from "../lib/accounts.mjs";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Encode(buf) {
  const digits = [0];
  for (const byte of buf) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
  }
  let out = "";
  for (let i = 0; i < buf.length && buf[i] === 0; i++) out += "1";
  return out + digits.reverse().map((d) => B58[d]).join("");
}

function makeWallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  const pubRaw = Buffer.from(jwk.x, "base64url");
  return {
    privateKey,
    pubRaw,
    publicKeyB64: pubRaw.toString("base64url"),
    solAddress: base58Encode(pubRaw),
    sign: (message) => cryptoSign(null, Buffer.from(message, "utf8"), privateKey).toString("base64url"),
  };
}

describe("wallet binding: HTTP API", () => {
  let api;
  after(() => { try { api?.server?.close(); } catch { /* already closed */ } });

  it("links, restores, backs up, and refuses every shortcut", async () => {
    const dir = makeStateDir();
    process.env.KILN_SWARM_API_PORT = "0";
    try {
      api = await startApiServer(dir, { apiPort: 0 });
    } finally {
      delete process.env.KILN_SWARM_API_PORT;
    }
    const base = api.url;
    const opToken = loadApiToken(dir);
    const call = async (method, path, body, bearer) => {
      const res = await fetch(base + path, {
        method,
        headers: {
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      return { status: res.status, text, data: JSON.parse(text || "{}") };
    };

    const pw = "password-long-1";
    await call("POST", "/v1/accounts", { email: "alice@x.io", name: "Alice", owner: "alice", password: pw });
    await call("POST", "/v1/accounts", { email: "bob@x.io", name: "Bob", owner: "bob", password: pw });
    const alice = (await call("POST", "/v1/accounts/login", { email: "alice@x.io", password: pw })).data.sessionToken;
    const bob = (await call("POST", "/v1/accounts/login", { email: "bob@x.io", password: pw })).data.sessionToken;
    const aliceAgent = (await call("POST", "/v1/accounts/me/agents", { name: "a1", scopes: ["forge"] }, alice)).data.token;

    const phantom = makeWallet(); // address = base58(pubkey)
    const local = makeWallet();   // 0x-style address, unrelated to the key bytes
    const localAddr = "0x7eb9249d2d076833cfc89d4f6ec2bb9b93cb66b9";
    const challengeFor = async (bearer, address) => {
      const r = await call("POST", "/v1/accounts/me/wallets/challenge", { address }, bearer);
      assert.equal(r.status, 201, JSON.stringify(r.data));
      return r.data;
    };

    // ---- happy path: phantom (base58 address IS the key)
    const c1 = await challengeFor(alice, phantom.solAddress);
    const link1 = await call("POST", "/v1/accounts/me/wallets", {
      address: phantom.solAddress, kind: "phantom",
      publicKey: phantom.publicKeyB64, challengeId: c1.challengeId,
      signature: phantom.sign(c1.message),
    }, alice);
    assert.equal(link1.status, 201, JSON.stringify(link1.data));
    assert.equal(link1.data.wallet.address, phantom.solAddress);
    assert.equal(link1.data.wallet.hasBackup, false);

    // ---- replay: the same challenge + signature is dead
    const replay = await call("POST", "/v1/accounts/me/wallets", {
      address: phantom.solAddress, kind: "phantom",
      publicKey: phantom.publicKeyB64, challengeId: c1.challengeId,
      signature: phantom.sign(c1.message),
    }, alice);
    assert.equal(replay.status, 404, "replayed challenge rejected");

    // ---- happy path: local 0x wallet (case-insensitive uniqueness)
    const c2 = await challengeFor(alice, localAddr.toUpperCase().replace("0X", "0x"));
    const link2 = await call("POST", "/v1/accounts/me/wallets", {
      address: localAddr, kind: "local",
      publicKey: local.publicKeyB64, challengeId: c2.challengeId,
      signature: local.sign(c2.message),
    }, alice);
    assert.equal(link2.status, 201, JSON.stringify(link2.data));
    assert.equal(link2.data.wallet.address, localAddr, "0x addresses normalize to lowercase");

    // ---- restore surface: list + /me
    const list = await call("GET", "/v1/accounts/me/wallets", null, alice);
    assert.equal(list.data.wallets.length, 2);
    const me = await call("GET", "/v1/accounts/me", null, alice);
    assert.equal(me.data.wallets.length, 2);
    assert.equal(me.data.hasWalletBackup, false);
    // agents may read the list; the operator is not an account
    assert.equal((await call("GET", "/v1/accounts/me/wallets", null, aliceAgent)).status, 200);
    assert.equal((await call("GET", "/v1/accounts/me/wallets", null, opToken)).status, 403);

    // ---- bad signature → 403, and the failed attempt burns the challenge
    const c3 = await challengeFor(alice, makeWallet().solAddress);
    const w3 = makeWallet();
    const badSig = await call("POST", "/v1/accounts/me/wallets", {
      address: w3.solAddress, kind: "phantom",
      publicKey: w3.publicKeyB64, challengeId: c3.challengeId,
      signature: w3.sign("kiln-wallet-link\nsome other message"),
    }, alice);
    assert.equal(badSig.status, 400, "challenge was issued for a different address");
    const c3b = await challengeFor(alice, w3.solAddress);
    const wrongMsg = await call("POST", "/v1/accounts/me/wallets", {
      address: w3.solAddress, kind: "phantom",
      publicKey: w3.publicKeyB64, challengeId: c3b.challengeId,
      signature: w3.sign("not the challenge"),
    }, alice);
    assert.equal(wrongMsg.status, 403, "bad signature is a 403");
    const afterBurn = await call("POST", "/v1/accounts/me/wallets", {
      address: w3.solAddress, kind: "phantom",
      publicKey: w3.publicKeyB64, challengeId: c3b.challengeId,
      signature: w3.sign(c3b.message),
    }, alice);
    assert.equal(afterBurn.status, 404, "a failed attempt consumed the challenge — correct signature now replays to 404");

    // ---- base58 binding: the presented key must BE the address
    const c4 = await challengeFor(alice, phantom.solAddress);
    const impostor = makeWallet();
    const wrongKey = await call("POST", "/v1/accounts/me/wallets", {
      address: phantom.solAddress, kind: "phantom",
      publicKey: impostor.publicKeyB64, challengeId: c4.challengeId,
      signature: impostor.sign(c4.message),
    }, alice);
    assert.equal(wrongKey.status, 400, "a base58 address only accepts its own key");

    // ---- cross-account conflict → 409 (proof first: bob signs with the same key)
    const c5 = await challengeFor(bob, phantom.solAddress);
    const conflict = await call("POST", "/v1/accounts/me/wallets", {
      address: phantom.solAddress, kind: "phantom",
      publicKey: phantom.publicKeyB64, challengeId: c5.challengeId,
      signature: phantom.sign(c5.message),
    }, bob);
    assert.equal(conflict.status, 409, "one account per wallet address");
    // bob's own list stays empty; alice's link untouched
    assert.equal((await call("GET", "/v1/accounts/me/wallets", null, bob)).data.wallets.length, 0);
    assert.equal((await call("GET", "/v1/accounts/me/wallets", null, alice)).data.wallets.length, 2);

    // ---- identity writes are session-only
    assert.equal((await call("POST", "/v1/accounts/me/wallets/challenge", { address: localAddr }, aliceAgent)).status, 403);
    assert.equal((await call("DELETE", `/v1/accounts/me/wallets/${phantom.solAddress}`, null, aliceAgent)).status, 403);

    // ---- encrypted backup: round-trip, opacity, session-only
    const SECRET = "raw-local-secret-key-material-0123456789abcdef";
    // The client encrypts before PUT; here a stand-in transform whose
    // output provably does not contain the secret.
    const blob = Buffer.from([...SECRET].reverse().join(""), "utf8").toString("base64");
    assert.ok(!blob.includes(SECRET));
    const kdf = { algo: "argon2id", salt: "c2FsdA", ops: 3, memKiB: 65536 };
    const put = await call("PUT", "/v1/accounts/me/wallet-backup", { blob, kdf }, alice);
    assert.equal(put.status, 200, JSON.stringify(put.data));
    assert.ok(!put.text.includes(blob), "PUT response never echoes the blob");
    const got = await call("GET", "/v1/accounts/me/wallet-backup", null, alice);
    assert.equal(got.status, 200);
    assert.equal(got.data.backup.blob, blob);
    assert.deepEqual(got.data.backup.kdf, kdf);
    // restore flags flip
    const me2 = await call("GET", "/v1/accounts/me", null, alice);
    assert.equal(me2.data.hasWalletBackup, true);
    assert.equal(me2.data.wallets.find((w) => w.kind === "local").hasBackup, true);
    assert.equal(me2.data.wallets.find((w) => w.kind === "phantom").hasBackup, false, "backup belongs to the local wallet");
    // non-owner sessions and agents get nothing
    assert.equal((await call("GET", "/v1/accounts/me/wallet-backup", null, bob)).data.backup, null);
    assert.equal((await call("GET", "/v1/accounts/me/wallet-backup", null, aliceAgent)).status, 403);
    assert.equal((await call("PUT", "/v1/accounts/me/wallet-backup", { blob, kdf }, aliceAgent)).status, 403);
    // opacity on disk: the store holds the blob but never the secret;
    // no audit/log artifact in the state dir contains the secret either
    const storeRaw = readFileSync(join(dir, "accounts.json"), "utf8");
    assert.ok(storeRaw.includes(blob), "blob is what is stored");
    assert.ok(!storeRaw.includes(SECRET), "plaintext secret never reaches the store");
    const auditPath = join(dir, "forge-audit.jsonl");
    if (existsSync(auditPath)) {
      const auditRaw = readFileSync(auditPath, "utf8");
      assert.ok(!auditRaw.includes(SECRET) && !auditRaw.includes(blob), "no audit line carries secret or blob");
    }

    // ---- unlink: bob can't, alice can; the address frees up after
    assert.equal((await call("DELETE", `/v1/accounts/me/wallets/${phantom.solAddress}`, null, bob)).status, 404);
    assert.equal((await call("DELETE", `/v1/accounts/me/wallets/${phantom.solAddress}`, null, alice)).status, 200);
    assert.equal((await call("DELETE", `/v1/accounts/me/wallets/${phantom.solAddress}`, null, alice)).status, 404);
    const c6 = await challengeFor(bob, phantom.solAddress);
    const relinked = await call("POST", "/v1/accounts/me/wallets", {
      address: phantom.solAddress, kind: "phantom",
      publicKey: phantom.publicKeyB64, challengeId: c6.challengeId,
      signature: phantom.sign(c6.message),
    }, bob);
    assert.equal(relinked.status, 201, "after unlink, another account may link the address");
  });

  it("expired challenges are refused (lib-level, short TTL)", async () => {
    const dir = makeStateDir();
    const acct = createAccount(dir, { email: "carol@x.io", name: "Carol", owner: "carol", password: "password-long-1" });
    const w = makeWallet();
    const c = issueWalletChallenge(dir, acct.id, w.solAddress, { ttlMs: 1 });
    await new Promise((r) => setTimeout(r, 15));
    assert.throws(
      () => linkWallet(dir, acct.id, {
        address: w.solAddress, kind: "phantom",
        publicKey: w.publicKeyB64, challengeId: c.challengeId, signature: w.sign(c.message),
      }),
      (e) => e.status === 410
    );
  });
});
