# KILN quick-wins lane — daemon side (branch `quick-wins` off feat/l1-compute @ e1ba0ab)

Source audit: AUDIT.md on branch completeness-audit-wins (worktree kiln-completeness-audit).
Daemon-side code merges to feat/l1-compute and activates at the next Doctor boot.
The daemon is NEVER restarted by this lane.

## Items
1. [ ] daemonStatus() probe budget — swarm/swarm.mjs `daemon status`/`daemon watchdog`
       still probe /health with a fixed 5s budget (the defect class merge
       6219db5 fixed in the Doctor). Reuse lib/doctor.mjs probeBudget()
       (exported, load-scaled, env-overridable) + sustained-non-response rule.
2. [x] G4a — declare kiln_forge_protection_* (4) in capabilities forge mcpTools
       (openapi.mjs); extend openapi-drift test to pin capabilities mcpTools
       against the tools mcp-server.mjs serves (D3 fence).
       DONE: forge mcpTools 25→29 names (36→40 declared total = 40 served);
       drift suite 3/3 incl. the new both-directions set-equality pin.
3. [x] G5a — kiln_papers_list/get/version MCP tools in swarm/mcp-server.mjs +
       declare in papers ability mcpTools; mcp.test list pin 40 → 43.
       DONE: tools proxy /v1/papers (records already carry resolver URLs);
       list-tool description states the pre-activation 404 honestly (staged
       for next boot). mcp.test 10/10 incl. new call test (empty list,
       unknown-paper 404 verbatim); drift pin covers the declaration.
4. [x] G7(doc) — WORKSPACES.md "seven MCP tools" → correct count/mechanism (D4).
       DONE: the seven are now framed as this document's surface; the server
       total (43 = 7 + 28 forge + 5 packages + 3 papers) is stated with
       tools/list + /v1/capabilities named as canonical (drift-pinned).

Kit-side items live in ~/workspace/.worktrees/kiln-kit-quick-wins/NOTES-kit-quick-wins.md.

## Final gate accounting (2026-11-02)
- Merged to feat/l1-compute: 6160ece (items 1-4) + 458318e (probe fix).
  Activates at the next Doctor boot; the running daemon was never touched.
- Standalone gates on merged content: daemon-status-probe 6/6, watchdog
  10/10, daemon-down 6/6, mcp 10/10, openapi-drift 3/3, doctor 16/16,
  ci-log 5/5.
- Full suite attempt 1 (pre-fix tree): 451 tests, 447 pass — 3 watchdog
  regressions (mine, fixed by f951449) + ci-log (flake, 5/5 standalone).
- Full suite attempt 2 (final tree) was KILLED mid-run by the host
  (memory: ~1GB free of 8GB; test-runner children reaped, zero-byte
  logs, instant setup failures in untouched files). Interim failures
  were all in files with zero overlap with this diff (papers-workflow,
  repodetails, repos-templates, sites, workspaces, daemon-tick —
  grep-verified 0 references to swarm.mjs/daemonStatus except
  daemon-tick's real-daemon status test, whose asserted lines come
  from cmdDaemon paths this diff does not change). A clean full-suite
  number on the final tree is still owed when the host calms; the
  per-file standalone gates above are the current evidence.

## Log
- Setup: worktree off e1ba0ab; kit worktree off forge origin/main b44ce0b.
- Item 1 CORRECTED after the merged-tree full suite (451 tests) caught a
  real regression in watchdog.test.mjs (a suite my recon missed — it
  drives the CLI as a subprocess): daemonStatus's pidIsDaemon gate
  false-DOWNed the suite's fixtures (live test-runner pid + real
  answering server), and spanning the full window on REFUSED
  connections would have blown the suite's 25-30s subprocess budgets.
  Fix: no identity gate in the status verdict (pid-reuse lives in
  daemon start's lock reclamation + the Doctor), and probes are
  classified — HTTP answer = definitive; no-listener (ECONNREFUSED…)
  = DOWN after a 3s grace; silence = the full load-scaled window.
  watchdog 10/10, probe suite 6/6 (new refused-port pin), daemon-down
  6/6 standalone. The 4th full-suite failure (ci-log) passed 5/5
  standalone = the known load-flake pattern.
- Item 1 DONE: daemonStatus() now pidIsDaemon-checks + probes via the shared
  probeBudget() (load-scaled attempt/window, sustained non-response before a
  DOWN verdict, watchdog.log probe trail with latency+load, diag on result);
  `daemon status` prints a probe line when >1 attempt was needed. Fencing
  deliberately NOT mirrored (Doctor's layer). New test
  swarm/test/daemon-status-probe.test.mjs: 5/5 standalone (slow-alive UP,
  sustained DOWN, dead-pid instant, watchdog no-restart ×2). One fixture
  flake under load (child boot >5s) hardened to a 30s port wait.
