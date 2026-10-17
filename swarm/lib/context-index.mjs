/**
 * KILN persistent local context index.
 *
 * Design goals:
 * - local-only, zero third-party dependencies
 * - content-addressed incremental indexing
 * - tracked Git files only
 * - secret-path filtering before content enters the index
 * - BM25 lexical retrieval + path/symbol heuristics
 * - bounded context packs with per-file provenance
 * - delta packs keyed by prior file hashes
 *
 * This module performs no model calls and never executes repository content.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync, mkdirSync, readFileSync, realpathSync, renameSync,
  statSync, writeFileSync,
} from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";

const INDEX_SCHEMA = "kiln.context-index.v1";
const PACK_SCHEMA = "kiln.context-pack.v2";
const DEFAULT_CHUNK_LINES = 80;
const DEFAULT_OVERLAP = 12;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const SECRET_PATH_PATTERNS = [
  /(^|\/)\.env($|\.)/i,
  /(^|\/)(id_rsa|id_ed25519|authorized_keys|known_hosts)$/i,
  /(^|\/).*(secret|credential|private[-_.]?key|keystore).*$/i,
  /(^|\/)(secrets?|credentials?)(\/|$)/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.pypirc$/i,
  /(^|\/)\.docker\/config\.json$/i,
];

const TEXT_EXTENSIONS = new Set([
  ".c",".cc",".cpp",".css",".go",".h",".hpp",".html",".java",".js",".json",
  ".jsx",".kt",".md",".mjs",".mts",".py",".rb",".rs",".sh",".sol",".sql",
  ".svelte",".toml",".ts",".tsx",".txt",".yaml",".yml",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function atomicJson(path, value) {
  const tmp = path + ".tmp-" + process.pid;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  renameSync(tmp, path);
}

function runGit(root, args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function canonicalRepoRoot(root) {
  const base = realpathSync(root);
  const top = realpathSync(runGit(base, ["rev-parse", "--show-toplevel"]));
  if (top !== base) return top;
  return base;
}

function pathInside(base, path) {
  return path === base || path.startsWith(base + sep);
}

function trackedFiles(base) {
  return execFileSync("git", ["-C", base, "ls-files", "-z"], {
    maxBuffer: 64 * 1024 * 1024,
  }).toString("utf8").split("\0").filter(Boolean);
}

function extension(path) {
  const m = /\.[A-Za-z0-9]+$/.exec(path);
  return m ? m[0].toLowerCase() : "";
}

function secretPath(path) {
  return SECRET_PATH_PATTERNS.some((r) => r.test(path));
}

function safeTextFile(base, rel) {
  if (!rel || rel.includes("\0") || secretPath(rel)) return null;
  const absolute = resolve(base, rel);
  if (!pathInside(base, absolute)) return null;
  let canonical;
  try { canonical = realpathSync(absolute); } catch { return null; }
  if (canonical !== absolute || !pathInside(base, canonical)) return null; // no symlink traversal
  let st;
  try { st = statSync(canonical); } catch { return null; }
  if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
  const ext = extension(rel);
  if (ext && !TEXT_EXTENSIONS.has(ext)) return null;
  let body;
  try { body = readFileSync(canonical, "utf8"); } catch { return null; }
  if (body.includes("\0")) return null;
  return { absolute: canonical, bytes: st.size, body };
}

function terms(text) {
  const normalized = String(text)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_./-]+/g, " ")
    .toLowerCase();
  const out = normalized.match(/[a-z][a-z0-9]{1,63}|\d+/g) || [];
  return out
    .map((x) => /^\d+$/.test(x) ? String(Number.parseInt(x, 10)) : x)
    .filter((x) => x.length > 1 || /^\d+$/.test(x));
}

function unique(xs) { return [...new Set(xs.filter(Boolean))]; }

function codeSignals(path, body) {
  const ext = extension(path);
  const symbols = [];
  const imports = [];
  if ([".js",".jsx",".ts",".tsx",".mjs",".mts"].includes(ext)) {
    for (const m of body.matchAll(/\b(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) symbols.push(m[1]);
    for (const m of body.matchAll(/\b(?:import[^"']*from\s*|import\s*\(|require\s*\()\s*["']([^"']+)["']/g)) imports.push(m[1]);
  } else if (ext === ".py") {
    for (const m of body.matchAll(/^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) symbols.push(m[1]);
    for (const m of body.matchAll(/^\s*(?:from\s+([A-Za-z0-9_.]+)\s+import|import\s+([A-Za-z0-9_.]+))/gm)) imports.push(m[1] || m[2]);
  } else if (ext === ".go") {
    for (const m of body.matchAll(/^\s*(?:func|type)\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)/gm)) symbols.push(m[1]);
    for (const m of body.matchAll(/"([^"]+)"/g)) if (m[1].includes("/")) imports.push(m[1]);
  } else if (ext === ".rs") {
    for (const m of body.matchAll(/\b(?:fn|struct|enum|trait|type|mod)\s+([A-Za-z_][A-Za-z0-9_]*)/g)) symbols.push(m[1]);
    for (const m of body.matchAll(/\buse\s+([^;]+);/g)) imports.push(m[1].trim());
  }
  return { symbols: unique(symbols).slice(0, 1000), imports: unique(imports).slice(0, 1000) };
}

function resolveLocalDependency(index, fromPath, spec) {
  if (!spec || !spec.startsWith(".")) return null;
  const fromDir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
  const raw = resolve("/", fromDir, spec).replace(/^\//, "");
  const candidates = [
    raw, raw + ".js", raw + ".ts", raw + ".tsx", raw + ".jsx", raw + ".mjs",
    raw + ".py", raw + "/index.js", raw + "/index.ts", raw + "/index.tsx",
  ];
  const known = new Set(index.files.map((x) => x.path));
  return candidates.find((x) => known.has(x)) || null;
}

function chunkFile(path, body, fileHash, chunkLines, overlap) {
  const lines = body.split("\n");
  const step = Math.max(1, chunkLines - overlap);
  const chunks = [];
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(lines.length, start + chunkLines);
    const text = lines.slice(start, end).join("\n");
    if (!text.trim()) continue;
    const id = sha256(fileHash + ":" + start + ":" + end);
    const toks = terms(text);
    const tf = Object.create(null);
    for (const t of toks) tf[t] = (tf[t] || 0) + 1;
    chunks.push({
      id, path, startLine: start + 1, endLine: end,
      text, tokenTerms: toks.length, tf,
    });
    if (end === lines.length) break;
  }
  return chunks;
}

function indexPath(indexDir, repoRoot) {
  const id = sha256(repoRoot).slice(0, 24);
  return join(indexDir, id + ".json");
}

export function loadIndex(indexDir, repoRoot) {
  const base = canonicalRepoRoot(repoRoot);
  const path = indexPath(indexDir, base);
  if (!existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, "utf8"));
  if (data.schema !== INDEX_SCHEMA || data.repoRoot !== base) return null;
  return data;
}

/**
 * Build or incrementally refresh a persistent index.
 * Unchanged file hashes reuse prior chunks exactly.
 */
