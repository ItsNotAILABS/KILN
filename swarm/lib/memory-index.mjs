/**
 * KILN Memory — FTS5 index sidecar (phase 1, docs/KILN_MEMORY.md).
 *
 * The memory ref (`refs/kiln/memory`) stays the source of truth, always.
 * This module maintains a REBUILDABLE SQLite sidecar per repo under
 * <state-dir>/memory-index/<owner>__<repo>.sqlite so recall stops paying
 * a full git replay + full-corpus tokenization on every query:
 *
 *   - sync: one rev-parse-class check (readEvents tip vs indexed tip).
 *     Fresh → O(1). Behind → replay once, upsert only what changed
 *     (episodes are immutable; fact validity windows are refreshed from
 *     the replayed state; links rewritten). Diverged (prefix hash
 *     mismatch — should be impossible under append-only CAS) → full
 *     rebuild. The ref is never written by this module.
 *   - recall: FTS5 MATCH over PRE-TOKENIZED text. Docs are indexed as
 *     space-joined KILN tokens (lib/memory.mjs tokenize()), so the FTS
 *     candidate set is exactly the set of docs containing a query term —
 *     the same universe the v1 scan scores. Ranking = FTS5 BM25 fused
 *     with the same salience/recency boosts and the same 1-hop link
 *     expansion as the scan path; eligibility (kinds, since/until, tags,
 *     fact validity at asOf) is enforced exactly as factsAt() does.
 *
 * Honest boundaries:
 *   - FTS5's idf differs from the scan's Lucene-style idf (FTS5 can go
 *     ≤ 0 for terms in over half the corpus). Scores are ranking
 *     numbers, not a contract; hit sets and top hits agree with the
 *     scan on real corpora (equivalence-tested), exact score values
 *     may differ.
 *   - Any index error (no node:sqlite, corrupt DB, sync failure)
 *     falls back to the v1 scan path in lib/memory.mjs — recall never
 *     fails because a derived cache did. KILN_MEMORY_INDEX=off
 *     disables the sidecar entirely.
 *   - A write that lands mid-recall is seen on the next call (the tip
 *     check runs per call).
 */
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readEvents, replayMemory, tokenize, docText, episodeWhen } from "./memory.mjs";

let DatabaseSync = null;
try {
  DatabaseSync = process.getBuiltinModule?.("node:sqlite")?.DatabaseSync || null;
} catch { DatabaseSync = null; }

export function memoryIndexEnabled() {
  return !!DatabaseSync && process.env.KILN_MEMORY_INDEX !== "off";
}

function indexPath(dir, owner, repo) {
  return join(dir, "memory-index", `${owner}__${repo}.sqlite`);
}

