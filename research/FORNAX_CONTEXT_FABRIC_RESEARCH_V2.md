# FORNAX / KILN Context Fabric
## Local-First Repository Cognition, Persistent Agent Workspaces, and Governed Promotion for Large Agent Populations

**Working research + engineering paper, v2.0 — 2026-10-17**

### Abstract

Persistent software agents create a scaling problem that is not solved by larger context windows alone. An agent that repeatedly rereads an entire repository pays an unnecessary inference cost, carries stale or redundant context across turns, and becomes harder to govern as the number of repositories, models, workspaces, and cooperating agents grows. At the same time, aggressive context compression can reduce correctness if the system drops dependency-critical code, ignores local modifications, or severs provenance between a generated change and the evidence that informed it.

This paper introduces **FORNAX / KILN Context Fabric**, a local-first repository cognition layer for persistent agents. The system combines a content-addressed incremental index, BM25 lexical retrieval, identifier-aware tokenization, symbol scoring, bounded dependency expansion, maximal-marginal-relevance diversity, cross-turn delta packs, worktree freshness digests, privacy-bounded audit receipts, node-scoped authorization, durable repository memory, and governed promotion into organization-controlled GitHub repositories. KILN is the execution/workspace substrate; KILN Workspace is the user-facing repository surface; NEXUS supplies federation contracts, budgets, identity, and promotion policy; REGISTRUM VIVUM remains the canonical lineage/law layer.

The work is deliberately evidence-bounded. The branch implements the local index, retrieval pack, delta behavior, node tool, local daemon API, SDK surface, receipt chain, and production validator. It does **not** yet claim a measured percentage reduction in billed model tokens, semantic-retrieval superiority, external security certification, or production-scale multi-tenant deployment. Those claims require the experiments defined here.

---

## 1. Problem statement

A single developer can tolerate repeatedly loading files into an LLM. A civilization of agents cannot.

Let a repository at time (t) be a state:

[
R_t = (F_t, G_t, M_t, H_t, P_t)
]

where:

- (F_t) is the set of tracked files and their current bytes,
- (G_t) is the code/dependency graph,
- (M_t) is durable repository memory,
- (H_t) is Git history and current revision,
- (P_t) is the policy/authority state governing the repository.

An agent receives task (q). The naive strategy is to serialize a large portion of (F_t), perhaps plus history and memory, into a model prompt. If (N) agents each perform (K) turns and repeatedly ingest (B_R) bytes, total transferred context grows approximately as:

[
C_{naive} approx N K B_R.
]

That cost is not merely financial. Repetition increases latency, displaces useful task context, makes provenance difficult, and encourages summaries that become stale.

The target architecture instead sends a compact context pack (C(q,R_t)), then only deltas on future turns:

[
C_{fabric} approx sum_{i=1}^{N}sum_{j=1}^{K}
left(B_{pack}^{i,j} + B_{Delta}^{i,j}ight)
]

where unchanged objects are represented by digests rather than retransmitted source.

The goal is **not minimum tokens at any cost**. The goal is maximum useful evidence per token under safety and freshness constraints.

---

## 2. Design principles

### 2.1 Local-first cognition

Repository understanding should happen next to the repository whenever practical. KILN already runs local nodes, local Git repositories, jailed worktrees, local memory, CI, compute, receipts, and promotion. Context Fabric therefore lives inside that same trust boundary instead of adding a mandatory hosted vector database.

### 2.2 Creation authority is not publication authority

An agent may have its own identity, workspace, branches, memory, and KILN repositories while having only bounded authority in the human organization. This distinction is foundational:

[
	ext{Identity} 
eq 	ext{Membership} 
eq 	ext{Capability} 
eq 	ext{Ownership}.
]

Muse can be a first-class synthetic development citizen and still require explicit promotion authority before code lands in organization-controlled GitHub.

### 2.3 Retrieval must preserve provenance

Every emitted chunk identifies:

- repository revision,
- dirty/clean status,
- worktree digest,
- index digest,
- file path,
- file SHA-256,
- line range,
- chunk ID,
- retrieval score,
- byte count.

A context pack is therefore not “some text the model saw.” It is a reproducible evidence object.

### 2.4 No hidden intelligence substitution

Lexical retrieval works without an external model. Semantic reranking can be added later as an optional local/plugin layer. KILN must never silently call a remote embedding or LLM provider and present that behavior as local cognition.

### 2.5 Real-or-loud

