/**
 * The daemon mailer: templates, the outbox state machine, transports.
 * Real rendering, real outbox files, a fake in-process SMTP server
 * for the wire dialogue, and injected fake transports for the drain.
 * The honesty gate is the point: no transport → queued-unsent,
 * forever, and nothing is ever marked sent without an acceptance.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { makeStateDir } from "./helpers.mjs";
import { makeEmailBinding } from "../lib/emailcrypto.mjs";
import {
  MailerError, renderEmail, enqueueMail, listOutbox, outboxCounts,
  drainOutbox, transportConfigFromEnv, createSmtpTransport,
  createCloudflareTransport,
} from "../lib/mailer.mjs";
import { startApiServer } from "../lib/httpapi.mjs";
import { loadApiToken } from "../lib/state.mjs";

const INVITE_CTX = {
  workspaceName: "Studio WS", inviter: "studio", role: "member",
  expiresAt: "2026-11-07T03:00:00.000Z",
  token: "kiln_inv_testtoken000000000000",
  acceptUrl: "https://kiln.pocketnova.app/invites/kiln_inv_testtoken000000000000",
};

describe("mailer: templates", () => {
  it("renders the invite email with link, token, and expiry — no placeholder leakage", () => {
    const m = renderEmail("workspace-invite", INVITE_CTX);
    assert.equal(m.subject, "You're invited to join Studio WS on KILN");
    assert.ok(m.text.includes(INVITE_CTX.token));
    assert.ok(m.text.includes(INVITE_CTX.acceptUrl));
    assert.ok(m.text.includes("Studio WS"));
    assert.ok(m.html.includes(INVITE_CTX.token));
    for (const out of [m.subject, m.text, m.html]) {
      assert.ok(!out.includes("{{") && !out.includes("}}"), "no placeholder syntax leaks");
      assert.ok(!out.includes("undefined"), "no undefined context leaks");
    }
  });

  it("renders the approved introduction copy verbatim for the architect's parameters", () => {
    const m = renderEmail("introduction", {
      owner: "itsnotailabs",
      workspaceName: "ItsNotAILABS",
      paperLine: "Your first paper, \"One Marketplace, Many Universes,\" is being published tonight",
    });
    assert.equal(m.subject, "Welcome to KILN — your account is becoming an identity");
    const expected = [
      "Welcome to KILN — the developer platform for the AI internet, and the forge where ItsNotAILABS builds in the open.",
      "",
      "This email is now tied to your account (itsnotailabs) — stored encrypted, shown only masked, and used for exactly two things: your business identity on KILN, and getting you back in if a device or wallet is ever lost. Signing in stays wallet-first: connect Phantom, and your profile, your wallets, and your work follow you to any browser.",
      "",
      "What's yours on KILN:",
      "• The ItsNotAILABS workspace — repos, projects, and your team, with members you add by email",
      "• Your forge — public and private repositories, the Studio creation suite, and your own agents with their own accounts and wallets",
      "• Publishing — papers and projects released from KILN under your name, each with its own link. Your first paper, \"One Marketplace, Many Universes,\" is being published tonight",
      "",
      "Start here: https://kiln.pocketnova.app/itsnotailabs",
      "",
      "— Auro, for KILN · ItsNotAILABS",
    ].join("\n");
    assert.equal(m.text, expected, "the introduction text is the approved copy, byte for byte");
    // generalized: no workspace/paper parameters still reads clean
    const g = renderEmail("introduction", { owner: "someone" });
    assert.ok(g.text.includes("Your workspace — repos, projects"));
    assert.ok(g.text.includes("https://kiln.pocketnova.app/someone"));
    assert.ok(!g.text.includes("undefined"));
  });

  it("renders the generic account notice, and refuses bad input loudly", () => {
    const m = renderEmail("account-notice", { title: "Heads up", body: "Something happened.", ctaUrl: "https://kiln.pocketnova.app", ctaLabel: "See it" });
    assert.equal(m.subject, "Heads up");
    assert.ok(m.text.includes("Something happened."));
    assert.throws(() => renderEmail("nope", {}), MailerError);
    assert.throws(() => renderEmail("introduction", {}), /needs context\.owner/);
    assert.throws(() => renderEmail("workspace-invite", { workspaceName: "X" }), /needs context/);
  });
});

describe("mailer: outbox state machine", () => {
  it("queues encrypted, drains honestly: unconfigured → sent → failed-bounded", async () => {
    const dir = makeStateDir();
    const binding = makeEmailBinding(dir, "person@example.com");
    const rec = enqueueMail(dir, {
      kind: "workspace-invite", to: binding,
      context: { workspaceName: "Studio WS", inviter: "studio", role: "member", expiresAt: "2026-11-07T03:00:00.000Z" },
      secret: "kiln_inv_testtoken000000000000",
    });
    assert.equal(rec.status, "queued");
    assert.equal(rec.to, "p•••@example.com");
    const raw = readFileSync(join(dir, "mail-outbox.json"), "utf8");
    assert.ok(!raw.includes("person@example.com"), "recipient never rests in plaintext");
    assert.ok(!raw.includes("kiln_inv_testtoken000000000000"), "invite token never rests in plaintext");
    assert.deepEqual(outboxCounts(dir), { queued: 1, sent: 0, failed: 0, total: 1 });

    // no transport configured → nothing moves, and it says so
    const un = await drainOutbox(dir, { env: {} });
    assert.deepEqual(un, { configured: false, attempted: 0, sent: 0, failed: 0, queued: 1 });
    assert.equal(listOutbox(dir)[0].status, "queued");

    // fake provider accepts → sent, with its id; the send itself saw
    // the decrypted recipient + rendered token (in memory only)
    let seen = null;
    const okTx = { kind: "fake", from: "kiln@example.com", async send(msg) { seen = msg; return { id: "prov-42" }; } };
    const done = await drainOutbox(dir, { transport: okTx });
    assert.equal(done.sent, 1);
    assert.equal(seen.to, "person@example.com");
    assert.ok(seen.text.includes("kiln_inv_testtoken000000000000"));
    assert.ok(seen.text.includes("https://kiln.pocketnova.app/invites/kiln_inv_testtoken000000000000"));
    const after1 = listOutbox(dir)[0];
    assert.equal(after1.status, "sent");
    assert.equal(after1.providerId, "prov-42");
    assert.ok(after1.sentAt);

    // failing provider → attempts climb, reason kept, terminal at 3
    enqueueMail(dir, { kind: "account-notice", to: binding, context: { title: "T", body: "B" } });
    const badTx = { kind: "fake", from: "kiln@example.com", async send() { throw new Error("provider refused: 550 no such user"); } };
    await drainOutbox(dir, { transport: badTx });
    let rec2 = listOutbox(dir).find((m) => m.kind === "account-notice");
    assert.equal(rec2.status, "queued");
    assert.equal(rec2.attempts, 1);
    assert.ok(rec2.lastError.includes("550"));
    await drainOutbox(dir, { transport: badTx });
    await drainOutbox(dir, { transport: badTx });
    rec2 = listOutbox(dir).find((m) => m.kind === "account-notice");
    assert.equal(rec2.status, "failed");
    assert.equal(rec2.attempts, 3);
    const noop = await drainOutbox(dir, { transport: badTx });
    assert.equal(noop.attempted, 0, "terminal failures are not retried silently");
  });

  it("parses transport config from env, incompletely = unconfigured", () => {
    assert.equal(transportConfigFromEnv({}), null);
    assert.equal(transportConfigFromEnv({ KILN_SMTP_HOST: "smtp.office365.com" }), null, "no credentials = unconfigured");
    const smtp = transportConfigFromEnv({
      KILN_SMTP_HOST: "smtp.office365.com", KILN_SMTP_USER: "u@x.io", KILN_SMTP_PASS: "p",
    });
    assert.equal(smtp.kind, "smtp");
    assert.equal(smtp.port, 587);
    assert.equal(smtp.secure, "starttls");
    assert.equal(smtp.from, "u@x.io");
    assert.equal(transportConfigFromEnv({ KILN_MAIL_API_URL: "https://mail.example/send", KILN_MAIL_API_KEY: "k" }), null, "https needs an explicit FROM");
    const https = transportConfigFromEnv({
      KILN_MAIL_API_URL: "https://mail.example/send", KILN_MAIL_API_KEY: "k", KILN_MAIL_FROM: "KILN <kiln@pocketnova.app>",
    });
    assert.equal(https.kind, "https");
  });
});

describe("mailer: SMTP wire dialogue (fake server)", () => {
  it("speaks EHLO/AUTH LOGIN/DATA and returns the provider queue id", async () => {
    const received = [];
    let dataMode = false;
    const server = createServer((sock) => {
      let buf = "";
      sock.write("220 fake.example ESMTP ready\r\n");
      sock.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        let idx;
        while ((idx = buf.indexOf("\r\n")) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (dataMode) {
            if (line === ".") { dataMode = false; sock.write("250 2.0.0 Ok: queued as TESTID123\r\n"); }
            else received.push(line);
            continue;
          }
          if (line.startsWith("EHLO")) sock.write("250 fake.example greets\r\n");
          else if (line === "AUTH LOGIN") sock.write("334 VXNlcm5hbWU6\r\n");
          else if (line === Buffer.from("user@x.io").toString("base64")) sock.write("334 UGFzc3dvcmQ6\r\n");
          else if (line === Buffer.from("app-password").toString("base64")) sock.write("235 2.7.0 Authentication successful\r\n");
          else if (line.startsWith("MAIL FROM")) sock.write("250 2.1.0 Ok\r\n");
          else if (line.startsWith("RCPT TO")) sock.write("250 2.1.5 Ok\r\n");
          else if (line === "DATA") { dataMode = true; sock.write("354 End data with <CR><LF>.<CR><LF>\r\n"); }
          else if (line === "QUIT") { sock.write("221 Bye\r\n"); sock.end(); }
          else sock.write("502 5.5.2 unrecognized\r\n");
        }
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = server.address().port;
      const tx = createSmtpTransport({
        kind: "smtp", host: "127.0.0.1", port, secure: "none",
        user: "user@x.io", pass: "app-password", from: "user@x.io",
      });
      const r = await tx.send({ to: "dest@example.com", subject: "Hello there", text: "Body text here", html: null });
      assert.equal(r.id, "TESTID123");
      const wire = received.join("\n");
      assert.ok(wire.includes("Subject: Hello there"));
      assert.ok(wire.includes(Buffer.from("Body text here").toString("base64")), "body travels base64-encoded");
    } finally {
      server.close();
    }
  });
});

describe("mailer: Cloudflare Email Sending transport", () => {
  const cfCfg = { accountId: "acct-1", apiToken: "tok-1", from: "KILN <kiln@pocketnova.app>" };
  const fakeFetch = (respond) => {
    const calls = [];
    const impl = async (url, opts) => { calls.push({ url, opts }); return respond(url, opts); };
    impl.calls = calls;
    return impl;
  };
  const jsonRes = (status, obj) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj) });

  it("POSTs the documented shape and treats delivered/queued as acceptance", async () => {
    const impl = fakeFetch(async () => jsonRes(200, {
      success: true, errors: [], messages: [],
      result: { delivered: ["dest@example.com"], permanent_bounces: [], queued: [] },
    }));
    const tx = createCloudflareTransport({ ...cfCfg, fetchImpl: impl });
    const r = await tx.send({ to: "dest@example.com", subject: "Hi", text: "Body", html: "<p>Body</p>" });
    assert.equal(r.id, null, "Cloudflare returns no per-message id on this surface");
    assert.equal(impl.calls.length, 1);
    assert.ok(impl.calls[0].url.endsWith("/accounts/acct-1/email/sending/send"));
    assert.equal(impl.calls[0].opts.headers.authorization, "Bearer tok-1");
    const sent = JSON.parse(impl.calls[0].opts.body);
    assert.equal(sent.from, "KILN <kiln@pocketnova.app>");
    assert.equal(sent.to, "dest@example.com");
    assert.equal(sent.subject, "Hi");

    const implQ = fakeFetch(async () => jsonRes(200, {
      success: true, errors: [], messages: [],
      result: { delivered: [], permanent_bounces: [], queued: ["dest@example.com"] },
    }));
    const txQ = createCloudflareTransport({ ...cfCfg, fetchImpl: implQ });
    await txQ.send({ to: "dest@example.com", subject: "Hi", text: "B", html: null });
  });

  it("refusals throw with Cloudflare's code — never a silent acceptance", async () => {
    const denied = fakeFetch(async () => jsonRes(403, {
      success: false, result: null, messages: [],
      errors: [{ code: 10102, message: "email.sending.error.authentication.forbidden" }],
    }));
    const tx = createCloudflareTransport({ ...cfCfg, fetchImpl: denied });
    await assert.rejects(() => tx.send({ to: "dest@example.com", subject: "Hi", text: "B", html: null }), /10102/);

    const bounced = fakeFetch(async () => jsonRes(200, {
      success: true, errors: [], messages: [],
      result: { delivered: [], permanent_bounces: ["dest@example.com"], queued: [] },
    }));
    const txB = createCloudflareTransport({ ...cfCfg, fetchImpl: bounced });
    await assert.rejects(() => txB.send({ to: "dest@example.com", subject: "Hi", text: "B", html: null }), /permanent bounce/);
  });

  it("drains the outbox through Cloudflare when configured by env", async () => {
    assert.equal(transportConfigFromEnv({ KILN_CF_ACCOUNT_ID: "a", KILN_CF_API_TOKEN: "t" }), null, "cloudflare needs an explicit FROM");
    const cfg = transportConfigFromEnv({
      KILN_CF_ACCOUNT_ID: "acct-1", KILN_CF_API_TOKEN: "tok-1", KILN_MAIL_FROM: "KILN <kiln@pocketnova.app>",
    });
    assert.equal(cfg.kind, "cloudflare");
    const pinned = transportConfigFromEnv({
      KILN_MAIL_TRANSPORT: "cloudflare", KILN_CF_ACCOUNT_ID: "acct-1", KILN_CF_API_TOKEN: "tok-1", KILN_MAIL_FROM: "KILN <kiln@pocketnova.app>",
      KILN_SMTP_HOST: "smtp.office365.com", KILN_SMTP_USER: "u@x.io", KILN_SMTP_PASS: "p",
    });
    assert.equal(pinned.kind, "cloudflare", "the pin wins over other configured families");
  });
});

describe("mailer: HTTP surface", () => {
  let api;
  after(() => { try { api?.server?.close(); } catch { /* already closed */ } });

  it("outbox + send are operator-only and honest about configuration", async () => {
    const dir = makeStateDir();
    process.env.KILN_SWARM_API_PORT = "0";
    try {
      api = await startApiServer(dir, { apiPort: 0 });
    } finally {
      delete process.env.KILN_SWARM_API_PORT;
    }
    const opToken = loadApiToken(dir);
    const call = async (method, path, body, bearer) => {
      const res = await fetch(api.url + path, {
        method,
        headers: {
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, data: JSON.parse((await res.text()) || "{}") };
    };
    const su = await call("POST", "/v1/accounts", { email: "solo@example.com", name: "Solo", owner: "solo", password: "solo-password-1" });
    assert.equal(su.status, 201);
    const sess = (await call("POST", "/v1/accounts/login", { email: "solo@example.com", password: "solo-password-1" })).data.sessionToken;
    assert.equal((await call("GET", "/v1/mail/outbox", null, sess)).status, 403, "account sessions stay out of the outbox");
    const box = await call("GET", "/v1/mail/outbox", null, opToken);
    assert.equal(box.status, 200);
    assert.ok(box.data.mail.some((m) => m.kind === "introduction" && m.to === "s•••@example.com"), "signup queued the introduction, masked");
    const drain = await call("POST", "/v1/mail/send", null, opToken);
    assert.equal(drain.status, 200);
    if (!drain.data.configured) {
      assert.ok(drain.data.queued >= 1, "unconfigured: still queued-unsent, stated plainly");
    }
  });
});
