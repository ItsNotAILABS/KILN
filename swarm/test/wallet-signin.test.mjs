/**
 * Wallet sign-in: the second login door. Real HTTP API, real ed25519
 * keys, real store — no mocks. A LINKED wallet signs its owner in
 * (challenge → signature → a normal kiln_sess_ session); everything
 * else is refused with linking's exact discipline: challenges burn on
 * any attempt, replay 404, expired 410, bad signature 403, and an
 * unlinked wallet — after a VALID signature — gets 403 with the
 * machine-readable reason "wallet_not_linked". The session is always
 * for the linked account, never for a claimed one.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { makeStateDir } from "./helpers.mjs";
import { startApiServer } from "../lib/httpapi.mjs";
import { loadApiToken } from "../lib/state.mjs";
import {
  createAccount, issueWalletChallenge, linkWallet,
  issueWalletSignInChallenge, verifyWalletSignIn,
} from "../lib/accounts.mjs";

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

describe("wallet sign-in: HTTP API", () => {
  let api;
  after(() => { try { api?.server?.close(); } catch { /* already closed */ } });

  it("signs linked wallets in and refuses every shortcut", async () => {
    const dir = makeStateDir();
    process.env.KILN_SWARM_API_PORT = "0";
    try {
      api = await startApiServer(dir, { apiPort: 0 });
    } finally {
      delete process.env.KILN_SWARM_API_PORT;
    }
    const base = api.url;
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

    const phantom = makeWallet(); // alice's, base58 address = key
    const local = makeWallet();   // bob's, 0x address + presented key
    const localAddr = "0x7eb9249d2d076833cfc89d4f6ec2bb9b93cb66b9";

    // Link both wallets through the existing Piece 5 flow.
    const linkVia = async (bearer, address, kind, w) => {
      const c = await call("POST", "/v1/accounts/me/wallets/challenge", { address }, bearer);
      assert.equal(c.status, 201, JSON.stringify(c.data));
      const r = await call("POST", "/v1/accounts/me/wallets", {
        address, kind, publicKey: w.publicKeyB64,
        challengeId: c.data.challengeId, signature: w.sign(c.data.message),
      }, bearer);
      assert.equal(r.status, 201, JSON.stringify(r.data));
    };
    await linkVia(alice, phantom.solAddress, "phantom", phantom);
    await linkVia(bob, localAddr, "local", local);

    const signInChallenge = async (address) => {
      const r = await call("POST", "/v1/accounts/wallet/challenge", { address });
      assert.equal(r.status, 201, JSON.stringify(r.data));
      assert.ok(r.data.message.startsWith("kiln-wallet-signin\n"), "own purpose tag");
      assert.ok(r.data.message.includes(`address:${address}`) || address.startsWith("0x"), "message names the address");
      assert.ok(!r.data.message.includes("account:"), "challenge never names an account before proof");
      return r.data;
    };

    // ---- happy path: Phantom-style (base58), NO bearer, NO publicKey
    const c1 = await signInChallenge(phantom.solAddress);
    const s1 = await call("POST", "/v1/accounts/wallet/verify", {
      challengeId: c1.challengeId, address: phantom.solAddress,
      signature: phantom.sign(c1.message),
    });
    assert.equal(s1.status, 200, JSON.stringify(s1.data));
    assert.ok(s1.data.sessionToken.startsWith("kiln_sess_"), "a normal session token");
    assert.equal(s1.data.account.owner, "alice");
    assert.equal(s1.data.wallet.address, phantom.solAddress);
    // the minted session works on a protected route
    const me1 = await call("GET", "/v1/accounts/me", null, s1.data.sessionToken);
    assert.equal(me1.status, 200);
    assert.equal(me1.data.account.owner, "alice");
    assert.equal(me1.data.principal.kind, "session");

    // ---- replay: the same challenge + signature is dead
    const replay = await call("POST", "/v1/accounts/wallet/verify", {
      challengeId: c1.challengeId, address: phantom.solAddress,
      signature: phantom.sign(c1.message),
    });
    assert.equal(replay.status, 404, "replayed sign-in challenge rejected");

    // ---- happy path: local 0x wallet, key presented (link discipline)
    const c2 = await signInChallenge(localAddr);
    const s2 = await call("POST", "/v1/accounts/wallet/verify", {
      challengeId: c2.challengeId, address: localAddr,
      publicKey: local.publicKeyB64, signature: local.sign(c2.message),
    });
    assert.equal(s2.status, 200, JSON.stringify(s2.data));
    assert.equal(s2.data.account.owner, "bob");
    assert.equal((await call("GET", "/v1/accounts/me", null, s2.data.sessionToken)).data.account.owner, "bob");

    // ---- happy path: local 0x wallet, key omitted (stored key used)
    const c2b = await signInChallenge(localAddr);
    const s2b = await call("POST", "/v1/accounts/wallet/verify", {
      challengeId: c2b.challengeId, address: localAddr,
      signature: local.sign(c2b.message),
    });
    assert.equal(s2b.status, 200, JSON.stringify(s2b.data));
    assert.equal(s2b.data.account.owner, "bob");

    // ---- cross-account: wallet is bob's; a claim of alice is ignored
    const c3 = await signInChallenge(localAddr);
    const s3 = await call("POST", "/v1/accounts/wallet/verify", {
      challengeId: c3.challengeId, address: localAddr,
      publicKey: local.publicKeyB64, signature: local.sign(c3.message),
      account: "alice", owner: "alice", accountId: "acct_claimed",
    });
    assert.equal(s3.status, 200, JSON.stringify(s3.data));
    assert.equal(s3.data.account.owner, "bob", "session is for the LINKED account, never a claimed one");
    assert.equal((await call("GET", "/v1/accounts/me", null, s3.data.sessionToken)).data.account.owner, "bob");

    // ---- unlinked: valid signature, no link → 403 wallet_not_linked
    const stranger = makeWallet();
    const c4 = await signInChallenge(stranger.solAddress);
    const s4 = await call("POST", "/v1/accounts/wallet/verify", {
      challengeId: c4.challengeId, address: stranger.solAddress,
      signature: stranger.sign(c4.message),
    });
    assert.equal(s4.status, 403, JSON.stringify(s4.data));
    assert.equal(s4.data.reason, "wallet_not_linked", "exact machine-readable reason");
    assert.equal(s4.data.code, "wallet_not_linked");
    assert.ok(s4.data.error.startsWith("wallet_not_linked"), "error text carries the reason too");
    assert.ok(!s4.data.sessionToken, "no session for an unlinked wallet");

    // ---- unlinked + BAD signature → plain 403, link state not revealed
    const c5 = await signInChallenge(stranger.solAddress);
    const s5 = await call("POST", "/v1/accounts/wallet/verify", {
      challengeId: c5.challengeId, address: stranger.solAddress,
      signature: stranger.sign("not the challenge"),
    });
    assert.equal(s5.status, 403);
    assert.equal(s5.data.reason, undefined, "bad signature never reveals link state");
    // and the failed attempt burned the challenge
    const s5b = await call("POST", "/v1/accounts/wallet/verify", {
      challengeId: c5.challengeId, address: stranger.solAddress,
      signature: stranger.sign(c5.message),
    });
    assert.equal(s5b.status, 404, "a failed attempt consumed the challenge");

    // ---- bad signature on a LINKED wallet → 403, no session
    const c6 = await signInChallenge(phantom.solAddress);
    const s6 = await call("POST", "/v1/accounts/wallet/verify", {
      challengeId: c6.challengeId, address: phantom.solAddress,
      signature: phantom.sign("kiln-wallet-signin\nforged"),
    });
    assert.equal(s6.status, 403);
    assert.ok(!s6.data.sessionToken);

    // ---- a LINK challenge cannot be spent as a sign-in challenge
    const lc = await call("POST", "/v1/accounts/me/wallets/challenge", { address: phantom.solAddress }, alice);
    assert.equal(lc.status, 201);
    const cross = await call("POST", "/v1/accounts/wallet/verify", {
      challengeId: lc.data.challengeId, address: phantom.solAddress,
      publicKey: phantom.publicKeyB64, signature: phantom.sign(lc.data.message),
    });
    assert.equal(cross.status, 404, "purpose separation: link challenges are not sign-in challenges");

    // ---- challenge for a malformed address → 400
    assert.equal((await call("POST", "/v1/accounts/wallet/challenge", { address: "no" })).status, 400);
    // ---- verify with a never-issued challenge → 404
    const ghost = await call("POST", "/v1/accounts/wallet/verify", {
      challengeId: "wsc_000000000000000000", address: phantom.solAddress,
      signature: phantom.sign("anything"),
    });
    assert.equal(ghost.status, 404);
  });

  it("expired sign-in challenges are refused (lib-level, short TTL)", async () => {
    const dir = makeStateDir();
    const acct = createAccount(dir, { email: "carol@x.io", name: "Carol", owner: "carol", password: "password-long-1" });
    const w = makeWallet();
    const lc = issueWalletChallenge(dir, acct.id, w.solAddress);
    linkWallet(dir, acct.id, {
      address: w.solAddress, kind: "phantom",
      publicKey: w.publicKeyB64, challengeId: lc.challengeId, signature: w.sign(lc.message),
    });
    const c = issueWalletSignInChallenge(dir, w.solAddress, { ttlMs: 1 });
    await new Promise((r) => setTimeout(r, 15));
    assert.throws(
      () => verifyWalletSignIn(dir, {
        address: w.solAddress, challengeId: c.challengeId, signature: w.sign(c.message),
      }),
      (e) => e.status === 410
    );
    // lib-level happy path + unlinked reason, without HTTP
    const c2 = issueWalletSignInChallenge(dir, w.solAddress);
    const ok = verifyWalletSignIn(dir, {
      address: w.solAddress, challengeId: c2.challengeId, signature: w.sign(c2.message),
    });
    assert.equal(ok.account.owner, "carol");
    assert.ok(ok.sessionToken.startsWith("kiln_sess_"));
    const stranger = makeWallet();
    const c3 = issueWalletSignInChallenge(dir, stranger.solAddress);
    assert.throws(
      () => verifyWalletSignIn(dir, {
        address: stranger.solAddress, challengeId: c3.challengeId, signature: stranger.sign(c3.message),
      }),
      (e) => e.status === 403 && e.reason === "wallet_not_linked"
    );
  });
});
