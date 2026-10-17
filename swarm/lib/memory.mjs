/**
 * KILN Memory — per-repo infinite memory.
 *
 * Every KILN-native repo carries its own memory INSIDE the repo, on the
 * orphan ref `refs/kiln/memory` of its bare repository. The ref is a
 * linear chain of commits; each commit adds exactly one event file
 * (`events/<seq>-<id>.json`). Events are append-only and hash-chained
 * (each event names the sha256 of the canonical previous event), so the
 * record is tamper-evident even outside git's own object integrity.
 *
 * "Infinite" means exactly this: storage is unbounded and nothing is
 * ever deleted — facts are superseded, not erased — while recall pages
 * a bounded, token-budgeted working set back into context. Storage
 * grows forever; context stays finite.
 *
 * Event types:
 *   episode   raw experience: a note, a transcript chunk, a build log, a
 *             decision record. The non-lossy ground truth (Zep's episode
 *             subgraph; Letta's recall tier). Content over INLINE_MAX is
 *             stored as a git blob and referenced by oid + sha256.
 *   fact      a derived semantic claim {subject, predicate, object}
 *             extracted from episodes. MUST cite >= 1 source episode.
 *             Carries a validity window: validFrom (eventDate or record
 *             time) until superseded. `supersedes: [factEventIds]`
 *             invalidates older facts atomically in the same event.
 *   supersede standalone invalidation of a fact (retraction with no
 *             replacement).
 *   link      a typed edge between two memory events (A-MEM-style
 *             Zettelkasten linking; powers graph-expanded recall).
 *   core      a Letta-style core block: a labeled, always-in-context
 *             text slot (e.g. "project", "conventions"). Latest wins;
 *             history is preserved in the event chain.
 *
 * Derived state is a pure replay of the event chain — the same
 * crash-safe pattern as lib/queue.mjs, plus the hash chain discipline
 * of lib/receipts.mjs and the canonical form of lib/canon.mjs.
 *
 * Concurrency: appends use update-ref compare-and-swap on the memory
 * tip with bounded retry, so two writers cannot fork the chain — the
 * loser replays on the winner's tip. All git work is real plumbing
 * (hash-object / mktree via a temp index / commit-tree / update-ref);
 * nothing here invents a hash or a commit.
 *
 * Honest boundaries (v1):
 *   - Replay is O(events) in memory. The ref is always the source of
 *     truth; recall is served by the rebuildable FTS5 sidecar in
 *     lib/memory-index.mjs (phase 1) whenever it is available, with
 *     this replay as the fallback and the auditor.
 *   - Retrieval is lexical BM25 + recency + salience + 1-hop link
 *     expansion. No embeddings yet — no fake semantic search.
 *   - Events are hash-chained but not yet node-signed; signing with
 *     the acting node's ed25519 key (receipts-style) is a later phase.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { canon, sha256hex, sha256hexOfCanon } from "./canon.mjs";
import { repoPath, repoExists } from "./git.mjs";
import { recallIndexed, memoryIndexInfo } from "./memory-index.mjs";

export const MEMORY_REF = "refs/kiln/memory";
const INLINE_MAX = 4096;          // content chars kept inline in the event JSON
const MAX_CONTENT = 1024 * 1024;  // hard cap per episode payload
const MAX_APPEND_RETRIES = 5;
const ZERO = "0".repeat(40);      // sha1 object-format "must not exist" marker

const EVENT_TYPES = new Set(["episode", "fact", "supersede", "link", "core"]);
const LABEL_RE = /^[a-z0-9]([a-z0-9-_]{0,62}[a-z0-9])?$/;

// ---------------------------------------------------------------- git plumbing

function git(gd, args, opts = {}) {
  const o = {
    input: opts.input,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, ...(opts.env || {}) },
  };
  if (!opts.binary) o.encoding = "utf8"; // binary callers get a raw Buffer
  return execFileSync("git", ["--git-dir", gd, ...args], o);
}

function memoryTip(gd) {
  try {
    return git(gd, ["rev-parse", "-q", "--verify", MEMORY_REF]).trim() || null;
  } catch {
    return null;
  }
}

function requireRepo(dir, owner, repo) {
  const gd = repoPath(dir, owner, repo); // throws on invalid names
  if (!repoExists(dir, owner, repo)) throw new Error(`memory: no such repo ${owner}/${repo}`);
  return gd;
}

export function newMemoryId() {
  return "mem_" + randomBytes(6).toString("hex");
}

function actorEnv(actor) {
  const name = String(actor || "kiln-memory").slice(0, 64);
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: "memory@kiln.local",
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: "memory@kiln.local",
  };
}

/** Read every event file at the memory tip. Returns [{path, oid, raw}] sorted by path. */
function readEventBlobs(gd, tip) {
  if (!tip) return [];
  const listing = git(gd, ["ls-tree", "-r", "-z", tip]).toString("utf8");
  const entries = [];
  for (const rec of listing.split("\0")) {
    if (!rec) continue;
    const tab = rec.indexOf("\t");
    const meta = rec.slice(0, tab).split(" ");
    const path = rec.slice(tab + 1);
    if (path.startsWith("events/")) entries.push({ oid: meta[2], path });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  if (!entries.length) return [];
  // cat-file --batch: "<oid> blob <size>\n<bytes>\n" per object.
  const input = entries.map((e) => e.oid).join("\n") + "\n";
  const out = git(gd, ["cat-file", "--batch"], { input, binary: true });
  const blobs = [];
  let off = 0;
  for (const e of entries) {
    const nl = out.indexOf(0x0a, off);
    const header = out.subarray(off, nl).toString("utf8").split(" ");
    const size = parseInt(header[2], 10);
    const body = out.subarray(nl + 1, nl + 1 + size);
    blobs.push({ ...e, raw: body.toString("utf8") });
    off = nl + 1 + size + 1; // body + trailing LF
  }
  return blobs;
}

function resolveContent(gd, ev) {
  if (ev.content !== undefined) return ev.content;
  if (ev.contentBlob) {
    const raw = git(gd, ["cat-file", "blob", ev.contentBlob.oid], { binary: true }).toString("utf8");
    if (sha256hex(raw) !== ev.contentBlob.sha256) {
      throw new Error(`memory: blob integrity failure for event ${ev.id}`);
    }
    return raw;
  }
  return "";
}

/** Full replay: parse + hash-chain-check every event, resolve blob content. */
export function readEvents(dir, owner, repo) {
  const gd = requireRepo(dir, owner, repo);
  const tip = memoryTip(gd);
  const blobs = readEventBlobs(gd, tip);
  const events = [];
  let prevHash = "GENESIS";
  for (const b of blobs) {
    let ev;
    try { ev = JSON.parse(b.raw); } catch { throw new Error(`memory: event ${b.path} is not valid JSON`); }
    const { hash, ... unsigned } = ev;
    if (ev.prev !== prevHash) throw new Error(`memory: hash chain broken at ${b.path}`);
    if (sha256hexOfCanon(unsigned) !== hash) throw new Error(`memory: event hash mismatch at ${b.path}`);
    prevHash = hash;
    if (ev.type === "episode") ev.content = resolveContent(gd, ev);
    events.push(ev);
  }
  return { tip, events };
}

// ---------------------------------------------------------------- append (CAS)

function appendEvent(dir, owner, repo, build) {
  const gd = requireRepo(dir, owner, repo);
  let lastError = null;
  for (let attempt = 0; attempt < MAX_APPEND_RETRIES; attempt++) {
    const { tip, events } = readEvents(dir, owner, repo);
    const seq = events.length;
    const prevHash = seq ? events[seq - 1].hash : "GENESIS";
    const ev = build(seq, prevHash);
    if (!EVENT_TYPES.has(ev.type)) throw new Error(`memory: bad event type ${ev.type}`);
    ev.hash = sha256hexOfCanon(ev);

    const tmp = mkdtempSync(join(tmpdir(), "kiln-mem-idx-"));
    const env = { ...actorEnv(ev.actor), GIT_INDEX_FILE: join(tmp, "index") };
    try {
      if (tip) git(gd, ["read-tree", tip], { env });
      else git(gd, ["read-tree", "--empty"], { env });

      // Large episode content goes to a content-addressed git blob; the
      // event references it by oid + sha256 (checked again on read).
      if (ev.type === "episode" && typeof ev.content === "string" && ev.content.length > INLINE_MAX) {
        const oid = git(gd, ["hash-object", "-w", "--stdin"], { input: ev.content }).trim();
        ev.contentBlob = { oid, size: ev.content.length, sha256: sha256hex(ev.content) };
        delete ev.content;
        // The hash must cover the final stored shape — recompute.
        const { hash, ...unsigned } = ev;
        ev.hash = sha256hexOfCanon(unsigned);
      }

      const evOid = git(gd, ["hash-object", "-w", "--stdin"], { input: canon(ev) }).trim();
      const name = `events/${String(seq).padStart(8, "0")}-${ev.id}.json`;
      git(gd, ["update-index", "--add", "--cacheinfo", `100644,${evOid},${name}`], { env });
      const tree = git(gd, ["write-tree"], { env }).trim();
      const commitArgs = ["commit-tree", tree, "-m", `memory: ${ev.type} ${ev.id}`];
      if (tip) commitArgs.push("-p", tip);
      const commit = git(gd, commitArgs, { env }).trim();
      // Compare-and-swap: refuse to move the ref if someone else won.
      git(gd, ["update-ref", MEMORY_REF, commit, tip || ZERO]);
      return { event: ev, commit };
    } catch (e) {
      lastError = e;
      // update-ref CAS failure = a concurrent writer moved the tip.
      // Retry on the new tip; anything else is a real error.
      const msg = String(e.stderr || e.message || "");
      if (/cannot lock ref|but expected|reference already exists|exists; cannot lock/i.test(msg) && attempt < MAX_APPEND_RETRIES - 1) {
        continue;
      }
      if (/cannot lock ref|but expected/i.test(msg)) continue;
      throw e;
    } finally {
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
  throw new Error(`memory: append failed after ${MAX_APPEND_RETRIES} retries (${lastError ? lastError.message : " contention"})`);
}

// ---------------------------------------------------------------- validation

function reqString(v, what, max) {
  if (typeof v !== "string" || !v.trim()) throw new Error(`memory: ${what} is required`);
  if (v.length > max) throw new Error(`memory: ${what} exceeds ${max} chars`);
  return v;
}
function optStrings(v, what) {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`memory: ${what} must be string[]`);
  return [...new Set(v.map((s) => s.trim()).filter(Boolean))].slice(0, 64);
}
function isoToSec(s, what) {
  if (s === undefined || s === null) return null;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) throw new Error(`memory: ${what} is not a valid date`);
  return Math.floor(ms / 1000);
}

// ---------------------------------------------------------------- writes

/**
 * Remember an episode — raw experience, stored losslessly, forever.
 * opts: {title?, kind?, content, tags?, entities?, eventDate?, source?, actor?, salience?}
 * source: {type: "commit"|"receipt"|"job"|"url"|"note"|…, ref: string}
 */
export function remember(dir, owner, repo, opts = {}) {
  const content = reqString(opts.content, "content", MAX_CONTENT);
  return appendEvent(dir, owner, repo, (seq, prev) => ({
    v: 1, id: newMemoryId(), seq, prev, type: "episode",
    ts: Math.floor(Date.now() / 1000),
    actor: String(opts.actor || "api"),
    kind: opts.kind ? String(opts.kind).slice(0, 64) : "note",
    title: opts.title ? String(opts.title).slice(0, 500) : "",
    content,
    tags: optStrings(opts.tags, "tags"),
    entities: optStrings(opts.entities, "entities"),
    eventDate: opts.eventDate ? new Date(isoToSec(opts.eventDate, "eventDate") * 1000).toISOString() : null,
    source: opts.source && typeof opts.source === "object"
      ? { type: String(opts.source.type || "note").slice(0, 32), ref: String(opts.source.ref || "").slice(0, 256) }
      : null,
    salience: Number.isFinite(opts.salience) ? Math.min(5, Math.max(0, opts.salience)) : 1,
  }));
}

/**
 * Assert a fact derived from episodes. Provenance is mandatory: at
 * least one source episode id, and every id must exist. `supersedes`
 * invalidates older facts in the same atomic event.
 */
export function assertFact(dir, owner, repo, opts = {}) {
  const subject = reqString(opts.subject, "subject", 2000);
  const predicate = reqString(opts.predicate, "predicate", 2000);
  const object = reqString(opts.object, "object", 2000);
  const sources = optStrings(opts.sourceEpisodes, "sourceEpisodes");
  if (!sources.length) throw new Error("memory: fact requires >= 1 source episode (provenance is mandatory)");
  const supersedes = optStrings(opts.supersedes, "supersedes");
  const { events } = readEvents(dir, owner, repo);
  const byId = new Map(events.map((e) => [e.id, e]));
  for (const id of sources) {
    const src = byId.get(id);
    if (!src) throw new Error(`memory: source episode ${id} not found in ${owner}/${repo}`);
    if (src.type !== "episode") throw new Error(`memory: source ${id} is a ${src.type}, not an episode`);
  }
  for (const id of supersedes) {
    const t = byId.get(id);
    if (!t || t.type !== "fact") throw new Error(`memory: supersede target ${id} is not a fact in ${owner}/${repo}`);
  }
  return appendEvent(dir, owner, repo, (seq, prev) => ({
    v: 1, id: newMemoryId(), seq, prev, type: "fact",
    ts: Math.floor(Date.now() / 1000),
    actor: String(opts.actor || "api"),
    subject, predicate, object,
    confidence: Number.isFinite(opts.confidence) ? Math.min(1, Math.max(0, opts.confidence)) : null,
    validFrom: opts.validFrom ? new Date(isoToSec(opts.validFrom, "validFrom") * 1000).toISOString() : null,
    sourceEpisodes: sources,
    supersedes,
    entities: optStrings(opts.entities ?? [subject, object], "entities"),
    salience: Number.isFinite(opts.salience) ? Math.min(5, Math.max(0, opts.salience)) : 1,
  }));
}

/** Retract a fact without a replacement. The fact stays in history. */
export function supersedeFact(dir, owner, repo, opts = {}) {
  const target = reqString(opts.fact, "fact", 128);
  const { events } = readEvents(dir, owner, repo);
  const t = events.find((e) => e.id === target);
  if (!t || t.type !== "fact") throw new Error(`memory: ${target} is not a fact in ${owner}/${repo}`);
  return appendEvent(dir, owner, repo, (seq, prev) => ({
    v: 1, id: newMemoryId(), seq, prev, type: "supersede",
    ts: Math.floor(Date.now() / 1000),
    actor: String(opts.actor || "api"),
    target,
    reason: opts.reason ? String(opts.reason).slice(0, 1000) : "",
  }));
}

/** Link two memory events with a typed relation. */
export function linkMemories(dir, owner, repo, opts = {}) {
  const from = reqString(opts.from, "from", 128);
  const to = reqString(opts.to, "to", 128);
  const relation = reqString(opts.relation, "relation", 64);
  const { events } = readEvents(dir, owner, repo);
  const ids = new Set(events.map((e) => [e.id]).flat());
  if (!ids.has(from)) throw new Error(`memory: link source ${from} not found`);
  if (!ids.has(to)) throw new Error(`memory: link target ${to} not found`);
  return appendEvent(dir, owner, repo, (seq, prev) => ({
    v: 1, id: newMemoryId(), seq, prev, type: "link",
    ts: Math.floor(Date.now() / 1000),
    actor: String(opts.actor || "api"),
    from, to, relation,
  }));
}

/** Set a core block (Letta-style always-in-context slot). Latest wins. */
export function setCore(dir, owner, repo, opts = {}) {
  const label = reqString(opts.label, "label", 64);
  if (!LABEL_RE.test(label)) throw new Error(`memory: bad core label "${label}"`);
  const value = reqString(opts.value, "value", 20000);
  return appendEvent(dir, owner, repo, (seq, prev) => ({
    v: 1, id: newMemoryId(), seq, prev, type: "core",
    ts: Math.floor(Date.now() / 1000),
    actor: String(opts.actor || "api"),
    label, value,
    description: opts.description ? String(opts.description).slice(0, 500) : "",
  }));
}

// ---------------------------------------------------------------- derived state

export function factValidFrom(ev) {
  return ev.validFrom ? Math.floor(Date.parse(ev.validFrom) / 1000) : ev.ts;
}
export function episodeWhen(ev) {
  return ev.eventDate ? Math.floor(Date.parse(ev.eventDate) / 1000) : ev.ts;
}

/** Replay events into the derived memory state. */
export function replayMemory(events) {
  const episodes = [];
  const facts = new Map();
  const links = [];
  const core = new Map();
  for (const ev of events) {
    if (ev.type === "episode") {
      episodes.push(ev);
    } else if (ev.type === "fact") {
      facts.set(ev.id, { ...ev, validFromTs: factValidFrom(ev), invalidAtTs: null, invalidatedBy: null });
      for (const oldId of ev.supersedes || []) {
        const old = facts.get(oldId);
        if (old && old.invalidAtTs === null) {
          old.invalidAtTs = factValidFrom(ev);
          old.invalidatedBy = ev.id;
        }
      }
    } else if (ev.type === "supersede") {
      const t = facts.get(ev.target);
      if (t && t.invalidAtTs === null) {
        t.invalidAtTs = ev.ts;
        t.invalidatedBy = ev.id;
      }
    } else if (ev.type === "link") {
      links.push(ev);
    } else if (ev.type === "core") {
      core.set(ev.label, { label: ev.label, value: ev.value, description: ev.description || "", updatedSeq: ev.seq, updatedTs: ev.ts, eventId: ev.id });
    }
  }
  return { episodes, facts: [...facts.values()], links, core: [...core.values()] };
}

export function loadMemory(dir, owner, repo) {
  const { tip, events } = readEvents(dir, owner, repo);
  return { tip, events, ...replayMemory(events) };
}

/** Facts valid at `asOfSec` (default: now). Superseded facts included only on request. */
export function factsAt(state, asOfSec = Math.floor(Date.now() / 1000), includeSuperseded = false) {
  return state.facts.filter((f) => {
    if (f.validFromTs > asOfSec) return false;
    if (f.invalidAtTs !== null && f.invalidAtTs <= asOfSec) return includeSuperseded;
    return true;
  });
}

export function memoryStats(dir, owner, repo) {
  const gd = requireRepo(dir, owner, repo);
  const state = loadMemory(dir, owner, repo);
  const byType = {};
  for (const e of state.events) byType[e.type] = (byType[e.type] || 0) + 1;
  let bytes = 0;
  if (state.tip) {
    const listing = git(gd, ["ls-tree", "-r", state.tip]).toString("utf8");
    for (const line of listing.split("\n")) {
      if (!line) continue;
      const oid = line.split(" ")[2].split("\t")[0];
      try { bytes += parseInt(git(gd, ["cat-file", "-s", oid]).trim(), 10) || 0; } catch { /* skip */ }
    }
  }
  const current = factsAt(state);
  return {
    repo: `${owner}/${repo}`,
    tip: state.tip,
    events: state.events.length,
    byType,
    episodes: state.episodes.length,
    facts: { total: state.facts.length, current: current.length, superseded: state.facts.length - current.length },
    links: state.links.length,
    coreBlocks: state.core.map((c) => c.label),
    bytes,
    oldestTs: state.events.length ? state.events[0].ts : null,
    newestTs: state.events.length ? state.events[state.events.length - 1].ts : null,
    index: memoryIndexInfo(dir, owner, repo),
  };
}

/** Verify chain integrity: linear commits, one event per commit, hash chain, blob hashes. */
export function verifyMemory(dir, owner, repo) {
  const gd = requireRepo(dir, owner, repo);
  const tip = memoryTip(gd);
  if (!tip) return { ok: true, events: 0, commits: 0, tip: null };
  const lines = git(gd, ["rev-list", "--parents", "--reverse", tip]).trim().split("\n").filter(Boolean);
  let prevCommit = null;
  for (const line of lines) {
    const parts = line.split(" ");
    const [commit, ...parents] = parts;
    if (parents.length > 1) return { ok: false, error: `commit ${commit} has ${parents.length} parents — memory chain must be linear` };
    if (prevCommit === null && parents.length !== 0) return { ok: false, error: "first memory commit has a parent" };
    if (prevCommit !== null && parents[0] !== prevCommit) return { ok: false, error: `commit ${commit} does not descend from the previous memory commit` };
    prevCommit = commit;
  }
  let state;
  try {
    state = loadMemory(dir, owner, repo); // re-checks hash chain + blob sha256
  } catch (e) {
    return { ok: false, error: e.message };
  }
  if (state.events.length !== lines.length) {
    return { ok: false, error: `commit count ${lines.length} != event count ${state.events.length} — a memory commit added no event` };
  }
  for (let i = 0; i < state.events.length; i++) {
    if (state.events[i].seq !== i) return { ok: false, error: `event seq gap at ${i}` };
  }
  return { ok: true, events: state.events.length, commits: lines.length, tip };
}

// ---------------------------------------------------------------- retrieval (BM25 + recency + salience + links)

export function tokenize(text) {
  return String(text || "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
}

export function docText(kind, item) {
  if (kind === "episode") return [item.title, item.kind, item.content, ...(item.tags || []), ...(item.entities || [])].join("\n");
  return [item.subject, item.predicate, item.object, ...(item.entities || [])].join("\n");
}

function estimateTokens(text) {
  return Math.ceil(String(text).length / 4);
}

/**
 * Recall: BM25 over episodes + currently-valid facts, boosted by
 * salience and recency, expanded one hop across explicit links.
 * Returns ranked [{kind, id, seq, score, via, item}] — `via` is
 * "search" or "link:<relation>:<otherId>" so ranking is explainable.
 *
 * Served by the FTS5 sidecar (lib/memory-index.mjs) whenever it is
 * available; the full-replay scan below is the fallback and auditor.
 * The result names its engine: "index" or "scan".
 */
export function recall(dir, owner, repo, query, opts = {}) {
  const asOfSec = opts.asOf ? isoToSec(opts.asOf, "asOf") : Math.floor(Date.now() / 1000);
  try {
    const r = recallIndexed(dir, owner, repo, query, opts, {
      asOfSec,
      sinceSec: opts.since ? isoToSec(opts.since, "since") : null,
      untilSec: opts.until ? isoToSec(opts.until, "until") : null,
    });
    if (r) return r;
  } catch { /* sidecar unavailable or stale — the scan decides (and throws what it must) */ }
  return recallScan(dir, owner, repo, query, opts, asOfSec);
}

function recallScan(dir, owner, repo, query, opts = {}, asOf) {
  const state = loadMemory(dir, owner, repo);
  const limit = Math.min(100, Math.max(1, opts.limit ?? 10));
  const kinds = new Set(opts.kinds && opts.kinds.length ? opts.kinds : ["episode", "fact"]);
  const docs = [];
  if (kinds.has("episode")) {
    for (const ep of state.episodes) {
      if (opts.since && episodeWhen(ep) < isoToSec(opts.since, "since")) continue;
      if (opts.until && episodeWhen(ep) > isoToSec(opts.until, "until")) continue;
      if (opts.tags && opts.tags.length && !(ep.tags || []).some((t) => opts.tags.includes(t))) continue;
      docs.push({ kind: "episode", item: ep });
    }
  }
  if (kinds.has("fact")) {
    for (const f of factsAt(state, asOf, !!opts.includeSuperseded)) {
      docs.push({ kind: "fact", item: f });
    }
  }
  if (!docs.length) return { repo: `${owner}/${repo}`, query, results: [], engine: "scan" };

  const qTokens = [...new Set(tokenize(query))];
  const docTokens = docs.map((d) => tokenize(docText(d.kind, d.item)));
  const avgLen = docTokens.reduce((a, t) => a + t.length, 0) / docs.length || 1;
  const df = new Map();
  for (const toks of docTokens) for (const t of new Set(toks)) df.set(t, (df.get(t) || 0) + 1);
  const N = docs.length;
  const k1 = 1.2, b = 0.75;
  const now = Math.floor(Date.now() / 1000);

  const scored = docs.map((d, i) => {
    const toks = docTokens[i];
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    let bm25 = 0;
    for (const t of qTokens) {
      const f = tf.get(t) || 0;
      if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));
      bm25 += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * (toks.length / avgLen)));
    }
    const when = d.kind === "episode" ? episodeWhen(d.item) : d.item.validFromTs;
    const ageDays = Math.max(0, (now - when) / 86400);
    const recency = 1 / (1 + ageDays / 30);
    const salience = Number.isFinite(d.item.salience) ? d.item.salience : 1;
    const score = bm25 * (0.7 + 0.3 * Math.min(1, salience / 5)) + 0.15 * recency;
    return { ...d, score, bm25 };
  });

  const hits = scored.filter((d) => d.bm25 > 0)
    .sort((a, b2) => b2.score - a.score || b2.item.seq - a.item.seq)
    .slice(0, limit);

  // One-hop graph expansion across explicit links (A-MEM / Graphiti move):
  // a memory linked to a strong hit is probably relevant even when its
  // own text doesn't match the query terms.
  const hitIds = new Set(hits.map((h) => h.item.id));
  const byId = new Map(scored.map((d) => [d.item.id, d]));
  const expanded = [];
  if (hits.length) {
    const topScore = hits[0].score;
    for (const l of state.links) {
      for (const [a, bId] of [[l.from, l.to], [l.to, l.from]]) {
        if (hitIds.has(a) && !hitIds.has(bId) && byId.has(bId)) {
          const d = byId.get(bId);
          expanded.push({ ...d, score: d.score + 0.25 * topScore, via: `link:${l.relation}:${a}` });
        }
      }
    }
  }
  const results = [...hits.map((h) => ({ ...h, via: "search" })), ...expanded]
    .sort((a, b2) => b2.score - a.score || b2.item.seq - a.item.seq)
    .slice(0, limit)
    .map((d) => ({
      kind: d.kind,
      id: d.item.id,
      seq: d.item.seq,
      score: Math.round(d.score * 1000) / 1000,
      via: d.via,
      ts: d.item.ts,
      eventDate: d.kind === "episode" ? d.item.eventDate : d.item.validFrom,
      title: d.kind === "episode" ? d.item.title : undefined,
      text: d.kind === "episode" ? d.item.content : `${d.item.subject} ${d.item.predicate} ${d.item.object}`,
      tags: d.item.tags || [],
      entities: d.item.entities || [],
      source: d.kind === "episode" ? d.item.source : undefined,
      sourceEpisodes: d.kind === "fact" ? d.item.sourceEpisodes : undefined,
      superseded: d.kind === "fact" ? d.item.invalidAtTs !== null : undefined,
    }));
  return { repo: `${owner}/${repo}`, query, results, engine: "scan" };
}

