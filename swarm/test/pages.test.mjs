/**
 * KILN Pages: repo pages setting (details PATCH round-trip + gates +
 * validation) and live-from-ref static serving at /pages/:owner/:repo/*.
 * Real HTTP API on an ephemeral port, real bare repos, real git — no
 * mocks. Covers: index at root + directory paths, nested assets,
 * content types, real 404s, the 301 slash canonicalization, HEAD,
 * path traversal (plain + percent-encoded) answered as nothing,
 * the visibility law (public → anonymous 200; private → anonymous 401,
 * non-owner account 403, owner 200), pages disabled → 404, and
 * push = republish (a new commit changes the served bytes).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { makeStateDir } from "./helpers.mjs";
import { startApiServer } from "../lib/httpapi.mjs";
import { loadApiToken } from "../lib/state.mjs";

describe("KILN Pages: setting + serving", () => {
  let api;
  after(() => { try { api?.server?.close(); } catch { /* already closed */ } });

  it("runs the pages matrix", async () => {
    const dir = makeStateDir();
    process.env.KILN_SWARM_API_PORT = "0";
    try {
      api = await startApiServer(dir, { apiPort: 0 });
    } finally {
      delete process.env.KILN_SWARM_API_PORT;
    }
    const base = api.url;
    const opToken = loadApiToken(dir);
    const call = async (method, path, body, bearer) => {
      const res = await fetch(base + path, {
        method,
        redirect: "manual",
        headers: {
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let data = {};
      try { data = JSON.parse(text || "{}"); } catch { /* raw bodies are the point */ }
      return { status: res.status, text, data, headers: res.headers };
    };
    const put = async (owner, repo, path, content, bearer) => {
      // The contents API is compare-and-swap: updating an existing file
      // requires its current sha (a create passes none).
      const cur = await call("GET",
        `/v1/repos/${owner}/${repo}/contents?path=${encodeURIComponent(path)}`, null, bearer);
      const sha = cur.status === 200 ? cur.data.sha : undefined;
      const r = await call("PUT", `/v1/repos/${owner}/${repo}/contents`,
        { path, content, message: `pages test: ${path}`, ...(sha ? { sha } : {}) }, bearer);
      assert.equal(r.status, 201, `PUT ${path}: ${r.text.slice(0, 200)}`);
      return r;
    };

    // ---- accounts: alice (owner), bob (non-owner)
    const pw = "password-long-1";
    assert.equal((await call("POST", "/v1/accounts", { email: "alice@x.io", name: "Alice", owner: "alice", password: pw })).status, 201);
    assert.equal((await call("POST", "/v1/accounts", { email: "bob@x.io", name: "Bob", owner: "bob", password: pw })).status, 201);
    const aliceSess = (await call("POST", "/v1/accounts/login", { email: "alice@x.io", password: pw })).data.sessionToken;
    const bobSess = (await call("POST", "/v1/accounts/login", { email: "bob@x.io", password: pw })).data.sessionToken;
    assert.ok(aliceSess && bobSess);

    // ---- alice's site repo, seeded under /site
    assert.equal((await call("POST", "/v1/repos", { owner: "alice", repo: "site" }, aliceSess)).status, 201);
    await put("alice", "site", "site/index.html", "<h1>hello kiln</h1>\n", aliceSess);
    await put("alice", "site", "site/style.css", "body { color: red; }\n", aliceSess);
    await put("alice", "site", "site/docs/index.html", "<p>nested index</p>\n", aliceSess);
    await put("alice", "site", "site/docs/guide.txt", "the guide\n", aliceSess);
    await put("alice", "site", "secret.txt", "not part of the site\n", aliceSess);

    const details = (bearer) => call("GET", "/v1/repos/alice/site/details", null, bearer);
    const patch = (body, bearer) => call("PATCH", "/v1/repos/alice/site/details", body, bearer);

    // ---- setting: default is disabled; serving answers 404 until enabled
    let d = await details(aliceSess);
    assert.equal(d.status, 200);
    assert.deepEqual(d.data.pages, { enabled: false, branch: "", path: "" });
    assert.equal((await call("GET", "/pages/alice/site/", null, aliceSess)).status, 404);

    // ---- setting: gates — non-owner session 403, anonymous 401
    assert.equal((await patch({ pages: { enabled: true, path: "site" } }, bobSess)).status, 403);
    assert.equal((await patch({ pages: { enabled: true, path: "site" } })).status, 401);

    // ---- setting: validation 400s
    for (const bad of [
      { pages: { path: "../etc" } },
      { pages: { path: "a//b" } },
      { pages: { path: "a/./b" } },
      { pages: { branch: ".." } },
      { pages: { branch: "bad branch" } },
      { pages: { enabled: "yes" } },
      { pages: "site" },
    ]) {
      const r = await patch(bad, aliceSess);
      assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(bad)}, got ${r.status}`);
    }

    // ---- setting: round-trip (owner), partial merge keeps siblings
    const set = await patch({ pages: { enabled: true, path: "/site/" } }, aliceSess);
    assert.equal(set.status, 200, set.text.slice(0, 200));
    assert.deepEqual(set.data.details.pages, { enabled: true, branch: "", path: "site" });
    d = await details(aliceSess);
    assert.deepEqual(d.data.pages, { enabled: true, branch: "", path: "site" });
    const remerge = await patch({ pages: { branch: "main" } }, aliceSess);
    assert.deepEqual(remerge.data.details.pages, { enabled: true, branch: "main", path: "site" });

    // ---- serving: private repo — owner 200, non-owner 403, anonymous 401
    let r = await call("GET", "/pages/alice/site/", null, aliceSess);
    assert.equal(r.status, 200);
    assert.equal(r.text, "<h1>hello kiln</h1>\n");
    assert.match(r.headers.get("content-type"), /text\/html/);
    assert.ok(r.headers.get("x-kiln-pages-sha"), "commit header present");
    assert.equal((await call("GET", "/pages/alice/site/", null, bobSess)).status, 403);
    assert.equal((await call("GET", "/pages/alice/site/")).status, 401);
    // operator reads anything
    assert.equal((await call("GET", "/pages/alice/site/", null, opToken)).status, 200);

    // ---- serving: bare root 301 → slash form; dir without slash 301
    r = await call("GET", "/pages/alice/site", null, aliceSess);
    assert.equal(r.status, 301);
    assert.equal(r.headers.get("location"), "/pages/alice/site/");
    r = await call("GET", "/pages/alice/site/docs", null, aliceSess);
    assert.equal(r.status, 301);
    assert.equal(r.headers.get("location"), "/pages/alice/site/docs/");

    // ---- serving: nested index, nested file, content types
    r = await call("GET", "/pages/alice/site/docs/", null, aliceSess);
    assert.equal(r.status, 200);
    assert.equal(r.text, "<p>nested index</p>\n");
    r = await call("GET", "/pages/alice/site/docs/guide.txt", null, aliceSess);
    assert.equal(r.status, 200);
    assert.equal(r.text, "the guide\n");
    assert.match(r.headers.get("content-type"), /text\/plain/);
    r = await call("GET", "/pages/alice/site/style.css", null, aliceSess);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /text\/css/);
    // direct index path works too
    assert.equal((await call("GET", "/pages/alice/site/index.html", null, aliceSess)).status, 200);

    // ---- serving: real 404s (missing file, missing dir, outside the pages root)
    assert.equal((await call("GET", "/pages/alice/site/nope.html", null, aliceSess)).status, 404);
    assert.equal((await call("GET", "/pages/alice/site/nope/", null, aliceSess)).status, 404);
    // secret.txt lives at the repo root, NOT under the designated /site
    assert.equal((await call("GET", "/pages/alice/site/%2e%2e/secret.txt", null, aliceSess)).status, 404);

    // ---- serving: traversal — fired as RAW HTTP paths (no client URL
    // normalization to hide behind): the server's own defenses must
    // answer every probe as nothing, and never leak the root file.
    const raw = (path) => new Promise((resolve, reject) => {
      const u = new URL(base);
      const req = httpRequest(
        { hostname: u.hostname, port: u.port, path, method: "GET",
          headers: { authorization: `Bearer ${aliceSess}` } },
        (res) => {
          let text = "";
          res.on("data", (c) => { text += c; });
          res.on("end", () => resolve({ status: res.statusCode, text }));
        });
      req.on("error", reject);
      req.end();
    });
    for (const probe of [
      "/pages/alice/site/../secret.txt",
      "/pages/alice/site/%2e%2e/secret.txt",
      "/pages/alice/site/%2e%2e%2fsecret.txt",
      "/pages/alice/site/docs/../../secret.txt",
      "/pages/alice/site/..%5csecret.txt",
      "/pages/alice/site/docs/%2e%2e%2f%2e%2e%2fsecret.txt",
      "/pages/alice/site/docs/%2e%2e/guide.txt",
    ]) {
      const pr = await raw(probe);
      assert.equal(pr.status, 404, `traversal ${probe} → ${pr.status}`);
      assert.ok(!pr.text.includes("not part of the site"), `traversal ${probe} leaked bytes`);
      assert.ok(!pr.text.includes("the guide"), `traversal ${probe} leaked site bytes`);
    }
    // Traversal in the owner/repo positions themselves, and probes so
    // encoded that URL parsing collapses them off the pages route
    // entirely (%2e%2e/%2e%2e → /pages/kiln.json, a non-route): never a
    // 200, never bytes — the exact refusal code there belongs to the
    // forge's standard gates, not to pages.
    for (const probe of ["/pages/../alice/site/", "/pages/%2e%2e/alice/site/", "/pages/alice/site/%2e%2e/%2e%2e/kiln.json"]) {
      const pr = await raw(probe);
      assert.notEqual(pr.status, 200, `position traversal ${probe} → ${pr.status}`);
      assert.ok(!pr.text.includes("hello kiln"), `position traversal ${probe} leaked bytes`);
    }
    // Dot segments that canonicalize WITHIN the surface are not
    // traversal: URL parsing resolves them lexically before routing,
    // so /pages/alice/../alice/site/ IS the canonical /pages/alice/site/
    // and serves exactly what that URL serves — nothing beyond it.
    // (A canonical /pages/<o>/<r>/… path can only name repo o/r; below
    // the repo, the segment sanitizer governs — proven above.)
    const canon = await raw("/pages/alice/../alice/site/");
    assert.equal(canon.status, 200);
    assert.equal(canon.text, "<h1>hello kiln</h1>\n");

    // ---- HEAD: headers, no body
    r = await call("HEAD", "/pages/alice/site/", null, aliceSess);
    assert.equal(r.status, 200);
    assert.equal(r.text, "");
    assert.ok(Number(r.headers.get("content-length")) > 0);

    // ---- push = republish: a new commit changes the served bytes
    const before = (await call("GET", "/pages/alice/site/", null, aliceSess)).headers.get("x-kiln-pages-sha");
    await put("alice", "site", "site/index.html", "<h1>second edition</h1>\n", aliceSess);
    r = await call("GET", "/pages/alice/site/", null, aliceSess);
    assert.equal(r.text, "<h1>second edition</h1>\n");
    assert.notEqual(r.headers.get("x-kiln-pages-sha"), before);

    // ---- visibility flip: public repo serves ANYONE, incl. anonymous
    assert.equal((await patch({ visibility: "public" }, aliceSess)).status, 200);
    r = await call("GET", "/pages/alice/site/");
    assert.equal(r.status, 200);
    assert.equal(r.text, "<h1>second edition</h1>\n");
    assert.equal((await call("HEAD", "/pages/alice/site/")).status, 200);
    // …and flipping back closes the anonymous door again
    assert.equal((await patch({ visibility: "private" }, aliceSess)).status, 200);
    assert.equal((await call("GET", "/pages/alice/site/")).status, 401);

    // ---- unknown repo: anonymous gets 401 (no oracle), owner-shaped 404
    assert.equal((await call("GET", "/pages/alice/ghost/")).status, 401);
    assert.equal((await call("GET", "/pages/alice/ghost/", null, aliceSess)).status, 404);

    // ---- disabling pages returns the site to nothing, files untouched
    assert.equal((await patch({ pages: { enabled: false } }, aliceSess)).status, 200);
    assert.equal((await call("GET", "/pages/alice/site/", null, aliceSess)).status, 404);
    assert.equal((await call("GET", "/pages/alice/site/", null, opToken)).status, 404);
  });
});
