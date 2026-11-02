/**
 * KILN Project Details: live per-repo facts derived from the hosted
 * bare repo (git plumbing + fs walk) plus the editable description /
 * topics persisted in the repo's kiln.json. Real bare repos, real
 * commits, real HTTP API on an ephemeral port — no mocks.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeStateDir } from "./helpers.mjs";
import { createRepo, repoPath } from "../lib/git.mjs";
import { createSite } from "../lib/sites.mjs";
import { createWorkspace } from "../lib/workspaces.mjs";
import {
  RepoDetailsError, repoDetails, updateRepoDetails, repoFactsSummary, repoVisibility,
} from "../lib/repodetails.mjs";
import { startApiServer } from "../lib/httpapi.mjs";
import { loadApiToken } from "../lib/state.mjs";

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd, encoding: "utf8", env: { ...process.env },
  }).trim();
}

const FILES = {
  "README.md": "# Widget\n\nA widget repo.\n",
  "src/main.js": "export const answer = 42;\n",
  "src/util.py": "def add(a, b):\n    return a + b\n",
  "notes.txt": "plain notes\n",
};

/**
 * Create a hosted repo and add TWO real commits on top of its seeded
 * initial commit: the FILES set, then one extra file. (Clone-based —
 * hosted repos are born with an initial commit, so an unrelated
 * history would be refused as non-fast-forward.) Returns { shas }
 * newest last.
 */
function seedMultiRepo(dir, owner, repo) {
  createRepo(dir, owner, repo);
  const seed = mkdtempSync(join(tmpdir(), "kiln-details-seed-"));
  const work = join(seed, "clone");
  git(seed, ["clone", "-q", repoPath(dir, owner, repo), "clone"]);
  git(work, ["config", "user.email", "test@kiln.local"]);
  git(work, ["config", "user.name", "kiln-test"]);
  for (const [path, content] of Object.entries(FILES)) {
    const idx = path.lastIndexOf("/");
    if (idx > 0) mkdirSync(join(work, path.slice(0, idx)), { recursive: true });
    writeFileSync(join(work, path), content);
  }
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", "widget: initial commit"]);
  const sha1 = git(work, ["rev-parse", "HEAD"]);
  writeFileSync(join(work, "EXTRA.md"), "extra file\n");
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", "widget: add extra"]);
  const sha2 = git(work, ["rev-parse", "HEAD"]);
  git(work, ["push", "-q", "origin", "main"]);
  return { shas: [sha1, sha2] };
}

function bytes(s) { return Buffer.byteLength(s, "utf8"); }

