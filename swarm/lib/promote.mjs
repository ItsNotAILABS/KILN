/**
 * KILN-native GitHub promotion — the publishing step, owned by KILN itself.
 *
 * A KILN repo (bare, at <stateDir>/git/<owner>/<repo>.git) is promoted to a
 * GitHub repo by REBUILDING its history through the GitHub Git Data API:
 * identical trees, messages, authors, and author dates (the committer
 * becomes the token identity, so GitHub SHAs differ from KILN SHAs — same
 * content). This mirrors tools/kiln_promote.py in auro/aurolounge, ported
 * to run inside the swarm instead of from a chat session.
 *
 * Why the API and not `git push`: from this environment only
 * api.github.com authenticates; native git-over-HTTPS to github.com does
 * not. The rebuild is also what makes --rebase possible: history is
 * replayed commit-by-commit onto the GitHub tip.
 *
 * Destination (never invented): explicit options > the repo's
 * tools/promote.conf (read from the promoted branch's tip) > error.
 *
 * Safety:
 *   - fast-forward only by default; --rebase replays onto a GitHub
 *     "Initial commit" (preserves a README added on github.com);
 *     --force rebuilds from scratch and force-updates the ref.
 *   - bare repos have no working tree, so there is no dirty-tree state
 *     to refuse on — the promoted history is exactly what's in the repo.
 *
 * Credential: the GitHub token is KILN's own, read from (first hit wins)
 *   1. env KILN_GITHUB_TOKEN
 *   2. <stateDir>/github.token   (keep it 0600)
 *   3. ~/.link-token             (legacy location)
 * (The chat-side helpers use the vault-backed `custom.github` surrogate,
 * which only exists inside the agent harness — a daemon can't call it,
 * which is exactly why KILN needs its own token file.) The token value is
 * never logged and never appears in receipts.
 *
 * promoteRepo() never throws for expected failures — it returns a receipt:
 *   { ok, repo, github, branch, sourceBranch, sourceTip,
 *     commitsTotal, commitsPlanned, commits: [{from,to,subject,blobs}],
 *     rebased, forced, remoteTipBefore, newTip, url,
 *     credential: {source} | null, warnings: [], error: {stage,message,status?} | null }
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { repoPath, repoExists } from "./git.mjs";

const execFileP = promisify(execFile);
const API = "https://api.github.com";
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_BUFFER = 64 * 1024 * 1024;

export class PromoteError extends Error {
  constructor(stage, message, status) {
    super(message);
    this.name = "PromoteError";
    this.stage = stage;
    if (status !== undefined) this.status = status;
  }
}

// ---------------------------------------------------------------- credential

/**
 * Resolve KILN's GitHub token. Returns { token, source, loosePerms } or
 * null when no credential is configured anywhere.
 */
export function loadGithubToken(dir) {
  if (process.env.KILN_GITHUB_TOKEN) {
    return { token: process.env.KILN_GITHUB_TOKEN.trim(), source: "env:KILN_GITHUB_TOKEN", loosePerms: false };
  }
  const candidates = [
    { path: join(dir, "github.token"), source: "file:github.token" },
    { path: join(homedir(), ".link-token"), source: "file:~/.link-token" },
  ];
  for (const c of candidates) {
    if (!existsSync(c.path)) continue;
    const token = readFileSync(c.path, "utf8").trim();
    if (!token) continue;
    let loosePerms = false;
    try { loosePerms = (statSync(c.path).mode & 0o077) !== 0; } catch { /* best effort */ }
    return { token, source: c.source, loosePerms };
  }
  return null;
}

// ---------------------------------------------------------------- conf

