/**
 * KILN-native git hosting.
 *
 * Bare repos live at <stateDir>/git/<owner>/<repo>.git. The daemon serves
 * the git smart-HTTP protocol by exec'ing the real `git http-backend` as a
 * CGI backend — the git protocol itself is NOT reimplemented here.
 *
 * Auth policy (enforced by the caller, lib/httpapi.mjs):
 *   - repo create, receive-pack (push): operator bearer token required
 *   - repo list, info/refs, upload-pack (clone/fetch) + CI reads: a forge
 *     principal is required (operator token, account session, or agent
 *     token); account principals are owner-scoped to their namespace.
 *     (Changed 2026-10-28 on the architect's rule — only our accounts see
 *     the forge. Reads were public before, which the public tunnel turned
 *     into public-internet read access to every hosted repo.)
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomicSync } from "./state.mjs";

export const GIT_BACKEND = "/usr/lib/git-core/git-http-backend";

const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

/** Owner/repo names: lowercase alnum + hyphens. Rejects traversal outright. */
export function validRepoName(s) {
  return typeof s === "string" && NAME_RE.test(s);
}

export function gitRoot(dir) {
  return join(dir, "git");
}

export function repoPath(dir, owner, repo) {
  if (!validRepoName(owner) || !validRepoName(repo)) {
    throw new Error(`invalid owner/repo name: ${owner}/${repo}`);
  }
  return join(gitRoot(dir), owner, `${repo}.git`);
}

export function repoExists(dir, owner, repo) {
  try {
    return existsSync(repoPath(dir, owner, repo));
  } catch {
    return false;
  }
}

/**
 * Default author of a repo's initial commit when the caller names no
 * other: the operator identity (the same name/email lib/forge.mjs's
 * actorOf stamps for operator writes). The HTTP create route passes the
 * creating principal's actor explicitly; the CLI's local fallback lands
 * here, which is truthful — the CLI is the operator's own tool.
 */
export const DEFAULT_REPO_AUTHOR = { name: "KILN Operator", email: "operator@kiln.local" };
export const INITIAL_COMMIT_MESSAGE = "chore: initialize repository";

export function createRepo(dir, owner, repo, opts = {}) {
  const p = repoPath(dir, owner, repo); // throws on invalid names
  if (existsSync(p)) {
    const e = new Error(`repo exists: ${owner}/${repo}`);
    e.code = "EXISTS";
    throw e;
  }
  mkdirSync(join(gitRoot(dir), owner), { recursive: true });
  execFileSync("git", ["init", "--bare", "--initial-branch=main", p], { stdio: "ignore" });
  // Smart-HTTP pushes are refused by git-http-backend (403) unless
  // http.receivepack is true; KILN enforces its own auth before the
  // backend ever runs, so enabling it here is safe.
  execFileSync("git", ["--git-dir", p, "config", "http.receivepack", "true"], { stdio: "ignore" });
  writeFileAtomicSync(
    join(p, "kiln.json"),
    JSON.stringify({ schema: "kiln.git-repo.v1", owner, repo, createdAt: new Date().toISOString() }) + "\n"
  );
  // Born PR-ready: main starts at an initial commit (empty tree),
  // authored by the creating principal, so branch → PR → merge works
  // from minute one with no client-side seeding. Before this, a new
  // repo had an unborn main and createPull 404'd until the client
  // hand-pushed a seed commit. Plumbing only — no worktree.
  const author = opts.author && opts.author.name && opts.author.email
    ? opts.author
    : DEFAULT_REPO_AUTHOR;
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email,
  };
  const tree = execFileSync("git", ["--git-dir", p, "mktree"], { input: "", encoding: "utf8" }).trim();
  const initialCommit = execFileSync(
    "git",
    ["--git-dir", p, "commit-tree", tree, "-m", opts.message || INITIAL_COMMIT_MESSAGE],
    { env, encoding: "utf8" }
  ).trim();
  execFileSync("git", ["--git-dir", p, "update-ref", "refs/heads/main", initialCommit], { stdio: "ignore" });
  return { owner, repo, path: p, initialCommit };
}

/**
 * Delete a repo outright: the bare git dir (which also carries the
 * repo's kiln.json details and its refs/kiln/memory chain) is removed,
 * so the repo vanishes from listRepos and every existence check at
 * once. Registry state that lives OUTSIDE the bare dir is the caller's
 * cleanup: forge records (lib/forge.mjs forgetRepo) and CI results
 * (lib/ci.mjs forgetRepoCiResults). Workspace/site registries keep
 * their member refs by the codebase's own pattern — their status views
 * already render a missing repo as exists:false, and membership is the
 * workspace owner's explicit edit, never a side effect.
 * Throws an Error with .code "NOT_FOUND" when the repo does not exist.
 */
