/**
 * KILN Papers — the publication registry (docs/PAPERS-WORKFLOW.md).
 *
 * A repo becomes a paper by DESIGNATION (details `paper {enabled}`,
 * gated on a valid paper.json — lib/repodetails.mjs) and becomes a
 * PUBLICATION at a forge RELEASE: this module snapshots the manifest
 * + the release tree's file list (path, size, sha256) at the release
 * commit into <stateDir>/papers.json and assigns the identifiers:
 *
 *   concept   kiln:<owner>/<slug>          (one per paper)
 *   version   kiln:<owner>/<slug>.v<n>     (n sequential from 1)
 *
 * Design rules (house law):
 *  - Released versions are IMMUTABLE — structurally: records are
 *    append-only here, no function edits or deletes a version, and
 *    the snapshot is a copy, so later repo edits cannot rewrite it.
 *    The only removal is forgetPaperRecords on repo deletion, riding
 *    the forge's own forget path.
 *  - The registry never copies visibility: readers (lib/httpapi.mjs)
 *    consult the repo's live visibility on every request, so a repo
 *    flipped private hides its records in the same instant.
 *  - `doi` is null on every record until a real DataCite/Crossref
 *    prefix exists. KILN IDs are KILN-registered identifiers in DOI
 *    syntax — never presented as registered DOIs.
 *  - Citations are generated at release time from the snapshot, so
 *    they are as immutable as the version they describe.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { writeFileAtomicSync } from "./state.mjs";
import { repoPath, repoExists, validRepoName } from "./git.mjs";
import { appendAudit, defaultBranch, listTags, readContents, resolveRef, ForgeError } from "./forge.mjs";
import { repoPages } from "./repodetails.mjs";
import { parseManifest, ManifestError, MAX_MANIFEST_BYTES } from "./papermanifest.mjs";

export class PapersError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "PapersError";
    this.status = status;
  }
}

const PAPERS_FILE = "papers.json";
/** The public base the resolver URLs are printed under. */
export const RESOLVER_BASE = "https://kiln.pocketnova.app";

// ---------------------------------------------------------------- identifiers

export function conceptId(owner, slug) {
  return `kiln:${owner}/${slug}`;
}

export function versionId(owner, slug, n) {
  return `kiln:${owner}/${slug}.v${n}`;
}

export function resolverUrl(owner, slug, n) {
  return n === undefined || n === null
    ? `${RESOLVER_BASE}/doi/${owner}/${slug}`
    : `${RESOLVER_BASE}/doi/${owner}/${slug}/v/${n}`;
}

// ---------------------------------------------------------------- store

function papersPath(dir) { return join(dir, PAPERS_FILE); }

function loadStore(dir) {
  const p = papersPath(dir);
  if (!existsSync(p)) return { papers: {} };
  try {
    const s = JSON.parse(readFileSync(p, "utf8"));
    return { papers: s.papers || {} };
  } catch {
    return { papers: {} };
  }
}

function saveStore(dir, store) {
  writeFileAtomicSync(papersPath(dir), JSON.stringify(store, null, 2) + "\n");
}

function key(owner, slug) { return `${owner}/${slug}`; }

function mustRepo(dir, owner, repo) {
  if (!validRepoName(owner) || !validRepoName(repo)) {
    throw new PapersError(400, `invalid owner/repo name: ${owner}/${repo}`);
  }
  if (!repoExists(dir, owner, repo)) throw new PapersError(404, `no such repo: ${owner}/${repo}`);
  return repoPath(dir, owner, repo);
}

/** The stored concept record for one paper, or null (no releases yet / no such paper). */
export function getPaperRecord(dir, owner, slug) {
  if (!validRepoName(owner) || !validRepoName(slug)) return null;
  return loadStore(dir).papers[key(owner, slug)] || null;
}

/** Every stored concept record (visibility filtering is the caller's job). */
export function listPaperRecords(dir) {
  return Object.values(loadStore(dir).papers)
    .sort((a, b) => key(a.owner, a.slug).localeCompare(key(b.owner, b.slug)));
}

/**
 * Repo deletion cleanup, riding the forge's forget path (the DELETE
 * route calls this beside forgetRepo): the paper's registry records
 * go with its repo. Returns how many released versions were removed,
 * for the audit line.
 */
