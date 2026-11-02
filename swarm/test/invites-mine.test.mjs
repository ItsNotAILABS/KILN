/**
 * GET /v1/invites/mine — the invitee's inbox: real HTTP API, real
 * HMAC matching against the encrypted-at-rest email layer, no mocks.
 *
 * The contract under test:
 *   - a session sees exactly the PENDING invites addressed to its
 *     account's bound email, across workspaces, in the shipped shape
 *     { id, workspaceId, workspaceSlug, workspaceName, role,
 *       status: "pending", createdAt, expiresAt } — and NO email
 *     field in any form (plaintext or masked) anywhere in the body;
 *   - isolation: another account's invites never appear;
 *   - expired, accepted (consumed), and revoked invites are excluded;
 *   - an account with no bound email gets an honest empty list;
 *   - agent tokens and the operator token get the codebase's
 *     not-an-account 403; anonymous gets 401; non-GET gets 404.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeStateDir } from "./helpers.mjs";
import { startApiServer } from "../lib/httpapi.mjs";
import { loadApiToken } from "../lib/state.mjs";
import { createInvite } from "../lib/invites.mjs";
import { resolveWorkspace } from "../lib/workspaces.mjs";

const SHAPE_KEYS = ["createdAt", "expiresAt", "id", "role", "status", "workspaceId", "workspaceName", "workspaceSlug"];

describe("GET /v1/invites/mine: the invitee inbox", () => {
  let api;
  after(() => { try { api?.server?.close(); } catch { /* already closed */ } });

  it("lists exactly my pending invites — isolated, unexpired, unconsumed, unrevoked", async () => {
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
    const signup = async (email, name, owner) => {
      const r = await call("POST", "/v1/accounts", { email, name, owner, password: `${owner}-password-1` });
      assert.equal(r.status, 201, `signup ${owner}: ${r.text}`);
      return r;
    };
    const loginAs = async (email, owner) => {
      const r = await call("POST", "/v1/accounts/login", { email, password: `${owner}-password-1` });
      assert.equal(r.status, 200, `login ${owner}: ${r.text}`);
      return r.data.sessionToken;
    };
    const mkWs = async (sess, slug, name) => {
      const r = await call("POST", "/v1/workspaces", { owner: "studio", slug, name }, sess);
      assert.equal(r.status, 201, `workspace ${slug}: ${r.text}`);
      return r.data.workspace;
    };

    // ---- cast: a workspace owner, two invitees, one email-less account
    await signup("owner@example.com", "Studio Owner", "studio");
    const ownerSess = await loginAs("owner@example.com", "studio");
    await signup("alice@example.com", "Alice", "alice");
    const aliceSess = await loginAs("alice@example.com", "alice");
    await signup("bob@example.com", "Bob", "bob");
    const bobSess = await loginAs("bob@example.com", "bob");
    await signup("carol@example.com", "Carol", "carol");
    const carolSess = await loginAs("carol@example.com", "carol");
    // Carol's account loses its email entirely (the pre-binding-era
    // shape) while her session stays valid — the email-invites suite's
    // fixture surgery, reused.
    const storePath = join(dir, "accounts.json");
    const store = JSON.parse(readFileSync(storePath, "utf8"));
    const carol = Object.values(store.accounts).find((a) => a.owner === "carol");
    delete carol.emailBinding;
    writeFileSync(storePath, JSON.stringify(store, null, 2) + "\n");

    const ws1 = await mkWs(ownerSess, "alpha-ws", "Alpha WS");
    const ws2 = await mkWs(ownerSess, "beta-ws", "Beta WS");
    const ws3 = await mkWs(ownerSess, "gamma-ws", "Gamma WS");
    const ws4 = await mkWs(ownerSess, "delta-ws", "Delta WS");
    const ws5 = await mkWs(ownerSess, "epsilon-ws", "Epsilon WS");
    const invite = async (ws, email, role = "member") => {
      const r = await call("POST", `/v1/workspaces/${ws.id}/invites`, { email, role }, ownerSess);
      assert.equal(r.status, 201, `invite ${email} -> ${ws.slug}: ${r.text}`);
      return r.data;
    };

    // ---- the field: alice pending x2, bob pending x1 (isolation),
    //      alice expired, alice revoked, alice consumed
    const a1 = await invite(ws1, "alice@example.com", "admin");
    const a2 = await invite(ws2, "alice@example.com");
    const b1 = await invite(ws1, "bob@example.com");
    const short = createInvite(dir, resolveWorkspace(dir, ws3.id),
      { email: "alice@example.com", role: "member", createdBy: "studio" }, { ttlMs: 1 });
    await new Promise((r) => setTimeout(r, 15));
    const aRevoked = await invite(ws4, "alice@example.com");
    assert.equal((await call("DELETE", `/v1/workspaces/${ws4.id}/invites/${aRevoked.invite.id}`, null, ownerSess)).status, 200);
    const aConsumed = await invite(ws5, "alice@example.com");
    assert.equal((await call("POST", `/v1/invites/${aConsumed.token}/accept`, null, aliceSess)).status, 200, "alice consumes the epsilon invite");

    // ---- happy path: alice sees exactly her two pending invites
    const mine = await call("GET", "/v1/invites/mine", null, aliceSess);
    assert.equal(mine.status, 200, mine.text);
    assert.deepEqual(mine.data.invites.map((i) => i.id), [a1.invite.id, a2.invite.id],
      "exactly the two pending invites, oldest first — expired/revoked/consumed/bob's all excluded");
    const [first, second] = mine.data.invites;
    assert.deepEqual(Object.keys(first).sort(), SHAPE_KEYS, "the shipped shape, no more and no less");
    assert.equal(first.workspaceId, ws1.id);
    assert.equal(first.workspaceSlug, "alpha-ws");
    assert.equal(first.workspaceName, "Alpha WS");
    assert.equal(first.role, "admin");
    assert.equal(first.status, "pending");
    assert.equal(first.createdAt, a1.invite.createdAt);
    assert.equal(first.expiresAt, a1.invite.expiresAt);
    assert.equal(second.workspaceSlug, "beta-ws");
    assert.equal(second.workspaceName, "Beta WS");
    // NO email field in any form, anywhere in the body
    assert.ok(!("email" in first) && !("emailMasked" in first), "no email key on the invite");
    assert.ok(!mine.text.includes("alice@example.com"), "no plaintext address in the response");
    assert.ok(!mine.text.includes("a•••@example.com"), "not even the masked address in the response");
    assert.ok(!mine.text.includes(short.invite.id), "the expired invite is not listed");
    assert.ok(!mine.text.includes(aRevoked.invite.id), "the revoked invite is not listed");
    assert.ok(!mine.text.includes(aConsumed.invite.id), "the consumed invite is not listed");

    // ---- isolation: bob sees only his own; alice's ids never appear
    const bobs = await call("GET", "/v1/invites/mine", null, bobSess);
    assert.equal(bobs.status, 200, bobs.text);
    assert.deepEqual(bobs.data.invites.map((i) => i.id), [b1.invite.id], "bob sees exactly his one invite");
    assert.equal(bobs.data.invites[0].workspaceSlug, "alpha-ws");
    assert.ok(!bobs.text.includes(a1.invite.id) && !bobs.text.includes(a2.invite.id), "alice's invites never leak into bob's list");
    assert.ok(!mine.text.includes(b1.invite.id), "bob's invite never leaks into alice's list");

    // ---- no bound email: honest empty list, still a 200
    const carols = await call("GET", "/v1/invites/mine", null, carolSess);
    assert.equal(carols.status, 200, carols.text);
    assert.deepEqual(carols.data, { invites: [] }, "no bound email -> empty list, stated plainly");

    // ---- principal discipline: session only
    const aliceAgent = (await call("POST", "/v1/accounts/me/agents", { name: "alice-bot" }, aliceSess)).data.token;
    assert.ok(aliceAgent, "agent token minted for the rejection check");
    const asAgent = await call("GET", "/v1/invites/mine", null, aliceAgent);
    assert.equal(asAgent.status, 403, "agent token is not the account");
    assert.match(asAgent.data.error, /not an agent token/);
    const asOperator = await call("GET", "/v1/invites/mine", null, opToken);
    assert.equal(asOperator.status, 403, "operator token is not an account");
    assert.match(asOperator.data.error, /not an account/);
    assert.equal((await call("GET", "/v1/invites/mine", null, null)).status, 401, "anonymous gets 401");
    assert.equal((await call("POST", "/v1/invites/mine", {}, aliceSess)).status, 404, "the door is GET-only");
    // the accept door is untouched by the new literal route
    assert.equal((await call("POST", "/v1/invites/kiln_inv_unknown/accept", null, aliceSess)).status, 404, "accept still answers unknown tokens 404");
  });
});
