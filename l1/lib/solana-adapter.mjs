/**
 * Shared-Solana adapter. Reads any configured RPC; submits only to
 * localhost or official devnet/testnet. Mainnet is refused.
 */
import {
  NETWORK, SOLANA_SUBMIT_RPC, assertCanSubmit, classifySvmNetwork, envOr,
} from "./chains.mjs";
import { rpc } from "./rpc.mjs";
import { BaseAdapter } from "./base-adapter.mjs";
import { buildMemoReceipt, verifyMemoReceipt, memoText } from "../../swarm/lib/transfer-receipt.mjs";
import { b58decode, b58encode, signBytes } from "../../swarm/lib/transfer-identity.mjs";

const SYSTEM_PROGRAM = "11111111111111111111111111111111";

function compactU16(n) {
  const out = [];
  for (;;) {
    let b = n & 0x7f; n >>= 7;
    if (n) b |= 0x80;
    out.push(b);
    if (!n) return Buffer.from(out);
  }
}

/** Legacy SystemProgram.transfer (2) message + signature wrapper helpers. */
export function buildSystemTransferMessage({ from, to, lamports, recentBlockhash }) {
  const payer = b58decode(from);
  const dest = b58decode(to);
  const program = b58decode(SYSTEM_PROGRAM);
  const blockhash = b58decode(recentBlockhash);
  if (payer.length !== 32 || dest.length !== 32 || blockhash.length !== 32) {
    throw new Error("solana transfer: from, to and blockhash must be 32-byte keys");
  }
  const data = Buffer.alloc(12);
  data.writeUInt32LE(2, 0); // SystemInstruction::Transfer
  data.writeBigUInt64LE(BigInt(lamports), 4);
  return Buffer.concat([
    Buffer.from([1, 0, 1]), // 1 signer, 0 ro-signed, 1 ro-unsigned (system program)
    compactU16(3), payer, dest, program,
    blockhash,
    compactU16(1),
    Buffer.from([2]), // program id index
    compactU16(2), Buffer.from([0, 1]), // from, to
    compactU16(data.length), data,
  ]);
}

export function signLegacyMessage(keypair, message) {
  const sig = signBytes(keypair, message);
  const tx = Buffer.concat([compactU16(1), sig, message]);
  return { transaction: tx.toString("base64"), signature: b58encode(sig) };
}

export class SolanaAdapter extends BaseAdapter {
  constructor(opts = {}) {
    super();
    this._id = opts.id || "solana";
    this._rpcUrl = opts.rpcUrl || envOr("KILN_SOLANA_RPC_URL", "http://127.0.0.1:8899");
    this._allow = opts.allowList || SOLANA_SUBMIT_RPC;
  }
  get id() { return this._id; }
  get family() { return "svm"; }
  get rpcUrl() { return this._rpcUrl; }
  get network() { return classifySvmNetwork(this._rpcUrl); }
  get allowList() { return this._allow; }

  rpc(method, params) { return rpc(this._rpcUrl, method, params); }

  assertCanSubmit() {
    assertCanSubmit({
      network: this.network,
      chainId: this.network === NETWORK.mainnet ? "mainnet-beta" : undefined,
      rpcUrl: this._rpcUrl,
      allowList: this._allow,
      label: this.id,
    });
  }

  async getHealth() {
    try {
      const slot = await this.rpc("getSlot", []);
      return { ok: true, slot, rpcUrl: this._rpcUrl, network: this.network };
    } catch (e) {
      return { ok: false, error: e.message, rpcUrl: this._rpcUrl, network: this.network };
    }
  }

  async getBlock(slot) {
    const s = slot ?? await this.rpc("getSlot", []);
    const hash = await this.rpc("getBlock", [s, { encoding: "json", transactionDetails: "none", rewards: false, maxSupportedTransactionVersion: 0 }]).catch(() => null);
    const blockhash = hash?.blockhash ?? null;
    return { height: s, slot: s, hash: blockhash, blockTime: hash?.blockTime ?? null, family: "svm" };
  }

  async getLatestBlockhash() {
    const { value } = await this.rpc("getLatestBlockhash", [{ commitment: "confirmed" }]);
    return { blockhash: value.blockhash, lastValidBlockHeight: value.lastValidBlockHeight };
  }

  async getBalance(address) {
    const r = await this.rpc("getBalance", [address, { commitment: "confirmed" }]);
    const lamports = typeof r === "object" && r && "value" in r ? Number(r.value) : Number(r);
    return { address, amount: lamports, unit: "lamports", raw: String(lamports) };
  }

  async requestAirdrop(address, lamports) {
    this.assertCanSubmit();
    if (this.network !== NETWORK.local) {
      throw new Error(`${this.id}: airdrop is only used on a local validator in this tree`);
    }
    const sig = await this.rpc("requestAirdrop", [address, Number(lamports)]);
    await this.rpc("confirmTransaction", [sig, { commitment: "confirmed" }]).catch(() => null);
    return { signature: sig };
  }

  async buildTransfer({ from, to, lamports, recentBlockhash }) {
    const bh = recentBlockhash || (await this.getLatestBlockhash()).blockhash;
    const message = buildSystemTransferMessage({ from, to, lamports, recentBlockhash: bh });
    return { kind: "svm-system-transfer", message: message.toString("base64"), from, to, lamports, recentBlockhash: bh };
  }

  async sign(built, keypair) {
    if (built.kind === "svm-system-transfer" || built.kind === "svm-memo-receipt") {
      const message = Buffer.from(built.message, "base64");
      const signed = signLegacyMessage(keypair, message);
      return { ...built, ...signed, signed: true };
    }
    throw new Error(`${this.id}: cannot sign kind ${built.kind}`);
  }

  async submit(signed) {
    this.assertCanSubmit();
    const tx = signed.transaction || signed.raw;
    if (!tx) throw new Error(`${this.id}: submit requires a signed transaction (base64)`);
    const sig = await this.rpc("sendTransaction", [tx, { encoding: "base64", preflightCommitment: "confirmed" }]);
    return { signature: sig, submitted: true, chain: this.id, rpcUrl: this._rpcUrl };
  }

  async getTransaction(signature) {
    return this.rpc("getTransaction", [signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
  }

  async buildDeliveryReceipt({ keypair, manifestId, recentBlockhash }) {
    const bh = recentBlockhash || (await this.getLatestBlockhash()).blockhash;
    const r = buildMemoReceipt({ keypair, manifestId, recentBlockhash: bh });
    return {
      kind: "svm-memo-receipt",
      ...r,
      message: Buffer.from(r.transaction, "base64").subarray(1 + 64).toString("base64"), // not needed by submit
      manifestId,
      memo: r.memo || memoText(manifestId),
      recentBlockhash: bh,
    };
  }

  async submitDeliveryReceipt({ keypair, manifestId }) {
    this.assertCanSubmit();
    const built = await this.buildDeliveryReceipt({ keypair, manifestId });
    if (!verifyMemoReceipt(built.transaction, manifestId)) {
      throw new Error(`${this.id}: built memo receipt failed local verify`);
    }
    const result = await this.submit(built);
    return { ...built, ...result };
  }
}
