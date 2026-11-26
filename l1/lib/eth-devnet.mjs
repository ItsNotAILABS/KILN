/**
 * Local Ethereum devnet: Anvil, bound to 127.0.0.1 only.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { DEFAULT_PORTS } from "./base-adapter.mjs";
import { rpc, localUrl } from "./rpc.mjs";
import { resolveBin } from "./which.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

export function defaultEthDir() {
  return join(ROOT, ".devnet", "ethereum");
}

function whichAnvil() {
  return resolveBin("anvil");
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function writeJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
}

export function readEthState(dir = defaultEthDir()) {
  const p = join(dir, "state.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

export async function stopEthDevnet(dir = defaultEthDir()) {
  const st = readEthState(dir);
  if (st?.pid && pidAlive(st.pid)) {
    try { process.kill(st.pid, "SIGTERM"); } catch { /* */ }
    for (let i = 0; i < 20; i++) {
      if (!pidAlive(st.pid)) break;
      await sleep(100);
    }
    if (pidAlive(st.pid)) {
      try { process.kill(st.pid, "SIGKILL"); } catch { /* */ }
    }
  }
  if (st) writeJson(join(dir, "state.json"), { ...st, pid: null, running: false, stoppedAt: new Date().toISOString() });
  return { stopped: true, dir };
}

async function waitForRpc(url, timeoutMs = 20_000) {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    try {
      const chainId = Number(await rpc(url, "eth_chainId", []));
      const block = Number(await rpc(url, "eth_blockNumber", []));
      return { ok: true, chainId, blockNumber: block };
    } catch (e) {
      last = e.message;
      await sleep(150);
    }
  }
  return { ok: false, error: last || "timed out waiting for Anvil" };
}

/** Well-known Anvil / Foundry default account 0 (documentation only; test use). */
export const ANVIL_ACCOUNT_0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
export const ANVIL_ACCOUNT_1 = "0x70997970C51812dc3A010C7dAbBdA33021cE538d";

export async function startEthDevnet(opts = {}) {
  const dir = resolve(opts.dir || defaultEthDir());
  const bind = opts.bind || "127.0.0.1";
  if (bind !== "127.0.0.1" && bind !== "localhost") {
    throw new Error("ethereum devnet: bind address must be 127.0.0.1");
  }
  const port = Number(opts.port || DEFAULT_PORTS.ethereum);
  const rpcUrl = localUrl(port, bind);
  const anvil = whichAnvil();
  if (!anvil) throw new Error("anvil not found on PATH (install Foundry, or skip eth integration tests)");

  const existing = readEthState(dir);
  if (existing?.pid && pidAlive(existing.pid)) {
    const health = await waitForRpc(existing.rpcUrl, 2_000);
    if (health.ok) return { alreadyRunning: true, ...existing, health };
    await stopEthDevnet(dir);
  }

  mkdirSync(dir, { recursive: true });
  const logFile = join(dir, "anvil.log");
  writeFileSync(logFile, "");
  const child = spawn(anvil, [
    "--host", bind,
    "--port", String(port),
    "--chain-id", String(opts.chainId || 31337),
    "--silent",
  ], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const onData = (buf) => { try { writeFileSync(logFile, buf, { flag: "a" }); } catch { /* */ } };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.unref();

  const health = await waitForRpc(rpcUrl, opts.bootTimeoutMs || 20_000);
  const state = {
    running: health.ok,
    pid: child.pid,
    dir, rpcUrl, port, bind,
    chainId: health.chainId || opts.chainId || 31337,
    accounts: { "0": ANVIL_ACCOUNT_0, "1": ANVIL_ACCOUNT_1 },
    startedAt: new Date().toISOString(),
    logFile,
  };
  writeJson(join(dir, "state.json"), state);
  if (!health.ok) {
    const log = existsSync(logFile) ? readFileSync(logFile, "utf8").slice(-2000) : "";
    throw new Error(`anvil failed to boot on ${rpcUrl}: ${health.error}\n${log}`);
  }
  return { alreadyRunning: false, ...state, health };
}

export async function statusEthDevnet(dir = defaultEthDir()) {
  const st = readEthState(dir);
  if (!st) return { running: false, dir };
  const alive = pidAlive(st.pid);
  let health = null;
  if (alive && st.rpcUrl) health = await waitForRpc(st.rpcUrl, 2_000);
  return { ...st, running: !!(alive && health?.ok), processAlive: alive, health };
}
