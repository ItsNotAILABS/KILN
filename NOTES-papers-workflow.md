# NOTES — KILN Papers workflow v1 (branch kiln-papers-workflow)

Architect's order (2026-11-01): make the workflow for any user, a user's
agent, or a first-class agent to make papers and release them with
persistent identifiers (concept + per-version) — KILN as its own
Zenodo/arXiv, on live KILN Pages + forge releases.

Base: feat/l1-compute @ 5dfbc9e. Worktree: ~/workspace/.worktrees/kiln-papers-workflow.
House rules: never touch the running daemon; no hand-written daemon
stores; suite is the proof; commit after each stage.

## Design decisions (from the brief + codebase patterns)

- Manifest: `paper.json` at repo ROOT, read at the DEFAULT BRANCH tip
  for designation, at the RELEASE COMMIT for the snapshot.
- Validator lives in its own zero-import module `lib/papermanifest.mjs`
  (used by repodetails for designation + papers.mjs for release) —
  avoids a repodetails↔papers import cycle.
- Designation: `paper: {enabled}` in kiln.json via the details PATCH,
  exactly the pages pattern (metaPaper/validPaper in repodetails.mjs;
  malformed stored value reads disabled). Enabling REQUIRES a valid
  paper.json at HEAD; disabling never does.
- Registry: `<stateDir>/papers.json`, forge.json-style load/save.
  Records keyed "owner/slug". Versions append-only (immutability is
  structural: no mutation path exists). Repo DELETE drops the records
  (forgetPaperRecords, beside forgetRepo in the DELETE route).
- Release hook in the POST releases route: if designated, validate the
  manifest at the would-be release commit BEFORE createRelease
  (invalid → 400, no release, no version); after creation, snapshot.
  Only API-created releases register versions (a bare pushed tag is
  not a paper release). Forge release deletion does NOT retract a
  paper version (v1 has no retraction).
- IDs: concept `kiln:<owner>/<slug>`, version `kiln:<owner>/<slug>.v<n>`
  (n sequential from 1, tag recorded alongside). Resolver base
  https://kiln.pocketnova.app/doi/<owner>/<slug>[/v/<n>].
- Visibility: read LIVE from repoVisibility at request time, never
  copied into the registry — flipping a repo private hides its records
  in the same instant. List filters per principal (operator: all;
  account/agent: own + public; anonymous: public only).
- Resolver GET /doi/:owner/:slug[/v/:n] → 302 to /pages/<o>/<s>/
  (pages-designated) else the /v1/papers record URL. Same visibility
  law as reads.
- `doi: null` on concept AND version records. NEVER a fake DOI.
- Citations generated at snapshot time from manifest + IDs + date:
  text + BibTeX (exact formats in the spec).
- Record #1 license call: the paper states NO license anywhere
  (paper.md, README, site checked). paper.json for record zero uses
  "All rights reserved" — the copyright default for an unlicensed
  work — FLAGGED for the architect; one-word edit to change.

## Stages

- [x] 0 — NOTES + spec (swarm/docs/PAPERS-WORKFLOW.md) — `2169b2c`
- [x] 1 — lib/papermanifest.mjs + repodetails paper designation — `d9643cb`
- [x] 2 — lib/papers.mjs + httpapi wiring (routes, hook, guards) — `a7b0e3b`
- [x] 3 — OpenAPI + capabilities + drift EXPECTED — `f24b431`
- [x] 4 — swarm/test/papers-workflow.test.mjs + full suite — `d4de721`
- [x] 5 — agent kit SDK + CLI + ephemeral smoke — kit repo `b65f7bc` (branch forge-kit-parity, local only)
- [x] 6 — record #1 ephemeral proof (seeded from the real repo) — below

## Suite

- New matrix: 7/7 (validator units, citation units, full HTTP matrix).
- Full swarm suite on this branch: first run 438 tests / 436 pass /
  2 fail (timing flakes under load — the run overlapped the kit smoke
  work); complete re-run: **438/438 pass, 0 fail**. Baseline was 431.

## Findings that corrected the brief's assumptions

1. **Inline creation templates carry NO arbitrary files.**
   `resolveTemplateFiles` reads files only from SAVED templates; the
   inline spec supports license/licenseText/readme/gitignore/
   templateId only. The kit's submitPaper therefore composes existing
   doors (create → contents commits for paper.md + paper.json →
   designate) instead of relying on template files. Caught by the
   kit smoke's first run (designation 400 "no paper.json found") —
   fixed in the kit, daemon untouched.
2. **The /doi resolver cannot be a capabilities endpoint or an
   OpenAPI operation** — the drift test requires capabilities
   endpoints ⊆ registered routes exactly, and the resolver is a
   browser redirect outside /v1. It is documented in the papers
   ability's title prose + the OpenAPI designation descriptions
   instead. Public /doi exposure rides the kiln-workspace origin
   wiring like /papers/ (noted in the spec).

## Record #1 proof (stage 6, ephemeral daemon seeded from the real repo)

