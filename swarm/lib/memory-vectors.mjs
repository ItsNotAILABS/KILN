/**
 * KILN Memory — vector recall tier (phase 3, docs/KILN_MEMORY.md).
 *
 * A persisted vector per recallable doc (episode / fact), stored in
 * the SAME rebuildable SQLite sidecar as the phase-1 FTS5 index
 * (<state-dir>/memory-index/<owner>__<repo>.sqlite, table `vectors`).
 * The memory ref stays the source of truth; this tier is a derived
 * cache, synced from the signature-verified read path (readEvents —
 * a chain phase-2 verification rejects never gets embedded, and the
 * fallback scan re-walks the same chain and throws the same error).
 *
 * Recall fusion (Mem0-style multi-signal): the lexical result (FTS5
 * index or replay scan — BM25 + salience + recency + 1-hop link
 * expansion) is re-ranked by blending its normalized score with the
 * doc's cosine similarity to the query vector, and eligible docs the
 * lexical pass missed entirely can enter as `via: "vector"` hits.
 * Eligibility for those additions is computed from the replayed state
 * with exactly the scan/index rules (kinds, since/until, tags, fact
 * validity at asOf via factsAt()) — the vector tier never widens the
 * eligible universe, it only re-ranks and adds within it.
 *
 * THE EMBEDDER — read this before believing the word "semantic":
 * the default embedder (`hashing-v1`) is a deterministic signed
 * feature-hashing embedder over the library's own tokens plus
 * character trigrams — the same technique as MatDaemon's
 * `matdaemon_embed_text`. It is a LEXICAL signal: it knows shared
 * words and shared character n-grams (so "invoice" is close to
 * "invoices", "deploy" to "deployment"), and nothing else. It has
 * never seen a training corpus, it knows no synonyms, and a high
 * cosine here does NOT mean two texts mean the same thing. It is a
 * placeholder-tier signal shipped honestly behind the embedder
 * interface below; a real local neural embedder can register under
 * its own id and take over without touching recall. Vectors are
 * stamped with the embedder id that produced them; an id change
 * re-embeds the corpus on the next sync, so vectors from different
 * embedders are never mixed in one ranking.
 *
 * Honest boundaries:
 *   - No external calls, no API keys, no new dependencies: the
 *     embedder runs in-process in pure JS (zero-dependency ethos).
 *   - Any tier error (no node:sqlite, embedder throw, corrupt
 *     sidecar) → the caller serves the lexical result untouched,
 *     exactly like phase 1's fallback discipline.
 *   - KILN_MEMORY_VECTORS=off disables the tier;
 *     KILN_MEMORY_EMBEDDER=<id> selects a registered embedder
 *     (unknown id → tier unavailable → lexical result untouched).
 *   - Result provenance: a fused result keeps the lexical `engine`
 *     ("index" | "scan") and gains a top-level `fusion` block naming
 *     the embedder, its dimension and the blend weight; docs scored
 *     by the tier carry `vectorScore` (raw cosine, may be ≤ 0 for
 *     lexical hits the vector signal scored weakly); vector-only
 *     additions carry `via: "vector"`.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  readEvents, replayMemory, factsAt, tokenize, docText, episodeWhen,
} from "./memory.mjs";

let DatabaseSync = null;
try {
  DatabaseSync = process.getBuiltinModule?.("node:sqlite")?.DatabaseSync || null;
} catch { DatabaseSync = null; }

// ---------------------------------------------------------------- embedders

/** Blend weight of the vector signal in fused scores (lexical: 1 - this). */
export const VECTOR_WEIGHT = 0.35;

const HASH_DIM = 256;

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * hashing-v1: signed feature hashing over word tokens (weight 1) and
 * per-token character trigrams (weight 0.5), L2-normalized. Pure,
 * deterministic across processes and machines — the same text always
 * embeds to the same vector. Returns null when the text has no usable
 * tokens (nothing to embed).
 */
