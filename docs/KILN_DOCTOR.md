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
