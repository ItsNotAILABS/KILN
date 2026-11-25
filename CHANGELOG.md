# Changelog

All notable changes to KILN, newest first. Swarm rounds are tagged on
`main` when they close (see docs/PRODUCTION.md → Releases).

## 2026-11-25 — Virtual computers

- `swarm/lib/vcomputer*.mjs`: a persistent machine per agent. It has an
  Xvfb + xfwm4 desktop, Chrome with a persisted profile, and a control API:
  screenshot, input (pixels or 0..1), shell exec with timeouts, and
  background jobs. Owner **hand-off** pauses the agent (423), serves a
  one-time noVNC page with an instruction banner and a hand-back button,
  and resumes the agent. Hand-off tokens are stored hashed only, and typed
  text is never logged.
- Docker backend: one container per computer with CPU/memory/pids limits,
  `cap-drop ALL`, a home volume, and idle shutdown plus a disk soft quota
  from the daemon tick. The local backend runs the same scripts without
  isolation (opt-in, dev/test).
- `swarm/vcomputer/image/`: a reproducible `kiln-vc` image. The base is
  pinned by digest, apt by snapshot date, and every tool by sha256 (Node
  LTS, pnpm, bun, gh, Rust 1.79 via rustup, Solana 1.18.26 + Anchor
  0.30.1, Chrome for Testing).
- API `/v1/vcomputers/*` (OpenAPI + capabilities + drift pin), the
  `VComputerClient` SDK, the `swarm.mjs vc …` CLI, and
  `docs/KILN_VIRTUAL_COMPUTERS.md`.

## 2026-10-26 — Production process pack

- Added `docs/PRODUCTION.md` (the operating process: change loop, dual CI,
  releases, incident process, health targets, known gaps), `CONTRIBUTING.md`,
  `SECURITY.md`, a PR template, and CODEOWNERS.
- `kiln-swarm.yml`: least-privilege token (`contents: read`) and a
  concurrency group so superseded runs cancel instead of queueing.

## 2026-10-23 — Round 2: wedge kill + supervision hardening

- Root-caused the zombie-daemon wedge: a host write fault zeroed a node
  state file; pre-hardening boot reconcile threw before the tick timer and
  stall watchdog existed, leaving a daemon that answered the API but never
  ticked. Fixed with atomic tmp+rename state writes, corrupt-node DEGRADED
  quarantine, timers created before reconcile, and a never-ticked stall
  rule (`lastTickMs`, 600 s budget).
- `daemon.env`: persistent state-dir environment for the daemon child.
- `SUITE_RESULT` verdict layer completed for KILN-native CI.
- Suite: **345/345, twice**, on the shipped tree. GitHub `main` verified
  tree-identical to local except the permission-blocked workflow file.

## 2026-10-22 — Real-tech round

- Memory embedder is real: all-MiniLM-L6-v2 (384-dim) behind the memory
  API, hashing-v1 kept as fallback. Eval: paraphrase/unrelated gap 0.694
  vs 0.317 for hashing.
- CI full-log retention: `GET /git/:owner/:repo/ci/log/:sha` with
  `KILN_CI_LOG_MAX_BYTES` (10 MB default).
- README field notes: the features that earned their keep, written from
  the commit record.
