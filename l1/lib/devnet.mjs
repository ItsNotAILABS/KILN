/**
 * Local KILN-SVM devnet launcher.
 *
 * Binds to 127.0.0.1 only. Tries solana-genesis with l1/genesis/kiln-svm.json
 * first; if that ledger will not boot under solana-test-validator, falls
 * back to the test validator's own genesis and records the hash it ran.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { DEFAULT_PORTS } from "./base-adapter.mjs";
import { rpc, localUrl } from "./rpc.mjs";
import { resolveBin } from "./which.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const REPO = resolve(ROOT, "..");
const GENESIS_SPEC = join(ROOT, "genesis", "kiln-svm.json");

export function defaultDevnetDir() {
  return join(ROOT, ".devnet", "kiln-svm");
}

export function loadGenesisSpec() {
  return JSON.parse(readFileSync(GENESIS_SPEC, "utf8"));
}

export function findSolanaTools() {
  return {
    keygen: resolveBin("solana-keygen"),
    genesis: resolveBin("solana-genesis"),
    validator: resolveBin("solana-test-validator"),
    solana: resolveBin("solana"),
  };
}

function run(bin, args, opts = {}) {
  const r = spawnSync(bin, args, { encoding: "utf8", ...opts });
  if (r.status !== 0) {
    throw new Error(`${bin} ${args.join(" ")} failed:\n${r.stderr || r.stdout}`);
  }
  return r;
}

function keygen(bin, path) {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    run(bin, ["new", "--no-bip39-passphrase", "-o", path, "--force"]);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function pubkeyOf(bin, path) {
  const r = run(bin, ["pubkey", path]);
  return r.stdout.trim();
}

function writeJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
}

export function readState(dir = defaultDevnetDir()) {
  const p = join(dir, "state.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function stopDevnet(dir = defaultDevnetDir()) {
  const st = readState(dir);
  if (st?.pid && pidAlive(st.pid)) {
    try { process.kill(st.pid, "SIGTERM"); } catch { /* already gone */ }
    for (let i = 0; i < 20; i++) {
      if (!pidAlive(st.pid)) break;
      await sleep(150);
    }
    if (pidAlive(st.pid)) {
      try { process.kill(st.pid, "SIGKILL"); } catch { /* */ }
    }
  }
  if (st) writeJson(join(dir, "state.json"), { ...st, pid: null, running: false, stoppedAt: new Date().toISOString() });
  return { stopped: true, dir };
}

/**
 * Write a custom genesis with solana-genesis. Returns { ok, ledger, keys, error? }.
 */
export function writeCustomGenesis(dir, tools, spec) {
  const ledger = join(dir, "ledger");
  const keys = join(dir, "keys");
  mkdirSync(keys, { recursive: true });
  const identity = join(keys, "identity.json");
  const vote = join(keys, "vote.json");
  const stake = join(keys, "stake.json");
  const faucet = join(keys, "faucet.json");
  keygen(tools.keygen, identity);
  keygen(tools.keygen, vote);
  keygen(tools.keygen, stake);
  keygen(tools.keygen, faucet);
  if (existsSync(ledger)) rmSync(ledger, { recursive: true, force: true });
  mkdirSync(ledger, { recursive: true });
  try {
    run(tools.genesis, [
      "--ledger", ledger,
      "--cluster-type", spec.clusterType || "development",
      "--hashes-per-tick", String(spec.hashesPerTick || "sleep"),
      "--slots-per-epoch", String(spec.slotsPerEpoch || 32),
      "--inflation", spec.inflation || "none",
      "--faucet-pubkey", faucet,
      "--faucet-lamports", String(spec.faucetLamports || 1_000_000_000_000),
      "--bootstrap-validator", identity, vote, stake,
      "--bootstrap-validator-lamports", String(spec.bootstrapValidatorLamports || 500_000_000_000),
      "--bootstrap-validator-stake-lamports", String(spec.bootstrapValidatorStakeLamports || 500_000_000),
    ]);
    return {
      ok: true,
      path: "solana-genesis",
      ledger,
      keys: {
        identity, vote, stake, faucet,
        identityPubkey: pubkeyOf(tools.keygen, identity),
        faucetPubkey: pubkeyOf(tools.keygen, faucet),
      },
    };
  } catch (e) {
    return { ok: false, path: "solana-genesis", error: e.message, ledger, keys: { identity, vote, stake, faucet } };
  }
}

async function waitForRpc(url, timeoutMs = 30_000) {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    try {
      const slot = await rpc(url, "getSlot", []);
      const genesisHash = await rpc(url, "getGenesisHash", []);
      return { ok: true, slot, genesisHash };
    } catch (e) {
      last = e.message;
      await sleep(250);
    }
  }
  return { ok: false, error: last || "timed out waiting for RPC" };
}

