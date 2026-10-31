/**
 * KILN Forge — the GitHub-shaped surface over KILN-native repos:
 * branches, tree/contents (read + write as real git commits), commit
 * history, compare, pull requests (open/comment/review/merge), tags and
 * releases. Packages live in lib/packages.mjs.
 *
 * Design rules (house law):
 *  - Real or loud failure. File writes are REAL git commits made with
 *    plumbing (hash-object/update-index/commit-tree/update-ref with a
 *    compare-and-swap on the branch tip) — never a worktree checkout,
 *    never a fake record.
 *  - PR/release records are an INDEX (JSON registry in the state dir,
 *    atomic writes like lib/workspaces.mjs). The git objects — branches,
 *    tags, commits — are the truth; the registry carries the prose
 *    (titles, comments, reviews, notes) git has no home for.
 *  - Merges run in a throwaway local clone of the bare repo and are
 *    pushed back over the filesystem; a conflicted merge changes
 *    NOTHING in the bare repo and answers 409 with the conflicted paths.
 *  - Every mutation appends to the audit log (forge-audit.jsonl):
 *    who (principal), what, where, when. The log is evidence, not a
 *    feature — nothing reads it back into product behavior.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { writeFileAtomicSync } from "./state.mjs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, createHash } from "node:crypto";
import { repoPath, repoExists, validRepoName } from "./git.mjs";
import { loadRepoConfig, enqueueCiJob, readLatest } from "./ci.mjs";

export class ForgeError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ForgeError";
    this.status = status;
  }
}

const FORGE_FILE = "forge.json";
const AUDIT_FILE = "forge-audit.jsonl";
const MAX_FILE_BYTES = 1024 * 1024; // contents API: 1MB per file, stated in errors
const MAX_PATCH_BYTES = 256 * 1024;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const PATH_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._\-/ ]+$/;

// ---------------------------------------------------------------- actors

/**
 * The identity a principal writes under. Operator is the forge root;
 * account sessions write as the account; agent tokens write as the
 * agent, owned by (and traceable to) their account.
 */
export function actorOf(principal) {
  if (!principal || principal.kind === "operator") {
    return { kind: "operator", label: "operator", name: "KILN Operator", email: "operator@kiln.local", owner: null };
  }
  if (principal.kind === "anonymous") {
    // Public-repo reads only (the HTTP gate never lets an anonymous
    // principal reach a write, where an actor would be stamped).
    return { kind: "anonymous", label: "anonymous", name: "Anonymous", email: "anonymous@kiln.local", owner: null };
  }
  const a = principal.account;
  if (principal.kind === "agent") {
    return {
      kind: "agent",
      label: `agent:${a.owner}/${principal.agent.name}`,
      name: principal.agent.name,
      email: a.email,
      owner: a.owner,
      accountName: a.name,
    };
  }
  return { kind: "session", label: `account:${a.owner}`, name: a.name, email: a.email, owner: a.owner };
}

// ---------------------------------------------------------------- audit

export function appendAudit(dir, actor, action, target, detail = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    actor: actor?.label || "unknown",
    actorKind: actor?.kind || "unknown",
    action,
    target,
    ...detail,
  }) + "\n";
  try { appendFileSync(join(dir, AUDIT_FILE), line); } catch { /* audit must never break the write it records */ }
}

// ---------------------------------------------------------------- store

function forgePath(dir) { return join(dir, FORGE_FILE); }

function loadStore(dir) {
  const p = forgePath(dir);
  if (!existsSync(p)) return { pulls: {}, releases: {}, counters: {} };
  try {
    const s = JSON.parse(readFileSync(p, "utf8"));
    return { pulls: s.pulls || {}, releases: s.releases || {}, counters: s.counters || {} };
  } catch {
    return { pulls: {}, releases: {}, counters: {} };
  }
}

function saveStore(dir, store) {
  writeFileAtomicSync(forgePath(dir), JSON.stringify(store, null, 2) + "\n");
}

/**
 * Repo deletion cleanup (the HTTP delete route's second half): drop
 * this repo's pull/release records and its PR counter from the forge
 * registry, so a repo recreated under the same name starts clean —
 * its first PR is #1 again, not a resurrection of the dead repo's
 * history. Returns what was removed, for the audit line.
 */
