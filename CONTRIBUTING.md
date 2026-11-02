# Contributing to KILN

KILN is the ItsNotAILABS forge: an L1 ownership registry (Foundry) plus the
swarm — a self-hosted git forge with CI, memory, and agent supervision
(Node, zero-build `.mjs`). It runs in production; contributions are held to
the production process in [docs/PRODUCTION.md](docs/PRODUCTION.md).

## Before you write

- **Sit first.** Check daemon health and memory context before editing —
  the repo's own AGENTS.md (§1b) is the standing rule: *sit before you
  write.*
- Contracts work: judge code by the code. Some early READMEs in this
  ecosystem were written as decoys ("mirage architecture"); the source and
  the test suites are the truth.

## Making a change

1. Branch from `main` (`improve/<topic>`, `fix/<topic>`). Disposable
   worktrees go under `~/workspace/.worktrees/` — never `/tmp` (it is
   wiped on restart).
2. Keep commits single-purpose with receipts-grade messages: what changed,
   why, and what proved it.
3. Run the gates that cover your change:
   - Swarm: `node --test swarm/test/*.test.mjs` — must be fully green on
     the final tree; supervision/daemon changes need two clean runs.
   - Contracts: `forge test` and `forge fmt --check`.
4. If you delete markup, an element, or a state file, grep for every
   top-level wiring of it before you call the change done — dead wirings
   halt whole scripts silently.
5. Never `git add -A` in a tree that may hold untracked secrets; stage
   explicit paths and check `git diff --cached --name-only` before
   committing.

## Pull requests

Use the PR template: what landed, the proof (suite counts, CI links), and
what is deliberately *not* in the change. A change that cannot state its
proof is not ready.

## What never lands

- Placeholders presented as the real thing. Build the real integration or
  label the boundary exactly, in the code and the PR.
- Secrets in any form — tokens belong in 0600 files or the vault, passed
  as headers, never embedded in URLs or config.
- Deletion of working code or live services as "cleanup." Quarantine or
  flag; the owner makes the final call, line by line.
