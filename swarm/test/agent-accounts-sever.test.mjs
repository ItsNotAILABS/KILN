/**
 * Sponsor-link severing + the no-silent-control matrix for agent
 * accounts (companion to agent-accounts.test.mjs). The link is
 * VISIBILITY, never control (ORGS-DESIGN §4 recommended defaults):
 *   - either side may sever; the child keeps its account, namespace,
 *     repos, and credentials;
 *   - a third party severing gets 404, indistinguishable from a
 *     missing child;
 *   - the sponsor cannot revoke the child's agent tokens, cannot
 *     delete the child's repos, and minting agents from the
 *     sponsor's session lands under the SPONSOR, never the child
 *     (there is no sign-in-as door).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { makeStateDir } from "./helpers.mjs";
import { startApiServer } from "../lib/httpapi.mjs";
import { loadApiToken } from "../lib/state.mjs";

describe("agent accounts: severing + sponsor no-control", () => {
  let api;
  after(() => { try { api?.server?.close(); } catch { /* already closed */ } });

  it("severs from both sides and refuses every sponsor-control move", async () => {
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

    const pw = "sponsor-password-1";
    await call("POST", "/v1/accounts", { email: "sponsor@x.io", name: "Sponsor", owner: "sponsor", password: pw });
    await call("POST", "/v1/accounts", { email: "other@x.io", name: "Other", owner: "other", password: pw });
    const sponsorSess = (await call("POST", "/v1/accounts/login", { email: "sponsor@x.io", password: pw })).data.sessionToken;
    const otherSess = (await call("POST", "/v1/accounts/login", { email: "other@x.io", password: pw })).data.sessionToken;

    const created = await call("POST", "/v1/accounts/me/agent-accounts",
      { owner: "child-agent", name: "Child Agent" }, sponsorSess);
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const child = created.data.account;
    const childToken = created.data.token;
    const childAgentId = created.data.agent.id;

    // the child builds in its own namespace (severing must keep this)
    assert.equal((await call("POST", "/v1/workspaces",
      { owner: "child-agent", slug: "lab", name: "Lab" }, childToken)).status, 201);
    assert.equal((await call("POST", "/git/child-agent/keeps", null, opToken)).status, 201);

    // ---------- no silent control ----------
    // sponsor cannot revoke the child's agent token (reads as missing)
    assert.equal((await call("DELETE", `/v1/accounts/me/agents/${childAgentId}`, null, sponsorSess)).status, 404,
      "the child's agent records are not the sponsor's to revoke");
    // ...and the token still works afterwards
    assert.equal((await call("GET", "/v1/accounts/me", null, childToken)).status, 200);
    // sponsor cannot delete the child's repo (owner-session-only pen)
    assert.equal((await call("DELETE", "/v1/repos/child-agent/keeps", null, sponsorSess)).status, 403,
      "repo deletion stays with the repo owner's session");
    // no sign-in-as: agents minted from the sponsor's session belong
    // to the SPONSOR — the child is never the implied account
    const minted = await call("POST", "/v1/accounts/me/agents", { name: "sponsor-helper" }, sponsorSess);
    assert.equal(minted.status, 201);
    assert.notEqual(minted.data.agent.accountId, child.id, "sponsor mints under itself, never as the child");
    assert.equal((await call("GET", "/v1/accounts/me", null, minted.data.token)).data.account.owner, "sponsor");
    // a third party cannot sever someone else's link
    assert.equal((await call("DELETE", `/v1/accounts/me/agent-accounts/${child.id}`, null, otherSess)).status, 404,
      "a non-party sever reads as missing");
    assert.equal((await call("GET", "/v1/accounts/me", null, childToken)).data.sponsor.owner, "sponsor",
      "the failed sever changed nothing");

    // ---------- sponsor-side sever ----------
    const severed = await call("DELETE", `/v1/accounts/me/agent-accounts/${child.id}`, null, sponsorSess);
    assert.equal(severed.status, 200, JSON.stringify(severed.data));
    assert.equal(severed.data.account.owner, "child-agent");
    assert.equal(severed.data.account.sponsor, null, "the link is gone from the child's shape");
    // the child keeps everything: token, namespace content, visibility of itself
    const childMe = await call("GET", "/v1/accounts/me", null, childToken);
    assert.equal(childMe.status, 200, "the child's credential survives severing");
    assert.equal(childMe.data.sponsor, null);
    assert.equal(childMe.data.account.owner, "child-agent");
    assert.equal((await call("GET", "/v1/workspaces?owner=child-agent", null, childToken)).status, 200);
    assert.deepEqual((await call("GET", "/v1/accounts/me/agent-accounts", null, sponsorSess)).data.accounts, [],
      "the sponsor's sponsored list is empty after severing");
    // severing twice is a 404, not a silent success
    assert.equal((await call("DELETE", `/v1/accounts/me/agent-accounts/${child.id}`, null, sponsorSess)).status, 404);

    // ---------- child-side sever ----------
    const created2 = await call("POST", "/v1/accounts/me/agent-accounts",
      { owner: "child-two", name: "Child Two" }, sponsorSess);
    assert.equal(created2.status, 201);
    const child2 = created2.data.account;
    const severed2 = await call("DELETE", `/v1/accounts/me/agent-accounts/${child2.id}`, null, created2.data.token);
    assert.equal(severed2.status, 200, JSON.stringify(severed2.data));
    assert.equal(severed2.data.account.sponsor, null);
    assert.equal((await call("GET", "/v1/accounts/me", null, created2.data.token)).data.sponsor, null,
      "the child reads its own severed link as gone");
    assert.deepEqual((await call("GET", "/v1/accounts/me/agent-accounts", null, sponsorSess)).data.accounts, [],
      "…and so does the sponsor");
  });
});
