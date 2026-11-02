/**
 * KILN accounts + agent identities: real HTTP API on an ephemeral port,
 * real scrypt, real store — no mocks. The negative cases are the point:
 * one account's principals must never touch another account's namespace.
 * Mirrors test/workspaces.test.mjs's harness.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeStateDir } from "./helpers.mjs";
import { startApiServer } from "../lib/httpapi.mjs";
import { loadApiToken } from "../lib/state.mjs";

describe("accounts: HTTP API", () => {
  let api;
  after(() => { try { api?.server?.close(); } catch { /* already closed */ } });

  it("runs the full account + agent lifecycle with owner scoping enforced", async () => {
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

    // ---- signup validation + hygiene
    assert.equal((await call("POST", "/v1/accounts", { email: "nope", name: "A", owner: "alice", password: "long-enough-1" })).status, 400);
    assert.equal((await call("POST", "/v1/accounts", { email: "a@x.io", name: "A", owner: "alice", password: "short" })).status, 400);
    assert.equal((await call("POST", "/v1/accounts", { email: "a@x.io", name: "A", owner: "Bad Owner", password: "long-enough-1" })).status, 400);

    const alicePw = "alice-password-1";
    const su = await call("POST", "/v1/accounts", { email: "alice@x.io", name: "Alice", owner: "alice", password: alicePw });
    assert.equal(su.status, 201);
    assert.equal(su.data.account.owner, "alice");
    assert.ok(!su.text.includes("scrypt") && !su.text.includes(alicePw), "no hash/password in signup response");

    // duplicates
    assert.equal((await call("POST", "/v1/accounts", { email: "alice@x.io", name: "A2", owner: "alice2", password: "long-enough-1" })).status, 409);
    assert.equal((await call("POST", "/v1/accounts", { email: "other@x.io", name: "A2", owner: "alice", password: "long-enough-1" })).status, 409);

    // reserved namespace: content exists under "taken" before any account
    assert.equal((await call("POST", "/git/taken/seedrepo", null, opToken)).status, 201);
    assert.equal((await call("POST", "/v1/accounts", { email: "t@x.io", name: "T", owner: "taken", password: "long-enough-1" })).status, 409);
    const claimed = await call("POST", "/v1/accounts", { email: "t@x.io", name: "T", owner: "taken", password: "long-enough-1" }, opToken);
    assert.equal(claimed.status, 201, "operator-signed signup may claim a content namespace");

    // second account for the negative cases
    const bobPw = "bob-password-123";
    assert.equal((await call("POST", "/v1/accounts", { email: "bob@x.io", name: "Bob", owner: "bob", password: bobPw })).status, 201);

    // ---- login
    const badLogin = await call("POST", "/v1/accounts/login", { email: "alice@x.io", password: "wrong-password" });
    assert.equal(badLogin.status, 401);
    assert.equal(badLogin.data.error, "invalid email or password");
    assert.equal((await call("POST", "/v1/accounts/login", { email: "ghost@x.io", password: "whatever-1234" })).status, 401);
    const login = await call("POST", "/v1/accounts/login", { email: "alice@x.io", password: alicePw });
    assert.equal(login.status, 200);
    const aliceSess = login.data.sessionToken;
    assert.ok(aliceSess.startsWith("kiln_sess_"));
    const bobLogin = await call("POST", "/v1/accounts/login", { email: "bob@x.io", password: bobPw });
    const bobSess = bobLogin.data.sessionToken;

    // ---- /me
    assert.equal((await call("GET", "/v1/accounts/me", null, null)).status, 401);
    assert.equal((await call("GET", "/v1/accounts/me", null, opToken)).status, 403);
    const me = await call("GET", "/v1/accounts/me", null, aliceSess);
    assert.equal(me.status, 200);
    assert.equal(me.data.account.owner, "alice");
    assert.equal(me.data.principal.kind, "session");

    // ---- agent minting (session only)
    assert.equal((await call("POST", "/v1/accounts/me/agents", { name: "op-forged" }, opToken)).status, 403);
    const minted = await call("POST", "/v1/accounts/me/agents", { name: "alice-bot" }, aliceSess);
    assert.equal(minted.status, 201);
    const aliceAgent = minted.data.token;
    assert.ok(aliceAgent.startsWith("kiln_agt_"));
    assert.ok(!minted.text.includes("tokenHash"));
    assert.equal((await call("POST", "/v1/accounts/me/agents", { name: "nested" }, aliceAgent)).status, 403, "agents cannot mint agents");
    const agentMe = await call("GET", "/v1/accounts/me", null, aliceAgent);
    assert.equal(agentMe.status, 200);
    assert.equal(agentMe.data.principal.kind, "agent");
    const list = await call("GET", "/v1/accounts/me/agents", null, aliceSess);
    assert.equal(list.data.agents.length, 1);
    assert.ok(!list.text.includes("tokenHash"));

    const bobMint = await call("POST", "/v1/accounts/me/agents", { name: "bob-bot" }, bobSess);
    const bobAgent = bobMint.data.token;
    const bobMintScoped = await call("POST", "/v1/accounts/me/agents", { name: "bob-reader", scopes: ["project-details"] }, bobSess);
    const bobReader = bobMintScoped.data.token;

    // ---- happy paths under own namespace
    const wsA = await call("POST", "/v1/workspaces", { owner: "alice", slug: "alice-ws", name: "Alice WS" }, aliceAgent);
    assert.equal(wsA.status, 201);
    const wsAId = wsA.data.workspace.id;
    assert.equal((await call("POST", "/git/alice/repo1", null, opToken)).status, 201);
    const desc = await call("PATCH", "/v1/repos/alice/repo1/details", { description: "alice repo", topics: ["a"] }, aliceSess);
    assert.equal(desc.status, 200);
    assert.equal(desc.data.details.description, "alice repo");

    // ---- NEGATIVES: bob's principals vs alice's namespace
    assert.equal((await call("POST", "/v1/workspaces", { owner: "alice", slug: "evil", name: "Evil" }, bobAgent)).status, 403, "create under foreign owner");
    assert.equal((await call("GET", `/v1/workspaces/${wsAId}`, null, bobAgent)).status, 403, "read foreign workspace");
    assert.equal((await call("PATCH", `/v1/workspaces/${wsAId}`, { name: "Hijacked" }, bobAgent)).status, 403, "patch foreign workspace");
    assert.equal((await call("DELETE", `/v1/workspaces/${wsAId}`, { confirm: "alice-ws" }, bobAgent)).status, 403, "delete foreign workspace");
    assert.equal((await call("PATCH", "/v1/repos/alice/repo1/details", { description: "hijacked" }, bobSess)).status, 403, "describe foreign repo");
    const bobList = await call("GET", "/v1/workspaces?owner=alice", null, bobAgent);
    assert.equal(bobList.status, 200);
    assert.ok(bobList.data.workspaces.every((w) => w.owner === "bob"), "list is force-scoped to the caller's owner");

    // scope gate: a project-details-only agent cannot touch workspaces
    const scoped = await call("POST", "/v1/workspaces", { owner: "bob", slug: "bob-ws", name: "Bob WS" }, bobReader);
    assert.equal(scoped.status, 403);
    assert.ok(scoped.data.error.includes('"workspaces"'), "error names the missing scope");
    // …but it can read details (discovery face)
    assert.equal((await call("GET", "/v1/repos/alice/repo1/details", null, bobReader)).status, 200);

    // operator-only surfaces refuse account principals
    assert.equal((await call("GET", "/v1/sites", null, aliceAgent)).status, 403);
    assert.equal((await call("GET", "/v1/sites", null, aliceSess)).status, 403);

    // ---- operator regression: root still sees and does everything
    const opList = await call("GET", "/v1/workspaces", null, opToken);
    assert.ok(opList.data.workspaces.some((w) => w.id === wsAId));
    assert.equal((await call("GET", `/v1/workspaces/${wsAId}`, null, opToken)).status, 200);
    const caps = await call("GET", "/v1/capabilities", null, opToken);
    assert.ok(caps.data.abilities.some((a) => a.id === "accounts"), "capabilities advertise accounts");

    // ---- revoke: the token dies immediately
    const agentsNow = await call("GET", "/v1/accounts/me/agents", null, aliceSess);
    const agtId = agentsNow.data.agents[0].id;
    const revoked = await call("DELETE", `/v1/accounts/me/agents/${agtId}`, null, aliceSess);
    assert.equal(revoked.status, 200);
    assert.equal(revoked.data.agent.revoked, true);
    assert.equal((await call("GET", "/v1/accounts/me", null, aliceAgent)).status, 401, "revoked agent token is dead");

    // ---- store hygiene: hashes at rest, never raw secrets
    const raw = readFileSync(join(dir, "accounts.json"), "utf8");
    assert.ok(raw.includes("scrypt$"), "passwords stored as scrypt hashes");
    for (const secret of [alicePw, bobPw, aliceSess, bobSess, aliceAgent, bobAgent]) {
      assert.ok(!raw.includes(secret), "no raw secret in the store");
    }
  });
});
