/**
 * Opt-in read-only Ethereum smoke checks.
 * Runs only when KILN_ETH_RPC_URL (or CLOUDFLARE_ETH_GATEWAY_URL) is set.
 * Never logs the RPC URL. Writes and submits stay refused.
 *
 * Some Cloudflare Web3 gateways answer eth_chainId but not every
 * method (eth_blockNumber / eth_getBalance may return a gateway
 * error). The smoke still attempts all three and reports each result.
 */
import { EthereumAdapter } from "./ethereum-adapter.mjs";

/** Ethereum 2 / Beacon deposit contract — a well-known public mainnet address. */
export const ETH_SMOKE_ADDRESS = "0x00000000219ab540356cBB839Cbe05303d7705Fa";

export function ethRpcConfigured() {
  for (const name of ["KILN_ETH_RPC_URL", "CLOUDFLARE_ETH_GATEWAY_URL"]) {
    const v = process.env[name];
    if (v != null && String(v).trim() !== "") return true;
  }
  return false;
}

function errorText(e) {
  return String(e && e.message ? e.message : e);
}

/**
 * Read-only probe: eth_chainId, eth_blockNumber, and a balance read.
 * chainId is required (throws if it fails). Block and balance errors
 * are returned in `errors` so callers can report them without leaking
 * the RPC URL. Does not submit.
 */
export async function readOnlyEthSmoke(adapter = new EthereumAdapter()) {
  const chainId = await adapter.getChainId();
  const errors = {};
  let blockNumber = null;
  try {
    const blockHex = await adapter.rpc("eth_blockNumber", []);
    const n = Number(blockHex);
    if (!Number.isInteger(n) || n < 0) {
      errors.blockNumber = "eth_blockNumber did not return a non-negative integer";
    } else {
      blockNumber = n;
    }
  } catch (e) {
    errors.blockNumber = errorText(e);
  }

  let balanceOk = false;
  try {
    const bal = await adapter.getBalance(ETH_SMOKE_ADDRESS);
    if (bal == null || bal.unit !== "wei" || typeof bal.amount !== "bigint") {
      errors.balance = "balance read did not return a wei amount";
    } else {
      balanceOk = true;
    }
  } catch (e) {
    errors.balance = errorText(e);
  }

  return { chainId, blockNumber, balanceOk, errors };
}