export function forgetRepo(dir, owner, repo) {
  const store = loadStore(dir);
  const k = key(owner, repo);
  const removed = {
    pulls: (store.pulls[k] || []).length,
    releases: (store.releases[k] || []).length,
  };
  delete store.pulls[k];
  delete store.releases[k];
  delete store.counters[k];
  if (removed.pulls || removed.releases) saveStore(dir, store);
  return removed;
}

// ---------------------------------------------------------------- git plumbing

function git(gd, args, opts = {}) {
  return execFileSync("git", ["--git-dir", gd, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 512 * 1024 * 1024,
    ...opts,
  });
}

function gitText(gd, args, opts = {}) {
  return git(gd, args, opts).toString("utf8");
}

function mustRepo(dir, owner, repo) {
  if (!validRepoName(owner) || !validRepoName(repo)) {
    throw new ForgeError(400, `invalid owner/repo name: ${owner}/${repo}`);
  }
  if (!repoExists(dir, owner, repo)) throw new ForgeError(404, `no such repo: ${owner}/${repo}`);
  return repoPath(dir, owner, repo);
}

export function validBranchName(name) {
  return typeof name === "string" && BRANCH_RE.test(name) && !name.includes("..") && !name.endsWith("/") && !name.endsWith(".lock");
}

function validPath(p) {
  return typeof p === "string" && p.length > 0 && p.length <= 512 && PATH_RE.test(p);
}

/** Resolve a ref name (branch, tag, sha, HEAD) to a commit sha, or null. */
export function resolveRef(gd, ref) {
  if (!ref) return null;
  try {
    return gitText(gd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).trim() || null;
  } catch { return null; }
}

