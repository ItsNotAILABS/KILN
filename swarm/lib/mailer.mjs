/**
 * KILN mail — the daemon sends email (the architect's order,
 * 2026-10-31: "Make it do an introduction email, and much more").
 *
 * Pieces:
 *   - A TEMPLATE REGISTRY (renderEmail). Every mail type is a named
 *     template rendered from a context object; new types plug in by
 *     adding one entry. Templates are functions of their context —
 *     there is no placeholder syntax to leak.
 *   - An OUTBOX (<stateDir>/mail-outbox.json, mode 0600). Sending is
 *     a two-step honesty discipline: enqueue only RECORDS intent;
 *     drainOutbox attempts delivery through a configured transport
 *     and records the outcome (queued → sent with the provider's
 *     acceptance id, or failed with the provider's reason, retries
 *     bounded at MAX_ATTEMPTS). With NO transport configured, mail
 *     stays "queued" and every surface says so — nothing is ever
 *     marked sent without a provider acceptance.
 *   - PLUGGABLE TRANSPORTS, configured by env (see docs/MAIL.md):
 *     SMTP (Outlook-compatible: smtp.office365.com STARTTLS / TLS)
 *     via KILN_SMTP_*, a generic HTTPS relay API via
 *     KILN_MAIL_API_URL + KILN_MAIL_API_KEY, or Cloudflare Email
 *     Sending (the app's own domain — the architect's ratified
 *     transport) via KILN_CF_ACCOUNT_ID + KILN_CF_API_TOKEN.
 *     From is KILN_MAIL_FROM.
 *
 * Encryption discipline matches the rest of the email layer: the
 * outbox stores the recipient as an email binding (ciphertext + HMAC
 * tag + masked form) and an invite's token as ciphertext — plaintext
 * addresses and tokens exist only in memory at the send moment.
 */
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { writeFileAtomicSync } from "./state.mjs";
import { decryptEmail, decryptText, encryptText } from "./emailcrypto.mjs";

export class MailerError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "MailerError";
    this.status = status;
  }
}

const OUTBOX_FILE = "mail-outbox.json";
export const MAX_ATTEMPTS = 3;
export const APP_URL = "https://kiln.pocketnova.app";

// ---------------------------------------------------------------- templates

function fmtExpiry(iso) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "full", timeStyle: "short", timeZone: "UTC",
    }).format(new Date(iso)) + " UTC";
  } catch {
    return String(iso);
  }
}

function htmlShell(title, bodyHtml) {
  return [
    "<!doctype html><html><body style=\"margin:0;padding:0;background:#0b0e14;\">",
    "<div style=\"max-width:560px;margin:0 auto;padding:32px 24px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#e6e9ef;\">",
    `<h1 style="font-size:20px;margin:0 0 16px;color:#ffffff;">${title}</h1>`,
    bodyHtml,
    "<p style=\"margin-top:32px;font-size:12px;color:#8a93a5;\">KILN — the developer platform for the AI internet · ItsNotAILABS</p>",
    "</div></body></html>",
  ].join("");
}

function p(text) {
  return `<p style="font-size:15px;line-height:1.55;margin:0 0 14px;">${text}</p>`;
}

function button(url, label) {
  return `<p style="margin:20px 0;"><a href="${url}" style="display:inline-block;background:#f97316;color:#111827;font-weight:600;text-decoration:none;padding:10px 18px;border-radius:8px;">${label}</a></p>`;
}