export function deleteRepo(dir, owner, repo) {
  const p = repoPath(dir, owner, repo); // throws on invalid names
  if (!existsSync(p)) {
    const e = new Error(`no such repo: ${owner}/${repo}`);
    e.code = "NOT_FOUND";
    throw e;
  }
  rmSync(p, { recursive: true, force: true });
  return { owner, repo };
}

export function listRepos(dir) {
  const root = gitRoot(dir);
  const out = [];
  if (!existsSync(root)) return out;
  for (const owner of readdirSync(root)) {
    const od = join(root, owner);
    let st;
    try { st = statSync(od); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const e of readdirSync(od)) {
      if (!e.endsWith(".git")) continue;
      const p = join(od, e);
      try { if (!statSync(p).isDirectory()) continue; } catch { continue; }
      let createdAt = null;
      try {
        createdAt = JSON.parse(readFileSync(join(p, "kiln.json"), "utf8")).createdAt || null;
      } catch { /* older repo, no metadata */ }
      out.push({ owner, repo: e.slice(0, -4), createdAt });
    }
  }
  out.sort((a, b) => `${a.owner}/${a.repo}`.localeCompare(`${b.owner}/${b.repo}`));
  return out;
}

function headerEnd(buf) {
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i + 4;
  }
  for (let i = 0; i + 1 < buf.length; i++) {
    if (buf[i] === 10 && buf[i + 1] === 10) return i + 2;
  }
  return -1;
}

/**
 * Serve one git smart-HTTP request by exec'ing git-http-backend as CGI.
 * `req.url` must be /git/<owner>/<repo>/(info/refs|git-upload-pack|git-receive-pack).
 * Resolves when the backend exits. Auth (for receive-pack) is the caller's job.
 */
export function serveGitHttp(dir, req, res) {
  return new Promise((resolve) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const m = url.pathname.match(/^\/git\/([a-z0-9-]+)\/([a-z0-9-]+)(\/.*)$/);
    if (!m) { res.writeHead(404); res.end("not found"); resolve(); return; }
    const [, owner, repo, rest] = m;
    let bare;
    try {
      bare = repoPath(dir, owner, repo);
    } catch {
      res.writeHead(404); res.end("no such repo"); resolve(); return;
    }
    if (!existsSync(bare)) { res.writeHead(404); res.end("no such repo"); resolve(); return; }

    const env = {
      GIT_PROJECT_ROOT: gitRoot(dir),
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: `/${owner}/${repo}.git${rest}`,
      REQUEST_METHOD: req.method,
      QUERY_STRING: url.searchParams.toString(),
      CONTENT_TYPE: req.headers["content-type"] || "",
      REMOTE_ADDR: "127.0.0.1",
      GIT_PROTOCOL: req.headers["git-protocol"] || "",
    };
    if (req.headers["content-length"]) env.CONTENT_LENGTH = req.headers["content-length"];
    // Minimal PATH so the backend can find its helpers; nothing else inherited.
    env.PATH = "/usr/lib/git-core:/usr/bin:/bin";

    let child;
    try {
      child = spawn(GIT_BACKEND, [], { env, stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      res.writeHead(500); res.end("git backend unavailable"); resolve(); return;
    }

    let headerBuf = Buffer.alloc(0);
    let headersSent = false;
    const fail = () => {
      if (!headersSent) { res.writeHead(502); res.end("git backend failed"); }
      else { try { res.end(); } catch {} }
      resolve();
    };
    child.on("error", fail);
    req.on("error", () => { try { child.kill("SIGKILL"); } catch {} });
    req.pipe(child.stdin);
    child.stdout.on("data", (chunk) => {
      if (headersSent) {
        res.write(chunk);
        return;
      }
      headerBuf = Buffer.concat([headerBuf, chunk]);
      if (headerBuf.length > 65536) { try { child.kill("SIGKILL"); } catch {} fail(); return; }
      const end = headerEnd(headerBuf);
      if (end < 0) return; // wait for the full CGI header block
      const raw = headerBuf.subarray(0, end).toString("latin1");
      const bodyStart = headerBuf.subarray(end);
      let status = 200;
      const headers = {};
      for (const line of raw.split(/\r?\n/)) {
        const ci = line.indexOf(":");
        if (ci < 0) continue;
        const k = line.slice(0, ci).trim().toLowerCase();
        const v = line.slice(ci + 1).trim();
        if (k === "status") {
          const sm = v.match(/^(\d{3})/);
          if (sm) status = parseInt(sm[1], 10);
        } else if (k) {
          headers[k] = v;
        }
      }
      try {
        res.writeHead(status, headers);
        if (bodyStart.length) res.write(bodyStart);
      } catch { try { child.kill("SIGKILL"); } catch {} fail(); return; }
      headersSent = true;
    });
    child.on("close", () => {
      try { res.end(); } catch {}
      resolve();
    });
  });
}
