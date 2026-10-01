# KILN Compute Runtime

How KILN's serverless runtime actually works: the scheduler math, the
isolation stack, metering, retries, and the honest list of what this
single-host runtime does and does not yet do. This doc describes the
implementation in `swarm/lib/compute.mjs` and friends; the runtime test
suite (`swarm/test/compute-runtime.test.mjs`) exercises the mechanisms
end-to-end against a real daemon (isolation, denial, limits, metering,
billing, 429 backpressure, readiness, env allowlist), and
`swarm/test/compute.test.mjs` covers the API contract. Claims about
behavior were verified by running them, not by reading the code.

## 1. What a function invocation is

`POST /v1/compute/invoke {code, args?, timeoutMs?, memoryMB?, network?, retries?, name?, waitMs?}`

1. **Admit** — the daemon checks the in-flight count against
   `KILN_COMPUTE_MAX_CONCURRENT` (default 8). Over the line: `429` with a
   `Retry-After: 2` header. No unbounded queue, no silent pile-up.
2. **Compile** — `code` (a JS module exporting `main(args)`) plus a
   metering harness (`runner.mjs`) are written to
   `.kiln_compute/<invId>/` inside a worker's work dir, and submitted as
   a real swarm job. The daemon spreads jobs across workers.
3. **Execute** — the worker's `shell.exec` tool runs the harness inside
   the Linux sandbox (§3). Stdout becomes `logs`; the return value is
   JSON-serialized to `result.json`; the harness meters itself to
   `metrics.json`; the sandbox parent writes `sandbox.json`.
4. **Settle** — the daemon tick runs a settlement sweep over the queue
   events: each attempt's admission slot is released exactly once, at actual
   job completion — never on poll. `GET /v1/compute/invocations/<id>` is a
   pure view: it merges the job event, `result.json`, `metrics.json`, and
   `sandbox.json` into status, result, logs, `metrics`, and `billing`,
   without touching scheduler state.

`POST /v1/compute/map` is N invokes sharing one `mapId` (max 64 items),
admitted atomically: all N slots or a 429, never a half-admitted map.
`GET /v1/compute/capacity` exposes the scheduler's telemetry (§2).

## 2. Scheduler math

The daemon is single-process; workers are child processes on one host.
Scheduling is therefore **admission control + telemetry**, not placement.

### 2.1 Little's law and the capacity target

For a stable system, Little's law relates the three quantities:

```
L = λ · W
```

- `λ` — arrival rate (invocations/second), as an EWMA (alpha 0.3) over
  inter-completion gaps. Completions approximate arrivals in steady state.
- `W` — service time (seconds), as the **p95** of the completion ring.
  Tail latency is what breaks a staffing target; p95 of real completions
  is observable where the function's "true cost" is not, and the earlier
  p50-based target under-provisioned exactly when the host got noisy.
- `L` — mean number of invocations concurrently in the system

The `/v1/compute/capacity` endpoint reports `littleTargetWorkers` and the
hysteresis-applied `desiredWorkers`:

```
littleTargetWorkers =
  clamp(min_warm, max_workers, ceil(arrival_rate_ewma · service_time_p95 · 1.5))
```

- The 1.5 safety factor is burst headroom: at exactly `L = λW` workers the
  system is at 100% utilization and any burst queues. 1.5× keeps
  steady-state utilization near 67%, which absorbs a 2× burst for roughly
  one service time before queueing starts. This is the standard M/M/c
  staffing intuition (Erlang-C with a delay-probability target behaves the
  same way: you staff above the offered load `a = λW`, never at it).
- `min_warm` (env `KILN_COMPUTE_MIN_WARM`, default 1) and `max_workers`
  (`KILN_COMPUTE_MAX_CONCURRENT`, default 8) clamp the target to sane
  bounds — the estimator never suggests zero workers on an idle box or
  more concurrency than admission allows.
- Hysteresis: `desiredWorkers` adopts an increased target immediately but
  steps down only when the raw target falls a full worker below it, so the
  reported target doesn't flap on noisy samples.

Honest scope, stated plainly: the scheduler is **telemetry + admission
control, not an autoscaler**. It computes and publishes the staffing
target; nothing in the daemon spawns or stops workers from it. Enforcement
is the 429 admission bound. Turning the target into real autoscale
actuation is a scoped-out future step (§5).