function hashingEmbed(text) {
  const tokens = tokenize(text);
  if (!tokens.length) return null;
  const vec = new Float64Array(HASH_DIM);
  const add = (feature, weight) => {
    const h = fnv1a(feature);
    const sign = (h >>> 16) & 1 ? -1 : 1;
    vec[h % HASH_DIM] += sign * weight;
  };
  for (const t of tokens) {
    add(`w:${t}`, 1);
    for (let i = 0; i + 3 <= t.length; i++) add(`g:${t.slice(i, i + 3)}`, 0.5);
  }
  let norm = 0;
  for (const x of vec) norm += x * x;
  norm = Math.sqrt(norm);
  if (!norm) return null;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return [...vec];
}

const EMBEDDERS = new Map();

/**
 * The embedder interface: { id, dim, embed(text) -> number[dim] | null }.
 * embed() must return an L2-normalized vector (cosine = dot product)
 * or null for "no signal". Registering a new id is the supported way
 * to swap in a real embedder later (e.g. a local neural model); the
 * sidecar re-embeds automatically when the active id changes.
 */
export function registerEmbedder(embedder) {
  if (!embedder || typeof embedder.id !== "string" || !embedder.id) {
    throw new Error("memory-vectors: embedder needs a string id");
  }
  if (!Number.isInteger(embedder.dim) || embedder.dim < 1) {
    throw new Error("memory-vectors: embedder needs a positive integer dim");
  }
  if (typeof embedder.embed !== "function") {
    throw new Error("memory-vectors: embedder needs an embed(text) function");
  }
  EMBEDDERS.set(embedder.id, embedder);
}

export function activeEmbedder() {
  const id = process.env.KILN_MEMORY_EMBEDDER || "hashing-v1";
  return EMBEDDERS.get(id) || null;
}

registerEmbedder({ id: "hashing-v1", dim: HASH_DIM, embed: hashingEmbed });

export function memoryVectorsEnabled() {
  return !!DatabaseSync && process.env.KILN_MEMORY_VECTORS !== "off" && !!activeEmbedder();
}

// ---------------------------------------------------------------- sidecar

function sidecarPath(dir, owner, repo) {
  return join(dir, "memory-index", `${owner}__${repo}.sqlite`);
}