Script: /tmp/papers-record1.mjs — copied
~/.kiln-swarm/git/auro/marketplace-paper.git into an ephemeral state
dir (live repo READ only), booted the branch's API on port 0, ran
PUT paper.json → PATCH designate → POST release {tag:"v1.1"} →
anonymous reads + resolver. Transcript (2026-11-01):

```
· seeded repo carries its live kiln.json: visibility=public
· pages designation carried over: {"enabled":true,"branch":"","path":"site"}
· paper not yet designated
· paper.json committed to the seeded copy (commit 9028b8cfe256)
· paper designated via details PATCH
· forge release v1.1 created (201)
· version ID assigned: kiln:auro/marketplace-paper.v1 (concept kiln:auro/marketplace-paper, n=1)
· no paperError on the release
· concept record readable anonymously (repo is public)
· concept id kiln:auro/marketplace-paper, doi null
· 1 version; pagesUrl /pages/auro/marketplace-paper/
· author Auro / ItsNotAILABS on the record
· version record: id kiln:auro/marketplace-paper.v1, tag v1.1, releasedBy operator
· paper.pdf snapshot sha256 matches the known artifact hash (e8a995ee1c007e90…, 194161 bytes)
· paper.json itself is in the release snapshot
· citation (text): Auro (2026). One Marketplace, Many Universes: Multi-Source Token Admission and a Three-Life Digital Currency for a Consumer Finance Application. KILN Papers, version 1. https://kiln.pocketnova.app/doi/auro/marketplace-paper/v/1
· resolver (anonymous): 302 → /pages/auro/marketplace-paper/
· version resolver (anonymous): 302 → /pages/auro/marketplace-paper/
RECORD #1 PROOF: ALL OK
```

### The record-zero paper.json (apply verbatim at live activation)

The abstract below is paper.md's Abstract paragraph, verbatim.
License "All rights reserved" — the paper states no license (see
the judgment call above; flagged for the architect).

```json
{
  "title": "One Marketplace, Many Universes: Multi-Source Token Admission and a Three-Life Digital Currency for a Consumer Finance Application",
  "authors": [{ "name": "Auro", "affiliation": "ItsNotAILABS" }],
  "abstract": "A consumer finance application's token marketplace is only as honest as its admission rule. This paper reports a production case study from Minutely, a live Solana trading application: the discovery failure that exposed the structural blind spot of single-source listing (a user searching for real, trading tokens the app had never heard of), and the system built in response — a union-of-universes admission pipeline that takes candidates from five independent listing sources (22,289 unique mints), deduplicates by mint with provenance preserved, and admits only tokens passing a quote-based tradability screen (a $10 buy quote through the execution router, price impact ≤ 10%). The result: the spot universe grows from 2,614 to 6,142 tokens, and 3,662 of the newly admitted — two-thirds — are not on the largest single source's verified list at all. From the app's own issuer-verified shelf, the paper shows why the obvious alternatives fail: liquidity and volume floors are blind to request-for-quote (RFQ) instruments and would delist 92% of a universe that demonstrably trades. Two case studies anchor the method's honesty: USOE, a real token with real pools, identified precisely and excluded by construction rather than force-listed; and 111 newly issued tokenized-stock tokens carrying genuine issuer fingerprints yet receiving real \"no route\" verdicts from the spot router — listing is not routing, and neither is faked. The paper then presents the marketplace's second half: a house digital token designed to graduate through three lives — paper-trading unit, ecosystem utility, and (only through explicit gates) a market — with its sizing (10 billion units, 6 decimals, a 35/15/15/25/10 distribution), its denomination doctrine (a printed ledger rate that is never a price), and a naming process that treated the name itself as a safety system, killing twelve candidate names on collision evidence and advancing five finalists — a slate the commissioner has since narrowed to a head-to-head of two, Spar and Tick, with his final pick still pending. An innovation agenda and a full status ledger close the paper: what is live, what is built and queued, and what is still only designed — labeled as such.",
  "license": "All rights reserved",
  "keywords": ["token listing", "market microstructure", "price impact", "tokenized equities", "real-world assets", "consumer finance", "paper trading", "tokenomics", "agent economies", "Solana"],
  "language": "en"
}
```

Live activation (parent coordinates, after merge+boot): PUT this
paper.json to auro/marketplace-paper, PATCH {paper:{enabled:true}},
POST release {tag:"v1.1"} — the registry then assigns
kiln:auro/marketplace-paper.v1 exactly as proven above.

## Record zero facts (from the repo itself)

- Title: "One Marketplace, Many Universes: Multi-Source Token
  Admission and a Three-Life Digital Currency for a Consumer Finance
  Application"
- Author: Auro (affiliation ItsNotAILABS); released as v1.1,
  2026-10-31; keywords from paper.md's Keywords line (10);
  abstract = paper.md's Abstract paragraph, verbatim.
- Repo files at main: README.md, deploy-pages.py, paper.md,
  paper.pdf, site/index.html, site/marketplace-paper.pdf.
