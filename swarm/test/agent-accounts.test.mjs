/**
 * Agent accounts + agent invite links (Lane C): real HTTP API, real
 * store, real ed25519 keys — no mocks. The model under test:
 *
 *   - an agent account is a FIRST-CLASS account (kind "agent", own
 *     namespace, own principal) sponsored by another account; the
 *     sponsor link is visibility, never control;
 *   - creation path (a): the sponsor's session creates one directly
 *     and hands over its first agent token (shown once);
 *   - creation path (b): the sponsor mints an invite LINK (hashed,
 *     single-use, 7-day); ANY agent holding it redeems UNAUTHENTICATED
 *     — the link is the bootstrap credential — choosing its own
 *     owner/name, and receives the account + a fresh agent token once;
 *   - the returned token works under the agent account's OWN
 *     principal; consumed/revoked links answer 404, expired 410;
 *   - the agent account signs in through the WALLET door once it
 *     links a wallet (Lane B verify resolves the owning account);
 *   - the pre-existing delegated-token model (kiln_agt_ under a
 *     human account) is unregressed.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeStateDir } from "./helpers.mjs";
import { startApiServer } from "../lib/httpapi.mjs";
import { loadApiToken } from "../lib/state.mjs";
import { accountByOwner } from "../lib/accounts.mjs";
import { createAgentInvite, redeemAgentInvite } from "../lib/agentinvites.mjs";

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
    publicKeyB64: pubRaw.toString("base64url"),
    solAddress: base58Encode(pubRaw),
    sign: (message) => cryptoSign(null, Buffer.from(message, "utf8"), privateKey).toString("base64url"),
  };
}

describe("agent accounts + invite links: HTTP API", () => {
  let api;
  after(() => { try { api?.server?.close(); } catch { /* already closed */ } });

  it("runs the full sponsor → agent-account lifecycle", async () => {
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

    // ---- sponsor + a second human for negative cases
    const pw = "sponsor-password-1";
    assert.equal((await call("POST", "/v1/accounts", { email: "sponsor@x.io", name: "Sponsor", owner: "sponsor", password: pw })).status, 201);
    assert.equal((await call("POST", "/v1/accounts", { email: "other@x.io", name: "Other", owner: "other", password: pw })).status, 201);
    const sponsorSess = (await call("POST", "/v1/accounts/login", { email: "sponsor@x.io", password: pw })).data.sessionToken;
    const otherSess = (await call("POST", "/v1/accounts/login", { email: "other@x.io", password: pw })).data.sessionToken;

    // the sponsor's delegated agent token (pre-existing model)
    const delegated = await call("POST", "/v1/accounts/me/agents", { name: "sponsor-helper" }, sponsorSess);
    assert.equal(delegated.status, 201);
    const delegatedToken = delegated.data.token;

    // ================= direct creation (path a) =================
    assert.equal((await call("POST", "/v1/accounts/me/agent-accounts", { owner: "x1", name: "X" })).status, 401, "unauthenticated");
    assert.equal((await call("POST", "/v1/accounts/me/agent-accounts", { owner: "x1", name: "X" }, delegatedToken)).status, 403, "a human's delegated token cannot sponsor");
    assert.equal((await call("POST", "/v1/accounts/me/agent-accounts", { owner: "x1", name: "X" }, opToken)).status, 400, "operator must name sponsorOwner");
    assert.equal((await call("POST", "/v1/accounts/me/agent-accounts", { owner: "x1", name: "X", sponsorOwner: "ghost" }, opToken)).status, 404, "unknown sponsorOwner");

    const created = await call("POST", "/v1/accounts/me/agent-accounts",
      { owner: "research-agent", name: "Research Agent", modelLabel: "claude" }, sponsorSess);
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal(created.data.account.kind, "agent");
    assert.equal(created.data.account.owner, "research-agent");
    assert.equal(created.data.account.email, null, "agent accounts carry no email by design");
    assert.equal(created.data.account.sponsor.owner, "sponsor");
    assert.equal(created.data.account.modelLabel, "claude");
    assert.equal(created.data.agent.accountId, created.data.account.id);
    const researchToken = created.data.token;
    assert.ok(researchToken.startsWith("kiln_agt_"));
    assert.ok(!created.text.includes("tokenHash") && !created.text.includes("passwordHash"));

    // duplicate owner is a 409 for every creation door
    assert.equal((await call("POST", "/v1/accounts/me/agent-accounts", { owner: "research-agent", name: "Dup" }, sponsorSess)).status, 409);
    assert.equal((await call("POST", "/v1/accounts/me/agent-accounts", { owner: "sponsor", name: "Dup" }, sponsorSess)).status, 409);

    // ---- the token resolves to the agent account's OWN principal
    const me = await call("GET", "/v1/accounts/me", null, researchToken);
    assert.equal(me.status, 200);
    assert.equal(me.data.account.owner, "research-agent");
    assert.equal(me.data.account.kind, "agent");
    assert.equal(me.data.principal.kind, "agent");
    assert.equal(me.data.sponsor.owner, "sponsor", "the child reads its sponsor link");
    assert.equal(me.data.sponsor.kind, "human");

    // ---- it acts under its own namespace, and only its own
    const ws = await call("POST", "/v1/workspaces", { owner: "research-agent", slug: "lab", name: "Lab" }, researchToken);
    assert.equal(ws.status, 201, JSON.stringify(ws.data));
    assert.equal((await call("POST", "/v1/workspaces", { owner: "sponsor", slug: "evil", name: "Evil" }, researchToken)).status, 403,
      "sponsorship is visibility, not control — the child cannot act as the sponsor either");

    // ---- sponsor side: list + /me surface
    const sponsored = await call("GET", "/v1/accounts/me/agent-accounts", null, sponsorSess);
    assert.deepEqual(sponsored.data.accounts.map((a) => a.owner), ["research-agent"]);
    const sponsorMe = await call("GET", "/v1/accounts/me", null, sponsorSess);
    assert.deepEqual(sponsorMe.data.sponsoredAgents.map((a) => a.owner), ["research-agent"]);
    assert.equal(sponsorMe.data.sponsor, null);
    assert.deepEqual((await call("GET", "/v1/accounts/me/agent-accounts", null, otherSess)).data.accounts, [],
      "another account's sponsored list is its own (empty)");

    // ---- delegated model unregressed: the helper token still acts as the sponsor
    const helperMe = await call("GET", "/v1/accounts/me", null, delegatedToken);
    assert.equal(helperMe.data.account.owner, "sponsor");
    assert.equal(helperMe.data.account.kind, "human");

    // ================= invite links (path b) =================
    const minted = await call("POST", "/v1/accounts/me/agent-invites", { label: "for my research agent" }, sponsorSess);
    assert.equal(minted.status, 201, JSON.stringify(minted.data));
    assert.equal(minted.data.invite.sponsorOwner, "sponsor");
    assert.equal(minted.data.invite.label, "for my research agent");
    assert.equal(minted.data.invite.status, "pending");
    assert.equal(minted.data.tokenShownOnce, true);
    const linkToken = minted.data.token;
    assert.ok(linkToken.startsWith("kiln_ainv_"));
    assert.ok(!minted.text.includes("tokenHash"));

    const list1 = await call("GET", "/v1/accounts/me/agent-invites", null, sponsorSess);
    assert.equal(list1.data.invites.length, 1);
    assert.ok(!list1.text.includes(linkToken), "the list never re-shows the token");

    // ---- redeem UNAUTHENTICATED: the link is the credential
    const redeemed = await call("POST", `/v1/agent-invites/${linkToken}/redeem`,
      { owner: "link-agent", name: "Link Agent", modelLabel: "some-framework" });
    assert.equal(redeemed.status, 201, JSON.stringify(redeemed.data));
    assert.equal(redeemed.data.account.kind, "agent");
    assert.equal(redeemed.data.account.sponsor.owner, "sponsor");
    assert.equal(redeemed.data.account.modelLabel, "some-framework");
    assert.equal(redeemed.data.invite.status, "accepted");
    assert.equal(redeemed.data.invite.redeemedBy, "link-agent");
    const linkAgentToken = redeemed.data.token;
    assert.ok(linkAgentToken.startsWith("kiln_agt_"));

    // the returned token works against protected routes under the new principal
    const linkMe = await call("GET", "/v1/accounts/me", null, linkAgentToken);
    assert.equal(linkMe.status, 200);
    assert.equal(linkMe.data.account.owner, "link-agent");
    assert.equal((await call("POST", "/v1/workspaces", { owner: "link-agent", slug: "ws", name: "WS" }, linkAgentToken)).status, 201);

    // ---- single-use: reuse + unknown tokens are the same 404
    assert.equal((await call("POST", `/v1/agent-invites/${linkToken}/redeem`, { owner: "again", name: "Again" })).status, 404, "consumed link is dead");
    assert.equal((await call("POST", "/v1/agent-invites/kiln_ainv_unknownunknown/redeem", { owner: "ghost", name: "Ghost" })).status, 404);

    // ---- sponsor sees the redemption linked
    const list2 = await call("GET", "/v1/accounts/me/agent-invites", null, sponsorSess);
    const accepted = list2.data.invites.find((i) => i.id === minted.data.invite.id);
    assert.equal(accepted.status, "accepted");
    assert.equal(accepted.redeemedAccountId, redeemed.data.account.id);
    const sponsored2 = await call("GET", "/v1/accounts/me/agent-accounts", null, sponsorSess);
    assert.deepEqual(sponsored2.data.accounts.map((a) => a.owner), ["research-agent", "link-agent"]);

    // ---- a failed redemption does NOT consume the link
    const mint2 = await call("POST", "/v1/accounts/me/agent-invites", {}, sponsorSess);
    const link2 = mint2.data.token;
    assert.equal((await call("POST", `/v1/agent-invites/${link2}/redeem`, { owner: "sponsor", name: "Taken" })).status, 409, "owner claimed");
    assert.equal((await call("POST", `/v1/agent-invites/${link2}/redeem`, { owner: "Bad Owner", name: "Bad" })).status, 400, "owner malformed");
    const retry = await call("POST", `/v1/agent-invites/${link2}/redeem`, { owner: "retry-agent", name: "Retry Agent" });
    assert.equal(retry.status, 201, "the link survived both failed attempts");

    // ---- reserved namespace (forge content, no account) refuses like public signup
    assert.equal((await call("POST", "/git/content-ns/seedrepo", null, opToken)).status, 201);
    const mint3 = await call("POST", "/v1/accounts/me/agent-invites", {}, sponsorSess);
    assert.equal((await call("POST", `/v1/agent-invites/${mint3.data.token}/redeem`, { owner: "content-ns", name: "Squatter" })).status, 409);
    assert.equal((await call("POST", `/v1/agent-invites/${mint3.data.token}/redeem`, { owner: "fresh-agent", name: "Fresh" })).status, 201,
      "…and the refused attempt did not consume it either");

    // ---- revoke: redemption fails; double-revoke is an honest 409; others cannot revoke yours
    const mint4 = await call("POST", "/v1/accounts/me/agent-invites", { label: "doomed" }, sponsorSess);
    assert.equal((await call("DELETE", `/v1/accounts/me/agent-invites/${mint4.data.invite.id}`, null, otherSess)).status, 404,
      "another sponsor's invite reads as missing");
    const revoked = await call("DELETE", `/v1/accounts/me/agent-invites/${mint4.data.invite.id}`, null, sponsorSess);
    assert.equal(revoked.status, 200);
    assert.equal(revoked.data.invite.status, "revoked");
    assert.equal((await call("POST", `/v1/agent-invites/${mint4.data.token}/redeem`, { owner: "late", name: "Late" })).status, 404, "revoked link is dead");
    assert.equal((await call("DELETE", `/v1/accounts/me/agent-invites/${mint4.data.invite.id}`, null, sponsorSess)).status, 409);

    // ---- operator door: mint + list + revoke naming sponsorOwner
    assert.equal((await call("POST", "/v1/accounts/me/agent-invites", { label: "no sponsor" }, opToken)).status, 400);
    const opMint = await call("POST", "/v1/accounts/me/agent-invites", { sponsorOwner: "sponsor", label: "op-minted" }, opToken);
    assert.equal(opMint.status, 201, JSON.stringify(opMint.data));
    const opRedeem = await call("POST", `/v1/agent-invites/${opMint.data.token}/redeem`, { owner: "op-agent", name: "Op Agent" });
    assert.equal(opRedeem.status, 201);
    assert.equal(opRedeem.data.account.sponsor.owner, "sponsor");
    const opList = await call("GET", "/v1/accounts/me/agent-invites?sponsorOwner=sponsor", null, opToken);
    assert.ok(opList.data.invites.some((i) => i.id === opMint.data.invite.id && i.status === "accepted"));

    // ---- sub-agent sponsorship: an agent account sponsors its own
    const subMint = await call("POST", "/v1/accounts/me/agent-invites", { label: "sub" }, linkAgentToken);
    assert.equal(subMint.status, 201, JSON.stringify(subMint.data));
    assert.equal(subMint.data.invite.sponsorOwner, "link-agent");
    const subRedeem = await call("POST", `/v1/agent-invites/${subMint.data.token}/redeem`, { owner: "sub-agent", name: "Sub Agent" });
    assert.equal(subRedeem.status, 201);
    assert.equal(subRedeem.data.account.sponsor.owner, "link-agent");
    const subDirect = await call("POST", "/v1/accounts/me/agent-accounts", { owner: "sub-direct", name: "Sub Direct" }, linkAgentToken);
    assert.equal(subDirect.status, 201);
    assert.equal(subDirect.data.account.sponsor.owner, "link-agent");

    // ================= wallet door for an agent account =================
    // A human's delegated token still cannot link the human's wallets…
    assert.equal((await call("POST", "/v1/accounts/me/wallets/challenge", { address: makeWallet().solAddress }, delegatedToken)).status, 403);
    // …but the agent account's OWN token manages its own identity.
    const w = makeWallet();
    const lc = await call("POST", "/v1/accounts/me/wallets/challenge", { address: w.solAddress }, researchToken);
    assert.equal(lc.status, 201, JSON.stringify(lc.data));
    const linked = await call("POST", "/v1/accounts/me/wallets", {
      address: w.solAddress, kind: "phantom", publicKey: w.publicKeyB64,
      challengeId: lc.data.challengeId, signature: w.sign(lc.data.message),
    }, researchToken);
    assert.equal(linked.status, 201, JSON.stringify(linked.data));

    // Lane B sign-in resolves the OWNING account — an agent account.
    const sc = await call("POST", "/v1/accounts/wallet/challenge", { address: w.solAddress });
    assert.equal(sc.status, 201);
    const si = await call("POST", "/v1/accounts/wallet/verify", {
      challengeId: sc.data.challengeId, address: w.solAddress, signature: w.sign(sc.data.message),
    });
    assert.equal(si.status, 200, JSON.stringify(si.data));
    assert.equal(si.data.account.owner, "research-agent");
    assert.equal(si.data.account.kind, "agent");
    const sessMe = await call("GET", "/v1/accounts/me", null, si.data.sessionToken);
    assert.equal(sessMe.status, 200);
    assert.equal(sessMe.data.principal.kind, "session");
    assert.equal(sessMe.data.account.owner, "research-agent");

    // ---- store hygiene: hashes at rest, never a raw secret
    const accountsRaw = readFileSync(join(dir, "accounts.json"), "utf8");
    const invitesRaw = readFileSync(join(dir, "agent-invites.json"), "utf8");
    assert.ok(accountsRaw.includes('"kind": "agent"'), "agent accounts recorded with their kind");
    for (const secret of [linkToken, mint2.data.token, mint3.data.token, researchToken, linkAgentToken, delegatedToken]) {
      assert.ok(!accountsRaw.includes(secret) && !invitesRaw.includes(secret), "no raw token in either store");
    }
    assert.ok(invitesRaw.includes("tokenHash"), "invite store holds hashes, not tokens");
  });

  it("expired invite links answer 410 (lib-level, short TTL)", async () => {
    const dir = makeStateDir();
    process.env.KILN_SWARM_API_PORT = "0";
    let localApi;
    try {
      localApi = await startApiServer(dir, { apiPort: 0 });
      const res = await fetch(localApi.url + "/v1/accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "exp@x.io", name: "Exp", owner: "exp-sponsor", password: "password-long-1" }),
      });
      assert.equal(res.status, 201);
    } finally {
      delete process.env.KILN_SWARM_API_PORT;
      try { localApi?.server?.close(); } catch { /* already closed */ }
    }
    const sponsor = accountByOwner(dir, "exp-sponsor");
    const { token } = createAgentInvite(dir, sponsor, { label: "short-lived" }, { ttlMs: 1 });
    await new Promise((r) => setTimeout(r, 15));
    assert.throws(
      () => redeemAgentInvite(dir, token, { owner: "too-late", name: "Too Late" }),
      (e) => e.status === 410
    );
    // …and an unknown token at the lib door is the same 404 as HTTP.
    assert.throws(
      () => redeemAgentInvite(dir, "kiln_ainv_nope", { owner: "x2", name: "X" }),
      (e) => e.status === 404
    );
  });
});
