/**
 * Chain adapter registry.
 *
 * Every chain KILN talks to implements the methods on BaseAdapter.
 * Register new chains here; do not scatter RPC calls through the swarm.
 */
import { envOr, ethereumRpcFromEnv } from "./chains.mjs";
import { DEFAULT_PORTS } from "./base-adapter.mjs";
import { SolanaAdapter } from "./solana-adapter.mjs";
import { KilnSvmAdapter } from "./kiln-svm-adapter.mjs";
import { EthereumAdapter } from "./ethereum-adapter.mjs";

export { BaseAdapter, DEFAULT_PORTS } from "./base-adapter.mjs";

const factories = {
  solana: (opts = {}) => new SolanaAdapter(opts),
  "kiln-svm": (opts = {}) => new KilnSvmAdapter(opts),
  ethereum: (opts = {}) => new EthereumAdapter(opts),
};

export const ADAPTER_IDS = Object.keys(factories);

export function openAdapter(id, opts = {}) {
  const fn = factories[id];
  if (!fn) throw new Error(`unknown chain adapter ${JSON.stringify(id)} (known: ${ADAPTER_IDS.join(", ")})`);
  return fn(opts);
}

/** Open the three built-in adapters using env defaults. */
export function openDefaultAdapters() {
  return {
    solana: openAdapter("solana", { rpcUrl: envOr("KILN_SOLANA_RPC_URL", "http://127.0.0.1:8899") }),
    "kiln-svm": openAdapter("kiln-svm", { rpcUrl: envOr("KILN_SVM_RPC_URL", `http://127.0.0.1:${DEFAULT_PORTS.kilnSvmRpc}`) }),
    ethereum: openAdapter("ethereum", { rpcUrl: ethereumRpcFromEnv(`http://127.0.0.1:${DEFAULT_PORTS.ethereum}`) }),
  };
}
