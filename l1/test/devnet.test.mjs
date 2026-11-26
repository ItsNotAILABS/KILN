import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveBin } from "../lib/which.mjs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { startDevnet, stopDevnet, findSolanaTools } from "../lib/devnet.mjs";
import { startEthDevnet, stopEthDevnet, ANVIL_ACCOUNT_0, ANVIL_ACCOUNT_1 } from "../lib/eth-devnet.mjs";
import { KilnSvmAdapter } from "../lib/kiln-svm-adapter.mjs";
import { EthereumAdapter } from "../lib/ethereum-adapter.mjs";
import { generateKeypair } from "../../swarm/lib/transfer-identity.mjs";
import { submitDeliveryReceipt, verifyMemoReceipt } from "../lib/receipts.mjs";

const HAS_SVM = !!(findSolanaTools().validator && findSolanaTools().keygen);
const HAS_ANVIL = !!resolveBin("anvil");

describe("KILN-SVM local devnet", { skip: !HAS_SVM }, () => {
  const dir = mkdtempSync(join(tmpdir(), "kiln-svm-"));
  const rpcPort = 18899;
  let adapter;
  let started = false;

  after(async () => {
    if (started) await stopDevnet(dir);
  });

  it("boots on 127.0.0.1, answers RPC, and reports a genesis hash", async () => {
    const st = await startDevnet({ dir, rpcPort, faucetPort: 18901, bind: "127.0.0.1" });
    started = true;
    assert.equal(st.bind, "127.0.0.1");
    assert.ok(st.health?.ok, st.health?.error);
    assert.ok(st.health.genesisHash || st.genesisHash);
    assert.ok(["solana-genesis", "solana-test-validator"].includes(st.genesisPath));
    adapter = new KilnSvmAdapter({ rpcUrl: st.rpcUrl });
    const health = await adapter.getHealth();
    assert.equal(health.ok, true);
    assert.ok(health.slot >= 0);
    const block = await adapter.getBlock();
    assert.ok(block.slot >= 0);
    assert.equal(block.family, "svm");
  });

  it("airdrops, reads a balance, and submits a Memo delivery receipt", async () => {
    assert.ok(adapter, "devnet did not start");
    const kp = generateKeypair();
    await adapter.requestAirdrop(kp.publicKey, 2_000_000_000); // 2 SOL, covers rent-free system account + fee
    // confirm by polling balance
    let lamports = 0;
    for (let i = 0; i < 30; i++) {
      lamports = (await adapter.getBalance(kp.publicKey)).amount;
      if (lamports >= 1_000_000_000) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(lamports >= 1_000_000_000, `airdrop did not land, balance=${lamports}`);
    const manifestId = "cd".repeat(32);
    const rec = await submitDeliveryReceipt(adapter, { keypair: kp, manifestId });
    assert.equal(rec.submitted, true);
    assert.ok(rec.signature);
    assert.equal(verifyMemoReceipt(rec.transaction, manifestId), true);
    // wait for the tx to be queryable
    let tx = null;
    for (let i = 0; i < 30; i++) {
      tx = await adapter.getTransaction(rec.signature).catch(() => null);
      if (tx) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(tx, "receipt transaction was not found on the local validator");
  });
});

describe("Ethereum local devnet (Anvil)", { skip: !HAS_ANVIL }, () => {
  const dir = mkdtempSync(join(tmpdir(), "kiln-eth-"));
  const port = 18545;
  let adapter;
  let started = false;

  after(async () => {
    if (started) await stopEthDevnet(dir);
  });

  it("boots Anvil on 127.0.0.1 and reads chain id, block, and balances", async () => {
    const st = await startEthDevnet({ dir, port, bind: "127.0.0.1", chainId: 31337 });
    started = true;
    assert.equal(st.health.ok, true);
    assert.equal(st.health.chainId, 31337);
    adapter = new EthereumAdapter({ rpcUrl: st.rpcUrl });
    const health = await adapter.getHealth();
    assert.equal(health.ok, true);
    assert.equal(health.chainId, 31337);
    const block = await adapter.getBlock();
    assert.equal(block.family, "evm");
    assert.ok(block.hash);
    const bal = await adapter.getBalance(ANVIL_ACCOUNT_0);
    assert.equal(bal.unit, "wei");
    assert.ok(bal.amount > 0n);
  });

  it("sends a local value transfer via unlocked accounts and refuses mainnet", async () => {
    assert.ok(adapter, "anvil did not start");
    const before = (await adapter.getBalance(ANVIL_ACCOUNT_1)).amount;
    const sent = await adapter.submitLocal({
      from: ANVIL_ACCOUNT_0,
      to: ANVIL_ACCOUNT_1,
      valueWei: 1_000_000_000_000_000n, // 0.001 ETH
    });
    assert.equal(sent.submitted, true);
    assert.match(sent.hash, /^0x[0-9a-f]{64}$/);
    // wait for the balance to move
    let after = before;
    for (let i = 0; i < 20; i++) {
      after = (await adapter.getBalance(ANVIL_ACCOUNT_1)).amount;
      if (after > before) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(after > before, `balance did not increase: ${before} -> ${after}`);
    const built = await adapter.buildTransfer({
      from: ANVIL_ACCOUNT_0,
      to: ANVIL_ACCOUNT_1,
      valueWei: 1n,
    });
    assert.equal(built.kind, "evm-legacy-transfer");
    assert.equal(built.chainId, 31337);
    const mainnet = new EthereumAdapter({ rpcUrl: "https://cloudflare-eth.com", chainId: 1 });
    await assert.rejects(() => mainnet.submitLocal({
      from: ANVIL_ACCOUNT_0, to: ANVIL_ACCOUNT_1, valueWei: 1n,
    }), /mainnet|allow-list/);
  });
});
