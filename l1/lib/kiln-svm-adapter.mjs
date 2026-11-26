/**
 * KILN-SVM adapter: the same SVM methods as Solana, pointed at the KILN
 * chain. Submits are localhost-only. This is "KILN's chain inside Solana"
 * at the key/program layer; settlement checkpoints are not implemented.
 */
import { KILN_SVM_SUBMIT_RPC, envOr } from "./chains.mjs";
import { DEFAULT_PORTS } from "./base-adapter.mjs";
import { SolanaAdapter } from "./solana-adapter.mjs";

export const KILN_SVM_CHAIN_NAME = "kiln-svm";

export class KilnSvmAdapter extends SolanaAdapter {
  constructor(opts = {}) {
    super({
      id: "kiln-svm",
      rpcUrl: opts.rpcUrl || envOr("KILN_SVM_RPC_URL", `http://127.0.0.1:${DEFAULT_PORTS.kilnSvmRpc}`),
      allowList: opts.allowList || KILN_SVM_SUBMIT_RPC,
    });
  }

  async getHealth() {
    const h = await super.getHealth();
    let genesisHash = null;
    try { genesisHash = await this.rpc("getGenesisHash", []); } catch { /* offline */ }
    return { ...h, chain: KILN_SVM_CHAIN_NAME, genesisHash };
  }

  /**
   * Settlement to shared Solana is specified, not implemented.
   * Always throws so nothing can silently post a checkpoint.
   */
  async submitSettlementCheckpoint() {
    throw new Error("kiln-svm: settlement checkpoints onto Solana are not implemented; nothing was submitted");
  }
}
