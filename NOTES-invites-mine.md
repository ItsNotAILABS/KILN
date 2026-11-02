# NOTES — invites-mine lane (Item 3, daemon half)

Goal: GET /v1/invites/mine — account-session-only endpoint listing the
PENDING invites addressed to the session account's bound email, matched
via the existing HMAC layer. No email field in the response, ever.

Base: feat/l1-compute @ 900cff8 (verified). Branch: invites-mine.
Coordinator merges after Item 1 — DO NOT merge this lane.

## Contract (from task)
{ invites: [ { id, workspaceId, workspaceSlug, workspaceName, role,
  status: "pending", createdAt, expiresAt } ] }
- session principal ONLY; agent tokens / operator → same not-an-account
  rejection as wallet-backup/email endpoints.
- no bound email → honest empty list (or codebase equivalent — record choice).
- isolation: never another account's invites.

## Sub-steps
- [x] step 0: worktree + this NOTES file committed (a61825c)
- [x] step 1: read existing invite/email code (swarm/lib) — patterns below
- [x] step 2: handler + route registration + capabilities surface
- [x] step 3: OpenAPI spec + drift test
- [x] step 4: suite tests (happy, isolation, no-bound-email, expired/consumed excluded, agent-token rejection)
- [x] step 5: docs (ACCOUNTS.md / WORKSPACES.md / MAIL.md as appropriate)
- [x] step 6: FULL suite on branch; flake evidence via standalone re-run if needed

## Findings (from step 1 reads)
- invite storage form: workspace-invites.json records carry
  { id, workspaceId, emailHmac, emailEnc, emailMasked, role, tokenHash,
  status: pending|accepted|revoked, createdBy, createdAt, expiresAt }.
  Pending-ness = status "pending" AND expiresAt > now (displayStatus()).
- HMAC matching layer: lib/emailcrypto.mjs — emailHmac(dir, email) over
  trim+lowercase; account records carry emailBinding.emailHmac (same tag).
  So /mine = compare invite.emailHmac === account.emailBinding.emailHmac.
  NO decryption needed at all. Legacy fallback: a pre-binding account may
  carry plaintext .email (session principals pass through withPlainEmail,
  which also sets .email to the decrypted address for bound accounts) —
  compute emailHmac(dir, account.email) when no binding tag is present.
- account with no bound email: no binding + no legacy email → honest
  EMPTY LIST { invites: [] } (chosen; the account simply has no address
  any invite could be addressed to).
- session principal / rejection pattern (invite accept, httpapi ~L850):
  anonymous → unauthorized(res) (401); operator → 403 "the operator token
  is not an account — …"; non-session (agent) → 403 "…sign in with the
  account (a session), not an agent token". Mirror this wording.
- workspace slug/name: getWorkspace(dir, id) from workspaces.mjs returns
  the recordView (slug + name present). Throws 404 if gone → then the
  invite ships with workspaceSlug/workspaceName = null (orphaned invite;
  accepting it would 404 too). Documented in the OpenAPI schema.
- capabilities: buildCapabilities() in lib/openapi.mjs — workspaces
  ability lists invite endpoints; add "GET /v1/invites/mine" there.
- OpenAPI + drift: paths in buildOpenApiDocument() (lib/openapi.mjs);
  test/openapi-drift.test.mjs EXPECTED table must gain
  ["GET", "/v1/invites/mine"] or the suite fails loudly. The mine path
  needs its own component schema (MyInvite) — WorkspaceInvite carries a
  masked `email`, which the /mine contract forbids in ANY form.
- route placement: httpapi.mjs — the /v1/invites/:token/accept block is
  followed by a catch-all 404 for /v1/invites*; the mine block must land
  BEFORE that catch-all. Header route doc comment sits ~L227-239.
- tests: node --test test/*.test.mjs (from swarm/). Harness pattern in
  test/email-invites.test.mjs (makeStateDir + startApiServer, real HTTP).

## Result
- step 6 done: FULL suite on branch = 439/439 pass, 0 fail (exit 0,
  ~6min). Base was 438 (papers lane count) + 1 new test = 439. No flakes.
- Targeted first: invites-mine + email-invites + openapi-drift = pass.
- MAIL.md untouched on purpose: no mail behavior changed.
- NOT merged, NOT pushed. Coordinator merges after Item 1.
- Code activates at the next Doctor boot (daemon never restarted here).