export function defaultBranch(gd) {
  try {
    const out = gitText(gd, ["symbolic-ref", "--quiet", "HEAD"]).trim(); // refs/heads/main
    return out.replace(/^refs\/heads\//, "") || "main";
  } catch { return "main"; }
}

function branchSha(gd, branch) {
  return resolveRef(gd, `refs/heads/${branch}`);
}

// ---------------------------------------------------------------- branches

export function listBranches(gd) {
  const head = defaultBranch(gd);
  let out = "";
  try { out = gitText(gd, ["for-each-ref", "--format=%(refname:strip=2) %(objectname)", "refs/heads"]); } catch { /* empty repo */ }
  return out.split("\n").filter(Boolean).map((line) => {
    const i = line.lastIndexOf(" ");
    return { name: line.slice(0, i), sha: line.slice(i + 1), default: line.slice(0, i) === head };
  });
}

export function createBranch(gd, name, from) {
  if (!validBranchName(name)) throw new ForgeError(400, `invalid branch name: ${name}`);
  if (branchSha(gd, name)) throw new ForgeError(409, `branch exists: ${name}`);
  const fromRef = from || defaultBranch(gd);
  const sha = resolveRef(gd, fromRef);
  if (!sha) throw new ForgeError(400, `cannot branch from "${fromRef}" — it does not resolve to a commit`);
  git(gd, ["branch", name, sha]);
  return { name, sha };
}

export function deleteBranch(gd, name) {
  if (!validBranchName(name)) throw new ForgeError(400, `invalid branch name: ${name}`);
  if (name === defaultBranch(gd)) throw new ForgeError(400, `refusing to delete the default branch (${name})`);
  if (!branchSha(gd, name)) throw new ForgeError(404, `no such branch: ${name}`);
  git(gd, ["branch", "-D", name]);
  return { ok: true, name };
}

// ---------------------------------------------------------------- tree + contents

export function readTree(gd, ref, path = "") {
  const sha = resolveRef(gd, ref || defaultBranch(gd));
  if (!sha) throw new ForgeError(404, "repo has no commits yet");
  const spec = path ? `${sha}:${path}` : sha;
  let out;
  try {
    out = gitText(gd, ["ls-tree", "-z", spec]);
  } catch {
    throw new ForgeError(404, `no such path at ${ref || "HEAD"}: ${path || "(root)"}`);
  }
  const entries = out.split("\0").filter(Boolean).map((row) => {
    // "<mode> <type> <sha>\t<name>"
    const tab = row.indexOf("\t");
    const meta = row.slice(0, tab).split(" ");
    const name = row.slice(tab + 1);
    return { name, path: path ? `${path}/${name}` : name, type: meta[1], sha: meta[2], mode: meta[0] };
  });
  // Sizes for blobs, one batched call.
  for (const e of entries) {
    if (e.type !== "blob") continue;
    try { e.size = parseInt(gitText(gd, ["cat-file", "-s", e.sha]).trim(), 10); } catch { e.size = null; }
  }
  return { ref: ref || defaultBranch(gd), sha, path, entries };
}

export function readContents(gd, ref, path) {
  if (!validPath(path)) throw new ForgeError(400, `invalid path: ${path}`);
  const sha = resolveRef(gd, ref || defaultBranch(gd));
  if (!sha) throw new ForgeError(404, "repo has no commits yet");
  let meta;
  try {
    meta = gitText(gd, ["ls-tree", "-z", sha, "--", path]).split("\0").filter(Boolean)
      .map((row) => { const t = row.indexOf("\t"); const m = row.slice(0, t).split(" "); return { type: m[1], sha: m[2] }; })[0];
  } catch { meta = null; }
  if (!meta) throw new ForgeError(404, `no such file at ${ref || "HEAD"}: ${path}`);
  if (meta.type !== "blob") throw new ForgeError(400, `${path} is a ${meta.type}, not a file`);
  const buf = git(gd, ["cat-file", "blob", meta.sha]);
  return { path, ref: ref || defaultBranch(gd), commit: sha, sha: meta.sha, size: buf.length, buffer: buf };
}

/**
 * Create/update/delete one file as a REAL commit on a branch, via
 * plumbing against a temp index. Compare-and-swap on the branch tip:
 * a concurrent move answers 409 instead of silently losing a write.
 * Returns { commit, branch, path, blobSha|null }.
 */
export function writeFile(dir, owner, repo, actor, { path, content, encoding, message, branch, sha, deleteFile = false }) {
  const gd = mustRepo(dir, owner, repo);
  if (!validPath(path)) throw new ForgeError(400, `invalid path: ${path}`);
  if (typeof message !== "string" || !message.trim()) throw new ForgeError(400, "a commit message is required");
  const br = branch || defaultBranch(gd);
  if (!validBranchName(br)) throw new ForgeError(400, `invalid branch name: ${br}`);
  const tip = branchSha(gd, br);
  if (!tip && branch) throw new ForgeError(404, `no such branch: ${br}`);
  if (!tip && !branch && listBranches(gd).length > 0) throw new ForgeError(404, `no such branch: ${br}`);

  // Current blob (for the optimistic sha check + update/delete sanity).
  let current = null;
  if (tip) {
    try {
      const row = gitText(gd, ["ls-tree", "-z", tip, "--", path]).split("\0").filter(Boolean)[0];
      if (row) { const t = row.indexOf("\t"); current = row.slice(0, t).split(" ")[2]; }
    } catch { /* no file */ }
  }
  if (deleteFile) {
    if (!current) throw new ForgeError(404, `no such file on ${br}: ${path}`);
    if (sha && sha !== current) throw new ForgeError(409, `sha mismatch — the file changed since you read it (current ${current})`);
  } else {
    if (current && !sha) throw new ForgeError(409, `file exists on ${br} — pass its current sha to update it (current ${current})`);
    if (current && sha !== current) throw new ForgeError(409, `sha mismatch — the file changed since you read it (current ${current})`);
    if (!current && sha) throw new ForgeError(409, `sha given but the file does not exist on ${br}`);
  }

  let buf = null;
  if (!deleteFile) {
    if (typeof content !== "string") throw new ForgeError(400, "content is required (string; base64 when encoding is \"base64\")");
    buf = encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
    if (buf.length > MAX_FILE_BYTES) throw new ForgeError(413, `file too large for the contents API (${buf.length} bytes > ${MAX_FILE_BYTES}) — push it with git instead`);
  }

  const tmpIdx = join(tmpdir(), `kiln-idx-${process.pid}-${randomBytes(6).toString("hex")}`);
  const env = {
    ...process.env,
    GIT_INDEX_FILE: tmpIdx,
    GIT_AUTHOR_NAME: actor.name, GIT_AUTHOR_EMAIL: actor.email,
    GIT_COMMITTER_NAME: actor.name, GIT_COMMITTER_EMAIL: actor.email,
  };
  try {
    if (tip) git(gd, ["read-tree", tip], { env }); else git(gd, ["read-tree", "--empty"], { env });
    let blobSha = null;
    if (deleteFile) {
      git(gd, ["update-index", "--force-remove", "--", path], { env });
    } else {
      blobSha = gitText(gd, ["hash-object", "-w", "--stdin"], { env, input: buf }).trim();
      git(gd, ["update-index", "--add", "--cacheinfo", `100644,${blobSha},${path}`], { env });
    }
    const tree = gitText(gd, ["write-tree"], { env }).trim();
    const args = ["commit-tree", tree, "-m", message];
    if (tip) args.splice(2, 0, "-p", tip);
    const commit = gitText(gd, args, { env }).trim();
    // CAS: only move the branch if it still points where we read it.
    try {
      git(gd, ["update-ref", `refs/heads/${br}`, commit, tip || "0000000000000000000000000000000000000000"]);
    } catch {
      throw new ForgeError(409, `branch ${br} moved while committing — retry`);
    }
    appendAudit(dir, actor, deleteFile ? "file.delete" : "file.write", `${owner}/${repo}:${path}`, { branch: br, commit });
    return { commit, branch: br, path, blobSha };
  } finally {
    try { rmSync(tmpIdx, { force: true }); } catch { /* temp index */ }
  }
}

// ---------------------------------------------------------------- commits + compare

const LOG_FMT = "%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e";

function parseLog(out) {
  return out.split("\x1e").map((r) => r.trim()).filter(Boolean).map((r) => {
    const [sha, parents, name, email, date, subject] = r.split("\x1f");
    return { sha, parents: parents ? parents.split(" ").filter(Boolean) : [], author: { name, email }, date, subject };
  });
}

export function listCommits(gd, { ref, limit = 30, path } = {}) {
  const sha = resolveRef(gd, ref || defaultBranch(gd));
  if (!sha) return { ref: ref || defaultBranch(gd), commits: [] };
  const n = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 200);
  const args = ["log", `--format=${LOG_FMT}`, "-n", String(n), sha];
  if (path) { if (!validPath(path)) throw new ForgeError(400, `invalid path: ${path}`); args.push("--", path); }
  return { ref: ref || defaultBranch(gd), commits: parseLog(gitText(gd, args)) };
}

