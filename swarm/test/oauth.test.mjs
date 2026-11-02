/**
 * OAuth sign-in (Google + X): real HTTP API, real accounts store,
 * provider stubbed at the config seam — the daemon's token/userinfo
 * URLs are pointed at a local stub server via the
 * KILN_OAUTH_<PROVIDER>_<TOKEN|USERINFO>_URL env overrides, so the
 * full flow (start → state/PKCE → callback → code exchange →
 * identity resolution → handoff/pending → session) runs for real
 * against deterministic provider identities.
 *
 * The contract under test (swarm/docs/ACCOUNTS.md, OAuth section):
 * resolution order provider-link → (Google only, verified email
 * only) HMAC email match → pending handle pick; a session NEVER
 * travels in a URL (one-time handoff codes do); states/pending/
 * handoffs are hashed, single-use, short-TTL; a provider with no
 * daemon credentials answers an honest 503 provider_not_configured.
 */
import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeStateDir } from "./helpers.mjs";
import { startApiServer } from "../lib/httpapi.mjs";
import {
  startOAuth, handleOAuthCallback, redeemOAuthHandoff,
} from "../lib/accounts.mjs";

// ---- provider stub -------------------------------------------------
const stubState = {
  googleIdentity: null, xIdentity: null,
  lastGoogleToken: null, lastXToken: null, lastXAuth: null,
};
const stub = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const sendJson = (code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { "content-type": "application/json" });
    res.end(body);
  };
  let body = "";
  for await (const chunk of req) body += chunk;
  if (url.pathname === "/google/token") {
    stubState.lastGoogleToken = Object.fromEntries(new URLSearchParams(body));
    return sendJson(200, { access_token: "google-stub-access", token_type: "Bearer" });
  }
  if (url.pathname === "/google/userinfo") {
    if (req.headers.authorization !== "Bearer google-stub-access") return sendJson(401, {});
    return sendJson(200, stubState.googleIdentity || {});
  }
  if (url.pathname === "/x/token") {
    stubState.lastXToken = Object.fromEntries(new URLSearchParams(body));
    stubState.lastXAuth = req.headers.authorization || null;
    return sendJson(200, { access_token: "x-stub-access", token_type: "Bearer" });
  }
  if (url.pathname === "/x/me") {
    if (req.headers.authorization !== "Bearer x-stub-access") return sendJson(401, {});
    return sendJson(200, { data: stubState.xIdentity || {} });
  }
  return sendJson(404, {});
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const stubBase = `http://127.0.0.1:${stub.address().port}`;
after(() => { try { stub.close(); } catch { /* already closed */ } });

const GOOGLE_ENV = {
  KILN_OAUTH_GOOGLE_CLIENT_ID: "google-client-id",
  KILN_OAUTH_GOOGLE_CLIENT_SECRET: "google-client-secret",
  KILN_OAUTH_GOOGLE_TOKEN_URL: `${stubBase}/google/token`,
  KILN_OAUTH_GOOGLE_USERINFO_URL: `${stubBase}/google/userinfo`,
  KILN_OAUTH_GOOGLE_AUTH_URL: "https://accounts.google.com/o/oauth2/v2/auth",
};
const X_ENV = {
  KILN_OAUTH_X_CLIENT_ID: "x-client-id",
  KILN_OAUTH_X_CLIENT_SECRET: "x-client-secret",
  KILN_OAUTH_X_TOKEN_URL: `${stubBase}/x/token`,
  KILN_OAUTH_X_USERINFO_URL: `${stubBase}/x/me`,
  KILN_OAUTH_X_AUTH_URL: "https://twitter.com/i/oauth2/authorize",
};
function setEnv(map) {
  for (const [k, v] of Object.entries(map)) {
    if (v === null) delete process.env[k]; else process.env[k] = v;
  }
}

// ---- shared HTTP driver ---------------------------------------------
let api; let dir;
before(async () => {
  dir = makeStateDir();
  setEnv(GOOGLE_ENV); setEnv(X_ENV);
  api = await startApiServer(dir, { apiPort: 0 });
});
after(() => { try { api?.server?.close(); } catch { /* already closed */ } });

async function call(method, path, body, bearer) {
  const res = await fetch(api.url + path, {
    method, redirect: "manual",
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text || "{}"); } catch { /* redirect bodies are empty */ }
  return { status: res.status, location: res.headers.get("location"), data, text };
}

