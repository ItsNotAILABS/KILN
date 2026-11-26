/**
 * Opt-in live read-only Ethereum probe.
 * Skips unless KILN_ETH_RPC_URL (or CLOUDFLARE_ETH_GATEWAY_URL) is set.
 * Never logs or asserts the RPC URL itself. Writes stay refused.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EthereumAdapter } from "../lib/ethereum-adapter.mjs";
import { ethRpcConfigured, readOnlyEthSmoke, ETH_SMOKE_ADDRESS } from "../lib/eth-live.mjs";
import { publicRpcLabel } from "../lib/chains.mjs";

const LIVE = ethRpcConfigured();

describe("ethereum live read-only probe", { skip: !LIVE }, () => {
  it("reads eth_chainId, redacts the RPC URL, and refuses submit", async () => {
    const adapter = new EthereumAdapter();
    assert.equal(adapter.info().rpcUrl, "[redacted-rpc]");
    const r = await readOnlyEthSmoke(adapter);
    assert.equal(typeof r.chainId, "number");
    assert.ok(Number.isInteger(r.chainId) && r.chainId > 0, "chain id should be a positive integer");
    const health = await adapter.getHealth();
    assert.equal(health.rpcUrl, "[redacted-rpc]");
    assert.equal(publicRpcLabel("https://example.invalid"), "[redacted-rpc]");
    await assert.rejects(() => adapter.submitLocal({
      from: "0x0000000000000000000000000000000000000001",
      to: "0x0000000000000000000000000000000000000002",
      valueWei: 1n,
    }), /mainnet|allow-list|refusing submit/);
    await assert.rejects(() => adapter.submit({ raw: "0x00" }), /mainnet|allow-list|refusing submit/);
    assert.match(ETH_SMOKE_ADDRESS, /^0x[0-9a-fA-F]{40}$/);
    // Keep a handle on optional reads so the next test can skip cleanly.
    return r;
  });

  it("reads eth_blockNumber and a public balance when the gateway fulfills them", async (t) => {
    const r = await readOnlyEthSmoke(new EthereumAdapter());
    if (r.blockNumber == null || !r.balanceOk) {
      const reasons = [r.errors.blockNumber, r.errors.balance].filter(Boolean).join("; ");
      t.skip(`gateway did not fulfill every read (${reasons || "unknown"})`);
      return;
    }
    assert.ok(Number.isInteger(r.blockNumber) && r.blockNumber > 0);
    assert.equal(r.balanceOk, true);
  });
});
