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

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function isLoopbackHost(hostname) {
  const h = String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  return LOOPBACK_HOSTS.has(h);
}

export function isLocalhostUrl(url) {
  try {
    const u = new URL(String(url));
    return (u.protocol === "http:" || u.protocol === "https:") && isLoopbackHost(u.hostname);
  } catch {
    return false;
  }
}

const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/**
 * Normalize an Ethereum RPC URL from env or a caller.
 * Trims whitespace, prepends https:// when no scheme is present,
 * and refuses http:// for non-loopback hosts. Error messages never
 * include the URL.
 */
export function normalizeEthRpcUrl(raw) {
  if (raw == null || String(raw).trim() === "") {
    throw new Error("ethereum: RPC URL is empty");
  }
  let s = String(raw).trim();
  if (s.startsWith("//")) s = "https:" + s;
  else if (!HAS_SCHEME.test(s)) s = "https://" + s;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error("ethereum: invalid RPC URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("ethereum: RPC URL must be http or https");
  }
  if (u.protocol === "http:" && !isLoopbackHost(u.hostname)) {
    throw new Error("ethereum: refusing http:// RPC for a non-loopback host (use https://)");
  }
  return u.href;
}

/** Safe label for logs and CLI. Loopback URLs are shown; anything else is redacted. */
export function publicRpcLabel(url) {
  try {
    if (url && isLocalhostUrl(url)) return String(url);
  } catch { /* fall through */ }
  return "[redacted-rpc]";
}

/** Strip a URL and its host/path pieces out of an error message. */
export function sanitizeErrorMessage(message, url) {
  let msg = String(message ?? "");
  if (!url) return msg;
  const pieces = new Set();
  const add = (v) => {
    if (v == null) return;
    const s = String(v).trim();
    if (s.length >= 4) pieces.add(s);
  };
  add(url);
  add(String(url).trim());
  try {
    const withScheme = HAS_SCHEME.test(String(url).trim()) ? String(url).trim() : "https://" + String(url).trim();
    const u = new URL(withScheme);
    add(u.href);
    add(u.origin);
    add(u.host);
    add(u.hostname);
    add(u.pathname);
    add(`${u.host}${u.pathname}`);
    add(String(url).replace(/^https?:\/\//i, "").trim());
  } catch { /* ignore parse failures */ }
  // Longest first so we don't leave remnants of a path after replacing the host.
  for (const piece of [...pieces].sort((a, b) => b.length - a.length)) {
    if (piece.length < 4) continue;
    msg = msg.split(piece).join("[redacted]");
  }
  return msg;
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
    throw new Error(`refusing submit on ${label}: RPC ${publicRpcLabel(rpcUrl)} is not on the allow-list (localhost, and Solana devnet/testnet for the shared Solana adapter only)`);
  }
}

export function envOr(name, fallback) {
  const v = process.env[name];
  return v != null && String(v).trim() !== "" ? String(v).trim() : fallback;
}

/** Ethereum RPC: owner-supplied Cloudflare gateway, or local Anvil. Never hardcoded. */
export function ethereumRpcFromEnv(defaultLocal = "http://127.0.0.1:18545") {
  const raw = envOr("KILN_ETH_RPC_URL", envOr("CLOUDFLARE_ETH_GATEWAY_URL", defaultLocal));
  return normalizeEthRpcUrl(raw);
}

export function optionalEthHeaders() {
  const token = envOr("KILN_ETH_RPC_TOKEN", envOr("CLOUDFLARE_ETH_GATEWAY_TOKEN", ""));
  if (!token) return undefined;
  return { authorization: `Bearer ${token}` };
}