export const TEMPLATES = {
  /**
   * A workspace invite. Context: {workspaceName, inviter, role,
   * expiresAt, token, acceptUrl}. The token + accept link are the
   * payload — they reach the invitee ONLY through this email (or the
   * inviter's own out-of-band copy from the create response).
   */
  "workspace-invite": {
    subject: (c) => `You're invited to join ${c.workspaceName} on KILN`,
    text: (c) => [
      `${c.inviter} invited you to join the ${c.workspaceName} workspace on KILN as ${c.role === "admin" ? "an admin" : "a member"}.`,
      "",
      "KILN is the developer platform for the AI internet — one forge where people and their agents keep their repos, workspaces, and work together.",
      "",
      "Accept the invitation:",
      c.acceptUrl,
      "",
      `Or paste this token in the app: ${c.token}`,
      "",
      `Sign in (or sign up) with the email address this was sent to — the invite is tied to it. It expires ${fmtExpiry(c.expiresAt)} and works exactly once.`,
      "",
      "— KILN",
    ].join("\n"),
    html: (c) => htmlShell(`You're invited to ${c.workspaceName}`, [
      p(`${c.inviter} invited you to join the <strong>${c.workspaceName}</strong> workspace on KILN as ${c.role === "admin" ? "an admin" : "a member"}.`),
      p("KILN is the developer platform for the AI internet — one forge where people and their agents keep their repos, workspaces, and work together."),
      button(c.acceptUrl, "Accept the invitation"),
      p(`Or paste this token in the app: <code style="background:#161b26;padding:2px 6px;border-radius:4px;">${c.token}</code>`),
      p(`Sign in (or sign up) with the email address this was sent to — the invite is tied to it. It expires ${fmtExpiry(c.expiresAt)} and works exactly once.`),
    ].join("")),
    required: ["workspaceName", "inviter", "role", "expiresAt"],
    secret: "token",
  },

  /**
   * The introduction — sent when an account's email is bound
   * (signup, PUT /me/email, invite acceptance). The copy is the
   * architect-approved introduction text (2026-10-31), parameterized
   * minimally: the account handle, the workspace name when known,
   * and an optional paper line. Context: {owner, workspaceName?,
   * paperLine?}.
   */
  "introduction": {
    subject: () => "Welcome to KILN — your account is becoming an identity",
    text: (c) => [
      "Welcome to KILN — the developer platform for the AI internet, and the forge where ItsNotAILABS builds in the open.",
      "",
      `This email is now tied to your account (${c.owner}) — stored encrypted, shown only masked, and used for exactly two things: your business identity on KILN, and getting you back in if a device or wallet is ever lost. Signing in stays wallet-first: connect Phantom, and your profile, your wallets, and your work follow you to any browser.`,
      "",
      "What's yours on KILN:",
      `• ${c.workspaceName ? `The ${c.workspaceName} workspace` : "Your workspace"} — repos, projects, and your team, with members you add by email`,
      "• Your forge — public and private repositories, the Studio creation suite, and your own agents with their own accounts and wallets",
      `• Publishing — papers and projects released from KILN under your name, each with its own link.${c.paperLine ? ` ${c.paperLine}` : ""}`,
      "",
      `Start here: ${APP_URL}/${c.owner}`,
      "",
      "— Auro, for KILN · ItsNotAILABS",
    ].join("\n"),
    html: (c) => htmlShell("Welcome to KILN — your account is becoming an identity", [
      p("Welcome to KILN — the developer platform for the AI internet, and the forge where ItsNotAILABS builds in the open."),
      p(`This email is now tied to your account (<strong>${c.owner}</strong>) — stored encrypted, shown only masked, and used for exactly two things: your business identity on KILN, and getting you back in if a device or wallet is ever lost. Signing in stays wallet-first: connect Phantom, and your profile, your wallets, and your work follow you to any browser.`),
      p("What's yours on KILN:"),
      p(`• ${c.workspaceName ? `The ${c.workspaceName} workspace` : "Your workspace"} — repos, projects, and your team, with members you add by email<br>` +
        "• Your forge — public and private repositories, the Studio creation suite, and your own agents with their own accounts and wallets<br>" +
        `• Publishing — papers and projects released from KILN under your name, each with its own link.${c.paperLine ? ` ${c.paperLine}` : ""}`),
      button(`${APP_URL}/${c.owner}`, "Start here"),
      p("— Auro, for KILN · ItsNotAILABS"),
    ].join("")),
    required: ["owner"],
    secret: null,
  },

  /**
   * Generic account notice — the plug for future mail types (receipt
   * notices, security alerts, CI digests) that don't need their own
   * layout. Context: {title, body, ctaLabel?, ctaUrl?}.
   */
  "account-notice": {
    subject: (c) => c.title,
    text: (c) => [
      c.body,
      ...(c.ctaUrl ? ["", `${c.ctaLabel || "Open KILN"}: ${c.ctaUrl}`] : []),
      "",
      "— KILN",
    ].join("\n"),
    html: (c) => htmlShell(c.title, [
      p(c.body),
      ...(c.ctaUrl ? [button(c.ctaUrl, c.ctaLabel || "Open KILN")] : []),
    ].join("")),
    required: ["title", "body"],
    secret: null,
  },
};

