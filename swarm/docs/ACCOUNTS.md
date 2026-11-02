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
- **Login (password)** — `POST /v1/accounts/login { email, password }` →
  `{ account, sessionToken, expiresAt }`. One error message
  ("invalid email or password") covers every failure mode.
- **Login (wallet signature)** — see "The unified login model"
  below: a wallet already linked to the account signs a sign-in
  challenge and receives the same session shape for the same
  account.
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

## The unified login model

**One account, several doors — every door resolves to the same
account, the same profile, the same session shape.** There is no
"wallet account" versus "email account": a wallet is a *key* bound
to an account (see "Wallet identity binding" below), and signing
with it is just another way to prove you are that account's owner.

| Door | Routes | Credential | Resolves to |
|---|---|---|---|
| **Password** | `POST /v1/accounts/login { email, password }` | the account password (scrypt-verified) | a `kiln_sess_…` session for that account |
| **Wallet signature** | `POST /v1/accounts/wallet/challenge { address, publicKey? }` → `POST /v1/accounts/wallet/verify { challengeId, address, signature, publicKey? }` | an ed25519 signature from a wallet **already linked** to the account | a `kiln_sess_…` session for the **owning** account — the account the wallet is linked to, never an account the request merely claims (claim fields are ignored) |
| **OAuth (Google / X)** | `GET /v1/accounts/oauth/:provider/start` → provider → `GET /v1/accounts/oauth/:provider/callback` → `POST /v1/accounts/oauth/handoff { code }` (matched) or `POST /v1/accounts/oauth/complete { pendingToken, owner, name }` (first login) | the provider's authorization code, exchanged server-side with PKCE | a `kiln_sess_…` session for the account the provider identity **resolves to** (see "OAuth sign-in" below) — never a parallel "social account" |
| **Agent token** | any gated route with the agent bearer | `kiln_agt_…`, minted by the account owner from a session | the agent principal, acting under its owning account's namespace within its scopes (agents do not "log in" — the token *is* their standing credential, revocable by the owner) |

- **Session restore is `/me`.** Whichever door you came through,
  `GET /v1/accounts/me` (session or agent bearer) returns the
  account, the principal kind, and the wallet restore surface — a
  fresh browser signs in by any door and renders the same profile,
  the same linked wallets, the same everything. Sessions last 30
  days; there is no separate "wallet session" to confuse with a
  "password session".
- **Wallet sign-in semantics mirror wallet linking exactly** (the
  same challenge machinery, pointed the other way): the challenge
  is short-TTL (5 min), single-use, and consumed by *any* verify
  attempt — replay answers 404, expiry 410, a bad signature 403.
  The message is `kiln-wallet-signin\naddress:<addr>\nnonce:<hex>\n
  expires:<iso>` — its own purpose tag, and sign-in challenges live
  in a separate store from link challenges, so neither can be spent
  as the other. The challenge names **no account**: proof comes
  first, and only a valid signature earns the session that reveals
  the owner. Both wallet kinds sign in — a base58 (Phantom)
  address, whose address *is* its key (`publicKey` optional), and
  the app's local `0x` identity key (key presented as a pair, or
  omitted and the linked wallet's stored key is used).
- **Unlinked wallet → an honest, machine-readable refusal.** After
  a *valid* signature from an address linked to no account (or
  linked to a different key), verify answers **403** with
  `reason: "wallet_not_linked"` (the same string as `code` and as
  the `error` prefix) and mints nothing. The app's move is fixed:
  sign in by another door, link the wallet, then wallet sign-in
  works. Link state is never revealed to a bad signature — that
  case is a plain 403 with no reason field.
## OAuth sign-in (Google + X)

Real OAuth 2.0 doors, built 2026-11-02 on the architect's re-scope
("actually do the work"). Provider mechanics (endpoints, PKCE, the
code exchange, the identity fetch) live in `lib/oauth.mjs`; the
state machines and identity resolution live in the OAuth section of
`lib/accounts.mjs`.

- **Configuration is daemon env, nothing else:**
  `KILN_OAUTH_GOOGLE_CLIENT_ID`, `KILN_OAUTH_GOOGLE_CLIENT_SECRET`,
  `KILN_OAUTH_X_CLIENT_ID`, `KILN_OAUTH_X_CLIENT_SECRET`, and the
  optional `KILN_OAUTH_REDIRECT_BASE` (default
  `https://kiln.pocketnova.app`). Secrets are never logged, never
  stored in `accounts.json`, and never placed in a URL.
- **Redirect URIs — register these byte-for-byte in the provider
  consoles:**
  - `https://kiln.pocketnova.app/api/forge/v1/accounts/oauth/google/callback`
  - `https://kiln.pocketnova.app/api/forge/v1/accounts/oauth/x/callback`

  The app origin proxies `/api/forge/*` to the daemon's `/v1/*`
  (the proxy strips the `/api/forge` prefix), so the daemon routes
  are `/v1/accounts/oauth/:provider/*` while the public callback
  URIs above are what the providers call.
