# KILN L1: Code Ownership and Provenance

KILN is planned as an EVM-compatible Layer 1 for user-controlled code identity, provenance, and governed execution.

## What ownership means

KILN cannot create legal copyright ownership by itself. It can provide strong cryptographic proof that an account controlled a signing key, registered a code digest, and authorized a repository or workspace action at a specific time. Legal license and transfer terms remain explicit metadata and off-chain agreements.

The ownership primitive is:

`owner + repository + commit/tree digest + license terms + timestamp + signature`

Source code stays in Git-compatible storage. KILN stores compact commitments, signatures, authorization changes, and receipts.

## Core objects

- **Account** — wallet or passkey-backed identity. Human-readable handles are optional.
- **Project** — a public repository or application namespace.
- **Workspace** — an account- or organization-scoped working environment.
- **Code commitment** — a content-addressed Git commit/tree digest registered on KILN.
- **License grant** — explicit permissions such as view, fork, modify, commercial use, or sublicense.
- **Agent authorization** — a bounded capability allowing an agent to propose changes without owning or transferring the project.
- **Receipt** — immutable record linking actor, action, policy decision, source digest, and resulting commit.

## Ownership rules

1. Registering a digest proves control of the signing account at registration time; it is not a substitute for legal title.
2. Every project has an owner account or organization and an explicit license.
3. Agents may propose and prepare changes, but cannot transfer ownership or grant broader rights.
4. Ownership transfer requires the current owner signature and recipient acceptance.
5. Releases, deployments, wallet actions, and destructive repository operations require explicit policy approval.
6. Public metadata is readable by everyone; private workspace content, secrets, prompts, and memory remain tenant-isolated.
7. A KILN receipt must never contain private keys, API secrets, or raw private source.

## L1 architecture

- **Execution:** EVM-compatible KILN chain.
- **Settlement contract:** project ownership, commit commitments, licenses, transfers, and agent capabilities.
- **Identity:** wallet plus passkey/account-abstraction support; recovery is an explicit policy.
- **Data:** Git repositories, content-addressed blobs, and encrypted workspace storage remain off-chain.
- **Indexing:** an indexer materializes project history, ownership events, license grants, and receipts for KILN search.
- **MCP/API:** KILN validates account scope and capability tokens before allowing agents to propose or execute actions.
- **Bridges:** optional anchors to Ethereum/Monad for externally verifiable checkpoints; bridges are not required for local development.

## First contract surface

The first production contract should expose:

- `registerProject(projectId, repositoryUri, owner, licenseId)`
- `commitProject(projectId, gitCommit, treeDigest, metadataDigest)`
- `grantLicense(projectId, grantee, permissions, expiry)`
- `authorizeAgent(projectId, agent, capabilities, expiry)`
- `transferProject(projectId, recipient)`
- `acceptTransfer(projectId)`
- `revokeAuthorization(projectId, subject)`
- `getProject(projectId)`

All mutation methods emit events containing the project ID, actor, digest, and policy reference. Contract storage should contain commitments and rights, not source files.

## User flow

1. A user creates an account with a wallet or passkey.
2. They import or create a repository in KILN.
3. KILN computes the Git commit/tree digest locally and asks the account to sign the registration.
4. The ownership commitment is written to the L1.
5. Agents can work in a scoped workspace and produce proposed commits.
6. The owner reviews the diff, approves the capability use, and signs the commit/release.
7. KILN publishes a receipt linking the resulting commit to the on-chain commitment.
8. Anyone can independently verify the owner, digest, license, and approval trail.

## MVP boundary

The first milestone is not a new decentralized compute economy. It is a verifiable ownership and provenance registry with:

- one EVM testnet;
- wallet/passkey account creation;
- project registration;
- Git commit anchoring;
- explicit license grants;
- agent capability scopes;
- public verification pages;
- tenant-isolated private workspaces;
- indexed receipts and audit history.

After that foundation is stable, KILN can add validator operation, native fees, governance, decentralized storage, and cross-chain checkpoints.

## Non-negotiable security constraints

- Never infer ownership from a Git username alone.
- Never let an agent hold an owner key.
- Never accept an unscoped capability token.
- Never put private source, secrets, or personal memory on a public chain.
- Require replay protection, expiry, chain ID, and domain separation for signed actions.
- Treat ownership transfer, license expansion, and deployment as high-risk actions requiring owner approval.