export function forgetPaperRecords(dir, owner, repo) {
  const store = loadStore(dir);
  const rec = store.papers[key(owner, repo)];
  if (!rec) return 0;
  delete store.papers[key(owner, repo)];
  saveStore(dir, store);
  return (rec.versions || []).length;
}

// ---------------------------------------------------------------- git reads

/**
 * The validated manifest at one commit. Missing, oversized, or
 * invalid paper.json is a 400 that names the problem — a release on
 * a designated repo with a broken manifest is refused, never
 * snapshotted with a guess.
 */
export function readManifestAtCommit(dir, owner, repo, commit) {
  const gd = mustRepo(dir, owner, repo);
  let hit;
  try {
    hit = readContents(gd, commit, "paper.json");
  } catch (e) {
    if (e instanceof ForgeError) {
      throw new PapersError(400,
        `paper release refused: no paper.json at the release commit ${String(commit).slice(0, 12)} — a designated paper must carry its manifest in the release itself`);
    }
    throw e;
  }
  if (hit.buffer.length > MAX_MANIFEST_BYTES) {
    throw new PapersError(400, `paper release refused: paper.json is ${hit.buffer.length} bytes — at most ${MAX_MANIFEST_BYTES}`);
  }
  try {
    return parseManifest(hit.buffer.toString("utf8"));
  } catch (e) {
    if (e instanceof ManifestError) throw new PapersError(400, `paper release refused: ${e.message}`);
    throw e;
  }
}

/** Every blob at a commit: [{path, size, sha256}] — the release archive's fingerprint. */
function snapshotFiles(gd, commit) {
  const out = execFileSync("git", ["--git-dir", gd, "ls-tree", "-r", "-l", commit], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 512 * 1024 * 1024,
  });
  const files = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const meta = line.slice(0, tab).split(/\s+/);
    if (meta[1] !== "blob") continue;
    const size = parseInt(meta[3], 10);
    const buf = execFileSync("git", ["--git-dir", gd, "cat-file", "blob", meta[2]], {
      stdio: ["ignore", "pipe", "ignore"], maxBuffer: 512 * 1024 * 1024,
    });
    files.push({
      path: line.slice(tab + 1),
      size: Number.isFinite(size) ? size : buf.length,
      sha256: createHash("sha256").update(buf).digest("hex"),
    });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

// ---------------------------------------------------------------- citations

function bibtexEscape(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/\{/g, "\\{").replace(/\}/g, "\\}");
}

/**
 * The generated citations for one version, from its manifest
 * snapshot + IDs + release date. Exact formats: docs/PAPERS-WORKFLOW.md.
 * When a registered DOI exists (the version's doi field — null
 * throughout v1), the citations prefer it over the resolver URL.
 */
export function buildCitations(manifest, { owner, slug, n, releasedAt, doi = null }) {
  const year = String(releasedAt || "").slice(0, 4) || String(new Date().getFullYear());
  const names = manifest.authors.map((a) => a.name);
  const url = resolverUrl(owner, slug, n);
  const id = versionId(owner, slug, n);
  const text = `${names.join(", ")} (${year}). ${manifest.title}. KILN Papers, version ${n}. ${doi ? `https://doi.org/${doi}` : url}`;
  const keyPart = `${owner}_${slug}_v${n}`.replace(/[^A-Za-z0-9]+/g, "_");
  const lines = [
    `@misc{kiln_${keyPart},`,
    `  author = {${names.map(bibtexEscape).join(" and ")}},`,
    `  title = {${bibtexEscape(manifest.title)}},`,
    `  year = {${year}},`,
    `  publisher = {KILN Papers},`,
    `  version = {${n}},`,
  ];
  if (doi) lines.push(`  doi = {${bibtexEscape(doi)}},`);
  lines.push(
    `  note = {KILN ID ${id}},`,
    `  url = {${url}}`,
    `}`,
  );
  return { text, bibtex: lines.join("\n") };
}

// ---------------------------------------------------------------- release hook

/**
 * Pre-flight for the forge release door: on a paper-designated repo,
 * resolve the commit a release WOULD point at (exactly the forge's
 * own resolution: an existing tag's commit, else the target/default
 * branch tip) and validate the manifest there. Returns {commit,
 * manifest} — or null when the release cannot resolve at all, in
 * which case the forge's own error should answer (this hook never
 * masks it). Throws PapersError(400) when the manifest is missing or
 * invalid at that commit: the release is refused whole.
 */