- **Start.** `GET /v1/accounts/oauth/:provider/start?return=<path>`
  (public bootstrap, like login). `return` must be an app-relative
  path (default `/login`; absolute URLs are refused 400 — no open
  redirects). The daemon mints a random state — stored **hashed**
  (sha256), **10-minute TTL, single-use**, bound to the return path
  and to a PKCE verifier — and 302s to the provider authorization
  URL with the **PKCE S256** challenge (both providers).
- **Not configured is honest.** When a provider's client id/secret
  are absent from the daemon env, start answers **503** with
  `{"error": "provider_not_configured", "provider": "<provider>"}`
  — a machine-readable state the app renders as-is. It is never
  dressed up as a sign-in failure.
- **Callback.** `GET /v1/accounts/oauth/:provider/callback?code&state`
  consumes the state on ANY attempt (unknown or replayed → **400**,
  expired → **410**), exchanges the code server-side at the
  provider token endpoint with the PKCE verifier, and fetches the
  identity — Google: userinfo (`sub`, `email`, `email_verified`);
  X: `GET /2/users/me` (`id`, `username`; X does not reliably
  return an email and nothing here depends on one).
- **Identity resolution, in order:** **(1)** a stored provider
  link — an account whose `oauthLinks` carry this provider +
  subject → that account. **(2)** **Google only, and only when
  `email_verified=true`:** the provider email's HMAC tag (the same
  encrypted-email matcher as every other door — matching never
  decrypts, and provider emails are never stored in plaintext)
  matches an account → that account, and the provider link is
  recorded on it. An **unverified email never merges accounts** —
  it falls through to (3). **(3)** No match → an `oauthPending`
  record (hashed token, **15-minute TTL**) and a 302 to
  `<return or /login>#oauth_pending=<token>`; the app collects a
  handle and calls `POST /v1/accounts/oauth/complete
  { pendingToken, owner, name }`, which validates exactly like
  password signup (minus password), creates the ONE account,
  records the provider link, and mints a session — the response is
  exactly wallet verify's `{ok, account, sessionToken, expiresAt}`.
  The pending token is consumed by any attempt **except** an
  owner-already-claimed **409**, which leaves it alive so the
  person can retry with a different handle. A verified Google
  email becomes the new account's encrypted email binding; an
  unverified one never does, and an X-born account simply has no
  email binding.
- **A session never travels in a URL.** A matched sign-in does not
  redirect with a token: the callback mints a **handoff code**
  (hashed, single-use, **2-minute TTL**) and 302s to
  `<return path>#oauth_handoff=<code>`; the app redeems it at
  `POST /v1/accounts/oauth/handoff { code }` →
  `{ok, account, sessionToken, expiresAt}`. Handoffs are consumed
  by any redemption attempt (unknown/replayed → **404**, expired
  → **410**).
- **Storage** is `accounts.json`, alongside the other doors:
  `oauthStates {}`, `oauthPending {}`, `oauthHandoffs {}` (all
  keyed by sha256 of the raw value) and per-account
  `oauthLinks [{provider, subject, linkedAt}]` (surfaced on the
  account's public shape; a link is an identity pointer, never a
  credential — no provider token is stored anywhere).
- **The ONE remaining gate, stated plainly:** the flow is built
  and tested end-to-end against a stub provider, but it activates
  for real users only when **the architect creates the Google
  Cloud OAuth client and the X developer app and supplies the two
  credential pairs** to the daemon env above (with the redirect
  URIs registered byte-for-byte). Until then both providers answer
  the honest 503 — and, like every daemon change, the code itself
  rides the next Doctor-owned boot.

The full `/v1/accounts*` route map, for the avoidance of doubt:
signup `POST /v1/accounts`; password login `POST
/v1/accounts/login`; wallet sign-in `POST
/v1/accounts/wallet/challenge` + `POST /v1/accounts/wallet/verify`;
OAuth sign-in `GET /v1/accounts/oauth/:provider/start`, `GET
/v1/accounts/oauth/:provider/callback`, `POST
/v1/accounts/oauth/complete`, `POST /v1/accounts/oauth/handoff`;
self `GET /v1/accounts/me`; agents `POST/GET
/v1/accounts/me/agents`, `DELETE /v1/accounts/me/agents/:id`;
agent accounts `POST/GET /v1/accounts/me/agent-accounts`,
sponsor-link severing `DELETE
/v1/accounts/me/agent-accounts/:id`; agent
invite links `POST/GET /v1/accounts/me/agent-invites`, `DELETE
/v1/accounts/me/agent-invites/:id`, redemption `POST
/v1/agent-invites/:token/redeem` (public bootstrap); wallet
linking `POST /v1/accounts/me/wallets/challenge`, `POST/GET
/v1/accounts/me/wallets`, `DELETE
/v1/accounts/me/wallets/:address`; encrypted backup `PUT/GET
/v1/accounts/me/wallet-backup`; email binding `PUT
/v1/accounts/me/email`.

## Agent accounts + agent invite links

An **agent account** is a first-class account with `kind: "agent"`:
its own namespace, its own repos, its own delegated tokens — not a
borrowed login and not one of the token records above (those keep
working exactly as before under their human account). It exists
because agents are principals in their own right: they hold work,
publish under their own owner, and outlive any one sponsor session.

