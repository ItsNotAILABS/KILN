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
        // Constant getters are external calls: read them before pranking so
        // the one-shot prank is not consumed by the getter calls.
        uint256 caps = registry.CAP_COMMIT() | registry.CAP_PROPOSE();
        vm.prank(owner);
        registry.authorizeAgent(projectId, agent, caps, uint64(block.timestamp + 1 days));
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
        // Read the constant before pranking: the getter is an external call
        // and would consume the one-shot prank.
        uint256 commitCap = registry.CAP_COMMIT();
        vm.prank(owner);
        registry.authorizeAgent(projectId, agent, commitCap, uint64(block.timestamp + 1 hours));
        vm.warp(block.timestamp + 2 hours);
        vm.prank(agent);
        vm.expectRevert(KilnOwnershipRegistry.NotAuthorizedAgent.selector);
        registry.commitProject(projectId, keccak256("commit"), keccak256("tree"), keccak256("meta"));
    }

    function testRejectsUnknownCapabilityBits() public {
        register();
        vm.prank(owner);
        vm.expectRevert(KilnOwnershipRegistry.InvalidCapabilities.selector);
        registry.authorizeAgent(projectId, agent, 16, uint64(block.timestamp + 1 days));
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
        // Read the constant before pranking: the getter is an external call
        // and would consume the one-shot prank.
        uint256 commitCap = registry.CAP_COMMIT();
        vm.prank(owner);
        registry.authorizeAgent(projectId, agent, commitCap, uint64(block.timestamp + 7 days));
        assertTrue(registry.hasCapability(projectId, agent, commitCap));
        vm.prank(owner);
        registry.transferProject(projectId, user);
        vm.prank(user);
        registry.acceptTransfer(projectId);
        assertEq(registry.getProject(projectId).owner, user);
        assertEq(registry.getProject(projectId).authorizationEpoch, 2);
        assertFalse(registry.hasCapability(projectId, agent, commitCap));
        vm.prank(agent);
        vm.expectRevert(KilnOwnershipRegistry.NotAuthorizedAgent.selector);
        registry.commitProject(projectId, keccak256("old-agent"), keccak256("tree"), keccak256("meta"));
    }

    // ---------- Agent delegation (clones) ----------

    event AgentDelegated(
        bytes32 indexed projectId,
        address indexed parentAgent,
        address indexed childAgent,
        uint256 capabilities,
        uint64 expiresAt
    );

    function _registerAndAuthorize(
        address agentAddr,
        uint256 caps,
        uint64 expiresAt
    ) internal {
        vm.prank(owner);
        registry.registerProject(projectId, "ipfs://project", owner, licenseId);
        vm.prank(owner);
        registry.authorizeAgent(projectId, agentAddr, caps, expiresAt);
    }

    function testOwnerAuthorizedGrantsHaveZeroParent() public {
        uint256 caps = registry.CAP_COMMIT() | registry.CAP_DELEGATE();
        uint64 expiry = uint64(block.timestamp + 1 days);
        _registerAndAuthorize(agent, caps, expiry);

        KilnOwnershipRegistry.AgentGrant memory grant = registry.getAgentGrant(projectId, agent);
        assertEq(grant.parent, address(0));
        assertEq(grant.capabilities, caps);
        assertEq(grant.expiresAt, expiry);
    }

    function testDelegateWithinScopeThenChildCommits() public {
        uint256 commitCap = registry.CAP_COMMIT();
        uint256 proposeCap = registry.CAP_PROPOSE();
        uint256 delegateCap = registry.CAP_DELEGATE();
        uint256 parentCaps = commitCap | proposeCap | delegateCap;
        uint64 parentExpiry = uint64(block.timestamp + 1 days);
        uint64 childExpiry = uint64(block.timestamp + 12 hours);
        address child = address(0xC111D);
        _registerAndAuthorize(agent, parentCaps, parentExpiry);

        vm.prank(agent);
        vm.expectEmit(true, true, true, true);
        emit AgentDelegated(projectId, agent, child, commitCap | proposeCap, childExpiry);
        registry.delegateGrant(projectId, child, commitCap | proposeCap, childExpiry);

        KilnOwnershipRegistry.AgentGrant memory grant = registry.getAgentGrant(projectId, child);
        assertEq(grant.capabilities, commitCap | proposeCap);
        assertEq(grant.expiresAt, childExpiry);
        assertEq(grant.parent, agent);

        vm.prank(child);
        registry.commitProject(projectId, keccak256("child-commit"), keccak256("tree"), keccak256("meta"));
        assertEq(registry.getProject(projectId).latestCommit, keccak256("child-commit"));
    }

    function testChildCanDelegateItsOwnSubset() public {
        uint256 commitCap = registry.CAP_COMMIT();
        uint256 delegateCap = registry.CAP_DELEGATE();
        uint256 parentCaps = commitCap | delegateCap;
        uint64 childExpiry = uint64(block.timestamp + 12 hours);
        uint64 grandchildExpiry = uint64(block.timestamp + 6 hours);
        address child = address(0xC111D);
        address grandchild = address(0xD00D);
        _registerAndAuthorize(agent, parentCaps, uint64(block.timestamp + 1 days));

        vm.prank(agent);
        registry.delegateGrant(projectId, child, parentCaps, childExpiry);

        vm.prank(child);
        registry.delegateGrant(projectId, grandchild, commitCap, grandchildExpiry);

        KilnOwnershipRegistry.AgentGrant memory grant = registry.getAgentGrant(projectId, grandchild);
        assertEq(grant.parent, child);

        vm.prank(grandchild);
        registry.commitProject(projectId, keccak256("grandchild-commit"), keccak256("tree"), keccak256("meta"));
        assertEq(registry.getProject(projectId).latestCommit, keccak256("grandchild-commit"));
    }

    function testCannotExceedParentCaps() public {
        uint256 commitCap = registry.CAP_COMMIT();
        uint256 delegateCap = registry.CAP_DELEGATE();
        uint256 releaseCap = registry.CAP_RELEASE();
        uint256 parentCaps = commitCap | delegateCap;
        address child = address(0xC111D);
        _registerAndAuthorize(agent, parentCaps, uint64(block.timestamp + 1 days));

        vm.prank(agent);
        vm.expectRevert(KilnOwnershipRegistry.ExceedsParentGrant.selector);
        registry.delegateGrant(
            projectId,
            child,
            parentCaps | releaseCap,
            uint64(block.timestamp + 12 hours)
        );

        // Child grant was not created.
        assertEq(registry.getAgentGrant(projectId, child).expiresAt, 0);
    }

    function testCannotExceedParentExpiry() public {
        uint256 commitCap = registry.CAP_COMMIT();
        uint256 delegateCap = registry.CAP_DELEGATE();
        uint256 parentCaps = commitCap | delegateCap;
        uint64 parentExpiry = uint64(block.timestamp + 1 days);
        address child = address(0xC111D);
        _registerAndAuthorize(agent, parentCaps, parentExpiry);

        vm.prank(agent);
        vm.expectRevert(KilnOwnershipRegistry.ExceedsParentGrant.selector);
        registry.delegateGrant(projectId, child, commitCap, uint64(block.timestamp + 2 days));
    }

    function testAgentWithoutDelegateCapCannotDelegate() public {
        uint256 commitCap = registry.CAP_COMMIT();
        address child = address(0xC111D);
        _registerAndAuthorize(agent, commitCap, uint64(block.timestamp + 1 days));

        vm.prank(agent);
        vm.expectRevert(KilnOwnershipRegistry.NotAuthorizedAgent.selector);
        registry.delegateGrant(projectId, child, commitCap, uint64(block.timestamp + 12 hours));
    }

    function testExpiredAgentCannotDelegate() public {
        uint256 commitCap = registry.CAP_COMMIT();
        uint256 delegateCap = registry.CAP_DELEGATE();
        address child = address(0xC111D);
        _registerAndAuthorize(agent, commitCap | delegateCap, uint64(block.timestamp + 1 days));

        vm.warp(block.timestamp + 2 days);

        vm.prank(agent);
        vm.expectRevert(KilnOwnershipRegistry.NotAuthorizedAgent.selector);
        registry.delegateGrant(projectId, child, commitCap, uint64(block.timestamp + 1 hours));
    }

    function testCascadeRevokeKillsChildrenButNotSiblings() public {
        uint256 commitCap = registry.CAP_COMMIT();
        uint256 delegateCap = registry.CAP_DELEGATE();
        address agentB = address(0xB0B2); // sibling of `agent`
        address childC = address(0xC111D);
        address grandchildD = address(0xD00D);
        uint64 expiry = uint64(block.timestamp + 1 days);
        _registerAndAuthorize(agent, commitCap | delegateCap, expiry);

        vm.prank(owner);
        registry.authorizeAgent(projectId, agentB, commitCap, expiry);

        vm.prank(agent);
        registry.delegateGrant(projectId, childC, commitCap | delegateCap, expiry);
        vm.prank(childC);
        registry.delegateGrant(projectId, grandchildD, commitCap, expiry);

        vm.prank(owner);
        registry.revokeAuthorization(projectId, agent);

        // Whole delegation subtree is gone, including the grandchild.
        assertEq(registry.getAgentGrant(projectId, agent).expiresAt, 0);
        assertEq(registry.getAgentGrant(projectId, childC).expiresAt, 0);
        assertEq(registry.getAgentGrant(projectId, grandchildD).expiresAt, 0);

        // Sibling subtree is untouched.
        assertEq(registry.getAgentGrant(projectId, agentB).expiresAt, expiry);

        // A revoked child can no longer commit.
        vm.prank(childC);
        vm.expectRevert(KilnOwnershipRegistry.NotAuthorizedAgent.selector);
        registry.commitProject(projectId, keccak256("x"), keccak256("y"), keccak256("z"));
    }

    function testRevokeOnChildOnlyKillsItsSubtree() public {
        uint256 commitCap = registry.CAP_COMMIT();
        uint256 delegateCap = registry.CAP_DELEGATE();
        address childC = address(0xC111D);
        address grandchildD = address(0xD00D);
        uint64 expiry = uint64(block.timestamp + 1 days);
        _registerAndAuthorize(agent, commitCap | delegateCap, expiry);

        vm.prank(agent);
        registry.delegateGrant(projectId, childC, commitCap | delegateCap, expiry);
        vm.prank(childC);
        registry.delegateGrant(projectId, grandchildD, commitCap, expiry);

        // Owner revokes just the child: parent stays, grandchild dies.
        vm.prank(owner);
        registry.revokeAuthorization(projectId, childC);

        assertEq(registry.getAgentGrant(projectId, agent).expiresAt, expiry);
        assertEq(registry.getAgentGrant(projectId, childC).expiresAt, 0);
        assertEq(registry.getAgentGrant(projectId, grandchildD).expiresAt, 0);
    }
}
