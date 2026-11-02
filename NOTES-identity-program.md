# Identity/accounts program — coordinator NOTES (3rd stand-up, 2026-11-02 ~01:56 CST)

## Inventory (verified first-hand this stand-up)
- Lane B daemon: DONE, merged feat/l1-compute (188d89c). Suite 454/454 on merged tree.
- Lane C daemon + sever: DONE, merged (c76d142, cfc5b80). Kit PR #3 merged (23ece48).
  Effective suite gate 456/456 (1 runcmd host flake, 5/5 standalone).
- App batch (B app + B-mobile both doors + C app /agents + invite landing):
  DONE on kiln-workspace branch account-unify-app @ 836e6a6
  (worktree .worktrees/kiln-account-unify). Gates green except:
  ephemeral-origin browser click-through PARTIAL (sandbox wall, disclosed in
  NOTES-account-unify-app.md) and the Worker deploy step itself.
- ACTIVATION: all daemon identity routes STAGED — live daemon booted
  2026-11-01 23:56 CST from 900d95c; B/C routes 404/401 live until the
  NEXT Doctor boot. Not broken. Never restart the daemon by hand.

## In flight (spawned 2026-11-02 ~01:57 CST)
- Landing child cb5f33f3: DONE. App batch landed on improve/ws-system-ui
  (cherry-picks 2100887…88cc4c8, byte-identical to 836e6a6; receipt
  4c89b9a + re-verify addendum 21a896c) and DEPLOYED as Worker v47
  (version 193059ea, deployment 622a5f8e @100%, 2026-11-02T07:56:55Z).
  Bindings verified (ASSETS, KILN_SWARM_TOKEN secret, ORIGINAL_API_URL);
  served-bytes sha256 ALL_MATCH 8/8. Live-origin render gate blocked by
  sandbox proxy (ERR_TUNNEL) — pre-merge staged-origin render proof over
  byte-identical assets stands, disclosed.
- Lane D child 286f9ace: DONE. Branch lane-d-discovery @ 81b7fbb:
  public /.well-known/agent.json + mcp.json manifests + honest JSON /api
  index at the edge (3980df8). Evidence: public GET /api/mcp 200 (28
  tools), POST initialize 200 (kiln 2026.9, protocol 2024-11-05);
  well-knowns 404 pre-landing (the defect). Daemon-side flags recorded
  in NOTES-lane-d-discovery.md (MCP proxy status field; redeem routes
  activate at next Doctor boot).

## Lane D landing: DONE (2026-11-02 ~02:16 CST)
- Landed on improve/ws-system-ui @ 60c0656 (cherry-picks 2d656bd,
  7c87b2d, 47fa2c8, dad5e4c, 5971db4; NOTES-account-unify-app.md
  preserved). Worker harness 13/13 on the landed tree.
- DEPLOYED as Worker v48 (d2a6079c; deployment eb352e2d @100%,
  08:14:20Z). Bindings verified incl. KILN_SWARM_TOKEN secret.
  Exactly 2 new asset-store files = the two .well-known manifests
  (upload manifest 209 total; the "194" in docs was stale).
- Public re-probe ALL 200: /.well-known/agent.json (names MCP door,
  redeem door POST /v1/agent-invites/:token/redeem, /v1/capabilities,
  /v1/openapi.json), /.well-known/mcp.json, /api + /api/ JSON index,
  GET /api/mcp 28 tools, POST initialize 200. SPA shell unchanged.
- Gemini acceptance test, discovery half: PASSES live now. Account
  half (invite redeem) still waits on the next Doctor boot.

## Parity phase: BUILT (2026-11-02 ~02:26 CST), landing in flight
- Child 6631b61f DONE: branch parity-g1-g18-g8 @ worktree kiln-parity —
  b6a78f0 notes · b401c52 G1 · 5ba961f G18+G8. G1: kiln-workspaces.js +
  kiln-parity-core.js, /workspaces via /$owner shadow, Create-sheet door.
  G18: kiln-repo-meta.js — visibility shown plainly on EVERY repo page +
  owner-only Settings (description/topics/visibility flip w/ confirm).
  G8: CI chip from details.ci ("No CI configured" honest state).
- Recon that matters: workspaces + repo-details daemon routes are LIVE
  on the running daemon (probed read-only) — parity needs NO Doctor boot.
- Gates: ephemeral-daemon proof 31/31, staged-origin renders 0 pageerrors
  (desktop + 375px), settings click-through proven, load-sim RAN CLEAN.
- Landing child f9625004 DONE: LIVE as Worker v49 (05deb345;
  deployment 549acb94 @100%, API-confirmed 2026-11-02T08:31:52Z).
  Landing commits 7231561/47d324c/ce896b2 + receipts to 0324586 on
  improve/ws-system-ui; zero conflicts; bindings verified pre-rollout;
  served-bytes sha256 MATCH 6/6. G1/G18/G8 are live against the
  already-live daemon routes — no boot needed. Parity phase CLOSED.

