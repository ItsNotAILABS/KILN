/**
 * Live Memo receipt against solana-test-validator when it will start, plus
 * an optional devnet faucet attempt (reported, not failed, if rate-limited).
 * Never talks to mainnet.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeypair, submitAndConfirmMemoReceipt, checkRpcUrl } from "../lib/transfer.mjs";
import { ALLOWED_RPC } from "../lib/transfer-receipt.mjs";

const DEVNET = "https://api.devnet.solana.com";
const LOCAL = "http://127.0.0.1:8899";

function findValidator() {
  const candidates = [
    "solana-test-validator",
    join(process.env.HOME || "", ".local/share/solana/install/active_release/bin/solana-test-validator"),
  ];
  for (const c of candidates) {
    if (c === "solana-test-validator") {
      const r = spawnSync("sh", ["-c", "command -v solana-test-validator"], { encoding: "utf8" });
      if (r.status === 0) return r.stdout.trim();
    } else if (existsSync(c)) return c;
  }
  return null;
}

async function waitRpc(url, timeoutMs = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth", params: [] }) });
      const j = await res.json();
      if (j.result === "ok" || j.result) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

describe("transfer: live receipt", { timeout: 180000 }, () => {
  const dirs = [];
  let child;
  after(async () => {
    if (child) {
      child.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 500));
      try { child.kill("SIGKILL"); } catch {}
    }
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("still refuses mainnet RPCs", () => {
    assert.throws(() => checkRpcUrl("https://api.mainnet-beta.solana.com"), /never mainnet/);
    assert.ok(ALLOWED_RPC.some((re) => re.test(LOCAL)));
    assert.ok(ALLOWED_RPC.some((re) => re.test(DEVNET)));
  });

  it("submits a memo to solana-test-validator and confirms it on-chain, or skips if the validator will not start", async (t) => {
    const bin = findValidator();
    if (!bin) { t.skip("solana-test-validator not installed"); return; }
    const ledger = mkdtempSync(join(tmpdir(), "kiln-sv-"));
    dirs.push(ledger);
    child = spawn(bin, ["--reset", "--quiet", "--ledger", ledger, "--bind-address", "127.0.0.1", "--rpc-port", "8899"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (d) => { err += d; if (err.length > 8000) err = err.slice(-4000); });
    const up = await waitRpc(LOCAL, 60000);
    if (!up) {
      t.skip(`solana-test-validator did not become healthy: ${err.slice(-400) || "no output"}`);
      return;
    }
    const kp = generateKeypair();
    const manifestId = "ab".repeat(32);
    const r = await submitAndConfirmMemoReceipt({ rpcUrl: LOCAL, keypair: kp, manifestId, timeoutMs: 45000 });
    assert.ok(r.submitted);
    assert.ok(r.confirmed?.confirmationStatus === "confirmed" || r.confirmed?.confirmationStatus === "finalized");
    assert.equal(r.memo, `kiln-transfer:${manifestId}`);
    console.log(`# local validator receipt ${r.submitted} status=${r.confirmed.confirmationStatus} slot=${r.confirmed.slot}`);
  });

  it("attempts a devnet faucet airdrop and reports rate-limits without failing the suite", async () => {
    const kp = generateKeypair();
    let result = "unknown";
    try {
      const res = await fetch(DEVNET, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "requestAirdrop", params: [kp.publicKey, 1_000_000_000] }) });
      const j = await res.json();
      if (j.error) {
        result = `devnet faucet refused: ${j.error.message || JSON.stringify(j.error)}`;
      } else {
        result = `devnet airdrop signature ${j.result}`;
        // Don't wait for confirmation or submit a receipt unless we clearly got SOL —
        // a subsequent sendTransaction may still fail if the airdrop is pending.
      }
    } catch (e) {
      result = `devnet faucet unreachable: ${e.message}`;
    }
    console.log(`# ${result}`);
    // Always pass: a rate-limited public faucet is not a product failure.
    assert.ok(typeof result === "string");
  });
});
