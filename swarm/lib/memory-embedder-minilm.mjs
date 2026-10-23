/**
 * memory-embedder-minilm.mjs — a REAL local neural embedder for the
 * memory vector tier: all-MiniLM-L6-v2 (384-dim, mean-pooled,
 * L2-normalized sentence embeddings) running on-device via
 * @huggingface/transformers + onnxruntime-node. No API keys, no
 * external calls at inference time; weights are files in a local
 * cache. Registered in lib/memory-vectors.mjs as `minilm-l6-v2`.
 *
 * Why a worker + Atomics.wait: the tier's embedder interface is
 * synchronous (embed(text) -> number[] | null) and ONNX inference is
 * async. The model lives in lib/memory-embedder-worker.mjs; embed()
 * hands it one text over a SharedArrayBuffer and blocks until the
 * vector lands. Consistent with the tier's existing posture — the
 * lexical path it fuses into is already fully synchronous (replay
 * scans, execFileSync git reads). First embed in a process pays the
 * model load (seconds from cache); steady-state embeds are ~10–30ms.
 *
 * OPTIONAL RUNTIME, OUTSIDE GIT: the transformers package and the
 * model weights live under the embedder home —
 * $KILN_MEMORY_EMBEDDER_HOME or ~/.cache/kiln-memory-embedder —
 * installed by swarm/scripts/setup-embedder.mjs. Nothing large ever
 * enters the repo tree, and the swarm itself stays zero-dependency:
 * this module imports only node: builtins.
 *
 * Failure honesty:
 *   - Runtime not installed / model fails to load / inference hangs
 *     -> embed() THROWS an "unavailable" error naming the setup
 *     command. In the sync path that throw rolls back the vector
 *     transaction (previously stored vectors survive) and recall
 *     serves the untouched lexical result — the same discipline as
 *     every other tier failure. The active id in stats/fusion only
 *     ever names minilm-l6-v2 after a sync actually embedded with it.
 *   - A single text's inference failure -> null ("no signal"),
 *     exactly like hashing-v1 returns null for tokenless text.
 */
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const MINILM_ID = "minilm-l6-v2";
export const MINILM_MODEL = "Xenova/all-MiniLM-L6-v2";
export const MINILM_DIM = 384;

const CTRL_BYTES = 16;
const ERR_BYTES = 1024;
const TEXT_BYTES = 262144;
const VEC_OFF = CTRL_BYTES + ERR_BYTES + TEXT_BYTES; // 263184, 4-aligned

const READY_TIMEOUT_MS = 120000; // first load: weights read + session init
const EMBED_TIMEOUT_MS = 60000;

export function minilmHome() {
  return process.env.KILN_MEMORY_EMBEDDER_HOME || join(homedir(), ".cache", "kiln-memory-embedder");
}

export function minilmInstalled(home = minilmHome()) {
  return existsSync(join(home, "node_modules", "@huggingface", "transformers", "package.json"));
}

let instance = null; // keyed by home; a home change spawns a fresh worker

function startInstance(home) {
  const sab = new SharedArrayBuffer(VEC_OFF + MINILM_DIM * 4);
  const inst = {
    home,
    failed: null,
    worker: null,
    ctrl: new Int32Array(sab, 0, 4),
    errBuf: new Uint8Array(sab, CTRL_BYTES, ERR_BYTES),
    textBuf: new Uint8Array(sab, CTRL_BYTES + ERR_BYTES, TEXT_BYTES),
    vecBuf: new Float32Array(sab, VEC_OFF, MINILM_DIM),
  };
  if (!minilmInstalled(home)) {
    inst.failed = `runtime not installed under ${home} (no @huggingface/transformers there)`;
    return inst;
  }
  let entry;
  try {
    entry = createRequire(join(home, "package.json")).resolve("@huggingface/transformers");
  } catch (e) {
    inst.failed = `cannot resolve @huggingface/transformers under ${home}: ${e.message}`;
    return inst;
  }
  const worker = new Worker(new URL("./memory-embedder-worker.mjs", import.meta.url), {
    workerData: { sab, entry, cacheDir: join(home, "models"), model: MINILM_MODEL },
  });
  worker.unref(); // never keep a CLI process alive just for the embedder
  worker.on("error", (e) => { inst.failed = `embedder worker died: ${e.message}`; });
  inst.worker = worker;
  return inst;
}

function unavailable(inst) {
  return new Error(
    `minilm-l6-v2 embedder unavailable: ${inst.failed || "unknown failure"} — ` +
    "install/repair with: node swarm/scripts/setup-embedder.mjs",
  );
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function minilmEmbed(text) {
  const s = String(text ?? "");
  if (!/[a-z0-9]{2,}/i.test(s)) return null; // no signal, mirroring hashing-v1
  const home = minilmHome();
  if (!instance || instance.home !== home) instance = startInstance(home);
  const inst = instance;
  if (inst.failed) throw unavailable(inst);

  // Wait for the model load (first embed in the process pays it).
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const load = Atomics.load(inst.ctrl, 2);
    if (load === 1) break;
    if (load === 2) {
      const msg = dec.decode(inst.errBuf).replace(/\0[\s\S]*$/, "").trim();
      inst.failed = `model load failed: ${msg || "unknown error"}`;
      throw unavailable(inst);
    }
    if (inst.failed) throw unavailable(inst);
    if (Date.now() > deadline) {
      inst.failed = `model load timed out after ${READY_TIMEOUT_MS}ms`;
      throw unavailable(inst);
    }
    Atomics.wait(inst.ctrl, 2, 0, 1000);
  }

  // Hand the text over (doc texts are small; the guard is for safety).
  let body = s;
  let bytes = enc.encode(body);
  while (bytes.length > TEXT_BYTES) {
    body = body.slice(0, Math.floor(body.length * 0.9));
    bytes = enc.encode(body);
  }
  inst.textBuf.set(bytes);
  Atomics.store(inst.ctrl, 3, bytes.length);
  Atomics.store(inst.ctrl, 1, -2); // "no result yet" sentinel
  Atomics.store(inst.ctrl, 0, 1);
  Atomics.notify(inst.ctrl, 0);

  const dl = Date.now() + EMBED_TIMEOUT_MS;
  while (Atomics.load(inst.ctrl, 0) !== 2) {
    if (inst.failed) throw unavailable(inst);
    if (Date.now() > dl) {
      inst.failed = `inference timed out after ${EMBED_TIMEOUT_MS}ms`;
      throw unavailable(inst);
    }
    Atomics.wait(inst.ctrl, 0, 1, 500);
  }
  const n = Atomics.load(inst.ctrl, 1);
  Atomics.store(inst.ctrl, 0, 0);
  if (n !== MINILM_DIM) return null; // this text failed inference -> no signal
  return [...inst.vecBuf];
}

/** The embedder object registered with the vector tier. */
export const minilmEmbedder = {
  id: MINILM_ID,
  dim: MINILM_DIM,
  signal: "neural · all-MiniLM-L6-v2 (local ONNX)",
  embed: minilmEmbed,
};

/** Operator-facing status (setup script, diagnostics). Never throws. */
export function minilmStatus() {
  const home = minilmHome();
  const out = {
    id: MINILM_ID,
    model: MINILM_MODEL,
    home,
    installed: minilmInstalled(home),
    loadState: "not-started",
  };
  if (instance && instance.home === home) {
    if (instance.failed) {
      out.loadState = "failed";
      out.error = instance.failed;
    } else {
      out.loadState = ["loading", "ready", "failed"][Atomics.load(instance.ctrl, 2)] || "loading";
    }
  }
  return out;
}
