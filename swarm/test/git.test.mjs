/**
 * KILN-native git hosting: real git round trip against the daemon's HTTP API.
 * Creates a repo via the API, clones it over smart HTTP, pushes a commit with
 * the Bearer <redacted>, and verifies a fresh clone sees it. Then proves an
 * unauthenticated push is refused (401) and lands nothing, and — since
 * the 2026-10-28 accounts-only rule — anonymous reads (info/refs,
 * upload-pack, clone) of private repos are refused too; account
 * sessions read only their own owner namespace. Since the 2026-10-29
 * visibility order, a repo the owner flips "public" reads like public
 * GitHub for anyone (list, clone/fetch, forge GETs) — covered by the
 * last test in this suite.
 *
 * No mocks: a real `git` client talks to the real `git http-backend` CGI.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeStateDir } from "./helpers.mjs";
import { loadApiToken } from "../lib/state.mjs";
import { startApiServer } from "../lib/httpapi.mjs";
import { validRepoName } from "../lib/git.mjs";
import { createAccount, login } from "../lib/accounts.mjs";

const dir = makeStateDir();
const token = loadApiToken(dir);
let api;
let base;

// Forge reads are principal-gated: clones carry the operator bearer as an
// http.extraHeader for the one invocation (never persisted in .git/config).
const bearerEnv = {
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "http.extraHeader",
  GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
};

// NOTE: async spawn, never spawnSync — the API server under test lives in
// this same event loop, and spawnSync would deadlock it (git waits for the
// server, the server waits for the blocked loop).
function git(cwd, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0", // never hang on a credential prompt
        GIT_CONFIG_NOSYSTEM: "1",
        ...extraEnv,
      },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ status: code, stdout, stderr }));
  });
}

async function gitOk(cwd, args, extraEnv = {}) {
  const r = await git(cwd, args, extraEnv);
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${(r.stderr || "").slice(0, 400)}`);
  return (r.stdout || "").trim();
}

async function apiCall(method, p, { auth = true, body = null } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: {
      ...(auth ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

describe("KILN-native git hosting", () => {
  it("starts the API server on an ephemeral port", async () => {
    process.env.KILN_SWARM_API_PORT = "0";
    try {
      api = await startApiServer(dir, { apiPort: 0 });
    } finally {
      delete process.env.KILN_SWARM_API_PORT;
    }
    base = api.url;
    assert.ok(base.startsWith("http://127.0.0.1:"));
  });

  it("validates repo names (no traversal, lowercase)", () => {
    assert.ok(validRepoName("auro"));
    assert.ok(validRepoName("my-repo-2"));
    assert.ok(!validRepoName("../x"));
    assert.ok(!validRepoName("a/b"));
    assert.ok(!validRepoName("UPPER"));
    assert.ok(!validRepoName(""));
    assert.ok(!validRepoName(".git"));
  });

  it("refuses repo creation without a token", async () => {
    const r = await apiCall("POST", "/git/eve/evil", { auth: false });
    assert.equal(r.status, 401);
  });

  it("creates a repo via the API", async () => {
    const r = await apiCall("POST", "/git/testowner/testrepo");
    assert.equal(r.status, 201);
    assert.equal(r.data.owner, "testowner");
    assert.equal(r.data.repo, "testrepo");
    assert.ok(r.data.cloneUrl.includes("/git/testowner/testrepo"));
  });

  it("rejects duplicate creation", async () => {
    const r = await apiCall("POST", "/git/testowner/testrepo");
    assert.equal(r.status, 409);
  });

  it("rejects bad names", async () => {
    const r = await apiCall("POST", "/git/BAD/name");
    assert.equal(r.status, 400);
  });

  it("repo listing without a token shows only public repos (none yet)", async () => {
    // Since the 2026-10-29 visibility order, GET /git answers
    // anonymously too — filtered to public repos, GitHub-style. Every
    // repo in this suite is private at this point, so the anonymous
    // list is empty; the public cases live in the visibility test at
    // the end of this suite.
    const r = await apiCall("GET", "/git", { auth: false });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.repos, []);
  });

  it("lists repos with the operator token", async () => {
    const r = await apiCall("GET", "/git");
    assert.equal(r.status, 200);
    assert.ok(r.data.repos.some((x) => x.owner === "testowner" && x.repo === "testrepo"));
  });

  it("refuses anonymous reads: info/refs, upload-pack, and clone", async () => {
    const refs = await fetch(`${base}/git/testowner/testrepo/info/refs?service=git-upload-pack`);
    assert.equal(refs.status, 401);
    assert.ok((refs.headers.get("www-authenticate") || "").includes("Basic"));
    await refs.arrayBuffer();
    const up = await fetch(`${base}/git/testowner/testrepo/git-upload-pack`, { method: "POST" });
    assert.equal(up.status, 401);
    await up.arrayBuffer();
    const work = mkdtempSync(join(tmpdir(), "kiln-git-anon-"));
    const r = await git(work, ["clone", "-q", `${base}/git/testowner/testrepo`, "anon"]);
    assert.notEqual(r.status, 0, "anonymous clone must fail");
  });

  it("account sessions read only their own namespace", async () => {
    createAccount(dir, {
      email: "reader@example.com", name: "Reader", owner: "reader1",
      password: "reader-password-1",
    });
    const created = await apiCall("POST", "/git/reader1/owned");
    assert.equal(created.status, 201);
    const { sessionToken } = login(dir, {
      email: "reader@example.com", password: "reader-password-1",
    });
    const sess = { headers: { authorization: `Bearer ${sessionToken}` } };
    const own = await fetch(`${base}/git/reader1/owned/info/refs?service=git-upload-pack`, sess);
    assert.equal(own.status, 200);
    await own.arrayBuffer();
    const other = await fetch(`${base}/git/testowner/testrepo/info/refs?service=git-upload-pack`, sess);
    assert.equal(other.status, 403);
    await other.arrayBuffer();
    const listRes = await fetch(`${base}/git`, sess);
    assert.equal(listRes.status, 200);
    const listData = await listRes.json();
    assert.ok(listData.repos.length > 0);
    assert.ok(listData.repos.every((x) => x.owner === "reader1"));
  });

  it("round trip: clone, push with token, fresh clone sees the commit", async () => {
    const cloneUrl = `${base}/git/testowner/testrepo`;
    const work = mkdtempSync(join(tmpdir(), "kiln-git-"));
    await gitOk(work, ["clone", "-q", cloneUrl, "w1"], bearerEnv);
    const w1 = join(work, "w1");
    writeFileSync(join(w1, "hello.txt"), "hello from KILN\n");
    await gitOk(w1, ["-c", "user.email=t@kiln.local", "-c", "user.name=kiln-test", "add", "hello.txt"]);
    await gitOk(w1, ["-c", "user.email=t@kiln.local", "-c", "user.name=kiln-test", "commit", "-q", "-m", "first commit"]);
    // push with the Bearer <redacted> via git's extraHeader mechanism:
    await gitOk(w1, ["push", "-q", "origin", "main"], {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
    });

    const w2 = join(work, "w2");
    await gitOk(work, ["clone", "-q", cloneUrl, "w2"], bearerEnv);
    const content = readFileSync(join(w2, "hello.txt"), "utf8");
    assert.equal(content, "hello from KILN\n");
    const log = await gitOk(w2, ["log", "--oneline", "-1"]);
    assert.ok(log.includes("first commit"), `unexpected log: ${log}`);
  });

  it("401 carries a WWW-Authenticate challenge (git needs it to retry)", async () => {
    const res = await fetch(`${base}/git/testowner/testrepo/git-receive-pack`, { method: "POST" });
    assert.equal(res.status, 401);
    const www = res.headers.get("www-authenticate") || "";
    assert.ok(
      www.includes("Basic"),
      `401 must advertise a Basic challenge so git retries with URL credentials, got: ${www}`
    );
    await res.arrayBuffer(); // drain
  });

  it("round trip: push via oauth2:<token>@ URL (Basic challenge-response flow)", async () => {
    // Exact repro of the filed ticket: credentials embedded in the URL are NOT
    // sent preemptively by git — it waits for a 401 with WWW-Authenticate,
    // then retries with Basic. Without the challenge header the push died with
    // "unexpected disconnect while reading sideband packet".
    const r = await apiCall("POST", "/git/testowner/urlrepo");
    assert.equal(r.status, 201);
    const authedUrl = base.replace("http://", `http://oauth2:${token}@`) + "/git/testowner/urlrepo";
    const work = mkdtempSync(join(tmpdir(), "kiln-git-url-"));
    await gitOk(work, ["clone", "-q", authedUrl, "w1"]);
    const w1 = join(work, "w1");
    writeFileSync(join(w1, "url.txt"), "pushed via URL credentials\n");
    await gitOk(w1, ["-c", "user.email=u@kiln.local", "-c", "user.name=kiln-test", "add", "url.txt"]);
    await gitOk(w1, ["-c", "user.email=u@kiln.local", "-c", "user.name=kiln-test", "commit", "-q", "-m", "url-auth commit"]);
    await gitOk(w1, ["push", "-q", "origin", "main"]);

    const w2 = join(work, "w2");
    await gitOk(work, ["clone", "-q", authedUrl, "w2"]);
    const content = readFileSync(join(w2, "url.txt"), "utf8");
    assert.equal(content, "pushed via URL credentials\n");
  });

  it("push WITHOUT a token is refused and lands nothing", async () => {
    const cloneUrl = `${base}/git/testowner/testrepo`;
    const work = mkdtempSync(join(tmpdir(), "kiln-git-evil-"));
    await gitOk(work, ["clone", "-q", cloneUrl, "evil"], bearerEnv);
    const e = join(work, "evil");
    writeFileSync(join(e, "evil.txt"), "should never land\n");
    await gitOk(e, ["-c", "user.email=e@kiln.local", "-c", "user.name=eve", "add", "evil.txt"]);
    await gitOk(e, ["-c", "user.email=e@kiln.local", "-c", "user.name=eve", "commit", "-q", "-m", "evil commit"]);
    const r = await git(e, ["push", "origin", "main"]);
    assert.notEqual(r.status, 0, "unauthenticated push must fail");
    // the real security assertion, independent of git's wording: the server
    // itself refuses unauthenticated receive-pack with 401
    const direct = await apiCall("POST", "/git/testowner/testrepo/git-receive-pack", { auth: false });
    assert.equal(direct.status, 401, `expected 401, got ${direct.status}`);

    // and nothing landed: a fresh clone has no evil.txt
    const w3 = join(work, "clean");
    await gitOk(work, ["clone", "-q", cloneUrl, "clean"], bearerEnv);
    const log = await gitOk(w3, ["log", "--oneline"]);
    assert.ok(!log.includes("evil commit"), `evil commit landed! log: ${log}`);
  });

  it("public repos read like GitHub; private repos keep the accounts-only wall", async () => {
    // One repo stays private (the default); one the owner flips public.
    assert.equal((await apiCall("POST", "/git/testowner/privlib")).status, 201);
    assert.equal((await apiCall("POST", "/git/testowner/publib")).status, 201);

    // Seed publib with one commit (operator push) so a clone has content.
    const work = mkdtempSync(join(tmpdir(), "kiln-git-pub-"));
    await gitOk(work, ["clone", "-q", `${base}/git/testowner/publib`, "seed"], bearerEnv);
    const seed = join(work, "seed");
    writeFileSync(join(seed, "PUB.md"), "public hello\n");
    await gitOk(seed, ["-c", "user.email=t@kiln.local", "-c", "user.name=kiln-test", "add", "PUB.md"]);
    await gitOk(seed, ["-c", "user.email=t@kiln.local", "-c", "user.name=kiln-test", "commit", "-q", "-m", "public seed"]);
    await gitOk(seed, ["push", "-q", "origin", "main"], {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
    });

    const detailsCall = async (method, repo, body, bearer) => {
      const res = await fetch(`${base}/v1/repos/testowner/${repo}/details`, {
        method,
        headers: {
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, data: await res.json().catch(() => ({})) };
    };

    // Default visibility is private on both; the flip validates its input.
    assert.equal((await detailsCall("GET", "publib", null, token)).data.visibility, "private");
    assert.equal((await detailsCall("GET", "privlib", null, token)).data.visibility, "private");
    const flip = await detailsCall("PATCH", "publib", { visibility: "public" }, token);
    assert.equal(flip.status, 200);
    assert.equal(flip.data.details.visibility, "public");
    assert.equal((await detailsCall("PATCH", "publib", { visibility: "friends" }, token)).status, 400);

    // Anonymous: the repo list shows public repos only — privlib and
    // the older private repos of this suite stay invisible.
    const anonList = await fetch(`${base}/git`);
    assert.equal(anonList.status, 200);
    const anonRepos = (await anonList.json()).repos;
    assert.ok(anonRepos.some((x) => x.owner === "testowner" && x.repo === "publib"));
    assert.ok(!anonRepos.some((x) => x.repo === "privlib"));
    assert.ok(!anonRepos.some((x) => x.repo === "testrepo"));

    // Anonymous: info/refs and a real clone of the public repo work…
    const pubRefs = await fetch(`${base}/git/testowner/publib/info/refs?service=git-upload-pack`);
    assert.equal(pubRefs.status, 200);
    await pubRefs.arrayBuffer();
    await gitOk(work, ["clone", "-q", `${base}/git/testowner/publib`, "anonclone"]);
    assert.equal(readFileSync(join(work, "anonclone", "PUB.md"), "utf8"), "public hello\n");
    // …while the private repo still refuses anonymous reads with 401.
    const privRefs = await fetch(`${base}/git/testowner/privlib/info/refs?service=git-upload-pack`);
    assert.equal(privRefs.status, 401);
    await privRefs.arrayBuffer();

    // A different account reads the public repo, is walled (403) on
    // the private one, and its list gains the public repo only.
    createAccount(dir, {
      email: "visitor@example.com", name: "Visitor", owner: "visitor1",
      password: "visitor-password-1",
    });
    const { sessionToken: visitorToken } = login(dir, {
      email: "visitor@example.com", password: "visitor-password-1",
    });
    const vsess = { headers: { authorization: `Bearer ${visitorToken}` } };
    const vPub = await fetch(`${base}/git/testowner/publib/info/refs?service=git-upload-pack`, vsess);
    assert.equal(vPub.status, 200);
    await vPub.arrayBuffer();
    const vPriv = await fetch(`${base}/git/testowner/privlib/info/refs?service=git-upload-pack`, vsess);
    assert.equal(vPriv.status, 403);
    await vPriv.arrayBuffer();
    const vList = await (await fetch(`${base}/git`, vsess)).json();
    assert.ok(vList.repos.some((x) => x.owner === "testowner" && x.repo === "publib"));
    assert.ok(!vList.repos.some((x) => x.repo === "privlib"));

    // Writes never open up: anonymous receive-pack stays 401 even on
    // the public repo.
    const anonPush = await fetch(`${base}/git/testowner/publib/git-receive-pack`, { method: "POST" });
    assert.equal(anonPush.status, 401);
    await anonPush.arrayBuffer();

    // The flip takes effect on the very next read.
    assert.equal((await detailsCall("PATCH", "publib", { visibility: "private" }, token)).status, 200);
    const backRefs = await fetch(`${base}/git/testowner/publib/info/refs?service=git-upload-pack`);
    assert.equal(backRefs.status, 401);
    await backRefs.arrayBuffer();
  });

  after(async () => {
    if (api) await new Promise((r) => api.server.close(r));
  });
});