describe("repodetails: live derivation", () => {
  it("derives the full details object from a real multi-file, two-commit repo", () => {
    const dir = makeStateDir();
    const { shas } = seedMultiRepo(dir, "auro", "widget");
    const d = repoDetails(dir, "auro", "widget");

    assert.equal(d.repo, "auro/widget");
    assert.equal(d.owner, "auro");
    assert.equal(d.name, "widget");
    assert.ok(d.createdAt, "createdAt comes from kiln.json");
    assert.equal(d.description, "");
    assert.deepEqual(d.topics, []);
    assert.equal(d.empty, false);
    assert.equal(d.defaultBranch, "main");
    assert.equal(d.commitCount, 3); // seeded initial commit + the two pushed

    const expectedBytes =
      Object.values(FILES).reduce((s, c) => s + bytes(c), 0) + bytes("extra file\n");
    assert.equal(d.fileCount, 5);
    assert.equal(d.treeBytes, expectedBytes);
    assert.ok(d.diskBytes > d.treeBytes, "bare repo on disk is bigger than the tree");

    assert.equal(d.lastCommit.sha, shas[1]);
    assert.equal(d.lastCommit.shortSha, shas[1].slice(0, 7));
    assert.equal(d.lastCommit.subject, "widget: add extra");
    assert.equal(d.lastCommit.author, "kiln-test");
    assert.ok(d.lastCommit.date);
    assert.equal(d.recentActivity.length, 3);
    assert.equal(d.recentActivity[0].sha, shas[1]);
    assert.equal(d.recentActivity[1].sha, shas[0]);
    assert.equal(d.recentActivity[1].subject, "widget: initial commit");

    // Languages: bytes-weighted, top 8. Markdown = README + EXTRA.
    const byLang = Object.fromEntries(d.languages.map((l) => [l.language, l]));
    assert.equal(byLang.Markdown.files, 2);
    assert.equal(byLang.Markdown.bytes, bytes(FILES["README.md"]) + bytes("extra file\n"));
    assert.equal(byLang.JavaScript.files, 1);
    assert.equal(byLang.JavaScript.bytes, bytes(FILES["src/main.js"]));
    assert.equal(byLang.Python.files, 1);
    assert.equal(byLang.Python.bytes, bytes(FILES["src/util.py"]));
    assert.equal(byLang.Text.files, 1);
    const pctSum = d.languages.reduce((s, l) => s + l.pct, 0);
    assert.ok(Math.abs(pctSum - 100) < 0.5, `pct sums to ~100 (got ${pctSum})`);
    assert.equal(d.languages[0].language, "Markdown"); // largest by bytes

    assert.equal(d.readme.path, "README.md");
    assert.equal(d.readme.title, "Widget"); // first ATX H1, "# " stripped
    assert.equal(d.readme.content, FILES["README.md"]);
    assert.equal(d.readme.truncated, false);

    assert.deepEqual(d.workspaces, []);
    assert.equal(d.site, null);
    assert.equal(d.ci, null); // no CI result recorded — null, never invented
  });

  it("a fresh repo reports its seeded initial commit, with zero files — not an error", () => {
    const dir = makeStateDir();
    // Repos are born with an initial commit now, so a brand-new repo
    // is not "empty": it has exactly one commit and an empty tree.
    const { initialCommit } = createRepo(dir, "auro", "blank");
    const d = repoDetails(dir, "auro", "blank");
    assert.equal(d.empty, false);
    assert.equal(d.defaultBranch, "main");
    assert.equal(d.commitCount, 1);
    assert.equal(d.fileCount, 0);
    assert.equal(d.treeBytes, 0);
    assert.ok(d.diskBytes > 0, "the bare repo itself occupies disk");
    assert.equal(d.lastCommit.sha, initialCommit);
    assert.equal(d.lastCommit.subject, "chore: initialize repository");
    assert.equal(d.lastCommit.author, "KILN Operator");
    assert.equal(d.recentActivity.length, 1);
    assert.equal(d.recentActivity[0].sha, initialCommit);
    assert.deepEqual(d.languages, []);
    assert.equal(d.readme, null);
    assert.equal(d.ci, null);
  });

  it("repoFactsSummary is exactly the economical summary — no readme, no extras", () => {
    const dir = makeStateDir();
    const { shas } = seedMultiRepo(dir, "auro", "widget");
    const s = repoFactsSummary(dir, "auro", "widget");
    assert.deepEqual(Object.keys(s).sort(),
      ["commitCount", "defaultBranch", "description", "lastCommit", "topics"]);
    assert.equal(s.defaultBranch, "main");
    assert.equal(s.commitCount, 3);
    assert.equal(s.lastCommit.sha, shas[1]);
  });
});