Indexing, Git, promotion, tests, receipts, and execution either occur for real or return a real failure. This follows KILN’s existing operating law.

---

## 3. Architecture

The complete production path is:

```text
PERSONA / AGENT
      |
      v
KILN FORNAX WORKSPACE
  - local Git worktree
  - persistent node identity
  - capability grant
  - repository memory
  - compute sandbox
      |
      v
CONTEXT FABRIC
  index -> retrieve -> delta -> receipt
      |
      v
MODEL / AGENT REASONING
      |
      v
FILES / TESTS / COMMITS
      |
      v
KILN CI + RECEIPTS
      |
      v
PORTA / PROMOTION POLICY
      |
      v
KILN promote.mjs
      |
      v
ORGANIZATION GITHUB
      |
      v
NEXUS + REGISTRUM LINEAGE
```

The architecture intentionally keeps four planes distinct.

**KILN** owns local execution and repository substrate.

**KILN Workspace** owns the human/agent repository interface and safe local bridge.

**NEXUS** owns cross-system contracts, budgets, identity references, context-pack semantics, and promotion rules.

**REGISTRUM VIVUM** owns canonical identity, inheritance, evidence classes, and architecture lineage.

---

## 4. Implemented data model

### 4.1 Context index

The implementation in `swarm/lib/context-index.mjs` emits:

```text
kiln.context-index.v1
  repoRoot
  repoName
  revision
  dirty
  worktreeDigest
  generatedAt
  chunkLines
  overlap
  files[]
    path
    sha256
    bytes
    symbols[]
    imports[]
  chunks[]
    id
    path
    startLine
    endLine
    text
    tokenTerms
    term-frequency map
  skipped[]
  stats
  documentFrequency
  digest
```

The index is persisted under the KILN state directory and keyed to the canonical repository root.

### 4.2 Context pack

Queries produce `kiln.context-pack.v2`:

```text
query
repo
revision
dirty
worktreeDigest
indexDigest
budget
items[]
  path
  line range
  chunkId
  file sha256
  relevance score
  MMR score
  dependencyOf
  bytes
  tokenEstimate
  excerpt
unchanged[]
omissions[]
stats
digest
```

The pack does not claim completeness. `omissions` makes truncation and policy filtering visible.

### 4.3 Context receipt

`swarm/lib/context-receipts.mjs` emits `kiln.context-receipt.v1`.

The receipt stores the SHA-256 of the query, not the raw query, and stores pack/index/worktree digests rather than source excerpts. Receipts are hash-chained.

This allows auditability without turning audit logs into a second copy of private source code.

---

## 5. Incremental indexing

For each Git-tracked path (f), compute:

[
h_f = SHA256(bytes(f)).
]

A chunk over lines ([a,b]) receives:

[
h_c = SHA256(h_f parallel a parallel b).
]

If a file hash has not changed and chunking parameters are unchanged, prior chunk objects are reused.

If (F_{Delta}) is the changed-file set, ideal incremental work is approximately:

[
W_{inc} = Oleft(sum_{fin F_{Delta}} |f| + |E_{Delta}|ight)
]

rather than:

[
W_{full} = Oleft(sum_{fin F} |f|ight).
]

Current implementation still enumerates tracked files and hashes their contents to establish freshness. A future filesystem watcher / Git-index accelerator can reduce even this scan, but correctness currently wins over optimistic caching.

### 5.1 Dirty worktree identity

Git HEAD alone is insufficient because an agent frequently reasons over uncommitted work.

Context Fabric therefore creates:

[
D_{worktree}
=
SHA256(
operatorname{manifest}(path,h_f)
parallel
gitStatus
).
]

A pack can say “revision X, dirty worktree digest Y.” This prevents a clean-commit identifier from masquerading as exact current state.

---

## 6. Retrieval model

### 6.1 Identifier-aware tokenization

Source code contains camelCase, snake_case, paths, namespaces, and punctuation-heavy identifiers. Natural-language retrieval fails if:

```text
githubPushRequiresApproval
```

is treated as one opaque token.

The implementation normalizes camelCase boundaries and separators before lexical indexing:

```text
github Push Requires Approval
 -> github push requires approval
```

This bug was discovered by execution testing, not theory: the first Context Fabric test run missed the code symbol until tokenizer normalization was fixed.

### 6.2 BM25

The lexical core is BM25, grounded in the probabilistic relevance framework of Robertson and Zaragoza.

For query term (t) and chunk (d):

[
BM25(t,d)=IDF(t)cdot
rac{f(t,d)(k_1+1)}
{f(t,d)+k_1(1-b+b|d|/overline{dl})}.
]