/** Run start and hand back the provider URL's params (incl. state). */
async function startFlow(provider, ret = "/login") {
  const r = await call("GET", `/v1/accounts/oauth/${provider}/start?return=${encodeURIComponent(ret)}`);
  assert.equal(r.status, 302, `start should redirect (got ${r.status}: ${r.text})`);
  return new URL(r.location);
}

async function callbackFlow(provider, code, state) {
  return call("GET", `/v1/accounts/oauth/${provider}/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
}

function fragmentParam(location, name) {
  const u = new URL(location, "http://app.local");
  assert.ok(u.hash, `redirect should carry a fragment: ${location}`);
  return new URLSearchParams(u.hash.slice(1)).get(name);
}

describe("oauth: google", () => {
  it("email-match sign-in → handoff → session; subject link takes over after", async () => {
    const pw = "password-long-1";
    const su = await call("POST", "/v1/accounts", { email: "alice@x.io", name: "Alice", owner: "alice", password: pw });
    assert.equal(su.status, 201, JSON.stringify(su.data));

    stubState.googleIdentity = { sub: "g-sub-1", email: "alice@x.io", email_verified: true, name: "Alice G" };
    const authUrl = await startFlow("google", "/dashboard");
    // The authorization URL carries the locked contract pieces.
    assert.equal(authUrl.searchParams.get("client_id"), "google-client-id");
    assert.equal(authUrl.searchParams.get("redirect_uri"),
      "https://kiln.pocketnova.app/api/forge/v1/accounts/oauth/google/callback");
    assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
    const challenge = authUrl.searchParams.get("code_challenge");
    assert.ok(challenge, "PKCE challenge present");
    const state = authUrl.searchParams.get("state");
    assert.ok(state, "state present");

    const cb = await callbackFlow("google", "code-1", state);
    assert.equal(cb.status, 302, JSON.stringify(cb.data));
    assert.ok(cb.location.startsWith("/dashboard#oauth_handoff="), `handoff redirect to the return path: ${cb.location}`);
    assert.ok(!cb.location.includes("kiln_sess_"), "a session token NEVER travels in a URL");
    // The code exchange really carried the PKCE verifier for this state.
    assert.equal(stubState.lastGoogleToken.code, "code-1");
    assert.equal(
      createHash("sha256").update(stubState.lastGoogleToken.code_verifier, "utf8").digest("base64url"),
      challenge, "token exchange sent the verifier whose S256 hash was the challenge");

    const code1 = fragmentParam(cb.location, "oauth_handoff");
    const ho = await call("POST", "/v1/accounts/oauth/handoff", { code: code1 });
    assert.equal(ho.status, 200, JSON.stringify(ho.data));
    assert.equal(ho.data.account.owner, "alice");
    assert.ok(ho.data.sessionToken.startsWith("kiln_sess_"));
    const me = await call("GET", "/v1/accounts/me", null, ho.data.sessionToken);
    assert.equal(me.status, 200);
    assert.equal(me.data.account.owner, "alice");
    assert.deepEqual(me.data.account.oauthLinks.map((l) => [l.provider, l.subject]),
      [["google", "g-sub-1"]], "the provider link was recorded on the email-matched account");

    // Handoff replay → 404 (consumed on the successful attempt).
    const replay = await call("POST", "/v1/accounts/oauth/handoff", { code: code1 });
    assert.equal(replay.status, 404, "replayed handoff rejected");

    // State replay → 400 (consumed by the first callback).
    const sreplay = await callbackFlow("google", "code-1", state);
    assert.equal(sreplay.status, 400, "replayed state rejected");

    // Second login: same subject, DIFFERENT (unverified) email —
    // the stored subject link resolves it, no email match needed.
    stubState.googleIdentity = { sub: "g-sub-1", email: "alice-other@y.io", email_verified: false };
    const auth2 = await startFlow("google");
    const cb2 = await callbackFlow("google", "code-2", auth2.searchParams.get("state"));
    assert.equal(cb2.status, 302);
    const ho2 = await call("POST", "/v1/accounts/oauth/handoff", { code: fragmentParam(cb2.location, "oauth_handoff") });
    assert.equal(ho2.status, 200, JSON.stringify(ho2.data));
    assert.equal(ho2.data.account.owner, "alice", "subject link resolves the second login");
  });

  it("unverified email does NOT merge; pending completes without binding it", async () => {
    stubState.googleIdentity = { sub: "g-sub-2", email: "alice@x.io", email_verified: false };
    const auth = await startFlow("google");
    const cb = await callbackFlow("google", "code-3", auth.searchParams.get("state"));
    assert.equal(cb.status, 302);
    assert.ok(cb.location.includes("#oauth_pending="), `unverified email falls through to pending: ${cb.location}`);
    const pendingToken = fragmentParam(cb.location, "oauth_pending");
    const done = await call("POST", "/v1/accounts/oauth/complete", {
      pendingToken, owner: "alice-g", name: "Alice Via Google",
    });
    assert.equal(done.status, 200, JSON.stringify(done.data));
    assert.equal(done.data.account.owner, "alice-g");
    assert.equal(done.data.account.emailBound, false, "an unverified provider email is never bound");
    assert.deepEqual(done.data.account.oauthLinks.map((l) => [l.provider, l.subject]),
      [["google", "g-sub-2"]], "the provider link is the account's door");
    // Alice's account was NOT merged: her email still signs in as her.
    const login = await call("POST", "/v1/accounts/login", { email: "alice@x.io", password: "password-long-1" });
    assert.equal(login.data.account.owner, "alice");
    // The consumed pending token is dead.
    const again = await call("POST", "/v1/accounts/oauth/complete", {
      pendingToken, owner: "alice-g2", name: "Again",
    });
    assert.equal(again.status, 404, "pending token is single-use");
  });

  it("pending → complete mints a session and binds a VERIFIED email; owner-taken 409 keeps pending alive", async () => {
    stubState.googleIdentity = { sub: "g-sub-3", email: "carol@x.io", email_verified: true, name: "Carol" };
    const auth = await startFlow("google");
    const cb = await callbackFlow("google", "code-4", auth.searchParams.get("state"));
    const pendingToken = fragmentParam(cb.location, "oauth_pending");
    assert.ok(pendingToken, "no account matched → pending");

    const taken = await call("POST", "/v1/accounts/oauth/complete", {
      pendingToken, owner: "alice", name: "Carol",
    });
    assert.equal(taken.status, 409, "owner already claimed");
    const done = await call("POST", "/v1/accounts/oauth/complete", {
      pendingToken, owner: "carol", name: "Carol",
    });
    assert.equal(done.status, 200, `pending survived the 409 and completed: ${JSON.stringify(done.data)}`);
    assert.equal(done.data.account.emailBound, true, "verified email binds (encrypted) at completion");
    assert.equal(done.data.account.email, "c•••@x.io", "only the masked form ever leaves the daemon");
    assert.ok(done.data.sessionToken.startsWith("kiln_sess_"));
    const me = await call("GET", "/v1/accounts/me", null, done.data.sessionToken);
    assert.equal(me.data.account.owner, "carol");

    // The store file never holds a plaintext provider email.
    const raw = readFileSync(join(dir, "accounts.json"), "utf8");
    assert.ok(!raw.includes("carol@x.io") && !raw.includes("alice@x.io"),
      "accounts.json carries no plaintext emails");
    assert.ok(!raw.includes("google-client-secret"), "no provider secrets at rest in the store");
  });

  it("not-configured start answers an honest 503 provider_not_configured", async () => {
    setEnv({ KILN_OAUTH_GOOGLE_CLIENT_ID: null, KILN_OAUTH_GOOGLE_CLIENT_SECRET: null });
    try {
      const r = await call("GET", "/v1/accounts/oauth/google/start?return=/login");
      assert.equal(r.status, 503);
      assert.deepEqual(r.data, { error: "provider_not_configured", provider: "google" });
    } finally {
      setEnv(GOOGLE_ENV);
    }
    const unknown = await call("GET", "/v1/accounts/oauth/github/start");
    assert.equal(unknown.status, 404, "unknown provider is a plain 404");
  });
});

describe("oauth: expiry + lib-level seams", () => {
  const fakeFetchFor = (identity) => async (url) => {
    const isToken = String(url).includes("token");
    const payload = isToken ? { access_token: "lib-stub-access" } : identity;
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
  const libEnv = { KILN_OAUTH_GOOGLE_CLIENT_ID: "id", KILN_OAUTH_GOOGLE_CLIENT_SECRET: "secret" };

  it("expired state answers 410 and a state is single-use", async () => {
    const d = makeStateDir();
    const started = startOAuth(d, "google", { returnPath: "/login" }, { env: libEnv, stateTtlMs: 1 });
    const state = new URL(started.authorizationUrl).searchParams.get("state");
    await new Promise((r) => setTimeout(r, 15));
    await assert.rejects(
      () => handleOAuthCallback(d, "google", { code: "c", state },
        { env: libEnv, fetchImpl: fakeFetchFor({ sub: "s1", email_verified: false }) }),
      (e) => e.status === 410);
  });

  it("expired handoff answers 410", async () => {
    const d = makeStateDir();
    const { createAccount } = await import("../lib/accounts.mjs");
    createAccount(d, { email: "erin@x.io", name: "Erin", owner: "erin", password: "password-long-1" });
    const started = startOAuth(d, "google", { returnPath: "/login" }, { env: libEnv });
    const state = new URL(started.authorizationUrl).searchParams.get("state");
    const r = await handleOAuthCallback(d, "google", { code: "c", state }, {
      env: libEnv, handoffTtlMs: 1,
      fetchImpl: fakeFetchFor({ sub: "g-erin", email: "erin@x.io", email_verified: true }),
    });
    assert.equal(r.kind, "handoff");
    await new Promise((res) => setTimeout(res, 15));
    assert.throws(() => redeemOAuthHandoff(d, { code: r.handoffCode }), (e) => e.status === 410);
    assert.throws(() => redeemOAuthHandoff(d, { code: r.handoffCode }), (e) => e.status === 404,
      "the expired attempt consumed the handoff");
    assert.throws(() => redeemOAuthHandoff(d, { code: "kiln_oauth_nope" }), (e) => e.status === 404);
  });
});


describe("oauth: x", () => {
  it("first X login goes to pending; completion links the subject; second login rides the link", async () => {
    stubState.xIdentity = { id: "x-user-1", username: "frankx", name: "Frank X" };
    const auth = await startFlow("x", "/home");
    assert.equal(auth.searchParams.get("client_id"), "x-client-id");
    assert.equal(auth.searchParams.get("redirect_uri"),
      "https://kiln.pocketnova.app/api/forge/v1/accounts/oauth/x/callback");
    assert.equal(auth.searchParams.get("code_challenge_method"), "S256");

    const cb = await callbackFlow("x", "x-code-1", auth.searchParams.get("state"));
    assert.equal(cb.status, 302);
    assert.ok(cb.location.startsWith("/home#oauth_pending="),
      `X has no reliable email, so a first login can only be pending: ${cb.location}`);
    // The token exchange used Basic client auth + the PKCE verifier.
    const expectedBasic = `Basic ${Buffer.from("x-client-id:x-client-secret").toString("base64")}`;
    assert.equal(stubState.lastXAuth, expectedBasic, "X token exchange authenticates with Basic client credentials");
    assert.ok(stubState.lastXToken.code_verifier, "X token exchange carried the PKCE verifier");

    const pendingToken = fragmentParam(cb.location, "oauth_pending");
    const done = await call("POST", "/v1/accounts/oauth/complete", {
      pendingToken, owner: "frank", name: "Frank",
    });
    assert.equal(done.status, 200, JSON.stringify(done.data));
    assert.equal(done.data.account.owner, "frank");
    assert.equal(done.data.account.emailBound, false, "an X-born account has no email binding");
    assert.deepEqual(done.data.account.oauthLinks.map((l) => [l.provider, l.subject]),
      [["x", "x-user-1"]]);
    const me = await call("GET", "/v1/accounts/me", null, done.data.sessionToken);
    assert.equal(me.data.account.owner, "frank");

    // Second X login: same subject → link → handoff → same account.
    const auth2 = await startFlow("x");
    const cb2 = await callbackFlow("x", "x-code-2", auth2.searchParams.get("state"));
    assert.equal(cb2.status, 302);
    assert.ok(cb2.location.includes("#oauth_handoff="), `subject link resolves: ${cb2.location}`);
    const ho = await call("POST", "/v1/accounts/oauth/handoff", {
      code: fragmentParam(cb2.location, "oauth_handoff"),
    });
    assert.equal(ho.status, 200, JSON.stringify(ho.data));
    assert.equal(ho.data.account.owner, "frank", "X subject link signs into the same ONE account");
  });

  it("X not-configured start answers 503 provider_not_configured for x", async () => {
    setEnv({ KILN_OAUTH_X_CLIENT_ID: null, KILN_OAUTH_X_CLIENT_SECRET: null });
    try {
      const r = await call("GET", "/v1/accounts/oauth/x/start");
      assert.equal(r.status, 503);
      assert.deepEqual(r.data, { error: "provider_not_configured", provider: "x" });
    } finally {
      setEnv(X_ENV);
    }
  });
});
