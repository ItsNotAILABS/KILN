#!/usr/bin/env node
/**
 * KILN L1 CLI — local SVM/Ethereum devnets and chain adapters.
 * Never submits to mainnet. Usage: node l1/kiln-l1.mjs <command>
 * Never prints RPC URLs from the environment.
 */
import { ADAPTER_IDS, openAdapter, openDefaultAdapters } from "./lib/adapter.mjs";
import { startDevnet, stopDevnet, statusDevnet } from "./lib/devnet.mjs";
import { startEthDevnet, stopEthDevnet, statusEthDevnet } from "./lib/eth-devnet.mjs";
import { submitDeliveryReceipt, buildDeliveryReceipt } from "./lib/receipts.mjs";
import { loadOrCreateKeypair } from "../swarm/lib/transfer-identity.mjs";
import { join } from "node:path";
import { homedir } from "node:os";
import { sanitizeErrorMessage } from "./lib/chains.mjs";
import { ethRpcConfigured, readOnlyEthSmoke } from "./lib/eth-live.mjs";

function usage(code = 0) {
  const text = `KILN L1 — multi-chain adapters and local devnets

  node l1/kiln-l1.mjs chains
  node l1/kiln-l1.mjs health [--chain solana|kiln-svm|ethereum]
  node l1/kiln-l1.mjs block [--chain ...]
  node l1/kiln-l1.mjs balance <address> [--chain ...]
  node l1/kiln-l1.mjs svm start|stop|status
  node l1/kiln-l1.mjs eth start|stop|status|health
  node l1/kiln-l1.mjs receipt build  --manifest-id <64-hex> [--chain kiln-svm|solana] [--keypair FILE]
  node l1/kiln-l1.mjs receipt submit --manifest-id <64-hex> [--chain kiln-svm|solana] [--keypair FILE]

RPC URLs (never commit secrets; never printed):
  KILN_SOLANA_RPC_URL          default http://127.0.0.1:8899
  KILN_SVM_RPC_URL             default http://127.0.0.1:18899
  KILN_ETH_RPC_URL             or CLOUDFLARE_ETH_GATEWAY_URL
                               bare host/path is accepted (https:// is prepended);
                               Cloudflare Web3 gateways are supported.
                               Default when unset: http://127.0.0.1:18545 (Anvil)
  KILN_ETH_RPC_TOKEN           optional bearer token for the gateway
`;
  process.stdout.write(text);
  process.exit(code);
}

function arg(flag, argv, fallback) {
  const i = argv.indexOf(flag);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  return fallback;
}

function safeErrorText(e) {
  let msg = String(e && (e.stack || e.message || e));
  for (const name of ["KILN_ETH_RPC_URL", "CLOUDFLARE_ETH_GATEWAY_URL", "KILN_ETH_RPC_TOKEN", "CLOUDFLARE_ETH_GATEWAY_TOKEN"]) {
    const v = process.env[name];
    if (v) msg = sanitizeErrorMessage(msg, v);
  }
  return msg;
}

/** Live read-only probe. Prints only chain id and block number, never the RPC URL. */
async function printEthHealth() {
  if (!ethRpcConfigured()) {
    process.stderr.write("eth health: KILN_ETH_RPC_URL is not set; skipping the live read-only probe\n");
    process.exit(2);
  }
  const adapter = openAdapter("ethereum");
  const r = await readOnlyEthSmoke(adapter);
  process.stdout.write(JSON.stringify({ chainId: r.chainId, blockNumber: r.blockNumber }) + "\n");
  const failed = [];
  if (r.errors && r.errors.blockNumber) failed.push("eth_blockNumber was not fulfilled by the gateway");
  if (r.errors && r.errors.balance) failed.push("balance read was not fulfilled by the gateway");
  if (failed.length) {
    process.stderr.write("eth health: " + failed.join("; ") + " (writes remain refused)\n");
    process.exit(1);
  }
}

async function main(argv) {
  const cmd = argv[0];
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") usage(0);

  if (cmd === "chains") {
    const adapters = openDefaultAdapters();
    for (const id of ADAPTER_IDS) {
      process.stdout.write(JSON.stringify(adapters[id].info()) + "\n");
    }
    return;
  }

  if (cmd === "health" || cmd === "block") {
    const id = arg("--chain", argv, "kiln-svm");
    if (cmd === "health" && id === "ethereum") {
      await printEthHealth();
      return;
    }
    const a = openAdapter(id);
    const r = cmd === "health" ? await a.getHealth() : await a.getBlock();
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
    if (cmd === "health" && r.ok === false) process.exit(2);
    return;
  }

  if (cmd === "balance") {
    const address = argv[1] && !argv[1].startsWith("--") ? argv[1] : arg("--address", argv);
    if (!address) usage(1);
    const id = arg("--chain", argv, "kiln-svm");
    const r = await openAdapter(id).getBalance(address);
    process.stdout.write(JSON.stringify(r, (_, v) => typeof v === "bigint" ? v.toString() : v, 2) + "\n");
    return;
  }

  if (cmd === "svm") {
    const sub = argv[1];
    if (sub === "start") {
      const st = await startDevnet();
      process.stdout.write(JSON.stringify({ ok: true, ...st, health: st.health }, null, 2) + "\n");
      return;
    }
    if (sub === "stop") {
      process.stdout.write(JSON.stringify(await stopDevnet(), null, 2) + "\n");
      return;
    }
    if (sub === "status") {
      process.stdout.write(JSON.stringify(await statusDevnet(), null, 2) + "\n");
      return;
    }
    usage(1);
  }

  if (cmd === "eth") {
    const sub = argv[1];
    if (sub === "start") {
      const st = await startEthDevnet();
      process.stdout.write(JSON.stringify(st, null, 2) + "\n");
      return;
    }
    if (sub === "stop") {
      process.stdout.write(JSON.stringify(await stopEthDevnet(), null, 2) + "\n");
      return;
    }
    if (sub === "status") {
      process.stdout.write(JSON.stringify(await statusEthDevnet(), null, 2) + "\n");
      return;
    }
    if (sub === "health" || sub === "smoke") {
      await printEthHealth();
      return;
    }
    usage(1);
  }

  if (cmd === "receipt") {
    const sub = argv[1];
    const manifestId = arg("--manifest-id", argv);
    if (!manifestId) usage(1);
    const chain = arg("--chain", argv, "kiln-svm");
    const keyFile = arg("--keypair", argv, join(homedir(), ".config", "kiln", "transfer", "id.json"));
    const keypair = loadOrCreateKeypair(keyFile);
    if (sub === "build") {
      const r = await buildDeliveryReceipt(chain, { keypair, manifestId });
      process.stdout.write(JSON.stringify({ payer: r.payer, signature: r.signature, memo: r.memo, transaction: r.transaction }, null, 2) + "\n");
      return;
    }
    if (sub === "submit") {
      const r = await submitDeliveryReceipt(chain, { keypair, manifestId });
      process.stdout.write(JSON.stringify({ signature: r.signature, submitted: r.submitted, chain: r.chain, memo: r.memo }, null, 2) + "\n");
      return;
    }
    usage(1);
  }

  usage(1);
}

main(process.argv.slice(2)).catch((e) => {
  process.stderr.write(safeErrorText(e) + "\n");
  process.exit(1);
});