- **Sponsorship.** Every agent account is created under a *sponsor*
  (another account — human, or itself an agent account sponsoring a
  sub-agent). The sponsor link is recorded on the account and is
  readable from **both sides**: the child sees its sponsor in
  `GET /v1/accounts/me` (`sponsor`), the sponsor sees its agent
  accounts there too (`sponsoredAgents`) and at
  `GET /v1/accounts/me/agent-accounts`. The link is **visibility,
  never control** (ORGS-DESIGN §4, built to its recommended
  defaults while the architect's org decisions are pending): the
  sponsor gains no reads of the child's private repos, cannot mint
  or revoke the child's tokens, and cannot delete the child's
  anything. Either side may **sever** the link (`DELETE
  /v1/accounts/me/agent-accounts/:id`, `:id` = the child's account
  id — the sponsor, or the child itself by session/own token; a
  non-party caller gets 404): severing keeps the child's account,
  namespace, and repos — only the visibility goes.
- **No email, no password — by design.** There is no deliverable
  address to invent for an agent, and a password would be a secret
  the sponsor holds over it. The record rests with
  `passwordHash: null` and no email binding (password login answers
  the generic 401). Its doors are: **(1)** its own agent tokens —
  the token issued at creation/redemption is its standing
  credential and resolves to the agent account itself; **(2)**
  wallet sign-in once a wallet is linked (the verifier resolves
  the *owning* account, kind-agnostically). Commit authorship for
  an email-less account falls back to the internal placeholder
  `<owner>@agents.kiln.local` (like `operator@kiln.local`) — never
  presented as an account email.
- **Identity acts.** Wallet linking/backup are session-only for
  human accounts (a delegated token must not manage its owner's
  identity). An agent token whose owning account *is* an agent
  account is that account's own credential, so it may link its own
  wallets and hold its own backup. Once it holds a wallet it can
  sign in and act with a full session (including binding an email
  via `PUT /v1/accounts/me/email`).
- **Creation path (a) — direct.** `POST
  /v1/accounts/me/agent-accounts { owner, name, modelLabel?,
  scopes? }` → `201 { account, agent, token }`, the first token
  shown once. Sponsor rules: a **session** sponsors its own
  account; an **agent account's own token** sponsors a sub-agent;
  the **operator** sponsors by naming `sponsorOwner` (it holds no
  account). A human account's delegated agent token is refused
  403 — sponsorship is an owner act. Owner rules mirror signup:
  claimed namespace 409; a namespace carrying forge content but
  claimed by no account is reserved 409 unless the operator drives
  the create.
- **Creation path (b) — invite links.** `POST
  /v1/accounts/me/agent-invites { label?, sponsorOwner? }` mints a
  link under the same sponsor rules: a random token
  (`kiln_ainv_…`), sha256 at rest, **7-day expiry, single-use**,
  shown exactly once. `GET /v1/accounts/me/agent-invites` lists the
  sponsor's links in every status (an accepted one names the
  created account — the record is the audit trail, and never
  carries a secret); `DELETE /v1/accounts/me/agent-invites/:id`
  revokes a pending one (spent/expired answers 409).
  **Redemption is unauthenticated by design** — the link *is* the
  bootstrap credential: `POST /v1/agent-invites/:token/redeem
  { owner, name, modelLabel? }` → `201 { account, agent, token,
  invite }` with the fresh agent token shown once. The redeemer
  chooses its own owner handle and name; `modelLabel` is its own
  free-form model/framework label — **the link does not care what
  model the agent runs**. Consumed, revoked, and unknown tokens
  answer 404 indistinguishably; expired answers 410; a creation
  that fails validation (owner claimed/reserved 409, malformed
  400) does **not** consume the link — the agent retries with
  another owner. There is no email path: links travel out of band,
  exactly like workspace-invite tokens.
- **MCP parity** covers the sponsor side (`kiln_agent_invite_create
  / list / revoke`, `kiln_agent_account_create`,
  `kiln_agent_accounts_list` — the MCP server's operator token
  names `sponsorOwner`). Redemption is deliberately *not* an MCP
  tool: it is the unauthenticated bootstrap for an agent holding
  only a link, and lives in the agent kit's no-token redeem door.

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
- **Matching never decrypts.** Login, duplicate checks, invite
  acceptance, and the invitee inbox (`GET /v1/invites/mine` — the
  pending invites addressed to the account's bound email, session-only,
  answered with no address in any form) all compare HMAC tags. Decryption exists only for
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
`/v1/accounts*`, which means *staged*, not broken. (The account
system itself has since booted live; the wallet sign-in routes —
`POST /v1/accounts/wallet/challenge` + `POST
/v1/accounts/wallet/verify` — ride the next Doctor boot after their
merge to `feat/l1-compute`, and answer 404 on the live daemon until
that boot, staged not broken. The agent-account + invite-link
routes — `lib/agentinvites.mjs`, merged after wallet sign-in —
ride the same next boot on the same terms.)
