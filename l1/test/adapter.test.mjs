import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { keccak256Hex } from "../lib/keccak.mjs";
import { rlpEncode } from "../lib/rlp.mjs";
import { buildLegacyTx } from "../lib/ethereum-adapter.mjs";
import { openAdapter, openDefaultAdapters, ADAPTER_IDS } from "../lib/adapter.mjs";
import { SolanaAdapter } from "../lib/solana-adapter.mjs";
import { KilnSvmAdapter } from "../lib/kiln-svm-adapter.mjs";
import { EthereumAdapter } from "../lib/ethereum-adapter.mjs";
import { classifySvmNetwork, NETWORK, assertCanSubmit, SOLANA_SUBMIT_RPC, KILN_SVM_SUBMIT_RPC, ETHEREUM_SUBMIT_RPC } from "../lib/chains.mjs";
import { loadGenesisSpec } from "../lib/devnet.mjs";
import { buildDeliveryReceipt, svmAdapter, memoText } from "../lib/receipts.mjs";
import { generateKeypair } from "../../swarm/lib/transfer-identity.mjs";
import { verifyMemoReceipt, buildMemoReceipt } from "../../swarm/lib/transfer-receipt.mjs";

describe("keccak256", () => {
  it("matches Ethereum empty-code hash and public abc / selector vectors", () => {
    assert.equal(keccak256Hex(""), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    assert.equal(keccak256Hex("abc"), "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
    assert.equal(keccak256Hex("hello world"), "47173285a8d7341e5e972fc677286384f802f8ef42a5ec5f03bbfa254cb01fad");
    assert.equal(keccak256Hex("transfer(address,uint256)").slice(0, 8), "a9059cbb");
  });
});

describe("RLP and unsigned legacy tx", () => {
  it("encodes small integers and byte strings", () => {
    assert.equal(rlpEncode(0n).toString("hex"), "80");
    // a single byte < 0x80 is itself
    assert.equal(rlpEncode(1n).toString("hex"), "01");
    const list = rlpEncode([1n, 2n]);
    assert.equal(list[0], 0xc2);
  });
  it("builds an EIP-155 unsigned transfer with a keccak sighash", () => {
    const tx = buildLegacyTx({
      nonce: 0n, gasPrice: 1n, gas: 21000n,
      to: "0x70997970C51812dc3A010C7dAbBdA33021cE538d",
      value: 1n, data: "0x", chainId: 31337,
    });
    assert.equal(tx.kind, "evm-legacy-transfer");
    assert.match(tx.unsigned, /^0x[0-9a-f]+$/);
    assert.match(tx.sighash, /^0x[0-9a-f]{64}$/);
  });
});

describe("adapter registry", () => {
  it("opens solana, kiln-svm and ethereum", () => {
    assert.deepEqual(ADAPTER_IDS.sort(), ["ethereum", "kiln-svm", "solana"]);
    const all = openDefaultAdapters();
    assert.equal(all.solana.family, "svm");
    assert.equal(all["kiln-svm"].family, "svm");
    assert.equal(all.ethereum.family, "evm");
    assert.equal(openAdapter("kiln-svm").id, "kiln-svm");
  });
  it("rejects unknown adapters", () => {
    assert.throws(() => openAdapter("bitcoin"), /unknown chain adapter/);
  });
});

describe("mainnet and URL refusal", () => {
  it("classifies official Solana URLs", () => {
    assert.equal(classifySvmNetwork("http://127.0.0.1:8899"), NETWORK.local);
    assert.equal(classifySvmNetwork("https://api.devnet.solana.com"), NETWORK.devnet);
    assert.equal(classifySvmNetwork("https://api.testnet.solana.com"), NETWORK.testnet);
    assert.equal(classifySvmNetwork("https://api.mainnet-beta.solana.com"), NETWORK.mainnet);
  });
  it("refuses Solana mainnet submit", () => {
    const a = new SolanaAdapter({ rpcUrl: "https://api.mainnet-beta.solana.com" });
    assert.equal(a.network, NETWORK.mainnet);
    assert.throws(() => a.assertCanSubmit(), /mainnet is not allowed/);
  });
  it("refuses KILN-SVM submit to a public URL", () => {
    const a = new KilnSvmAdapter({ rpcUrl: "https://api.devnet.solana.com" });
    assert.throws(() => a.assertCanSubmit(), /not on the allow-list/);
  });
  it("refuses Ethereum submit to a non-local URL and to chain id 1", () => {
    const a = new EthereumAdapter({ rpcUrl: "https://cloudflare-eth.com", chainId: 1 });
    assert.throws(() => a.assertCanSubmit(), /mainnet/);
    const b = new EthereumAdapter({ rpcUrl: "https://example.invalid/eth" });
    assert.throws(() => b.assertCanSubmit(), /not on the allow-list/);
    assert.throws(() => assertCanSubmit({
      network: NETWORK.local, chainId: 1, rpcUrl: "http://127.0.0.1:8545",
      allowList: ETHEREUM_SUBMIT_RPC, label: "ethereum",
    }), /mainnet chain id/);
  });
  it("allows localhost submit on all three allow-lists", () => {
    assertCanSubmit({ network: NETWORK.local, rpcUrl: "http://127.0.0.1:18899", allowList: KILN_SVM_SUBMIT_RPC, label: "kiln-svm" });
    assertCanSubmit({ network: NETWORK.devnet, rpcUrl: "https://api.devnet.solana.com", allowList: SOLANA_SUBMIT_RPC, label: "solana" });
  });
  it("kiln-svm settlement checkpoint is not implemented and throws without sending", async () => {
    const a = new KilnSvmAdapter({ rpcUrl: "http://127.0.0.1:18899" });
    await assert.rejects(() => a.submitSettlementCheckpoint(), /not implemented/);
  });
});

describe("delivery receipts through the adapter hook", () => {
  it("builds and verifies a Memo receipt offline (no RPC)", async () => {
    const kp = generateKeypair();
    const manifestId = "ab".repeat(32);
    assert.equal(memoText(manifestId), `kiln-transfer:${manifestId}`);
    const built = await buildDeliveryReceipt(
      new SolanaAdapter({ rpcUrl: "http://127.0.0.1:1" }),
      { keypair: kp, manifestId, recentBlockhash: kp.publicKey },
    );
    assert.equal(built.kind, "svm-memo-receipt");
    assert.equal(built.memo, `kiln-transfer:${manifestId}`);
    assert.equal(verifyMemoReceipt(built.transaction, manifestId), true);
    // same wire format as the original builder
    const raw = buildMemoReceipt({ keypair: kp, manifestId, recentBlockhash: kp.publicKey });
    assert.equal(verifyMemoReceipt(raw.transaction, manifestId), true);
  });
  it("refuses receipt submit on a non-SVM adapter id", () => {
    assert.throws(() => svmAdapter("ethereum"), /not supported on ethereum/);
  });
});

describe("genesis spec", () => {
  it("describes a development KILN-SVM cluster bound to loopback", () => {
    const g = loadGenesisSpec();
    assert.equal(g.name, "kiln-svm");
    assert.equal(g.clusterType, "development");
    assert.equal(g.bindAddress, "127.0.0.1");
    assert.equal(g.hashesPerTick, "sleep");
    assert.ok(g.slotsPerEpoch >= 8);
    assert.equal(g.defaultRpcPort, 18899);
  });
});