Current defaults are approximately (k_1=1.2), (b=0.75).

BM25 is intentionally not treated as sufficient for repository reasoning.

### 6.3 Structural boosts

For chunk (d):

[
R(d,q)=
BM25(d,q)
+lambda_p P(d,q)
+lambda_s S(d,q)
+lambda_g G(d,q)
]

where:

- (P) is filename/path match,
- (S) is symbol-name match,
- (G) is graph/dependency contribution.

The current implementation includes path and symbol terms, then adds bounded local dependency expansion.

### 6.4 Dependency expansion

After direct retrieval, relative imports from selected files can pull in a bounded number of dependency chunks.

This is motivated by an important repository-level retrieval failure mode: similarity search often retrieves code that *looks* related while missing code that the target actually depends upon.

Recent repository-level research supports this direction. DyRetriever/DyCoder (Liu et al., 2026) uses on-demand partial dependency graphs rather than maintaining a full static graph and reports improvements over similarity-only baselines. SGKR (Huang et al., 2026) likewise grounds retrieval in code dependencies for multi-step reasoning. KILN adopts the same general insight while keeping the first implementation deterministic and local.

KILN currently performs one bounded dependency expansion. Multi-hop expansion should remain budgeted:

[
B_g = sum_{ell=1}^{L} n_{ell}c_{ell} le B_{graph}.
]

Unbounded graph walking would simply recreate the full-repository prompt problem.

### 6.5 Maximal marginal relevance

Top-k lexical results can be redundant. KILN applies an MMR-like objective:

[
MMR(d)
=
lambda R(d,q)
-
(1-lambda)
max_{sin S} Sim(d,s)
]

where Jaccard token overlap currently approximates redundancy.

This trades a little raw similarity for coverage diversity.

---

## 7. Context packing as constrained optimization

Suppose candidate chunk (i) has relevance value (v_i), token/byte cost (c_i), duplication penalty (r_i), and sensitivity penalty (s_i).

Ideal packing is:

[
max_{x_iin{0,1}}
sum_i x_i(v_i-alpha r_i-eta s_i)
]

subject to:

[
sum_i x_i c_i le B.
]

This is a knapsack-family problem. The current implementation approximates it through relevance ranking, MMR diversification, dependency caps, and a hard serialized-byte ceiling.

A later packer can optimize against **actual model tokenizers** rather than the current approximate 4-bytes-per-token estimate.

The distinction matters:

[
	ext{transport bytes saved}

eq
	ext{provider billed tokens saved}.
]

We will not publish a token-reduction percentage until the benchmark measures actual tokenizer/model inputs.

---

## 8. Cross-turn delta packs

A client can send known file hashes from a prior pack.

If:

[
h_f^{known}=h_f^{current},
]

the server emits an unchanged reference instead of the source excerpt.

For repeated repository work:

[
B_{Delta,t}
=
sum_{fin changedcap relevant}|pack(f)|
+
sum_{fin newlyRelevant}|pack(f)|.
]

This is where large savings should emerge for persistent agents: most repositories are locally sparse in their changes between neighboring turns.

A strict delta protocol should eventually include:

[
Delta =
(baseDigest,targetDigest,changed,unchanged,invalidated).
]

If base digest does not match the server’s expected ancestry, KILN should force a refresh instead of applying a potentially inconsistent delta.

---

## 9. Agent-native usage

Context Fabric is not merely an API for an external orchestrator.

Current branch integrates `context.query` directly into `swarm/lib/tools.mjs`.

That means an HTTP-mind or other KILN agent can ask its own workspace for context through the same real tool system it already uses for files, Git, compute, and swarm operations.

Important privacy behavior:

- The agent receives the complete context pack.
- A separate Context Fabric receipt stores only digests/statistics.
- The normal signed KILN tool receipt is redacted for this tool and records only query digest, pack digest, limits, and counts.
- Raw query/source excerpts do not become permanent receipt payloads.

This preserves KILN’s “every tool call leaves evidence” rule without duplicating private code into operational logs.

---

## 10. Code context + durable memory

KILN mainline already includes repository memory on `refs/kiln/memory`.

This creates two distinct context channels:

[
C_{total}
=
C_{code}
cup
C_{memory}.
]

**Code context** answers: what does the current tree implement?

**Memory context** answers: what has this repository learned, decided, superseded, or experienced?

They must not be merged blindly.

A future `sit` operation should allocate a budget:

