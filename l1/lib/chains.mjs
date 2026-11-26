/**
 * Chain identifiers, RPC allow-lists, and the mainnet-submit refusal.
 * Public mainnet is never a legal submit target in this tree.
 */

export const NETWORK = Object.freeze({
  local: "local",
  devnet: "devnet",
  testnet: "testnet",
  mainnet: "mainnet",
});

/** Official Solana public RPCs we may *submit* to, plus loopback. Mainnet is not listed. */
export const SOLANA_SUBMIT_RPC = [
  /^https:\/\/api\.devnet\.solana\.com\/?$/,
  /^https:\/\/api\.testnet\.solana\.com\/?$/,
  /^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/,
];

/** KILN-SVM submits only go to a process on this machine. */
export const KILN_SVM_SUBMIT_RPC = [
  /^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/,
];

/** Ethereum submits only go to a process on this machine (Anvil). */
export const ETHEREUM_SUBMIT_RPC = [
  /^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/,
];

const MAINNET_SVM_RPC = [
  /mainnet-beta\.solana\.com/i,
  /api\.mainnet\.solana/i,
  /solana-mainnet/i,
];

export function isLocalhostUrl(url) {
  try {
    const u = new URL(String(url));
    return (u.protocol === "http:" || u.protocol === "https:")
      && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
  } catch {
    return false;
  }
}

export function classifySvmNetwork(url) {
  const s = String(url);
  if (isLocalhostUrl(s)) return NETWORK.local;
  if (/api\.devnet\.solana\.com/i.test(s)) return NETWORK.devnet;
  if (/api\.testnet\.solana\.com/i.test(s)) return NETWORK.testnet;
  if (MAINNET_SVM_RPC.some((re) => re.test(s))) return NETWORK.mainnet;
  return NETWORK.devnet; // unknown public URL: treat cautiously; submit still allow-listed
}

export function allowedSubmit(url, allowList) {
  return allowList.some((re) => re.test(String(url)));
}

/**
 * Throw if this adapter must not broadcast.
 * Refuses mainnet by network name or chain id, and any URL outside the allow-list.
 */
export function assertCanSubmit({ network, chainId, rpcUrl, allowList, label }) {
  if (network === NETWORK.mainnet) {
    throw new Error(`refusing submit on ${label}: mainnet is not allowed`);
  }
  if (chainId === 1 || chainId === "1" || chainId === "mainnet-beta") {
    throw new Error(`refusing submit on ${label}: mainnet chain id is not allowed`);
  }
  if (!allowedSubmit(rpcUrl, allowList)) {
    throw new Error(`refusing submit on ${label}: RPC ${rpcUrl} is not on the allow-list (localhost, and Solana devnet/testnet for the shared Solana adapter only)`);
  }
}

export function envOr(name, fallback) {
  const v = process.env[name];
  return v != null && String(v).trim() !== "" ? String(v).trim() : fallback;
}

/** Ethereum RPC: owner-supplied Cloudflare gateway, or local Anvil. Never hardcoded. */
export function ethereumRpcFromEnv(defaultLocal = "http://127.0.0.1:18545") {
  return envOr("KILN_ETH_RPC_URL", envOr("CLOUDFLARE_ETH_GATEWAY_URL", defaultLocal));
}

export function optionalEthHeaders() {
  const token = envOr("KILN_ETH_RPC_TOKEN", envOr("CLOUDFLARE_ETH_GATEWAY_TOKEN", ""));
  if (!token) return undefined;
  return { authorization: `Bearer ${token}` };
}
