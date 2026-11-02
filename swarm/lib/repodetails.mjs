/**
 * KILN Project Details — one aggregated details object per hosted repo,
 * derived LIVE on every call from the bare repo itself (git plumbing +
 * an fs size walk), exactly like siteStatus/workspaceStatus derive their
 * answers. Nothing is cached, so details can never go stale and lie.
 *
 * The only persisted part is the EDITABLE metadata — description,
 * topics and visibility — which lives in the bare repo's own `kiln.json` (the metadata
 * file lib/git.mjs createRepo writes at repo creation). Updates merge
 * atomically into that file and preserve unknown fields, so older and
 * future tooling fields survive a details edit. Repos without a
 * kiln.json read defaults; the first update creates the file. No manual
 * per-repo setup exists anywhere: every hosted repo answers details
 * immediately.
 *
 * Circular-import care: workspaces.mjs imports repoFactsSummary from
 * here (for its status repo entries), and this module imports the
 * workspaces/sites registry stores for membership + linked-site lookup.
 * All cross-calls happen at runtime inside functions — neither module
 * has top-level side effects that touch the other.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomicSync } from "./state.mjs";
import { repoPath, repoExists, validRepoName } from "./git.mjs";
import { parseManifest, ManifestError, MAX_MANIFEST_BYTES } from "./papermanifest.mjs";
import { readLatest } from "./ci.mjs";
import { loadStore as loadWorkspaceStore } from "./workspaces.mjs";
import { loadStore as loadSiteStore } from "./sites.mjs";

const MAX_DESCRIPTION = 1024;
const MAX_TOPICS = 16;
const TOPIC_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const README_MAX_BYTES = 128 * 1024;
const MAX_LANGUAGES = 8;

// Language by file extension — small, in-module, bytes-weighted below.
const LANGUAGE_BY_EXT = {
  js: "JavaScript", mjs: "JavaScript", cjs: "JavaScript", jsx: "JavaScript",
  ts: "TypeScript", tsx: "TypeScript", mts: "TypeScript", cts: "TypeScript",
  py: "Python", rs: "Rust", go: "Go", java: "Java", kt: "Kotlin",
  c: "C", h: "C", cpp: "C++", cc: "C++", cxx: "C++", hpp: "C++",
  cs: "C#", rb: "Ruby", php: "PHP", swift: "Swift", scala: "Scala",
  html: "HTML", htm: "HTML", css: "CSS", scss: "SCSS", less: "Less",
  sh: "Shell", bash: "Shell", zsh: "Shell", ps1: "PowerShell",
  json: "JSON", yaml: "YAML", yml: "YAML", toml: "TOML", xml: "XML",
  md: "Markdown", markdown: "Markdown", sql: "SQL", sol: "Solidity",
  lua: "Lua", r: "R", pl: "Perl", ex: "Elixir", exs: "Elixir",
  erl: "Erlang", hs: "Haskell", ml: "OCaml", clj: "Clojure",
  dart: "Dart", vue: "Vue", svelte: "Svelte", txt: "Text",
};

export class RepoDetailsError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "RepoDetailsError";
    this.status = status;
  }
}

// ---------------------------------------------------------------- git plumbing

function needRepo(dir, owner, repo) {
  if (!validRepoName(owner) || !validRepoName(repo) || !repoExists(dir, owner, repo)) {
    throw new RepoDetailsError(404,
      `no such repo: ${owner}/${repo} — check the owner/repo name, or create the repo first (repo create / POST /git/${owner}/${repo})`);
  }
  return repoPath(dir, owner, repo);
}

/** Run git plumbing against the bare repo. Returns trimmed stdout, or null on any failure. */
function gitOut(gd, args, opts = {}) {
  try {
    return execFileSync("git", ["--git-dir", gd, ...args], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], ...opts,
    });
  } catch {
    return null;
  }
}