function openVectors(dir, owner, repo) {
  mkdirSync(join(dir, "memory-index"), { recursive: true });
  const db = new DatabaseSync(sidecarPath(dir, owner, repo));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS vec_meta (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS vectors (
      event_id TEXT PRIMARY KEY, embedder TEXT NOT NULL, vec BLOB NOT NULL
    );
  `);
  return db;
}

function vecMetaGet(db, k) {
  const row = db.prepare("SELECT v FROM vec_meta WHERE k = ?").get(k);
  return row ? row.v : null;
}
function vecMetaSet(db, k, v) {
  db.prepare("INSERT INTO vec_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
    .run(k, v === null ? null : String(v));
}

function encodeVec(vec) {
  const f = Float32Array.from(vec);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}
function decodeVec(buf) {
  const ab = new ArrayBuffer(buf.length);
  new Uint8Array(ab).set(buf);
  return new Float32Array(ab);
}

/** The recallable doc set (episodes + all facts) as {id, kind, text}. */
function docSet(state) {
  const docs = [];
  for (const ep of state.episodes) docs.push({ id: ep.id, kind: "episode", text: docText("episode", ep) });
  for (const f of state.facts) docs.push({ id: f.id, kind: "fact", text: docText("fact", f) });
  return docs;
}

/**
 * Bring the vector store to the current ref tip. Reads through
 * readEvents, so hash-chain + signature verification run first — a
 * chain that fails verification throws here and is never embedded
 * (the caller's lexical scan throws the identical error itself).
 * Vectors are content-keyed by event id: event text is immutable
 * under the hash chain, so an existing (id, embedder) vector never
 * needs recomputing. An embedder-id change wipes and re-embeds.
 * Returns {tip, docs, embedded, embedder, dim, state} or null when
 * the tier is unavailable.
 */
export function syncMemoryVectors(dir, owner, repo) {
  if (!memoryVectorsEnabled()) return null;
  const emb = activeEmbedder();
  const { tip, events } = readEvents(dir, owner, repo);
  const state = replayMemory(events);
  const docs = docSet(state);
  const db = openVectors(dir, owner, repo);
  try {
    db.exec("BEGIN");
    try {
      if (vecMetaGet(db, "embedder") !== emb.id) {
        db.exec("DELETE FROM vectors");
        vecMetaSet(db, "embedder", emb.id);
        vecMetaSet(db, "dim", emb.dim);
      }
      const have = new Set(
        db.prepare("SELECT event_id FROM vectors WHERE embedder = ?").all(emb.id).map((r) => r.event_id),
      );
      const want = new Set(docs.map((d) => d.id));
      const del = db.prepare("DELETE FROM vectors WHERE event_id = ?");
      for (const id of have) if (!want.has(id)) del.run(id);
      const ins = db.prepare(
        "INSERT INTO vectors (event_id, embedder, vec) VALUES (?, ?, ?) " +
        "ON CONFLICT(event_id) DO UPDATE SET embedder = excluded.embedder, vec = excluded.vec",
      );
      let embedded = 0;
      for (const d of docs) {
        if (have.has(d.id)) continue;
        const v = emb.embed(d.text);
        if (!v) continue;
        ins.run(d.id, emb.id, encodeVec(v));
        embedded++;
      }
      vecMetaSet(db, "tip", tip || "");
      vecMetaSet(db, "syncTs", Math.floor(Date.now() / 1000));
      db.exec("COMMIT");
      return { tip, docs: docs.length, embedded, embedder: emb.id, dim: emb.dim, state };
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw e;
    }
  } finally {
    db.close();
  }
}

/** Sidecar vector stats for memoryStats — read-only, never syncs. */
export function memoryVectorsInfo(dir, owner, repo) {
  if (!memoryVectorsEnabled()) return null;
  if (!existsSync(sidecarPath(dir, owner, repo))) return null;
  let db;
  try {
    db = openVectors(dir, owner, repo);
    const embedder = vecMetaGet(db, "embedder");
    if (embedder === null) return null;
    const n = db.prepare("SELECT COUNT(*) AS n FROM vectors WHERE embedder = ?").get(embedder).n;
    return {
      embedder,
      dim: Number(vecMetaGet(db, "dim") || 0) || null,
      vectors: n,
      tip: vecMetaGet(db, "tip") || null,
      syncTs: Number(vecMetaGet(db, "syncTs") || 0) || null,
      // Plain-language label, carried into stats so no surface can
      // present this tier as more than it is.
      signal: embedder === "hashing-v1" ? "lexical-hashing (not semantic)" : "registered embedder",
    };
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* best effort */ }
  }
}

// ---------------------------------------------------------------- fusion

function eligibleDocs(state, opts, pre) {
  const kinds = new Set(opts.kinds && opts.kinds.length ? opts.kinds : ["episode", "fact"]);
  const out = new Map(); // id -> {kind, item}
  if (kinds.has("episode")) {
    for (const ep of state.episodes) {
      if (pre.sinceSec !== null && episodeWhen(ep) < pre.sinceSec) continue;
      if (pre.untilSec !== null && episodeWhen(ep) > pre.untilSec) continue;
      if (opts.tags && opts.tags.length && !(ep.tags || []).some((t) => opts.tags.includes(t))) continue;
      out.set(ep.id, { kind: "episode", item: ep });
    }
  }
  if (kinds.has("fact")) {
    for (const f of factsAt(state, pre.asOfSec, !!opts.includeSuperseded)) {
      out.set(f.id, { kind: "fact", item: f });
    }
  }
  return out;
}

/** Result row for a vector-only hit — same shape as the scan's rows. */
function vectorOnlyRow(kind, item, score, sim) {
  return {
    kind,
    id: item.id,
    seq: item.seq,
    score: Math.round(score * 1000) / 1000,
    via: "vector",
    vectorScore: Math.round(sim * 1000) / 1000,
    ts: item.ts,
    eventDate: kind === "episode" ? item.eventDate : item.validFrom,
    title: kind === "episode" ? item.title : undefined,
    text: kind === "episode" ? item.content : `${item.subject} ${item.predicate} ${item.object}`,
    tags: item.tags || [],
    entities: item.entities || [],
    source: kind === "episode" ? item.source : undefined,
    sourceEpisodes: kind === "fact" ? item.sourceEpisodes : undefined,
    superseded: kind === "fact" ? item.invalidAtTs !== null : undefined,
  };
}

/**
 * Fuse vector similarity into a lexical recall result.
 *
 * base: a result from recallIndexed / recallScan (already eligibility-
 * filtered, BM25-ranked). Returns a new result object — same hits,
 * re-ranked, plus eligible vector-only additions — or null when the
 * tier can't contribute (disabled, unknown embedder, empty query
 * signal, empty corpus). Any throw means "serve base untouched" to
 * the caller; note the sync's readEvents throw is the chain's own
 * integrity error, which the lexical scan surfaces identically.
 *
 * Fusion math: base scores are normalized by the base top score;
 * fused = (1 - VECTOR_WEIGHT) * baseNorm + VECTOR_WEIGHT * max(0, cos).
 * A base hit with no stored vector keeps only its lexical share.
 * Vector-only hits score VECTOR_WEIGHT * max(0, cos).
 */
export function fuseRecallVectors(dir, owner, repo, query, opts = {}, pre, base) {
  if (!memoryVectorsEnabled()) return null;
  const emb = activeEmbedder();
  const qv = emb.embed(query);
  if (!qv || qv.length !== emb.dim) return null;

  const synced = syncMemoryVectors(dir, owner, repo);
  if (!synced) return null;
  const eligible = eligibleDocs(synced.state, opts, pre);
  if (!eligible.size) return null;

  const db = openVectors(dir, owner, repo);
  let sims;
  try {
    sims = new Map();
    const rows = db.prepare("SELECT event_id, vec FROM vectors WHERE embedder = ?").all(emb.id);
    for (const row of rows) {
      if (!eligible.has(row.event_id)) continue;
      const v = decodeVec(row.vec);
      if (v.length !== emb.dim) continue;
      let dot = 0;
      for (let i = 0; i < emb.dim; i++) dot += qv[i] * v[i];
      sims.set(row.event_id, dot);
    }
  } finally {
    db.close();
  }
  if (!sims.size) return null;

  const limit = Math.min(100, Math.max(1, opts.limit ?? 10));
  const baseMax = base.results.reduce((m, r) => Math.max(m, r.score), 0);
  const W = VECTOR_WEIGHT;
  const sim01 = (id) => {
    const s = sims.get(id);
    return s === undefined ? undefined : Math.min(1, Math.max(0, s));
  };

  const fused = [];
  const baseIds = new Set();
  for (const r of base.results) {
    baseIds.add(r.id);
    const s01 = sim01(r.id);
    const baseNorm = baseMax > 0 ? r.score / baseMax : 0;
    const score = (1 - W) * baseNorm + (s01 === undefined ? 0 : W * s01);
    fused.push({
      ...r,
      score: Math.round(score * 1000) / 1000,
      ...(sims.has(r.id) ? { vectorScore: Math.round(sims.get(r.id) * 1000) / 1000 } : {}),
    });
  }
  for (const [id, sim] of sims) {
    if (baseIds.has(id) || sim <= 0) continue;
    const { kind, item } = eligible.get(id);
    fused.push(vectorOnlyRow(kind, item, W * Math.min(1, sim), sim));
  }
  fused.sort((a, b) => b.score - a.score || b.seq - a.seq);
  return {
    ...base,
    results: fused.slice(0, limit),
    fusion: {
      embedder: emb.id,
      dim: emb.dim,
      weight: W,
      signal: emb.id === "hashing-v1" ? "lexical-hashing (not semantic)" : "registered embedder",
      vectorsConsidered: sims.size,
    },
  };
}