/** Render a template against a context (secret values included by the caller). */
export function renderEmail(kind, context = {}) {
  const tpl = TEMPLATES[kind];
  if (!tpl) throw new MailerError(400, `unknown mail template: ${kind} — registered: ${Object.keys(TEMPLATES).join(", ")}`);
  for (const key of tpl.required) {
    if (context[key] === undefined || context[key] === null || context[key] === "") {
      throw new MailerError(400, `mail template "${kind}" needs context.${key}`);
    }
  }
  if (tpl.secret && !context[tpl.secret]) {
    throw new MailerError(400, `mail template "${kind}" needs its secret context (${tpl.secret})`);
  }
  return { subject: tpl.subject(context), text: tpl.text(context), html: tpl.html(context) };
}

// ---------------------------------------------------------------- outbox store

function outboxPath(dir) {
  return join(dir, OUTBOX_FILE);
}

function loadOutbox(dir) {
  const p = outboxPath(dir);
  if (!existsSync(p)) return { mail: {} };
  try {
    const s = JSON.parse(readFileSync(p, "utf8"));
    return { mail: s.mail || {} };
  } catch {
    return { mail: {} };
  }
}

function saveOutbox(dir, store) {
  writeFileAtomicSync(outboxPath(dir), JSON.stringify(store, null, 2) + "\n");
  try { chmodSync(outboxPath(dir), 0o600); } catch { /* best effort */ }
}

/** The outbox shape that may leave the daemon. Masked recipient only. */
export function mailPublic(rec) {
  return {
    id: rec.id, kind: rec.kind, to: rec.to.emailMasked,
    status: rec.status, attempts: rec.attempts,
    providerId: rec.providerId || null,
    lastError: rec.lastError || null,
    createdAt: rec.createdAt, updatedAt: rec.updatedAt,
    sentAt: rec.sentAt || null,
  };
}

/**
 * Record a mail for delivery. `to` is an email binding
 * ({emailHmac, emailEnc, emailMasked} — lib/emailcrypto.mjs); a
 * template `secret` value (an invite token) is encrypted before it
 * rests. Returns the public view. Status starts "queued" — always;
 * only drainOutbox with a provider acceptance may move it to "sent".
 */
export function enqueueMail(dir, { kind, to, context = {}, secret = null } = {}) {
  const tpl = TEMPLATES[kind];
  if (!tpl) throw new MailerError(400, `unknown mail template: ${kind} — registered: ${Object.keys(TEMPLATES).join(", ")}`);
  if (!to || typeof to.emailEnc !== "string" || typeof to.emailMasked !== "string") {
    throw new MailerError(400, "enqueueMail needs a recipient email binding ({emailHmac, emailEnc, emailMasked})");
  }
  if (tpl.secret && !secret) {
    throw new MailerError(400, `mail template "${kind}" requires a secret (${tpl.secret}) to enqueue`);
  }
  // Validate the context renders (with a stand-in secret) so a
  // malformed mail fails HERE, at the caller's doorstep, not at
  // drain time. The stand-in render is discarded.
  renderEmail(kind, { ...context, [tpl.secret || "noop"]: secret || "present", acceptUrl: "https://example.invalid/" });
  const now = new Date().toISOString();
  const record = {
    id: `mail_${randomBytes(6).toString("hex")}`,
    kind,
    to: { emailHmac: to.emailHmac, emailEnc: to.emailEnc, emailMasked: to.emailMasked },
    context,
    secretEnc: tpl.secret ? encryptText(dir, secret) : null,
    status: "queued",
    attempts: 0,
    providerId: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    sentAt: null,
  };
  const store = loadOutbox(dir);
  store.mail[record.id] = record;
  saveOutbox(dir, store);
  return mailPublic(record);
}

export function listOutbox(dir) {
  return Object.values(loadOutbox(dir).mail)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(mailPublic);
}

export function outboxCounts(dir) {
  const counts = { queued: 0, sent: 0, failed: 0, total: 0 };
  for (const rec of Object.values(loadOutbox(dir).mail)) {
    counts.total++;
    if (counts[rec.status] !== undefined) counts[rec.status]++;
  }
  return counts;
}