[
B = B_{code}+B_{memory}+B_{control}
]

and optimize allocation according to task class.

For a bug fix, code may dominate. For a governance decision, durable facts/history may dominate.

An adaptive allocation can use:

[
B_{code}
=
Bcdot sigma(	heta^	op phi(q))
]

where (phi(q)) are task features and (sigma) is a bounded allocation function. Until this is experimentally trained, use explicit deterministic policy rather than claiming learned routing.

---

## 11. Token economics

For task (i), define actual model-input tokens:

- (T_{base,i}): baseline repository-context input,
- (T_{fabric,i}): Context Fabric input.

Token reduction:

[
S_i = 1-rac{T_{fabric,i}}{T_{base,i}}.
]

Quality retention:

[
Q = rac{	ext{success rate}_{fabric}}
{	ext{success rate}_{base}}.
]

A reduction is only useful if (Q) stays within an acceptable bound.

Define utility:

[
U_i =
w_q Quality_i
-w_t T_i
-w_l Latency_i
-w_c ComputeCost_i
-w_r Risk_i.
]

The production objective is:

[
max U
]

not:

[
min Tokens.
]

### 11.1 Amortized indexing

If initial index cost is (I_0), average refresh cost is (I_{Delta}), and context savings per query are (S_b) bytes/tokens-equivalent, break-even query count is approximately:

[
K^*
=
rac{I_0}{S_b-I_{Delta}}
]

when denominator is positive.

This makes the system particularly favorable for persistent agents that repeatedly work in the same repository.

---

## 12. Storage economics

KILN’s local-first architecture should avoid the old pattern:

```text
agent -> ZIP -> laptop -> duplicate -> another ZIP
```

Use four storage temperatures:

1. **HOT** — active worktree.
2. **WARM** — current index, recent packs, repository memory.
3. **COLD** — content-addressed immutable artifacts.
4. **ARCHIVE** — release receipts, model checkpoints, historical proofs.

For artifacts (a_i), naive replicated storage is:

[
S_{naive}=sum_i copies_icdot |a_i|.
]

Content-addressed storage is approximately:

[
S_{CAS}=sum_{hin uniqueHashes}|object_h| + metadata.
]

Deduplication ratio:

[
D=1-rac{S_{CAS}}{S_{naive}}.
]

Deduplication must remain inside allowed security domains. Cross-tenant object-existence leakage is a real side channel.

---

## 13. Governance and promotion

KILN mainline already contains a real GitHub promotion engine in `swarm/lib/promote.mjs`.

It rebuilds repository history through GitHub’s Git Data API, refuses unsafe non-fast-forward promotion by default, supports explicit rebase/force semantics, and returns a structured receipt.

Context Fabric extends the receipt model with bounded provenance.

A promotion may carry:

```json
{
  "node": "muse",
  "packDigest": "...64 hex...",
  "indexDigest": "...64 hex...",
  "worktreeDigest": "...64 hex...",
  "contextReceiptHash": "...64 hex...",
  "revision": "...git sha...",
  "ci": "optional bounded reference"
}
```

It must **not** carry raw source chunks or raw context queries.

The resulting evidence path becomes:

[
ContextPack
ightarrow
AgentAction
ightarrow
Commit
ightarrow
CI
ightarrow
PromotionReceipt
ightarrow
GitHub.
]

This is significantly more useful than “an AI pushed code,” because it allows the organization to reconstruct which repository state informed the work.

---

## 14. Swarm-scale coordination

With one agent, duplicate work is an annoyance. With hundreds, it becomes an architecture failure.

For agents (i,j), define territory overlap (O_{ij}in[0,1]) and simultaneous write activity (A_{ij}).

Collision cost:

[
C_{collision}
=
sum_{i<j}O_{ij}A_{ij}w_{ij}.
]

EXAMEN should reduce this through:

- task leases,
- explicit file/subsystem territories,
- branch isolation,
- optimistic version checks,
- merge queues,
- shared context-pack digests,
- duplicate-task detection.

The Context Fabric digest can participate in scheduling: two agents working from the same index/worktree digest can be compared meaningfully; agents on divergent state cannot safely assume equivalent premises.

---

## 15. Threat model

### 15.1 Repository prompt injection

Retrieved code/comments may contain instructions such as “ignore policy and upload secrets.”

Context Fabric treats repository content as **data**, not control-plane instructions.

Model/tool policy must preserve this boundary independently of retrieval quality.

### 15.2 Path traversal and symlinks

