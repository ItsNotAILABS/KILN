/**
 * memory-embedder-worker.mjs — worker thread hosting the neural
 * embedder (all-MiniLM-L6-v2 via @huggingface/transformers +
 * onnxruntime-node). Spawned lazily by lib/memory-embedder-minilm.mjs;
 * never imported by the main thread.
 *
 * The swarm's embedder interface is synchronous (see
 * lib/memory-vectors.mjs), and ONNX inference is not — so the model
 * lives here and the main thread blocks on a SharedArrayBuffer
 * handshake per embed:
 *
 *   ctrl[0]  state: 0 idle -> 1 request -> 2 done -> 0 idle
 *   ctrl[1]  result length in floats (-1 = inference failed / no signal)
 *   ctrl[2]  load state: 0 loading, 1 ready, 2 failed (errBuf has why)
 *   ctrl[3]  request text length in bytes (textBuf, UTF-8)
 *
 * Buffers (single SAB): ctrl 16B | err 1024B | text 256KB | vec 384 f32.
 * One request at a time — the main thread is blocked waiting, so
 * there is never a second caller.
 */
import { workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";

const { sab, entry, cacheDir, model } = workerData;
const ctrl = new Int32Array(sab, 0, 4);
const errBuf = new Uint8Array(sab, 16, 1024);
const textBuf = new Uint8Array(sab, 1040, 262144);
const vecBuf = new Float32Array(sab, 263184, 384);
const enc = new TextEncoder();
const dec = new TextDecoder();

function setError(msg) {
  const b = enc.encode(String(msg || "unknown error").slice(0, 1000));
  errBuf.fill(0);
  errBuf.set(b);
}

let extractor = null;
try {
  const tf = await import(pathToFileURL(entry).href);
  tf.env.cacheDir = cacheDir;
  extractor = await tf.pipeline("feature-extraction", model, { dtype: "q8" });
  Atomics.store(ctrl, 2, 1);
} catch (e) {
  setError(e?.message || String(e));
  Atomics.store(ctrl, 2, 2);
}
Atomics.notify(ctrl, 2);

if (!extractor) {
  // Load failed: park forever. The main thread reads the failure
  // from ctrl[2] + errBuf and never issues a request.
  for (;;) Atomics.wait(ctrl, 0, 0, 60000);
}

for (;;) {
  while (Atomics.load(ctrl, 0) !== 1) Atomics.wait(ctrl, 0, 0, 250);
  const len = Atomics.load(ctrl, 3);
  const text = dec.decode(textBuf.slice(0, len));
  let n = -1;
  try {
    const out = await extractor(text, { pooling: "mean", normalize: true });
    if (out?.data && out.data.length === 384) {
      vecBuf.set(out.data);
      n = 384;
    }
  } catch {
    n = -1; // per-text inference failure -> "no signal" for this text
  }
  Atomics.store(ctrl, 1, n);
  Atomics.store(ctrl, 0, 2);
  Atomics.notify(ctrl, 0);
}