// ---------------------------------------------------------------- transports

/**
 * The configured transport, or null when the env carries none (or an
 * incomplete one). Env:
 *   KILN_MAIL_FROM       sender address (SMTP: defaults to the user)
 *   KILN_SMTP_HOST/PORT/SECURE(tls|starttls|none)/USER/PASS
 *   KILN_MAIL_API_URL + KILN_MAIL_API_KEY   (HTTPS relay)
 *   KILN_CF_ACCOUNT_ID + KILN_CF_API_TOKEN  (Cloudflare Email Sending;
 *                        KILN_MAIL_FROM required, as for HTTPS)
 *   KILN_MAIL_TRANSPORT  "smtp" | "https" | "cloudflare" — pins the
 *                        choice when several families are present.
 */
export function transportConfigFromEnv(env = process.env) {
  const pin = String(env.KILN_MAIL_TRANSPORT || "").toLowerCase();
  const cloudflare = () => {
    if (!env.KILN_CF_ACCOUNT_ID || !env.KILN_CF_API_TOKEN || !env.KILN_MAIL_FROM) return null;
    return {
      kind: "cloudflare",
      accountId: env.KILN_CF_ACCOUNT_ID, apiToken: env.KILN_CF_API_TOKEN,
      from: env.KILN_MAIL_FROM,
    };
  };
  if (pin === "cloudflare") return cloudflare();
  if (pin !== "https" && pin !== "cloudflare" && env.KILN_SMTP_HOST) {
    if (!env.KILN_SMTP_USER || !env.KILN_SMTP_PASS) return null;
    const port = parseInt(env.KILN_SMTP_PORT || "587", 10);
    const secure = ["tls", "starttls", "none"].includes(String(env.KILN_SMTP_SECURE || "").toLowerCase())
      ? String(env.KILN_SMTP_SECURE).toLowerCase()
      : (port === 465 ? "tls" : "starttls");
    return {
      kind: "smtp",
      host: env.KILN_SMTP_HOST, port, secure,
      user: env.KILN_SMTP_USER, pass: env.KILN_SMTP_PASS,
      from: env.KILN_MAIL_FROM || env.KILN_SMTP_USER,
    };
  }
  if (pin !== "smtp" && pin !== "cloudflare" && env.KILN_MAIL_API_URL) {
    if (!env.KILN_MAIL_API_KEY || !env.KILN_MAIL_FROM) return null;
    return {
      kind: "https",
      url: env.KILN_MAIL_API_URL, apiKey: env.KILN_MAIL_API_KEY,
      from: env.KILN_MAIL_FROM,
    };
  }
  if (!pin) return cloudflare();
  return null;
}

export function transportFromEnv(env = process.env) {
  const cfg = transportConfigFromEnv(env);
  if (!cfg) return null;
  if (cfg.kind === "smtp") return createSmtpTransport(cfg);
  if (cfg.kind === "cloudflare") return createCloudflareTransport(cfg);
  return createHttpsTransport(cfg);
}

/**
 * Cloudflare Email Sending (REST) — the app sends from its own
 * domain (the architect ratified Cloudflare as the mailer's domain,
 * 2026-10-31). POST /accounts/{id}/email/sending/send with a bearer
 * token carrying the Email Sending permission; acceptance is the
 * recipient landing in the response's delivered[] or queued[] —
 * a permanent bounce or an API error is a refusal and throws with
 * Cloudflare's own code + message, so the outbox records the truth.
 * Cloudflare returns no per-message id on this surface, so a sent
 * record's providerId stays null (status + sentAt are the receipt).
 */
export function createCloudflareTransport(cfg) {
  const doFetch = cfg.fetchImpl || fetch;
  return {
    kind: "cloudflare",
    from: cfg.from,
    async send({ to, subject, text, html }) {
      const res = await doFetch(`https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/email/sending/send`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${cfg.apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ from: cfg.from, to, subject, text, html }),
      });
      const body = await res.text();
      let j = null;
      try { j = JSON.parse(body); } catch { /* handled below */ }
      if (!res.ok || !j?.success) {
        const e = j?.errors?.[0];
        throw new Error(`Cloudflare Email Sending refused (${res.status}${e ? `, code ${e.code}` : ""}): ${e?.message || body.slice(0, 300)}`);
      }
      const delivered = j.result?.delivered || [];
      const queued = j.result?.queued || [];
      const bounced = j.result?.permanent_bounces || [];
      if (bounced.includes(to)) {
        throw new Error(`Cloudflare Email Sending: permanent bounce for the recipient`);
      }
      if (!delivered.includes(to) && !queued.includes(to)) {
        throw new Error(`Cloudflare Email Sending: response did not accept the recipient (delivered=${delivered.length}, queued=${queued.length})`);
      }
      return { id: null };
    },
  };
}

