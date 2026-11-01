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

## Wallet identity binding + encrypted backup

An account can bind **wallet addresses** to itself — the fix for the
app's generated wallet being a browser-local key with no daemon
identity (a second browser used to force a brand-new wallet):

- **Linking is proof, not assertion.** `POST
  /v1/accounts/me/wallets/challenge` issues a short-TTL (5 min),
  single-use challenge naming the account + address; the wallet
  signs it with its ed25519 key; `POST /v1/accounts/me/wallets`
  verifies before linking. Any attempt consumes the challenge
  (replays answer 404, expiry 410, bad signature 403). Kinds:
  `local` (the app's generated key) and `phantom`. A base58 address
  must present its own public key (the address *is* the key); a `0x`
  address binds to the presented key as a pair. **An address links
  to exactly one account** — a second account's valid proof answers
  409, and only after its own signature verifies (link state is
  never revealed to someone who cannot sign for the address).
- **Encrypted backup.** `PUT /v1/accounts/me/wallet-backup` stores
  an opaque blob + KDF metadata: the client encrypts the local
  secret with a password-derived key **in the browser**; the server
  never sees plaintext, never logs the blob, and returns it only to
  the owning account's **session** (`GET …/wallet-backup`; agent
  tokens are refused). This is what lets a fresh browser restore the
  same wallet after sign-in.
- **Restore surface.** `GET /v1/accounts/me` and `GET
  /v1/accounts/me/wallets` carry the links with per-wallet
  `hasBackup` (local wallets only), so a new browser renders "wallet
  0x… is linked to this account — restore" instead of "generate a
  new wallet".
- Linking/unlinking and backup writes are **session-only** — agent
  tokens cannot manage who the account *is*, the same rule as agent
  management. Unlinking frees the address for another account.

The daemon surface is the whole of this piece; the app-side restore
UX (restore flow, backup prompt at generation, Phantom link in
profile settings) is a separate lane in kiln-workspace.

## Encrypted email binding

An account can be tied to its email — the business identity and the
recovery path — under the architect's rule (2026-10-31): *"encrypt
my email and stuff."* The binding (`lib/emailcrypto.mjs`) is the
**only** storage an address gets:

- At rest an address is an **AES-256-GCM ciphertext** plus an
  **HMAC-SHA256 lookup tag** over the normalized (trim + lowercase)
  address, plus its **masked form** (`a•••@example.com`). The master
  key lives in `<stateDir>/email.key` (mode 0600, generated on first
  use, never committed, never logged); encryption and HMAC keys are
  HKDF-derived from it under separate labels.
- **Matching never decrypts.** Login, duplicate checks, and invite
  acceptance all compare HMAC tags. Decryption exists only for
  in-memory internal uses (forge commit authorship; the mailer's
  send moment) — **no endpoint returns a full address once a binding
  exists**: `GET /v1/accounts/me` carries `emailMasked` and
  `emailBound: true`.
- **Signup binds** through this same path (no plaintext address is
  stored for a new account). A legacy record from before the binding
  era keeps its plaintext address until its first successful login
  or a bind migrates it — the plaintext is deleted in the same write.
- `PUT /v1/accounts/me/email` (session-only) binds or rebinds. **One
  address ties to exactly one account** — an address held by another
  account answers 409. A binding *change* enqueues the introduction
  email (see `docs/MAIL.md`); re-saving the same address stays quiet.
- **Workspace invites adopt bindings** (see `docs/WORKSPACES.md`):
  accepting an invite copies the invite's encrypted binding onto an
  unbound account; an account bound to a *different* address is
  refused 409 — an invite can never silently re-tie an account.

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