function defaultBranch(gd) {
  const out = gitOut(gd, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const b = out ? out.trim() : "";
  return b || null;
}

function hasHead(gd) {
  return gitOut(gd, ["rev-parse", "-q", "--verify", "HEAD"]) !== null;
}

function commitCount(gd, head) {
  if (!head) return 0;
  const out = gitOut(gd, ["rev-list", "--count", "HEAD"]);
  const n = out ? parseInt(out.trim(), 10) : NaN;
  return Number.isFinite(n) ? n : 0;
}

const LOG_FORMAT = "--format=%H%x00%s%x00%an%x00%aI";

/** Up to `n` most recent commits: {sha, shortSha, subject, author, date}. */
function recentCommits(gd, head, n) {
  if (!head) return [];
  const out = gitOut(gd, ["log", `-${n}`, LOG_FORMAT, "HEAD"]);
  if (!out) return [];
  return out.split("\n").filter(Boolean).map((line) => {
    const [sha, subject, author, date] = line.split("\0");
    return { sha, shortSha: sha.slice(0, 7), subject: subject || "", author: author || "", date: date || "" };
  });
}

/** All blobs at HEAD: [{path, size}] from `ls-tree -r -l`. */
function treeBlobs(gd, head) {
  if (!head) return [];
  const out = gitOut(gd, ["ls-tree", "-r", "-l", "HEAD"]);
  if (!out) return [];
  const blobs = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const meta = line.slice(0, tab).split(/\s+/);
    const size = parseInt(meta[3], 10);
    if (meta[1] !== "blob" || !Number.isFinite(size)) continue;
    blobs.push({ path: line.slice(tab + 1), size });
  }
  return blobs;
}

/** Root-level entries at HEAD: [{type, sha, size|null, name}] from `ls-tree -l`. */
function rootEntries(gd, head) {
  if (!head) return [];
  const out = gitOut(gd, ["ls-tree", "-l", "HEAD"]);
  if (!out) return [];
  const entries = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const meta = line.slice(0, tab).split(/\s+/);
    entries.push({ type: meta[1], sha: meta[2], name: line.slice(tab + 1) });
  }
  return entries;
}

/** Total on-disk size of the bare repo directory (fs walk, symlinks not followed). */
function diskBytes(gd) {
  let total = 0;
  const walk = (p) => {
    let entries;
    try { entries = readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(p, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) { try { total += statSync(full).size; } catch { /* vanished mid-walk */ } }
    }
  };
  walk(gd);
  return total;
}

function languageBreakdown(blobs) {
  const total = blobs.reduce((s, b) => s + b.size, 0);
  const byLang = new Map();
  for (const b of blobs) {
    const base = b.path.slice(b.path.lastIndexOf("/") + 1);
    const dot = base.lastIndexOf(".");
    const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
    const language = LANGUAGE_BY_EXT[ext] || "Other";
    const cur = byLang.get(language) || { language, files: 0, bytes: 0 };
    cur.files += 1;
    cur.bytes += b.size;
    byLang.set(language, cur);
  }
  return [...byLang.values()]
    .sort((a, b) => b.bytes - a.bytes || a.language.localeCompare(b.language))
    .slice(0, MAX_LANGUAGES)
    .map((l) => ({ ...l, pct: total > 0 ? Math.round((l.bytes / total) * 1000) / 10 : 0 }));
}

