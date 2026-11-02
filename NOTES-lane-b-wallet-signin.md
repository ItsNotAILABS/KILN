# Lane B (daemon) — wallet sign-in + login unification — NOTES

Base: feat/l1-compute @ 900d95c (~/workspace/repos/KILN)
Worktree: ~/workspace/.worktrees/kiln-lane-b-wallet (swarm/ copy — see host fault note)

## Host fault (2026-11-01 ~23:50 CST, observed at lane start)
- exec-side writes opened O_RDWR fail EPERM globally (python/node/git).
  git lockfiles use O_RDWR, so `git branch/worktree/commit` via exec fail
  with "couldn't write ...lock" even though O_WRONLY writes (shell
  redirection, node writeFileSync, muse.write) succeed intermittently.
- Workaround in use: working copy of swarm/ made via tar (O_WRONLY);
  all edits via muse.write/muse.edit (file-tool channel, reliable).
  Git commits/merge will be attempted via exec at each step; if the
  fault persists, commits are BLOCKED-BY-HOST and this file + the
  working tree are the checkpoint. Retried periodically.

## Design (locked before code)
- Routes (PUBLIC bootstrap, like login — no bearer required):
  - POST /v1/accounts/wallet/challenge {address, publicKey?}
    -> 201 {ok, challengeId, message, expiresAt}
  - POST /v1/accounts/wallet/verify {challengeId, address, signature, publicKey?}
    -> 200 {ok, account, sessionToken, expiresAt, wallet:{address,kind,publicKey,createdAt,hasBackup}}
- Message (exact string the wallet signs, UTF-8):
    kiln-wallet-signin
    address:<normalized address>
    nonce:<48 hex chars>
    expires:<iso>
  Same field discipline as kiln-wallet-link, own purpose tag, NO
  account line (the owning account is never revealed before proof).
- Semantics mirror linking exactly:
  - challenge TTL 5 min, single-use; one live challenge per address
    (re-issue replaces).
  - ANY verify attempt consumes the challenge.
  - replay/unknown -> 404; expired -> 410; bad signature -> 403;
    address mismatch vs challenge -> 400; malformed key/sig -> 400.
  - base58 address IS its key: presented publicKey (if any) must
    equal it (400 otherwise); if omitted, key is derived from address.
  - 0x address: publicKey may be presented (link discipline) or
    omitted, in which case the LINKED wallet's stored key is used.
    After signature verifies, a presented key that differs from the
    linked wallet's stored key -> 403.
  - Proof first, link state last: only AFTER the signature verifies
    does the server look up the link. Unlinked (or key-mismatched
    linked) cases never mint a session.
  - Unlinked -> status 403, body:
      { error: "wallet_not_linked: this wallet address is not linked to any account — link it from a signed-in session first, then sign in with it",
        reason: "wallet_not_linked", code: "wallet_not_linked" }
    EXACT reason string: wallet_not_linked
  - Cross-account: verify IGNORES any account/owner/accountId fields
    in the request body. The session is always for the account the
    wallet is LINKED to.
  - Success mints a normal kiln_sess_ session (30 days, same store +
    hashing as password login) for the owning account.
- Storage: accounts.json gains walletSignInChallenges {} (separate
  from walletChallenges so a link challenge can never be replayed as
  a sign-in challenge and vice versa — purpose separation by store,
  not just by message tag).
- Capabilities: wallet sign-in belongs in the existing "accounts"
  ability (endpoints list + title), following the existing pattern —
  it is an account door, not a new ability family. No MCP tools
  (accounts ability has none; sign-in is a human/app flow).
- AccountsError gains optional .reason/.code; httpapi surfaces them
  when present (all other errors keep the exact {error} shape).

## Steps
- [x] 1. lib/accounts.mjs: sign-in challenge + verify + session mint refactor
      (AccountsError.reason/code, walletSignInChallenges store, mintSession
      shared by password login + wallet sign-in, issueWalletSignInChallenge,
      verifyWalletSignIn; git commit attempt deferred — O_RDWR fault above)
- [x] 2. lib/httpapi.mjs: public routes + header doc (syntax ok)
- [x] 3. test/wallet-signin.test.mjs — PASS 2/2 first run (HTTP suite +
      lib expired-challenge suite; covers phantom success + /me,
      local presented-key + omitted-key success, unlinked reason,
      replay 404, bad-sig burn, cross-account claim ignored,
      link-challenge purpose separation, ghost challenge 404)
- [x] 4. lib/openapi.mjs + test/openapi-drift.test.mjs + capabilities
      (accounts ability endpoints + title; drift PASS 3/3)
- [x] 5. swarm/docs/ACCOUNTS.md: unified login map (doors table,
      session restore via /me, wallet_not_linked contract, OAuth
      provider-credential gate stated plainly, full route map)
- [x] 6. Targeted tests, then full suite on final tree, flake accounting
- [x] 7. Merge to feat/l1-compute (or blocked-by-host report)

## Final accounting (2026-11-02)
- Host fault cleared mid-lane; a proper git worktree
  (~/workspace/.worktrees/kiln-lane-b, branch lane-b-wallet-signin)
  replaced the plain copy; the verified files were copied in and
  committed per item:
  d495b7c accounts core · 6fe9046 httpapi routes · 425e75b tests ·
  438f99a openapi/drift · 5ddb334 ACCOUNTS.md docs
  (+ this NOTES file in d495b7c; final accounting follows as a
  notes-only commit on feat/l1-compute).
- Merge: 188d89c "merge: Lane B daemon — wallet sign-in + unified
  login model" onto feat/l1-compute (was 900d95c).
- Targeted (branch worktree): wallet-signin 2 + wallets 2 +
  accounts 1 + openapi-drift 3 = 8/8 pass.
- FULL SUITE on the MERGED tree (~/workspace/repos/KILN/swarm,
  node --test test/*.test.mjs): 454 tests / 139 suites,
  454 pass, 0 fail, exit 0.
- Flake accounting: the first full run was on the plain swarm-only
  copy and showed 453/454 — the one failure was nightly.test.mjs
  expecting ../projects/registry.json, a file outside the copied
  subtree (zero overlap with this diff). Re-runs: nightly 7/7 on
  the original tree AND 7/7 on the copy after adding projects/;
  the merged-tree full run above is fully green, nightly included.
  No other flakes observed.
- Activation: NOT live yet. The daemon booted 2026-11-01 23:56 CST
  from 900d95c (papers/invites boot) — this lane merged AFTER that
  boot, so POST /v1/accounts/wallet/* answers 404 on the live
  daemon until the NEXT Doctor-owned boot. Staged, not broken.
  No daemon restart was performed by this lane.