/** Generic HTTPS relay: POST {from, to, subject, text, html} with a bearer key. */
export function createHttpsTransport(cfg) {
  return {
    kind: "https",
    from: cfg.from,
    async send({ to, subject, text, html }) {
      const res = await fetch(cfg.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${cfg.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ from: cfg.from, to, subject, text, html }),
      });
      const body = await res.text();
      if (!res.ok) throw new Error(`mail API refused (${res.status}): ${body.slice(0, 300)}`);
      let id = null;
      try { const j = JSON.parse(body); id = j.id || j.messageId || j.data?.id || null; } catch { /* id is best-effort */ }
      return { id: id ? String(id) : null };
    },
  };
}

// ---- minimal SMTP client (RFC 5321): EHLO, STARTTLS, AUTH LOGIN, DATA.
// Zero-dependency by house rule; the dialogue is deliberately small
// and every refusal surfaces the server's own words as the error.

function smtpSession(socket) {
  let buf = "";
  const waiters = [];
  socket.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx + 1);
      buf = buf.slice(idx + 1);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i](line)) waiters.splice(i, 1);
      }
    }
  });
  /** Read one (possibly multiline) reply; resolves {code, text}. */
  function readReply() {
    return new Promise((resolve, reject) => {
      const lines = [];
      const timer = setTimeout(() => reject(new Error("SMTP reply timed out")), 20000);
      const onLine = (line) => {
        lines.push(line.trimEnd());
        const m = line.match(/^(\d{3})([ -])/);
        if (m && m[2] === " ") {
          clearTimeout(timer);
          resolve({ code: parseInt(m[1], 10), text: lines.join("\n") });
          return true;
        }
        return false;
      };
      waiters.push(onLine);
      socket.once("error", (e) => { clearTimeout(timer); reject(e); });
    });
  }
  async function cmd(line, expect) {
    socket.write(line + "\r\n");
    const r = await readReply();
    if (!expect.includes(r.code)) {
      throw new Error(`SMTP ${line.split(" ")[0]} refused: ${r.text.slice(0, 300)}`);
    }
    return r;
  }
  return { readReply, cmd };
}

function encodeSubject(subject) {
  // RFC 2047 encoded-word when the subject leaves ASCII (workspace
  // names are Unicode); plain otherwise.
  return /^[\x20-\x7e]*$/.test(subject)
    ? subject
    : `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

function buildMime({ from, to, subject, text, html, id }) {
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${id}@kiln-smtp>`,
    "MIME-Version: 1.0",
  ];
  if (!html) {
    headers.push("Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64");
    return headers.join("\r\n") + "\r\n\r\n" + Buffer.from(text, "utf8").toString("base64");
  }
  const boundary = `kiln-${randomBytes(9).toString("hex")}`;
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  const part = (type, body) => [
    `--${boundary}`,
    `Content-Type: ${type}; charset=utf-8`,
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(body, "utf8").toString("base64"),
  ].join("\r\n");
  return headers.join("\r\n") + "\r\n\r\n" +
    part("text/plain", text) + "\r\n" + part("text/html", html) + `\r\n--${boundary}--`;
}

