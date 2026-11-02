// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title KILN Compute Registry
/// @notice Attestation registry for off-chain compute. Heavy numerics run
/// off-chain (MatDaemon, the Auro model); this contract binds that work to
/// the chain in three steps anyone can audit after the fact:
/// register an algorithm (id -> spec digest), commit a job (algorithm +
/// inputs digest), attest a result (result digest, attester address).
/// The pure kernels in KilnCompute verify the arithmetic behind a claim;
/// this registry records who claimed what, when — the attestation chain.
/// @dev Registration and attestation are open: any address may register an
/// algorithm id or attest a result. Integrity comes from the digests and
/// the first-write rules, not from a gatekeeper — the first registration of
/// an algoId fixes its specHash (a later, different spec must use a new
/// id), and the first attestation of a job fixes its resultHash (a disputed
/// result is a new job, not an overwrite). Every record keeps its author.
contract KilnComputeRegistry {
    struct Algorithm {
        bytes32 specHash;
        address registeredBy;
        uint64 registeredAt;
    }

    struct Job {
        bytes32 algoId;
        bytes32 inputsHash;
        address committedBy;
        uint64 committedAt;
        bytes32 resultHash;
        address attestedBy;
        uint64 attestedAt; // 0 while the job is unattested
    }

    mapping(bytes32 => Algorithm) private algorithms;
    mapping(bytes32 => Job) private jobs;
    /// @notice Total jobs ever committed; also the nonce inside every jobId,
    /// so identical (algoId, inputsHash, committer) commits never collide.
    uint256 public jobCount;

    error InvalidAlgorithmId();
    error InvalidSpecHash();
    error InvalidInputsHash();
    error InvalidResultHash();
    error AlgorithmAlreadyRegistered();
    error AlgorithmNotFound();
    error JobNotFound();
    error AlreadyAttested();

    event AlgorithmRegistered(bytes32 indexed algoId, address indexed registeredBy, bytes32 specHash, uint64 timestamp);
    event JobCommitted(bytes32 indexed jobId, bytes32 indexed algoId, address indexed committedBy, bytes32 inputsHash, uint64 timestamp);
    event ResultAttested(bytes32 indexed jobId, address indexed attestedBy, bytes32 resultHash, uint64 timestamp);

    /// @notice Register an algorithm: bind `algoId` to the digest of its
    /// specification (what the inputs mean, what the result must satisfy).
    /// First writer wins — re-registering the same id reverts, so a spec can
    /// never be silently swapped under an existing id.
    function registerAlgorithm(bytes32 algoId, bytes32 specHash) external {
        if (algoId == bytes32(0)) revert InvalidAlgorithmId();
        if (specHash == bytes32(0)) revert InvalidSpecHash();
        if (algorithms[algoId].registeredAt != 0) revert AlgorithmAlreadyRegistered();
        algorithms[algoId] = Algorithm({specHash: specHash, registeredBy: msg.sender, registeredAt: uint64(block.timestamp)});
        emit AlgorithmRegistered(algoId, msg.sender, specHash, uint64(block.timestamp));
    }

    /// @notice Commit a compute job: `inputsHash` digests the job's inputs
    /// (for vector kernels, KilnCompute.digestVector / rmsDigest produce
    /// these). Returns the jobId binding algorithm, inputs, committer, and
    /// a global nonce. The job exists from this moment; its result is
    /// attested separately, by any address, exactly once.
    function commitJob(bytes32 algoId, bytes32 inputsHash) external returns (bytes32 jobId) {
        if (algorithms[algoId].registeredAt == 0) revert AlgorithmNotFound();
        if (inputsHash == bytes32(0)) revert InvalidInputsHash();
        jobCount += 1;
        jobId = keccak256(abi.encode(algoId, inputsHash, msg.sender, jobCount));
        jobs[jobId] = Job({
            algoId: algoId,
            inputsHash: inputsHash,
            committedBy: msg.sender,
            committedAt: uint64(block.timestamp),
            resultHash: bytes32(0),
            attestedBy: address(0),
            attestedAt: 0
        });
        emit JobCommitted(jobId, algoId, msg.sender, inputsHash, uint64(block.timestamp));
    }

    /// @notice Attest a job's result digest. First attestation wins: once a
    /// job carries a result, re-attestation reverts (AlreadyAttested) — a
    /// challenger who computes a different result commits a new job and lets
    /// the kernels (KilnCompute) adjudicate the arithmetic.
    function attestResult(bytes32 jobId, bytes32 resultHash) external {
        Job storage job = jobs[jobId];
        if (job.committedAt == 0) revert JobNotFound();
        if (resultHash == bytes32(0)) revert InvalidResultHash();
        if (job.attestedAt != 0) revert AlreadyAttested();
        job.resultHash = resultHash;
        job.attestedBy = msg.sender;
        job.attestedAt = uint64(block.timestamp);
        emit ResultAttested(jobId, msg.sender, resultHash, uint64(block.timestamp));
    }

    /// @notice The registered spec record for an algorithm.
    function getAlgorithm(bytes32 algoId) external view returns (Algorithm memory) {
        if (algorithms[algoId].registeredAt == 0) revert AlgorithmNotFound();
        return algorithms[algoId];
    }

    /// @notice The full record of a job: algorithm, inputs, committer, and
    /// (once attested) result + attester.
    function getJob(bytes32 jobId) external view returns (Job memory) {
        if (jobs[jobId].committedAt == 0) revert JobNotFound();
        return jobs[jobId];
    }

    /// @notice True once a job carries an attested result.
    function isAttested(bytes32 jobId) external view returns (bool) {
        return jobs[jobId].attestedAt != 0;
    }

    /// @notice Verify a complete attestation chain in one call: the job must
    /// exist, belong to `algoId`, carry exactly `inputsHash`, and be attested
    /// with exactly `resultHash`. Non-reverting — built for challengers and
    /// indexers checking a claim before trusting it.
    function verifyAttestation(bytes32 jobId, bytes32 algoId, bytes32 inputsHash, bytes32 resultHash) external view returns (bool) {
        Job storage job = jobs[jobId];
        return job.committedAt != 0
            && job.algoId == algoId
            && job.inputsHash == inputsHash
            && job.attestedAt != 0
            && job.resultHash == resultHash;
    }
}
