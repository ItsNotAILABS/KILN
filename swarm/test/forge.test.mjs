/**
 * KILN Forge — the GitHub-shaped surface: contents-as-commits, branches,
 * compare, pull requests (comment/review/merge), releases, packages —
 * against a REAL HTTP API on an ephemeral port and REAL git repos.
 * The negative cases are the point: anonymous 401s, owner walls, the
 * forge-scope requirement, sha-mismatch 409s, immutable packages.
 * Mirrors test/accounts.test.mjs's harness.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeStateDir } from "./helpers.mjs";
import { startApiServer } from "../lib/httpapi.mjs";
import { loadApiToken } from "../lib/state.mjs";
import { createAccount, login } from "../lib/accounts.mjs";
import { repoPath } from "../lib/git.mjs";

describe("forge: HTTP API", () => {
  let api;
  after(() => { try { api?.server?.close(); } catch { /* already closed */ } });

  it("runs the full forge flow with auth walls enforced", async () => {
    const dir = makeStateDir();
    process.env.KILN_SWARM_API_PORT = "0";
    try {
      api = await startApiServer(dir, { apiPort: 0 });
    } finally {
      delete process.env.KILN_SWARM_API_PORT;
    }
    const base = api.url;
    const op = loadApiToken(dir);
    const call = async (method, path, body, bearer, raw = false) => {
      const res = await fetch(base + path, {
        method,
        headers: {
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          ...(body !== undefined && !raw ? { "content-type": "application/json" } : {}),
        },
        body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { /* raw response */ }
      return { status: res.status, text, data };
    };

    // ---- anonymous: everything forge is 401
    assert.equal((await call("GET", "/v1/repos/auro/f/pulls")).status, 401);
    assert.equal((await call("GET", "/v1/packages")).status, 401);
    assert.equal((await call("PUT", "/v1/repos/auro/f/contents", { path: "x", content: "y", message: "z" })).status, 401);
    assert.equal((await call("PUT", "/v1/packages/auro/p/1.0.0/a.txt", "bytes", undefined, true)).status, 401);

    // ---- repo + contents-as-commits (operator)
    assert.equal((await call("POST", "/git/auro/f", undefined, op)).status, 201);
    const w1 = await call("PUT", "/v1/repos/auro/f/contents", { path: "README.md", content: "# Forge Test\n", message: "add readme" }, op);
    assert.equal(w1.status, 201, w1.text);
    assert.match(w1.data.commit, /^[0-9a-f]{40}$/);
    const rc = await call("GET", "/v1/repos/auro/f/contents?path=README.md", undefined, op);
    assert.equal(rc.status, 200);
    assert.equal(Buffer.from(rc.data.content, "base64").toString("utf8"), "# Forge Test\n");
    const raw = await call("GET", "/v1/repos/auro/f/contents?path=README.md&raw=1", undefined, op);
    assert.equal(raw.text, "# Forge Test\n");

    // update without sha -> 409; with the right sha -> new commit
    assert.equal((await call("PUT", "/v1/repos/auro/f/contents", { path: "README.md", content: "v2\n", message: "edit" }, op)).status, 409);
    const w2 = await call("PUT", "/v1/repos/auro/f/contents", { path: "README.md", content: "# Forge Test v2\n", message: "edit readme", sha: rc.data.sha }, op);
    assert.equal(w2.status, 201, w2.text);
    assert.notEqual(w2.data.commit, w1.data.commit);
    const commits = await call("GET", "/v1/repos/auro/f/commits", undefined, op);
    assert.equal(commits.data.commits.length, 3); // initial commit + the two writes
    assert.equal(commits.data.commits[0].subject, "edit readme");
    const one = await call("GET", `/v1/repos/auro/f/commits/${w1.data.commit}`, undefined, op);
    assert.equal(one.data.files[0].path, "README.md");

    // ---- branch + PR flow
    const br = await call("POST", "/v1/repos/auro/f/branches", { name: "feature" }, op);
    assert.equal(br.status, 201, br.text);
    const w3 = await call("PUT", "/v1/repos/auro/f/contents", { path: "src/app.js", content: "export const x = 1;\n", message: "add app", branch: "feature" }, op);
    assert.equal(w3.status, 201, w3.text);
    const cmp = await call("GET", "/v1/repos/auro/f/compare?base=main&head=feature", undefined, op);
    assert.equal(cmp.data.ahead, 1);
    assert.equal(cmp.data.files[0].path, "src/app.js");
    assert.match(cmp.data.patch, /export const x/);

    const pr = await call("POST", "/v1/repos/auro/f/pulls", { title: "Add app", body: "first PR", head: "feature", base: "main" }, op);
    assert.equal(pr.status, 201, pr.text);
    assert.equal(pr.data.pull.number, 1);
    assert.equal(pr.data.pull.mergeable, true);
    const cmt = await call("POST", "/v1/repos/auro/f/pulls/1/comments", { body: "looks good" }, op);
    assert.equal(cmt.status, 201);
    const rev = await call("POST", "/v1/repos/auro/f/pulls/1/reviews", { state: "approved" }, op);
    assert.equal(rev.status, 201);
    const merged = await call("POST", "/v1/repos/auro/f/pulls/1/merge", { method: "merge" }, op);
    assert.equal(merged.status, 200, merged.text);
    assert.equal(merged.data.pull.state, "merged");
    const after = await call("GET", "/v1/repos/auro/f/contents?path=src/app.js", undefined, op);
    assert.equal(after.status, 200); // merged content is on main now
    assert.equal((await call("POST", "/v1/repos/auro/f/pulls/1/merge", {}, op)).status, 409); // merged is final

    // ---- conflicting PR refuses, changes nothing
    await call("POST", "/v1/repos/auro/f/branches", { name: "left" }, op);
    await call("POST", "/v1/repos/auro/f/branches", { name: "right" }, op);
    const cur = await call("GET", "/v1/repos/auro/f/contents?path=README.md&ref=left", undefined, op);
    await call("PUT", "/v1/repos/auro/f/contents", { path: "README.md", content: "left\n", message: "left edit", branch: "left", sha: cur.data.sha }, op);
    await call("PUT", "/v1/repos/auro/f/contents", { path: "README.md", content: "right\n", message: "right edit", branch: "right", sha: cur.data.sha }, op);
    const prL = await call("POST", "/v1/repos/auro/f/pulls", { title: "Left", head: "left", base: "main" }, op);
    const prR = await call("POST", "/v1/repos/auro/f/pulls", { title: "Right", head: "right", base: "main" }, op);
    assert.equal((await call("POST", `/v1/repos/auro/f/pulls/${prL.data.pull.number}/merge`, {}, op)).status, 200);
    const conflict = await call("POST", `/v1/repos/auro/f/pulls/${prR.data.pull.number}/merge`, {}, op);
    assert.equal(conflict.status, 409, conflict.text);
    assert.match(conflict.data.error, /conflict/);
    const stillOpen = await call("GET", `/v1/repos/auro/f/pulls/${prR.data.pull.number}`, undefined, op);
    assert.equal(stillOpen.data.pull.state, "open");

    // ---- fast-forward merge + impossible ff
    await call("POST", "/v1/repos/auro/f/branches", { name: "ff" }, op);
    await call("PUT", "/v1/repos/auro/f/contents", { path: "ff.txt", content: "ff\n", message: "ff file", branch: "ff" }, op);
    const prF = await call("POST", "/v1/repos/auro/f/pulls", { title: "FF", head: "ff", base: "main" }, op);
    const ffm = await call("POST", `/v1/repos/auro/f/pulls/${prF.data.pull.number}/merge`, { method: "fast-forward" }, op);
    assert.equal(ffm.status, 200, ffm.text);
    assert.equal(ffm.data.mergeCommit, ffm.data.pull.headSha);

    // ---- releases: tag + notes record
    const rel = await call("POST", "/v1/repos/auro/f/releases", { tag: "v1.0.0", name: "First", notes: "## Notes\n- shipped\n" }, op);
    assert.equal(rel.status, 201, rel.text);
    assert.match(rel.data.release.sha, /^[0-9a-f]{40}$/);
    const tags = await call("GET", "/v1/repos/auro/f/tags", undefined, op);
    assert.ok(tags.data.tags.some((t) => t.name === "v1.0.0" && t.annotated));
    const rels = await call("GET", "/v1/repos/auro/f/releases", undefined, op);
    assert.equal(rels.data.releases[0].notes, "## Notes\n- shipped\n");
    const relPatch = await call("PATCH", "/v1/repos/auro/f/releases/v1.0.0", { notes: "updated notes" }, op);
    assert.equal(relPatch.data.release.notes, "updated notes");
    assert.equal((await call("POST", "/v1/repos/auro/f/releases", { tag: "v1.0.0" }, op)).status, 409);

    // ---- packages: publish / resolve / download / immutability
    const pub = await call("PUT", "/v1/packages/auro/demo/1.0.0/demo.txt", "hello package\n", op, true);
    assert.equal(pub.status, 201, pub.text);
    assert.equal(pub.data.file.size, 14);
    const again = await call("PUT", "/v1/packages/auro/demo/1.0.0/demo.txt", "hello package\n", op, true);
    assert.equal(again.status, 200); // idempotent, same bytes
    assert.equal(again.data.idempotent, true);
    assert.equal((await call("PUT", "/v1/packages/auro/demo/1.0.0/demo.txt", "tampered\n", op, true)).status, 409);
    const meta = await call("GET", "/v1/packages/auro/demo", undefined, op);
    assert.equal(meta.data.package.latest, "1.0.0");
    const dl = await call("GET", "/v1/packages/auro/demo/1.0.0/demo.txt", undefined, op);
    assert.equal(dl.text, "hello package\n");

    // ---- account + agent scoping
    const su = await call("POST", "/v1/accounts", { email: "alice@x.io", name: "Alice", owner: "alice", password: "alice-password-1" });
    assert.equal(su.status, 201, su.text);
    const login = await call("POST", "/v1/accounts/login", { email: "alice@x.io", password: "alice-password-1" });
    const sess = login.data.sessionToken;
    assert.ok(sess);
    assert.equal((await call("POST", "/git/alice/repo1", undefined, op)).status, 201); // operator seeds her repo
    const ag = await call("POST", "/v1/accounts/me/agents", { name: "alice-bot", scopes: ["forge"] }, sess);
    assert.equal(ag.status, 201, ag.text);
    const agTok = ag.data.token;
    const ag2 = await call("POST", "/v1/accounts/me/agents", { name: "alice-reader", scopes: ["workspaces"] }, sess);
    const ag2Tok = ag2.data.token;

    // agent with the forge scope writes in its own namespace…
    const aw = await call("PUT", "/v1/repos/alice/repo1/contents", { path: "NOTE.md", content: "from alice-bot\n", message: "agent deposit" }, agTok);
    assert.equal(aw.status, 201, aw.text);
    const ac = await call("GET", "/v1/repos/alice/repo1/commits", undefined, agTok);
    assert.equal(ac.data.commits[0].author.name, "alice-bot");
    // …but not in anyone else's
    assert.equal((await call("PUT", "/v1/repos/auro/f/contents", { path: "evil.txt", content: "x", message: "x" }, agTok)).status, 403);
    assert.equal((await call("GET", "/v1/repos/auro/f/pulls", undefined, agTok)).status, 403);
    // …and an agent without the forge scope is refused even at home
    assert.equal((await call("PUT", "/v1/repos/alice/repo1/contents", { path: "no.txt", content: "x", message: "x" }, ag2Tok)).status, 403);
    // packages: alice's agent publishes under alice only
    assert.equal((await call("PUT", "/v1/packages/alice/demo/0.1.0/a.bin", "aa", agTok, true)).status, 201);
    assert.equal((await call("PUT", "/v1/packages/auro/demo/0.1.0/a.bin", "aa", agTok, true)).status, 403);

    // ---- changes_requested blocks a non-operator merge; approval unblocks
    await call("POST", "/v1/repos/alice/repo1/branches", { name: "work" }, agTok);
    await call("PUT", "/v1/repos/alice/repo1/contents", { path: "work.txt", content: "w\n", message: "work", branch: "work" }, agTok);
    const apr = await call("POST", "/v1/repos/alice/repo1/pulls", { title: "Work", head: "work", base: "main" }, agTok);
    assert.equal(apr.status, 201, apr.text);
    const an = apr.data.pull.number;
    await call("POST", `/v1/repos/alice/repo1/pulls/${an}/reviews`, { state: "changes_requested", body: "not yet" }, sess);
    assert.equal((await call("POST", `/v1/repos/alice/repo1/pulls/${an}/merge`, {}, agTok)).status, 409);
    await call("POST", `/v1/repos/alice/repo1/pulls/${an}/reviews`, { state: "approved" }, sess);
    // the session's latest review is approved, but the changes_requested came
    // from the same author label — latest-per-reviewer wins, so it unblocks:
    const am2 = await call("POST", `/v1/repos/alice/repo1/pulls/${an}/merge`, {}, agTok);
    assert.equal(am2.status, 200, am2.text);
  });
});

