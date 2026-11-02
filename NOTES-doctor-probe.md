# NOTES — Doctor probe budget (load-aware) — branch doctor-probe-budget

Base: feat/l1-compute @ 900cff8 (verified 2026-11-01).
Problem (2026-11-01): Doctor returned 3+ FALSE "daemon still DOWN" verdicts vs a live
daemon answering GET /v1/capabilities 200 in 5–11s; Doctor probe budget timed out under
post-reboot load (loadavg 27–54 on 2-core box; box here reports nproc=4, load seen 10.5).

## Findings (code map)
- Probe lives in the KILN adapter `swarm/lib/doctor.mjs` `daemonHealth()`: pidAlive →
  pidIsDaemon → `fetch(apiUrl + "/health", AbortSignal.timeout(5000))` — FIXED 5s budget.
  One `up:false` from the watcher probe = a death in core supervisor.tick() →
  coroner → medic → `daemon watchdog` recovery. That is the false-DOWN chain.
- `swarm/lib/doctor-core/*` is a VENDORED snapshot ("do not edit here", sync-from-doctor.sh)
  → ALL changes go in `swarm/lib/doctor.mjs` only. Core stays untouched.
- Deaths journal = `<dir>/doctor/deaths.jsonl` via journalEvent (format/consumers preserved —
  not touched). Doctor log surface = `<dir>/doctor/doctor.log` via core `dlog()`.
- validateHealth passes extra health fields through → safe to attach `probe` diagnostics.
- Existing contracts to preserve: reason substrings /API not responding/, /fenced/,
  /is not alive/ (tests match on them); dead pid returns immediately (no API probe);
  fence verdict is identity, not non-response → stays immediate on a live API answer.
- swarm.mjs has a SEPARATE daemonStatus() (daemon status/watchdog CLI) with its own 5s
  fetch — not the Doctor's probe; out of scope, noted for the report.

## Design (all in swarm/lib/doctor.mjs)
- (a) `systemLoad()` (os.loadavg/cpus) + `probeBudget(opts)`: factor = max(1, load1/cores);
  attemptTimeout = clamp(5000*factor, 5000, 45000); window = clamp(15000*factor, 15000, 60000);
  minAttempts = max(2, ceil(window/attempt)); gap 1000ms; hard maxAttempts 12.
  Worst-case probe ≈ 90–106s < TICK_LOCK_STALE_MS (120s). Ops/test env overrides:
  KILN_DOCTOR_PROBE_ATTEMPT_MS / _WINDOW_MS / _GAP_MS; opts injection for tests.
- (b) daemonHealth API stage = confirmation loop: consecutive failed attempts (timeout,
  network error, or HTTP non-ok) until attempts>=minAttempts AND elapsed>=windowMs before
  returning up:false. Any success returns up immediately. Pid identity re-checked between
  attempts. DOWN reason keeps legacy prefix + appends sustained/load/budget evidence.
  Result carries `probe` diagnostics {attempts, elapsedMs, load1, cores, perCore,
  attemptTimeoutMs, windowMs}.
- (c) dlog per attempt (latency + load + budget) + DOWN-verdict line into doctor.log;
  KilnSupervisor.tick() override logs tick durationMs + load into doctor.log.

## TODO
- [x] Read doctor code (lib/doctor.mjs + lib/doctor-core/*), find probe + DOWN verdict + recovery path
- [x] (a) load-scaled probe budget — probeBudget()/systemLoad() in lib/doctor.mjs; smoke-verified:
      idle → attempt 5000ms window 15000ms minAttempts 3; load1=54/2 cores → caps 45000/60000, minAttempts 2
- [x] (b) sustained non-response — confirmation loop in daemonHealth (consecutive failures spanning
      window + minAttempts; pid identity re-checked between attempts; dead pid still instant)
- [x] (c) logging — per-attempt dlog (latency/load/budget) + DOWN-verdict line + KilnSupervisor.tick()
      duration/load line, all into <dir>/doctor/doctor.log (existing dlog surface); probe diagnostics
      attached to health results as `probe`
- [x] Tests: slow-alive under high load NOT down; dead still detected+recovered; budget stretches with load
- [x] Full swarm suite run — 443/443 pass, 0 fail (136 suites, 444s, log: full-suite.log). No flakes.
- [x] Activation finding (cron runs doctor check from MAIN tree; long-running doctor loop)

## Activation finding (investigated 2026-11-01, read-only)
- TWO consumers run doctor code from the MAIN tree (~/workspace/repos/KILN, currently on feat/l1-compute):
  1. Muse cron `kiln-swarm-daemon-watchdog` (interval 5m, timeout_secs=120) runs
     `node /home/hatch/workspace/repos/KILN/swarm/swarm.mjs doctor check --dir /home/hatch/.kiln-swarm`
     — a FRESH node process per run → picks up new code automatically on the first run after
     the coordinator merges this branch into feat/l1-compute in the main tree. No cycle needed.
  2. The long-running doctor loop: pid 24193, started 2026-11-01T22:45:53Z,
     `node …/swarm/swarm.mjs doctor _run --dir /home/hatch/.kiln-swarm` — loaded lib/doctor.mjs
     at start; keeps OLD code until the process is cycled. NOT cycled by me (hard rule).
     Exact activation for the loop: after merge, an authorized `swarm.mjs doctor stop`
     (the next cron `doctor check` auto-starts the loop with new code via check()'s
     ensure-alive path) or `doctor stop` + `doctor start`.
  → State after merge alone: PARTIAL activation (cron inline ticks new, loop ticks old,
    serialized by the same tick lock). FULL activation needs the one loop cycle above.
- Caveat: cron timeout_secs=120 vs worst-case stretched check: a genuinely unresponsive API
  at max load can make one daemonHealth confirmation run ~90–106s and check() probes twice
  (tick + final verify) → a check could exceed 120s and be killed mid-confirmation. Harmless
  (no verdict is journaled until the window completes; next run resumes) but worth raising
  the cron timeout to ~300s when the loop is cycled. NOT changed here (cron belongs to
  goal service-drop-watchdog; not in this task's authority).

## Log
- Worktree created ~/workspace/.worktrees/kiln-doctor-probe, branch doctor-probe-budget @ 900cff8.
- 162570e notes/design checkpoint. fd32652 implementation (lib/doctor.mjs only).
  8b5ccc0 tests (test/doctor-probe-budget.test.mjs, 5 tests, all pass standalone, 36.7s).
- Existing doctor-adjacent suites pass: doctor + doctor-recovery-hardening + watchdog +
  daemon-down = 41/41 (46s).
- Full suite: DONE — `node --test test/*.test.mjs` → 443 tests / 136 suites, 443 pass, 0 fail,
  duration 444s (loadavg ~10–14 during run). No failures, so no flake analysis needed.
  (443 includes the 5 new tests; doctor-adjacent files re-verified separately at 41/41.)
