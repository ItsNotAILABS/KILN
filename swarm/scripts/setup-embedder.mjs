#!/usr/bin/env node
/**
 * setup-embedder.mjs — install the OPTIONAL neural embedder runtime
 * (minilm-l6-v2: all-MiniLM-L6-v2 via @huggingface/transformers +
 * onnxruntime-node) into the embedder home, OUTSIDE the repo:
 *
 *   $KILN_MEMORY_EMBEDDER_HOME  or  ~/.cache/kiln-memory-embedder
 *     package.json + node_modules/   the transformers runtime
 *     models/                        the model weights (transformers cache)
 *
 * Nothing is added to the swarm's own tree — the runtime stays
 * zero-dependency, and hashing-v1 remains the default embedder.
 * This script is also the fetch path: the first run downloads the
 * package (~90MB with the bundled ONNX CPU binaries) and the model
 * (~25MB, q8). Later runs are no-ops except the smoke test.
 *
 * npm runs with --ignore-scripts on purpose: onnxruntime-node's
 * postinstall only downloads OPTIONAL CUDA binaries (its CPU
 * binaries are bundled in the package), and that download ignores
 * proxy settings on some networks and fails the whole install.
 *
 * Usage: node swarm/scripts/setup-embedder.mjs [--force]
 * Then:  KILN_MEMORY_EMBEDDER=minilm-l6-v2 node swarm/swarm.mjs memory recall ...
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  minilmEmbedder, minilmHome, minilmInstalled, MINILM_MODEL,
} from "../lib/memory-embedder-minilm.mjs";

const PIN = "@huggingface/transformers@4.3.1";
const home = minilmHome();
mkdirSync(home, { recursive: true });
if (!existsSync(join(home, "package.json"))) {
  writeFileSync(
    join(home, "package.json"),
    JSON.stringify({ name: "kiln-memory-embedder", private: true, version: "0.0.0" }, null, 2) + "\n",
  );
}

if (!minilmInstalled(home) || process.argv.includes("--force")) {
  console.log(`installing ${PIN} into ${home} (npm --ignore-scripts; see header for why)`);
  const r = spawnSync(
    "npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", PIN],
    { cwd: home, stdio: "inherit" },
  );
  if (r.status !== 0) {
    console.error("setup-embedder: npm install failed");
    process.exit(1);
  }
} else {
  console.log(`runtime already installed under ${home}`);
}

console.log(`warming model ${MINILM_MODEL} (first run downloads weights into ${join(home, "models")})`);
const t0 = Date.now();
const a = minilmEmbedder.embed("The daemon died and the doctor restarted it.");
const b = minilmEmbedder.embed("The daemon crashed and was revived by the doctor.");
const c = minilmEmbedder.embed("Grandma baked a chocolate cake for the party.");
if (!a || !b || !c) {
  console.error("setup-embedder: smoke test failed — embedder returned no signal");
  process.exit(1);
}
const cos = (x, y) => x.reduce((s, v, i) => s + v * y[i], 0);
console.log(
  `smoke: paraphrase cos=${cos(a, b).toFixed(3)} · unrelated cos=${cos(a, c).toFixed(3)} ` +
  `· load + 3 embeds in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
);
console.log("ready — select it with: KILN_MEMORY_EMBEDDER=minilm-l6-v2");
process.exit(0);
