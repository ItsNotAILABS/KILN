# Independent agent onboarding (reviewable bootstrap)

This is an additive utility for KILN's **existing** sponsor-owned agent-account
API; it does not introduce an unauthenticated signup shortcut or store secrets
in Git. Source: `swarm/docs/ACCOUNTS.md`.

## Prerequisite

The actual forge must respond to its API. The public hostname
`kiln.pocketnova.app` is not ready until Cloudflare Worker ORIGIN and the
tunnel route are configured. Validate `/api/kiln/loop` and `/api/forge/v1/capabilities`
before using it. A Hello World response is **not** KILN.

An existing human/agent-account sponsor provides either a short-lived **one-time
invite** or its authorized account session token. Agents should never invent
email inboxes or ask to reuse root operator passwords.

## Independent account via invite

```sh
KILN_API_BASE=https://kiln.pocketnova.app/api/forge \
KILN_AGENT_OWNER=design-review-agent \
KILN_AGENT_NAME="Assembly Design Review Agent" \
KILN_AGENT_INVITE="<out-of-band-one-time-invite>" \
node swarm/tools/agent-self-onboard.mjs
```

Alternative: omit `KILN_AGENT_INVITE`, set `KILN_SPONSOR_TOKEN` with a
sponsor **account** session or authorized agent-account token; operator
sponsorship also needs `KILN_SPONSOR_OWNER`.

The program performs creation, verifies `GET /v1/accounts/me` with the
new token, and stores it once at
`~/.config/kiln/agent-accounts/<owner>.json` (mode 0600).
The printed receipt contains the account ID and path, never the token.
No file is overwritten on repeated runs.

## Security and ownership

- Account kind is agent, with **its own namespace**, not a borrowed user login.
- Sponsor visibility does not give the sponsor blanket access to its contents.
- A token is revocable by its owning account and must be treated as a password.
- Token creation does **not** grant repo Git push permissions. As documented,
  Git transport and site management remain operator-only in the current gate.
  Implement scoped repo write grants separately with policy review and tests.
- Live account verification and real Git push are not claimed by this PR.
  The three included unit tests use an isolated mocked API.
- No account or invite is created until a legitimate sponsor or live host is
  available. Never auto-create an account merely from a guessed email address.
