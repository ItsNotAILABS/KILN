# KILN Doctor — diagnostic supervisor for the swarm daemon

The swarm daemon dies silently from time to time: no fatal exception in
`daemon.log`, no OOM evidence, just gone. The plain `daemon watchdog`
restarts it blindly, which keeps the swarm up but never learns WHY.

The doctor replaces blind restarts with **forensic supervision**:

1. **Watch** — its own detached poll loop (~15s) checks true daemon health
   (pid alive AND genuinely the daemon AND the API answering).
2. **Capture** — on a new death, BEFORE restarting, it writes a forensic
   bundle to `~/.kiln-swarm/doctor/deaths/<utc-ts>.json`: daemon.log tail
   (200 lines), watchdog.log tail, `ps` filtered to node/swarm, available
   memory, dmesg OOM grep, lock state, per-node heartbeat ages, the dead
   daemon's uptime and reason.
3. **Recover** — through the EXISTING `daemon watchdog` restart path (shared
   via the CLI, not duplicated), then verifies with a health check. A
   stale-held lock gets a courtesy re-probe, never a forced break.
4. **Journal** — every death and recovery is appended to
   `~/.kiln-swarm/doctor/deaths.jsonl` (one JSON object per line).
5. **Diagnose** — `diagnose()` mines the journal: median death interval,
   time-of-day histogram (UTC), stale-heartbeat correlation, memory trend,
   OOM evidence. It returns a clearly-labeled **hypothesis**, never a
   conclusion — and `"insufficient-data"` below 3 recorded deaths.

## Agent architecture

The doctor is four specialist agents supervised by a core:

```
            ┌─────────────────────────┐
            │      doctor core        │
            │  (poll loop, tick lock, │
            │   agent supervision)    │
            └────┬────┬────┬────┬─────┘
                 │    │    │    │
           ┌─────┘    │    │    └─────┐
           ▼          ▼    ▼          ▼
       ┌────────┐ ┌────────┐ ┌──────────┐ ┌───────┐
       │watcher │ │coroner │ │detective │ │ medic │
       │probes  │ │captures│ │mines the │ │recovers│
       │health  │ │forensics│ │journal  │ │via the │
       │        │ │BEFORE  │ │         │ │watchdog│
       │        │ │recovery│ │         │ │ path   │
       └────────┘ └────────┘ └──────────┘ └───────┘
```

- **watcher** — the honest health probe (pid alive AND genuinely the
  daemon AND the API answering). A failed probe is a death, never a maybe.
- **coroner** — on a NEW death, runs every forensic collector BEFORE any
  restart and writes the bundle. Evidence first, restart second — always.
- **detective** — mines `deaths.jsonl` and produces the diagnosis. It also
  reads the daemon's `tick.json`: when the latest death's last completed
  tick is more than 5 minutes old, the wedge hypothesis is CONFIRMED, not
  just suspected.
- **medic** — recovery with manners: lock courtesy (never force a restart
  on a live subject), then the proven restart path, then an honest verify.
  The journaled `ok` is the *verification* result, not the restart's.

The core restarts any agent that throws (up to 5 times, then retires it
loudly while the loop stays alive) — a broken forensics collector must
never stop recovery. `doctor status` shows each agent's state
(`watcher=ok coroner=ok detective=ok medic=ok`).

## The generic core (vendored)

The agents and the core live in `swarm/lib/doctor-core/` — a vendored
snapshot of the standalone repo **ItsNotAILABS/doctor**
(`@itsnotai/doctor` on npm): a zero-dependency generic process
supervisor with the same four agents and a plugin interface
(`healthCheck`, `collectors`, `recover`, `lockProbe`). KILN is just one
plugin: `swarm/lib/doctor.mjs` (the KILN adapter) wires the swarm
daemon's health check, collectors, and watchdog-path recovery into the
generic core.

The doctor repo is the source of truth. KILN's copy is a snapshot —
**do not edit `swarm/lib/doctor-core/*.mjs` by hand**. Re-sync with:

```
bash swarm/lib/doctor-core/sync-from-doctor.sh
```

The vendored commit is recorded in `swarm/lib/doctor-core/VERSION`.

## Commands

```
swarm.mjs doctor start|stop|status|report|check [--dir PATH]
```

| command | what it does |
|---|---|
| `start` | Daemonize the doctor loop (detached, stdio → `doctor/doctor.log`, pidfile `doctor/doctor.json`). No-op if already running. |
| `stop` | SIGTERM the doctor loop. |
| `status` | Doctor alive? Daemon health? Death count + last death timestamp. Exits 1 when the doctor is down. |
| `report` | Journal summary (last 5 deaths) + current diagnosis. Expect `insufficient-data` until 3 deaths are recorded. |
| `check` | **The cron entry point.** Ensures the doctor is alive (starts it if not), runs one inline supervision tick, then prints only what's new since the last check: death/recovery lines and any NEW diagnosis. Silent exit 0 when healthy and nothing new. Exit 1 when the daemon is still DOWN or the watchdog reported a crash loop. |

The 5-minute cron runs `doctor check`. The worker running it reports the
stdout lines; the agent layer turns death/recovery lines into tracking
timeline entries and surfaces NEW DIAGNOSIS lines to the user. The doctor
process itself never chats — deaths are journaled, not announced.

## Alert policy

- Daemon dies and the doctor recovers it → **silent** (journaled only).
- Daemon still DOWN after the recovery attempt, or the watchdog reports a
  crash loop (≥5 restarts in an hour) → `check` exits 1 → the cron alerts
  the user immediately, pointing at `~/.kiln-swarm/daemon.log`.
- `diagnose()` produces a NEW hypothesis or pattern → surfaced once via
  `check` output (deduped against the last notified hypothesis).

