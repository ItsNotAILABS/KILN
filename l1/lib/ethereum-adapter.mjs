/**
 * Ethereum adapter. Reads from a configured JSON-RPC URL (Cloudflare
 * Ethereum gateway or Anvil). Submits only to localhost; chain id 1 is
 * always refused. No gateway URL or token is stored in the repo.
 *
 * Local writes use eth_sendTransaction against Anvil's unlocked accounts
 * (the owner still signs on a real chain; this tree never broadcasts there).
 */
import {
  NETWORK, ETHEREUM_SUBMIT_RPC, assertCanSubmit, ethereumRpcFromEnv,
  isLocalhostUrl, optionalEthHeaders, normalizeEthRpcUrl, publicRpcLabel,
} from "./chains.mjs";
import { rpc } from "./rpc.mjs";
import { BaseAdapter } from "./base-adapter.mjs";
import { rlpEncode } from "./rlp.mjs";
import { keccak256, keccak256Hex } from "./keccak.mjs";

function hexToBig(hex) {
  if (hex == null || hex === "0x") return 0n;
  return BigInt(hex);
}

function toHex(value) {
  if (typeof value === "string" && value.startsWith("0x")) return value;
  const n = BigInt(value);
  return "0x" + n.toString(16);
}

function strip0x(s) {
  return String(s).replace(/^0x/i, "");
}

export function normalizeAddress(addr) {
  const h = strip0x(addr).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(h)) throw new Error(`ethereum: bad address ${addr}`);
  return "0x" + h;
}

/** Build an unsigned EIP-155 legacy transaction (fields + RLP payload). */
export function buildLegacyTx({ nonce, gasPrice, gas, to, value, data = "0x", chainId }) {
  const fields = [nonce, gasPrice, gas, to, value, data, chainId, 0, 0].map((v, i) => {
    if (i === 3) return Buffer.from(strip0x(to), "hex"); // address
    if (i === 5) return Buffer.from(strip0x(data || "0x"), "hex");
    return BigInt(v ?? 0);
  });
  const unsigned = rlpEncode(fields);
  return {
    kind: "evm-legacy-transfer",
    nonce, gasPrice, gas, to, value, data: data || "0x", chainId,
    unsigned: "0x" + unsigned.toString("hex"),
    sighash: "0x" + keccak256Hex(unsigned),
  };
}

export class EthereumAdapter extends BaseAdapter {
  constructor(opts = {}) {
    super();
    this._rpcUrl = normalizeEthRpcUrl(opts.rpcUrl || ethereumRpcFromEnv());
    this._headers = opts.headers || optionalEthHeaders();
    this._allow = opts.allowList || ETHEREUM_SUBMIT_RPC;
    this._chainId = opts.chainId ?? null;
  }
  get id() { return "ethereum"; }
  get family() { return "evm"; }
  get rpcUrl() { return this._rpcUrl; }
  get network() {
    if (isLocalhostUrl(this._rpcUrl)) return NETWORK.local;
    if (this._chainId === 1) return NETWORK.mainnet;
    return NETWORK.testnet;
  }

  rpc(method, params) { return rpc(this._rpcUrl, method, params, { headers: this._headers }); }

  async getChainId() {
    if (this._chainId != null) return Number(this._chainId);
    const id = Number(await this.rpc("eth_chainId", []));
    this._chainId = id;
    return id;
  }

  assertCanSubmit() {
    const chainId = this._chainId;
    assertCanSubmit({
      network: this.network,
      chainId: chainId ?? undefined,
      rpcUrl: this._rpcUrl,
      allowList: this._allow,
      label: this.id,
    });
  }

  async getHealth() {
    try {
      const [blockNumber, chainId] = await Promise.all([
        this.rpc("eth_blockNumber", []),
        this.getChainId(),
      ]);
      return {
        ok: true,
        blockNumber: Number(blockNumber),
        chainId,
        rpcUrl: publicRpcLabel(this._rpcUrl),
        network: this.network,
      };
    } catch (e) {
      return { ok: false, error: e.message, rpcUrl: publicRpcLabel(this._rpcUrl), network: this.network };
    }
  }

  async getBlock(n) {
    const tag = n == null ? "latest" : toHex(n);
    const b = await this.rpc("eth_getBlockByNumber", [tag, false]);
    if (!b) throw new Error("ethereum: block not found");
    return {
      height: Number(b.number),
      hash: b.hash,
      timestamp: Number(b.timestamp),
      family: "evm",
      chainId: await this.getChainId().catch(() => null),
    };
  }

  async getBalance(address) {
    const hex = await this.rpc("eth_getBalance", [normalizeAddress(address), "latest"]);
    const wei = hexToBig(hex);
    return { address: normalizeAddress(address), amount: wei, unit: "wei", raw: hex };
  }

  async buildTransfer({ from, to, valueWei, gas, gasPrice, data = "0x" }) {
    const chainId = await this.getChainId();
    const nonceHex = from
      ? await this.rpc("eth_getTransactionCount", [normalizeAddress(from), "pending"])
      : "0x0";
    const gasPriceHex = gasPrice != null ? toHex(gasPrice) : await this.rpc("eth_gasPrice", []);
    const gasLimit = gas != null ? toHex(gas) : "0x5208"; // 21000
    return buildLegacyTx({
      nonce: hexToBig(nonceHex),
      gasPrice: hexToBig(gasPriceHex),
      gas: hexToBig(gasLimit),
      to: normalizeAddress(to),
      value: BigInt(valueWei),
      data,
      chainId,
    });
  }

  /**
   * This adapter does not hold or apply secp256k1 owner keys itself.
   * On Anvil, use submitLocal (unlocked eth_sendTransaction). On a
   * public chain the owner signs in their wallet; this tree will not broadcast.
   */
  async sign() {
    throw new Error("ethereum: sign() is not implemented in-process; use an unlocked local Anvil account via submitLocal, or sign in an owner wallet (mainnet submit is refused)");
  }

  async submit(signed) {
    this.assertCanSubmit();
    const chainId = await this.getChainId();
    if (chainId === 1) throw new Error("ethereum: refusing submit: chain id 1 (mainnet)");
    const raw = signed.raw || signed.rawTransaction || signed.transaction;
    if (!raw) throw new Error("ethereum: submit requires a raw signed transaction");
    const hash = await this.rpc("eth_sendRawTransaction", [raw]);
    return { hash, submitted: true, chain: this.id, rpcUrl: publicRpcLabel(this._rpcUrl) };
  }

  /** Local-only: Anvil (and similar) unlocked-account send. Never on mainnet. */
  async submitLocal({ from, to, valueWei, data = "0x" }) {
    this.assertCanSubmit();
    const chainId = await this.getChainId();
    if (chainId === 1) throw new Error("ethereum: refusing submit: chain id 1 (mainnet)");
    const tx = {
      from: normalizeAddress(from),
      to: normalizeAddress(to),
      value: toHex(valueWei),
    };
    if (data && data !== "0x") tx.data = data;
    const hash = await this.rpc("eth_sendTransaction", [tx]);
    return { hash, submitted: true, chain: this.id, via: "eth_sendTransaction", rpcUrl: publicRpcLabel(this._rpcUrl) };
  }

  async getTransaction(hash) {
    return this.rpc("eth_getTransactionByHash", [hash]);
  }

  async getReceipt(hash) {
    return this.rpc("eth_getTransactionReceipt", [hash]);
  }
}

export { keccak256, keccak256Hex };
