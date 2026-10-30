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
import { makeStateDir } from "./helpers.mjs";
import { startApiServer } from "../lib/httpapi.mjs";
import { loadApiToken } from "../lib/state.mjs";
import { createAccount, login } from "../lib/accounts.mjs";

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
    assert.equal(commits.data.commits.length, 2);
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
    assert.equal(commitsAnon.data.commits.length, 1);
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
