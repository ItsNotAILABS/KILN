# KILN Account and Signing Flow

## Account model

A KILN account is an identity controlled by a wallet, passkey, or smart account. The account owns projects and authorizes agents; a GitHub username is only an external repository identity.

The first release should support:

- EVM wallet connection for direct signing.
- Passkey/WebAuthn recovery through an account-abstraction smart account.
- Organization accounts with multiple members and role-based approvals.
- A separate agent key with expiry and capability limits.
- Session keys that cannot transfer projects, broaden licenses, or deploy without approval.

## Registration

1. The user signs into KILN.
2. KILN verifies control of the external repository through an OAuth installation or signed challenge.
3. KILN computes the Git commit and tree digests in the user workspace.
4. The user signs a typed registration request containing chain ID, contract address, project ID, repository URI, digest, license, nonce, and expiry.
5. The transaction registers the project on the selected KILN network.
6. KILN indexes the emitted event and publishes a verification page.

## Agent work

Agents receive a narrowly scoped capability:

- PROPOSE can prepare a diff and receipt.
- COMMIT can anchor an already-approved commit digest.
- RELEASE can publish a release record only after policy approval.

Agents never receive the owner key. Every request includes an account ID, project ID, workspace ID, capability, nonce, and expiry.

## Transfer and licenses

Project transfer is two-step: the current owner proposes a recipient, then the recipient accepts. License grants are explicit and independently queryable. Expanding permissions is a new owner action; agents cannot do it.

## Privacy

Public chain data includes project IDs, code digests, ownership events, licenses, capability events, and timestamps. Private source, secrets, prompts, memory, and workspace contents remain off-chain and tenant-isolated.

## Network rollout

- Local Anvil chain for contract development.
- Monad testnet for early EVM validation and wallet integration.
- KILN sovereign network after contract, account, indexing, and governance audits.
- Optional Ethereum/Monad checkpointing for external verification.

No production deployment should occur until the contract, account recovery, indexing, and transfer flows have independent security review.
