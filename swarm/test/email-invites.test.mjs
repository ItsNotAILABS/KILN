/**
 * Encrypted email binding + workspace invites by email: real HTTP
 * API, real AES-256-GCM/HMAC at rest, real store files — no mocks.
 * The negative cases are the point (an invite must never re-tie an
 * account to a different address), and the closing sweep proves the
 * secrecy invariant: walk EVERY file in the state dir and assert no
 * plaintext email and no raw invite/session token appears anywhere —
 * accounts store, invites store, mail outbox, audit log included.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, scryptSync } from "node:crypto";
import { makeStateDir } from "./helpers.mjs";
import { startApiServer } from "../lib/httpapi.mjs";
import { loadApiToken } from "../lib/state.mjs";
import { createInvite } from "../lib/invites.mjs";
import { resolveWorkspace } from "../lib/workspaces.mjs";

const EMAILS = [
  "owner@example.com", "guest@example.com", "guest2@example.com",
  "invitee@example.com", "joinme@example.com", "newbie@example.com",
  "adopted@example.com", "dup@example.com", "admin2@example.com",
  "exp@example.com", "revoked@example.com", "legacy@example.com",
];

function walkFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
}

describe("email binding + workspace invites: HTTP API", () => {
  let api;
  after(() => { try { api?.server?.close(); } catch { /* already closed */ } });

  it("runs the full lifecycle with encryption at rest proven by a state-dir sweep", async () => {
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

    // ---- signup stores the address ONLY as an encrypted binding
    const su = await signup("owner@example.com", "Studio Owner", "studio");
    assert.equal(su.data.account.email, "o•••@example.com", "signup response is masked");
    assert.equal(su.data.account.emailBound, true);
    assert.ok(!su.text.includes("owner@example.com"), "no plaintext email in the signup response");
    const keyStat = statSync(join(dir, "email.key"));
    assert.equal(keyStat.mode & 0o777, 0o600, "email key file is 0600");
    const rawAccounts = () => readFileSync(join(dir, "accounts.json"), "utf8");
    assert.ok(rawAccounts().includes("emailEnc"), "binding ciphertext at rest");
    assert.ok(!rawAccounts().includes("owner@example.com"), "no plaintext email in accounts.json");

    const ownerSess = await loginAs("owner@example.com", "studio");
    // login by the bound address works through the HMAC tag alone
    assert.equal((await call("POST", "/v1/accounts/login", { email: "OWNER@example.com", password: "studio-password-1" })).status, 200, "login is case-insensitive via normalization");

    // ---- workspace + membership starts empty
    const ws = await call("POST", "/v1/workspaces", { owner: "studio", slug: "studio-ws", name: "Studio WS" }, ownerSess);
    assert.equal(ws.status, 201);
    const wsId = ws.data.workspace.id;
    assert.deepEqual(ws.data.workspace.members, []);

    await signup("guest@example.com", "Guest", "guest");
    const guestSess = await loginAs("guest@example.com", "guest");
    await signup("invitee@example.com", "Invitee", "invitee");
    const inviteeSess = await loginAs("invitee@example.com", "invitee");
    await signup("other@example.com", "Other", "other");
    const otherSess = await loginAs("other@example.com", "other");

    // not a member yet: read + list are walled
    assert.equal((await call("GET", `/v1/workspaces/${wsId}`, null, guestSess)).status, 403);
    const guestList = await call("GET", "/v1/workspaces", null, guestSess);
    assert.ok(!guestList.data.workspaces.some((w) => w.id === wsId), "member-less list excludes the workspace");

    // ---- PUT /me/email: session-only, masked, rebinds login
    const guestAgent = (await call("POST", "/v1/accounts/me/agents", { name: "guest-bot" }, guestSess)).data.token;
    assert.equal((await call("PUT", "/v1/accounts/me/email", { email: "guest2@example.com" }, guestAgent)).status, 403, "agent token cannot bind email");
    assert.equal((await call("PUT", "/v1/accounts/me/email", { email: "guest2@example.com" }, opToken)).status, 403, "operator is not an account");
    assert.equal((await call("PUT", "/v1/accounts/me/email", { email: "not-an-email" }, guestSess)).status, 400);
    const bound = await call("PUT", "/v1/accounts/me/email", { email: "guest2@example.com" }, guestSess);
    assert.equal(bound.status, 200);
    assert.equal(bound.data.account.email, "g•••@example.com");
    assert.ok(!bound.text.includes("guest2@example.com"), "bind response never echoes the address");
    assert.equal((await call("POST", "/v1/accounts/login", { email: "guest@example.com", password: "guest-password-1" })).status, 401, "old address no longer logs in");
    assert.equal((await call("POST", "/v1/accounts/login", { email: "guest2@example.com", password: "guest-password-1" })).status, 200, "new address logs in");
    // one address, one account
    assert.equal((await call("PUT", "/v1/accounts/me/email", { email: "guest2@example.com" }, otherSess)).status, 409, "address already tied elsewhere");

    // ---- invites: create (owner), token shown once, masked views
    const invA = await call("POST", `/v1/workspaces/${wsId}/invites`, { email: "joinme@example.com", role: "member" }, ownerSess);
    assert.equal(invA.status, 201, invA.text);
    assert.ok(invA.data.token.startsWith("kiln_inv_"), "plaintext token shown at creation");
    assert.equal(invA.data.tokenShownOnce, true);
    assert.equal(invA.data.invite.email, "j•••@example.com");
    assert.equal(invA.data.invite.status, "pending");
    const tokenA = invA.data.token;

    const dup = await call("POST", `/v1/workspaces/${wsId}/invites`, { email: "joinme@example.com", role: "admin" }, ownerSess);
    assert.equal(dup.status, 409, "duplicate pending invite refused");
    assert.equal((await call("POST", `/v1/workspaces/${wsId}/invites`, { email: "x@example.com", role: "owner" }, ownerSess)).status, 400, "owner is not an invitable role");
    assert.equal((await call("POST", `/v1/workspaces/${wsId}/invites`, { email: "x@example.com", role: "member" }, otherSess)).status, 403, "unrelated account cannot invite");
    assert.equal((await call("GET", `/v1/workspaces/${wsId}/invites`, null, otherSess)).status, 403, "unrelated account cannot list invites");

    const list1 = await call("GET", `/v1/workspaces/${wsId}/invites`, null, ownerSess);
    assert.equal(list1.data.invites.length, 1);
    assert.ok(!list1.text.includes(tokenA), "invite list never carries the token");
    assert.ok(!list1.text.includes("joinme@example.com"), "invite list is masked only");

    // ---- accept with the WRONG bound email → 409, invite survives
    assert.equal((await call("POST", `/v1/invites/${tokenA}/accept`, null, inviteeSess)).status, 409, "bound to a different address");
    assert.equal((await call("POST", `/v1/invites/${tokenA}/accept`, null, opToken)).status, 403, "operator cannot accept");
    assert.equal((await call("POST", `/v1/invites/${tokenA}/accept`, null, guestAgent)).status, 403, "agent token cannot accept");

    // ---- accept with NO email on the account → binding adopted
    await signup("newbie@example.com", "Newbie", "newbie");
    const newbieSess = await loginAs("newbie@example.com", "newbie");
    // Fixture surgery: strip the account's email entirely (the
    // pre-binding-era shape) while its session stays valid.
    const store = JSON.parse(rawAccounts());
    const newbie = Object.values(store.accounts).find((a) => a.owner === "newbie");
    delete newbie.emailBinding;
    writeFileSync(join(dir, "accounts.json"), JSON.stringify(store, null, 2) + "\n");
    const invB = await call("POST", `/v1/workspaces/${wsId}/invites`, { email: "adopted@example.com", role: "member" }, ownerSess);
    const acc = await call("POST", `/v1/invites/${invB.data.token}/accept`, null, newbieSess);
    assert.equal(acc.status, 200, acc.text);
    assert.equal(acc.data.member.role, "member");
    assert.equal(acc.data.account.email, "a•••@example.com", "adopted binding reports masked");
    assert.equal(acc.data.account.emailBound, true);
    const newbieMe = await call("GET", "/v1/accounts/me", null, newbieSess);
    assert.equal(newbieMe.data.account.email, "a•••@example.com");
    // member now: read + list open up
    assert.equal((await call("GET", `/v1/workspaces/${wsId}`, null, newbieSess)).status, 200, "member can read the workspace");
    const newbieList = await call("GET", "/v1/workspaces", null, newbieSess);
    assert.ok(newbieList.data.workspaces.some((w) => w.id === wsId), "member list includes the workspace");
    const status = await call("GET", `/v1/workspaces/${wsId}`, null, ownerSess);
    assert.ok(status.data.workspace.members.some((m) => m.owner === "newbie" && m.role === "member" && m.via === "invite"));
    // single-use: replay is indistinguishable from unknown
    assert.equal((await call("POST", `/v1/invites/${invB.data.token}/accept`, null, newbieSess)).status, 404, "consumed token replays as 404");
    assert.equal((await call("POST", "/v1/invites/kiln_inv_unknown/accept", null, newbieSess)).status, 404);

    // a plain member cannot manage invites
    assert.equal((await call("POST", `/v1/workspaces/${wsId}/invites`, { email: "z@example.com", role: "member" }, newbieSess)).status, 403, "member cannot invite");

    // ---- accept with the MATCHING bound email → member with role
    const invC = await call("POST", `/v1/workspaces/${wsId}/invites`, { email: "invitee@example.com", role: "admin" }, ownerSess);
    const accC = await call("POST", `/v1/invites/${invC.data.token}/accept`, null, inviteeSess);
    assert.equal(accC.status, 200, accC.text);
    assert.equal(accC.data.member.role, "admin");
    // an admin member CAN invite
    const invD = await call("POST", `/v1/workspaces/${wsId}/invites`, { email: "admin2@example.com", role: "member" }, inviteeSess);
    assert.equal(invD.status, 201, "admin member manages invites");
    await signup("admin2@example.com", "Admin Two", "admin2");
    const admin2Sess = await loginAs("admin2@example.com", "admin2");
    assert.equal((await call("POST", `/v1/invites/${invD.data.token}/accept`, null, admin2Sess)).status, 200);

    // ---- revoke: the token dies
    const invE = await call("POST", `/v1/workspaces/${wsId}/invites`, { email: "revoked@example.com", role: "member" }, ownerSess);
    const revoked = await call("DELETE", `/v1/workspaces/${wsId}/invites/${invE.data.invite.id}`, null, ownerSess);
    assert.equal(revoked.status, 200);
    assert.equal(revoked.data.invite.status, "revoked");
    assert.equal((await call("POST", `/v1/invites/${invE.data.token}/accept`, null, guestSess)).status, 404, "revoked token reads as not found");
    assert.equal((await call("DELETE", `/v1/workspaces/${wsId}/invites/${invE.data.invite.id}`, null, ownerSess)).status, 409, "double revoke is honest");

    // ---- expired: 410 (lib-created with a 1ms TTL — the test-only knob)
    await signup("exp@example.com", "Expiring", "exp");
    const expSess = await loginAs("exp@example.com", "exp");
    const wsRec = resolveWorkspace(dir, wsId);
    const short = createInvite(dir, wsRec, { email: "exp@example.com", role: "member", createdBy: "studio" }, { ttlMs: 1 });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal((await call("POST", `/v1/invites/${short.token}/accept`, null, expSess)).status, 410, "expired invite answers 410");

    // ---- mail wiring: welcomes + invite mails queued, all unsent
    const outbox = await call("GET", "/v1/mail/outbox", null, opToken);
    assert.equal(outbox.status, 200);
    assert.equal(outbox.data.transport.configured, false, "no transport in the test env — stated, not faked");
    assert.ok(outbox.data.counts.total >= 6, `expected queued mail, got ${JSON.stringify(outbox.data.counts)}`);
    assert.equal(outbox.data.counts.sent, 0, "nothing claims sent without a provider");
    assert.ok(outbox.data.mail.some((m) => m.kind === "introduction" && m.to === "o•••@example.com"), "signup introduction queued, masked");
    assert.ok(outbox.data.mail.some((m) => m.kind === "workspace-invite" && m.to === "j•••@example.com"), "invite mail queued, masked");
    assert.equal((await call("GET", "/v1/mail/outbox", null, ownerSess)).status, 403, "outbox is operator-only");
    const drain = await call("POST", "/v1/mail/send", null, opToken);
    assert.equal(drain.data.configured, false);
    assert.ok(drain.data.queued >= 6, "unconfigured drain leaves everything queued-unsent");

    // ---- THE SWEEP: no plaintext email, no raw token, anywhere at rest
    const secrets = [
      ...EMAILS, "other@example.com",
      tokenA, invB.data.token, invC.data.token, invD.data.token, invE.data.token, short.token,
      ownerSess, guestSess, inviteeSess, newbieSess,
    ];
    const files = walkFiles(dir);
    assert.ok(files.length > 5, "sweep actually covered the state dir");
    for (const f of files) {
      let content;
      try { content = readFileSync(f, "utf8"); } catch { continue; }
      for (const s of secrets) {
        assert.ok(!content.includes(s), `plaintext secret leaked into ${f.replace(dir, "<dir>")}: ${s.slice(0, 4)}…`);
      }
    }
  });

  it("migrates a legacy plaintext-email account on first login", async () => {
    const dir = makeStateDir();
    process.env.KILN_SWARM_API_PORT = "0";
    let api2;
    try {
      api2 = await startApiServer(dir, { apiPort: 0 });
    } finally {
      delete process.env.KILN_SWARM_API_PORT;
    }
    try {
      // Hand-build a pre-binding-era record: plaintext email, scrypt hash.
      const salt = randomBytes(16);
      const hash = scryptSync("legacy-password-1", salt, 64);
      const legacy = {
        accounts: {
          acct_legacy00001: {
            id: "acct_legacy00001",
            email: "legacy@example.com",
            name: "Legacy",
            owner: "legacy",
            passwordHash: `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`,
            createdAt: new Date().toISOString(),
          },
        },
        sessions: {}, agents: {}, wallets: {}, walletChallenges: {}, walletBackups: {},
      };
      writeFileSync(join(dir, "accounts.json"), JSON.stringify(legacy, null, 2) + "\n");
      const res = await fetch(`${api2.url}/v1/accounts/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "legacy@example.com", password: "legacy-password-1" }),
      });
      assert.equal(res.status, 200, "legacy login still works");
      const after = readFileSync(join(dir, "accounts.json"), "utf8");
      assert.ok(!after.includes("legacy@example.com"), "plaintext address deleted by migration");
      assert.ok(after.includes("emailEnc"), "binding written by migration");
      const res2 = await fetch(`${api2.url}/v1/accounts/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "legacy@example.com", password: "legacy-password-1" }),
      });
      assert.equal(res2.status, 200, "second login runs on the HMAC path");
    } finally {
      try { api2?.server?.close(); } catch { /* already closed */ }
    }
  });
});