export function getCommit(gd, shaIn) {
  const sha = resolveRef(gd, shaIn);
  if (!sha) throw new ForgeError(404, `no such commit: ${shaIn}`);
  const [commit] = parseLog(gitText(gd, ["log", "-1", `--format=${LOG_FMT}`, sha]));
  let files = [];
  try {
    const out = gitText(gd, ["diff-tree", "--no-commit-id", "--name-status", "-r", "-M", sha]);
    files = out.split("\n").filter(Boolean).map((l) => {
      const parts = l.split("\t");
      return parts.length >= 3
        ? { status: parts[0][0], path: parts[2], oldPath: parts[1] }
        : { status: parts[0][0], path: parts[1] };
    });
  } catch { /* root commit without parent still lists via --root fallback below */ }
  if (!files.length && !commit.parents.length) {
    try {
      const out = gitText(gd, ["diff-tree", "--root", "--no-commit-id", "--name-status", "-r", sha]);
      files = out.split("\n").filter(Boolean).map((l) => { const p = l.split("\t"); return { status: p[0][0], path: p[1] }; });
    } catch { /* empty tree */ }
  }
  return { ...commit, files };
}

export function compareRefs(gd, base, head) {
  const baseSha = resolveRef(gd, base);
  const headSha = resolveRef(gd, head);
  if (!baseSha) throw new ForgeError(404, `base does not resolve: ${base}`);
  if (!headSha) throw new ForgeError(404, `head does not resolve: ${head}`);
  const counts = gitText(gd, ["rev-list", "--left-right", "--count", `${baseSha}...${headSha}`]).trim().split(/\s+/);
  const behind = parseInt(counts[0], 10) || 0;
  const ahead = parseInt(counts[1], 10) || 0;
  const commits = parseLog(gitText(gd, ["log", `--format=${LOG_FMT}`, "-n", "100", `${baseSha}..${headSha}`]));
  let files = [];
  let patch = null;
  try {
    const ns = gitText(gd, ["diff", "--numstat", `${baseSha}...${headSha}`]);
    files = ns.split("\n").filter(Boolean).map((l) => {
      const [a, d, p] = l.split("\t");
      return { path: p, additions: a === "-" ? null : parseInt(a, 10), deletions: d === "-" ? null : parseInt(d, 10) };
    });
  } catch { /* identical trees */ }
  try {
    const raw = git(gd, ["diff", `${baseSha}...${headSha}`]);
    patch = raw.subarray(0, MAX_PATCH_BYTES).toString("utf8");
    if (raw.length > MAX_PATCH_BYTES) patch += "\n… (patch truncated at 256KB — fetch the refs for the full diff)\n";
  } catch { /* no diff */ }
  return { base, head, baseSha, headSha, ahead, behind, commits, files, patch };
}

