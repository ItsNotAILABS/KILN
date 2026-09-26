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
  `project.release` (runs a repo's release command — needs `CAP_RELEASE` (2),
  refused loudly without it, no side effects), `swarm.spawn`, `swarm.submit`.
  Nothing is simulated; if something can't run, it fails loudly.

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

### KILN Compute — serverless functions on the swarm

The swarm is also a supercomputer other repos call like serverless. Full
spec: `docs/KILN_COMPUTE.md`.

```js
import { ComputeClient } from "./lib/compute-client.mjs";
const kiln = await ComputeClient.connect();

// run a function, get the result back (code must export main(args))
const r = await kiln.invoke({
  code: `export async function main(args) { return args.x * 2; }`,
  args: { x: 21 }, waitMs: 60000,
});
console.log(r.result); // 42

// fan out across workers
const m = await kiln.map({
  code: `export async function main(n) { return n * n; }`,
  items: [1, 2, 3, 4],
});
const done = await kiln.waitMap(m.mapId);
console.log(done.results.map((x) => x.result)); // [1, 4, 9, 16]

// pop a repo as a persistent supervised service
const app = await kiln.deployApp({
  name: "my-api", repo: "http://127.0.0.1:18787/git/auro/my-api",
  command: "node", args: ["server.mjs"], port: 8901,
});
```

```sh
node swarm.mjs compute invoke --code "export async function main(a){ return a.x*2 }" --args '{"x":21}' --wait 60000
node swarm.mjs compute map --code "export async function main(n){ return n*n }" --items '[1,2,3,4]' --wait 120000
node swarm.mjs compute deploy --name my-api --repo <url> --command node --args '["server.mjs"]' --port 8901
```

### depositCode — agents contributing code

`depositCode({ repo, files, message })` is the first-class primitive for an
agent (Muse, a forge agent, an external agent via the API) to contribute code
into a KILN project. It spawns a fresh node with **only `CAP_COMMIT`**, which
really `git clone`s the repo, writes the files, and commits:

```js
const deposit = await swarm.depositCode({
  repo: "/path/to/project",          // or a git URL the worker can clone
  files: [
    { path: "src/hello.js", content: "export function hello() { return 1; }\n" },
  ],
  message: "deposit: hello module",
});
// deposit = { nodeId, nodeName, jobId, commitHash, summary, receipts }
// receipts.allOk === true, receipts.results has the node's signed receipts
```

Without `CAP_COMMIT` the worker's `git.commit` is refused *before* anything
runs — the job fails loudly and **no commit is created**. The commit hash
returned is parsed from the worker's real `git commit` output; it is never
invented.

API surface: `POST /jobs`, `GET /jobs`, `GET /jobs/:id`, `POST /nodes`,
`GET /nodes`, `POST /nodes/:id/stop`, `GET /nodes/:id/logs`,
`POST /receipts/verify`, `GET /health`.

**Auth (honest, minimal):** the API binds `127.0.0.1` only — never a public
interface. Every route except `GET /health` requires
`Authorization: Bearer <token>` where the token lives at
`<stateDir>/api.token` (0600, generated at init). `SwarmClient.connect()`
reads it for you; `swarm.mjs daemon token` prints it for wiring other local
services. There is no user system and no remote access by design.

## Nightly test workers

`nightly.mjs` runs the test suites of registered KILN projects on real worker
nodes — one node per project, each a fresh clone, `CAP_COMMIT`, script mind:

```sh
node nightly.mjs                 # all configured projects
node nightly.mjs --project kiln  # just one
```

It reads `../projects/registry.json` (canonical project list) and
`nightly.config.json` (per-project local checkout + test command). A project
runs only if it is **registered**, its local checkout exists, and its test
binary is on `PATH` — anything else is skipped loudly, never silently. If the
daemon is down it exits 1 and prints the exact `daemon start` fix command.

Adding a project: (1) register it in `projects/registry.json`, (2) make sure a
checkout exists on the machine, (3) add an entry to `nightly.config.json`:

