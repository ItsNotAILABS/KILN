# KILN Memory — infinite memory per repo

**Status:** v1 merged to main (`e45c69f`) and live since 2026-10-14 —
library + HTTP API + client SDK + CLI. Phase 1 (FTS5 index sidecar)
built 2026-10-17: see "Phases after v1" below.

## The one-sentence version

Every KILN repo carries its own memory **inside the repo itself**, on an
orphan git ref (`refs/kiln/memory`): an append-only, hash-chained event
log where raw episodes are kept forever, facts are derived with
mandatory provenance and superseded (never deleted) when the world
changes, and recall pages a small, token-budgeted working set back into
an agent's context.

"Infinite" is a storage property, not a context property. Storage is
unbounded; context is finite and budgeted. Every serious memory system
we studied makes exactly this split — the ones that blur it are the
ones that fall over.

## What the research said (and what we took)

| System | Core move | What KILN took |
|---|---|---|
| **Teradata Loom** | Tiered context (ROM / kernel / L1 / L2 / swap) + salience-driven graph memory: entities, edges, FTS5, time decay, token-budget allocation, event-date anchoring | Tiered recall with an explicit budget; salience + recency in ranking; absolute `eventDate` stored at write time so relative phrases never need re-resolving |
| **MemGPT / Letta** | Context window as RAM, external store as disk; agent pages memory via function calls; small always-in-context **core blocks** (labeled, size-capped), searchable recall + archival tiers; sleep-time consolidation | Core blocks per repo (latest wins, history kept); the context-pack builder pages core → facts → episodes under a budget; consolidation is a later, separate pass, never a hot-path rewrite |
| **Zep / Graphiti** | Bi-temporal knowledge graph built from **episodes** (raw inputs kept as provenance); facts are edges with `valid_at` / `invalid_at`; contradictions invalidate, never delete; hybrid semantic + BM25 + graph retrieval | Episodes are the non-lossy ground truth; facts carry validity windows and are invalidated by supersession; `factsAt(t)` answers "what was true on date X"; hybrid retrieval (lexical now, graph expansion now, embeddings later) |
| **Mem0** | Extract salient facts per turn; the 2026 algorithm is **ADD-only** — records accumulate with temporal context instead of being merged away; entity linking boosts ranking; decay at ranking time, not storage time | Append-only writes. Nothing is ever merged, overwritten, or deleted; all "forgetting" is ranking-side (recency/salience), all correction is supersession |
| **A-MEM** | Zettelkasten: atomic notes with keywords/tags, dynamic links between notes, memory evolution | Explicit typed `link` events between memories; one-hop graph expansion in recall. We deliberately did **not** take in-place evolution: old notes are never rewritten — evolution happens through new facts that supersede, so history stays auditable |

And the lesson from KILN's own outage history: any memory system whose
recovery path can strand state is worse than none. So memory is
event-sourced with a pure replay (the `queue.mjs` pattern), hash-chained
(the `receipts.mjs` pattern), and verified by an independent
`verifyMemory` walk — the same forensics-first discipline as the Doctor.

## Architecture

### Where it lives

```
<stateDir>/git/<owner>/<repo>.git
└── refs/kiln/memory            ← the memory lineage (orphan ref)
    └── commit N
        └── events/00000042-mem_….json   ← exactly one event per commit
```

Why in the repo, not beside it:

- **Per-repo by construction.** Scope isn't a column to filter on; it's
  the storage boundary. Repo A's memory cannot leak into repo B's —
  there is no shared table to mis-query. (Tested.)
- **Git is the storage engine.** Content addressing, deduplication,
  packfiles, integrity checking, replication — decades of engineering
  we don't have to redo. Large payloads ride as ordinary blobs.
- **Memory travels with the repo.** Clone/fetch can carry
  `refs/kiln/memory` with a refspec; KILN promotion can carry it to
  GitHub the same way it carries code history.
- **The code lineage stays clean.** The ref is an orphan: memory commits
  never appear in `main`'s history, branches, or blame.

### The event log

Each event is canonical JSON (`lib/canon.mjs`), stored as a blob, named
`events/<seq>-<id>.json`, and committed alone. Every event carries
`prev` = sha256 of the canonical previous event (`GENESIS` for seq 0)
and its own `hash` — a hash chain independent of git, so tampering is
detectable from the events alone. Appends are compare-and-swap on the
ref (`update-ref` with the expected old tip, bounded retry): two
writers can't fork the chain; the loser replays onto the winner's tip.

Five event types:

