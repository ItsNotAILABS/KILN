/**
 * KILN-native git hosting.
 *
 * Bare repos live at <stateDir>/git/<owner>/<repo>.git. The daemon serves
 * the git smart-HTTP protocol by exec'ing the real `git http-backend` as a
 * CGI backend — the git protocol itself is NOT reimplemented here.
 *
 * Auth policy (enforced by the caller, lib/httpapi.mjs):
 *   - repo create, receive-pack (push): bearer token required
 *   - repo list, info/refs, upload-pack (clone/fetch): public
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

export function createRepo(dir, owner, repo) {
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
  writeFileSync(
    join(p, "kiln.json"),
    JSON.stringify({ schema: "kiln.git-repo.v1", owner, repo, createdAt: new Date().toISOString() }) + "\n"
  );
  return { owner, repo, path: p };
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
