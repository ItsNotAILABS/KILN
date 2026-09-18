// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {KilnOwnershipRegistry} from "../contracts/KilnOwnershipRegistry.sol";

contract KilnOwnershipRegistryTest is Test {
    KilnOwnershipRegistry internal registry;
    address internal owner = address(0xA11CE);
    address internal agent = address(0xB0B);
    address internal user = address(0xCAFE);
    bytes32 internal projectId = keccak256("ItsNotAILABS/KILN");
    bytes32 internal licenseId = keccak256("MIT");

    function setUp() public { registry = new KilnOwnershipRegistry(); }

    function register() internal {
        vm.prank(owner);
        registry.registerProject(projectId, "https://github.com/ItsNotAILABS/KILN", owner, licenseId);
    }

    function testRegisterAndAnchorCommit() public {
        register();
        vm.prank(owner);
        registry.commitProject(projectId, keccak256("git-commit"), keccak256("git-tree"), keccak256("metadata"));
        KilnOwnershipRegistry.Project memory project = registry.getProject(projectId);
        assertEq(project.owner, owner);
        assertEq(project.latestCommit, keccak256("git-commit"));
        assertEq(project.latestTree, keccak256("git-tree"));
        assertEq(project.authorizationEpoch, 1);
    }

    function testCannotRegisterProjectForVictimWithoutConsent() public {
        vm.prank(user);
        vm.expectRevert(KilnOwnershipRegistry.OwnerConsentRequired.selector);
        registry.registerProject(projectId, "ipfs://squat", owner, licenseId);
    }

    function testAgentCanAnchorWithinScope() public {
        register();
        vm.prank(owner);
        registry.authorizeAgent(projectId, agent, registry.CAP_COMMIT() | registry.CAP_PROPOSE(), uint64(block.timestamp + 1 days));
        vm.prank(agent);
        registry.commitProject(projectId, keccak256("commit"), keccak256("tree"), keccak256("meta"));
        assertEq(registry.getProject(projectId).latestCommit, keccak256("commit"));
        assertTrue(registry.hasCapability(projectId, agent, registry.CAP_COMMIT()));
        assertFalse(registry.hasCapability(projectId, agent, registry.CAP_RELEASE()));
    }

    function testUnauthorizedAgentCannotCommit() public {
        register();
        vm.prank(user);
        vm.expectRevert(KilnOwnershipRegistry.NotAuthorizedAgent.selector);
        registry.commitProject(projectId, keccak256("commit"), keccak256("tree"), keccak256("meta"));
    }

    function testExpiredGrantCannotCommit() public {
        register();
        vm.prank(owner);
        registry.authorizeAgent(projectId, agent, registry.CAP_COMMIT(), uint64(block.timestamp + 1 hours));
        vm.warp(block.timestamp + 2 hours);
        vm.prank(agent);
        vm.expectRevert(KilnOwnershipRegistry.NotAuthorizedAgent.selector);
        registry.commitProject(projectId, keccak256("commit"), keccak256("tree"), keccak256("meta"));
    }

    function testRejectsUnknownCapabilityBits() public {
        register();
        vm.prank(owner);
        vm.expectRevert(KilnOwnershipRegistry.InvalidCapabilities.selector);
        registry.authorizeAgent(projectId, agent, 8, uint64(block.timestamp + 1 days));
    }

    function testRejectsZeroCommitAndTreeDigests() public {
        register();
        vm.prank(owner);
        vm.expectRevert(KilnOwnershipRegistry.InvalidDigest.selector);
        registry.commitProject(projectId, bytes32(0), keccak256("tree"), keccak256("meta"));
        vm.prank(owner);
        vm.expectRevert(KilnOwnershipRegistry.InvalidDigest.selector);
        registry.commitProject(projectId, keccak256("commit"), bytes32(0), keccak256("meta"));
    }

    function testTransferCanBeCancelled() public {
        register();
        vm.prank(owner);
        registry.transferProject(projectId, user);
        vm.prank(owner);
        registry.cancelTransfer(projectId);
        vm.prank(user);
        vm.expectRevert(KilnOwnershipRegistry.TransferNotPending.selector);
        registry.acceptTransfer(projectId);
    }

    function testTransferInvalidatesOldOwnerAgentGrants() public {
        register();
        vm.prank(owner);
        registry.authorizeAgent(projectId, agent, registry.CAP_COMMIT(), uint64(block.timestamp + 7 days));
        assertTrue(registry.hasCapability(projectId, agent, registry.CAP_COMMIT()));
        vm.prank(owner);
        registry.transferProject(projectId, user);
        vm.prank(user);
        registry.acceptTransfer(projectId);
        assertEq(registry.getProject(projectId).owner, user);
        assertEq(registry.getProject(projectId).authorizationEpoch, 2);
        assertFalse(registry.hasCapability(projectId, agent, registry.CAP_COMMIT()));
        vm.prank(agent);
        vm.expectRevert(KilnOwnershipRegistry.NotAuthorizedAgent.selector);
        registry.commitProject(projectId, keccak256("old-agent"), keccak256("tree"), keccak256("meta"));
    }
}