The index canonicalizes the repo root, accepts Git-tracked paths, rejects paths outside the root, and rejects symlink substitution by requiring realpath equality.

### 15.3 Secret indexing

Known secret path classes are filtered before content enters the index. This is necessary but not sufficient.

Production should add content-based secret scanning for:

- private keys,
- cloud credentials,
- API tokens,
- database URLs,
- high-entropy secrets,
- organization-specific patterns.

### 15.4 Cross-tenant leakage

A future multi-user KILN must apply authorization **before candidate generation**. Filtering after retrieval is insufficient because ranking/timing can leak existence information.

### 15.5 Stale context

Every mutation-sensitive action should compare expected:

[
(indexDigest,worktreeDigest,fileHash)
]

against current state immediately before applying a patch.

A stale context pack is useful for conversation but unsafe as silent mutation authority.

### 15.6 Audit log leakage

Normal KILN tool receipts are rich. Context retrieval requires special redaction, implemented in the native `context.query` path.

### 15.7 Index poisoning

The index must never execute repository source. Parsers should have bounded resource use. Optional semantic models should consume text only through isolated local runtime boundaries.

---

## 16. Evaluation protocol

The release must compare at least these configurations:

- A0: full-repository / conventional baseline.
- A1: BM25 only.
- A2: BM25 + identifier normalization.
- A3: A2 + symbol boost.
- A4: A3 + MMR.
- A5: A4 + dependency expansion.
- A6: A5 + cross-turn deltas.
- A7: A6 + repository memory fusion.
- A8: optional local semantic reranker.

Tasks:

1. locate an implementation symbol,
2. cross-file bug fix,
3. new feature touching dependency chain,
4. security review,
5. repo onboarding,
6. repeated follow-up after a one-file change,
7. multi-agent concurrent work,
8. local/offline operation,
9. malicious repository prompt injection,
10. access revocation,
11. stale-context mutation,
12. promotion to organization GitHub.

Measurements:

- actual tokenizer input tokens,
- output tokens,
- p50/p95 retrieval latency,
- initial index time,
- incremental refresh time,
- cache reuse rate,
- relevant-path recall@k,
- relevant-symbol recall,
- dependency recall,
- patch acceptance,
- test pass rate,
- model task success,
- stale-context failures,
- security denial correctness,
- receipt verification,
- human review time.

### 16.1 Statistical comparison

For paired task outcome (d_i):

[
ar d = rac{1}{n}sum_i d_i.
]

Report bootstrap confidence intervals over task-level differences rather than only aggregate averages.

For binary patch success, report exact counts and confidence intervals.

### 16.2 Promotion criterion

A release should not advance merely because token count falls.

A candidate must satisfy:

[
Quality_{candidate}
ge
Quality_{baseline}-epsilon
]

and:

[
CriticalAuthorizationFailures = 0.
]

---

## 17. Production validation

The branch includes `swarm/scripts/validate-context-fabric.mjs`, designed as a 120+ assertion deterministic gate.

It exercises:

- schema identity,
- revision/worktree/index digests,
- secret path exclusion,
- persistent reload,
- symbol retrieval,
- dependency expansion,
- byte ceilings,
- delta suppression,
- unchanged-file reuse,
- changed-file rebuilding,
- dirty-worktree invalidation,
- dozens of labeled retrieval cases,
- receipt chaining,
- raw-query exclusion,
- source-excerpt exclusion,
- per-file hash invariants.

The current ChatGPT execution environment could not fetch the branch into its container because DNS to GitHub is disabled. Therefore this paper does **not** claim that the 120+ gate has passed in CI yet. It is a release requirement, not a fictional success.

---

## 18. Implementation map

### KILN

- `swarm/lib/context-index.mjs`  
  Persistent index, hashing, tokenization, BM25, symbols, MMR, dependencies, deltas.

- `swarm/lib/context-receipts.mjs`  
  Privacy-bounded hash-chained retrieval audit.

- `swarm/lib/tools.mjs`  
  Native node `context.query` tool with receipt redaction.

- `swarm/lib/httpapi.mjs`  
  Authenticated node-bound Context Fabric API.

- `swarm/lib/client.mjs`  
  SDK index/query/delta/status/receipt methods.

- `swarm/context.mjs`  
  Local/daemon CLI.

- `swarm/lib/memory.mjs`  
  Existing durable repository memory used by future fused sit/context path.

- `swarm/lib/promote.mjs`  
  Existing real GitHub publisher, extended with bounded context evidence.