// ---------------------------------------------------------------- tags + releases

export function listTags(gd) {
  let out = "";
  try { out = gitText(gd, ["for-each-ref", "--format=%(refname:strip=2) %(objectname) %(*objectname) %(objecttype)", "refs/tags"]); } catch { /* none */ }
  return out.split("\n").filter(Boolean).map((line) => {
    const parts = line.split(" ");
    const annotated = parts[3] === "tag";
    return { name: parts[0], sha: annotated && parts[2] ? parts[2] : parts[1], annotated };
  });
}

function key(owner, repo) { return `${owner}/${repo}`; }

export function listReleases(dir, owner, repo) {
  const gd = mustRepo(dir, owner, repo);
  const store = loadStore(dir);
  const records = store.releases[key(owner, repo)] || [];
  const byTag = new Map(records.map((r) => [r.tag, r]));
  const out = [];
  for (const t of listTags(gd)) {
    const rec = byTag.get(t.name);
    out.push(rec
      ? { ...rec, sha: t.sha, annotated: t.annotated }
      : { tag: t.name, name: t.name, notes: null, target: null, sha: t.sha, annotated: t.annotated, createdBy: null, createdAt: null, recorded: false });
    byTag.delete(t.name);
  }
  // Records whose tag was deleted out-of-band stay visible, flagged.
  for (const rec of byTag.values()) out.push({ ...rec, sha: null, tagMissing: true });
  return out.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")) || a.tag.localeCompare(b.tag));
}

