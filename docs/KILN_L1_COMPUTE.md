# KILN L1 Compute — verifiable compute on the chain

The L1 compute layer lives beside `KilnOwnershipRegistry` in `contracts/`:

- **`KilnCompute`** (library) — pure verification kernels.
- **`KilnComputeRegistry`** — the compute attestation registry.

## The boundary, stated plainly

**Heavy numerics do NOT run on-chain.** A full matmul is O(n³); RMSNorm over
a real model dimension is O(n) multiplications per token. Running that in
the EVM would be slow, expensive, and pointless. It runs where it already
runs: **MatDaemon** (matrix compute plane) and the **Auro** model runtime —
off-chain, fast, unglamorous.

What runs **on-chain** is the part the chain is actually good at:

1. **Verification kernels** — algorithms whose *checking* is cheap and
   exact, even when *producing* the result was expensive. Any single
   element of a MatDaemon matmul can be proven on-chain in O(n). Any file
   or commit can be proven inside a Merkle tree. Any segment of the agent
   ledger's hash chain can be replayed and checked.
2. **Attestation** — a registry binding *algorithm → job → result* with
   digests and attester addresses, so a claim made off-chain is anchored
   on-chain and anyone can audit the chain of custody after the fact.

If a number matters, it is either verified by a kernel or attested in the
registry (ideally both). If it is neither, it is just a number somebody
said — this layer exists so KILN doesn't have to take anybody's word.

## The kernels (`contracts/KilnCompute.sol`)

All pure, all exact integer/byte math. Solidity 0.8 checked arithmetic:
overflow reverts rather than wrapping a claim into truth.

| Kernel | What it verifies |
|---|---|
| `verifyLeaf(root, leaf, proof, index)` | Merkle inclusion — a leaf sits at `index` in the tree with this root. The forge primitive: prove a file/commit is in a tree. |
| `verifyChainStep` / `verifyChainSegment` | Hash-chain folds — a ledger segment starting at a known hash ends at the claimed head. Tamper with any entry and the fold breaks. |
| `dot` / `verifyDot` | Dot product over raw `int256` vectors. |
| `verifyMatmulElement(aRow, bCol, claimed)` | One element `C[i][j] = dot(row_i(A), col_j(B))` — the verifiable-compute pattern: MatDaemon computes the whole product; any element is provable here. |
| `verifyMatmulElementCommitted(rowCommit, colCommit, …)` | The same check, with the row/column first bound to previously committed digests (`digestVector`). |
| `sumSquares` / `meanSquare` / `rms` / `rmsDigest` | The RMSNorm verification core: `rms(x) = isqrt(sum(x²)/n)`. `rmsDigest` commits to `(sumSquares, count)` — the two numbers the RMS value derives from. |
| `isqrt` | Floor integer square root (Newton iteration from a power-of-two bound), exact for every `uint256`. |
| `digestVector` | `keccak256(abi.encode(v))` — the commitment digest for a vector. |

### Conventions (normative — producers must match these)

- **Merkle:** keccak256, *index-directed* pairing (children hashed in
  positional left/right order, never sorted). A level with an odd node
  count **duplicates** its last node. Duplication is deliberate: under
  promote-unchanged, a bare `(proof, index)` pair is ambiguous about which
  level a sibling belongs to; duplication keeps every proof verifiable
  from `(root, leaf, proof, index)` alone. Leaves are `keccak256(data)`
  (`leafHash`).
- **Hash chain:** `next = keccak256(prevHash || entryHash)`, raw byte
  concatenation, starting from whatever genesis hash the ledger chose.
- **Fixed point:** vectors are raw signed integers; the library never
  rescales. If inputs are scaled by `S`, `dot`/`sumSquares`/`meanSquare`
  outputs are scaled by `S²`, and `rms` comes back in the input's own
  scale (scaled by `S`). The house convention is `S = 1e18`, but the
  kernels verify arithmetic, not interpretation. `meanSquare` divides
  with truncation toward zero (the sum of squares is non-negative, so in
  practice it floors).

### Honest limits

- `verifyMatmulElementCommitted` binds vectors to digests — it does **not**
  make verification hash-only. The raw row and column are still inputs;
  the digest proves they're the *committed* vectors, the dot proves the
  *arithmetic*. Both halves are needed, and the code says so.
- The kernels verify one element / one segment / one leaf per call. A
  challenger auditing a full matmul samples elements; the sampling
  strategy (how many, chosen how) is policy, and it lives off-chain.
- `rms` is the bare RMS value. RMSNorm's epsilon and learned gain are
  model details and stay in the Auro runtime, off-chain.

## The registry (`contracts/KilnComputeRegistry.sol`)

Three steps, each an event, each record keeping its author:

1. `registerAlgorithm(algoId, specHash)` — bind an algorithm id to the
   digest of its spec. **First writer wins:** re-registering an id
   reverts, so a spec can't be swapped under an existing id.
2. `commitJob(algoId, inputsHash) → jobId` — commit a job against a
   registered algorithm. `jobId = keccak256(algoId, inputsHash, committer,
   nonce)`; identical recommits never collide.
3. `attestResult(jobId, resultHash)` — attest the result digest. **First
   attestation wins:** re-attestation reverts. A disputed result is a new
   job, adjudicated by the kernels — not an overwrite.

`verifyAttestation(jobId, algoId, inputsHash, resultHash)` checks the whole
chain in one non-reverting call, for challengers and indexers.

Registration and attestation are **open** (any address). Integrity comes
from the digests, the first-write rules, and the recorded authors — not
from a gatekeeper. Project-scoped authorization (the ownership registry's
capability grants) can be layered by callers that need it; this registry
deliberately stays the simple, auditable base.

### The intended flow (MatDaemon job, end to end)

1. Register `keccak256("matdaemon.matmul.v1")` once, with the spec digest.
2. MatDaemon receives A and B; the committer posts
   `commitJob(algoId, digest)` where the inputs digest binds A and B
   (e.g. a Merkle root over `digestVector` of each row/column).
3. MatDaemon computes C = A·B off-chain; an attester posts
   `attestResult(jobId, digest(C))`.
4. Anyone, later, doubts C[i][j]: they fetch row i and column j, check
   their digests against step 2's commitment, and call
   `verifyMatmulElementCommitted` on-chain. The chain settles it.

## Status

Contracts + Foundry tests only. **Nothing here is deployed on any chain
yet** — deployment rides the L1 chain program (Robinhood Chain 4663 /
Monad) and the architect's broadcast, like the ownership registry's. The
ownership registry's behavior is untouched by this layer.