## RE-SCOPE (architect, 2026-11-02 02:19 CST): REAL OAUTH, not covered buttons
"Why did you make google and x worse instead of actually do the work" —
the honest-cover interim is rejected as the end state. Lane B now builds
the complete Google (then X) OAuth 2.0 flow: start redirect (state +
PKCE), callback at the real origin, code exchange, identity resolution
into the ONE account model (verified-email HMAC match → link+session;
subject link; no match → pending + handle pick), session via shared
mintSession + one-time handoff code (never a session in a URL).
Config = daemon env KILN_OAUTH_{GOOGLE,X}_CLIENT_{ID,SECRET} (+ optional
KILN_OAUTH_REDIRECT_BASE). Not-configured → 503 provider_not_configured,
server-driven honest app state; the on-load "Sign-in failed" banner dies
as app slice 1. ONLY remaining gate: the architect creates the Google
Cloud + X developer apps and supplies the credential pairs.
Redirect URIs (byte-for-byte for his consoles):
- https://kiln.pocketnova.app/api/forge/v1/accounts/oauth/google/callback
- https://kiln.pocketnova.app/api/forge/v1/accounts/oauth/x/callback
Children spawned 02:20 CST: daemon c68e344d (branch lane-b-oauth),
app f1b10e2e (branch lane-b-oauth-app).
- OAuth DAEMON DONE (c68e344d): merged feat/l1-compute @ b0e8ece
  (slices 08b2bbb/203f45e/307a1ca/b6749c2). Proxy mapping verified
  (/api/forge/X → daemon /X) so the locked callback URIs land exactly.
  Full suite 465/465 on merged tree; oauth 8/8 (email-match→handoff,
  PKCE proof, unverified-no-merge, replay/expiry, both 503s); the 4
  flickered suites all pass standalone (known host flake family).
  ACCOUNTS.md carries env names + redirect URIs + the one gate.
  STAGED for next Doctor boot (404 live until then).
- OAuth APP DONE (f1b10e2e): branch lane-b-oauth-app, 7 commits.
  Slice 1 root cause PROVEN: "Sign-in failed" is the fallback literal of
  the grok-auth wrapper in client-DRhaju3Z.js; the pre-v47 login chunk
  called it against the stubbed lab stack, which always errors → the
  catch wrote the literal into the banner. New wiring never uses that
  banner for provider state. Built: oauthPreflight/oauthStartUrl/
  oauthHandoff/oauthComplete + fragment handling at boot (handoff →
  session in kiln.daemon.session.v1; pending → handle-pick, survives
  reload; fragment always scrubbed); buttons preflight → navigate only
  when configured, else the muted not-switched-on state; /account shows
  Google/X link rows from account.oauthLinks (extra-provider linking
  while signed in: no door in the contract — flagged, not invented).
  Contract verified line-by-line vs the daemon branch — zero drift.
  Ephemeral proof vs real daemon code 7/7; stub harness 6/6.
  Disclosed shortfall: handle-pick submit click-through + 375px renders
  not captured in-browser (Chromium wedged under load 17–58);
  .scratch/flow.mjs committed as the one-command re-run.
- OAuth app landing: DONE via finisher f0b130c7 (two predecessors died
  in restarts; coordinator ran diff-sanity + node --check + load-sim
  directly). LIVE as Worker v52 (0def9d21; deployment edf3a8ad @100%,
  API-confirmed 2026-11-02T09:35:40Z; v51 was the typing round).
  improve/ws-system-ui tip ff8a1eb (receipt). Bindings verified;
  served-bytes MATCH 3/3.
- FINDING (pre-boot click behavior): the staged OAuth start door
  answers 401 operator-gate (not 404) through the proxy, and the OAuth
  paths didn't treat it as not-yet-active (wallet doors do, via
  isNotYetActive): chunk navigated to the raw 401 JSON; panel rendered
  the raw daemon string. Post-boot the 503 path works as designed.
  FIX child 0a3c75c4 dispatched same-pass: oauthPreflight + chunk map
  404 + operator-gate 401 → {configured:false}; handoff staleness
  checked for the same class; lands as its own Worker version.
- Preflight fix: DONE + LIVE. Child died in a restart; its complete
  edits survived uncommitted. Coordinator reviewed + gated directly
  (node --check 3/3, load-sim RAN CLEAN, preflight harness 8/8 incl.
  negative cases), committed 27d3762, fast-forwarded. Finisher
  e9765355 deployed Worker v53 (1f0c8909; deployment d9ef04ca @100%,
  API-confirmed 09:50:09Z; bindings verified; served-bytes MATCH 3/3;
  receipt de76556). Live probe: endpoint still staged-401 pre-boot,
  buttons now map it to the honest state. BUILD SIDE OF THE PROGRAM
  IS COMPLETE: app v47 identity · v48 discovery · v49 parity ·
  v52 OAuth · v53 preflight fix; daemon stack merged on
  feat/l1-compute (tip 64c1982) awaiting the next Doctor boot.
- Push round 3 child fd07ea51 dispatched (inventory-first: predecessor
  push worktrees exist under .worktrees/push-round3/; house push
  discipline + tree-verified receipts).

## Queued after parity lands
1. Push round 3 LAST (reconcile vs moved remotes, disposable worktree,
   one commit at a time, tree-verify; workflows held, no Workflows:write).

## Acceptance test (architect's)
External agent (Gemini) holding ONLY an invite link ends with a working
agent account + credential, discoverable from public manifests. Pieces:
Lane C redeem (daemon, staged) + Lane D manifests (in flight) + app
/agents surface (in landing). Full live pass also needs the next
Doctor boot to activate the staged daemon routes.
