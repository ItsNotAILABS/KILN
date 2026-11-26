# KILN L1 runtime

Architecture: [docs/KILN_L1.md](../docs/KILN_L1.md).

This directory is the working adapter layer and the local-devnet launchers
for KILN's multi-chain L1: a KILN SVM chain (Agave / `solana-test-validator`),
shared Solana, and Ethereum (Anvil or a configured Cloudflare gateway URL).

```bash
node l1/kiln-l1.mjs --help
node --test l1/test/*.test.mjs
```

Submit is refused on mainnet. Tests start local validators only and skip
when `solana-test-validator` or `anvil` is not on `PATH`.

Environment (no secrets in git):

| Variable | Purpose |
|---|---|
| `KILN_SOLANA_RPC_URL` | Shared Solana RPC (default `http://127.0.0.1:8899`) |
| `KILN_SVM_RPC_URL` | KILN-SVM RPC (default `http://127.0.0.1:18899`) |
| `KILN_ETH_RPC_URL` or `CLOUDFLARE_ETH_GATEWAY_URL` | Ethereum RPC |
| `KILN_ETH_RPC_TOKEN` | Optional bearer token for the gateway |

`l1/.devnet/` is local state (ledgers, pids, logs) and is gitignored.
