# KILN in production — how this repo is run

KILN is production infrastructure, not a demo: a live forge (git smart-HTTP,
CI, memory) serving real work on this host, mirrored to
`github.com/ItsNotAILABS/KILN`. This document is the operating process a
dev team runs it by. If a practice here and a habit disagree, this file wins
until it is amended in a commit.

## The loop (every change, no exceptions)

1. **Sit before you write.** Read the current state — daemon health
   (`tick.json`), the memory sit-rep, the goal the work belongs to — before
   touching code. (AGENTS.md §1b.)
2. **Branch, never pile onto a dirty tree.** Work happens on a named branch
   or in a disposable worktree under `~/workspace/.worktrees/`. The main
   checkout is shared by parallel lanes; never run history-rewriting or
   reset-hard tooling in a tree holding someone else's uncommitted work.
3. **Prove it on the tree you ship.** The swarm suite
   (`node --test swarm/test/*.test.mjs`) must pass on the exact final tree.
   Daemon/supervision changes need **two consecutive clean runs** — one
   green run has hidden wedges before (2026-10-23).
4. **Reconcile before you push.** The GitHub push helper applies HEAD's diff
   onto the *current* remote tree. If the remote moved, diff both sides
   against the common base first; any file changed on both sides gets a
   real 3-way merge, never an overwrite. (Learned by losing L1 governance
   hardening once; repaired, not repeated.)
5. **Verify the remote tree, not the push output.** After pushing, compare
   trees (`git diff --stat local remote`): the only tolerated delta is a
   file on the known permission-blocked list below.
6. **Receipt in chat, standard shape.** 🔥 KILN receipt block for pushes;
   grouped one-line-per-repo list for views. Never raw git output, never a
   credential in a URL.

## CI — two systems, two jobs

- **KILN-native CI** (the daemon itself) runs on every push to a KILN-hosted
  repo and is the primary gate: it executes on the same class of iron the
  code ships to, retains full logs (`GET /git/:owner/:repo/ci/log/:sha`,
  `KILN_CI_LOG_MAX_BYTES`), and records a `SUITE_RESULT` verdict.
- **GitHub Actions** is the public mirror gate:
  - `kiln-l1.yml` — Foundry tests + fmt + Anvil deploy on contracts changes.
    **Live on GitHub today.**
  - `kiln-swarm.yml` — the 40-file swarm suite on `swarm/**` changes.
    **Written and green locally; NOT yet on GitHub** — the push token lacks
    the Workflows permission, so the file is permission-blocked (see
    "Known gaps"). Until it lands, GitHub shows no swarm CI signal and the
    KILN-native CI result is the swarm's only public-grade proof. Do not
    claim GitHub CI coverage for the swarm until the workflow file exists
    on the remote — check with `git ls-tree`, not memory.

## Releases

- Version the swarm by annotated tags on KILN main (`swarm-vX.Y.Z`) when a
  round closes: suite proof ×2, CHANGELOG entry, tag. Tags are the release;
  there is no separate artifact store.
- Project releases inside KILN go through `swarm/release.mjs`
  (CAP_RELEASE-gated, refuses projects without a configured release
  command — release commands are never invented).
- Nightly coverage: `swarm/nightly.mjs` runs registered projects' real test
  commands and skips anything unregistered or missing **loudly**.

## Incidents — the daemon death process

The swarm daemon is supervised, in order: the **Doctor** (owns boots,
~15 s poll, captures a forensic bundle in `~/.kiln-swarm/doctor/deaths/`
*before* restarting), **VIVAX** (adopts foreign boots rather than
restarting them), and a 5-minute watchdog cron as backstop/reporting
channel. House rules:

- Never hand-start the daemon. The Doctor owns boots.
- A recovered death is **journaled, not announced** (tracking entry on the
  service-drop watchdog goal + the Doctor's NEW DIAGNOSIS line when the
  journal supports a new pattern). A still-DOWN daemon or a fenced
  supervisor **is** announced immediately.
- Stall budget: a daemon that has never ticked, or whose `lastTickMs` is
  older than 600 s, is wedged by definition and self-aborts; the Doctor
  replaces it. Wedged-but-answering is the failure this rule exists for.
- Open reliability item: deaths continue at a ~2 h median interval with a
  silent-vanish signature (healthy tick seconds before, no OOM line, no
  fatal log) — leading hypothesis is external SIGKILL-class termination.
  Closing it needs a hosting-layer audit (host process management /
  runtime reaping), which is the architect's call, not the daemon's.

## Health targets (measured, not aspirational)

- Daemon recovery after a death: **< 60 s** (observed ~10 s typical).
- Wedge self-abort: **≤ ~10.5 min** from a never-ticked boot.
- Suite: **345/345**, twice, on the shipped tree, for supervision changes.
- GitHub tree parity with local main: **exact**, minus the
  permission-blocked list.

## Known gaps (the backlog, in priority order)

1. `kiln-swarm.yml` not on GitHub (Workflows permission) — no public CI
   signal for the swarm. Fix: laptop push or a Workflows:write token grant.
   Same block holds the one-line `kiln-governance.yml` fix in
   kiln-workspace.
2. Daemon death root cause unproven — hosting-layer audit pending the
   architect's word (see Incidents).
3. GitHub history is helper-generated (tree-faithful, history-parallel):
   pushes land via the Git Data API one commit at a time, so GitHub's
   commit graph differs from local history while trees match exactly.
   Anyone auditing history should diff trees, not count commits.
4. `kiln.medinatechlabs.net` public door: Cloudflare tunnel target is the
   KILN API on :18787; cloudflared cannot run inside this VM, so the tunnel
   must originate from the architect's laptop to the VM's Tailscale
   address.

## Secrets

- Tokens live in 0600 files (`~/.kiln-swarm/api.token`,
  `~/.kiln-swarm/github.token`) or the Secure Vault — never in chat, never
  in a URL, never in repo config. Git pushes to the KILN server pass the
  token as an `Authorization: Bearer` header only.
- A token pasted into chat is exposed by definition: revoke and replace it,
  from the laptop, before anything else proceeds.