/** Root README* content, capped at 128KB with an honest truncated flag. */
function readReadme(gd, head) {
  const entry = rootEntries(gd, head)
    .filter((e) => e.type === "blob" && /^readme([.].*)?$/i.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name))[0];
  if (!entry) return null;
  let buf;
  try {
    buf = execFileSync("git", ["--git-dir", gd, "cat-file", "blob", entry.sha], {
      stdio: ["ignore", "pipe", "ignore"], maxBuffer: 512 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  const truncated = buf.length > README_MAX_BYTES;
  const content = buf.subarray(0, README_MAX_BYTES).toString("utf8");
  // Title = the first ATX H1 ("# …"), the conventional README title; null
  // when the README has none — never guessed from the filename.
  const titleMatch = content.match(/^#[ \t]+(.+?)[ \t]*$/m);
  return {
    path: entry.name,
    title: titleMatch ? titleMatch[1] : null,
    content,
    truncated,
  };
}

// ---------------------------------------------------------------- kiln.json (editable metadata)

function kilnJsonPath(gd) {
  return join(gd, "kiln.json");
}

/** Parsed kiln.json, or {} when absent/unreadable. Unknown fields ride along untouched. */
function readKilnMeta(gd) {
  try {
    const m = JSON.parse(readFileSync(kilnJsonPath(gd), "utf8"));
    return m && typeof m === "object" ? m : {};
  } catch {
    return {};
  }
}

function metaDescription(meta) {
  return typeof meta.description === "string" ? meta.description : "";
}

function metaTopics(meta) {
  return Array.isArray(meta.topics) ? meta.topics.filter((t) => typeof t === "string") : [];
}

/**
 * Visibility is GitHub-shaped: "public" only when kiln.json says exactly
 * that. Anything else — absent, corrupt, a typo — reads "private", the
 * safe default every read gate relies on.
 */
function metaVisibility(meta) {
  return meta && meta.visibility === "public" ? "public" : "private";
}

function validVisibility(visibility) {
  if (visibility !== "public" && visibility !== "private") {
    throw new RepoDetailsError(400, `visibility must be "public" or "private"`);
  }
  return visibility;
}

// ---------------------------------------------------------------- pages setting

const PAGES_BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const PAGES_PATH_MAX = 256;

/**
 * The repo's KILN Pages source designation, normalized from kiln.json.
 * Stored shape: pages: { enabled, branch, path } — branch "" = the
 * repo's default branch, path "" = the branch root. Anything malformed
 * in the store reads as the disabled default: the failure mode is
 * "no site", never "the wrong site".
 */
export function metaPages(meta) {
  const p = meta && typeof meta.pages === "object" && meta.pages !== null ? meta.pages : {};
  return {
    enabled: p.enabled === true,
    branch: typeof p.branch === "string" ? p.branch : "",
    path: typeof p.path === "string" ? p.path.replace(/^\/+|\/+$/g, "") : "",
  };
}

/** The repo's stored pages designation (disabled default for unknown repos). */
export function repoPages(dir, owner, repo) {
  if (!validRepoName(owner) || !validRepoName(repo) || !repoExists(dir, owner, repo)) {
    return { enabled: false, branch: "", path: "" };
  }
  return metaPages(readKilnMeta(repoPath(dir, owner, repo)));
}

function validPagesPath(path) {
  if (typeof path !== "string" || path.length > PAGES_PATH_MAX) {
    throw new RepoDetailsError(400, `pages.path must be a string of at most ${PAGES_PATH_MAX} chars`);
  }
  const clean = path.replace(/^\/+|\/+$/g, "");
  if (clean === "") return "";
  // A directory inside the repo: relative segments only — no "..", no
  // ".", no backslashes, no empty segments. The pages server joins this
  // onto git object lookups, never the filesystem, but the stored value
  // is held to the same discipline as forge paths regardless.
  if (clean.includes("\\") || clean.split("/").some((s) => s === "" || s === "." || s === "..")) {
    throw new RepoDetailsError(400, `pages.path must be a clean relative directory (no "..", ".", or empty segments)`);
  }
  return clean;
}

function validPagesBranch(branch) {
  if (typeof branch !== "string" ||
      (branch !== "" && (!PAGES_BRANCH_RE.test(branch) || branch.includes("..") ||
        branch.endsWith("/") || branch.endsWith(".lock")))) {
    throw new RepoDetailsError(400, `pages.branch must be "" (the default branch) or a valid branch name`);
  }
  return branch;
}

/** Validate a partial pages patch and merge it over the current setting. */
function validPages(pages, current) {
  if (!pages || typeof pages !== "object" || Array.isArray(pages)) {
    throw new RepoDetailsError(400, `pages must be an object {enabled?, branch?, path?}`);
  }
  const next = { ...current };
  if (pages.enabled !== undefined) {
    if (typeof pages.enabled !== "boolean") {
      throw new RepoDetailsError(400, `pages.enabled must be a boolean`);
    }
    next.enabled = pages.enabled;
  }
  if (pages.branch !== undefined) next.branch = validPagesBranch(pages.branch);
  if (pages.path !== undefined) next.path = validPagesPath(pages.path);
  return next;
}

// ---------------------------------------------------------------- paper designation

/**
 * The repo's paper designation, normalized from kiln.json. Stored
 * shape: paper: { enabled }. A paper is designated by its MANIFEST,
 * never by assertion: enabling is refused unless a valid paper.json
 * sits at the default branch's tip at that moment (validPaper below).
 * Anything malformed in the store reads as the disabled default,
 * same discipline as pages.
 */
export function metaPaper(meta) {
  const p = meta && typeof meta.paper === "object" && meta.paper !== null ? meta.paper : {};
  return { enabled: p.enabled === true };
}

/** The repo's stored paper designation (disabled default for unknown repos). */
export function repoPaper(dir, owner, repo) {
  if (!validRepoName(owner) || !validRepoName(repo) || !repoExists(dir, owner, repo)) {
    return { enabled: false };
  }
  return metaPaper(readKilnMeta(repoPath(dir, owner, repo)));
}

/** Validate a partial paper patch and merge it over the current setting. */
function validPaper(paper, current, gd) {
  if (!paper || typeof paper !== "object" || Array.isArray(paper)) {
    throw new RepoDetailsError(400, `paper must be an object {enabled?}`);
  }
  const next = { ...current };
  if (paper.enabled !== undefined) {
    if (typeof paper.enabled !== "boolean") {
      throw new RepoDetailsError(400, `paper.enabled must be a boolean`);
    }
    next.enabled = paper.enabled;
  }
  if (next.enabled) {
    if (!hasHead(gd)) {
      throw new RepoDetailsError(400,
        `paper designation requires a valid paper.json at the repo root — the repo has no commits yet`);
    }
    const entry = rootEntries(gd, true).find((e) => e.type === "blob" && e.name === "paper.json");
    if (!entry) {
      throw new RepoDetailsError(400,
        `paper designation requires a valid paper.json at the repo root on the default branch — none found`);
    }
    let buf;
    try {
      buf = execFileSync("git", ["--git-dir", gd, "cat-file", "blob", entry.sha], {
        stdio: ["ignore", "pipe", "ignore"], maxBuffer: 512 * 1024 * 1024,
      });
    } catch {
      throw new RepoDetailsError(400, `paper.json could not be read from the default branch tip`);
    }
    if (buf.length > MAX_MANIFEST_BYTES) {
      throw new RepoDetailsError(400, `paper.json is ${buf.length} bytes — at most ${MAX_MANIFEST_BYTES}`);
    }
    try {
      parseManifest(buf.toString("utf8"));
    } catch (e) {
      if (e instanceof ManifestError) throw new RepoDetailsError(400, e.message);
      throw e;
    }
  }
  return next;
}

/**
 * The repo's stored visibility ("public" | "private"). Unknown repos and
 * unreadable metadata read "private": gates consult this on every public
 * read, so the failure mode must be closed, never open.
 */
export function repoVisibility(dir, owner, repo) {
  if (!validRepoName(owner) || !validRepoName(repo) || !repoExists(dir, owner, repo)) {
    return "private";
  }
  return metaVisibility(readKilnMeta(repoPath(dir, owner, repo)));
}

function validDescription(description) {
  if (typeof description !== "string" || description.length > MAX_DESCRIPTION) {
    throw new RepoDetailsError(400, `description must be a string of at most ${MAX_DESCRIPTION} chars`);
  }
  return description;
}

function validTopics(topics) {
  if (!Array.isArray(topics)) {
    throw new RepoDetailsError(400, "topics must be an array of topic strings");
  }
  if (topics.length > MAX_TOPICS) {
    throw new RepoDetailsError(400, `topics: at most ${MAX_TOPICS} topics`);
  }
  const out = [];
  for (const t of topics) {
    if (typeof t !== "string" || !TOPIC_RE.test(t)) {
      throw new RepoDetailsError(400,
        `invalid topic "${t}": each topic must match ^[a-z0-9][a-z0-9-]{0,31}$ (lowercase letters, digits, dashes)`);
    }
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------- public API

/**
 * Context-economical summary for workspace status repo entries:
 * { description, topics, defaultBranch, commitCount, lastCommit } —
 * deliberately NO readme body and no filesystem walk.
 * Unknown repo → RepoDetailsError 404.
 */
export function repoFactsSummary(dir, owner, repo) {
  const gd = needRepo(dir, owner, repo);
  const meta = readKilnMeta(gd);
  const head = hasHead(gd);
  const recent = recentCommits(gd, head, 1);
  return {
    description: metaDescription(meta),
    topics: metaTopics(meta),
    defaultBranch: defaultBranch(gd),
    commitCount: commitCount(gd, head),
    lastCommit: recent.length ? recent[0] : null,
  };
}

/** The full project-details object for one repo, derived live. Unknown repo → 404. */
export function repoDetails(dir, owner, repo) {
  const gd = needRepo(dir, owner, repo);
  const meta = readKilnMeta(gd);
  const head = hasHead(gd);
  const blobs = treeBlobs(gd, head);
  const recent = recentCommits(gd, head, 5);
  const ref = `${owner}/${repo}`;

  const workspaces = Object.values(loadWorkspaceStore(dir).workspaces)
    .filter((w) => Array.isArray(w.repos) && w.repos.includes(ref))
    .map((w) => ({ id: w.id, owner: w.owner, slug: w.slug, name: w.name, parentId: w.parentId ?? null }))
    .sort((a, b) => a.slug.localeCompare(b.slug));

  let site = null;
  for (const s of Object.values(loadSiteStore(dir).sites)) {
    if (s.frontend === ref) { site = { id: s.id, name: s.name, role: "frontend" }; break; }
    if (s.backend === ref) { site = { id: s.id, name: s.name, role: "backend" }; break; }
  }

  return {
    repo: ref,
    owner,
    name: repo,
    createdAt: typeof meta.createdAt === "string" ? meta.createdAt : null,
    description: metaDescription(meta),
    topics: metaTopics(meta),
    visibility: metaVisibility(meta),
    pages: metaPages(meta),
    paper: metaPaper(meta),
    empty: !head,
    defaultBranch: defaultBranch(gd),
    commitCount: commitCount(gd, head),
    fileCount: blobs.length,
    treeBytes: blobs.reduce((s, b) => s + b.size, 0),
    diskBytes: diskBytes(gd),
    lastCommit: recent.length ? recent[0] : null,
    recentActivity: recent,
    languages: languageBreakdown(blobs),
    readme: readReadme(gd, head),
    workspaces,
    site,
    ci: readLatest(dir, owner, repo) || null,
  };
}

/**
 * Edit the persisted metadata (description, topics and/or visibility) in the repo's
 * kiln.json — merged atomically, unknown fields preserved, file created
 * when absent. Returns the full updated details object.
 */
export function updateRepoDetails(dir, owner, repo, patch = {}) {
  const gd = needRepo(dir, owner, repo);
  const meta = readKilnMeta(gd);
  const next = { ...meta };
  if (!existsSync(kilnJsonPath(gd))) {
    // First write for a repo that predates kiln.json: stamp the identity
    // fields createRepo would have written — but NOT a createdAt, which
    // would invent a creation date the forge does not know.
    next.schema = next.schema || "kiln.git-repo.v1";
    next.owner = next.owner || owner;
    next.repo = next.repo || repo;
  }
  if (patch.description !== undefined) next.description = validDescription(patch.description);
  if (patch.topics !== undefined) next.topics = validTopics(patch.topics);
  if (patch.visibility !== undefined) next.visibility = validVisibility(patch.visibility);
  if (patch.pages !== undefined) next.pages = validPages(patch.pages, metaPages(meta));
  if (patch.paper !== undefined) next.paper = validPaper(patch.paper, metaPaper(meta), gd);
  writeFileAtomicSync(kilnJsonPath(gd), JSON.stringify(next, null, 2) + "\n");
  return repoDetails(dir, owner, repo);
}