function spawnValidator(tools, { ledger, rpcPort, faucetPort, reset, bind }) {
  const logFile = join(dirname(ledger), "validator.log");
  const fd = writeFileSync(logFile, "");
  const out = { write: undefined };
  const args = [
    "--ledger", ledger,
    "--bind-address", bind,
    "--rpc-port", String(rpcPort),
    "--faucet-port", String(faucetPort),
    "--gossip-host", bind,
  ];
  if (reset) args.unshift("--reset");
  const child = spawn(tools.validator, args, {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stream = { logFile, chunks: [] };
  const onData = (buf) => {
    try { writeFileSync(logFile, buf, { flag: "a" }); } catch { /* */ }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.unref();
  return { pid: child.pid, logFile };
}

export async function startDevnet(opts = {}) {
  const spec = loadGenesisSpec();
  const dir = resolve(opts.dir || defaultDevnetDir());
  const bind = opts.bind || spec.bindAddress || "127.0.0.1";
  if (bind !== "127.0.0.1" && bind !== "localhost") {
    throw new Error("kiln-svm devnet: bind address must be 127.0.0.1 (refusing to expose a local faucet)");
  }
  const rpcPort = Number(opts.rpcPort || spec.defaultRpcPort || DEFAULT_PORTS.kilnSvmRpc);
  const faucetPort = Number(opts.faucetPort || spec.defaultFaucetPort || DEFAULT_PORTS.kilnSvmFaucet);
  const rpcUrl = localUrl(rpcPort, bind);
  const tools = findSolanaTools();
  if (!tools.validator) throw new Error("solana-test-validator not found on PATH");
  if (!tools.keygen) throw new Error("solana-keygen not found on PATH");

  const existing = readState(dir);
  if (existing?.pid && pidAlive(existing.pid)) {
    const health = await waitForRpc(existing.rpcUrl, 3_000);
    if (health.ok) return { alreadyRunning: true, ...existing, health };
    await stopDevnet(dir);
  }

  mkdirSync(dir, { recursive: true });
  const ledger = join(dir, "ledger");
  let genesis = { ok: false, path: "none" };
  if (tools.genesis && opts.skipGenesis !== true) {
    genesis = writeCustomGenesis(dir, tools, spec);
  }

  let usedCustom = false;
  let spawned;
  if (genesis.ok) {
    spawned = spawnValidator(tools, { ledger, rpcPort, faucetPort, reset: false, bind });
    let health = await waitForRpc(rpcUrl, opts.bootTimeoutMs || 20_000);
    if (health.ok) {
      usedCustom = true;
      const state = {
        running: true,
        pid: spawned.pid,
        dir, ledger, rpcUrl, rpcPort, faucetPort, bind,
        genesisPath: "solana-genesis",
        genesisHash: health.genesisHash,
        keys: genesis.keys,
        startedAt: new Date().toISOString(),
        logFile: spawned.logFile,
      };
      writeJson(join(dir, "state.json"), state);
      return { alreadyRunning: false, ...state, health };
    }
    if (spawned.pid) {
      try { process.kill(spawned.pid, "SIGTERM"); } catch { /* */ }
    }
  }

  // Fallback: test-validator genesis (reliable single-process devnet).
  if (existsSync(ledger)) rmSync(ledger, { recursive: true, force: true });
  spawned = spawnValidator(tools, { ledger, rpcPort, faucetPort, reset: true, bind });
  const health = await waitForRpc(rpcUrl, opts.bootTimeoutMs || 40_000);
  const state = {
    running: health.ok,
    pid: spawned.pid,
    dir, ledger, rpcUrl, rpcPort, faucetPort, bind,
    genesisPath: usedCustom ? "solana-genesis" : "solana-test-validator",
    genesisHash: health.genesisHash || null,
    genesisAttempt: genesis.ok ? "custom-did-not-boot" : (genesis.error || "no-solana-genesis"),
    customGenesisError: genesis.ok ? "validator did not become healthy on custom ledger" : genesis.error || null,
    startedAt: new Date().toISOString(),
    logFile: spawned.logFile,
  };
  writeJson(join(dir, "state.json"), state);
  if (!health.ok) {
    const log = existsSync(spawned.logFile) ? readFileSync(spawned.logFile, "utf8").slice(-2000) : "";
    throw new Error(`kiln-svm devnet failed to boot on ${rpcUrl}: ${health.error}\n${log}`);
  }
  return { alreadyRunning: false, ...state, health };
}

export async function statusDevnet(dir = defaultDevnetDir()) {
  const st = readState(dir);
  if (!st) return { running: false, dir };
  const alive = pidAlive(st.pid);
  let health = null;
  if (alive && st.rpcUrl) health = await waitForRpc(st.rpcUrl, 2_000);
  return { ...st, running: !!(alive && health?.ok), processAlive: alive, health };
}

export { GENESIS_SPEC, REPO };