### 2.2 Backpressure

`MAX_CONCURRENT` (env `KILN_COMPUTE_MAX_CONCURRENT`, default 8) is the hard
ceiling. The default comes from the box: 2 CPUs, and a Node function
pegging one core means 8 concurrent invocations can transiently oversubscribe
~4× — acceptable for short functions, visible via `capacity.inflight`, and
one env var away from tuning. When the ceiling is hit the API answers 429
with a `Retry-After: 2` header, so callers back off instead of building an
invisible queue inside the daemon.

Admission is atomic per request: a single invoke takes one slot; a map
takes all N of its slots at once or gets a 429 with none taken — a 64-item
fan-out at capacity can never strand a half-admitted map (failed
admissions release nothing because they took nothing).

Completions feed a 500-sample ring buffer; each attempt's duration is
recorded exactly once by the settlement sweep (§2.4), guarded by a
per-attempt settle key, so retries and repeated polls can't double-count.

### 2.3 Retries and idempotency

`retries` (0–2, default 0) retries **sandbox-infrastructure failures only**:
the sandbox setup itself failed inside the namespaces (exit 21–28), i.e.
the function never ran. Function errors, timeouts, memory kills, and fork
bombs never retry — re-running them would just fail identically and burn
someone's budget.

There is no cross-invocation idempotency key yet: each `POST` is a new
invocation with a new id. Retried attempts reuse the invocation id and are
visible as `attempt: 2` with `retried: true` once resubmitted; while a retry
is waiting on capacity the view shows `retryPending: true`.
(See §5 for what's missing.)

### 2.4 Settlement, exactly once, at completion

Admission slots used to be released when the caller polled the invocation —
a caller that never polled leaked a slot until the daemon restarted. Now
the daemon tick runs `settleComputeJobs()`: an incremental sweep over queue
events since a persisted high-water mark (`settleSeq`). Each terminal
attempt (done or failed) releases its slot exactly once, guarded by a
per-attempt settle key that survives daemon restarts (seeded from the
store). Polling an invocation is a pure read and never touches scheduler
state.

One subtlety this creates: a `waitInvocation` that returns the moment the
job looks done can resolve up to one tick before the sweep releases the
slot. So submission reconciles just-in-time — `submitInvocation` and
`submitMap` run the (idempotent) sweep before the admission decision, and
admission always sees real capacity. The tick remains the primary settler;
the submit path just refuses to decide on stale numbers.

Retries ride the same sweep: a sandbox-infra failure with retries left is
settled and marked retry-deferred, then a second pass resubmits it through
admission — at capacity it keeps `retriesLeft` and waits for a later sweep
instead of jumping the queue.

## 3. Isolation

Every function runs under `swarm/lib/sandbox.mjs` + `sandbox-setup.sh`:

| Mechanism | What it does | Enforcement |
|---|---|---|
| Mount namespace | workdir bind-mounted as the only writable user path | kernel |
| Mount namespace | `/home`, `/root` covered with an empty dir | kernel |
| Mount namespace | `/etc` covered too when `network:false` | kernel |
| PID namespace | function sees only its own tree; init death kills the tree | kernel |
| UTS + IPC namespaces | hostname and IPC objects are private | kernel |
| Net namespace | fresh loopback only, unless `network:true` | kernel |
| Minimal env | `env -i PATH HOME` — host env never enters | exec |
| JS heap cap | `--max-old-space-size=<memoryMB>` | V8 |
| RSS supervisor | parent polls tree RSS every 50ms, SIGKILL past 2× memoryMB | supervisor |
| Fork guard | parent counts namespace processes every 50ms, SIGKILL past 128 | supervisor |
| Wall-clock timeout | SIGTERM at deadline, SIGKILL 5s later even if TERM is ignored | supervisor |
| Output cap | 64KB stdout/stderr capture | supervisor |

Deliberate non-goals and why:

- **RLIMIT_NPROC is not used.** It counts threads per UID machine-wide; on a
  busy host the daemon's UID already holds thousands of threads, so any
  useful limit SIGSEGVs Node at startup (`uv_thread_create` fails inside
  `WorkerThreadsTaskRunner`). The namespace-scoped process count does the
  job without the false positives. (We learned this by watching Node crash,
  not by reasoning about it.)
- **RLIMIT_AS is not used.** V8 reserves ~4GB of virtual address space at
  startup; capping address space kills the runtime during init. The heap cap
  + RSS supervisor covers real memory instead.
- **RLIMIT_CPU is not used.** This build of `unshare` mishandles the child's
  SIGXCPU death (`sigprocmask unblock failed`), so CPU is **metered**
  (`process.cpuUsage()` → `metrics.cpuMs`) rather than capped. The
  wall-clock timeout is the hard bound on CPU burners.
- **No seccomp filter yet.** The namespace + env + output restrictions are
  the current boundary; a seccomp-bpf syscall allowlist is the next layer
  (§5).
- **cgroup controllers** are not delegated in this environment, so
  kernel-enforced CPU/memory/pids limits are unavailable; the supervisor
  process does the enforcing in userspace.

## 4. Metering and billing

The harness records `wallMs`, `cpuMs` (user+system), and `peakRssBytes`
(`process.resourceUsage().maxRSS`). The sandbox parent records `timedOut`,
`signal`, `rssKilled`, `forkBomb`, `heapOom`. Billing derives from metered
numbers, the serverless unit:

```
billedMs  = ceil(wallMs)
GB-seconds = (billedMs / 1000) × (memoryMB / 1024)
```

Both ride on the invocation view (`metrics`, `billing`). No prices are
attached — KILN meters usage; pricing is a policy layer above.

## 5. Honest gaps (not yet built)

- **Autoscale actuation.** The scheduler computes the Little's-law staffing
  target and publishes it on `/v1/compute/capacity`; nothing acts on it.
  Real autoscaling (spawning/retiring workers from `desiredWorkers`) is
  designed but not implemented.
- **Idempotency keys.** Retried POSTs create new invocations; callers must
  dedupe. Planned: client-supplied `idempotencyKey` with 24h dedupe window.
- **Per-function concurrency limits and reserved concurrency.** Only the
  global `MAX_CONCURRENT` exists.
- **Warm pools / provisioned concurrency.** Every invoke cold-starts Node
  (~65–80ms measured). No pool yet.
- **Dead-letter queue.** Invocations that exhaust retries surface as
  `failed` with the error; there is no DLQ to inspect later.
- **Seccomp-bpf syscall filtering.** Namespaces are the current boundary.
- **Multi-host placement.** The scheduler is single-host; the job system
  already spreads work across workers on this box.
- **Signed invocation receipts.** Jobs have hash-chained receipts; compute
  invocations don't yet anchor theirs.
- **Readiness depth.** `ready` means a TCP connect to the declared port
  succeeded — not an HTTP health check, not "serving correct traffic."
- **Deploy-branch mismatch.** Fixed 2026-10-01: node creation now refuses
  a clone that produced no checkout (remote HEAD pointing at a missing
  branch used to boot into an empty tree and crash-loop with
  MODULE_NOT_FOUND), and app supervision waits for a valid checkout
  before booting instead of restarting into a broken tree.

## 6. Apps (persistent services)

`POST /v1/compute/apps {name, repo, command, args?, env?, port?}` deploys a
repo as a supervised service: the worker boots `command` on (re)start and
restarts it on crash with backoff; logs go to `app.log`.

Two corrections from the first version:

- **Readiness, not just liveness.** `GET /v1/compute/apps/:id` reports
  `status: ready | starting | running | down` where `ready` means a TCP
  probe of the declared port actually accepted a connection. `running`
  (no port declared) still means the worker is alive. The port was always
  recorded; now it's actually checked.
- **Explicit env allowlist.** Apps used to inherit the worker's entire
  environment (`{...process.env, ...app.env}`) — a credential-extraction
  path for anyone holding the API token. Now the app gets
  `PATH, HOME, TMPDIR, PORT?` plus only its declared `env` entries. The
  daemon's secrets never enter the app's process.

Apps are deliberately less jailed than functions (they're long-lived
services, not one-shot compute), but they no longer see host secrets.
