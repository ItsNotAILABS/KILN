# KILN mail — the daemon sends email

The architect's order (2026-10-31): *"Make it do an introduction
email, and much more."* The daemon owns a mailer (`lib/mailer.mjs`):
a template registry, an outbox, and pluggable transports. The app
sends its own mail from its own domain — never through anyone's
personal mailbox.

## Templates

Every mail type is a named template rendered from a context object —
functions of their context, no placeholder syntax to leak. A template
that needs a secret (an invite token) refuses to render without it,
and `enqueueMail` validates the render at enqueue time so a malformed
mail fails at the caller's doorstep, not at drain time.

| Template | Fires when | Context |
|---|---|---|
| `workspace-invite` | A workspace invite is created | workspaceName, inviter, role, expiresAt (+ secret: token) |
| `introduction` | An account's email is bound (signup, `PUT /me/email`, invite acceptance) — and only when the binding *changes*, so re-saving the same address stays quiet | owner, workspaceName?, paperLine? |
| `account-notice` | The generic plug for future mail (receipts, security alerts, digests) | title, body, ctaLabel?, ctaUrl? |

The `introduction` copy is the architect-approved welcome text
(2026-10-31), parameterized minimally (handle, workspace name, an
optional paper line). A test pins it byte-for-byte.

## The outbox, and the honesty discipline

`<stateDir>/mail-outbox.json`, mode 0600, one record per mail:

- **Enqueue only records intent.** Status starts `queued` — always.
- **Drain is the only path to `sent`**, and only on provider
  acceptance (the provider's id is recorded when the surface returns
  one). A failure keeps the provider's own words in `lastError`,
  increments `attempts`, and goes terminally `failed` at 3 attempts —
  no silent infinite retry.
- **No transport configured → nothing moves** and every surface says
  so: `POST /v1/mail/send` answers `{configured:false, …}` and the
  mail stays `queued`. Nothing is ever marked sent without an
  acceptance.
- **Encryption matches the email layer**: the recipient rests as an
  encrypted binding (AES-256-GCM ciphertext + HMAC tag + masked
  form), a template secret rests as ciphertext. Plaintext addresses
  and tokens exist only in memory at the send moment.
  `GET /v1/mail/outbox` is operator-only and shows masked recipients.

Routes: `GET /v1/mail/outbox`, `POST /v1/mail/send` (operator token).
Drains also happen implicitly nowhere — sending is an explicit act.

## Transports (env-configured)

| Kind | Env | Notes |
|---|---|---|
| `cloudflare` | `KILN_CF_ACCOUNT_ID`, `KILN_CF_API_TOKEN`, `KILN_MAIL_FROM` | Cloudflare Email Sending REST — the ratified transport (below) |
| `smtp` | `KILN_SMTP_HOST`, `KILN_SMTP_PORT` (587), `KILN_SMTP_SECURE` (tls\|starttls\|none), `KILN_SMTP_USER`, `KILN_SMTP_PASS`, `KILN_MAIL_FROM` (defaults to the user) | Minimal zero-dependency SMTP client; Outlook-compatible (smtp.office365.com). Cloudflare's own SMTP submission (smtp.mx.cloudflare.net) also fits this shape once console credentials exist |
| `https` | `KILN_MAIL_API_URL`, `KILN_MAIL_API_KEY`, `KILN_MAIL_FROM` | Generic relay: POST `{from, to, subject, text, html}` with a bearer key |

`KILN_MAIL_TRANSPORT=smtp|https|cloudflare` pins the family when
several are configured; an incomplete family reads as unconfigured.

## Cloudflare Email Sending — the ratified transport, and its gate

The architect ratified Cloudflare as the mailer's domain/transport
(2026-10-31: *"Cloudflare is fine as its domain"*). The daemon sends
via `POST /accounts/{account_id}/email/sending/send`; acceptance is
the recipient appearing in the response's `delivered[]` or
`queued[]` (a `permanent_bounces[]` entry or an API error is a
refusal, recorded with Cloudflare's error code).

**Status (probed live 2026-10-31): gated on account-side setup.** The
Cloudflare API token the house deploys with carries Workers + DNS
scopes only — the send endpoint answers `401 / code 10000`
(Authentication error) and Email Routing reads answer `403 / code
10000`. Enabling takes, all by the account owner in the dashboard:

1. **Token scope** — edit the API token (or mint one) adding the
   Email Sending permission; put it in the daemon's env as
   `KILN_CF_API_TOKEN` with `KILN_CF_ACCOUNT_ID` and
   `KILN_MAIL_FROM` (e.g. `KILN <kiln@pocketnova.app>`).
2. **Domain onboarding** — Email Service → Email Sending → Onboard
   Domain for `pocketnova.app`; Cloudflare adds the SPF / DKIM /
   DMARC records and the `cf-bounce` MX automatically.
3. **Recipient entitlement** — sending to arbitrary recipients
   requires the Workers Paid plan. On the free plan, sends to
   **destination addresses verified in Email Routing** still work
   (and are quota-exempt) — enough for the first welcome mail once
   the recipient verifies.

Until then the outbox queues honestly. The transport itself is built
and unit-tested (fake-fetch wire shape + refusals in
`test/mailer.test.mjs`); the moment the env lands, `POST
/v1/mail/send` delivers everything queued.

## Who enqueues what

- **Signup** (`POST /v1/accounts`) → `introduction` to the new
  account's bound address.
- **`PUT /v1/accounts/me/email`** on a binding change →
  `introduction` to the new address.
- **Invite create** → `workspace-invite` to the invited address,
  carrying the accept link + token (the token also returns once in
  the create response for out-of-band delivery — belt and braces,
  because until a transport is configured the email cannot fly).
- **Invite accept** on a binding change → `introduction`.
