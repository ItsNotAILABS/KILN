/**
 * KILN Memory — cross-repo recall (phase 6, docs/KILN_MEMORY.md).
 *
 * Recall across EVERY repo memory chain in the state dir, fused into
 * one ranked result. This is a read-time fan-out, never a merged
 * global store: per-repo remains the storage boundary, each chain is
 * read and ranked by the exact single-repo machinery (lib/memory.mjs
 * recall — FTS5 sidecar tier, replay-scan fallback, phase-3 vector
 * fusion), and nothing is written anywhere by this module.
 *
 * Integrity posture (non-negotiable): before a repo is searched, its
 * chain is read through the phase-2 signature-verified path
 * (readEvents — hash chain + Ed25519 epoch rules). A chain that fails
 * verification is EXCLUDED from the results and reported in the
 * envelope (`repos[]` entry with status "excluded" + the error, and
 * the top-level `excluded` list) — a forged or broken chain can never
 * poison cross-repo results, and its exclusion is never silent.
 *
 * Provenance: every hit carries `repo` ("owner/repo"), `engine`
 * (the tier that produced it in its own repo: "index" | "scan"), the
 * repo envelope's `fusion` block when the vector tier engaged, the
 * `signing` summary of its chain (signed/legacy counts, epoch start,
 * signer ids), and `repoScore` — its raw score inside its own repo.
 *
 * Ranking fusion: per-repo scores are NOT comparable across repos
 * (BM25 idf and corpus statistics are per-corpus), so each hit's
 * merged `score` is its repo-local score max-normalized by its own
 * repo's top returned score — the same normalization phase-3 fusion
 * applies to its lexical base. A merged score therefore reads as
 * "strength within its own repo" in [0, 1]; the raw `repoScore`
 * stays on the hit for audit. This keeps a large corpus from
 * drowning a small one purely on corpus statistics.
 *
 * Eligibility parity is by construction: the per-repo recall call
 * applies kinds / since / until / tags / factsAt() exactly as a
 * single-repo query would. Global option errors (bad dates) are
 * validated once, up front, and throw — they are never mistaken for
 * per-repo exclusions.
 *
 * Cost, honestly: per query this performs one verified replay
 * (readEvents: O(events) hash + signature walk) per repo that has a
 * memory ref, plus the per-repo recall itself (sidecar-served when
 * the phase-1/3 sidecars are tip-fresh). There is no cross-repo
 * index; fan-out cost is linear in total events across repos for
 * the verification pass. Fine at today's scale (a handful of repos,
 * ≤ ~10³ events each); a posture cache is future work if the repo
 * count grows by orders of magnitude.
 *
 * Kill switch: KILN_MEMORY_CROSSREPO=off makes cross-repo recall
 * throw loudly. Single-repo recall is unaffected, and the per-tier
 * fallback discipline (phases 1/3) is untouched inside each repo.
 */
import { listRepos } from "./git.mjs";
import { recall, readEvents } from "./memory.mjs";
import { signatureSummary } from "./memory-signing.mjs";

export function memoryCrossRepoEnabled() {
  return process.env.KILN_MEMORY_CROSSREPO !== "off";
}

function checkDateOpt(v, what) {
  if (v === undefined || v === null) return;
  if (!Number.isFinite(Date.parse(v))) throw new Error(`memory: ${what} is not a valid date`);
}

/**
 * Cross-repo recall. Returns:
 *   { crossRepo: true, query, results: [hit…], repos: [status…], excluded: [{repo, error}…] }
 * hit: the single-repo hit shape plus { repo, score (normalized),
 *   repoScore (raw in-repo score), engine, signing, fusion? }.
 * status: { repo, status: "ok"|"empty"|"excluded", events, hits?,
 *   engine?, signing, error? }.
 */
export function recallCrossRepo(dir, query, opts = {}) {
  if (!memoryCrossRepoEnabled()) {
    throw new Error("memory: cross-repo recall is disabled (KILN_MEMORY_CROSSREPO=off)");
  }
  // Global options are validated once, before fan-out — a bad date
  // is a caller error, not a per-repo exclusion.
  checkDateOpt(opts.asOf, "asOf");
  checkDateOpt(opts.since, "since");
  checkDateOpt(opts.until, "until");
  const limit = Math.min(100, Math.max(1, opts.limit ?? 10));

  const repos = [];
  const excluded = [];
  const merged = [];
  for (const { owner, repo } of listRepos(dir)) {
    const name = `${owner}/${repo}`;
    // Integrity gate: the phase-2 verified read. Any throw (hash
    // chain, signature epoch, blob integrity) excludes the repo —
    // loudly, in the envelope — and the fan-out continues.
    let events;
    try {
      ({ events } = readEvents(dir, owner, repo));
    } catch (e) {
      const error = String(e.message || e);
      repos.push({ repo: name, status: "excluded", events: null, signing: null, error });
      excluded.push({ repo: name, error });
      continue;
    }
    const signing = signatureSummary(events);
    if (!events.length) {
      repos.push({ repo: name, status: "empty", events: 0, signing });
      continue;
    }
    // Same limit per repo: every repo gets up to `limit` candidates
    // into the merge before the global slice.
    const r = recall(dir, owner, repo, query, { ...opts, limit });
    const rawMax = r.results.reduce((m, x) => Math.max(m, x.score), 0);
    for (const hit of r.results) {
      merged.push({
        ...hit,
        repo: name,
        score: rawMax > 0 ? Math.round((hit.score / rawMax) * 1000) / 1000 : 0,
        repoScore: hit.score,
        engine: r.engine,
        ...(r.fusion ? { fusion: r.fusion } : {}),
        signing,
      });
    }
    repos.push({
      repo: name, status: "ok", events: events.length, hits: r.results.length,
      engine: r.engine, signing,
    });
  }
  merged.sort((a, b) =>
    b.score - a.score || b.repoScore - a.repoScore ||
    (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0) || b.seq - a.seq);
  return {
    crossRepo: true,
    query,
    results: merged.slice(0, limit),
    repos,
    excluded,
  };
}