1. **`episode`** — raw experience: a note, a decision record, a build
   log, a transcript chunk. Fields: `title`, `kind`, `content`,
   `tags[]`, `entities[]`, `eventDate` (when it happened, distinct from
   `ts`, when it was recorded), `source {type, ref}` (a commit sha, a
   receipt id, a job id, a URL), `salience`. Content ≤ 4096 chars is
   inline; larger content (≤ 1 MB) is stored as a git blob and
   referenced by oid + sha256, re-verified on every read.
2. **`fact`** — a derived claim `{subject, predicate, object}` with
   `confidence`, a validity window (`validFrom`), and **mandatory
   `sourceEpisodes[]`** — a fact that can't name the episodes it came
   from is refused at write time. `supersedes[]` invalidates older
   facts atomically in the same event.
3. **`supersede`** — standalone retraction of a fact (with a reason)
   when there is no replacement.
4. **`link`** — a typed edge `{from, to, relation}` between any two
   memory events.
5. **`core`** — sets a labeled core block (`project`, `conventions`, …).
   Latest wins in the derived view; every version stays in the log.

### Derived state = replay

Facts get bi-temporal semantics from the replay: a fact is *current*
from its `validFrom` until a superseding event's `validFrom` (or a
retraction's `ts`) closes the window. `factsAt(state, t)` therefore
answers both "what is true now" and "what did we believe on March 1st"
from the same log, with nothing ever deleted.

### Retrieval

