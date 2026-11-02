// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {KilnComputeRegistry} from "../contracts/KilnComputeRegistry.sol";

contract KilnComputeRegistryTest is Test {
    KilnComputeRegistry internal registry;
    address internal registrar = address(0xA11CE);
    address internal committer = address(0xB0B);
    address internal attester = address(0xCAFE);
    address internal stranger = address(0xD00D);

    bytes32 internal algoId = keccak256("matdaemon.matmul.v1");
    bytes32 internal specHash = keccak256("spec: C = A*B over int256 vectors, scale 1e18");
    bytes32 internal inputsHash = keccak256("inputs: A row 0, B col 0 digests");
    bytes32 internal resultHash = keccak256("result: C[0][0] digest");

    function setUp() public {
        registry = new KilnComputeRegistry();
    }

    function register() internal {
        vm.prank(registrar);
        registry.registerAlgorithm(algoId, specHash);
    }

    function commit() internal returns (bytes32 jobId) {
        vm.prank(committer);
        jobId = registry.commitJob(algoId, inputsHash);
    }

    function testRegisterAlgorithm() public {
        vm.expectEmit(true, true, false, true);
        emit KilnComputeRegistry.AlgorithmRegistered(algoId, registrar, specHash, uint64(block.timestamp));
        register();

        KilnComputeRegistry.Algorithm memory algo = registry.getAlgorithm(algoId);
        assertEq(algo.specHash, specHash);
        assertEq(algo.registeredBy, registrar);
        assertEq(algo.registeredAt, uint64(block.timestamp));
    }

    function testRegisterRejectsDuplicatesAndZeroValues() public {
        register();
        vm.prank(stranger);
        vm.expectRevert(KilnComputeRegistry.AlgorithmAlreadyRegistered.selector);
        registry.registerAlgorithm(algoId, keccak256("a different spec under the same id"));

        vm.expectRevert(KilnComputeRegistry.InvalidAlgorithmId.selector);
        registry.registerAlgorithm(bytes32(0), specHash);
        vm.expectRevert(KilnComputeRegistry.InvalidSpecHash.selector);
        registry.registerAlgorithm(keccak256("other"), bytes32(0));
    }

    function testFullLifecycleAndVerify() public {
        register();
        bytes32 jobId = commit();

        KilnComputeRegistry.Job memory job = registry.getJob(jobId);
        assertEq(job.algoId, algoId);
        assertEq(job.inputsHash, inputsHash);
        assertEq(job.committedBy, committer);
        assertEq(job.attestedAt, 0);
        assertFalse(registry.isAttested(jobId));
        assertFalse(registry.verifyAttestation(jobId, algoId, inputsHash, resultHash));

        // Attestation by a SECOND address (not the committer) is the normal
        // case: the runner commits, an independent attester vouches.
        vm.expectEmit(true, true, false, true);
        emit KilnComputeRegistry.ResultAttested(jobId, attester, resultHash, uint64(block.timestamp));
        vm.prank(attester);
        registry.attestResult(jobId, resultHash);

        job = registry.getJob(jobId);
        assertEq(job.resultHash, resultHash);
        assertEq(job.attestedBy, attester);
        assertTrue(registry.isAttested(jobId));

        // The full chain verifies; every wrong link fails.
        assertTrue(registry.verifyAttestation(jobId, algoId, inputsHash, resultHash));
        assertFalse(registry.verifyAttestation(jobId, algoId, inputsHash, keccak256("wrong result")));
        assertFalse(registry.verifyAttestation(jobId, keccak256("other algo"), inputsHash, resultHash));
        assertFalse(registry.verifyAttestation(jobId, algoId, keccak256("other inputs"), resultHash));
        assertFalse(registry.verifyAttestation(keccak256("no such job"), algoId, inputsHash, resultHash));
    }

    function testJobIdsNeverCollide() public {
        register();
        bytes32 first = commit();
        bytes32 second = commit();
        assertTrue(first != second);
        assertEq(registry.jobCount(), 2);
    }

    function testCommitRequiresRegisteredAlgorithm() public {
        vm.prank(committer);
        vm.expectRevert(KilnComputeRegistry.AlgorithmNotFound.selector);
        registry.commitJob(algoId, inputsHash);

        register();
        vm.prank(committer);
        vm.expectRevert(KilnComputeRegistry.InvalidInputsHash.selector);
        registry.commitJob(algoId, bytes32(0));
    }

    function testAttestRejectsUnknownJobZeroResultAndSecondAttestation() public {
        register();
        bytes32 jobId = commit();

        vm.prank(attester);
        vm.expectRevert(KilnComputeRegistry.JobNotFound.selector);
        registry.attestResult(keccak256("no such job"), resultHash);

        vm.prank(attester);
        vm.expectRevert(KilnComputeRegistry.InvalidResultHash.selector);
        registry.attestResult(jobId, bytes32(0));

        vm.prank(attester);
        registry.attestResult(jobId, resultHash);

        // First attestation wins — even the original attester cannot rewrite.
        vm.prank(stranger);
        vm.expectRevert(KilnComputeRegistry.AlreadyAttested.selector);
        registry.attestResult(jobId, keccak256("a different result"));
    }

    function testGettersRevertForUnknownIds() public {
        vm.expectRevert(KilnComputeRegistry.AlgorithmNotFound.selector);
        registry.getAlgorithm(algoId);
        vm.expectRevert(KilnComputeRegistry.JobNotFound.selector);
        registry.getJob(keccak256("no such job"));
    }
}