/** Parse tools/promote.conf (key=value lines, # comments). */
export function parsePromoteConf(text) {
  const conf = {};
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    conf[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return conf;
}

const GH_OWNER_RE = /^[A-Za-z0-9]([A-Za-z0-9-]{0,38}[A-Za-z0-9])?$/;
const GH_REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

// ---------------------------------------------------------------- git plumbing

async function git(bare, args, opts = {}) {
  const { stdout } = await execFileP("git", ["--git-dir", bare, ...args], {
    maxBuffer: MAX_BUFFER,
    ...(opts.buffer ? { encoding: "buffer" } : {}),
  });
  return stdout;
}

async function gitText(bare, args) {
  return (await git(bare, args)).toString().trim();
}

/** Exit-code-returning ancestor check (git exits 1 = not ancestor, 128 = unknown object). */
async function isAncestor(bare, maybeAncestor, descendant) {
  try {
    await execFileP("git", ["--git-dir", bare, "merge-base", "--is-ancestor", maybeAncestor, descendant]);
    return true;
  } catch {
    return false; // any nonzero: not an ancestor we can build on (Python parity: rc != 0)
  }
}

/**
 * The branch to promote: the bare repo's HEAD branch when it has commits,
 * else the repo's only branch. Null when ambiguous/empty.
 */
export async function resolveSourceBranch(bare) {
  let headBranch = null;
  try {
    const ref = await gitText(bare, ["symbolic-ref", "HEAD"]); // refs/heads/<name>
    if (ref.startsWith("refs/heads/")) headBranch = ref.slice("refs/heads/".length);
  } catch { /* no HEAD symref */ }
  const refs = (await gitText(bare, ["for-each-ref", "--format=%(refname)", "refs/heads"]))
    .split("\n").filter(Boolean).map((r) => r.replace("refs/heads/", ""));
  if (headBranch && refs.includes(headBranch)) return headBranch;
  if (refs.length === 1) return refs[0];
  return null;
}

/**
 * Local per-commit diff entries vs its parent (or the empty tree for a
 * root commit), WITHOUT uploading anything: [{ path, mode, type, localSha }]
 * where type is "blob" | "commit" (submodule gitlink) and localSha is null
 * for deletions. Pure git plumbing — unit-testable without GitHub.
 */
export async function diffEntries(bare, parentRef, sha) {
  const buf = await git(bare, ["diff-tree", "--no-commit-id", "-r", "--raw", "-z", parentRef, sha], { buffer: true });
  const tokens = buf.toString("utf8").split("\0").filter((t) => t.length > 0);
  const entries = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const meta = tokens[i].replace(/^:/, "").split(/\s+/);
    const path = tokens[i + 1];
    const [oldMode, newMode, , newSha, status] = meta;
    if (status.startsWith("D")) {
      entries.push({ path, mode: oldMode, type: "blob", localSha: null });
    } else if (newMode === "160000") {
      // Submodule gitlink: a tree entry of type "commit", no blob upload.
      entries.push({ path, mode: newMode, type: "commit", localSha: newSha });
    } else if (status.startsWith("A") || status.startsWith("M") || status.startsWith("T")) {
      entries.push({ path, mode: newMode, type: "blob", localSha: newSha });
    } else {
      throw new PromoteError("git", `unexpected diff status ${status} for ${path} in ${sha.slice(0, 12)}`);
    }
  }
  return entries;
}

// ---------------------------------------------------------------- github api

async function ghApi(token, method, path, payload) {
  let res;
  try {
    res = await fetch(API + path, {
      method,
      headers: {
        "authorization": `Bearer ${token}`,
        "accept": "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(payload !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: payload !== undefined ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(60000),
    });
  } catch (e) {
    throw new PromoteError("github_network", `GitHub API ${method} ${path} unreachable: ${e.message}`);
  }
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text.slice(0, 300) }; }
  if (res.status === 404 && method === "GET") return { status: 404, body };
  if (res.status >= 400) {
    const stage = method === "GET" ? "github_read" : "github_write";
    const detail = body && body.message ? body.message : text.slice(0, 300);
    throw new PromoteError(stage, `GitHub API ${method} ${path} -> ${res.status}: ${detail}`, res.status);
  }
  return { status: res.status, body };
}

// ---------------------------------------------------------------- promote

/**
 * Promote KILN repo <owner>/<repo> (in state dir `dir`) to GitHub.
 * opts: { githubOwner, githubRepo, branch, rebase, force }.
 * Always resolves with a receipt; never rejects for expected failures.
 */
