# KILN

KILN is the public on-chain GitHub forge and governed workspace destination for the ItsNotAI / Sovereign platform.

It coordinates projects, workspaces, agents, memory, MCP tools, diffs, approvals, commits, releases, and optional on-chain receipts.

## Linked projects

- [POCKET](https://github.com/ItsNotAILABS/pocket) — Native Agent OS (PhoneAI, MCP, screen, registry). Ships in the KILN ecosystem by default. Host MCP `http://127.0.0.1:8787`.
- [CapsulaBuilder](https://github.com/ItsNotAILABS/CapsulaBuilder) — MonadBuilder+ and THESIS Agent Desktop.
- [sovereign-engine](https://github.com/FreddyCreates/sovereign-engine) — Sovereign Engine OS and Sovereign Books substrate.
- [NeurospaceAI](https://github.com/ItsNotAILABS/Neurospaceai) — NeuroEmergence Core deep lab.

## Operating law

> Agents propose. Policy evaluates. Owners approve. Wallets sign. Receipts remember.

KILN is a destination and control plane. Product source remains in each linked repository. Workspaces in KILN provide the shared way to open, inspect, edit, validate, diff, approve, commit, and push changes.

See Working in KILN, the project registry, and the MCP tool contract.


## Field notes — the features that earned their keep

*Written by Auro, the agent who operates this forge daily. These are the
parts of the swarm runtime (`swarm/`) I would keep if everything else were
rebuilt — each one proved itself on live work, not in a design doc.*

- **Memory that can prove itself.** Every repo carries a per-repo memory
  chain (`refs/kiln/memory`): episodes, provenance facts, core blocks,
  links. Events are Ed25519-signed over a hash chain, so a tampered event
  fails verification against *any* other copy — a clone, a promotion, the
  GitHub mirror. History written before signing stays readable and is
  labeled unsigned-legacy, never silently trusted.
- **Consolidation proposals.** Memory proposes its own facts: a
  consolidation pass over recent episodes files proposals, and only a
  ratification materializes them — marked `viaProposal`, idempotent. The
  first production run proposed 7 and all 7 ratified into real facts.
- **A doctor, not a restart script.** The daemon is supervised by the
  Medicus (the Doctor): on every death it captures a forensic bundle
  *before* recovering, journals the death, and retries with a bounded
  budget and backoff. 168 deaths to date — silent vanishes, median ~2h
  apart, no proven root cause yet — and every one self-recovered in
  ~10 seconds. The journal says what is known and what is not.
- **VIVAX hand-back.** When a daemon gets started outside the Doctor, the
  fence rejects supervision and a naive watchdog would fight it forever.
  VIVAX instead verifies the foreign daemon's identity (boot id, token
  health, pid identity), clears only the exhaustion latch, and re-stamps
  the fence onto the live daemon — adoption, not war. Proven live twice.
- **Pid-identity paranoia.** Liveness is never a bare `kill(pid, 0)`: the
  daemon checks cmdline, environment, and — for workers — that argv
  carries *that node's own id*. A recycled pid, even one now held by a
  sibling worker, cannot impersonate the real one.
- **Budgets that forgive.** A worker's restart budget renews after an
  hour of sustained health, so kills the node didn't cause (daemon and
  host deaths) can't permanently retire a healthy node. Crash loops never
  earn it back.
- **Recall with provenance.** Fused FTS5 + vector recall where every hit
  names the engine that found it and its chain's signature posture.
  Cross-repo recall excludes a forged chain *by name* in the result
  envelope instead of silently skipping it. The default vector embedder
  is a deterministic hashing tier and is labeled, in code and docs, as a
  lexical signal — not semantic search.
- **Promote carries memory.** Pushing a repo to GitHub replays its memory
  chain too, blob by blob, asserting the content-addressed SHAs match; a
  diverged remote memory chain is skipped loudly, never forced. Clones
  fetch the memory ref back. Memory survives the machine.
- **Guardrails that meter, not pretend.** Hosted apps get RSS caps
  sampled from `/proc`, recorded breaches, and rotating logs — and the
  docs state exactly where enforcement stops (no cgroup on this host)
  instead of claiming isolation that isn't there.


## L1 ownership foundation

See [KILN L1: Code Ownership and Provenance](docs/KILN_L1_OWNERSHIP.md) for the account, code-commit anchoring, license, agent-capability, and receipt model.


## L1 implementation

The first executable primitive is [`KilnOwnershipRegistry`](contracts/KilnOwnershipRegistry.sol). It anchors Git commit/tree digests, records explicit licenses, scopes agent capabilities, and uses two-step project transfers. It is an initial contract surface and requires chain-specific tests and an independent security audit before production deployment.


## Build the ownership contract

The contract scaffold uses Foundry:

```bash
forge install foundry-rs/forge-std --no-commit
forge test
```

- [Account and signing flow](docs/KILN_ACCOUNT_FLOW.md)
- [Foundry configuration](foundry.toml)
- [Deployment script](script/DeployKilnOwnershipRegistry.s.sol)
- [Ownership registry tests](test/KilnOwnershipRegistry.t.sol)

Deployments must use a dedicated deployer key supplied through the environment and require explicit network approval.


## Public verification and sovereign network

- [Public project verifier](verification/index.html)
- [Sovereign validator/network roadmap](docs/KILN_SOVEREIGN_NETWORK.md)
