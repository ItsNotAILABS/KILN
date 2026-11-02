// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title KILN Compute Kernels
/// @notice Pure on-chain verification kernels for the KILN verifiable-compute
/// layer. Heavy numerics run off-chain (MatDaemon, the Auro model); what runs
/// here is the part the EVM is good at: exact, cheap verification — Merkle
/// inclusion, hash-chain folds, and integer linear-algebra spot-checks — so a
/// result computed elsewhere can be proven (or refuted) on-chain.
/// @dev Fixed-point convention: vectors are raw signed integers. This library
/// never rescales. If a caller scales inputs by S, `dot` and `sumSquares`
/// outputs are scaled by S^2, `meanSquare` by S^2, and `rms` by S (the RMS
/// value comes back in the same scale as the inputs). The common convention
/// in this codebase is S = 1e18 (one whole unit = 1e18 raw), but the kernels
/// are scale-agnostic: they verify the arithmetic, not the interpretation.
library KilnCompute {
    error LengthMismatch();
    error EmptyVector();

    // ------------------------------------------------------------------
    // Merkle inclusion
    // ------------------------------------------------------------------

    /// @notice Hash one Merkle node from its ordered children.
    /// @dev Convention: index-directed (positional) pairing — children are
    /// hashed in (left, right) order as given, NOT sorted. The position is
    /// carried by the leaf index in `verifyLeaf`. A level with an odd node
    /// count DUPLICATES its last node (the node is hashed with itself).
    /// Duplication is chosen over promote-unchanged deliberately: a promoted
    /// node's proof is ambiguous under a bare (proof, index) pair — the
    /// verifier cannot tell which level a sibling belongs to without a
    /// tree-size oracle — while duplication keeps every proof verifiable
    /// from (root, leaf, proof, index) alone, at every level, uniformly.
    function hashPair(bytes32 left, bytes32 right) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(left, right));
    }

    /// @notice Hash arbitrary data into a Merkle leaf.
    function leafHash(bytes calldata data) external pure returns (bytes32) {
        return keccak256(data);
    }

    /// @notice Verify that `leaf` sits at position `index` in the tree whose
    /// root is `root`, given the sibling path bottom-to-top.
    /// @dev Folds the proof one level at a time: at each level, if the
    /// current index bit is 0 the running hash is the left child, otherwise
    /// the right child; the index then shifts down. Under the
    /// duplicate-the-odd-node convention (see `hashPair`) the proof length
    /// is exactly the tree depth for every leaf, including a level's last
    /// odd node — its sibling at that level is itself.
    /// @param root The Merkle root to verify against.
    /// @param leaf The leaf hash being proven (see `leafHash`).
    /// @param proof Sibling hashes, ordered from the leaf level upward.
    /// @param index Zero-based position of the leaf in its level.
    function verifyLeaf(bytes32 root, bytes32 leaf, bytes32[] calldata proof, uint256 index) external pure returns (bool) {
        bytes32 node = leaf;
        uint256 idx = index;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 sibling = proof[i];
            if (idx & 1 == 0) {
                node = keccak256(abi.encodePacked(node, sibling));
            } else {
                node = keccak256(abi.encodePacked(sibling, node));
            }
            idx >>= 1;
        }
        return node == root;
    }

    // ------------------------------------------------------------------
    // Hash chains (agent-ledger tamper evidence)
    // ------------------------------------------------------------------

    /// @notice Advance a hash chain by one entry.
    /// @dev next = keccak256(prevHash || entryHash), raw byte concatenation.
    function chainStep(bytes32 prevHash, bytes32 entryHash) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(prevHash, entryHash));
    }

    /// @notice Verify a single claimed chain step.
    function verifyChainStep(bytes32 prevHash, bytes32 entryHash, bytes32 claimedNext) external pure returns (bool) {
        return keccak256(abi.encodePacked(prevHash, entryHash)) == claimedNext;
    }

    /// @notice Fold a run of entries onto a starting hash and return the
    /// resulting chain head. An empty run returns `startHash` unchanged.
    function chainSegment(bytes32 startHash, bytes32[] calldata entries) external pure returns (bytes32) {
        bytes32 node = startHash;
        for (uint256 i = 0; i < entries.length; i++) {
            node = keccak256(abi.encodePacked(node, entries[i]));
        }
        return node;
    }

    /// @notice Verify that folding `entries` onto `startHash` ends exactly at
    /// `claimedEnd` — a challenger replays the segment; any tampered entry
    /// breaks the fold.
    function verifyChainSegment(bytes32 startHash, bytes32[] calldata entries, bytes32 claimedEnd) external pure returns (bool) {
        bytes32 node = startHash;
        for (uint256 i = 0; i < entries.length; i++) {
            node = keccak256(abi.encodePacked(node, entries[i]));
        }
        return node == claimedEnd;
    }

    // ------------------------------------------------------------------
    // Integer vector kernels (MatDaemon / Auro verification cores)
    // ------------------------------------------------------------------

    /// @notice Dot product of two equal-length vectors, raw integer math.
    /// @dev Reverts LengthMismatch on differing lengths. Overflow reverts via
    /// Solidity 0.8 checked arithmetic — a claim that only verifies by
    /// overflowing is not a claim this layer will bless.
    function dot(int256[] calldata a, int256[] calldata b) external pure returns (int256) {
        if (a.length != b.length) revert LengthMismatch();
        int256 acc = 0;
        for (uint256 i = 0; i < a.length; i++) {
            acc += a[i] * b[i];
        }
        return acc;
    }

    /// @notice Verify a claimed dot product.
    function verifyDot(int256[] calldata a, int256[] calldata b, int256 claimed) external pure returns (bool) {
        if (a.length != b.length) revert LengthMismatch();
        int256 acc = 0;
        for (uint256 i = 0; i < a.length; i++) {
            acc += a[i] * b[i];
        }
        return acc == claimed;
    }

    /// @notice Verify ONE element of a matrix product: C[i][j] must equal
    /// dot(row i of A, column j of B). The full matmul runs off-chain in
    /// MatDaemon in O(n^3); any single element is provable here in O(n).
    /// @param aRow Row i of A (length n).
    /// @param bCol Column j of B (length n), supplied as a vector.
    /// @param claimed The claimed value of C[i][j].
    function verifyMatmulElement(int256[] calldata aRow, int256[] calldata bCol, int256 claimed) external pure returns (bool) {
        if (aRow.length != bCol.length) revert LengthMismatch();
        int256 acc = 0;
        for (uint256 i = 0; i < aRow.length; i++) {
            acc += aRow[i] * bCol[i];
        }
        return acc == claimed;
    }

    /// @notice Commitment digest of a vector: keccak256 of its ABI encoding.
    /// @dev Used to bind a row/column to a value committed earlier (e.g. in
    /// KilnComputeRegistry as a job's inputsHash). Honest bound: the digest
    /// binds the data, it does not hide it — verification still needs the raw
    /// vector (see `verifyMatmulElementCommitted`).
    function digestVector(int256[] calldata v) external pure returns (bytes32) {
        return keccak256(abi.encode(v));
    }

    /// @notice Committed-digests form of the matmul spot-check: the supplied
    /// row and column must first hash to the previously committed digests,
    /// then the element identity is checked. This proves the verified vectors
    /// are the committed ones — it does NOT make verification hash-only; the
    /// raw arrays are still inputs, by design.
    function verifyMatmulElementCommitted(
        bytes32 rowCommit,
        bytes32 colCommit,
        int256[] calldata aRow,
        int256[] calldata bCol,
        int256 claimed
    ) external pure returns (bool) {
        if (keccak256(abi.encode(aRow)) != rowCommit) return false;
        if (keccak256(abi.encode(bCol)) != colCommit) return false;
        if (aRow.length != bCol.length) revert LengthMismatch();
        int256 acc = 0;
        for (uint256 i = 0; i < aRow.length; i++) {
            acc += aRow[i] * bCol[i];
        }
        return acc == claimed;
    }

    /// @notice Sum of squares of a vector — the accumulation at the heart of
    /// RMS normalization (Auro's RMSNorm) and energy/ magnitude checks.
    function sumSquares(int256[] calldata x) external pure returns (int256) {
        int256 acc = 0;
        for (uint256 i = 0; i < x.length; i++) {
            acc += x[i] * x[i];
        }
        return acc;
    }

    /// @notice Mean of squares: sumSquares / length, integer division
    /// (truncates toward zero; the sum of squares is non-negative, so this
    /// is a floor). Reverts EmptyVector for an empty input.
    function meanSquare(int256[] calldata x) external pure returns (int256) {
        if (x.length == 0) revert EmptyVector();
        int256 acc = 0;
        for (uint256 i = 0; i < x.length; i++) {
            acc += x[i] * x[i];
        }
        return acc / int256(x.length);
    }

    /// @notice Integer square root (floor) via the Babylonian method.
    /// @dev Documented implementation: Newton iteration on uint256 starting
    /// from a power of two with r*r >= x (an overestimate, or the root
    /// itself when x is a perfect square), derived by doubling; exact for
    /// every uint256 input (the result r satisfies r*r <= x < (r+1)*(r+1)).
    /// Cost is O(log) iterations — a verification helper, not a hot loop.
    function isqrt(uint256 x) external pure returns (uint256) {
        if (x == 0) return 0;
        // Initial guess: a power of two whose square reaches at least x,
        // found by doubling; Newton then converges monotonically downward.
        uint256 r = 1;
        uint256 xCopy = x;
        while (xCopy > 1) {
            xCopy >>= 2;
            r <<= 1;
        }
        // r now satisfies r*r >= x, so Newton's method for integer sqrt
        // decreases monotonically to the floor root.
        uint256 y = (r + x / r) >> 1;
        while (y < r) {
            r = y;
            y = (r + x / r) >> 1;
        }
        return r;
    }

    /// @notice Root-mean-square of a vector: sqrt(meanSquare(x)), returned in
    /// the same scale as the inputs (see the fixed-point note at the top).
    /// This is the value Auro's RMSNorm divides by (before its epsilon and
    /// gain, which stay off-chain); here it is exactly reproducible.
    function rms(int256[] calldata x) external pure returns (int256) {
        if (x.length == 0) revert EmptyVector();
        int256 acc = 0;
        for (uint256 i = 0; i < x.length; i++) {
            acc += x[i] * x[i];
        }
        int256 ms = acc / int256(x.length);
        // ms >= 0 always (sum of squares), so the cast is safe.
        return int256(_isqrt(uint256(ms)));
    }

    /// @notice The digest a compute job commits for an RMS claim: a binding
    /// commitment to (sum of squares, element count) — the two numbers from
    /// which the RMS value is derived exactly by `rms`. Anyone holding the
    /// vector can recompute both and compare; anyone holding only the digest
    /// can later check a revealed vector against it.
    function rmsDigest(int256[] calldata x) external pure returns (bytes32) {
        if (x.length == 0) revert EmptyVector();
        int256 acc = 0;
        for (uint256 i = 0; i < x.length; i++) {
            acc += x[i] * x[i];
        }
        return keccak256(abi.encode(acc, x.length));
    }

    /// @dev Internal twin of `isqrt` so `rms` does not pay an external call.
    function _isqrt(uint256 x) internal pure returns (uint256) {
        if (x == 0) return 0;
        uint256 r = 1;
        uint256 xCopy = x;
        while (xCopy > 1) {
            xCopy >>= 2;
            r <<= 1;
        }
        uint256 y = (r + x / r) >> 1;
        while (y < r) {
            r = y;
            y = (r + x / r) >> 1;
        }
        return r;
    }
}