```json
"my-project": {
  "local": "~/workspace/repos/my-project",
  "setup": [["npm", "ci", "--no-audit", "--no-fund"]],
  "test": { "command": "npm", "args": ["test"], "timeoutMs": 300000 }
}
```

Optional `"release": { "command": ..., "args": [...] }` declares the repo's
real release command for `CAP_RELEASE`-gated release workers. Leave it out
until the project has a real one — nightly never invents release processes.

To run a release for a project that has one configured:

```sh
node release.mjs --project my-project
```

It spawns a worker with `CAP_RELEASE` and nothing else, runs the configured
command through the `project.release` tool (same jail as `shell.exec`),
waits, verifies receipts, and reports. With no `release` command configured
it refuses loudly instead of guessing — neither bundled project has one yet.

## Long-task offload (http mind)

A job can run under the `http` mind instead of `script` — the worker hands the
job to a real model, which then drives the same grant-checked, receipted
tools. Mind selection is per job: `job.mind || node.mind || "script"`, so:

```sh
node swarm.mjs job submit --plan examples/long-task.json --name my-long-task --mind http
# or: await swarm.submitJob({ name, plan: {...}, mind: "http" })
```

`examples/long-task.json` is the template: `{task, deliverable, constraints}` —
the whole object becomes the model's task brief. It carries `"steps": []`
because the submission gate requires `plan.steps[]`; the http mind ignores
the steps and works from the brief. Setup:

```sh
KILN_MIND_URL=https://your-endpoint/v1/chat/completions \
KILN_MIND_MODEL=your-model \
KILN_MIND_API_KEY=... \
node swarm.mjs daemon start
```

Workers inherit the daemon's environment, so the URL must be set **before**
`daemon start`. Without a real `KILN_MIND_URL` the http mind **refuses
loudly** — the plumbing is real, the model is yours to plug in.

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
- `CAP_RELEASE` (2) is enforced by `project.release`: without it the call is
  refused before anything executes. The on-chain registry declares the same
  bit; the swarm consumes it for real release commands.

## Tests

```sh
node --test test/*.test.mjs
```

Covers: grant enforcement + delegation subset/expiry (mirrors the contract),
receipt sign/verify/tamper/chain-break, queue persistence across a simulated
restart, shell+fs jail escapes, real git commits, `project.release` gating on
`CAP_RELEASE` (runs for real / refused with no side effects), script-mind
plans, the http mind against a stub completions server (plus its loud refusal
with no URL, and the `examples/long-task.json` template shape end to end),
nightly plan building + the loud daemon-down failure, and a full
worker-process end-to-end (real file, real commit, verified receipts), plus
the HTTP API + SDK against a real daemon.

## KILN-native git hosting

The swarm daemon is also a git forge: real bare repositories under
`<stateDir>/git/<owner>/<repo>.git`, served over real Git smart HTTP via
`git http-backend`. No simulation — `git clone`, `fetch`, and `push` all work
against it with a normal git client.

```sh
node swarm.mjs repo create --owner auro --repo auro   # needs the daemon token
node swarm.mjs repo list                              # public
git clone http://127.0.0.1:18787/git/auro/auro       # public, no token
```

Rules:

- **Public:** `GET /git` (repo listing), clone, and fetch.
- **Authenticated:** repo creation and `push`. Auth is checked *before*
  `git-http-backend` ever runs — an unauthenticated push never reaches git.
  Clients authenticate with the daemon bearer token, either as
  `Authorization: Bearer <token>` (what `http.extraHeader` sends) or HTTP
  Basic with the token as the password (what `http://oauth2:<token>@host/...`
  URLs send — git retries the 401 challenge with it).
- Owner/repo names are lowercase alphanumeric plus hyphens; traversal and
  uppercase are rejected.
- Current boundary: the daemon listens on loopback only, so clone/push URLs
  are localhost URLs for now.

Tests (`test/git.test.mjs`, 11 tests): authenticated create (201), duplicate
(409), bad names (400), unauthenticated create refused (401), public listing,
a real clone → push → fresh-clone round trip, a 401 `WWW-Authenticate`
challenge assertion, a real push via `oauth2:<token>@` URL credentials, and a
real unauthenticated push that is refused and lands nothing.
