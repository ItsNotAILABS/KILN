# KILN accounts + agent identities

The forge has three kinds of principal, resolved in this order on
every gated request:

| Principal | Bearer | Who |
|---|---|---|
| **operator** | the root token from `<stateDir>/api.token` | the forge's owner. Root: every surface, every namespace. Unchanged from before accounts existed — the CLI, the MCP server, and the agent kit keep working exactly as they did. |
| **session** | `kiln_sess_…` (30 days) | a person who signed up and logged in. Acts only under their own `owner` namespace. |
| **agent** | `kiln_agt_…` (until revoked) | an agent identity minted by an account. Acts only under the owning account's namespace, and only within its `scopes`. |

## The model

- **Account** — `{ id (acct_…), email, name, owner, createdAt }`. The
  `owner` is the account's namespace on the forge: its workspaces and
  repos live under that owner, and owner scoping is what keeps one
  account out of another's work. Passwords are stored as scrypt
  hashes (per-account salt); they are never returned anywhere.
- **Signup** — `POST /v1/accounts { email, name, owner, password }`
  (public bootstrap; password ≥ 10 chars; owner must match
  `[a-z0-9][a-z0-9-]{0,63}`). Email and owner are unique across
  accounts (409). A namespace that **already has repos or workspaces**
  is *reserved*: a public signup cannot claim it — only an
  operator-signed signup can (that's how the forge's owner claims
  their own long-standing namespace).
- **Login** — `POST /v1/accounts/login { email, password }` →
  `{ account, sessionToken, expiresAt }`. One error message
  ("invalid email or password") covers every failure mode.
- **Agent identity** — `{ id (agt_…), accountId, name, scopes,
  createdAt, revoked }`. Minted by the account owner from a session:
  `POST /v1/accounts/me/agents { name, scopes? }` → the raw token is
  in that response **exactly once**; only its sha256 is stored.
  `GET /v1/accounts/me/agents` lists, `DELETE
  /v1/accounts/me/agents/:id` revokes (the record stays for audit;
  the token dies immediately). Agent tokens cannot manage agents —
  minting and revoking are owner acts.
- **Scopes** — `workspaces` and `project-details`. An agent token
  without the matching scope gets a 403 naming the missing scope.
  Default when unspecified: both.

## What account/agent principals may reach

Discovery (`/v1/capabilities`, `/v1/openapi.json`), their own account
routes (`/v1/accounts/me…`), workspaces, and repo project-details.
Within workspaces and details, owner scoping applies:

- create workspace → only under your own `owner`;
- list workspaces → silently scoped to your own;
- get/patch/delete a workspace → yours, or 403;
- describe (PATCH details) → only repos under your own `owner`;
- read details → any repo (details are the forge's discovery face).

Everything else under the auth gate is **operator-only** for account
and agent principals, and answers 403 saying so. That includes
**sites** and the **git transport**: pushes still use the operator
bearer recipe in this slice — account/agent tokens are API
principals, not git credentials (yet). Both boundaries are stated
here so nobody has to discover them from an error.

## Storage + hygiene

`<stateDir>/accounts.json`, written atomically like the other
registries, mode 0600. At rest it holds only hashes: scrypt password
hashes, sha256 session/agent token hashes. No hash, salt, password,
or raw token ever appears in a response or a log.

## Known limits (named, not hidden)

- No rate limiting on login/signup yet — the forge is
  operator-hosted and tunnel-fronted; brute-force throttling is a
  named follow-up before any public signup push.
- Sessions expire after 30 days and are not individually revocable
  yet (no logout endpoint in this slice); agent tokens are the
  revocable credential.
- Account principals cannot push git or manage sites yet (above).

## Rollout

These routes are code in `lib/accounts.mjs` + `lib/httpapi.mjs`.
Like every daemon change, they go live on the daemon's next
Doctor-owned boot — until then the live daemon answers 404 for
`/v1/accounts*`, which means *staged*, not broken.
