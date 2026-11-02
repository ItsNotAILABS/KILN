# Lane C — agent accounts + agent invite links (daemon + kit)

Architect's order (2026-11-01): "I should be sending the links to my
agents — any of them, any type of the models — and they should be able
to use the app." Daemon-source work merges to `feat/l1-compute` and
activates at the next Doctor boot. NEVER restart the daemon.

Base: `feat/l1-compute` @ `3a3cafa` (Lane B wallet sign-in merged).
Worktree: `~/workspace/.worktrees/kiln-lane-c`, branch
`lane-c-agent-accounts`. Kit: `auro/kiln-agent-kit`, forge main
`38d6018`, ships via forge PR flow.

## Design decisions (from code reads, 2026-11-02)

- Existing model: accounts in `swarm/lib/accounts.mjs`
  (accounts.json; scrypt passwords; kiln_sess_ sessions; kiln_agt_
  agent identities bound to an account, resolved by
  `resolveAccountToken`). Workspace invites in `swarm/lib/invites.mjs`
  are the discipline template: random token, sha256 at rest, 7-day
  TTL, single-use, consumed/revoked/unknown → 404 indistinguishable,
  expired → 410, DELETE revokes.
- ORGS-DESIGN §4 recommended defaults (the architect's 4 org
  decisions are still pending — building to these, NOT building the
  orgs system): account gains `kind: "human" | "agent"` (default
  human); sponsor link is **visibility, never control**; severing
  keeps the child's namespace. Deviation, deliberate: the link lives
  ON the child account record (`sponsorAccountId`/`sponsorOwner`)
  rather than a separate links.json — one store, atomic with
  creation, `accountPublic()` can carry it without a store read.
  Semantics identical to the design's link record.
- Agent accounts have **no email and no password**: separate creation
  path (`createAgentAccount`), `emailBinding: null`,
  `passwordHash: null` (password login answers the generic 401 —
  verifyPassword fails clean on a null hash). No fake deliverable
  email is invented. Their doors: (1) agent tokens minted for the
  account (kiln_agt_ — the token issued at creation/redemption IS
  the account's standing credential, resolving to the agent account
  as its own principal); (2) wallet sign-in once a wallet is linked
  (Lane B verify resolves the OWNING account — kind-agnostic, so it
  falls out of the account model; proven in tests).
- Identity-act rule extension: wallet linking/backup are
  session-only today because a delegated agent token must not manage
  its HUMAN owner's identity. An agent token whose OWNING account is
  kind "agent" IS that account's own credential (there is no human
  session behind it), so it may link wallets / hold the backup for
  ITSELF. A human account's agent token stays refused, unchanged.
- Forge commit authorship: `actorOf` used `account.email` directly;
  an agent account has none → fallback authorship identity
  `<owner>@agents.kiln.local` (internal placeholder like
  operator@kiln.local; never an account email — accountPublic email
  stays null).
