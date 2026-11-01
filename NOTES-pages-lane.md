# KILN Pages lane — third dispatch (2026-10-31 ~23:18 CDT)

## WIP verdict (inherited, unchanged by lane 2 which died at startup)
**SOUND — complete implementation, zero tests.** All four files syntax-check:
- `swarm/lib/pages.mjs` (new, 179 lines): `planPage()` resolves /pages/:owner/:repo/*
  against the designated ref via forge `readContents` (git plumbing, never FS).
  Per-segment percent-decode + reject (`.`, `..`, `/`, `\`, NUL → 404; bad encoding → 400).
  Directory w/o slash → 301 iff it has an index; missing → real 404, no SPA fallback.
  28-entry content-type map; plan carries commit sha for the x-kiln-pages-sha header.
- `swarm/lib/repodetails.mjs`: `pages {enabled, branch, path}` in kiln.json; malformed
  store reads as disabled (fail-closed); PATCH validation strict (branch regex +
  no `..`/`.lock` suffix; path = clean relative dir, no dot/empty segments).
- `swarm/lib/httpapi.mjs`: GET|HEAD /pages route; anonymous principal minted only for
  public repos; private → owner namespace + operator (anon 401, non-owner account 403);
  agent principals need `forge` scope; 301/200 with content-type/length, no-cache,
  x-kiln-pages-{sha,path}. PATCH details passes `pages` through (existing owner gate).
- `swarm/lib/openapi.mjs`: PAGES_SETTING_SCHEMA on RepoDetails + PATCH body; capabilities
  mention pages in project-details + forge abilities (no NEW /v1 path → drift test only
  needs route coverage unchanged; /pages is outside /v1, same as /git).

## Completion plan
- [x] 1. Commit WIP implementation — abf828c (drift + repodetails green pre-commit).
- [x] 2. swarm/test/pages.test.mjs — full matrix green. Two real findings fixed/documented: (a) planPage invalid-name 400→404 (URL pathname normalization can rewrite an encoded probe into an invalid repo name; a serving route answers absence with 404); (b) traversal probes fired as RAW http paths — %2f/ %5c/encoded-dot probes all 404 with zero leak; probes collapsing off-route get the forge standard gates; dot segments canonicalizing WITHIN the surface serve exactly the canonical URL (asserted, not a hole).
      serving index/nested/content-types/404/traversal(plain+encoded)/private denial
      (anon 401, non-owner 403)/public anon 200/HEAD/301/push=republish (new commit changes bytes).
- [x] 3. Full suite: 400 tests, 399 pass. The 1 failure (runcmd SIGTERM-grace 1000ms timing) proven a load flake, not fallout: runcmd code byte-identical base↔main tree, untouched by this diff, and passes 5/5 on re-run in this worktree once the suite finished.
- [x] 4. Exposure — DECIDED + DOCUMENTED, staged for activation: canonical https://kiln.pocketnova.app/papers/<repo>/ via an origin prefix route in kiln-workspace serve-original (/papers/<repo>/ → daemon /pages/auro/<repo>/). Not edited from this lane: that tree is owned by the app lanes tonight and the daemon route is inactive until merge+boot, so any wiring shipped now would front a 404. Exact rule is in PAGES.md status. Daemon-side serving proven end-to-end over real HTTP by the test matrix.
      /pages proxy) — daemon route itself activates only at next Doctor boot after merge;
      label exactly. Local live proof against a worktree-run daemon instance instead.
- [x] 5. Paper — designation STAGED for activation (live daemon predates the setting; its details response has no pages field, a PATCH would be silently dropped). One-command runbook step recorded in PAGES.md. Footer canonical-URL PR: NOT done, correctly — the KILN URL does not serve yet; Cloudflare Pages copy stays the serving copy of record.
      allows (details PATCH is pre-round? details+visibility shipped earlier, but `pages`
      field needs the merged code → likely STAGED for activation; say which).
- [x] 6. Mobile gate — DONE with scripted Chromium evidence: baseline 670px wide at 375 (two stacked floors: .ev nowrap 638px + .cite/pre min-content 623px). Fix shipped as forge PR #5 (merged) + Pages mirror redeployed (cdc4aed5, live bytes hash-identical to the fixed file): docW 375, zero overflow, tables fit at 319 by wrapping, BibTeX pre scrolls internally (253/555), TOC is a 41px one-row scroll strip (a sticky variant was tested and does NOT engage in this layout — static strip shipped honestly; desktop sticky rail untouched, 1280 re-measured).
      + redeploy Pages mirror (deploy-pages.py in the paper repo).
- [x] 7. PAGES.md status — written (real vs staged vs remaining).
- House rules: never restart the swarm daemon; kiln-original restart allowed if disclosed;
  local commits only; serialize heavy steps (host load 25-42).
