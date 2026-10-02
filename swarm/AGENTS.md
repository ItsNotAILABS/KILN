# Using the KILN swarm as compute — agent guide

This is the operator manual for **agents** (models, protocols, Muse
instances, subagents — anything that can run Node) that want to offload work
to the swarm: spawn workers, run jobs, and collect results with signed
receipts. Not CLI-only: everything here goes through `lib/client.mjs`, a
zero-dependency SDK (global `fetch` only).

For the runtime internals (nodes, grants, daemon), read `README.md`.

## 1. Connect

```js
import { SwarmClient } from "<path-to>/KILN/swarm/lib/client.mjs";

// Reads <stateDir>/daemon.json (api port) + api.token. Throws LOUDLY if the
// daemon isn't running — never guesses, never silently degrades.
const swarm = await SwarmClient.connect(); // or { dir: "/home/user/.kiln-swarm" }
// KILN_SWARM_DIR env also works.
```

If it throws, the daemon is down. Do NOT fake the work — either start it
(`swarm.mjs daemon start` via shell, if you have that right) or report that
compute is unavailable.

## 2. The agent loop

```js
// Spawn a worker. caps: 1=commit 2=release 4=propose 8=delegate (bitmask).
// policy: "never" | "on-failure" | "always".
const { id } = await swarm.spawnNode({
  name: "my-worker", caps: 1, ttlSec: 3600,
  repo: "http://127.0.0.1:18787/git/auro/auro", // optional: worker git-clones this
  mind: "script", policy: "on-failure",
});

// Run a job on it. plan.steps[] = tool calls the worker executes for real.
const { id: jobId } = await swarm.submitJob({
  name: "compute-something",
  node: id,
  mind: "script",
  plan: { steps: [
    { tool: "shell.exec", args: { command: "node", args: ["-e", "console.log(6*7)"] } },
    { tool: "fs.write",   args: { path: "RESULT.md", content: "# result\n" } },
    { tool: "git.commit", args: { message: "agent: computed result" } },
    { tool: "git.push",   args: {} }, // publish to the KILN-native remote
  ]},
});

// waitForJob resolves on done, THROWS on failed or timeout — never a maybe.
const job = await swarm.waitForJob(jobId, { timeoutMs: 120000 });
console.log(job.summary); // real tool output, e.g. git commit's stdout

// Inspect + verify.
const logs = await swarm.nodeLogs(id, { tail: 50 });
const receipts = await swarm.verifyReceipts(id); // signed hash chain check
await swarm.stopNode(id); // clean up when done
```

Available tools inside a job step (`tool` / `args`): `shell.exec {command,
args, timeoutMs}` (argv-based, no shell), `fs.read {path}`, `fs.write {path, content}`, `git.status`,
`git.log`, `git.commit {message}`, `git.push {remote?}`
(publishes to the KILN-native remote using the daemon credential — the token
never touches the workdir or logs), `swarm.submit {…}`, `swarm.spawn {…}`,
`project.release {…}`. Every call is grant-gated: without the matching cap it
is **refused before running** (the job fails honestly, nothing half-done).

## 3. depositCode — the one-call contribution primitive

```js
// Spawns a minimal CAP_COMMIT-only node, clones `repo`, writes the files,
// commits. Returns { nodeId, jobId, commitHash, summary, receipts }.
// commitHash is parsed from the REAL `git commit` output — never invented.
const r = await swarm.depositCode({
  repo: "http://127.0.0.1:18787/git/auro/scratch",
  files: [{ path: "NOTE.md", content: "hello from the swarm\n" }],
  message: "agent: deposit note",
});
```

## 4. KILN-native git

```js
const repos = await swarm.listRepos();            // [{ owner, repo }, …]
const r = await swarm.createRepo({ owner: "auro", repo: "scratch" });
// r.cloneUrl → "http://127.0.0.1:18787/git/auro/scratch"
```

Clone/fetch are public. **Push needs the bearer token**: the daemon's
`api.token` as an `Authorization: Bearer <token>` header (git http.extraHeader).
Pushes without it are refused — verified, not assumed.

## 5. Persistent pieces of yourself

A node with `policy: "always"` is a persistent worker: the daemon respawns it
if it dies. Give it your repo and your caps, and it is a standing extension
of you inside KILN — it can hold state in its workdir, run jobs you submit,
and leave signed receipts for everything it did.

```js
const { id } = await swarm.spawnNode({
  name: "auro", caps: 15, ttlSec: 31536000,
  repo: "http://127.0.0.1:18787/git/auro/auro",
  mind: "script", policy: "always", maxRestarts: 100,
});
```

Check on it any time: `listNodes()`, `nodeLogs(id)`, `verifyReceipts(id)`.

## 6. KILN Compute — serverless functions, fan-out, app hosting

`lib/compute-client.mjs` (`ComputeClient extends SwarmClient`) turns the
swarm into serverless compute any repo can call. Same auth, same receipts.

```js
import { ComputeClient } from "<path-to>/KILN/swarm/lib/compute-client.mjs";
const kiln = await ComputeClient.connect();

// invoke: run a function, get the result. code MUST export main(args).
// waitMs blocks (1000..300000); omit it for fire-and-forget + poll.
const r = await kiln.invoke({
  code: `export async function main(args) { return args.x * 2; }`,
  args: { x: 21 },
  waitMs: 60000,           // -> { status:"done", ok:true, result:42, logs, durationMs }
});
const v = await kiln.invocation(r.invocationId);          // poll later
const v2 = await kiln.waitInvocation(r.invocationId);     // throws on failure/timeout

// map: fan one function over many items — the supercomputer bit.
// Each item is its own job; the daemon spreads them across idle workers
// and autospawns up to maxNodes. Max 64 items per map.
const m = await kiln.map({
  code: `export async function main(n) { return n * n; }`,
  items: [1, 2, 3, 4],
});
const done = await kiln.waitMap(m.mapId);                // throws if any item failed
console.log(done.results.map((x) => x.result));         // [1, 4, 9, 16]

// apps: deploy a repo as a persistent supervised service.
// The worker boots `command` on (re)start, restarts it on crash, logs to app.log.
// Survives daemon restarts and VM recycles via the watchdog path.
const app = await kiln.deployApp({
  name: "my-api",
  repo: "http://127.0.0.1:18787/git/auro/my-api",
  command: "node", args: ["server.mjs"], port: 8901,
});
const logs = await kiln.appLogs(app.appId, { tail: 50 });
await kiln.undeployApp(app.appId); // stop for good
```

Function results are real: `ok:true` + JSON `result`, or `ok:false` + the
function's real error. A module without `main()` fails loudly. Limits:
code ≤ 256KB, `timeoutMs` 100..300000ms, results > 1MB are not returned.

## 7. Rules (non-negotiable)

1. **Real or loud failure.** Every tool executes for real or the job fails
   with the real error. Never invent output, hashes, receipts, or commits.
2. **Verify receipts** after work that matters (`verifyReceipts`). A broken
   chain means tampering — say so.
3. **Least capability.** Spawn with only the caps the task needs
   (`depositCode` uses CAP_COMMIT alone). Caps are a bitmask: 1 commit,
   2 release, 4 propose, 8 delegate.
4. **Clean up** short-lived nodes with `stopNode`. Keep persistent ones few
   and named.
5. **Daemon health first.** If `connect()` throws, run `swarm.mjs daemon
   status`; if a watchdog cron exists it will have restarted it — otherwise
   say the swarm is down instead of pretending.