/**
 * Build a budgeted context pack: core blocks first (always), then
 * currently-valid facts (when no query, the most salient/recent; with a
 * query, the recall ranking), then episodes. Nothing is silently
 * dropped — the pack reports what was included and the budget state.
 */
export function buildContext(dir, owner, repo, opts = {}) {
  const budgetTokens = Math.min(200000, Math.max(64, opts.budgetTokens ?? 4000));
  const state = loadMemory(dir, owner, repo);
  const asOf = opts.asOf ? isoToSec(opts.asOf, "asOf") : Math.floor(Date.now() / 1000);
  let used = 0;
  let overBudget = false;
  const take = (text) => {
    const cost = estimateTokens(text);
    if (used + cost > budgetTokens) { overBudget = true; return false; }
    used += cost;
    return true;
  };

  const coreOut = [];
  for (const block of state.core) {
    const line = `## ${block.label}\n${block.value}`;
    if (take(line)) coreOut.push({ label: block.label, value: block.value, eventId: block.eventId });
    else break;
  }

  let ranked;
  if (opts.query) {
    const r = recall(dir, owner, repo, opts.query, { limit: 50, asOf: opts.asOf, includeSuperseded: false });
    const factIds = new Set(r.results.filter((x) => x.kind === "fact").map((x) => x.id));
    const epIds = new Set(r.results.filter((x) => x.kind === "episode").map((x) => x.id));
    ranked = {
      facts: state.facts.filter((f) => factIds.has(f.id)),
      episodes: state.episodes.filter((e) => epIds.has(e.id)),
    };
  } else {
    const facts = factsAt(state, asOf, false)
      .sort((a, b2) => (b2.salience || 1) - (a.salience || 1) || b2.seq - a.seq);
    const episodes = [...state.episodes].sort((a, b2) => episodeWhen(b2) - episodeWhen(a));
    ranked = { facts, episodes };
  }

  const factsOut = [];
  for (const f of ranked.facts) {
    const line = `- ${f.subject} ${f.predicate} ${f.object} [fact ${f.id} seq=${f.seq} sources=${(f.sourceEpisodes || []).join(",")}]`;
    if (!take(line)) break;
    factsOut.push({ id: f.id, seq: f.seq, subject: f.subject, predicate: f.predicate, object: f.object, sourceEpisodes: f.sourceEpisodes });
  }
  const epsOut = [];
  for (const ep of ranked.episodes) {
    const body = ep.content.length > 2000 ? ep.content.slice(0, 2000) + "…" : ep.content;
    const line = `### ${ep.title || ep.kind} [episode ${ep.id} seq=${ep.seq}${ep.eventDate ? ` event=${ep.eventDate}` : ""}]\n${body}`;
    if (!take(line)) break;
    epsOut.push({ id: ep.id, seq: ep.seq, title: ep.title, kind: ep.kind, eventDate: ep.eventDate });
  }

  const text = [
    `# Memory · ${owner}/${repo}`,
    ...coreOut.map((c) => `## ${c.label}\n${c.value}`),
    factsOut.length ? `## Facts\n${factsOut.map((f) => `- ${f.subject} ${f.predicate} ${f.object}`).join("\n")}` : "",
    ...epsOut.map((e) => {
      const ep = state.episodes.find((x) => x.id === e.id);
      const body = ep.content.length > 2000 ? ep.content.slice(0, 2000) + "…" : ep.content;
      return `### ${ep.title || ep.kind} [episode ${ep.id} seq=${ep.seq}]\n${body}`;
    }),
  ].filter(Boolean).join("\n\n");

  return {
    repo: `${owner}/${repo}`,
    budgetTokens,
    usedTokens: used,
    overBudget,
    core: coreOut,
    facts: factsOut,
    episodes: epsOut,
    text,
  };
}
