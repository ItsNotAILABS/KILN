# Lane B (daemon) — REAL OAuth (Google + X) — NOTES

Base: feat/l1-compute @ 8f5d995
Worktree: ~/workspace/.worktrees/kiln-lane-b-oauth (branch lane-b-oauth)

## Proxy verification (locked contract)
- kiln-workspace scripts/serve-original.mjs (~line 875-883): "Forge API
  proxy: /api/forge/X -> daemon http://127.0.0.1:18787/X" — the proxy
  strips the "/api/forge" prefix, so public
  /api/forge/v1/accounts/oauth/<provider>/callback lands on daemon
  /v1/accounts/oauth/<provider>/callback. Locked redirect URIs are
  correct as built (no STOP needed):
  - https://kiln.pocketnova.app/api/forge/v1/accounts/oauth/google/callback
  - https://kiln.pocketnova.app/api/forge/v1/accounts/oauth/x/callback

## Design
- lib/oauth.mjs: provider layer ONLY (endpoints, env config, PKCE,
  authorization URL, code exchange + identity fetch). Test seam:
  per-call overrides {clientId, clientSecret, redirectBase, authUrl,
  tokenUrl, userinfoUrl} + fetchImpl; endpoint overrides also via env
  KILN_OAUTH_<GOOGLE|X>_<AUTH|TOKEN|USERINFO>_URL.
- lib/accounts.mjs OAuth section: state machines + resolution.
  States/pending/handoffs stored HASHED (sha256) in accounts.json
  (oauthStates 10m / oauthPending 15m / oauthHandoffs 2m, all
  single-use); per-account oauthLinks [{provider, subject, linkedAt}].
  Sessions via the shared exported mintSession. Provider emails are
  only ever HMAC-matched / stored as encrypted bindings — never
  plaintext (pending records hold makeEmailBinding output only).
- Resolution order: (1) provider link; (2) Google + email_verified
  ONLY → HMAC match → link recorded; unverified never merges;
  (3) pending → POST complete picks handle (owner-taken 409 keeps
  pending alive; other attempts consume it). Matched sign-in hands
  the app a handoff code in the redirect fragment — never a session
  in a URL; POST handoff redeems it ({ok, account, sessionToken,
  expiresAt}, consumed on any attempt, unknown 404, expired 410).

## Slices
- [x] 1. config + state store + start/callback skeleton + not-configured honesty
      (smoke: not-configured → 503 {"error":"provider_not_configured",
      "provider":"google"}; configured start → 302 to Google with the
      exact locked redirect_uri + PKCE S256; unknown state → 400)
- [x] 2. Google full flow + tests — test/oauth.test.mjs (provider stub
      via env endpoint overrides): email-match → handoff → session on
      /me + link recorded; PKCE verifier↔challenge proven at the stub;
      subject-link second login; unverified email does NOT merge
      (pending, and completion does not bind it); pending → complete
      (+ verified email bound encrypted, masked only); owner-taken
      409 keeps pending alive; state replay 400; handoff replay 404;
      expired state 410; expired handoff 410; not-configured 503
      exact body; accounts.json holds no plaintext emails/secrets.
      6/6 pass.
- [x] 3. X flow + tests — X first login → pending (no email depended
      on), completion records the subject link with no email binding;
      second login rides the link → handoff → same account; token
      exchange proven to use Basic client auth + PKCE verifier;
      X not-configured → 503 for provider "x". Suite now 8/8.
- [x] 4. openapi/docs/capabilities + drift — OpenAPI operations for
      all four OAuth routes + oauthLinks on the Account schema;
      capabilities accounts endpoints + title updated; drift
      EXPECTED table updated (green); httpapi header map updated;
      ACCOUNTS.md gains the OAuth section (env names, byte-for-byte
      redirect URIs, resolution order, not-configured behavior, the
      provider-links storage, and the ONE remaining gate: the
      architect creates the Google Cloud + X developer apps and
      supplies the two credential pairs) and the doors table gains
      the OAuth row — the old "no OAuth doors exist" paragraph is
      replaced. Targeted: oauth 8 + drift 3 + accounts/wallets/
      wallet-signin — 16/16 pass.
- [x] 5. merge to feat/l1-compute + full suite (accounting below)

## Final accounting (2026-11-02)
- Slice commits on lane-b-oauth: 08b2bbb (1: provider layer +
  store + routes) · 203f45e (2: Google tests) · 307a1ca (3: X
  tests) · b6749c2 (4: openapi/docs/capabilities) · 1c3478e
  (pre-merge sync with feat/l1-compute @ 1654ba2).
- Targeted: oauth 8/8; oauth+drift+accounts+wallets+wallet-signin
  16/16.
- FULL SUITE on the merged tree (465 tests / 144 suites):
  - Run A (spec reporter, output to file): **465 pass, 0 fail**.
  - Run B (TAP reporter): 462 pass, 3 fail — the failing suites
    were ci-log retention, watchdog, and worker-adopt
    (pid-reuse), all heavy process/timing suites; runcmd also
    flickered in the same window. EVERY one of the four files
    passes standalone on this tree (runcmd 5/5, ci-log 5/5,
    watchdog 10/10, worker-adopt 5/5, the latter two twice) —
    the known host timing-flake family under parallel-lane load,
    zero overlap with this diff (accounts/oauth/httpapi/openapi).
  - A run before A died mid-suite on ENOSPC: the 512MB /tmp tmpfs
    was 100% full of accumulated kiln test dirs from parallel
    lanes; stale dirs (>30 min) were cleaned and A/B ran after.
- Activation: NOT live. The daemon was never restarted by this
  lane; the OAuth routes ride the next Doctor-owned boot, and
  answer 404 on the live daemon until then — staged, not broken.
  Even after that boot, both providers answer the honest 503
  provider_not_configured until the architect creates the Google
  Cloud + X developer apps and supplies the two credential pairs
  (KILN_OAUTH_GOOGLE_CLIENT_ID/SECRET, KILN_OAUTH_X_CLIENT_ID/
  SECRET) with the redirect URIs registered byte-for-byte:
  - https://kiln.pocketnova.app/api/forge/v1/accounts/oauth/google/callback
  - https://kiln.pocketnova.app/api/forge/v1/accounts/oauth/x/callback
