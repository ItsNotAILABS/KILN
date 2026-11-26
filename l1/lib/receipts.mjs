/**
 * Delivery receipts go through a chain adapter.
 *
 * The Memo wire format is still built by swarm/lib/transfer-receipt.mjs
 * (unchanged). This module is the hook: pick an SVM adapter, build or
 * submit the receipt, and keep mainnet refusal in the adapter.
 */
import { memoText, verifyMemoReceipt } from "../../swarm/lib/transfer-receipt.mjs";
import { openAdapter } from "./adapter.mjs";

export { memoText, verifyMemoReceipt };

export function svmAdapter(chainOrAdapter, opts) {
  if (chainOrAdapter && typeof chainOrAdapter.submitDeliveryReceipt === "function") return chainOrAdapter;
  const id = chainOrAdapter || "kiln-svm";
  if (id !== "solana" && id !== "kiln-svm") {
    throw new Error(`delivery receipts are SVM Memo transactions; not supported on ${id}`);
  }
  return openAdapter(id, opts);
}

export async function buildDeliveryReceipt(chainOrAdapter, { keypair, manifestId, recentBlockhash }) {
  const adapter = svmAdapter(chainOrAdapter);
  return adapter.buildDeliveryReceipt({ keypair, manifestId, recentBlockhash });
}

export async function submitDeliveryReceipt(chainOrAdapter, { keypair, manifestId }) {
  const adapter = svmAdapter(chainOrAdapter);
  adapter.assertCanSubmit();
  return adapter.submitDeliveryReceipt({ keypair, manifestId });
}