describe("repodetails: editable metadata in kiln.json", () => {
  it("description/topics roundtrip; unknown kiln.json fields are preserved", () => {
    const dir = makeStateDir();
    seedMultiRepo(dir, "auro", "widget");
    const p = join(repoPath(dir, "auro", "widget"), "kiln.json");
    const before = JSON.parse(readFileSync(p, "utf8"));
    assert.equal(before.schema, "kiln.git-repo.v1");
    // A field no details code knows about — it must survive edits.
    writeFileSync(p, JSON.stringify({ ...before, customField: { keep: "me" } }, null, 2) + "\n");

    const updated = updateRepoDetails(dir, "auro", "widget", {
      description: "The widget service", topics: ["widget", "demo-thing"],
    });
    assert.equal(updated.description, "The widget service");
    assert.deepEqual(updated.topics, ["widget", "demo-thing"]);

    const after1 = JSON.parse(readFileSync(p, "utf8"));
    assert.deepEqual(after1.customField, { keep: "me" });
    assert.equal(after1.schema, "kiln.git-repo.v1");
    assert.equal(after1.createdAt, before.createdAt);
    assert.equal(after1.description, "The widget service");

    // A topics-only patch leaves the description alone (and vice versa).
    const tOnly = updateRepoDetails(dir, "auro", "widget", { topics: ["solo"] });
    assert.equal(tOnly.description, "The widget service");
    assert.deepEqual(tOnly.topics, ["solo"]);
    const reread = repoDetails(dir, "auro", "widget");
    assert.equal(reread.description, "The widget service");
    assert.deepEqual(reread.topics, ["solo"]);
  });

  it("a repo whose kiln.json is missing reads defaults; the first update creates it", () => {
    const dir = makeStateDir();
    seedMultiRepo(dir, "auro", "widget");
    const p = join(repoPath(dir, "auro", "widget"), "kiln.json");
    execFileSync("rm", [p]);
    const d = repoDetails(dir, "auro", "widget");
    assert.equal(d.createdAt, null);
    assert.equal(d.description, "");
    assert.deepEqual(d.topics, []);
    const updated = updateRepoDetails(dir, "auro", "widget", { description: "born now" });
    assert.equal(updated.description, "born now");
    assert.equal(existsSync(p), true);
    // createdAt is NOT invented by the first metadata write.
    assert.equal(updated.createdAt, null);
  });

  it("rejects invalid topics and oversized descriptions with 400", () => {
    const dir = makeStateDir();
    seedMultiRepo(dir, "auro", "widget");
    const is400 = (e) => e instanceof RepoDetailsError && e.status === 400;
    assert.throws(() => updateRepoDetails(dir, "auro", "widget", { topics: ["Bad_Topic!"] }), is400);
    assert.throws(() => updateRepoDetails(dir, "auro", "widget", { topics: ["-leading-dash"] }), is400);
    assert.throws(
      () => updateRepoDetails(dir, "auro", "widget", { topics: Array.from({ length: 17 }, (_, i) => `t${i}`) }),
      is400
    );
    assert.throws(
      () => updateRepoDetails(dir, "auro", "widget", { description: "x".repeat(1025) }),
      is400
    );
    // Refused writes persisted nothing.
    assert.equal(repoDetails(dir, "auro", "widget").description, "");
  });

  it("visibility defaults to private, flips via update, and reads fail-closed", () => {
    const dir = makeStateDir();
    seedMultiRepo(dir, "auro", "widget");
    // Default: kiln.json carries no visibility -> private everywhere.
    assert.equal(repoDetails(dir, "auro", "widget").visibility, "private");
    assert.equal(repoVisibility(dir, "auro", "widget"), "private");
    // The owner flips it public; details, the gate helper and the
    // persisted kiln.json all agree.
    const d = updateRepoDetails(dir, "auro", "widget", { visibility: "public" });
    assert.equal(d.visibility, "public");
    assert.equal(repoVisibility(dir, "auro", "widget"), "public");
    const meta = JSON.parse(readFileSync(join(repoPath(dir, "auro", "widget"), "kiln.json"), "utf8"));
    assert.equal(meta.visibility, "public");
    // And back to private.
    assert.equal(
      updateRepoDetails(dir, "auro", "widget", { visibility: "private" }).visibility,
      "private"
    );
    // Invalid values are refused (400) and persist nothing.
    const is400 = (e) => e instanceof RepoDetailsError && e.status === 400;
    assert.throws(() => updateRepoDetails(dir, "auro", "widget", { visibility: "everyone" }), is400);
    assert.throws(() => updateRepoDetails(dir, "auro", "widget", { visibility: "PUBLIC" }), is400);
    assert.equal(repoVisibility(dir, "auro", "widget"), "private");
    // A corrupt / hand-written value reads private — the gates fail
    // closed, never open.
    writeFileSync(
      join(repoPath(dir, "auro", "widget"), "kiln.json"),
      JSON.stringify({ schema: "kiln.git-repo.v1", owner: "auro", repo: "widget", visibility: "yes" })
    );
    assert.equal(repoVisibility(dir, "auro", "widget"), "private");
    assert.equal(repoDetails(dir, "auro", "widget").visibility, "private");
    // Unknown repos read private too.
    assert.equal(repoVisibility(dir, "auro", "ghost"), "private");
  });

  it("unknown repos 404 across details, summary, and update", () => {
    const dir = makeStateDir();
    const is404 = (e) => e instanceof RepoDetailsError && e.status === 404;
    assert.throws(() => repoDetails(dir, "auro", "ghost"), is404);
    assert.throws(() => repoFactsSummary(dir, "auro", "ghost"), is404);
    assert.throws(() => updateRepoDetails(dir, "auro", "ghost", { description: "x" }), is404);
  });
});

