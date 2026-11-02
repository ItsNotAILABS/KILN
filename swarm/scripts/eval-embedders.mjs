#!/usr/bin/env node
/**
 * eval-embedders.mjs — measured embedder comparison for the memory
 * vector tier. NOT part of the test suite (the suite must stay green
 * with no model and no network); this is the operator's proof tool.
 *
 * For each registered embedder it embeds a fixed set of paraphrase
 * pairs (same meaning, deliberately varied wording) and unrelated
 * pairs (first text of each pair vs the second text of the NEXT
 * pair — different topics entirely), then reports mean cosine for
 * related vs unrelated and the separation gap.
 *
 * A lexical embedder (hashing-v1) separates mostly by shared words /
 * character n-grams, so its gap is small and its "unrelated" scores
 * ride on accidental token overlap. A semantic embedder
 * (minilm-l6-v2) should show related >> unrelated. The numbers are
 * printed, never asserted — judge for yourself.
 *
 * Usage: node swarm/scripts/eval-embedders.mjs
 * (minilm-l6-v2 needs scripts/setup-embedder.mjs first; without it
 * the script prints UNAVAILABLE for that row and still exits 0.)
 */
import { activeEmbedder } from "../lib/memory-vectors.mjs";

const PAIRS = [
  ["The daemon died at 3am and the doctor restarted it within seconds.",
   "When the daemon crashed overnight, the doctor brought it back almost immediately."],
  ["How do I rotate the operator secret for the forge?",
   "What is the procedure to change the forge operator credential?"],
  ["The March invoice was paid in full by the client.",
   "The client settled the March bill completely."],
  ["She ordered a chocolate cake with gold decorations for the party.",
   "For the celebration she bought a chocolate cake decorated in gold."],
  ["Memory events are signed so tampering is evident against any other copy.",
   "Because memory events carry signatures, edits can be detected by comparing copies."],
  ["The worker's restart budget renews after an hour of healthy running.",
   "A worker earns its restart budget back once it has run healthily for an hour."],
  ["Pushing to GitHub carries the repo's memory chain with it.",
   "When a repo is promoted to GitHub, its memory history is replayed too."],
  ["Guests loved the party app and used it all night.",
   "Party guests enjoyed the app and kept using it through the evening."],
];

const cos = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

function evaluate(id) {
  process.env.KILN_MEMORY_EMBEDDER = id;
  const emb = activeEmbedder();
  if (!emb) return { id, error: "not registered" };
  let related, unrelated;
  try {
    const A = PAIRS.map(([a]) => emb.embed(a));
    const B = PAIRS.map(([, b]) => emb.embed(b));
    if (A.some((v) => !v) || B.some((v) => !v)) return { id, error: "embed returned no signal" };
    related = PAIRS.map((_, i) => cos(A[i], B[i]));
    unrelated = PAIRS.map((_, i) => cos(A[i], B[(i + 1) % PAIRS.length]));
  } catch (e) {
    return { id, error: e.message };
  }
  return {
    id,
    dim: emb.dim,
    signal: emb.signal || "registered embedder",
    relatedMean: mean(related),
    unrelatedMean: mean(unrelated),
    gap: mean(related) - mean(unrelated),
    relatedMin: Math.min(...related),
    unrelatedMax: Math.max(...unrelated),
  };
}

console.log(`embedder evaluation: ${PAIRS.length} paraphrase pairs vs ${PAIRS.length} unrelated pairs\n`);
for (const id of ["hashing-v1", "minilm-l6-v2"]) {
  const r = evaluate(id);
  if (r.error) {
    console.log(`${id.padEnd(14)} UNAVAILABLE — ${r.error}`);
    continue;
  }
  console.log(
    `${id.padEnd(14)} dim=${r.dim}  ${r.signal}\n` +
    `${"".padEnd(14)} related  mean=${r.relatedMean.toFixed(3)} min=${r.relatedMin.toFixed(3)}\n` +
    `${"".padEnd(14)} unrelated mean=${r.unrelatedMean.toFixed(3)} max=${r.unrelatedMax.toFixed(3)}\n` +
    `${"".padEnd(14)} separation gap = ${r.gap.toFixed(3)}`,
  );
}
process.exit(0);