export function planPaperRelease(dir, owner, repo, { tag, target } = {}) {
  const gd = mustRepo(dir, owner, repo);
  const existing = listTags(gd).find((t) => t.name === tag);
  const commit = existing ? existing.sha : resolveRef(gd, target || defaultBranch(gd));
  if (!commit) return null;
  const manifest = readManifestAtCommit(dir, owner, repo, commit);
  return { commit, manifest };
}

/**
 * Snapshot a just-created forge release into the registry and
 * assign the next version ID. `release` is forge.createRelease's
 * record ({tag, sha, createdAt, …}); `manifest` is the validated
 * manifest from planPaperRelease for the same commit (re-read here
 * if not supplied). Returns the stored version record.
 */
export function recordPaperRelease(dir, owner, repo, actor, release, manifest) {
  const gd = mustRepo(dir, owner, repo);
  const snapManifest = manifest || readManifestAtCommit(dir, owner, repo, release.sha);
  const files = snapshotFiles(gd, release.sha);
  const store = loadStore(dir);
  const k = key(owner, repo);
  const rec = store.papers[k] || {
    id: conceptId(owner, repo),
    owner,
    slug: repo,
    repo: k,
    doi: null,
    versions: [],
  };
  const n = rec.versions.length + 1;
  const version = {
    n,
    id: versionId(owner, repo, n),
    tag: release.tag,
    commit: release.sha,
    releasedAt: release.createdAt,
    releasedBy: actor?.label || "unknown",
    manifest: snapManifest,
    files,
    doi: null,
    citations: buildCitations(snapManifest, { owner, slug: repo, n, releasedAt: release.createdAt }),
  };
  rec.versions.push(version);
  store.papers[k] = rec;
  saveStore(dir, store);
  appendAudit(dir, actor, "paper.release", `${k}@v${n}`, { tag: release.tag, commit: release.sha, id: version.id });
  return version;
}

// ---------------------------------------------------------------- read views

/** One version as the API serves it (stored snapshot + its resolver URL). */
export function versionView(dir, record, version) {
  return {
    ...version,
    conceptId: record.id,
    owner: record.owner,
    slug: record.slug,
    resolver: resolverUrl(record.owner, record.slug, version.n),
  };
}

/** The concept record as the API serves it: snapshot data + live repo facts. */
export function conceptView(dir, record) {
  const versions = (record.versions || []).map((v) => versionView(dir, record, v));
  const latest = versions.length ? versions[versions.length - 1] : null;
  const pages = repoPages(dir, record.owner, record.slug);
  return {
    id: record.id,
    owner: record.owner,
    slug: record.slug,
    repo: record.repo,
    doi: record.doi ?? null,
    resolver: resolverUrl(record.owner, record.slug),
    pagesUrl: pages.enabled ? `/pages/${record.owner}/${record.slug}/` : null,
    title: latest ? latest.manifest.title : null,
    manifest: latest ? latest.manifest : null,
    versionCount: versions.length,
    firstReleasedAt: versions.length ? versions[0].releasedAt : null,
    latestReleasedAt: latest ? latest.releasedAt : null,
    versions,
  };
}

/** One version view by number, or null. */
export function getVersionView(dir, record, n) {
  const v = (record.versions || []).find((x) => x.n === n);
  return v ? versionView(dir, record, v) : null;
}

// ---------------------------------------------------------------- resolver

/**
 * Where a resolver hit lands: the paper's KILN Pages site when a
 * pages source is designated (the canonical record page), else the
 * API record itself. Throws PapersError(404) for a paper or version
 * that does not exist — an ID that was never assigned resolves
 * nowhere, honestly.
 */
export function planDoiRedirect(dir, owner, slug, n) {
  const record = getPaperRecord(dir, owner, slug);
  if (!record) {
    throw new PapersError(404,
      `no paper record for ${owner}/${slug} — papers are registered at their first release (see swarm/docs/PAPERS-WORKFLOW.md)`);
  }
  if (n !== undefined && n !== null) {
    if (!getVersionView(dir, record, n)) {
      throw new PapersError(404, `paper ${owner}/${slug} has no version ${n} (it has ${record.versions.length})`);
    }
  }
  const pages = repoPages(dir, owner, slug);
  if (pages.enabled) return { location: `/pages/${owner}/${slug}/` };
  return { location: n !== undefined && n !== null ? `/v1/papers/${owner}/${slug}/v/${n}` : `/v1/papers/${owner}/${slug}` };
}
