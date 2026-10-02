# KILN deployment record

`chain.json` is the canonical record of where KilnOwnershipRegistry is actually
deployed. The app reads this file: no entry means "not anchored" — ownership,
commits, and agent grants are only claims in the forge until a deployment entry
(`chainId -> contract address, txHash, deployedAt`) flips the project to
anchored against a real on-chain registry.

Entries are added here by the deploy script run (see `script/`), never by hand.
