# KILN Sovereign Network Layer

KILN's ownership registry is EVM-compatible so it can be validated on local Anvil and Monad testnet first. A sovereign KILN L1 is a later network milestone, not something implied by deploying a Solidity contract.

## Recommended network shape

Use a sovereign EVM execution layer with:

- deterministic EVM execution for the ownership registry and future KILN contracts;
- proof-of-stake validators with explicit staking, slashing, and upgrade governance;
- a native KILN fee token for transaction fees and validator economics;
- a separate indexer that serves public project history and verification pages;
- content-addressed Git/blob storage outside consensus;
- optional checkpointing to Ethereum or Monad for independent timestamp anchoring.

The first network release should prioritize predictable ownership transactions and receipts over general-purpose high-throughput claims.

## Validator responsibilities

Validators must:

1. execute and attest to blocks;
2. retain contract state and event history;
3. expose RPC and chain identity information;
4. participate in governance only through defined on-chain rules;
5. never receive user repository secrets or private workspace data.

A validator is not an owner of user code. Ownership remains an account-level contract state transition.

## Required modules

- EVM execution and JSON-RPC
- consensus and validator set management
- staking, rewards, and slashing
- chain parameters and upgrade governance
- fee market and transaction replay protection
- event indexing for projects, commits, licenses, and agent grants
- explorer/verifier API
- snapshot, backup, and disaster recovery tooling

## Rollout

### Phase 0: contract validation

- Run the Foundry suite.
- Deploy to Anvil.
- Exercise registration, commit anchoring, agent grants, and two-step transfer.
- Record the deployed bytecode and chain configuration.

### Phase 1: public EVM validation

- Deploy the same bytecode to Monad testnet.
- Connect KILN wallet/passkey accounts.
- Index events and serve the public verifier.
- Test repository proof challenges and account recovery.

### Phase 2: private devnet

- Run a small validator set in a reproducible local network.
- Test restart, state sync, validator rotation, upgrades, and RPC failure.
- Add fee and governance policies.
- Produce public genesis and chain-ID documentation.

### Phase 3: public testnet

- Publish binaries, genesis, validator requirements, RPC endpoints, explorer, and incident procedures.
- Run an external security review of consensus, bridges, account recovery, and ownership contracts.
- Do not accept production code ownership claims until the network can be independently reproduced.

### Phase 4: mainnet

- Freeze the genesis registry contract and chain parameters.
- Require audited release artifacts and reproducible builds.
- Establish emergency pause and upgrade rules that cannot silently rewrite ownership history.

## What KILN must not do

- Do not put source code or private workspace memory on-chain.
- Do not equate a GitHub handle with cryptographic ownership.
- Do not allow an agent key to transfer a project or broaden a license.
- Do not launch a token or mainnet before validator, recovery, and contract security review.
- Do not claim legal copyright transfer from an on-chain digest alone.

## Open decisions before implementation

- EVM sovereign-chain framework and consensus engine
- chain ID and native token economics
- validator admission and slashing policy
- account-abstraction and passkey implementation
- indexer/database choice
- bridge/checkpoint policy
- governance and emergency-upgrade authority