- Direct creation (path a): `POST /v1/accounts/me/agent-accounts`
  (session; or operator naming `sponsorOwner`) creates the agent
  account + mints its first agent token (returned once) under the
  sponsor. Existing `POST /v1/accounts/me/agents` (delegated tokens
  under one's OWN account) is untouched — unregressed by test.
- Agent invites: new `swarm/lib/agentinvites.mjs` +
  `agent-invites.json` store mirroring invites.mjs discipline.
  Token prefix `kiln_ainv_`. Mint: session (or agent-account self
  token sponsoring a sub-agent, per ORGS §4b; or operator naming
  `sponsorOwner`). Redemption is UNAUTHENTICATED (the link is the
  bootstrap credential), handled beside the wallet sign-in bootstrap
  routes before the principal gate. Redemption does NOT consume the
  invite when account creation fails validation (409 owner taken /
  400 bad owner) — the redeemer may retry with another owner; it IS
  consumed on success. Namespace-content reservation mirrors public
  signup (route checks repos/workspaces before redeem).
- Audit without secrets: the invite record itself is the trail
  (createdBy sponsor owner, redeemedBy owner + redeemedAccountId +
  timestamps); no token/hash ever leaves in a response or log.
- MCP: sponsor-side tools declared + served
  (kiln_agent_invite_create/list/revoke, kiln_agent_account_create,
  kiln_agent_accounts_list — they ride the operator token the MCP
  server already holds, naming sponsorOwner). Redemption is NOT an
  MCP tool: the MCP server is configured with the operator token;
  redemption is an unauthenticated bootstrap for an agent holding
  ONLY a link — it belongs to the kit's no-token static door.
  Declaring it in MCP would misrepresent who redeems.
- No email sends. Invites travel out-of-band (the link), exactly
  like workspace invites' token delivery; mailer untouched.

## Route shapes (app lane consumes verbatim)

All bodies JSON; errors `{error}`; success envelopes carry `ok: true`.

- `POST /v1/accounts/me/agent-accounts` — sponsor: session (self) |
  agent-account self token | operator + `sponsorOwner` in body.
  Body `{owner, name, modelLabel?, scopes?, sponsorOwner?}` →
  `201 {ok, account, agent, token}` (token once). Errors: 400
  validation / operator missing sponsorOwner; 403 human delegated
  token; 404 unknown sponsorOwner; 409 owner claimed/reserved.
- `GET /v1/accounts/me/agent-accounts` (`?sponsorOwner=` operator) →
  `200 {accounts:[Account]}` (sponsored agent accounts).
- `POST /v1/accounts/me/agent-invites` — same sponsor rules.
  Body `{label?, sponsorOwner?}` → `201 {ok, invite, token,
  tokenShownOnce: true, delivery}` (token once; prefix kiln_ainv_).
- `GET /v1/accounts/me/agent-invites` (`?sponsorOwner=` operator) →
  `200 {invites:[AgentInvite]}` every status; accepted carries
  redeemedBy/redeemedAt/redeemedAccountId.
- `DELETE /v1/accounts/me/agent-invites/:id` (`?sponsorOwner=`
  operator) → `200 {ok, invite}`; 404 not yours; 409 not pending.
- `POST /v1/agent-invites/:token/redeem` — PUBLIC (no bearer).
  Body `{owner, name, modelLabel?}` → `201 {ok, account, agent,
  token, tokenShownOnce: true, invite}`. Errors: 400 validation
  (link NOT consumed), 404 consumed/revoked/unknown, 409 owner
  claimed/reserved (NOT consumed), 410 expired.
- `GET /v1/accounts/me` now also returns `sponsor` (Account|null)
  and `sponsoredAgents` ([Account]); `account` gains `kind`,
  `sponsor: {accountId, owner}|null`, `modelLabel`.
- AgentInvite shape: `{id (ainv_…), sponsorOwner, label, status:
  pending|accepted|revoked|expired, createdBy, createdAt,
  expiresAt, redeemedBy?, redeemedAt?, redeemedAccountId?}`.
- Wallet identity acts (challenge/link/unlink/backup) additionally
  accept an agent token whose owning account is kind "agent"
  (its own identity); human delegated tokens still 403.

## Steps

- [x] 0. Worktree + NOTES checkpoint
- [x] 1. accounts.mjs: kind + sponsor + createAgentAccount + lists
- [x] 2. agentinvites.mjs: mint/list/revoke/redeem
- [x] 3. httpapi: routes + bootstrap redeem + /me sponsor surface +
       self-agent identity acts + actorOf fallback (forge.mjs)
- [x] 4. openapi + capabilities + drift EXPECTED (drift test: routes/docs pass; MCP half red until step 5, expected) + capabilities + drift EXPECTED
- [x] 5. MCP sponsor tools (43 → 48; drift pin green) sponsor tools
- [x] 6. Tests (agent-accounts 2/2; neighbors accounts+wallet-signin+invites 13/13, forge+workspaces+wallets 29/29): swarm/test/agent-accounts.test.mjs + drift/mcp/accounts suites
- [x] 7. ACCOUNTS.md docs docs
- [x] 8. Merge to feat/l1-compute @ `c76d142` + full suite gate (below)
- [x] 9. Kit: SDK + CLI + d.ts + smoke — found pre-landed in ~/workspace/.worktrees/kit-lane-c (3 commits off 38d6018, matching contract exactly), verified + shipped as forge PR #3, merged main `23ece48`
- [x] 10. Round trips via ephemeral instance of merged code (kit agents-smoke OK; MCP 48 tools + live invite create/list; raw REST shapes) + live-daemon staged check (404 mint / 401 redeem — rides next Doctor boot)

## Flakes / host notes

- Full suite on merged tree (feat/l1-compute @ c76d142):
  **456 tests, 455 pass, 1 fail** — the failure is
  test/runcmd.test.mjs "a SIGTERM-ignoring process is SIGKILLed
  after the grace period" (timing assertion, 1000ms budget) with
  ZERO overlap vs this lane's diff; standalone re-run 5/5 green.
  Host flake under full-suite saturation (323s run, 2-core host).
  Effective gate: **456/456**.
- Activation: daemon last booted 2026-11-01 23:56 CST from
  900d95c. Lane C (and Lane B) routes are STAGED — live answers
  404 (operator mint) / 401 (unauthenticated redeem) until the
  next Doctor boot. The swarm daemon was never restarted by
  this lane; all live proof ran on an ephemeral instance.

## Addendum (sever slice, landed after the accounting above)

- `DELETE /v1/accounts/me/agent-accounts/:id` (commit `b173a7e`,
  merged `cfc5b80`): either side severs the sponsor link — sponsor
  (operator via ?sponsorOwner=) or the child itself (session / own
  token); non-party → 404. Child keeps account/namespace/repos.
  No-control matrix pinned in test/agent-accounts-sever.test.mjs
  (sponsor cannot revoke child tokens 404, cannot delete child
  repos 403, sponsor-minted agents land under the sponsor).
  Targeted gate on merged tree: 21/21 (sever + agent-accounts +
  drift + mcp + accounts + wallet-signin + wallets). Kit sever verb
  shipped inside PR #3 (3f2402e); CLI sever proven against an
  ephemeral instance of the merged code.
- Concurrency note: two Lane C instances ran in this worktree
  simultaneously (host-restart successor overlap). Slices
  interleaved without loss — every commit above is the union.