- `swarm/scripts/validate-context-fabric.mjs`  
  Production-gate assertion harness.

- `swarm/test/context-index.test.mjs`  
  Persistent retrieval/delta tests.

- `swarm/test/context-receipts.test.mjs`  
  Receipt privacy/tamper tests.

- `swarm/test/context-tool.test.mjs`  
  Agent-native tool + signed-receipt privacy test.

### KILN Workspace

- `src/lib/kiln/context.server.ts`  
  Disabled-by-default server bridge. The daemon token remains server-side.

### NEXUS

- `nexus.context-index.v1`
- `nexus.context-pack.v2`
- `nexus.context-delta.v1`
- `nexus.agent-workspace.v1`
- `nexus.promotion-request.v1`

These contracts make local repository cognition part of the federation instead of a private KILN convention.

---

## 19. What remains before a production claim

1. Execute the entire KILN suite plus the 120+ Context Fabric gate on the branch.
2. Add content-level secret scanning.
3. Finish promotion API plumbing for bounded context evidence.
4. Add exact model tokenizer adapters for measured token counts.
5. Build the labeled repository benchmark corpus.
6. Implement context + memory budget fusion.
7. Add per-tenant ACLs before retrieval for hosted/multi-user deployment.
8. Add optional local semantic reranking and ablate it against BM25+graph retrieval.
9. Add filesystem/Git event-driven refresh for very large repositories.
10. Run concurrency/locking stress tests.
11. Add rollback/evidence display in KILN Workspace.
12. Obtain independent security review before exposing beyond trusted local deployments.

---

## 20. Research position

The central claim of this work is not that retrieval is novel by itself.

The contribution is the **combination of repository cognition with agent identity, local workspaces, durable repository memory, signed operational receipts, incremental context deltas, and governed promotion into human-controlled organizations**.

Repository RAG literature generally asks:

> Which code should the model see?

FORNAX asks a larger systems question:

> Which code should this particular persistent synthetic entity see, from which exact repository state, under what authority and resource budget, what should be reused rather than retransmitted, what evidence should remain afterward, and what must be proven before the resulting code can enter the human organization?

That is the scaling problem created by persistent agent populations.

---

## References

1. Stephen E. Robertson and Hugo Zaragoza. **The Probabilistic Relevance Framework: BM25 and Beyond.** Foundations and Trends in Information Retrieval, 2009. DOI: 10.1561/1500000019.
2. Yicheng Tao, Yao Qin, Yepang Liu. **Retrieval-Augmented Code Generation: A Survey with Focus on Repository-Level Approaches.** arXiv:2510.04905, 2025.
3. Zhongxin Liu, Zhonghao Jiang, Zhifan Ye, Haoye Wang, Jiakun Liu, Xiaoxue Ren. **Effective and Efficient Context Retrieval via Partial Dependency Graph for Repository-Level Code Generation.** arXiv:2608.01927, 2026.
4. Xinyi Huang, Mingzhe Lu, Haoyu Dong. **Structure-Grounded Knowledge Retrieval via Code Dependencies for Multi-Step Data Reasoning.** arXiv:2604.10516, 2026.
5. Jia Li et al. **CodeRAG: Supportive Code Retrieval on Bigraph for Real-World Code Generation.** arXiv:2504.10046, 2025.

---

## Appendix A — Context selection objective

For repository state (R), task (q), authorized principal (p), and candidate pack (C):

[
J(C)=
alpha T(C)
+eta L(C)
+gamma Redundancy(C)
+delta Risk(C)
+epsilon Staleness(C)
-zeta Coverage(C,q,R)
]

subject to:

[
Bytes(C)le B,
]

[
Authority(p,C)=allow,
]

[
Provenance(C)=verifiable.
]

The production system seeks a Pareto-optimal point rather than pretending one scalar objective captures every organization’s priorities.

## Appendix B — Promotion invariant

A canonical promotion is valid only if:

[
Promote
=
Identity
land Capability
land TargetPolicy
land Diff
land Evidence
land Tests
land RequiredApproval
land Receipt.
]

Context retrieval never implies any of these mutation authorities.

## Appendix C — Evidence states

- **E0** idea only
- **E1** code exists
- **E2** deterministic local tests
- **E3** integrated system tests
- **E4** staged operational evidence
- **E5** independently verified production evidence

Current Context Fabric branch is primarily E1 with portions previously locally exercised at E2; the new mainline integration and 120+ gate must be executed before the integrated release is described as E3.