export function buildContextIndex(repoRoot, indexDir, opts = {}) {
  const base = canonicalRepoRoot(repoRoot);
  mkdirSync(indexDir, { recursive: true, mode: 0o700 });
  const prior = loadIndex(indexDir, base);
  const chunkLines = Math.max(20, Math.min(240, Number(opts.chunkLines || DEFAULT_CHUNK_LINES)));
  const overlap = Math.max(0, Math.min(chunkLines - 1, Number(opts.overlap || DEFAULT_OVERLAP)));
  const previousFiles = new Map((prior?.files || []).map((f) => [f.path, f]));
  const previousChunks = new Map();
  for (const c of prior?.chunks || []) {
    const list = previousChunks.get(c.path) || [];
    list.push(c); previousChunks.set(c.path, list);
  }

  const files = [];
  const chunks = [];
  const skipped = [];
  let reusedFiles = 0;
  let rebuiltFiles = 0;

  for (const rel of trackedFiles(base)) {
    if (secretPath(rel)) { skipped.push({ path: rel, reason: "secret-path-policy" }); continue; }
    const f = safeTextFile(base, rel);
    if (!f) { skipped.push({ path: rel, reason: "unsupported-or-unsafe" }); continue; }
    const fileHash = sha256(f.body);
    const previous = previousFiles.get(rel);
    const signals = codeSignals(rel, f.body);
    files.push({ path: rel, sha256: fileHash, bytes: Buffer.byteLength(f.body, "utf8"), symbols: signals.symbols, imports: signals.imports });
    if (previous?.sha256 === fileHash && prior?.chunkLines === chunkLines && prior?.overlap === overlap) {
      chunks.push(...(previousChunks.get(rel) || []));
      reusedFiles++;
    } else {
      chunks.push(...chunkFile(rel, f.body, fileHash, chunkLines, overlap));
      rebuiltFiles++;
    }
  }

  const documentFrequency = Object.create(null);
  let totalTerms = 0;
  for (const c of chunks) {
    totalTerms += c.tokenTerms;
    for (const t of Object.keys(c.tf)) documentFrequency[t] = (documentFrequency[t] || 0) + 1;
  }
  const revision = runGit(base, ["rev-parse", "HEAD"]);
  const status = runGit(base, ["status", "--porcelain=v1", "-z"]);
  const manifestMaterial = files.map((f) => f.path + "\0" + f.sha256).join("\n");
  const worktreeDigest = sha256(manifestMaterial + "\nSTATUS\n" + status);
  const now = new Date().toISOString();
  const index = {
    schema: INDEX_SCHEMA,
    version: 1,
    repoRoot: base,
    repoName: basename(base),
    revision,
    dirty: Boolean(status),
    worktreeDigest,
    generatedAt: now,
    chunkLines,
    overlap,
    files,
    chunks,
    skipped,
    stats: {
      tracked: trackedFiles(base).length,
      indexedFiles: files.length,
      chunks: chunks.length,
      totalTerms,
      averageChunkTerms: chunks.length ? totalTerms / chunks.length : 0,
      reusedFiles,
      rebuiltFiles,
      skippedFiles: skipped.length,
    },
    documentFrequency,
  };
  index.digest = sha256(JSON.stringify({
    revision: index.revision,
    worktreeDigest: index.worktreeDigest,
    files: index.files,
    chunkIds: index.chunks.map((c) => c.id),
  }));
  atomicJson(indexPath(indexDir, base), index);
  return index;
}