`recall(query)` ranks episodes + currently-valid facts with **Okapi
BM25** (pure JS, no dependencies — the swarm's standing rule), then:

- multiplies by a salience factor and adds a recency term
  (`1 / (1 + ageDays/30)` — decay at ranking time only, per Mem0);
- **expands one hop across `link` events**: a memory linked to a strong
  hit is pulled in with a score bonus and a `via: "link:<relation>:<id>"`
  marker, so every ranking decision is explainable;
- filters by kind, tags, and time window; facts can be queried as of
  any date.

`buildContext({query?, budgetTokens})` assembles the pack an agent
actually receives: **core blocks first (always), then facts, then
episodes**, each item costed at ~4 chars/token, stopping at the budget
and *reporting* `usedTokens` / `overBudget` instead of silently
truncating. An over-budget core is surfaced as a fact about the repo,
not hidden.

### Provenance

Every fact cites its episodes; every episode can cite its origin
(commit, receipt, job). A context pack names the event id and seq of
everything it includes. `verifyMemory` independently walks the ref:
commits must be linear, exactly one event per commit, seq gapless,
hash chain intact, blob sha256s matching. Forgery is detected (tested
with a hand-forged commit appended outside the library).

## Surfaces

- **Library** — `swarm/lib/memory.mjs`:
  `remember`, `assertFact`, `supersedeFact`, `linkMemories`, `setCore`,
  `loadMemory`, `factsAt`, `recall`, `buildContext`, `memoryStats`,
  `verifyMemory`, `readEvents`.
- **HTTP API** (authenticated, under the repo's namespace):
  `POST /git/:o/:r/memory/episodes|facts|supersede|links|core`,
  `GET  /git/:o/:r/memory/core|facts|recall|context|stats`,
  `POST /git/:o/:r/memory/verify`.
- **Client SDK** — `SwarmClient.memoryRemember / memoryFact /
  memorySupersede / memoryLink / memorySetCore / memoryCore /
  memoryFacts / memoryRecall / memoryContext / memoryStats /
  memoryVerify`.
- **CLI** — `swarm.mjs memory remember|fact|supersede|link|core|
  core-get|facts|recall|context|stats|verify --repo <owner>/<repo>`.
  The CLI calls the library directly (same code path as the API), so
  memory works with the daemon down.

## Verification (2026-10-14)

- `test/memory.test.mjs`: 14/14 — episode/fact provenance (including
  refusal of provenance-free facts), blob round-trip for large content,
  atomic supersession + as-of time travel, standalone retraction,
  BM25 ranking, link expansion, core-first budgeted packs with
  over-budget reporting, forgery detection, cross-repo isolation,
  empty-memory state, and a real-daemon API + SDK round-trip with an
  unauthenticated-access refusal.
- Full swarm suite on this branch: **194/194 pass** (the consolidated
  baseline was 180/180; +14 memory tests, zero regressions).
- Dogfooded live the same day: `auro/auro` received the first real
  memory (episode `mem_5223ad701bd0` + a `project` core block) via the
  CLI against the production state dir; `verifyMemory` ok, context
  pack served at 190/600 tokens.

## Honest boundaries (v1)

- **Replay is O(events)** in memory on every read. Fine to ~10⁴–10⁵
  events per repo; the scale phase adds a rebuildable index sidecar
  (SQLite FTS5 under the state dir, derived from the ref, never the
  source of truth) — the Loom/dakai-`loom` pattern.
- **Retrieval is lexical**, not semantic. No embeddings yet: rather
  honest BM25 than fake "AI search". The embedding phase plugs a
  vector column into the same ranking (Loom's persisted-embedding
  pattern) behind the same `recall` API.
- **Events are hash-chained, not node-signed.** When a swarm node
  writes memory, v2 signs the event with the node's ed25519 key,
  receipts-style, so "which agent asserted this" is cryptographic.
- **No automatic extraction yet.** Facts are asserted explicitly by
  agents/humans today. The consolidation phase (Letta sleep-time /
  Mem0 extraction) proposes facts from episodes *as proposals* —
  invisible to recall until ratified — never as silent writes.
- **Git GC is the operator's friend**: the memory ref grows forever by
  design; `git gc` on the bare repo keeps packfiles tight. Storage is
  cheap; lost history is not recoverable.

## Phases after v1

1. **Index sidecar** — ✅ BUILT 2026-10-17 (`lib/memory-index.mjs`).
   SQLite FTS5 per repo at `<state-dir>/memory-index/<owner>__<repo>.sqlite`,
   synced from the ref on every recall (tip-checked: O(1) when fresh,
   incremental upserts when behind, full rebuild on divergence) and
   never written back to the ref. Docs are indexed pre-tokenized with
   the library's own tokenizer, so the candidate universe matches the
   v1 scan exactly; ranking is FTS5 BM25 fused with the same
   salience/recency boosts and 1-hop link expansion. Recall results
   name their engine (`engine: "index" | "scan"`); any sidecar error —
   or `KILN_MEMORY_INDEX=off` — falls back to the replay scan, which
   stays the fallback and the auditor. `memoryStats` reports the
   sidecar's tip/doc count. Equivalence with the scan (hit sets + top
   hits) is pinned by `test/memory-index.test.mjs`.
2. **Signed events** — node-key signatures on writes; `verifyMemory`
   checks signatures for events that carry them.
3. **Embeddings** — optional persisted vectors per event (local model
   first), fused into recall ranking (semantic + BM25 + graph +
   temporal, Mem0-style multi-signal fusion).
4. **Consolidation proposals** — ✅ BUILT 2026-10-17. A consolidation
   pass reads new episodes and *proposes* facts/links/core edits; a
   human or the acting agent ratifies. Proposals are events too
   (`proposal` / `proposal-status` in the same hash chain): the payload
   is validated exactly like a direct write (provenance mandatory), a
   pending proposal is invisible to recall, and ratification
   materializes the real event marked `viaProposal` — idempotently, so
   a crash or retry never double-writes. Library
   (`proposeMemory`/`resolveProposal`), HTTP API
   (`POST /memory/propose`, `GET /memory/proposals`,
   `POST /memory/proposals/resolve`), SDK, and CLI
   (`propose-fact|propose-link|propose-core|proposals|ratify|reject`)
   all shipped; `memoryStats` reports pending/ratified/rejected
   counts. Pinned by `test/memory-proposals.test.mjs`. The proposer
   itself is any agent with read access — the daemon has no LLM and
   invents nothing.
5. **Fetch/promote refspecs** — ✅ BUILT 2026-10-17. `promote` carries
   `refs/kiln/memory` to GitHub in the same run as the branch (skip
   with `memory: false`): the local chain is replayed commit-by-commit
   through the Git Data API — created when the GitHub ref is absent,
   incremental when the remote event ids are a prefix of the local
   chain, up-to-date when they match. Divergence (unknown ids, a
   longer remote, a prefix mismatch, an unparseable remote subject) is
   a loud skip on the receipt (`memory: {status: "diverged"}` +
   warning), never a force. Every replayed blob — event files and
   large-episode content blobs alike — is SHA-asserted against its
   local oid before the ref moves (content-addressed, so the GitHub
   copy verifies byte-for-byte); a failed memory step is recorded on
   the receipt without failing the branch promotion. Node checkouts
   fetch the memory ref too: `gitClone` probes with `ls-remote` and
   only then persists the `+refs/kiln/memory:refs/kiln/memory` refspec
   (an exact refspec for an absent ref makes every later fetch exit
   128). The daemon already serves the ref via git transport.
   Network-free core pinned by `test/promote.test.mjs`
   (`listMemoryCommits` / `planMemoryReplay` + clone gating).
6. **Cross-repo memory** — explicitly linked memories across repos
   (an episode in repo A cited by a fact in repo B), opt-in per link,
   never a merged global store. Per-repo stays the default and the
   boundary.
