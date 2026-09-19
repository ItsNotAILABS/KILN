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

## 6. Rules (non-negotiable)

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