function openIndex(dir, owner, repo) {
  mkdirSync(join(dir, "memory-index"), { recursive: true });
  const db = new DatabaseSync(indexPath(dir, owner, repo));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS docs (
      event_id TEXT PRIMARY KEY, kind TEXT NOT NULL, seq INTEGER NOT NULL,
      ts INTEGER NOT NULL, when_ts INTEGER NOT NULL, salience REAL NOT NULL DEFAULT 1,
      invalid_at_ts INTEGER, title TEXT, text TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]', entities TEXT NOT NULL DEFAULT '[]',
      event_date TEXT, source TEXT, source_episodes TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(event_id UNINDEXED, text);
    CREATE TABLE IF NOT EXISTS links (from_id TEXT NOT NULL, to_id TEXT NOT NULL, relation TEXT NOT NULL);
  `);
  return db;
}

function metaGet(db, k) {
  const row = db.prepare("SELECT v FROM meta WHERE k = ?").get(k);
  return row ? row.v : null;
}
function metaSet(db, k, v) {
  db.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v === null ? null : String(v));
}

/**
 * Bring the sidecar to the current ref tip. Returns {tip, docs} or null
 * when the sidecar is unavailable. Throws only on ref/read errors the
 * caller must not paper over (readEvents integrity failures) — the
 * caller (recall) treats any throw as "fall back to scan", which will
 * surface the same integrity error itself.
 */
export function syncMemoryIndex(dir, owner, repo) {
  if (!memoryIndexEnabled()) return null;
  const { tip, events } = readEvents(dir, owner, repo);
  const db = openIndex(dir, owner, repo);
  try {
    const indexedTip = metaGet(db, "tip");
    if (indexedTip === (tip || "")) {
      return { tip, docs: Number(metaGet(db, "docs") || 0), fresh: true };
    }
    const state = replayMemory(events);
    let lastSeq = Number(metaGet(db, "lastSeq") || 0);
    const lastHash = metaGet(db, "lastHash");
    const prefixOk = lastSeq === 0 || (events.length >= lastSeq && lastSeq > 0 && events[lastSeq - 1]?.hash === lastHash);
    db.exec("BEGIN");
    try {
      if (!prefixOk) {
        db.exec("DELETE FROM docs; DELETE FROM fts; DELETE FROM links;");
        lastSeq = 0;
      }
      const upDoc = db.prepare(`
        INSERT INTO docs (event_id, kind, seq, ts, when_ts, salience, invalid_at_ts, title, text, tags, entities, event_date, source, source_episodes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(event_id) DO UPDATE SET invalid_at_ts = excluded.invalid_at_ts`);
      const hasFts = db.prepare("SELECT 1 AS x FROM fts WHERE event_id = ?");
      const insFts = db.prepare("INSERT INTO fts (event_id, text) VALUES (?, ?)");
      const indexDoc = (kind, item, whenTs, text) => {
        upDoc.run(
          item.id, kind, item.seq, item.ts, whenTs,
          Number.isFinite(item.salience) ? item.salience : 1,
          kind === "fact" ? (item.invalidAtTs ?? null) : null,
          kind === "episode" ? (item.title || "") : null,
          text,
          JSON.stringify(item.tags || []), JSON.stringify(item.entities || []),
          kind === "episode" ? (item.eventDate || null) : (item.validFrom || null),
          kind === "episode" ? JSON.stringify(item.source || null) : null,
          kind === "fact" ? JSON.stringify(item.sourceEpisodes || []) : null,
        );
        if (!hasFts.get(item.id)) {
          insFts.run(item.id, tokenize(docText(kind, item)).join(" "));
        }
      };
      for (const ep of state.episodes) {
        if (ep.seq >= lastSeq) indexDoc("episode", ep, episodeWhen(ep), ep.content);
      }
      for (const f of state.facts) {
        indexDoc("fact", f, f.validFromTs, `${f.subject} ${f.predicate} ${f.object}`);
      }
      db.exec("DELETE FROM links");
      const insLink = db.prepare("INSERT INTO links (from_id, to_id, relation) VALUES (?, ?, ?)");
      for (const l of state.links) insLink.run(l.from, l.to, l.relation);
      const docs = db.prepare("SELECT COUNT(*) AS n FROM docs").get().n;
      metaSet(db, "tip", tip || "");
      metaSet(db, "lastSeq", events.length);
      metaSet(db, "lastHash", events.length ? events[events.length - 1].hash : null);
      metaSet(db, "docs", docs);
      metaSet(db, "syncTs", Math.floor(Date.now() / 1000));
      db.exec("COMMIT");
      return { tip, docs, fresh: false };
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw e;
    }
  } finally {
    db.close();
  }
}

/** Sidecar stats for memoryStats — read-only, never triggers a sync. */
export function memoryIndexInfo(dir, owner, repo) {
  if (!memoryIndexEnabled()) return null;
  if (!existsSync(indexPath(dir, owner, repo))) return null;
  let db;
  try {
    db = openIndex(dir, owner, repo);
    const tip = metaGet(db, "tip");
    if (tip === null) return null;
    return {
      tip: tip || null,
      docs: Number(metaGet(db, "docs") || 0),
      lastSeq: Number(metaGet(db, "lastSeq") || 0),
      syncTs: Number(metaGet(db, "syncTs") || 0) || null,
    };
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* best effort */ }
  }
}

function rowToDoc(row) {
  return {
    kind: row.kind,
    id: row.event_id,
    seq: row.seq,
    ts: row.ts,
    whenTs: row.when_ts,
    salience: row.salience,
    invalidAtTs: row.invalid_at_ts,
    title: row.title,
    text: row.text,
    tags: JSON.parse(row.tags || "[]"),
    entities: JSON.parse(row.entities || "[]"),
    eventDate: row.event_date,
    source: row.source ? JSON.parse(row.source) : undefined,
    sourceEpisodes: row.source_episodes ? JSON.parse(row.source_episodes) : undefined,
  };
}

function eligible(doc, { kinds, asOfSec, sinceSec, untilSec, tagFilter, includeSuperseded }) {
  if (!kinds.has(doc.kind)) return false;
  if (doc.kind === "episode") {
    if (sinceSec !== null && doc.whenTs < sinceSec) return false;
    if (untilSec !== null && doc.whenTs > untilSec) return false;
    if (tagFilter && tagFilter.length && !doc.tags.some((t) => tagFilter.includes(t))) return false;
  } else {
    if (doc.whenTs > asOfSec) return false;
    if (!includeSuperseded && doc.invalidAtTs !== null && doc.invalidAtTs <= asOfSec) return false;
  }
  return true;
}

/**
 * Indexed recall. Mirrors lib/memory.mjs recall()'s result shape and
 * semantics; returns null when the sidecar can't serve (disabled or
 * empty query universe) so the caller falls back to the scan. Any
 * throw likewise means "fall back" to the caller.
 * pre: {asOfSec, sinceSec, untilSec} — date options pre-validated by
 * the caller so invalid dates throw identically on both paths.
 */
export function recallIndexed(dir, owner, repo, query, opts = {}, pre) {
  if (!memoryIndexEnabled()) return null;
  const qTokens = [...new Set(tokenize(query))];
  if (!qTokens.length) return { repo: `${owner}/${repo}`, query, results: [], engine: "index" };

  const synced = syncMemoryIndex(dir, owner, repo);
  if (!synced) return null;

  const limit = Math.min(100, Math.max(1, opts.limit ?? 10));
  const kinds = new Set(opts.kinds && opts.kinds.length ? opts.kinds : ["episode", "fact"]);
  const ctx = {
    kinds,
    asOfSec: pre.asOfSec,
    sinceSec: pre.sinceSec,
    untilSec: pre.untilSec,
    tagFilter: opts.tags || null,
    includeSuperseded: !!opts.includeSuperseded,
  };
  const now = Math.floor(Date.now() / 1000);
  const boost = (doc, bm25) => {
    const ageDays = Math.max(0, (now - doc.whenTs) / 86400);
    const recency = 1 / (1 + ageDays / 30);
    const salience = Number.isFinite(doc.salience) ? doc.salience : 1;
    return bm25 * (0.7 + 0.3 * Math.min(1, salience / 5)) + 0.15 * recency;
  };

  const db = openIndex(dir, owner, repo);
  try {
    const match = qTokens.map((t) => `"${t}"`).join(" OR ");
    const rows = db.prepare(
      "SELECT d.*, -bm25(fts) AS bm FROM fts JOIN docs d ON d.event_id = fts.event_id WHERE fts MATCH ?"
    ).all(match);
    const scored = new Map(); // id -> {doc, bm25, score}
    for (const row of rows) {
      const doc = rowToDoc(row);
      if (!eligible(doc, ctx)) continue;
      scored.set(doc.id, { doc, bm25: row.bm, score: boost(doc, row.bm) });
    }
    const hits = [...scored.values()]
      .filter((s) => s.bm25 > 0)
      .sort((a, b) => b.score - a.score || b.doc.seq - a.doc.seq)
      .slice(0, limit);
    if (!hits.length) return { repo: `${owner}/${repo}`, query, results: [], engine: "index" };

    // One-hop link expansion — same rule as the scan: a doc linked to a
    // hit joins with its own score + 25% of the top hit's score.
    const hitIds = new Set(hits.map((h) => h.doc.id));
    const topScore = hits[0].score;
    const expanded = [];
    const linkRows = db.prepare("SELECT from_id, to_id, relation FROM links").all();
    const getDoc = db.prepare("SELECT * FROM docs WHERE event_id = ?");
    for (const l of linkRows) {
      for (const [a, bId] of [[l.from_id, l.to_id], [l.to_id, l.from_id]]) {
        if (!hitIds.has(a) || hitIds.has(bId)) continue;
        let s = scored.get(bId);
        if (!s) {
          const row = getDoc.get(bId);
          if (!row) continue;
          const doc = rowToDoc(row);
          if (!eligible(doc, ctx)) continue;
          s = { doc, bm25: 0, score: boost(doc, 0) };
        }
        if (expanded.some((e) => e.doc.id === bId)) continue;
        expanded.push({ ...s, score: s.score + 0.25 * topScore, via: `link:${l.relation}:${a}` });
      }
    }
    const results = [
      ...hits.map((h) => ({ ...h, via: "search" })),
      ...expanded,
    ]
      .sort((a, b) => b.score - a.score || b.doc.seq - a.doc.seq)
      .slice(0, limit)
      .map((s) => ({
        kind: s.doc.kind,
        id: s.doc.id,
        seq: s.doc.seq,
        score: Math.round(s.score * 1000) / 1000,
        via: s.via,
        ts: s.doc.ts,
        eventDate: s.doc.eventDate,
        title: s.doc.kind === "episode" ? s.doc.title : undefined,
        text: s.doc.text,
        tags: s.doc.tags,
        entities: s.doc.entities,
        source: s.doc.kind === "episode" ? s.doc.source : undefined,
        sourceEpisodes: s.doc.kind === "fact" ? s.doc.sourceEpisodes : undefined,
        superseded: s.doc.kind === "fact" ? s.doc.invalidAtTs !== null : undefined,
      }));
    return { repo: `${owner}/${repo}`, query, results, engine: "index" };
  } finally {
    db.close();
  }
}
