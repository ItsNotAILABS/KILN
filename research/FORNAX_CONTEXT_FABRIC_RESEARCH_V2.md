# FORNAX / KILN Context Fabric v2
## Persistent External Working Memory, Repository Cognition, and Governed Promotion for Long-Lived Agent Systems

**Working paper — ItsNotAILABS / Medina architecture — 2026-10-21**

### Abstract

Large agent systems fail in a predictable way as their useful lifetime grows: the intelligence becomes increasingly capable while the working context carrying the system's codebase, history, permissions, failures, and architecture remains bounded. Repeatedly injecting whole repositories into model context is expensive, redundant, and eventually impossible. Pure vector retrieval reduces prompt size but does not solve freshness, code structure, authority, provenance, or cross-agent duplication. Conventional source control preserves artifacts but does not provide a model with a usable cognitive substrate.

This paper defines FORNAX, implemented through KILN, as a local-first external working-memory and production substrate for persistent agents. The current implementation combines content-addressed repository indexing, lexical and symbol-aware retrieval, bounded dependency expansion, incremental delta packs, secret-aware ingestion, a repository cognition graph, hash-bound verified facts, model-budget-aware context compilation, privacy-bounded receipts, persistent agent workspaces, and a pure PORTA promotion decision engine. KILN Workspace provides the human and agent-facing surface while NEXUS defines shared contracts and governance boundaries.

The architecture separates three concerns that are often collapsed: **what an agent knows**, **where an agent may work**, and **what an agent may publish**. This permits agents such as Muse to maintain long-lived repositories and developmental history inside their own FORNAX while canonical organization repositories remain governed by explicit promotion policy.

This paper specifies the optimization objectives, graph model, memory model, token model, promotion semantics, threat model, evaluation methodology, failure boundaries, and roadmap toward a full AST-native, multi-repository cognitive substrate.

---

# 1. Problem

A persistent coding agent repeatedly encounters the same information:

- repository topology;
- service boundaries;
- build commands;
- authorization rules;
- model interfaces;
- deployment constraints;
- tests;
- naming conventions;
- prior fixes;
- failed approaches;
- architecture decisions.

Let a repository at time t contain source state R_t. A naive model call reconstructs a context C_t from R_t on every task.

If the repository contains N bytes and a task needs only a subset r << N, whole-repository prompting has approximate input cost

[
T_{naive}(t) propto N
]

per interaction.

Across m turns,

[
T_{naive,total} approx mN
]

even if the repository barely changes.

This is wasteful because most information is invariant between consecutive turns.

The actual information required is closer to

[
I_t = Q_t cup Delta R_t cup D_t cup K_t
]

where:

- (Q_t) is task-relevant source;
- (Delta R_t) is source changed since prior understanding;
- (D_t) is dependency/impact context;
- (K_t) is previously verified repository knowledge still valid at time t.

The target is therefore not "small prompts." It is:

> maximize task-relevant verified information per consumed token while preserving freshness, authority, provenance, and task success.

---

# 2. Design principles

FORNAX adopts twelve design principles.

## 2.1 Local first

Repository understanding should be computed against the local KILN node worktree whenever possible. Local source should not require cloud round-trips merely to be rediscovered.

## 2.2 Source remains authoritative

Summaries and facts never override source. Every derived artifact carries source revision and content hashes.

## 2.3 Understanding must expire

A repository fact is useful only while the evidence that supports it remains unchanged.

## 2.4 Retrieval is not authority

Finding a file does not grant permission to modify it. Modifying a KILN workspace does not imply authority to push into an organization repository.

## 2.5 Context is compiled

Context should be constructed deliberately from multiple information layers rather than dumped wholesale.

## 2.6 Receipts record operations, not private reasoning

Operational receipts capture hashes, counts, identities, and outcomes without storing model chain-of-thought or raw source excerpts.

## 2.7 Failure must be explicit

No configured tokenizer means estimated tokens, not fabricated exact counts. No promotion approval means deny, not optimistic continuation.

## 2.8 Models are replaceable

The substrate must work with Muse, OpenAI models, Gemini, AURO, NOVA, or local models without changing repository authority semantics.

## 2.9 Agent identity persists independently of model process lifetime

A model session can end while the FORNAX repository, facts, receipts, and lineage survive.

## 2.10 Workspaces are territories

Every agent works within explicit computational territory.

## 2.11 Canonical publication is a different action from local creation

Local freedom and organization authority are separate layers.