export async function promoteRepo(dir, owner, repo, opts = {}) {
  const receipt = {
    ok: false,
    repo: `${owner}/${repo}`,
    github: null,
    branch: null,
    sourceBranch: null,
    sourceTip: null,
    commitsTotal: 0,
    commitsPlanned: 0,
    commits: [],
    rebased: false,
    forced: !!opts.force,
    remoteTipBefore: null,
    newTip: null,
    url: null,
    credential: null,
    warnings: [],
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  try {
    await promoteInner(dir, owner, repo, opts, receipt);
    receipt.ok = true;
  } catch (e) {
    if (e instanceof PromoteError) {
      receipt.error = { stage: e.stage, message: e.message };
      if (e.status !== undefined) receipt.error.status = e.status;
    } else {
      receipt.error = { stage: "internal", message: String((e && e.message) || e) };
    }
  }
  receipt.finishedAt = new Date().toISOString();
  return receipt;
}

async function promoteInner(dir, owner, repo, opts, receipt) {
  if (!repoExists(dir, owner, repo)) {
    throw new PromoteError("repo_not_found", `no such KILN repo: ${owner}/${repo}`);
  }
  const bare = repoPath(dir, owner, repo);

  // ---- source: branch + tip + full history (oldest first) ----
  const srcBranch = await resolveSourceBranch(bare);
  if (!srcBranch) {
    throw new PromoteError("no_source_branch", `repo ${owner}/${repo} has no promotable branch (empty or ambiguous HEAD)`);
  }
  receipt.sourceBranch = srcBranch;
  const head = await gitText(bare, ["rev-parse", `refs/heads/${srcBranch}`]);
  receipt.sourceTip = head;
  const allCommits = (await gitText(bare, ["rev-list", "--reverse", head])).split("\n").filter(Boolean);
  receipt.commitsTotal = allCommits.length;

  // ---- destination: flags/body > tools/promote.conf at the branch tip ----
  let conf = {};
  try { conf = parsePromoteConf(await git(bare, ["show", `${head}:tools/promote.conf`])); } catch { /* no conf in repo */ }
  const ghOwner = opts.githubOwner || conf.owner || "";
  const ghRepo = opts.githubRepo || conf.repo || "";
  const branch = opts.branch || conf.branch || "main";
  if (!ghOwner || !ghRepo) {
    throw new PromoteError("no_target",
      "no GitHub destination: pass github owner/repo or add tools/promote.conf (owner=/repo=) to the repo");
  }
  if (!GH_OWNER_RE.test(ghOwner) || !GH_REPO_RE.test(ghRepo)) {
    throw new PromoteError("bad_target", `invalid GitHub destination: ${ghOwner}/${ghRepo}`);
  }
  receipt.github = `${ghOwner}/${ghRepo}`;
  receipt.branch = branch;
  receipt.url = `https://github.com/${ghOwner}/${ghRepo}/tree/${branch}`;
  // Plan (pre-remote-check): everything, unless the remote turns out to be
  // an ancestor — selection is finalized after the remote checks below.
  receipt.commitsPlanned = allCommits.length;

  // ---- credential ----
  const cred = loadGithubToken(dir);
  if (!cred) {
    throw new PromoteError("no_github_credential",
      `no GitHub credential configured for KILN: create ${join(dir, "github.token")} (mode 0600) ` +
      "containing a GitHub token with Contents:write on the destination, or set KILN_GITHUB_TOKEN");
  }
  receipt.credential = { source: cred.source };
  if (cred.loosePerms) receipt.warnings.push(`credential file permissions are looser than 0600 (${cred.source}) — tighten them`);
  const token = cred.token;

  // ---- remote state ----
  const repoInfo = await ghApi(token, "GET", `/repos/${ghOwner}/${ghRepo}`);
  if (repoInfo.status === 404) {
    throw new PromoteError("github_repo_not_found",
      `GitHub repo ${ghOwner}/${ghRepo} does not exist (create it first — KILN never creates repos)`, 404);
  }
  let remoteSha = null;
  const refRes = await ghApi(token, "GET", `/repos/${ghOwner}/${ghRepo}/git/ref/heads/${branch}`);
  if (refRes.status !== 404) remoteSha = refRes.body.object.sha;
  receipt.remoteTipBefore = remoteSha;

  let remoteTree = null;
  let commits = allCommits;
  if (remoteSha && !opts.force) {
    const ancestor = await isAncestor(bare, remoteSha, head);
    if (!ancestor && !opts.rebase) {
      throw new PromoteError("not_fast_forward",
        `remote ${branch} (${remoteSha.slice(0, 7)}) is not an ancestor of KILN ${srcBranch} (${head.slice(0, 7)}); ` +
        "refusing non-fast-forward promotion (rebase replays onto a GitHub initial commit; force rebuilds from scratch)");
    }
    const tipCommit = await ghApi(token, "GET", `/repos/${ghOwner}/${ghRepo}/git/commits/${remoteSha}`);
    if (opts.rebase && !ancestor) {
      if ((tipCommit.body.parents || []).length > 0) {
        throw new PromoteError("rebase_needs_root",
          "rebase expects the remote tip to be a root commit (e.g. GitHub's 'Initial commit'); reconcile manually instead");
      }
      receipt.rebased = true;
    }
    remoteTree = tipCommit.body.tree.sha;
    if (ancestor) {
      // Incremental: only the commits the remote doesn't have yet.
      commits = (await gitText(bare, ["rev-list", "--reverse", `${remoteSha}..${head}`])).split("\n").filter(Boolean);
    }
  }
  receipt.commitsPlanned = commits.length;
  if (!commits.length) {
    receipt.error = null;
    receipt.note = "already up to date";
    return;
  }

  // ---- rebuild history on GitHub ----
  let newRemoteSha = opts.force ? null : remoteSha;
  let newRemoteTree = opts.force ? null : remoteTree;
  for (const sha of commits) {
    const parentsLine = await gitText(bare, ["rev-list", "--parents", "-1", sha]);
    const parents = parentsLine.split(/\s+/).filter(Boolean);
    const isRoot = parents.length === 1;
    const parentRef = isRoot ? EMPTY_TREE : parents[1];

    const local = await diffEntries(bare, parentRef, sha);
    const treeEntries = [];
    let blobCount = 0;
    for (const e of local) {
      if (e.localSha === null) {
        treeEntries.push({ path: e.path, mode: e.mode, type: "blob", sha: null });
      } else if (e.type === "commit") {
        treeEntries.push({ path: e.path, mode: e.mode, type: "commit", sha: e.localSha });
      } else {
        const content = await git(bare, ["cat-file", "blob", e.localSha], { buffer: true });
        const blob = await ghApi(token, "POST", `/repos/${ghOwner}/${ghRepo}/git/blobs`, {
          content: Buffer.from(content).toString("base64"),
          encoding: "base64",
        });
        treeEntries.push({ path: e.path, mode: e.mode, type: "blob", sha: blob.body.sha });
        blobCount++;
      }
    }
    const treePayload = { tree: treeEntries };
    if (newRemoteTree) treePayload.base_tree = newRemoteTree;
    const tree = await ghApi(token, "POST", `/repos/${ghOwner}/${ghRepo}/git/trees`, treePayload);

    const authorLine = await gitText(bare, ["log", "-1", "--format=%an%x1f%ae%x1f%aI", sha]);
    const [aName, aEmail, aDate] = authorLine.split("\x1f");
    const message = (await git(bare, ["log", "-1", "--format=%B", sha])).toString().trimEnd();
    const subject = (await gitText(bare, ["log", "-1", "--format=%s", sha])).slice(0, 80);
    const commit = await ghApi(token, "POST", `/repos/${ghOwner}/${ghRepo}/git/commits`, {
      message,
      author: { name: aName, email: aEmail, date: aDate },
      tree: tree.body.sha,
      parents: newRemoteSha ? [newRemoteSha] : [],
    });
    newRemoteSha = commit.body.sha;
    newRemoteTree = tree.body.sha;
    receipt.commits.push({ from: sha, to: newRemoteSha, subject, blobs: blobCount });
  }

  // ---- move the ref ----
  if (remoteSha) {
    await ghApi(token, "PATCH", `/repos/${ghOwner}/${ghRepo}/git/refs/heads/${branch}`, {
      sha: newRemoteSha, force: !!opts.force,
    });
  } else {
    await ghApi(token, "POST", `/repos/${ghOwner}/${ghRepo}/git/refs`, {
      ref: `refs/heads/${branch}`, sha: newRemoteSha,
    });
  }
  receipt.newTip = newRemoteSha;
}
