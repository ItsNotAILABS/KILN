# KILN Swarm — headless agent runtime

A real runtime for spawning swarms of headless subagents: backend workers,
persistent nodes of software. Each node is a persistent identity that runs
as **an entire OS process**. Zero dependencies, plain Node `.mjs`.

## What it is

- **Node** — persistent software identity: an ed25519 keypair, a kiln node id
  (`hex(sha256(pubkey))` — a content id, **not** an Ethereum address), a state
  dir, and a capability grant mirroring `contracts/KilnOwnershipRegistry.sol`
  (`{capabilities, expiresAt, parent}`). The grant is enforced in-process
  **before every tool call**: `git.commit` needs `CAP_COMMIT` (1),
  `swarm.submit` needs `CAP_PROPOSE` (4), `swarm.spawn` needs `CAP_DELEGATE` (8).
  Spawning a child node is on-chain-style delegation: subset of the parent's
  caps, expiry capped at the parent's, parent recorded.
- **Worker** — one detached OS process per node (`lib/worker.mjs`), stdio to
  per-node log files, heartbeats via heartbeat-file mtime, restart policies
  (`never` / `on-failure` / `always`, max restarts).
- **Daemon** — the backend worker host (`lib/daemon.mjs`). Owns an append-only
  JSONL job queue (atomic appends + fsync, state by replay), assigns pending
  jobs to idle nodes or spawns nodes, reconciles on boot (dead pids marked,
  respawned per policy) so nodes survive daemon restarts. Workers are **not**
  killed when the daemon stops — they are persistent; a restarted daemon
  re-adopts live pids.
- **Minds** — pluggable. `script` executes a declarative plan of tool calls
  (`{steps:[{tool,args}]}`), fail-fast, genuinely useful for long tasks.
  `http` POSTs to a chat-completions endpoint from `KILN_MIND_URL`
  (OpenAI-compatible tool calls); with no URL it **refuses loudly** — there is
  no fake LLM anywhere in this codebase.
- **Receipts** — every executed tool call appends one canonical-JSON receipt
  signed with the node's ed25519 key (`node:crypto`), hash-chained, fsync'd.
  Verifiable offline with the node's public key: `receipts verify`.
- **Tools** — all real, all jailed to the node's work dir (a git clone):
  `fs.read/write/list`, `shell.exec` (no shell, argv only, denylist, timeout,
  cwd jail — escape attempts fail), `git.status/log/commit`,
  `swarm.spawn`, `swarm.submit`. Nothing is simulated; if something can't run,
  it fails loudly.

## Quickstart

```sh
cd swarm
export KILN_SWARM_DIR=~/.kiln-swarm   # default if unset
node swarm.mjs init
node swarm.mjs daemon start
node swarm.mjs node spawn --name worker-1 --caps 15 --ttl 86400 --repo /path/to/repo --mind script
node swarm.mjs node list
# submit a plan (see examples/report-job.json)
node swarm.mjs job submit --plan examples/report-job.json --name nightly-report
node swarm.mjs job list
node swarm.mjs receipts verify
node swarm.mjs daemon stop
```

## Use it as a feature

Anything built in the forge — a model service, a protocol daemon, an AI agent —
can drive the swarm programmatically. The daemon exposes a **local HTTP API**
and `lib/client.mjs` is a zero-dependency SDK for it.

```js
import { SwarmClient } from "./lib/client.mjs";

const swarm = await SwarmClient.connect(); // reads KILN_SWARM_DIR, daemon.json, api.token
const { id } = await swarm.submitJob({
  name: "nightly-report",
  plan: { steps: [
    { tool: "fs.write", args: { path: "REPORT.md", content: "# nightly\n" } },
    { tool: "shell.exec", args: { command: "git", args: ["log", "--oneline", "-3"] } },
    { tool: "git.commit", args: { message: "nightly report" } },
  ]},
});
const job = await swarm.waitForJob(id, { timeoutMs: 120000 }); // throws if the job fails
console.log(job.summary);
const nodes = await swarm.listNodes();
const check = await swarm.verifyReceipts(); // { results, allOk }
```

API surface: `POST /jobs`, `GET /jobs`, `GET /jobs/:id`, `POST /nodes`,
`GET /nodes`, `POST /nodes/:id/stop`, `GET /nodes/:id/logs`,
`POST /receipts/verify`, `GET /health`.

**Auth (honest, minimal):** the API binds `127.0.0.1` only — never a public
interface. Every route except `GET /health` requires
`Authorization: Bearer <token>` where the token lives at
`<stateDir>/api.token` (0600, generated at init). `SwarmClient.connect()`
reads it for you; `swarm.mjs daemon token` prints it for wiring other local
services. There is no user system and no remote access by design.

## Honesty notes

- Tool calls really execute: real file writes, real `git`, real subprocesses.
  The shell has no shell: `shell.exec` takes `{command, args[]}` with
  `shell: false`; shell binaries and metacharacters are rejected.
- The `http` mind needs a real endpoint (`KILN_MIND_URL`, optional
  `KILN_MIND_API_KEY`, `KILN_MIND_MODEL`). Unconfigured, it exits with an
  error instead of hallucinating a mind.
- Receipts are real ed25519 signatures over canonical JSON, hash-chained.
  `receipts verify` fails loudly on tampering, chain breaks, or wrong keys.
- Job submission via CLI/API is operator-level (like the contract owner);
  capability grants are enforced where work happens: inside the worker,
  before every tool call, and on delegation.
- `CAP_RELEASE` (2) is declared and reserved, matching the on-chain registry;
  no tool consumes it yet — the grant panel says so rather than implying it.

## Tests

```sh
node --test test/*.test.mjs
```

Covers: grant enforcement + delegation subset/expiry (mirrors the contract),
receipt sign/verify/tamper/chain-break, queue persistence across a simulated
restart, shell+fs jail escapes, real git commits, script-mind plans, the http
mind against a stub completions server (plus its loud refusal with no URL),
and a full worker-process end-to-end (real file, real commit, verified
receipts), plus the HTTP API + SDK against a real daemon.