## Tick instrumentation

The daemon's tick loop can wedge: it stops making progress without being
killed, so nothing looks like a crash. Two mechanisms make that observable
and self-terminating.

**tick.json.** After every completed tick the daemon writes
`<stateDir>/tick.json` with one `writeFileSync`:

```json
{"lastTickStartMs": 1759330000000, "lastTickEndMs": 1759330000012,
 "tickCount": 48123, "avgTickMs": 11.8, "maxTickMs": 240.0,
 "updatedAt": "2026-10-02T10:00:00.012Z"}
```

- `lastTickStartMs` / `lastTickEndMs` — wall-clock `Date.now()` at tick
  start/end (consistent with the heartbeat files).
- `tickCount` — completed ticks this daemon lifetime.
- `avgTickMs` — running mean of tick duration; `maxTickMs` — max observed.
- `updatedAt` — ISO timestamp of the write.

A write failure can never break the tick: it is logged once per daemon
lifetime (then suppressed), never per tick. The external supervisor reads
this file — a stale `lastTickEndMs` on a live pid is the wedge signature.

**`daemon status` tick line.** When the daemon is up, `swarm.mjs daemon
status` prints after the api line:

```
tick: last completed 3s ago, avg=12ms max=240ms count=48123
```

or `tick: no tick data yet` when the daemon is up but no tick has completed.

**Stall self-abort.** An INDEPENDENT 30s watchdog timer (`setInterval`,
registered in `main()`, separate from the tick interval) checks a pure
predicate every 30s — it reads the in-memory tick stats, so it does not
depend on `tick()` running:

```
stall = (nowMs - lastTickEndMs > thresholdMs) AND (nowMs - bootMs > thresholdMs)
```

Grace rules (conservative by design): never aborts before the daemon has
been up longer than the threshold, and never before the first tick
completes (`lastTickEndMs` null → not stalled). Threshold default is
600000 ms (10 minutes) — no false positives under normal 2s ticks.
Configurable via `config.json` `tickStallAbortMs`, or env
`KILN_TICK_STALL_MS` (env wins when set to a valid positive integer;
invalid values are ignored).

On stall the daemon logs LOUDLY and exits(1):

```
TICK STALL — self-aborting: no completed tick for 601234ms (threshold 600000ms,
lastTickEnd=2026-10-02T10:00:00.012Z, tickCount=48123, avgTickMs=11.8, maxTickMs=240.0)
```

A loud crash is the point: the doctor captures the forensic bundle and
restarts through the proven watchdog path. The stall line is written
synchronously (fd 1) so `process.exit(1)` cannot truncate it.

**Honest limitation.** An in-process timer cannot catch a FULLY blocked
event loop — no timer fires while the thread is wedged. This watchdog
catches the cases it can see from inside (tick interval starved, ticks
that start but never complete, slow death). The doctor remains the
external backstop for the fully-blocked case: it detects the stale
tick.json + unresponsive API from outside and restarts.

**Test-only hook.** `KILN_TICK_WEDGE_TEST=1` makes the daemon skip every
tick after the first completes (alive process, stale tick.json, free event
loop) so the self-abort path is exercised for real in tests
(`swarm/test/daemon-tick.test.mjs`). Never set in production.

## Honesty notes — what the doctor can and can't do

- **Can:** detect every daemon death within ~15s, preserve pre-restart
  evidence that the old watchdog destroyed, recover through the proven
  restart path, and find statistical patterns across deaths (regular
  intervals, time-of-day clustering, which workers go heartbeat-stale
  first, memory trends, OOM-killer sightings).
- **Can't:** see inside a dead process. If the daemon is SIGKILLed by the
  kernel with nothing in the log, the bundle records exactly that absence —
  the diagnosis will say the deaths "look irregular" rather than invent a
  cause. dmesg OOM correlation is coarse (no per-death timestamps from the
  kernel ring buffer in this environment).
- The bearer token (`api.token`) is read only to probe the API and is never
  written to any log, bundle, journal line, or stdout.
- The journal starts fresh on deploy. Old deaths are NOT backfilled — a
  hypothesis built on invented history would be worse than none.

## Files

All under `<stateDir>/doctor/` (default `~/.kiln-swarm/doctor/`):

```
doctor.json    {pid, startedAt} — the doctor's own pidfile
doctor.lock    exclusive-create single-instance lock
tick.lock      serializes the loop tick vs an inline `check` tick
doctor.log     the doctor's own log
state.json     lastHealthyTs, lastHandledDeathId, lastCheckTs, lastHypothesisNotified
deaths.jsonl   one JSON object per death/recovery event
deaths/        forensic bundles, one JSON file per death
```

## Tests

`swarm/test/doctor.test.mjs` (16 tests): synthetic-journal diagnosis
(regular interval, time-of-day clustering, stale-worker correlation, OOM
flag, insufficient-data floor), bundle capture against a scratch state dir,
stale vs live lock probing (pid-reuse safe), honest down-reporting, and an
end-to-end tick that restarts a dead daemon through the real watchdog path
on an ephemeral port. All tests use scratch dirs and never touch the live
daemon.

`swarm/test/daemon-tick.test.mjs` (14 tests): tick.json contract shape and
sane values from a real daemon, `tickStalled()` predicate units (recent /
stale / boot grace / null-first-tick / threshold boundary), threshold
resolution (default 10min, config `tickStallAbortMs`, env
`KILN_TICK_STALL_MS` precedence), the self-abort end-to-end (wedged tick
loop → exit(1) + loud TICK STALL line via the test-only
`KILN_TICK_WEDGE_TEST` hook), and the `daemon status` tick line (including
`no tick data yet` before the first tick).
