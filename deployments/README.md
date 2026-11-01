# KILN deployment record

`chain.json` is the canonical record of where KilnOwnershipRegistry is actually
deployed. The app reads this file: no entry means "not anchored" — ownership,
commits, and agent grants are only claims in the forge until a deployment entry
(`chainId -> contract address, txHash, deployedAt`) flips the project to
anchored against a real on-chain registry.

Entries are added here by the deploy script run (see `script/`), never by hand.

## Target networks (verified live 2026-10-31, deploy-prep)

Multi-chain decision (architect, 2026-10-31): Robinhood Chain mainnet +
Monad. Facts below were confirmed by live `eth_chainId` calls to the
official RPCs during deploy prep — not copied from listings alone. No
deployment has been broadcast yet; `chain.json` stays empty until the
architect runs the broadcast with his own key.

| Network | Chain ID | Official public RPC | Explorer | Gas token | Live gas price at prep |
|---|---|---|---|---|---|
| Robinhood Chain (mainnet) | 4663 (`0x1237`) | `https://rpc.mainnet.chain.robinhood.com` | robinhoodchain.blockscout.com | ETH | 0.125 gwei |
| Monad testnet | 10143 (`0x279f`) | `https://testnet-rpc.monad.xyz` | testnet.monadexplorer.com | MON (testnet, faucet) | ~102 gwei (100 gwei base floor) |
| Monad mainnet (alternate) | 143 (`0x8f`) | `https://rpc.monad.xyz` | monadvision.com | MON | ~102 gwei |

Notes:

- `docs/KILN_SOVEREIGN_NETWORK.md` Phase 1 prescribes Monad **testnet** for
  public validation; mainnet is listed only as the verified alternate if
  the architect redirects.
- Simulated deploys (forge script, no broadcast, placeholder deployer)
  succeeded end-to-end on 4663 and 10143, including the `chain.json`
  recording step: ~2.15M total script gas; estimated cost ≈0.00027 ETH max
  on Robinhood Chain (well under $1) and ≈0.22–0.44 testnet MON on Monad.
- The registry address of a real deployment depends on the deployer's
  address and its nonce on that chain at broadcast time — it cannot be
  known until he runs it. Full packet: `~/workspace/kiln-l1-deploy/PACKET.md`.
