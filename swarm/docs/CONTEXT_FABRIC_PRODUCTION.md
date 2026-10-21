# KILN Context Fabric v2 - Production Boundary

## Current branch

`civitas/context-fabric-v1`

## Implemented

- persistent content-addressed repository index
- dirty worktree digest
- incremental reuse
- BM25 + path + symbol retrieval
- MMR redundancy control
- local dependency expansion
- delta packs
- secret path and secret content filtering
- repository graph and impact analysis
- verified fact ledger with hash invalidation
- token budget adapter with exact custom tokenizer hook
- compiled mission context packs
- privacy-bounded context receipt chain
- loopback daemon endpoints
- SwarmClient APIs
- Workspace server-only bridge
- NEXUS protocol contracts
- pure PORTA promotion decision engine

## Operator boundary

The daemon is loopback only. Context APIs are authenticated. Context operations are bound to registered KILN node workdirs; callers cannot submit arbitrary host paths. Workspace never sends the daemon bearer token to browser code. PORTA currently evaluates promotion only and does not push or merge.

## Required before production claim

1. Execute the complete test suite in a clean checkout.
2. Add 100+ production assertions covering context, security, graph, ledger, API, Workspace bridge, NEXUS compatibility, and PORTA denial paths.
3. Integrate a real tokenizer and run paired model benchmarks.
4. Replace parser-lite graph extraction with language-aware AST adapters.
5. Add dedicated secret scanner integration and organization policy.
6. Add node/tenant-scoped authorization beyond the single local daemon bearer token for multi-user deployment.
7. Implement PORTA mutation executor using short-lived organization credentials.
8. Add branch protection, rollback, idempotency, and release receipts.
9. Run concurrency/chaos tests.
10. Complete independent security review before exposing anything beyond localhost.

## Promotion sequence

```
agent worktree
  -> context/impact refresh
  -> clean diff digest
  -> tests
  -> secret scan
  -> NEXUS policy
  -> human/delegated approval if required
  -> PORTA allow decision
  -> short-lived GitHub credential
  -> push candidate branch
  -> CI
  -> merge gate
  -> execution receipt
```

## Truth states

- IMPLEMENTED: source exists on branch.
- TESTED: automated test executed successfully in a clean runtime.
- BENCHMARKED: measured against declared benchmark.
- DEPLOYED: running in a declared environment.
- AUDITED: independently reviewed.

Do not convert IMPLEMENTED into TESTED, BENCHMARKED, DEPLOYED, or AUDITED without evidence.