describe("forge: public repo visibility", () => {
  let api;
  after(() => { try { api?.server?.close(); } catch { /* already closed */ } });

  it("deletes branches through the percent-encoded route (the SDK/CLI form)", async () => {
    const dir = makeStateDir();
    process.env.KILN_SWARM_API_PORT = "0";
    try {
      api = await startApiServer(dir, { apiPort: 0 });
    } finally {
      delete process.env.KILN_SWARM_API_PORT;
    }
    const base = api.url;
    const op = loadApiToken(dir);
    const call = async (method, path, body, bearer) => {
      const res = await fetch(base + path, {
        method,
        headers: {
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { /* raw response */ }
      return { status: res.status, text, data };
    };

    assert.equal((await call("POST", "/git/auro/bd", undefined, op)).status, 201);
    const w = await call("PUT", "/v1/repos/auro/bd/contents", { path: "README.md", content: "# BD\n", message: "seed" }, op);
    assert.equal(w.status, 201, w.text);

    // Slash-named branch, deleted the way the kit SDK/CLI send it:
    // DELETE .../branches/<encodeURIComponent(name)> — the %2F form.
    // Regression: the route's name pattern excluded "%", so the encoded
    // name never matched and the request fell through to a bare 404.
    assert.equal((await call("POST", "/v1/repos/auro/bd/branches", { name: "fix/slash-name" }, op)).status, 201);
    const del = await call("DELETE", `/v1/repos/auro/bd/branches/${encodeURIComponent("fix/slash-name")}`, undefined, op);
    assert.equal(del.status, 200, del.text);
    assert.equal(del.data.name, "fix/slash-name");
    const names = (await call("GET", "/v1/repos/auro/bd/branches", undefined, op)).data.branches.map((b) => b.name);
    assert.ok(!names.includes("fix/slash-name"), names.join(","));
    assert.ok(names.includes("main"), names.join(","));

    // The raw-slash form keeps working, and a plain name deletes both ways.
    assert.equal((await call("POST", "/v1/repos/auro/bd/branches", { name: "fix/raw-slash" }, op)).status, 201);
    assert.equal((await call("DELETE", "/v1/repos/auro/bd/branches/fix/raw-slash", undefined, op)).status, 200);
    assert.equal((await call("POST", "/v1/repos/auro/bd/branches", { name: "plain-name" }, op)).status, 201);
    assert.equal((await call("DELETE", "/v1/repos/auro/bd/branches/plain-name", undefined, op)).status, 200);

    // Guards still hold through the encoded route: the default branch is
    // refused, and a missing branch 404s with the forge's own message
    // (proof the request now reaches deleteBranch, not the router).
    assert.equal((await call("DELETE", `/v1/repos/auro/bd/branches/${encodeURIComponent("main")}`, undefined, op)).status, 400);
    const missing = await call("DELETE", `/v1/repos/auro/bd/branches/${encodeURIComponent("fix/not-there")}`, undefined, op);
    assert.equal(missing.status, 404);
    assert.match(missing.data.error, /no such branch/);

    // Harness hygiene: the shared `after` closes only the LAST test's
    // server, and this suite tolerates exactly one leaked server (the
    // first test's). A middle test must close its own, or the file's
    // process never exits even with every test green.
    api.server.closeAllConnections?.();
    api.server.close();
  });

  it("public repos open every forge GET to anyone; writes stay owner-only", async () => {
    const dir = makeStateDir();
    process.env.KILN_SWARM_API_PORT = "0";
    try {
      api = await startApiServer(dir, { apiPort: 0 });
    } finally {
      delete process.env.KILN_SWARM_API_PORT;
    }
    const base = api.url;
    const op = loadApiToken(dir);
    const call = async (method, path, body, bearer) => {
      const res = await fetch(base + path, {
        method,
        headers: {
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { /* raw response */ }
      return { status: res.status, text, data };
    };

    // Accounts first (namespaces must be claimed before they hold
    // content): pubowner owns the repo, visitor is the other account.
    createAccount(dir, { email: "owner@example.com", name: "Owner", owner: "pubowner", password: "owner-password-1" });
    createAccount(dir, { email: "guest@example.com", name: "Guest", owner: "visitor", password: "guest-password-1" });
    const ownerSess = login(dir, { email: "owner@example.com", password: "owner-password-1" }).sessionToken;
    const guestSess = login(dir, { email: "guest@example.com", password: "guest-password-1" }).sessionToken;
    // Visitor's agents: one with the forge scope, one without.
    const agMint = await call("POST", "/v1/accounts/me/agents", { name: "guest-bot", scopes: ["forge"] }, guestSess);
    assert.equal(agMint.status, 201, agMint.text);
    const guestAgent = agMint.data.token;
    const ag2Mint = await call("POST", "/v1/accounts/me/agents", { name: "guest-lookout", scopes: ["workspaces"] }, guestSess);
    assert.equal(ag2Mint.status, 201, ag2Mint.text);
    const guestAgentNoForge = ag2Mint.data.token;

    // Repo with content, a branch, and a commit to compare (operator).
    assert.equal((await call("POST", "/git/pubowner/pub", undefined, op)).status, 201);
    const w = await call("PUT", "/v1/repos/pubowner/pub/contents", { path: "README.md", content: "# Public Test\n", message: "add readme" }, op);
    assert.equal(w.status, 201, w.text);
    assert.equal((await call("POST", "/v1/repos/pubowner/pub/branches", { name: "feature" }, op)).status, 201);
    const w3 = await call("PUT", "/v1/repos/pubowner/pub/contents", { path: "feat.txt", content: "feat\n", message: "feature work", branch: "feature" }, op);
    assert.equal(w3.status, 201, w3.text);

    // ---- while private: today's walls, byte for byte
    assert.equal((await call("GET", "/v1/repos/pubowner/pub/details", undefined, op)).data.visibility, "private");
    for (const p of ["branches", "tree", "contents?path=README.md", "commits", "pulls", "tags", "releases", "details"]) {
      assert.equal((await call("GET", `/v1/repos/pubowner/pub/${p}`)).status, 401, `anonymous GET ${p} on a private repo`);
    }
    assert.equal((await call("GET", "/v1/repos/pubowner/pub/contents?path=README.md", undefined, guestSess)).status, 403);
    assert.equal((await call("GET", "/v1/repos/pubowner/pub/commits", undefined, guestAgent)).status, 403);
    // a non-owner may not flip visibility either
    assert.equal((await call("PATCH", "/v1/repos/pubowner/pub/details", { visibility: "public" }, guestSess)).status, 403);

    // ---- the owner flips it public (session, own namespace)
    const flip = await call("PATCH", "/v1/repos/pubowner/pub/details", { visibility: "public" }, ownerSess);
    assert.equal(flip.status, 200, flip.text);
    assert.equal(flip.data.details.visibility, "public");

    // ---- anonymous: every forge GET opens, with real content
    const dAnon = await call("GET", "/v1/repos/pubowner/pub/details");
    assert.equal(dAnon.status, 200);
    assert.equal(dAnon.data.visibility, "public");
    assert.equal((await call("GET", "/v1/repos/pubowner/pub/branches")).status, 200);
    assert.equal((await call("GET", "/v1/repos/pubowner/pub/tree")).status, 200);
    const cAnon = await call("GET", "/v1/repos/pubowner/pub/contents?path=README.md");
    assert.equal(cAnon.status, 200);
    assert.equal(Buffer.from(cAnon.data.content, "base64").toString("utf8"), "# Public Test\n");
    const commitsAnon = await call("GET", "/v1/repos/pubowner/pub/commits");
    assert.equal(commitsAnon.status, 200);
    assert.equal(commitsAnon.data.commits.length, 2); // initial commit + "add readme"
    assert.equal((await call("GET", `/v1/repos/pubowner/pub/commits/${w.data.commit}`)).status, 200);
    const cmpAnon = await call("GET", "/v1/repos/pubowner/pub/compare?base=main&head=feature");
    assert.equal(cmpAnon.status, 200);
    assert.equal(cmpAnon.data.ahead, 1);
    assert.equal((await call("GET", "/v1/repos/pubowner/pub/pulls")).status, 200);
    assert.equal((await call("GET", "/v1/repos/pubowner/pub/tags")).status, 200);
    assert.equal((await call("GET", "/v1/repos/pubowner/pub/releases")).status, 200);

    // ---- other principals read it too; the scope rule is NOT loosened
    assert.equal((await call("GET", "/v1/repos/pubowner/pub/contents?path=README.md", undefined, guestSess)).status, 200);
    assert.equal((await call("GET", "/v1/repos/pubowner/pub/contents?path=README.md", undefined, guestAgent)).status, 200);
    assert.equal((await call("GET", "/v1/repos/pubowner/pub/contents?path=README.md", undefined, guestAgentNoForge)).status, 403);

    // ---- writes on a PUBLIC repo stay refused for everyone but the owner
    assert.equal((await call("PUT", "/v1/repos/pubowner/pub/contents", { path: "evil.txt", content: "x", message: "x" })).status, 401);
    assert.equal((await call("POST", "/v1/repos/pubowner/pub/branches", { name: "evil" })).status, 401);
    assert.equal((await call("POST", "/v1/repos/pubowner/pub/pulls", { title: "x", head: "feature", base: "main" })).status, 401);
    assert.equal((await call("DELETE", "/v1/repos/pubowner/pub/contents", { path: "README.md", message: "x" })).status, 401);
    assert.equal((await call("PUT", "/v1/repos/pubowner/pub/contents", { path: "evil.txt", content: "x", message: "x" }, guestSess)).status, 403);
    assert.equal((await call("POST", "/v1/repos/pubowner/pub/branches", { name: "evil" }, guestSess)).status, 403);
    assert.equal((await call("POST", "/v1/repos/pubowner/pub/pulls", { title: "x", head: "feature", base: "main" }, guestAgent)).status, 403);
    assert.equal((await call("PATCH", "/v1/repos/pubowner/pub/details", { visibility: "private" }, guestSess)).status, 403);
    // packages are a separate namespace — untouched by repo visibility
    assert.equal((await call("GET", "/v1/packages/pubowner")).status, 401);

    // ---- the owner still writes, and flipping back closes the reads
    const wOwner = await call("PUT", "/v1/repos/pubowner/pub/contents", { path: "owner.txt", content: "mine\n", message: "owner write" }, ownerSess);
    assert.equal(wOwner.status, 201, wOwner.text);
    assert.equal((await call("PATCH", "/v1/repos/pubowner/pub/details", { visibility: "private" }, ownerSess)).status, 200);
    assert.equal((await call("GET", "/v1/repos/pubowner/pub/contents?path=README.md")).status, 401);
    assert.equal((await call("GET", "/v1/repos/pubowner/pub/contents?path=README.md", undefined, guestSess)).status, 403);
  });

});

describe("forge: bare-repo contents delete + merge workspace", () => {
  let api;
  after(() => { try { api?.server?.close(); } catch { /* already closed */ } });

  const boot = async () => {
    const dir = makeStateDir();
    process.env.KILN_SWARM_API_PORT = "0";
    try {
      api = await startApiServer(dir, { apiPort: 0 });
    } finally {
      delete process.env.KILN_SWARM_API_PORT;
    }
    const base = api.url;
    const op = loadApiToken(dir);
    const call = async (method, path, body, bearer) => {
      const res = await fetch(base + path, {
        method,
        headers: {
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { /* raw response */ }
      return { status: res.status, text, data };
    };
    return { dir, call, op };
  };

  it("deletes files through the contents API on a bare repo", async () => {
    const { call, op } = await boot();
    try {
      assert.equal((await call("POST", "/git/auro/del", undefined, op)).status, 201);
      const w1 = await call("PUT", "/v1/repos/auro/del/contents", { path: "DEL.md", content: "gone soon\n", message: "add del" }, op);
      assert.equal(w1.status, 201, w1.text);
      const w2 = await call("PUT", "/v1/repos/auro/del/contents", { path: "KEEP.md", content: "stays\n", message: "add keep" }, op);
      assert.equal(w2.status, 201, w2.text);
      const w3 = await call("PUT", "/v1/repos/auro/del/contents", { path: "dir/GONE.md", content: "nested\n", message: "add nested" }, op);
      assert.equal(w3.status, 201, w3.text);

      // Regression (bare-repo delete): the delete path ran
      // `update-index --force-remove`, which demands a work tree — the
      // forge's repos are bare, so every contents delete 500'd with
      // "this operation must be run in a work tree" while puts (which
      // use --cacheinfo) worked on the same repos.
      const del = await call("DELETE", "/v1/repos/auro/del/contents", { path: "DEL.md", message: "remove del", sha: w1.data.blobSha }, op);
      assert.equal(del.status, 200, del.text);
      assert.match(del.data.commit, /^[0-9a-f]{40}$/);
      assert.equal(del.data.blobSha, null);

      // The file is gone from the tree; its sibling is untouched; the
      // delete is a real commit on top of the writes.
      assert.equal((await call("GET", "/v1/repos/auro/del/contents?path=DEL.md", undefined, op)).status, 404);
      assert.equal((await call("GET", "/v1/repos/auro/del/contents?path=KEEP.md", undefined, op)).status, 200);
      const tree = await call("GET", "/v1/repos/auro/del/tree", undefined, op);
      assert.deepEqual(tree.data.entries.map((e) => e.path).sort(), ["KEEP.md", "dir"]);
      const commits = await call("GET", "/v1/repos/auro/del/commits", undefined, op);
      // Union semantics: repos are born with a seed commit ("chore:
      // initialize repository"), so the chain is seed + 3 writes + this
      // delete = 5, newest first.
      assert.equal(commits.data.commits.length, 5);
      assert.equal(commits.data.commits[0].subject, "remove del");
      const gone = await call("GET", `/v1/repos/auro/del/commits/${del.data.commit}`, undefined, op);
      assert.deepEqual(gone.data.files, [{ status: "D", path: "DEL.md" }]);

      // A nested delete works the same way, and a second delete of the
      // same path is an honest 404, not a 500.
      const delNested = await call("DELETE", "/v1/repos/auro/del/contents", { path: "dir/GONE.md", message: "remove nested", sha: w3.data.blobSha }, op);
      assert.equal(delNested.status, 200, delNested.text);
      assert.equal((await call("GET", "/v1/repos/auro/del/contents?path=dir/GONE.md", undefined, op)).status, 404);
      assert.equal((await call("DELETE", "/v1/repos/auro/del/contents", { path: "dir/GONE.md", message: "again" }, op)).status, 404);
      // Stale-sha delete is still a 409, same as a stale-sha write.
      assert.equal((await call("DELETE", "/v1/repos/auro/del/contents", { path: "KEEP.md", message: "x", sha: w1.data.blobSha }, op)).status, 409);
    } finally {
      // Middle test in this block: close its own server (see the
      // branch-delete test's note on the shared-after invariant).
      api.server.closeAllConnections?.();
      api.server.close();
    }
  });

  it("merges with the workspace under the state dir, not os.tmpdir()", async () => {
    const { dir, call, op } = await boot();

    assert.equal((await call("POST", "/git/auro/mrg", undefined, op)).status, 201);
    const w = await call("PUT", "/v1/repos/auro/mrg/contents", { path: "README.md", content: "# Merge\n", message: "seed" }, op);
    assert.equal(w.status, 201, w.text);
    assert.equal((await call("POST", "/v1/repos/auro/mrg/branches", { name: "feat" }, op)).status, 201);
    const wf = await call("PUT", "/v1/repos/auro/mrg/contents", { path: "feat.txt", content: "feat\n", message: "feature work", branch: "feat" }, op);
    assert.equal(wf.status, 201, wf.text);
    const pr = await call("POST", "/v1/repos/auro/mrg/pulls", { title: "Merge me", head: "feat", base: "main" }, op);
    assert.equal(pr.status, 201, pr.text);

    // Regression (merge workspace on tmpfs): the throwaway merge clone
    // was created under os.tmpdir() — a 512MB tmpfs on the swarm host —
    // so merging a large repo died mid-checkout with "Out of
    // diskspace". Point TMPDIR at a path that cannot be used at all:
    // a merge that still consults os.tmpdir() for its workspace fails
    // outright, a merge whose workspace lives under the (disk-backed)
    // state dir never notices. (Git itself does not need TMPDIR for
    // clone/checkout/merge — verified against a scratch bare repo.)
    const savedTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = join(dir, "tmpdir-must-not-be-used");
    let merged;
    try {
      merged = await call("POST", `/v1/repos/auro/mrg/pulls/${pr.data.pull.number}/merge`, { method: "merge" }, op);
    } finally {
      if (savedTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmpdir;
    }
    assert.equal(merged.status, 200, merged.text);
    assert.equal(merged.data.pull.state, "merged");
    assert.equal((await call("GET", "/v1/repos/auro/mrg/contents?path=feat.txt", undefined, op)).status, 200);

    // The workspace base exists under the state dir and the throwaway
    // clone was cleaned out of it — success leaves no litter behind.
    const mergeBase = join(dir, "merge-tmp");
    assert.ok(existsSync(mergeBase), "merge workspace base should live under the state dir");
    assert.deepEqual(readdirSync(mergeBase), []);
  });
});


describe("forge: repo lifecycle — born PR-ready, delete, delete-on-merge", () => {
  let api, dir, base, op, call;
  after(() => { try { api?.server?.close(); } catch { /* already closed */ } });

  async function boot() {
    if (api) return;
    dir = makeStateDir();
    process.env.KILN_SWARM_API_PORT = "0";
    try {
      api = await startApiServer(dir, { apiPort: 0 });
    } finally {
      delete process.env.KILN_SWARM_API_PORT;
    }
    base = api.url;
    op = loadApiToken(dir);
    call = async (method, path, body, bearer) => {
      const res = await fetch(base + path, {
        method,
        headers: {
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch { /* raw response */ }
      return { status: res.status, text, data };
    };
  }

  it("a repo is born with an initial commit and takes a first PR end-to-end; merge can delete the head branch", async () => {
    await boot();
    const created = await call("POST", "/git/auro/born", undefined, op);
    assert.equal(created.status, 201, created.text);
    assert.match(created.data.initialCommit, /^[0-9a-f]{40}$/);

    // main resolves from minute one: one branch at the initial commit,
    // whose log is exactly the seed commit with an empty tree.
    const branches = await call("GET", "/v1/repos/auro/born/branches", undefined, op);
    assert.deepEqual(branches.data.branches.map((b) => b.name), ["main"]);
    assert.equal(branches.data.branches[0].sha, created.data.initialCommit);
    const commits = await call("GET", "/v1/repos/auro/born/commits", undefined, op);
    assert.equal(commits.data.commits.length, 1);
    assert.equal(commits.data.commits[0].subject, "chore: initialize repository");
    assert.equal(commits.data.commits[0].author.name, "KILN Operator");

    // The exact kit-landing flow, with NO client-side seed commit:
    // branch straight off main, write on the branch, open and merge.
    assert.equal((await call("POST", "/v1/repos/auro/born/branches", { name: "feat/initial-kit" }, op)).status, 201);
    const w = await call("PUT", "/v1/repos/auro/born/contents", { path: "README.md", content: "# Born\n", message: "kit readme", branch: "feat/initial-kit" }, op);
    assert.equal(w.status, 201, w.text);
    const pr = await call("POST", "/v1/repos/auro/born/pulls", { title: "Initial kit", head: "feat/initial-kit", base: "main" }, op);
    assert.equal(pr.status, 201, pr.text);
    const merged = await call("POST", "/v1/repos/auro/born/pulls/1/merge", { deleteBranch: true }, op);
    assert.equal(merged.status, 200, merged.text);
    assert.equal(merged.data.headBranchDeleted, true);
    const names = (await call("GET", "/v1/repos/auro/born/branches", undefined, op)).data.branches.map((b) => b.name);
    assert.deepEqual(names, ["main"]);
    const onMain = await call("GET", "/v1/repos/auro/born/contents?path=README.md", undefined, op);
    assert.equal(onMain.status, 200);
    assert.equal(Buffer.from(onMain.data.content, "base64").toString("utf8"), "# Born\n");

    // Default stays OFF: a merge without the flag keeps its head branch.
    assert.equal((await call("POST", "/v1/repos/auro/born/branches", { name: "keep" }, op)).status, 201);
    assert.equal((await call("PUT", "/v1/repos/auro/born/contents", { path: "keep.txt", content: "k\n", message: "keep work", branch: "keep" }, op)).status, 201);
    const pr2 = await call("POST", "/v1/repos/auro/born/pulls", { title: "Keep branch", head: "keep", base: "main" }, op);
    assert.equal(pr2.status, 201, pr2.text);
    const merged2 = await call("POST", `/v1/repos/auro/born/pulls/${pr2.data.pull.number}/merge`, {}, op);
    assert.equal(merged2.status, 200, merged2.text);
    assert.ok(!merged2.data.headBranchDeleted);
    const names2 = (await call("GET", "/v1/repos/auro/born/branches", undefined, op)).data.branches.map((b) => b.name);
    assert.ok(names2.includes("keep"));
  });

  it("DELETE repo: owner session or operator only; deletion is complete and recreation starts clean", async () => {
    await boot();
    createAccount(dir, { email: "del@example.com", name: "Del", owner: "delowner", password: "del-password-1" });
    createAccount(dir, { email: "delguest@example.com", name: "Del Guest", owner: "delguest", password: "guest-password-1" });
    const ownerSess = login(dir, { email: "del@example.com", password: "del-password-1" }).sessionToken;
    const guestSess = login(dir, { email: "delguest@example.com", password: "guest-password-1" }).sessionToken;
    const agMint = await call("POST", "/v1/accounts/me/agents", { name: "del-bot", scopes: ["forge"] }, ownerSess);
    assert.equal(agMint.status, 201, agMint.text);
    const ownerAgent = agMint.data.token;

    assert.equal((await call("POST", "/git/delowner/victim", undefined, op)).status, 201);
    // Seed forge state the deletion must scrub: a file, a branch + open
    // PR (forge registry), a release, and a workspace membership.
    assert.equal((await call("PUT", "/v1/repos/delowner/victim/contents", { path: "a.txt", content: "a\n", message: "seed" }, op)).status, 201);
    assert.equal((await call("POST", "/v1/repos/delowner/victim/branches", { name: "wip" }, op)).status, 201);
    assert.equal((await call("POST", "/v1/repos/delowner/victim/pulls", { title: "wip pr", head: "wip", base: "main" }, op)).status, 201);
    assert.equal((await call("POST", "/v1/repos/delowner/victim/releases", { tag: "v1.0.0", name: "One" }, op)).status, 201);
    const ws = await call("POST", "/v1/workspaces", { owner: "delowner", slug: "del-ws", name: "Del WS", repos: ["delowner/victim"] }, ownerSess);
    assert.equal(ws.status, 201, ws.text);
    const wsId = ws.data.workspace.id;

    // ---- the auth matrix
    assert.equal((await call("DELETE", "/v1/repos/delowner/victim")).status, 401); // anonymous
    assert.equal((await call("DELETE", "/v1/repos/delowner/victim", undefined, ownerAgent)).status, 403); // agent: never
    assert.equal((await call("DELETE", "/v1/repos/delowner/victim", undefined, guestSess)).status, 403); // non-owner session
    assert.equal((await call("DELETE", "/v1/repos/delowner/nope", undefined, ownerSess)).status, 404); // owner, missing repo
    const del = await call("DELETE", "/v1/repos/delowner/victim", undefined, ownerSess);
    assert.equal(del.status, 200, del.text);
    assert.equal(del.data.deleted, true);

    // ---- completeness: gone from listings, details and pulls 404,
    // and the workspace keeps its member ref rendered as missing (the
    // codebase's own pattern for registry references).
    const listing = await call("GET", "/git", undefined, op);
    assert.ok(!listing.data.repos.some((r) => r.owner === "delowner" && r.repo === "victim"));
    assert.equal((await call("GET", "/v1/repos/delowner/victim/details", undefined, op)).status, 404);
    assert.equal((await call("GET", "/v1/repos/delowner/victim/pulls", undefined, op)).status, 404);
    const wsAfter = await call("GET", `/v1/workspaces/${wsId}`, undefined, ownerSess);
    assert.equal(wsAfter.status, 200, wsAfter.text);
    assert.equal(wsAfter.data.repos.find((r) => r.repo === "delowner/victim").exists, false);

    // ---- recreation starts clean: fresh initial commit, forge
    // registry scrubbed (no pulls/releases, PR counter back to #1).
    const re = await call("POST", "/git/delowner/victim", undefined, op);
    assert.equal(re.status, 201, re.text);
    assert.match(re.data.initialCommit, /^[0-9a-f]{40}$/);
    assert.deepEqual((await call("GET", "/v1/repos/delowner/victim/pulls", undefined, op)).data.pulls, []);
    assert.deepEqual((await call("GET", "/v1/repos/delowner/victim/releases", undefined, op)).data.releases, []);
    assert.equal((await call("GET", "/v1/repos/delowner/victim/details", undefined, op)).data.commitCount, 1);
    assert.equal((await call("POST", "/v1/repos/delowner/victim/branches", { name: "again" }, op)).status, 201);
    const prAgain = await call("POST", "/v1/repos/delowner/victim/pulls", { title: "first again", head: "again", base: "main" }, op);
    assert.equal(prAgain.status, 201, prAgain.text);
    assert.equal(prAgain.data.pull.number, 1);

    // The operator can delete too.
    assert.equal((await call("DELETE", "/v1/repos/delowner/victim", undefined, op)).status, 200);
  });

  it("createPull on a legacy repo with no commits answers an explicit 409, not a bare 404", async () => {
    await boot();
    // A pre-fix repo, created by hand the old way: bare, unborn main.
    const p = repoPath(dir, "legacy", "old");
    mkdirSync(dirname(p), { recursive: true });
    execFileSync("git", ["init", "--bare", "--initial-branch=main", p], { stdio: "ignore" });
    const pr = await call("POST", "/v1/repos/legacy/old/pulls", { title: "x", head: "feat", base: "main" }, op);
    assert.equal(pr.status, 409, pr.text);
    assert.match(pr.data.error, /no commits yet/);
  });
});