function bm25(index, queryTerms, chunk, { k1 = 1.2, b = 0.75 } = {}) {
  const N = Math.max(1, index.chunks.length);
  const avg = Math.max(1, index.stats.averageChunkTerms || 1);
  let score = 0;
  for (const t of queryTerms) {
    const f = chunk.tf[t] || 0;
    if (!f) continue;
    const df = index.documentFrequency[t] || 0;
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    const denom = f + k1 * (1 - b + b * chunk.tokenTerms / avg);
    score += idf * (f * (k1 + 1)) / denom;
  }
  return score;
}

function pathBoost(path, queryTerms) {
  const p = path.toLowerCase();
  return queryTerms.reduce((n, t) => n + (p.includes(t) ? 0.7 : 0), 0);
}

function jaccardTerms(a, b) {
  const A = new Set(terms(a)), B = new Set(terms(b));
  if (!A.size || !B.size) return 0;
  let intersection = 0;
  for (const t of A) if (B.has(t)) intersection++;
  return intersection / (A.size + B.size - intersection);
}

function numberedExcerpt(chunk) {
  return chunk.text.split("\n")
    .map((line, i) => String(chunk.startLine + i) + ": " + line)
    .join("\n");
}

/**
 * Query a persisted index and return a bounded, provenance-rich pack.
 * MMR removes near-duplicate chunks while preserving relevance.
 */
