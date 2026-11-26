/** Shared adapter contract. Kept in its own file so adapters can import it without a cycle. */
import { publicRpcLabel } from "./chains.mjs";
export const DEFAULT_PORTS = Object.freeze({
  kilnSvmRpc: 18899,
  kilnSvmFaucet: 18901,
  ethereum: 18545,
});

export class BaseAdapter {
  get id() { throw new Error("adapter: id"); }
  get family() { throw new Error("adapter: family"); }
  get network() { throw new Error("adapter: network"); }
  get rpcUrl() { throw new Error("adapter: rpcUrl"); }
  async getHealth() { throw new Error("adapter: getHealth"); }
  async getBlock() { throw new Error("adapter: getBlock"); }
  async getBalance(_address) { throw new Error("adapter: getBalance"); }
  async buildTransfer(_tx) { throw new Error("adapter: buildTransfer"); }
  async sign(_built, _key) { throw new Error("adapter: sign"); }
  async submit(_signed) { throw new Error("adapter: submit"); }
  assertCanSubmit() { throw new Error("adapter: assertCanSubmit"); }
  info() {
    return { id: this.id, family: this.family, network: this.network, rpcUrl: publicRpcLabel(this.rpcUrl) };
  }
}
