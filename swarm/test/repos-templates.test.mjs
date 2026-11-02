/**
 * POST /v1/repos (canonical repo creation) + creation templates:
 * real HTTP API on an ephemeral port, real bare repos, real git —
 * no mocks. Covers: plain create unchanged, template scaffolding
 * landing IN the initial commit, saved user templates (round-trip,
 * inline override, cross-account denial), and the auth matrix.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { makeStateDir } from "./helpers.mjs";
import { startApiServer } from "../lib/httpapi.mjs";
import { loadApiToken } from "../lib/state.mjs";
import { createRepo, repoPath } from "../lib/git.mjs";

function gitBare(dir, owner, repo, args) {
  return execFileSync("git", ["--git-dir", repoPath(dir, owner, repo), ...args], { encoding: "utf8" }).trim();
}

describe("repo create + templates: HTTP API", () => {
  let api;
  after(() => { try { api?.server?.close(); } catch { /* already closed */ } });

  it("runs the create + template matrix", async () => {
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
        headers: {
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let data = {};
      try { data = JSON.parse(text || "{}"); } catch { /* raw bodies below */ }
      return { status: res.status, text, data };
    };
    const fileAt = async (owner, repo, path, bearer) => {
      const r = await call("GET", `/v1/repos/${owner}/${repo}/contents?path=${encodeURIComponent(path)}`, null, bearer);
      if (r.status !== 200) return null;
      return Buffer.from(r.data.content, "base64").toString("utf8");
    };

    // ---- accounts: alice (owner), bob (the non-owner)
    const pw = "password-long-1";
    assert.equal((await call("POST", "/v1/accounts", { email: "alice@x.io", name: "Alice", owner: "alice", password: pw })).status, 201);
    assert.equal((await call("POST", "/v1/accounts", { email: "bob@x.io", name: "Bob", owner: "bob", password: pw })).status, 201);
    const aliceSess = (await call("POST", "/v1/accounts/login", { email: "alice@x.io", password: pw })).data.sessionToken;
    const bobSess = (await call("POST", "/v1/accounts/login", { email: "bob@x.io", password: pw })).data.sessionToken;
    assert.ok(aliceSess && bobSess);
    // alice's forge-scoped agent + a workspaces-only agent
    const agForge = await call("POST", "/v1/accounts/me/agents", { name: "forger", scopes: ["forge"] }, aliceSess);
    assert.equal(agForge.status, 201);
    const aliceAgent = agForge.data.token;
    const agWs = await call("POST", "/v1/accounts/me/agents", { name: "lookout", scopes: ["workspaces"] }, aliceSess);
    const aliceWsAgent = agWs.data.token;

    // ---- plain create via /v1/repos: unchanged behaviour
    const plain = await call("POST", "/v1/repos", { owner: "alice", repo: "plain" }, aliceSess);
    assert.equal(plain.status, 201, JSON.stringify(plain.data));
    assert.deepEqual(plain.data.files, []);
    assert.equal(gitBare(dir, "alice", "plain", ["rev-list", "--count", "main"]), "1");
    assert.equal(gitBare(dir, "alice", "plain", ["log", "-1", "--format=%s", "main"]), "chore: initialize repository");
    assert.equal(gitBare(dir, "alice", "plain", ["ls-tree", "--name-only", "main"]), "");
    // duplicate create → 409; bad name → 400; anonymous → 401
    assert.equal((await call("POST", "/v1/repos", { owner: "alice", repo: "plain" }, aliceSess)).status, 409);
    assert.equal((await call("POST", "/v1/repos", { owner: "alice", repo: "Bad Name" }, aliceSess)).status, 400);
    assert.equal((await call("POST", "/v1/repos", { owner: "alice", repo: "noauth" })).status, 401);

    // ---- operator creates anywhere; non-owner session cannot
    assert.equal((await call("POST", "/v1/repos", { owner: "opspace", repo: "byop" }, opToken)).status, 201);
    assert.equal((await call("POST", "/v1/repos", { owner: "alice", repo: "bobsmove" }, bobSess)).status, 403);

    // ---- built-in template: license + readme + gitignore in the INITIAL commit
    const mit = await call("POST", "/v1/repos", {
      owner: "alice", repo: "mit-app", description: "A test app",
      template: { license: "MIT", readme: true, gitignore: "node" },
    }, aliceSess);
    assert.equal(mit.status, 201, JSON.stringify(mit.data));
    assert.deepEqual([...mit.data.files].sort(), [".gitignore", "LICENSE", "README.md"]);
    assert.equal(gitBare(dir, "alice", "mit-app", ["rev-list", "--count", "main"]), "1", "scaffold lands in the initial commit, not a follow-up");
    const lic = await fileAt("alice", "mit-app", "LICENSE", aliceSess);
    assert.ok(lic.includes("MIT License") && lic.includes("Permission is hereby granted"), "real MIT text");
    assert.ok(lic.includes(`Copyright (c) ${new Date().getFullYear()} alice`), "holder filled with the owner");
    assert.equal(await fileAt("alice", "mit-app", "README.md", aliceSess), "# mit-app\n\nA test app\n");
    assert.ok((await fileAt("alice", "mit-app", ".gitignore", aliceSess)).includes("node_modules/"));
    // born PR-ready with content: branch → write → PR → merge
    assert.equal((await call("POST", "/v1/repos/alice/mit-app/branches", { name: "feat" }, aliceSess)).status, 201);
    const put = await call("PUT", "/v1/repos/alice/mit-app/contents", { path: "index.js", content: "export {};\n", message: "feat: add index", branch: "feat" }, aliceSess);
    assert.equal(put.status, 201, JSON.stringify(put.data));
    const pr = await call("POST", "/v1/repos/alice/mit-app/pulls", { title: "Add index", head: "feat", base: "main" }, aliceSess);
    assert.equal(pr.status, 201, JSON.stringify(pr.data));
    const merged = await call("POST", `/v1/repos/alice/mit-app/pulls/${pr.data.pull.number}/merge`, { method: "merge" }, aliceSess);
    assert.equal(merged.status, 200, JSON.stringify(merged.data));
    assert.ok(await fileAt("alice", "mit-app", "index.js", aliceSess));

    // ---- the other built-ins, none, custom text, and the typo fence
    const gpl = await call("POST", "/v1/repos", { owner: "alice", repo: "gpl-app", template: { license: "GPL-3.0" } }, aliceSess);
    assert.equal(gpl.status, 201);
    const gplLic = await fileAt("alice", "gpl-app", "LICENSE", aliceSess);
    assert.ok(gplLic.includes("GNU GENERAL PUBLIC LICENSE") && gplLic.includes("Version 3"), "real GPL-3.0 text");
    const none = await call("POST", "/v1/repos", { owner: "alice", repo: "nolicense", template: { license: "none" } }, aliceSess);
    assert.equal(none.status, 201);
    assert.deepEqual(none.data.files, []);
    const custom = await call("POST", "/v1/repos", {
      owner: "alice", repo: "customlic",
      template: { licenseText: "Copyright (c) us. Hands off, mostly.\n" },
    }, aliceSess);
    assert.equal(custom.status, 201);
    assert.equal(await fileAt("alice", "customlic", "LICENSE", aliceSess), "Copyright (c) us. Hands off, mostly.\n");
    const customViaLicense = await call("POST", "/v1/repos", {
      owner: "alice", repo: "customlic2",
      template: { license: "This project is licensed on a napkin.\nAsk before copying anything at all, please.\n" },
    }, aliceSess);
    assert.equal(customViaLicense.status, 201, "long/multi-line license string is custom text");
    assert.equal((await call("POST", "/v1/repos", { owner: "alice", repo: "typo", template: { license: "Apach" } }, aliceSess)).status, 400, "short unknown license is a typo, not a LICENSE file");

    // ---- saved user templates: CRUD + round-trip + override + denial
    assert.equal((await call("POST", "/v1/templates", { name: "x" }, opToken)).status, 403, "operator has no template book");
    const house = await call("POST", "/v1/templates", {
      name: "house style",
      license: "Apache-2.0",
      readme: true,
      gitignore: "python",
      files: [{ path: "docs/CHANGELOG.md", content: "# Changelog\n" }],
    }, aliceSess);
    assert.equal(house.status, 201, JSON.stringify(house.data));
    const houseId = house.data.template.id;
    assert.ok(houseId.startsWith("tpl_"));
    assert.equal((await call("POST", "/v1/templates", { name: "house style" }, aliceSess)).status, 409, "names unique per account");
    const list = await call("GET", "/v1/templates", null, aliceSess);
    assert.equal(list.data.templates.length, 1);
    assert.equal((await call("GET", `/v1/templates/${houseId}`, null, aliceSess)).status, 200);
    // bob can neither read nor use alice's template
    assert.equal((await call("GET", `/v1/templates/${houseId}`, null, bobSess)).status, 404);
    assert.equal((await call("GET", "/v1/templates", null, bobSess)).data.templates.length, 0);
    assert.equal((await call("POST", "/v1/repos", { owner: "bob", repo: "borrowed", template: { templateId: houseId } }, bobSess)).status, 404);

    const fromTpl = await call("POST", "/v1/repos", { owner: "alice", repo: "from-house", template: { templateId: houseId } }, aliceSess);
    assert.equal(fromTpl.status, 201, JSON.stringify(fromTpl.data));
    assert.ok((await fileAt("alice", "from-house", "LICENSE", aliceSess)).includes("Apache License"), "saved Apache license lands");
    assert.equal(await fileAt("alice", "from-house", "docs/CHANGELOG.md", aliceSess), "# Changelog\n");
    assert.ok((await fileAt("alice", "from-house", ".gitignore", aliceSess)).includes("__pycache__/"));
    // inline override beats the saved template's license
    const overridden = await call("POST", "/v1/repos", {
      owner: "alice", repo: "from-house-mit",
      template: { templateId: houseId, license: "MIT" },
    }, aliceSess);
    assert.equal(overridden.status, 201);
    assert.ok((await fileAt("alice", "from-house-mit", "LICENSE", aliceSess)).includes("MIT License"), "inline license wins");
    assert.equal(await fileAt("alice", "from-house-mit", "docs/CHANGELOG.md", aliceSess), "# Changelog\n", "saved files still land");
    // a saved template's own README is never overwritten by scaffolding
    const own = await call("POST", "/v1/templates", {
      name: "own readme", readme: true,
      files: [{ path: "README.md", content: "# Mine\n" }],
    }, aliceSess);
    assert.equal(own.status, 201);
    const ownRepo = await call("POST", "/v1/repos", { owner: "alice", repo: "own-readme", template: { templateId: own.data.template.id } }, aliceSess);
    assert.equal(ownRepo.status, 201);
    assert.equal(await fileAt("alice", "own-readme", "README.md", aliceSess), "# Mine\n");

    // delete: bob cannot, alice can; afterwards the id is gone
    assert.equal((await call("DELETE", `/v1/templates/${houseId}`, null, bobSess)).status, 404);
    assert.equal((await call("DELETE", `/v1/templates/${houseId}`, null, aliceSess)).status, 200);
    assert.equal((await call("GET", `/v1/templates/${houseId}`, null, aliceSess)).status, 404);

    // ---- agents: forge scope creates (with templates); without it, 403
    const byAgent = await call("POST", "/v1/repos", {
      owner: "alice", repo: "agent-made", template: { license: "BSD-3-Clause" },
    }, aliceAgent);
    assert.equal(byAgent.status, 201, JSON.stringify(byAgent.data));
    assert.ok((await fileAt("alice", "agent-made", "LICENSE", aliceAgent)).includes("Redistribution and use in source and binary forms"));
    assert.equal((await call("POST", "/v1/repos", { owner: "alice", repo: "ws-agent-repo" }, aliceWsAgent)).status, 403, "no forge scope, no create");
    // agent can hold templates for its account
    const agTpl = await call("POST", "/v1/templates", { name: "agent tpl", license: "MIT" }, aliceAgent);
    assert.equal(agTpl.status, 201);
    assert.equal((await call("GET", "/v1/templates", null, aliceSess)).data.templates.some((t) => t.name === "agent tpl"), true, "agent-saved template belongs to the account");
  });

  it("createRepo lib-level: files land in the initial commit tree", () => {
    const dir = makeStateDir();
    const r = createRepo(dir, "libuser", "scaffolded", {
      files: [
        { path: "LICENSE", content: "MIT-ish\n" },
        { path: "src/deep/main.js", content: "export {};\n" },
      ],
    });
    assert.ok(r.initialCommit);
    const names = gitBare(dir, "libuser", "scaffolded", ["ls-tree", "-r", "--name-only", "main"]);
    assert.deepEqual(names.split("\n"), ["LICENSE", "src/deep/main.js"]);
    assert.equal(gitBare(dir, "libuser", "scaffolded", ["show", "main:src/deep/main.js"]), "export {};");
    assert.throws(() => createRepo(dir, "libuser", "bad", { files: [{ path: "../evil", content: "x" }] }), /invalid scaffold file/);
    assert.throws(() => createRepo(dir, "libuser", "bad2", {
      files: [{ path: "a.txt", content: "1" }, { path: "a.txt", content: "2" }],
    }), /duplicate path/);
  });
});
