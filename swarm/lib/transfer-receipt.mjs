/**
 * transfer-receipt.mjs — optional on-chain receipt for a transfer: a Solana
 * Memo-program transaction whose memo is "kiln-transfer:<manifestId>".
 *
 * Only the 32-byte manifest hash goes on chain, never file bytes. Building a
 * receipt is offline and free. Submitting one is opt-in and REFUSES mainnet:
 * submitMemoReceipt only talks to devnet, testnet or a localhost validator
 * (solana-test-validator). The payer must already hold devnet/local SOL
 * (`solana airdrop 1 <pubkey> -u devnet`).
 */
import { b58decode, b58encode, signBytes, verifyBytes } from "./transfer-identity.mjs";

export const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const ALLOWED_RPC = [
  /^https:\/\/api\.devnet\.solana\.com\/?$/,
  /^https:\/\/api\.testnet\.solana\.com\/?$/,
  /^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/,
];

function compactU16(n) {
  const out = [];
  for (;;) {
    let b = n & 0x7f; n >>= 7;
    if (n) b |= 0x80;
    out.push(b);
    if (!n) return Buffer.from(out);
  }
}

export function memoText(manifestId) {
  if (!/^[0-9a-f]{64}$/.test(manifestId)) throw new Error("memo receipt: manifestId must be 64 hex chars");
  return `kiln-transfer:${manifestId}`;
}

/** Serialize a legacy Solana message: payer signs, one Memo instruction. */
export function buildMemoMessage({ payer, manifestId, recentBlockhash }) {
  const payerKey = b58decode(payer);
  const program = b58decode(MEMO_PROGRAM_ID);
  const blockhash = b58decode(recentBlockhash);
  if (payerKey.length !== 32 || blockhash.length !== 32) throw new Error("memo receipt: payer and blockhash must be 32 bytes");
  const data = Buffer.from(memoText(manifestId), "utf8");
  return Buffer.concat([
    Buffer.from([1, 0, 1]),               // header: 1 signer, 0 ro-signed, 1 ro-unsigned (memo program)
    compactU16(2), payerKey, program,     // account keys
    blockhash,
    compactU16(1),                        // one instruction
    Buffer.from([1]),                     // program id index (memo)
    compactU16(1), Buffer.from([0]),      // accounts: payer (memo checks it signed)
    compactU16(data.length), data,
  ]);
}

/** Build + sign the receipt transaction. Offline; returns base64 wire tx. */
export function buildMemoReceipt({ keypair, manifestId, recentBlockhash }) {
  const message = buildMemoMessage({ payer: keypair.publicKey, manifestId, recentBlockhash });
  const sig = signBytes(keypair, message);
  const tx = Buffer.concat([compactU16(1), sig, message]);
  return { transaction: tx.toString("base64"), signature: b58encode(sig), memo: memoText(manifestId), payer: keypair.publicKey };
}

/** Check a receipt's signature and that its memo names manifestId. */
export function verifyMemoReceipt(txBase64, manifestId) {
  const tx = Buffer.from(txBase64, "base64");
  if (tx[0] !== 1) return false;
  const sig = tx.subarray(1, 65), message = tx.subarray(65);
  const payer = b58encode(message.subarray(4, 36));
  if (!verifyBytes(payer, message, sig)) return false;
  return message.includes(Buffer.from(memoText(manifestId)));
}

export function checkRpcUrl(url) {
  if (!ALLOWED_RPC.some((re) => re.test(String(url)))) {
    throw new Error(`refusing RPC ${url}: receipts may only be submitted to devnet, testnet or a localhost validator — never mainnet`);
  }
}

async function rpc(url, method, params) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message || JSON.stringify(j.error)}`);
  return j.result;
}

/** Opt-in: fetch a blockhash, sign, submit to devnet/testnet/localhost. */
export async function submitMemoReceipt({ rpcUrl, keypair, manifestId }) {
  checkRpcUrl(rpcUrl);
  const { value } = await rpc(rpcUrl, "getLatestBlockhash", [{ commitment: "confirmed" }]);
  const r = buildMemoReceipt({ keypair, manifestId, recentBlockhash: value.blockhash });
  const sig = await rpc(rpcUrl, "sendTransaction", [r.transaction, { encoding: "base64" }]);
  return { ...r, submitted: sig, rpcUrl };
}
