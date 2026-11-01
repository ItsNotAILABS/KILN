# KILN Pages — audit and build order

The architect's ask (2026-10-31): KILN should be able to *push pages
like GitHub Pages* — point at a repo and have a site served from it.
This document is the audit of what exists today, the honest gap list,
and the smallest build order that closes it. (Discovery listing —
capabilities + OpenAPI — was fixed ahead of this document in the
2026-10-31 discovery round; everything below is the remaining work.)

## What "GitHub Pages" means, decomposed

1. A repo (or a branch/folder in it) is designated the site's source.
2. Its static files are served over HTTP at a stable public URL.
3. Republishing is automatic: push to the source, the site updates.
4. Optionally: a build step (Jekyll etc.) and custom domains.

## What exists today

**Sites (lib/sites.mjs, docs/SITES.md)** — a registry of *product
linkages*: a site = frontend repo + backend repo + optional published
artifact slug + optional compute app. Create writes the linkage into
both repos' KILN Memory; status aggregates both repos' HEADs, the
compute app's live status/readiness, and memory-linkage verification.
Full CRUD over `POST/GET/DELETE /v1/sites[/:id]` and the CLI
(`swarm.mjs sites …`). This is an *index of an app-shaped site* — it
serves no content itself.

**Compute apps (lib/compute.mjs)** — a repo can be *run*: deployApp
clones the repo onto a worker and supervises a long-lived process on
a port, surviving daemon restarts. Dynamic backends are covered.

**Public preview (lib/preview.mjs)** — the public-exposure path:
per-app public URLs via a relay the architect controls (ssh reverse
tunnels to a VPS or his laptop; Caddy terminates TLS). `public: true`
on deploy, or POST/DELETE `/v1/compute/apps/:id/preview`. This is the
trust boundary any public serving must ride: the daemon itself binds
127.0.0.1 only and has no inbound path.

**Repo file reads** — git clone/fetch (principal-gated; public repos
anonymous) and the forge contents API (`GET …/contents`, `?raw=1`).
Files are *readable* — but nothing *serves* them as a website: no
content-type mapping for browsing, no index resolution, no URL space
for a site.

## The gaps (why there is no Pages yet)

1. **No static serving.** Nothing maps a repo ref + path to HTTP
   responses a browser can render as a site (index.html resolution,
   text/html + asset content types, directory redirects). This is
   the core missing piece; it is a server feature, not a registry one.
2. **No publish/source designation.** A repo has no "pages" setting
   (enabled? which branch? which folder?). Repo details
   (lib/repodetails.mjs, kiln.json) is the natural home and already
   carries owner-editable fields (description/topics/visibility).
3. **The site record doesn't fit a static site.** createSite REQUIRES
   both a frontend and a backend repo. A Pages site is one repo of
   static files — it cannot be expressed without a dummy backend.
4. **No push → republish wiring.** CI already enqueues on push
   (lib/ci.mjs), but nothing connects a push to a site's source
   branch with the act of publishing. (Serving *live from the ref*
   makes this gap evaporate for raw static — see build order step 3.)
5. **Sites are operator-only.** The scope guard keeps /v1/sites off
   every account/agent surface. GitHub Pages is a repo-owner feature;
   owners cannot manage sites in their own namespace today.
6. **No URL scheme for served sites.** Compute previews have slugs on
   the relay; static sites need their own rule (e.g. a slug per repo,
   or owner/repo paths under one relay host) + the relay admin mapping
   to go with it.
7. **No build step.** GitHub builds Jekyll by default. KILN has the
   machinery to build later (compute jobs) but no static-build
   pipeline; raw-static-first is the honest v1.

## Smallest honest build order

1. **Pages setting on the repo** — extend repo details with
   `pages: { enabled, branch, path }` (PATCH /v1/repos/:o/:r/details,
   owner/operator, same validation discipline as visibility). No new
   store; kiln.json already persists per-repo owner choices.
2. **Static file server in the daemon** — `GET /pages/:owner/:repo/*`
   serving blobs from the designated ref+path: index.html at
   directory paths, an extension → content-type table, HEAD/GET only,
   byte ranges unnecessary for v1. Auth follows the repo's existing
   rule exactly: public repo → anyone; private → accounts in the
   owner namespace + operator (reuse repoVisibility; do not invent a
   second policy).
3. **Serve live from the ref** — no publish artifacts, no build
   queue: a push to the source branch *is* the republish (the next
   request reads the new tip). This deletes gap 4 for v1 and matches
   how siteStatus already reads HEADs live. State it plainly in the
   UI/docs: there is no staging.
4. **Fit the site record** — allow a site with only a frontend repo
   (backend optional) when that repo has pages enabled; siteStatus
   reports the pages source + served tip sha. Keep two-repo sites
   byte-identical.
5. **Public exposure** — register the pages route with the preview
   relay under a per-repo slug, same as compute app previews; the
   relay stays the only public door.
6. **Owner access** — widen the scope guard so account/agent
   principals manage pages settings (+ their own sites) inside their
   namespace, forge-scoped for agents, mirroring the details PATCH
   rule.
7. **Later, separately:** a build step (a compute job that renders a
   source branch into a `gh-pages`-style branch the server then
   serves), custom domains (relay/Caddy-level), and MCP/CLI parity
   for the pages routes.

Steps 1–3 are the irreducible core: one details field, one route,
one policy reuse. Everything after is wiring that already has a
pattern to copy (preview relay, scope guard, sites status).
