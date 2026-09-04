// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title KILN Ownership Registry
/// @notice Anchors project ownership, Git provenance, licenses, and bounded agent
/// capabilities. Source code remains in Git/content-addressed storage.
contract KilnOwnershipRegistry {
    uint256 public constant CAP_COMMIT = 1;
    uint256 public constant CAP_RELEASE = 2;
    uint256 public constant CAP_PROPOSE = 4;

    struct Project {
        address owner;
        address pendingOwner;
        string repositoryUri;
        bytes32 licenseId;
        bytes32 latestCommit;
        bytes32 latestTree;
        bytes32 metadataDigest;
        uint64 registeredAt;
        uint64 updatedAt;
    }

    struct AgentGrant {
        uint256 capabilities;
        uint64 expiresAt;
    }

    mapping(bytes32 => Project) private projects;
    mapping(bytes32 => mapping(address => AgentGrant)) private agentGrants;
    mapping(bytes32 => mapping(address => uint256)) private licensePermissions;

    error ProjectAlreadyRegistered();
    error ProjectNotFound();
    error NotProjectOwner();
    error NotAuthorizedAgent();
    error InvalidProjectId();
    error InvalidOwner();
    error TransferNotPending();
    error GrantExpired();

    event ProjectRegistered(
        bytes32 indexed projectId,
        address indexed owner,
        string repositoryUri,
        bytes32 indexed licenseId,
        uint64 timestamp
    );
    event CommitAnchored(
        bytes32 indexed projectId,
        address indexed actor,
        bytes32 indexed gitCommit,
        bytes32 treeDigest,
        bytes32 metadataDigest,
        uint64 timestamp
    );
    event LicenseGranted(
        bytes32 indexed projectId,
        address indexed grantee,
        uint256 permissions,
        uint64 timestamp
    );
    event AgentAuthorized(
        bytes32 indexed projectId,
        address indexed agent,
        uint256 capabilities,
        uint64 expiresAt
    );
    event AgentAuthorizationRevoked(bytes32 indexed projectId, address indexed agent);
    event TransferProposed(bytes32 indexed projectId, address indexed currentOwner, address indexed recipient);
    event TransferAccepted(bytes32 indexed projectId, address indexed previousOwner, address indexed newOwner);

    modifier projectOwner(bytes32 projectId) {
        if (projects[projectId].owner == address(0)) revert ProjectNotFound();
        if (projects[projectId].owner != msg.sender) revert NotProjectOwner();
        _;
    }

    function registerProject(
        bytes32 projectId,
        string calldata repositoryUri,
        address owner,
        bytes32 licenseId
    ) external {
        if (projectId == bytes32(0)) revert InvalidProjectId();
        if (owner == address(0)) revert InvalidOwner();
        if (projects[projectId].owner != address(0)) revert ProjectAlreadyRegistered();

        uint64 nowTs = uint64(block.timestamp);
        projects[projectId] = Project({
            owner: owner,
            pendingOwner: address(0),
            repositoryUri: repositoryUri,
            licenseId: licenseId,
            latestCommit: bytes32(0),
            latestTree: bytes32(0),
            metadataDigest: bytes32(0),
            registeredAt: nowTs,
            updatedAt: nowTs
        });

        emit ProjectRegistered(projectId, owner, repositoryUri, licenseId, nowTs);
    }

    function commitProject(
        bytes32 projectId,
        bytes32 gitCommit,
        bytes32 treeDigest,
        bytes32 metadataDigest
    ) external {
        Project storage project = projects[projectId];
        if (project.owner == address(0)) revert ProjectNotFound();

        if (msg.sender != project.owner) {
            AgentGrant memory grant = agentGrants[projectId][msg.sender];
            if (grant.expiresAt < block.timestamp || grant.capabilities & CAP_COMMIT == 0) {
                revert NotAuthorizedAgent();
            }
        }

        project.latestCommit = gitCommit;
        project.latestTree = treeDigest;
        project.metadataDigest = metadataDigest;
        project.updatedAt = uint64(block.timestamp);

        emit CommitAnchored(
            projectId,
            msg.sender,
            gitCommit,
            treeDigest,
            metadataDigest,
            uint64(block.timestamp)
        );
    }

    function grantLicense(
        bytes32 projectId,
        address grantee,
        uint256 permissions
    ) external projectOwner(projectId) {
        if (grantee == address(0)) revert InvalidOwner();
        licensePermissions[projectId][grantee] = permissions;
        emit LicenseGranted(projectId, grantee, permissions, uint64(block.timestamp));
    }

    function authorizeAgent(
        bytes32 projectId,
        address agent,
        uint256 capabilities,
        uint64 expiresAt
    ) external projectOwner(projectId) {
        if (agent == address(0)) revert InvalidOwner();
        if (expiresAt <= block.timestamp) revert GrantExpired();
        agentGrants[projectId][agent] = AgentGrant(capabilities, expiresAt);
        emit AgentAuthorized(projectId, agent, capabilities, expiresAt);
    }

    function revokeAuthorization(bytes32 projectId, address agent)
        external
        projectOwner(projectId)
    {
        delete agentGrants[projectId][agent];
        emit AgentAuthorizationRevoked(projectId, agent);
    }

    function transferProject(bytes32 projectId, address recipient)
        external
        projectOwner(projectId)
    {
        if (recipient == address(0)) revert InvalidOwner();
        projects[projectId].pendingOwner = recipient;
        projects[projectId].updatedAt = uint64(block.timestamp);
        emit TransferProposed(projectId, msg.sender, recipient);
    }

    function acceptTransfer(bytes32 projectId) external {
        Project storage project = projects[projectId];
        if (project.owner == address(0)) revert ProjectNotFound();
        if (project.pendingOwner != msg.sender) revert TransferNotPending();

        address previousOwner = project.owner;
        project.owner = msg.sender;
        project.pendingOwner = address(0);
        project.updatedAt = uint64(block.timestamp);

        emit TransferAccepted(projectId, previousOwner, msg.sender);
    }

    function getProject(bytes32 projectId) external view returns (Project memory) {
        if (projects[projectId].owner == address(0)) revert ProjectNotFound();
        return projects[projectId];
    }

    function getAgentGrant(bytes32 projectId, address agent)
        external
        view
        returns (AgentGrant memory)
    {
        return agentGrants[projectId][agent];
    }

    function getLicensePermissions(bytes32 projectId, address grantee)
        external
        view
        returns (uint256)
    {
        return licensePermissions[projectId][grantee];
    }
}
