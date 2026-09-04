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

    function setUp() public {
        registry = new KilnOwnershipRegistry();
    }

    function testRegisterAndAnchorCommit() public {
        vm.prank(owner);
        registry.registerProject(projectId, "https://github.com/ItsNotAILABS/KILN", owner, licenseId);

        vm.prank(owner);
        registry.commitProject(projectId, keccak256("git-commit"), keccak256("git-tree"), keccak256("metadata"));

        KilnOwnershipRegistry.Project memory project = registry.getProject(projectId);
        assertEq(project.owner, owner);
        assertEq(project.latestCommit, keccak256("git-commit"));
        assertEq(project.latestTree, keccak256("git-tree"));
    }

    function testAgentCanAnchorWithinScope() public {
        vm.prank(owner);
        registry.registerProject(projectId, "ipfs://project", owner, licenseId);

        vm.prank(owner);
        registry.authorizeAgent(projectId, agent, registry.CAP_COMMIT() | registry.CAP_PROPOSE(), uint64(block.timestamp + 1 days));

        vm.prank(agent);
        registry.commitProject(projectId, keccak256("commit"), keccak256("tree"), keccak256("meta"));

        assertEq(registry.getProject(projectId).latestCommit, keccak256("commit"));
    }

    function testUnauthorizedAgentCannotCommit() public {
        vm.prank(owner);
        registry.registerProject(projectId, "ipfs://project", owner, licenseId);

        vm.prank(user);
        vm.expectRevert(KilnOwnershipRegistry.NotAuthorizedAgent.selector);
        registry.commitProject(projectId, keccak256("commit"), keccak256("tree"), keccak256("meta"));
    }

    function testTransferRequiresRecipientAcceptance() public {
        vm.prank(owner);
        registry.registerProject(projectId, "ipfs://project", owner, licenseId);

        vm.prank(owner);
        registry.transferProject(projectId, user);
        assertEq(registry.getProject(projectId).owner, owner);

        vm.prank(user);
        registry.acceptTransfer(projectId);
        assertEq(registry.getProject(projectId).owner, user);
    }
}
