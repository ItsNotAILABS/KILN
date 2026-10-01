# KILN Compute — the swarm as serverless

KILN is a supercomputer you call like serverless. Three primitives, all over
the local HTTP API (Bearer `<api.token>`, 127.0.0.1 only), all executed for
real by swarm workers with signed receipts. The runtime underneath — the
sandbox, the scheduler math, metering — is documented in
`docs/KILN_COMPUTE_RUNTIME.md`.

## 1. `invoke` — run a function, get the result

`POST /v1/compute/invoke`

```json
{
  "code": "export async function main(args) { return args.x * 2; }",
  "args": { "x": 21 },
  "timeoutMs": 30000,
  "memoryMB": 256,
  "network": false,
  "retries": 0,
  "name": "double-it",
  "waitMs": 60000
}
```

`code` is a JS module that **must export `main(args)`**. It runs inside the
KILN Linux sandbox on a worker: fresh mount/pid/uts/ipc namespaces, `/home`
and `/root` hidden, minimal environment (no host secrets), network denied
unless `network:true`, JS heap capped at `memoryMB` (64..2048, default 256),
wall-clock timeout with SIGTERM-then-SIGKILL teeth. `console.log` is
captured, and the return value is JSON-serialized back. Without `waitMs` you
get `201 {invocationId, jobId, status:"pending"}`; with `waitMs`
(1000..300000) the call blocks until done and returns the full result:

```json
{ "invocationId": "inv_…", "status": "done", "ok": true,
  "result": 42, "logs": ["…"], "durationMs": 2311,
  "metrics": { "wallMs": 65, "cpuMs": 41, "peakRssBytes": 47185920,
               "timedOut": false, "rssKilled": false, "forkBomb": false },
  "billing": { "billedMs": 65, "memoryMB": 256, "gbSeconds": 0.01625 } }
```

Billing is metered in GB-seconds (`s × GB`), the serverless unit — no prices
attached, KILN meters usage and policy prices it.

Failures are honest: `ok:false` with the function's real error (or the
sandbox's policy error — timeout, memory, fork-bomb), or `status:"failed"`
with the job error. `retries` (0–2) retries **sandbox-infra failures only**,
never function errors. `GET /v1/compute/invocations/:id` polls any invocation
later (pure read — scheduler accounting settles in the daemon tick at actual
completion, never on poll). `GET /v1/compute/capacity` shows arrival rate
(EWMA), p50/p95 service time, and the Little's-law concurrency target with
hysteresis. Admission is atomic per request: a map takes all N of its slots
or gets a 429 with none taken.

Admission is bounded (`KILN_COMPUTE_MAX_CONCURRENT`, default 8): over the
line you get `429` with a `Retry-After` header, not a silent queue.

Limits: code ≤ 256KB, `timeoutMs` 100..300000, args must be JSON-serializable,
results > 1MB are not returned (you get `truncated:true` instead).

## 2. `map` — fan out across workers (the supercomputer bit)

`POST /v1/compute/map`

```json
{
  "code": "export async function main(n) { return n * n; }",
  "items": [1, 2, 3, 4, 5, 6],
  "timeoutMs": 60000
}
```

Each item becomes its own job. The daemon spreads them over idle workers and
autospawns up to `maxNodes` (default 8). `GET /v1/compute/map/:mapId`
returns `{counts, results[]}` — aggregate whenever you like.

Up to 64 items per map. Need more? Say so deliberately — the cap is a
footgun guard, not a law of physics.

## 3. `apps` — pop a repo as a persistent service

`POST /v1/compute/apps`

```json
{
  "name": "my-api",
  "repo": "http://127.0.0.1:18787/git/auro/my-api",
  "command": "node",
  "args": ["server.mjs"],
  "port": 8901,
  "env": { "NODE_ENV": "production" }
}
```

The repo is cloned into a persistent node (`restartPolicy: always`,
`maxRestarts: 100`). The worker boots `command` on (re)start, restarts it on
crash with backoff, and streams logs to `app.log`. It survives daemon
restarts and VM recycles through the normal watchdog path: the daemon
respawns the worker, the worker re-reads `app.json` and boots the app again.

- `GET /v1/compute/apps` — list (with TCP readiness per app)
- `GET /v1/compute/apps/:id` — one app: worker liveness + port readiness probe
- `GET /v1/compute/apps/:id/logs?tail=100` — logs
- `DELETE /v1/compute/apps/:id` — stop for good (worker SIGTERMed, never respawned)

`status` reflects application readiness, not just process liveness: `ready`
means the declared port is actually accepting TCP connections; `starting`
means the worker is alive but the port isn't up yet.

The app command runs with the same jail philosophy as `shell.exec`: no
shell binaries, no metacharacters. `env` is validated (`[A-Za-z_][A-Za-z0-9_]*`,
≤ 32 entries); `app.json` is written `0600` because env can carry secrets.
The app's environment is an explicit allowlist (`PATH`, `HOME`, `TMPDIR`,
`PORT` if declared, plus your `env` entries) — it never inherits the
worker's environment, so daemon secrets can't leak into a deployed app.

## From another repo

```js
import { ComputeClient } from "<kiln>/swarm/lib/compute-client.mjs";
const kiln = await ComputeClient.connect(); // KILN_SWARM_DIR or ~/.kiln-swarm

const r = await kiln.invoke({
  code: `export async function main(args) { return args.x * 2; }`,
  args: { x: 21 },
  waitMs: 60000,
});
console.log(r.result); // 42

const m = await kiln.map({ code: `export async function main(n) { return n*n; }`, items: [1,2,3,4] });
const done = await kiln.waitMap(m.mapId);
console.log(done.results.map((x) => x.result)); // [1,4,9,16]

const app = await kiln.deployApp({ name: "my-api", repo: "…", command: "node", args: ["server.mjs"], port: 8901 });
```

`waitInvocation` / `waitMap` resolve on success and **throw** on failure or
timeout — never a maybe. See `swarm/examples/compute-invoke.mjs` for a full
"another repo" example and `swarm/AGENTS.md` for the agent operator manual.

## CLI

```
node swarm.mjs compute invoke --code "export async function main(a){ return a.x*2 }" --args '{"x":21}' --wait 60000
node swarm.mjs compute map --code "export async function main(n){ return n*n }" --items '[1,2,3,4]' --wait 120000
node swarm.mjs compute deploy --name my-api --repo <url> --command node --args '["server.mjs"]' --port 8901
node swarm.mjs compute apps
node swarm.mjs compute logs --app <id> --tail 50
node swarm.mjs compute undeploy --app <id>
```

## Trust model

Unchanged from the swarm: the Bearer token **is** the boundary. Anyone
holding `api.token` can already run arbitrary binaries via `POST /jobs`, so
`invoke` doesn't widen what a caller can do — it just makes it ergonomic.
Don't hand the token to code you wouldn't trust with a shell on this machine.
