# KILN Context Fabric v2 — Operator and Agent Contract

Context Fabric makes a KILN node's Git worktree queryable without repeatedly serializing the whole repository into an agent prompt.

## Boundaries

- Retrieval is local and read-only.
- Daemon routes are authenticated and bound to an existing KILN node workdir.
- There is no arbitrary host-path query API.
- Only Git-tracked text files enter the index.
- Secret-path classes are excluded before indexing.
- Symlinks are not followed into the index.
- Repository text is data, not control-plane instruction.
- Context access does not imply commit, release, or GitHub promotion authority.
- Raw queries and source excerpts are excluded from Context Fabric audit receipts.

## Agent usage

Inside a KILN node, use the native tool:

```json
{
  "tool": "context.query",
  "args": {
    "query": "promotion policy and github receipt",
    "maxBytes": 24000,
    "maxChunks": 12
  }
}
```

Preferred agent loop:

1. Query for the task and relevant symbols.
2. Read exact files only when a complete contiguous section is required.
3. Perform work.
4. On follow-up turns, pass known file hashes so unchanged source is represented as an unchanged reference.
5. Re-query before mutation when the worktree may have moved.
6. Run tests and inspect Git diff.
7. Promote only through the existing governed KILN promotion path.

Do not start by recursively reading the repository unless the task explicitly requires a whole-repo audit.

## CLI

Direct local repository:

```sh
node context.mjs local-index --repo /workspace/myrepo
node context.mjs local-query --repo /workspace/myrepo --query "agent promotion evidence"
```

Node through the local daemon:

```sh
node context.mjs index --node muse
node context.mjs query --node muse --query "agent promotion evidence"
node context.mjs status --node muse
node context.mjs verify
```

Delta from a saved prior pack:

```sh
node context.mjs delta --node muse --query "same task follow up" --prior previous-pack.json
```

## SDK

```js
const kiln = await SwarmClient.connect();

const first = await kiln.contextQuery("muse", "promotion policy", {
  maxBytes: 24000,
  maxChunks: 12,
});

const next = await kiln.contextDelta(
  "muse",
  "promotion policy after the latest edit",
  first.pack,
);

await kiln.contextReceiptsVerify();
```

## HTTP API

Authenticated loopback API:

```text
POST /v1/context/nodes/:node/index
POST /v1/context/nodes/:node/query
GET  /v1/context/nodes/:node/status
POST /v1/context/receipts/verify
```

The daemon bearer token remains local. A browser application must use a trusted server-side bridge; never expose `api.token` to client JavaScript.

## Retrieval stack

Current deterministic stack:

1. canonical Git tracked files;
2. content SHA-256;
3. incremental chunk reuse;
4. identifier normalization;
5. BM25;
6. filename/path boost;
7. symbol boost;
8. MMR de-duplication;
9. bounded local dependency expansion;
10. hard pack byte/chunk ceilings;
11. known-hash delta suppression.

Optional future semantic reranking must be explicit and cannot silently create a hosted-provider dependency.

## Production gates

Run:

```sh
cd swarm
node --test test/context-index.test.mjs test/context-receipts.test.mjs test/context-tool.test.mjs
node scripts/validate-context-fabric.mjs
node scripts/context-benchmark.mjs --repo .. --cases examples/context-benchmark-cases.json
```

Then run the complete KILN suite:

```sh
node --test test/*.test.mjs
```

Do not advertise a token-reduction percentage from `byteReduction`. The benchmark's byte and four-byte/token estimates are transport proxies. A release claim about token cost requires an actual tokenizer/model paired evaluation.

## Evidence ladder

- E1: code exists.
- E2: deterministic local tests and 120+ validation assertions pass.
- E3: integrated daemon/node/SDK/promotion tests pass.
- E4: staged agent workloads demonstrate retrieval quality and measured tokenizer savings.
- E5: independent production/security evidence.

Context Fabric is not production-certified merely because the modules exist.


## Context sit: code + durable memory

A KILN node can use `context.sit` when it needs both the current code tree and durable repository memory:

```json
{
  "tool": "context.sit",
  "args": {
    "query": "promotion policy and prior decisions",
    "maxBytes": 18000,
    "maxChunks": 10,
    "memoryTokens": 1200
  }
}
```

Memory is fused only when the node is actually attached to a KILN-native repository. The tool derives owner/repo from that node's own remote (loopback Git URL or local KILN bare path). It does not accept an arbitrary memory repository argument.

## Promotion with context provenance

The SDK can bind a context result into a real KILN GitHub promotion:

```js
const contextResult = await kiln.contextQuery(
  "muse",
  "promotion implementation and policy",
  { maxBytes: 24000 },
);

const receipt = await kiln.promoteFromContext({
  repo: "muse/project",
  github: "ItsNotAILABS/project",
  contextResult,
  ci: "context-fabric-gate",
});
```

The promotion carries digests and receipt hashes, not raw query text or retrieved source.