describe("repodetails: membership + linked site", () => {
  it("surfaces workspace memberships (with parentId) and the linked site with its role", () => {
    const dir = makeStateDir();
    seedMultiRepo(dir, "auro", "widget");
    seedMultiRepo(dir, "auro", "widget-api");
    const site = createSite(dir, {
      name: "widget-site", frontend: "auro/widget", backend: "auro/widget-api", actor: "test",
    });
    const parent = createWorkspace(dir, { owner: "auro", slug: "lab", name: "Lab", repos: [], actor: "test" });
    const ws = createWorkspace(dir, {
      owner: "auro", slug: "widgets", name: "Widgets",
      repos: ["auro/widget", "auro/widget-api"], siteIds: [site.id],
      parentId: parent.id, actor: "test",
    });

    const d = repoDetails(dir, "auro", "widget");
    assert.deepEqual(d.workspaces, [{
      id: ws.id, owner: "auro", slug: "widgets", name: "Widgets", parentId: parent.id,
    }]);
    assert.deepEqual(d.site, { id: site.id, name: "widget-site", role: "frontend" });

    const back = repoDetails(dir, "auro", "widget-api");
    assert.deepEqual(back.site, { id: site.id, name: "widget-site", role: "backend" });
    assert.equal(back.workspaces.length, 1);
  });
});

describe("repodetails: HTTP API", () => {
  let api;
  after(() => { try { api?.server?.close(); } catch { /* already closed */ } });

  it("GET/PATCH details over HTTP (auth enforced, 404 unknown, 400 invalid)", async () => {
    const dir = makeStateDir();
    seedMultiRepo(dir, "auro", "widget");
    process.env.KILN_SWARM_API_PORT = "0";
    try {
      api = await startApiServer(dir, { apiPort: 0 });
    } finally {
      delete process.env.KILN_SWARM_API_PORT;
    }
    const token = loadApiToken(dir);
    const call = async (method, path, body, auth = true) => {
      const res = await fetch(api.url + path, {
        method,
        headers: {
          ...(auth ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, data: await res.json().catch(() => ({})) };
    };

    assert.equal((await call("GET", "/v1/repos/auro/widget/details", null, false)).status, 401);

    const got = await call("GET", "/v1/repos/auro/widget/details");
    assert.equal(got.status, 200);
    assert.equal(got.data.repo, "auro/widget");
    assert.equal(got.data.commitCount, 3);
    assert.equal(got.data.readme.path, "README.md");

    const patched = await call("PATCH", "/v1/repos/auro/widget/details", {
      description: "Over HTTP", topics: ["http", "live"],
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.data.ok, true);
    assert.equal(patched.data.details.description, "Over HTTP");
    assert.deepEqual(patched.data.details.topics, ["http", "live"]);
    assert.equal((await call("GET", "/v1/repos/auro/widget/details")).data.description, "Over HTTP");

    assert.equal((await call("PATCH", "/v1/repos/auro/widget/details", { topics: ["NOPE"] })).status, 400);
    assert.equal((await call("GET", "/v1/repos/auro/ghost/details")).status, 404);
    assert.equal((await call("PATCH", "/v1/repos/auro/ghost/details", { description: "x" })).status, 404);

    // Visibility over HTTP: private by default, PATCH flips it,
    // details GET returns it, invalid values are 400.
    assert.equal(got.data.visibility, "private");
    const flipped = await call("PATCH", "/v1/repos/auro/widget/details", { visibility: "public" });
    assert.equal(flipped.status, 200);
    assert.equal(flipped.data.details.visibility, "public");
    assert.equal((await call("GET", "/v1/repos/auro/widget/details")).data.visibility, "public");
    assert.equal((await call("PATCH", "/v1/repos/auro/widget/details", { visibility: "friends" })).status, 400);
    assert.equal((await call("GET", "/v1/repos/auro/widget/details")).data.visibility, "public");

    // Discovery rides the same server + auth.
    assert.equal((await call("GET", "/v1/capabilities", null, false)).status, 401);
    const caps = await call("GET", "/v1/capabilities");
    assert.equal(caps.status, 200);
    const abilityIds = caps.data.abilities.map((a) => a.id);
    assert.ok(abilityIds.includes("workspaces"));
    assert.ok(abilityIds.includes("project-details"));
    assert.ok(abilityIds.includes("sites")); // site-id discovery is part of the surface
    assert.equal(caps.data.openapi, "/v1/openapi.json");

    const spec = await call("GET", "/v1/openapi.json");
    assert.equal(spec.status, 200);
    assert.equal(spec.data.openapi, "3.1.0");
    assert.ok(spec.data.paths["/v1/workspaces"]);
    assert.ok(spec.data.paths["/v1/workspaces/{id}"].patch);
    assert.ok(spec.data.paths["/v1/repos/{owner}/{repo}/details"].get);
    assert.ok(spec.data.paths["/v1/repos/{owner}/{repo}/details"].patch);
    assert.ok(spec.data.paths["/v1/sites"].get);
    assert.ok(spec.data.paths["/v1/capabilities"].get);
    // The spec describes the instance that served it — never a hardcoded port.
    assert.equal(spec.data.servers[0].url, "/");
  });
});