export function createRelease(dir, owner, repo, actor, { tag, name, notes, target } = {}) {
  const gd = mustRepo(dir, owner, repo);
  if (typeof tag !== "string" || !TAG_RE.test(tag) || tag.includes("..")) {
    throw new ForgeError(400, `invalid tag: ${tag}`);
  }
  const existing = listTags(gd).find((t) => t.name === tag);
  const store = loadStore(dir);
  const records = store.releases[key(owner, repo)] || [];
  if (records.some((r) => r.tag === tag)) throw new ForgeError(409, `release exists: ${tag}`);
  let targetSha;
  if (existing) {
    targetSha = existing.sha;
    if (target) {
      const want = resolveRef(gd, target);
      if (want !== targetSha) throw new ForgeError(409, `tag ${tag} already points at ${targetSha}, not ${target}`);
    }
  } else {
    targetSha = resolveRef(gd, target || defaultBranch(gd));
    if (!targetSha) throw new ForgeError(400, `target does not resolve to a commit: ${target || defaultBranch(gd)}`);
    const msg = `${name || tag}\n\n${notes || ""}`.trim();
    git(gd, ["tag", "-a", tag, "-m", msg, targetSha], {
      env: { ...process.env, GIT_COMMITTER_NAME: actor.name, GIT_COMMITTER_EMAIL: actor.email },
    });
  }
  const rec = {
    tag,
    name: name || tag,
    notes: notes ?? null,
    target: target || null,
    sha: targetSha,
    recorded: true,
    createdBy: actor.label,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  records.push(rec);
  store.releases[key(owner, repo)] = records;
  saveStore(dir, store);
  appendAudit(dir, actor, "release.create", `${owner}/${repo}@${tag}`, { sha: targetSha });
  return rec;
}

export function updateRelease(dir, owner, repo, actor, tag, { name, notes } = {}) {
  mustRepo(dir, owner, repo);
  const store = loadStore(dir);
  const records = store.releases[key(owner, repo)] || [];
  const rec = records.find((r) => r.tag === tag);
  if (!rec) throw new ForgeError(404, `no release record for tag: ${tag} (create the release first)`);
  if (name !== undefined) rec.name = String(name);
  if (notes !== undefined) rec.notes = notes === null ? null : String(notes);
  rec.updatedAt = new Date().toISOString();
  saveStore(dir, store);
  appendAudit(dir, actor, "release.update", `${owner}/${repo}@${tag}`, {});
  return rec;
}

export function deleteRelease(dir, owner, repo, actor, tag, { deleteTag = false } = {}) {
  const gd = mustRepo(dir, owner, repo);
  const store = loadStore(dir);
  const records = store.releases[key(owner, repo)] || [];
  const i = records.findIndex((r) => r.tag === tag);
  if (i < 0 && !listTags(gd).some((t) => t.name === tag)) throw new ForgeError(404, `no such release: ${tag}`);
  if (i >= 0) records.splice(i, 1);
  store.releases[key(owner, repo)] = records;
  saveStore(dir, store);
  if (deleteTag) { try { git(gd, ["tag", "-d", tag]); } catch { /* already gone */ } }
  appendAudit(dir, actor, "release.delete", `${owner}/${repo}@${tag}`, { deleteTag: !!deleteTag });
  return { ok: true, tag, tagDeleted: !!deleteTag };
}

// ---------------------------------------------------------------- pull requests

function pullView(dir, gd, owner, repo, pull) {
  const headSha = branchSha(gd, pull.head);
  const baseSha = branchSha(gd, pull.base);
  let ahead = null, behind = null, mergeable = null;
  if (headSha && baseSha && pull.state === "open") {
    try {
      const counts = gitText(gd, ["rev-list", "--left-right", "--count", `${baseSha}...${headSha}`]).trim().split(/\s+/);
      behind = parseInt(counts[0], 10) || 0;
      ahead = parseInt(counts[1], 10) || 0;
    } catch { /* refs moved */ }
    try {
      // merge-tree writes the would-be tree; exit 1 = conflicts.
      execFileSync("git", ["--git-dir", gd, "merge-tree", "--write-tree", baseSha, headSha], { stdio: ["ignore", "pipe", "pipe"] });
      mergeable = true;
    } catch { mergeable = false; }
  }
  let ci = null;
  if (headSha) {
    try { ci = readLatest(dir, owner, repo, pull.head) || null; } catch { ci = null; }
    if (ci && ci.sha !== headSha) ci = null; // stale branch result is not this PR's CI
  }
  const reviews = {};
  for (const r of pull.reviews) reviews[r.author] = r.state; // latest per reviewer wins
  return { ...pull, headSha, baseSha, ahead, behind, mergeable, ci, reviewStates: reviews };
}

export function createPull(dir, owner, repo, actor, { title, body, head, base } = {}) {
  const gd = mustRepo(dir, owner, repo);
  if (typeof title !== "string" || !title.trim()) throw new ForgeError(400, "a PR title is required");
  if (!validBranchName(head || "")) throw new ForgeError(400, `invalid head branch: ${head}`);
  const baseBr = base || defaultBranch(gd);
  if (!validBranchName(baseBr)) throw new ForgeError(400, `invalid base branch: ${baseBr}`);
  if (head === baseBr) throw new ForgeError(400, "head and base are the same branch");
  // Legacy repos (created before the forge seeded an initial commit at
  // birth) can have NO commits at all: no branch name can resolve, and
  // the old bare "no such … branch" 404 sent clients hunting for a
  // branch problem that does not exist. Name the real state and the
  // way out. (New repos are born with an initial commit, so this only
  // fires for pre-fix repos — they are deliberately NOT retro-seeded.)
  if (listBranches(gd).length === 0) {
    throw new ForgeError(409,
      `repo ${owner}/${repo} has no commits yet, so no branch can resolve — it predates seeded initial commits. Land a first commit (push to ${baseBr}, or write a file via the contents API), then open the pull request.`);
  }
  if (!branchSha(gd, head)) throw new ForgeError(404, `no such head branch: ${head}`);
  if (!branchSha(gd, baseBr)) {
    throw new ForgeError(404, baseBr === defaultBranch(gd)
      ? `no such base branch: ${baseBr} — the default branch does not resolve to a commit in this repo (pass base: "<an existing branch>", or land a commit on ${baseBr} first)`
      : `no such base branch: ${baseBr}`);
  }
  const store = loadStore(dir);
  const k = key(owner, repo);
  const n = (store.counters[k] || 0) + 1;
  store.counters[k] = n;
  const pull = {
    number: n,
    repo: k,
    title: title.trim(),
    body: body ?? null,
    head, base: baseBr,
    state: "open",
    author: actor.label,
    comments: [],
    reviews: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergedAt: null, mergedBy: null, mergeCommit: null, mergeMethod: null,
  };
  (store.pulls[k] = store.pulls[k] || []).push(pull);
  saveStore(dir, store);
  appendAudit(dir, actor, "pull.open", `${k}#${n}`, { head, base: baseBr });
  return pullView(dir, gd, owner, repo, pull);
}

export function listPulls(dir, owner, repo, { state } = {}) {
  const gd = mustRepo(dir, owner, repo);
  const store = loadStore(dir);
  const all = store.pulls[key(owner, repo)] || [];
  return all
    .filter((p) => !state || state === "all" || p.state === state)
    .map((p) => pullView(dir, gd, owner, repo, p));
}

function findPull(store, owner, repo, n) {
  const pulls = store.pulls[key(owner, repo)] || [];
  const pull = pulls.find((p) => p.number === n);
  if (!pull) throw new ForgeError(404, `no such pull request: #${n}`);
  return pull;
}

export function getPull(dir, owner, repo, n) {
  const gd = mustRepo(dir, owner, repo);
  const store = loadStore(dir);
  return pullView(dir, gd, owner, repo, findPull(store, owner, repo, n));
}

export function updatePull(dir, owner, repo, actor, n, { title, body, state } = {}) {
  mustRepo(dir, owner, repo);
  const store = loadStore(dir);
  const pull = findPull(store, owner, repo, n);
  if (pull.state === "merged") throw new ForgeError(409, "a merged PR is final");
  if (title !== undefined) { if (!String(title).trim()) throw new ForgeError(400, "title cannot be empty"); pull.title = String(title).trim(); }
  if (body !== undefined) pull.body = body === null ? null : String(body);
  if (state !== undefined) {
    if (!["open", "closed"].includes(state)) throw new ForgeError(400, `state must be "open" or "closed" (merge via the merge endpoint)`);
    pull.state = state;
  }
  pull.updatedAt = new Date().toISOString();
  saveStore(dir, store);
  appendAudit(dir, actor, "pull.update", `${key(owner, repo)}#${n}`, { state: pull.state });
  return pull;
}

export function commentPull(dir, owner, repo, actor, n, { body } = {}) {
  mustRepo(dir, owner, repo);
  if (typeof body !== "string" || !body.trim()) throw new ForgeError(400, "a comment body is required");
  const store = loadStore(dir);
  const pull = findPull(store, owner, repo, n);
  const comment = { id: `c_${randomBytes(6).toString("hex")}`, author: actor.label, body, createdAt: new Date().toISOString() };
  pull.comments.push(comment);
  pull.updatedAt = new Date().toISOString();
  saveStore(dir, store);
  appendAudit(dir, actor, "pull.comment", `${key(owner, repo)}#${n}`, { comment: comment.id });
  return comment;
}

export function reviewPull(dir, owner, repo, actor, n, { state, body } = {}) {
  mustRepo(dir, owner, repo);
  if (!["approved", "changes_requested", "commented"].includes(state)) {
    throw new ForgeError(400, `review state must be approved | changes_requested | commented`);
  }
  const store = loadStore(dir);
  const pull = findPull(store, owner, repo, n);
  if (pull.state !== "open") throw new ForgeError(409, `cannot review a ${pull.state} PR`);
  const review = { id: `r_${randomBytes(6).toString("hex")}`, author: actor.label, state, body: body ?? null, createdAt: new Date().toISOString() };
  pull.reviews.push(review);
  pull.updatedAt = new Date().toISOString();
  saveStore(dir, store);
  appendAudit(dir, actor, "pull.review", `${key(owner, repo)}#${n}`, { review: review.id, state });
  return review;
}

/**
 * Merge a PR for real. fast-forward: base ref moves to the head commit
 * (refused unless strictly ahead). merge: a throwaway clone merges head
 * into base with a merge commit and pushes back over the filesystem;
 * conflicts answer 409 with the conflicted paths and NOTHING changes.
 * A standing changes_requested review blocks non-operator merges.
 * After a successful merge, CI is enqueued for the base branch when the
 * repo has a CI command — same best-effort contract as the push path.
 */
export function mergePull(dir, owner, repo, actor, n, { method = "merge", message, deleteBranch: deleteHeadBranch = false } = {}) {
  const gd = mustRepo(dir, owner, repo);
  if (!["merge", "fast-forward"].includes(method)) throw new ForgeError(400, `method must be "merge" or "fast-forward"`);
  const store = loadStore(dir);
  const pull = findPull(store, owner, repo, n);
  if (pull.state !== "open") throw new ForgeError(409, `PR #${n} is ${pull.state}, not open`);
  const latest = {};
  for (const r of pull.reviews) latest[r.author] = r.state;
  const blockers = Object.entries(latest).filter(([, s]) => s === "changes_requested").map(([a]) => a);
  if (blockers.length && actor.kind !== "operator") {
    throw new ForgeError(409, `merge blocked — changes requested by: ${blockers.join(", ")} (an operator may override)`);
  }
  const baseSha = branchSha(gd, pull.base);
  const headSha = branchSha(gd, pull.head);
  if (!baseSha || !headSha) throw new ForgeError(409, "base or head branch no longer resolves");

  let mergeCommit = null;
  if (method === "fast-forward") {
    let ancestor = false;
    try { git(gd, ["merge-base", "--is-ancestor", baseSha, headSha]); ancestor = true; } catch { ancestor = false; }
    if (!ancestor) throw new ForgeError(409, `fast-forward impossible — ${pull.base} has commits ${pull.head} lacks`);
    try {
      git(gd, ["update-ref", `refs/heads/${pull.base}`, headSha, baseSha]);
    } catch { throw new ForgeError(409, `branch ${pull.base} moved during merge — retry`); }
    mergeCommit = headSha;
  } else {
    const tmp = mkdtempSync(join(tmpdir(), "kiln-merge-"));
    try {
      const env = { ...process.env, GIT_AUTHOR_NAME: actor.name, GIT_AUTHOR_EMAIL: actor.email, GIT_COMMITTER_NAME: actor.name, GIT_COMMITTER_EMAIL: actor.email };
      execFileSync("git", ["clone", "--quiet", "--no-hardlinks", gd, tmp], { stdio: ["ignore", "pipe", "pipe"] });
      execFileSync("git", ["-C", tmp, "checkout", "--quiet", pull.base], { stdio: ["ignore", "pipe", "pipe"] });
      const msg = message || `Merge pull request #${n}: ${pull.title}`;
      try {
        execFileSync("git", ["-C", tmp, "merge", "--no-ff", "-m", msg, headSha], { stdio: ["ignore", "pipe", "pipe"], env });
      } catch {
        let conflicted = [];
        try {
          conflicted = execFileSync("git", ["-C", tmp, "diff", "--name-only", "--diff-filter=U"], { encoding: "utf8" }).split("\n").filter(Boolean);
          execFileSync("git", ["-C", tmp, "merge", "--abort"], { stdio: "ignore" });
        } catch { /* clone is discarded anyway */ }
        throw new ForgeError(409, `merge conflicts in: ${conflicted.join(", ") || "(unknown paths)"} — nothing was merged`);
      }
      mergeCommit = execFileSync("git", ["-C", tmp, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      execFileSync("git", ["-C", tmp, "push", "--quiet", "origin", `${pull.base}:${pull.base}`], { stdio: ["ignore", "pipe", "pipe"] });
    } finally {
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* temp clone */ }
    }
  }

  pull.state = "merged";
  pull.mergedAt = new Date().toISOString();
  pull.mergedBy = actor.label;
  pull.mergeCommit = mergeCommit;
  pull.mergeMethod = method;
  pull.updatedAt = pull.mergedAt;
  saveStore(dir, store);
  appendAudit(dir, actor, "pull.merge", `${key(owner, repo)}#${n}`, { method, commit: mergeCommit });

  // Optional delete-on-merge (GitHub parity; default OFF — the kit
  // landings left feat/* branches behind because merge had no way to
  // ask). The merge itself is already final at this point, so a head
  // branch that cannot be deleted (it is the repo's default branch,
  // or it vanished mid-merge) never fails the call: the answer says
  // plainly that the branch was kept, and why.
  let headBranchDeleted = false;
  let headBranchKept = null;
  if (deleteHeadBranch) {
    try {
      deleteBranch(gd, pull.head);
      headBranchDeleted = true;
      appendAudit(dir, actor, "branch.delete", `${key(owner, repo)}:${pull.head}`, { via: `pull #${n} merge (deleteBranch)` });
    } catch (e) {
      headBranchKept = e.message;
    }
  }

  // CI on the merged base — best-effort, exactly like the git-push path.
  let ci = null;
  try {
    const cfg = loadRepoConfig(dir);
    if (cfg[key(owner, repo)]?.command) {
      enqueueCiJob(dir, { owner, repo, ref: `refs/heads/${pull.base}`, sha: mergeCommit });
      ci = "enqueued";
    }
  } catch { ci = null; }
  return { pull: { ...pull, headSha, baseSha: mergeCommit }, mergeCommit, ci, headBranchDeleted, headBranchKept };
}