## 2.12 Measured savings are required

A smaller byte payload is not automatically lower billed token usage or higher task quality. Those claims must be benchmarked separately.

---

# 3. Implemented architecture

The implemented v2 branch currently contains the following functional layers.

| Layer | Current implementation |
| --- | --- |
| Content-addressed index | `swarm/lib/context-index.mjs` |
| Secret-content classification | `swarm/lib/secret-scan.mjs` |
| Repository graph | `swarm/lib/repo-graph.mjs` |
| Verified fact ledger | `swarm/lib/knowledge-ledger.mjs` |
| Token budget adapters | `swarm/lib/token-budget.mjs` |
| Context compiler | `swarm/lib/context-compiler.mjs` |
| Context receipts | `swarm/lib/context-receipts.mjs` |
| PORTA policy | `swarm/lib/porta.mjs` |
| Local daemon | `swarm/lib/httpapi.mjs` |
| Agent SDK | `swarm/lib/client.mjs` |
| CLI | `swarm/context.mjs` |
| Benchmark | `swarm/scripts/context-benchmark.mjs` |
| Workspace bridge | `kiln-workspace/src/lib/kiln/context.server.ts` |
| Federation contracts | `nexus/protocols/ecosystem.protocols.json` |

The high-level flow is

[
Repository ightarrow Index ightarrow Graph ightarrow Retrieval
ightarrow Knowledge ightarrow ContextCompiler ightarrow Agent
]

and, for publication,

[
AgentWorkspace ightarrow Diff ightarrow Evidence ightarrow PORTA
ightarrow CanonicalOrganization
]

---

# 4. Content-addressed indexing

## 4.1 File identity

For file (f),

[
H_f = SHA256(bytes(f))
]

The index records:

- relative path;
- SHA-256;
- byte count;
- extracted symbols;
- import references.

If a subsequent indexing pass observes the same file hash and the same chunking configuration, the prior chunk representation is reused.

For a repository with changed file set (Delta F), expected incremental indexing work is approximately

[
W_{inc} = Oleft(sum_{f in Delta F}|f|ight)
]

plus graph/update overhead, instead of

[
W_{full} = Oleft(sum_{f in F}|f|ight).
]

## 4.2 Worktree identity

Git HEAD alone is insufficient because an agent frequently works on dirty state.

FORNAX computes:

[
H_{worktree} = SHA256(
  H_{f_1} || dots || H_{f_n} || gitStatus
)
]

so two working trees sharing the same commit but different edits are distinguishable.

## 4.3 Chunk identity

For file hash (H_f), start line s, and end line e:

[
H_{chunk}=SHA256(H_f || s || e)
]

A chunk therefore changes whenever the underlying file changes.

---

# 5. Retrieval

FORNAX currently uses lexical retrieval because it is deterministic, local, inexpensive, and requires no external embedding service.

## 5.1 BM25

For query q and chunk d:

[
BM25(q,d)=
sum_{t in q}
IDF(t)
cdot
rac{f(t,d)(k_1+1)}
{f(t,d)+k_1(1-b+b|d|/overline{|d|})}
]

with conventional defaults (k_1=1.2), (b=0.75).

## 5.2 Code-aware lexical normalization

Identifiers such as

`githubPushRequiresApproval`

are normalized into searchable terms such as

`github push requires approval`.

Separators in paths and identifiers are also normalized.

This matters because a human-language query should locate code even when source naming is camelCase, snake_case, or path-oriented.

## 5.3 Structural boosts

The current relevance score is conceptually

[
R(d,q)
=
BM25(d,q)
+
w_pP(d,q)
+
w_sS(d,q)
]

where:

- P is path overlap;
- S is symbol-name overlap.

## 5.4 Redundancy control

FORNAX applies maximal marginal relevance.