export function createSmtpTransport(cfg) {
  return {
    kind: "smtp",
    from: cfg.from,
    async send({ to, subject, text, html }) {
      const raw = cfg.secure === "tls"
        ? tlsConnect({ host: cfg.host, port: cfg.port, servername: cfg.host })
        : netConnect({ host: cfg.host, port: cfg.port });
      const socket = await new Promise((resolve, reject) => {
        raw.once("connect", () => resolve(raw));
        raw.once("secureConnect", () => resolve(raw));
        raw.once("error", reject);
        setTimeout(() => reject(new Error("SMTP connect timed out")), 20000);
      });
      try {
        let s = smtpSession(socket);
        const greeting = await s.readReply();
        if (greeting.code !== 220) throw new Error(`SMTP greeting refused: ${greeting.text.slice(0, 200)}`);
        await s.cmd("EHLO kiln.local", [250]);
        if (cfg.secure === "starttls") {
          await s.cmd("STARTTLS", [220]);
          const upgraded = await new Promise((resolve, reject) => {
            const t = tlsConnect({ socket, servername: cfg.host }, () => resolve(t));
            t.once("error", reject);
          });
          s = smtpSession(upgraded);
          await s.cmd("EHLO kiln.local", [250]);
          return await deliver(upgraded, s);
        }
        return await deliver(socket, s);
      } finally {
        try { socket.destroy(); } catch { /* already gone */ }
      }

      async function deliver(sock, s) {
        await s.cmd("AUTH LOGIN", [334]);
        await s.cmd(Buffer.from(cfg.user, "utf8").toString("base64"), [334]);
        await s.cmd(Buffer.from(cfg.pass, "utf8").toString("base64"), [235]);
        await s.cmd(`MAIL FROM:<${cfg.from}>`, [250]);
        await s.cmd(`RCPT TO:<${to}>`, [250, 251]);
        await s.cmd("DATA", [354]);
        const mime = buildMime({ from: cfg.from, to, subject, text, html, id: randomBytes(8).toString("hex") });
        sock.write(mime + "\r\n.\r\n");
        const done = await s.readReply();
        if (done.code !== 250) throw new Error(`SMTP DATA refused: ${done.text.slice(0, 300)}`);
        try { await s.cmd("QUIT", [221]); } catch { /* the mail already landed */ }
        const m = done.text.match(/queued as[:\s]+([A-Za-z0-9._-]+)/i)
          || done.text.match(/\bid[:=]\s*([A-Za-z0-9._-]+)/i);
        return { id: m ? m[1] : null };
      }
    },
  };
}

// ---------------------------------------------------------------- drain

/**
 * Attempt delivery of every queued record. Returns honest counts:
 * with no transport configured, {configured:false} and NOTHING moves
 * — the outbox keeps saying "queued", which is the truth. A failed
 * attempt increments attempts and stores the provider's reason; at
 * MAX_ATTEMPTS the record is terminally "failed" until an operator
 * requeues it at the store level (no silent infinite retry).
 */
export async function drainOutbox(dir, { transport, env = process.env, limit = 50 } = {}) {
  const tx = transport !== undefined ? transport : transportFromEnv(env);
  const store = loadOutbox(dir);
  const queued = Object.values(store.mail)
    .filter((r) => r.status === "queued")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (!tx) {
    return { configured: false, attempted: 0, sent: 0, failed: 0, queued: queued.length };
  }
  let sent = 0, failed = 0, attempted = 0;
  for (const rec of queued.slice(0, limit)) {
    attempted++;
    try {
      const to = decryptEmail(dir, rec.to.emailEnc);
      if (!to) throw new Error("recipient address could not be decrypted (email key mismatch)");
      const tpl = TEMPLATES[rec.kind];
      const secret = rec.secretEnc ? decryptText(dir, rec.secretEnc) : null;
      const context = { ...rec.context };
      if (tpl?.secret) {
        if (!secret) throw new Error("the mail's secret could not be decrypted (email key mismatch)");
        context[tpl.secret] = secret;
        context.acceptUrl = `${APP_URL}/invites/${secret}`;
      }
      const { subject, text, html } = renderEmail(rec.kind, context);
      const r = await tx.send({ to, subject, text, html });
      rec.status = "sent";
      rec.providerId = r?.id ? String(r.id) : null;
      rec.sentAt = new Date().toISOString();
      rec.lastError = null;
      sent++;
    } catch (e) {
      rec.attempts++;
      rec.lastError = String(e?.message || e).slice(0, 500);
      rec.status = rec.attempts >= MAX_ATTEMPTS ? "failed" : "queued";
      if (rec.status === "failed") failed++;
    }
    rec.updatedAt = new Date().toISOString();
    saveOutbox(dir, store);
  }
  const remaining = Object.values(store.mail).filter((r) => r.status === "queued").length;
  return { configured: true, attempted, sent, failed, queued: remaining };
}
