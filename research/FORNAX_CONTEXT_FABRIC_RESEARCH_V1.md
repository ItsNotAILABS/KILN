# KILN / FORNAX: A Local-First Context Fabric for Persistent Agent Civilizations
## Research and engineering paper — working edition 2026-10-17

**Status:** architecture and implementation research. Source-observed: KILN swarm local HTTP, Git hosting, agent capabilities, receipts; KILN Workspace GitHub import; NEXUS context-pack and budget protocols. Experimental algorithms below are not production-certified.

### Abstract
Long-lived synthetic workers waste inference budget when they repeatedly consume whole repository trees, obsolete summaries and redundant artifacts. We propose a local-first, content-addressed context fabric that combines exact code retrieval, lexical search, optional semantic retrieval, dependency-aware expansion, durable provenance, and bounded promotion. Agent-owned FORNAX workspaces remain distinct from organizational authority. NEXUS coordinates identity, budgets and handoffs; REGISTRUM VIVUM supplies law and lineage; PORTA mediates promotion to GitHub. We define objectives, threat models, retrieval algorithms, cache invalidation, measurement protocols, rollout gates and failure modes.

## 1. System boundary and claims
KILN is the authoritative local execution and repository substrate for an agent's assigned territory, not automatically the authority for organization-wide promotion. KILN Workspace is the human/agent UX and import surface. NEXUS is the federation contract and policy plane. REGISTRUM is the canonical registry and inheritance plane. ARCA is content-addressed artifact storage. GENEALOGIA tracks ancestry. TESTIS validates evidence. The GitHub organization remains an explicitly permissioned publication destination. A local working tree may be dirty; Git HEAD is not a content freshness proof. Each context slice must carry per-file hashes and a worktree fingerprint.

## 2. Formal optimization objective
For request q, repository state R, authorized principal p and retrieved pack C, minimize:
J(C) = alpha*T_in(C) + beta*L(C) + gamma*D(C) + delta*Risk(C) + epsilon*Stale(C)
subject to Coverage(C,q,R) >= tau, Bytes(C) <= B, Authority(p,C)=allow, and Provenance(C)=verifiable.
T_in is actual model-input tokens, not character count. L is retrieval latency. D is duplicated information; Risk measures sensitive content exposure; Stale penalizes outdated hashes. The optimization is multi-objective: lower token use must not degrade task success or increase hallucination.

Token saving per task i: S_i = 1 - T_fabric,i / T_baseline,i. Report median, p90 and task-weighted aggregate; negative S_i indicates regression. Quality retention Q = Success_fabric / Success_baseline. Effective cost = token_price * tokens + local_compute + storage + synchronization + retrieval latency cost. Do not advertise a fixed percentage before controlled experiments.

## 3. Snapshot and indexing algorithm
A snapshot contains repo ID, tenant ID, owner principal, branch, HEAD, tracked paths, worktree file hashes, parser version, tokenizer version, indexing configuration, and manifest hash. Use git ls-files -z for tracked paths; reject symlinks and paths outside the canonical root. Filter .env, key files, credentials and other secret classes BEFORE indexing. Store a file as chunks keyed by SHA256(file bytes || parser version || chunk coordinates). Cache retrieval features by content hash. If file hash unchanged, reuse chunks and index entries; if changed, rebuild only that file and dependency edges. Rename detection may reuse content hashes while preserving new path identities.

Incremental work: W_incremental approximately O(sum bytes of changed files + affected dependency edges), versus O(total repository bytes) for full scan. This is an engineering target, not an observed runtime guarantee.

## 4. Multi-stage retrieval
Stage A: enforce tenant, principal, repo and path ACL before any candidate generation. Stage B: lexical BM25 over filenames, symbols, headings and chunk content. Stage C: exact symbol resolution from tree-sitter/LSP/ctags if available. Stage D: optional local embedding ANN retrieval, never mandatory and never a hidden cloud fallback. Stage E: dependency-aware expansion to imports, call sites, tests and interfaces. Stage F: rerank by relevance, recency, authority, evidence quality and diversity. Stage G: knapsack-like packing under token and byte budgets.

BM25(q,d) = sum over terms t of IDF(t) * f(t,d)*(k1+1)/(f(t,d)+k1*(1-b+b*|d|/avgdl)).
Combined rank = w_b*norm(BM25) + w_s*semantic + w_g*dependency + w_f*freshness + w_e*evidence - w_d*duplication - w_r*sensitivity.
Weights are learned or tuned against labeled tasks, never called trained weights without checkpoint and experiment evidence.

## 5. Context packing
Represent each candidate chunk i with value v_i, token cost c_i and duplicate penalty d_i. Choose x_i in {0,1} maximizing sum x_i*(v_i-d_i) subject to sum x_i*c_i <= B. A practical greedy approximation sorts by marginal utility per token and applies maximal marginal relevance. Always include a compact repository map and precise provenance. When uncertainty remains, return missing-context flags rather than silently inventing completeness.