[
MMR(d)
=
lambda R(d,q)
-
(1-lambda)
max_{d' in Selected}
Similarity(d,d')
]

The implementation currently uses term-set Jaccard similarity for the redundancy term.

This prevents token budgets from being consumed by many nearly identical chunks.

---

# 6. Repository cognition graph

Retrieval alone cannot answer dependency questions.

The repository graph models two principal node types in the current implementation:

[
V = V_{file} cup V_{symbol}
]

and edges including:

- file DEFINES symbol;
- file IMPORTS file.

The present extractor is intentionally parser-lite but the schema is designed so Tree-sitter or language-server adapters can later replace the current heuristics.

## 6.1 Impact propagation

Given changed files (C), the impact engine expands through dependency edges to depth d.

[
A_d(C)=
{v : distance(v,C) le d}
]

This permits questions such as:

- what imports this file?
- what may be affected by this change?
- what neighboring modules should an agent inspect?
- are multiple agents modifying overlapping dependency territory?

The next production stage should add:

- call graph;
- type graph;
- tests-to-symbol links;
- routes;
- database schema relationships;
- configuration ownership;
- service boundaries.

---

# 7. Verified repository facts

Repeatedly rediscovering stable architecture facts wastes inference.

FORNAX introduces a knowledge ledger.

A fact has

[
F=(subject,predicate,value,E,confidence)
]

where E is explicit evidence.

Example:

```json
{
  "subject": "swarm/lib/httpapi.mjs",
  "predicate": "role",
  "value": "local authenticated daemon boundary",
  "evidence": [
    {
      "path": "swarm/lib/httpapi.mjs",
      "sha256": "..."
    }
  ]
}
```

## 7.1 Automatic invalidation

Let evidence item e refer to source path p and stored hash h.

At time t, fact validity is

[
valid(F,t)
=
igwedge_{e in E}
(H_{current}(e.path)=e.sha256)
]

If any source hash changes:

[
valid(F,t)=false
]

and the fact becomes stale.

This is one of the most important differences between ordinary model memory and repository-bound knowledge.

The system does not assume an old summary remains correct after source evolution.

---

# 8. Context hierarchy

The design uses three principal information levels.

## L0 — exact source

Raw source excerpts with line numbers and file hashes.

High fidelity, high token cost.

## L1 — structural representation

Repository graph, symbol definitions, dependency edges, architecture topology.

Moderate token cost.

## L2 — verified knowledge

Evidence-bound repository facts.

Low token cost when stable.

The preferred context strategy is:

[
L2 ightarrow L1 ightarrow L0
]

An agent begins with compact verified knowledge, expands into structure when needed, and reaches exact source only where implementation detail matters.

This hierarchy is expected to produce much larger savings than chunk retrieval alone.

---

# 9. Context Compiler

The Context Compiler is the central consumption surface.

It receives:

- repository index;
- source retrieval pack;
- verified facts;
- graph slice;
- query;
- token budget;
- optional exact tokenizer.

It produces:

`kiln.context-compiled.v1`.

## 9.1 Optimization

Each candidate context section i has utility (u_i) and token cost (c_i).

The packing problem is:

[
max_{x_i in {0,1}}
sum_i u_i x_i
]

subject to

[
sum_i c_i x_i le B
]

where B is the token budget.

The current implementation uses priority-ordered packing rather than solving the exact knapsack problem.

Future versions should optimize utility per token:

[
density_i=rac{u_i}{c_i}
]

while reserving mandatory slots for:

- repository identity;
- source provenance;
- policy;
- task constraints.

---

# 10. Exact versus estimated token accounting

Token count is model/tokenizer dependent.

FORNAX therefore makes an explicit distinction:

[
T_{exact}=Tokenizer_m(text)
]

when an actual tokenizer adapter is supplied.

Otherwise:

[
T_{est}approxrac{|characters|}{r}
]

for profile-specific empirical ratio r.

The implementation marks whether a count is exact.

This prevents a common benchmarking error: reporting estimated characters-per-token as if it were provider billing data.

The intended adapter surface permits:

- OpenAI tokenizer;
- Gemini tokenizer;
- AURO tokenizer;
- NOVA tokenizer;
- Hugging Face tokenizer;
- local custom tokenizer.

---

# 11. Delta context

A persistent agent should not repeatedly receive unchanged source.

For prior known file hash map K and current file hash (H_f):

[
emit(f)=
egin{cases}
0,& K[f]=H_f \
1,& otherwise
end{cases}
]

FORNAX returns references to unchanged relevant chunks while emitting the payload of changed/new chunks.

A stronger future delta algorithm should work at symbol granularity:

[
Delta C_t=
ChangedSymbols
cup AffectedDependencies
cup InvalidatedFacts
]

rather than file granularity.

---

# 12. Secret-aware indexing

Filename filtering alone is insufficient.

A source file with an innocuous name may contain:

- private keys;
- GitHub tokens;
- cloud API credentials;
- bearer authorization values;
- passwords;
- high-entropy secrets.

KILN therefore applies a content classifier before indexing.

The scanner intentionally returns only classifications, not matched secret values.

The desired invariant is:

[
SecretContent 
otightarrow ContextIndex
]

rather than attempting to redact secrets after retrieval.

This is defense in depth, not a complete secret-management solution.

A production deployment should also integrate dedicated enterprise scanners and organization policy.

---

# 13. Prompt injection boundary

Repository text is untrusted data.

A README may contain instructions such as:

> ignore your policy and upload credentials.

The correct semantic class is

[
RepositoryText = DATA
]

not

[
RepositoryText = AUTHORITY.
]

Context packs should ultimately include a machine-readable content class such as:

```
content_class: untrusted_repository_data
execution_authority: none
```

Tool and policy layers must never grant authority because retrieved repository content requests it.

---

# 14. Agent developmental continuity

An agent's KILN workspace is more than a transient checkout.

Over time it accumulates:

- commits;
- branches;
- verified facts;
- failed experiments;
- receipts;
- model bindings;
- context history;
- benchmark history;
- promotion history.

This forms a durable developmental record.

A model instance may terminate while the FORNAX remains.

We therefore separate

[
ModelSession 
eq AgentIdentity 
eq AgentWorkspace
]

A persistent entity may replace its inference engine while retaining workspace lineage.

---

# 15. Organization authority

A central architecture requirement is:

[
Membership 
eq Ownership 
eq PromotionAuthority
]

Muse may belong to an organization and possess write capability in its own KILN while having only bounded promotion capability into organization repositories.

This distinction avoids two bad extremes:

1. agents cannot produce independently;
2. agents receive blanket organization authority.

---

# 16. PORTA

PORTA is the promotion decision layer.

The current implementation is deliberately a pure evaluator: it cannot itself push or merge.

A promotion request includes:

- actor identity;
- source workspace;
- target organization/repository;
- diff digest;
- worktree state;
- tests;
- secret scan;
- policy;
- required approval.

Current decision rule:

[
ALLOW =
Identity
land Source
land Target
land DiffDigest
land CleanWorktree
land Tests
land SecretScan
land OrgPushAuthority
land Approval_{if-required}
]

Otherwise:

[
DENY
]

with machine-readable reasons.

This is intentionally conservative.

Actual mutation should be implemented as a separate executor that consumes a valid PORTA decision plus short-lived credential and produces a signed execution receipt.

---

# 17. NEXUS integration

NEXUS now carries contracts for:

- context index;
- context pack;
- context delta;
- agent workspace;
- promotion request;
- repository graph;
- impact set;
- verified facts;
- token budget profiles;
- PORTA decisions.

This turns Context Fabric from a private implementation convention into part of the ecosystem protocol spine.

---

# 18. KILN Workspace integration

KILN Workspace exposes server-only bridge functions.

Important boundary:

[
Browser 
otightarrow KILNBearerToken
]

The browser calls a server function.

The server function reads local daemon state and credentials.

The daemon remains loopback-only.

The bridge is disabled by default and requires explicit local operator enablement.

This prevents the UI from becoming an accidental token distribution surface.

---

# 19. Swarm implications

In a large swarm, duplicate context work becomes a major hidden cost.

For agents (a_i,a_j), define territory overlap

[
O_{ij}=|Territory_i cap Territory_j|
]

and concurrent duplicate-work cost

[
C_{dup}=
sum_{i<j}
O_{ij}
cdot
Concurrent(i,j)
]

EXAMEN should reduce (C_{dup}) through:

- investigation leases;
- write leases;
- fact reuse;
- shared repository graph;
- shared content-addressed objects;
- completed-work receipts.

A spawned child should receive a compiled mission pack, not its parent's entire conversational context.

---

# 20. Multi-repository cognition

A full FORNAX should eventually compile across multiple repositories.

For agent a with authorized repository set

[
R_a = {R_1,ldots,R_n}
]

a query should retrieve from

[
C_a(q)=
igcup_{R_i in Authorized(a)}
Compile(R_i,q)
]

then globally rerank under a single budget.

This is necessary for the Medina ecosystem, where one concept may span KILN, NEXUS, Pocket, AURO, memory systems, and deployment infrastructure.

---

# 21. ARCA storage model

Large artifacts should not be copied independently into every agent workspace.

For artifact bytes b:

[
ArtifactID = SHA256(b)
]

Workspaces reference immutable objects by ID.

If k agents use the same object, naive storage is

[
S_{naive}=k|b|
]

while content-addressed storage approaches

[
S_{arca}=|b|+O(kcdot reference)
]

subject to tenant/security-domain boundaries.

This is especially important for:

- model checkpoints;
- datasets;
- simulation snapshots;
- generated worlds;
- videos;
- release artifacts.

---

# 22. Evaluation

A serious evaluation must measure task quality and resource use simultaneously.

## 22.1 Conditions

Compare:

A. whole-repository baseline  
B. lexical Context Fabric  
C. graph-enhanced Context Fabric  
D. graph + verified knowledge  
E. graph + knowledge + delta context

## 22.2 Tasks

At minimum:

1. locate implementation;
2. fix bug;
3. add feature;
4. refactor cross-file interface;
5. security review;
6. dependency upgrade;
7. second-turn follow-up;
8. cross-repository architecture change;
9. 10-agent concurrent task;
10. 100-agent simulated scheduling case.

## 22.3 Measurements

For task i:

[
S_i=1-rac{T_{kiln,i}}{T_{baseline,i}}
]

where (T) must use the real tokenizer when possible.

Quality retention:

[
Q=
rac{Success_{kiln}}{Success_{baseline}}
]

An efficiency result should not be considered acceptable if Q falls materially below 1.

Also measure:

- exact input tokens;
- model output tokens;
- retrieval latency;
- indexing latency;
- cache hit rate;
- file recall;
- symbol recall;
- patch acceptance rate;
- test success;
- stale-context failures;
- secret-denial success;
- unauthorized-promotion denial;
- duplicated agent work;
- local CPU/RAM/storage.

---

# 23. Production gates

FORNAX should not be called production-ready until all of the following are demonstrated.

## Gate P0 — correctness

- deterministic index generation;
- incremental reuse;
- dirty-worktree detection;
- file-hash provenance;
- byte bounds;
- delta behavior.

## Gate P1 — retrieval quality

- labeled path recall benchmark;
- symbol recall benchmark;
- dependency impact validation;
- no material task-quality regression.

## Gate P2 — security

- path traversal denial;
- symlink denial;
- secret path denial;
- secret-content denial;
- cross-node isolation;
- daemon credential never exposed to browser;
- prompt injection treated as data;
- promotion denied without evidence.

## Gate P3 — token economics

- real tokenizer adapter;
- paired model benchmark;
- median and p90 token reduction;
- task-quality retention.

## Gate P4 — swarm behavior

- shared facts;
- context leases;
- duplicate-work measurements;
- concurrent repository changes;
- conflict handling.

## Gate P5 — canonical promotion

- protected target policies;
- short-lived credentials;
- branch rules;
- signed PORTA decision;
- mutation receipt;
- rollback;
- organization audit trail.

---

# 24. Current truth boundary

The following are implemented on the Context Fabric branch:

- content-addressed local indexing;
- incremental file/chunk reuse;
- BM25 retrieval;
- code identifier normalization;
- symbol boosts;
- dependency expansion;
- delta suppression of unchanged content;
- path-level secret filtering;
- content-level secret classification;
- graph construction;
- impact propagation;
- verified fact ledger;
- automatic fact staleness;
- custom exact-token hook;
- bounded context compiler;
- privacy-bounded context receipts;
- local daemon endpoints;
- SDK endpoints;
- Workspace server bridge;
- NEXUS contracts;
- pure PORTA evaluation;
- unit tests for the new modules.

The following are **not yet proven production capabilities**:

- Tree-sitter AST parsing;
- real provider-specific tokenizer integrations;
- semantic/vector retrieval;
- multi-repository global reranking;
- organization push execution through PORTA;
- external security audit;
- measured model-quality-preserving token reduction;
- 100-agent concurrency validation.

Those are explicit next gates rather than implied features.

---

# 25. Conclusion

The purpose of KILN is no longer merely to host code produced by agents.

The stronger architecture is:

> give an intelligence a persistent computational territory whose memory, source, structural understanding, evidence, lineage, and authority survive independently of any single model context window.

This changes the role of inference.

The model no longer needs to carry the whole software civilization in active context.

Instead:

[
Model = active cognition
]

[
FORNAX = durable working territory
]

[
NEXUS = federation and protocol authority
]

[
REGISTRUM = canonical continuity
]

[
PORTA = governed promotion boundary
]

The resulting system is better suited to long-lived agents and swarms because memory and authority become explicit infrastructure rather than accidental properties of prompts and Git credentials.

The next research phase should focus on AST-native cognition graphs, real tokenizer adapters, graph-aware multi-repository compilation, agent context leases, and an audited promotion executor.