export function queryContextIndex(index, query, opts = {}) {
  if (!index || index.schema !== INDEX_SCHEMA) throw new Error("context index missing or incompatible");
  const qTerms = [...new Set(terms(query))];
  if (!qTerms.length) throw new Error("query must contain at least one searchable term");
  const maxBytes = Math.max(512, Math.min(512_000, Number(opts.maxBytes || 24_000)));
  const maxChunks = Math.max(1, Math.min(100, Number(opts.maxChunks || 12)));
  const lambda = Math.max(0, Math.min(1, Number(opts.mmrLambda ?? 0.78)));
  const knownHashes = opts.knownHashes && typeof opts.knownHashes === "object" ? opts.knownHashes : {};

  const fileMeta = new Map(index.files.map((x) => [x.path, x]));
  const ranked = index.chunks.map((chunk) => {
    const meta = fileMeta.get(chunk.path) || {};
    let symbolBoost = 0;
    let bestSymbolCoverage = 0;
    for (const symbol of meta.symbols || []) {
      const symbolTerms = new Set(terms(symbol));
      const matched = qTerms.reduce((n, t) => n + (symbolTerms.has(t) ? 1 : 0), 0);
      if (!matched) continue;
      const coverage = matched / Math.max(1, symbolTerms.size);
      bestSymbolCoverage = Math.max(bestSymbolCoverage, coverage);
      const multiTermBonus = matched >= 2 ? 2.0 + 0.5 * matched : 0;
      symbolBoost = Math.max(symbolBoost, matched * 1.4 + multiTermBonus);
    }
    const symbolCoverageBoost = bestSymbolCoverage >= 1 ? 1.25 : bestSymbolCoverage * 0.75;
    return {
      chunk,
      relevance: bm25(index, qTerms, chunk, opts) + pathBoost(chunk.path, qTerms) + symbolBoost + symbolCoverageBoost,
    };
  }).filter((x) => x.relevance > 0);

  const selected = [];
  while (ranked.length && selected.length < maxChunks) {
    let bestIndex = -1, bestScore = -Infinity;
    for (let i = 0; i < ranked.length; i++) {
      const candidate = ranked[i];
      let redundancy = 0;
      for (const prior of selected) redundancy = Math.max(redundancy, jaccardTerms(candidate.chunk.text, prior.chunk.text));
      const mmr = lambda * candidate.relevance - (1 - lambda) * redundancy;
      if (mmr > bestScore) { bestScore = mmr; bestIndex = i; }
    }
    const [picked] = ranked.splice(bestIndex, 1);
    selected.push({ ...picked, mmr: bestScore });
  }

  if (opts.expandDependencies !== false && selected.length) {
    const existing = new Set(selected.map((x) => x.chunk.path));
    const maxDependencyChunks = Math.max(0, Math.min(10, Number(opts.maxDependencyChunks ?? 3)));
    let added = 0;
    for (const parent of [...selected]) {
      if (added >= maxDependencyChunks) break;
      const meta = fileMeta.get(parent.chunk.path);
      for (const spec of meta?.imports || []) {
        if (added >= maxDependencyChunks) break;
        const dep = resolveLocalDependency(index, parent.chunk.path, spec);
        if (!dep || existing.has(dep)) continue;
        const chunk = index.chunks.find((c) => c.path === dep);
        if (!chunk) continue;
        selected.push({ chunk, relevance: parent.relevance * 0.35, mmr: parent.mmr * 0.35, dependencyOf: parent.chunk.path });
        existing.add(dep);
        added++;
      }
    }
  }

  const fileHashes = Object.fromEntries(index.files.map((f) => [f.path, f.sha256]));
  const items = [];
  const unchanged = [];
  let remaining = maxBytes;
  for (const x of selected) {
    const fileHash = fileHashes[x.chunk.path];
    if (knownHashes[x.chunk.path] === fileHash) {
      unchanged.push({ path: x.chunk.path, sha256: fileHash, chunkId: x.chunk.id });
      continue;
    }
    const full = numberedExcerpt(x.chunk);
    if (remaining <= 0) break;
    const bytes = Buffer.from(full, "utf8");
    const excerpt = bytes.length <= remaining ? full : bytes.subarray(0, remaining).toString("utf8");
    if (!excerpt) break;
    const actualBytes = Buffer.byteLength(excerpt, "utf8");
    items.push({
      path: x.chunk.path,
      startLine: x.chunk.startLine,
      endLine: x.chunk.endLine,
      chunkId: x.chunk.id,
      sha256: fileHash,
      score: Number(x.relevance.toFixed(6)),
      mmr: Number(x.mmr.toFixed(6)),
      dependencyOf: x.dependencyOf || null,
      bytes: actualBytes,
      tokenEstimate: Math.ceil(actualBytes / 4),
      excerpt,
    });
    remaining -= actualBytes;
  }

  const omissions = [];
  if (selected.length > items.length + unchanged.length) omissions.push("byte-budget");
  if (index.skipped.length) omissions.push("policy-filtered-files");
  const pack = {
    schema: PACK_SCHEMA,
    query: String(query),
    repo: index.repoName,
    revision: index.revision,
    dirty: index.dirty,
    worktreeDigest: index.worktreeDigest,
    indexDigest: index.digest,
    generatedAt: new Date().toISOString(),
    budget: { maxBytes, maxChunks },
    items,
    unchanged,
    omissions,
    stats: {
      candidateChunks: ranked.length + selected.length,
      selectedChunks: selected.length,
      emittedChunks: items.length,
      unchangedChunks: unchanged.length,
      emittedBytes: items.reduce((n, x) => n + x.bytes, 0),
      tokenEstimate: items.reduce((n, x) => n + x.tokenEstimate, 0),
    },
  };
  pack.digest = sha256(JSON.stringify({
    indexDigest: pack.indexDigest,
    query: pack.query,
    items: pack.items.map((x) => [x.chunkId, x.sha256]),
    unchanged: pack.unchanged,
  }));
  return pack;
}

export function refreshAndQuery(repoRoot, indexDir, query, opts = {}) {
  const index = buildContextIndex(repoRoot, indexDir, opts);
  return { index, pack: queryContextIndex(index, query, opts) };
}

export const contextSchemas = { INDEX_SCHEMA, PACK_SCHEMA };