## 6. Cross-turn delta protocol
The client supplies known pack digest, known file hashes and last accepted revision. Server returns unchanged references plus changed chunks, deletions and invalidations. The model may still need a reminder summary depending on provider caching and conversation context. Distinguish bytes saved on the transport from billed model tokens actually avoided. Delta packs should carry base_digest and target_digest, with mismatch forcing a full refresh. Prevent stale-context execution by comparing expected file hashes immediately before mutation.

## 7. Agent identity and authority
PERSONA SYNTHETICA identifies agent principal and key; COLLEGIUM defines organization membership; DOMINIUM identifies owned work territories. Membership does not imply repository write authority. Every push must be gated by PORTA: authenticated principal, exact target repository and branch, explicit capability, diff digest, tests, secret scan, dependency/license scan, protected-branch rules, human approval where required, and signed receipt. Use short-lived, scoped credentials. No GitHub token should be passed to a browser or model context.

## 8. Local device and sync
KILN node is bound to loopback. A local workstation uses its own worktree; KILN may index a read-only mirror or a jailed assigned worktree. Sync states: UNLINKED -> IMPORTED -> TRACKING -> DIRTY -> RECONCILING -> READY_TO_PROMOTE -> PROMOTED, with CONFLICT and QUARANTINED branches. A repository imported from GitHub is not automatically two-way synchronized. Resolve conflicts through explicit merge proposals, not silent force-push. Never promote dirty unreviewed state as if it matched a clean commit.

## 9. Durable memory and archival economics
Use a tiered system: HOT working files, WARM index and recent history, COLD content-addressed objects, ARCHIVE immutable releases. Deduplicate by hash within the same security domain; cross-tenant deduplication must not leak object existence. Keep retention policies, legal holds and deletion propagation explicit. Storage savings = 1 - unique physical bytes / naive replicated bytes. A model checkpoint should be referenced by immutable digest, not copied into every agent's workspace.

## 10. Swarm scheduling and contention
EXAMEN assigns tasks with ownership leases and budgets. Minimize collision cost:
C = sum_{i<j} overlap(territory_i,territory_j)*concurrency(i,j).
Use exclusive write leases for critical files, optimistic version checks for independent branches, and merge queues for promotion. Task decomposition should respect dependency DAGs; cancellation and retries must be idempotent. Never grant broad execution rights solely because a task was delegated.

## 11. Security and threat model
Threats: prompt injection from repository files, malicious package scripts, symlink traversal, cross-tenant search leakage, stale hashes, leaked credentials, unauthorized promotion, retrieval of secrets, model exfiltration, replayed approvals, index poisoning and compromised local daemon. Defenses: strict ACL before retrieval, canonical path containment, no tool instructions from retrieved text, content type filters, secret scanner, bounded output, scoped identities, replay-resistant receipts, signed approvals, sandboxed build steps, safe git arguments, no shell interpolation, no arbitrary execution in retrieval path, audit logs and emergency revocation. The initial context-fabric v1 prototype does not implement all of these and must remain experimental.

## 12. Experimental evaluation
Benchmarks: (A) locate implementation symbol; (B) cross-file bug fix; (C) dependency upgrade; (D) security review; (E) repo onboarding; (F) incremental second-turn follow-up; (G) multi-agent concurrent patch; (H) offline local-only operation; (I) malicious repo prompt injection; (J) revoked access. For each task record baseline tokens, fabric tokens, answer correctness, patch acceptance, p50/p95 latency, CPU/RAM, cache hit rate, stale errors and security denials. Run paired trials with same model and task budget; bootstrap confidence intervals over task-level differences. Gate rollout on no material quality regression and zero critical authorization violations. Report failure cases, not just aggregate wins.

## 13. Production roadmap
P0: harden path checks, secret filtering, exact UTF-8 byte limits, tests, ACL boundary. P1: persistent content-hash index, incremental invalidation, pack/delta API, deterministic benchmark harness. P2: symbol graph, local embedding plug-in, provenance UI, repo import sync state machine. P3: PORTA promotion gates, tenant-aware capability grants, signed receipts, rollback. P4: EXAMEN swarm leases and contention control, model/weight registry integration, multi-device federation. P5: 100+ release assertions, chaos testing, privacy review, observed latency/token reports and staged deployment.

## 14. Implementation contracts
context-pack request: {request_id,principal,tenant,repo_ref,query,budget,known_digest,known_hashes}. Response: {schema,request_id,revision,worktree_digest,items:[{path,lines,sha256,excerpt,token_estimate}],omissions,provenance,receipt}. Index update: {repo_ref,changed_paths,deleted_paths,manifest_digest}. Promotion: {actor,source_kiln,target_org,target_repo,branch,diff_digest,policy_decision,tests,approvals,receipt}. Reject requests missing authorization; never infer a principal from the client-supplied body alone.

## 15. Evidence posture
This paper proposes measurable engineering methods; it does not claim token savings, benchmark results, security certification or live production deployment. Prior repository inspection supports existence of a local KILN daemon, Git operations, grants, receipts and NEXUS context-pack contracts. The new prototype module is only a foundation and must be tested and reviewed before public use.
