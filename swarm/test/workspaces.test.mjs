/**
 * KILN Workspaces: first-class grouping of member repos + linked sites
 * under one owner. Real bare repos, real memory writes, real HTTP API on
 * an ephemeral port — no mocks. Mirrors test/sites.test.mjs.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeStateDir } from "./helpers.mjs";
import { createRepo, repoPath } from "../lib/git.mjs";
import { loadMemory } from "../lib/memory.mjs";
import { createSite, deleteSite } from "../lib/sites.mjs";
import {
  WorkspacesError, createWorkspace, listWorkspaces, workspaceTree, getWorkspace,
  resolveWorkspace, updateWorkspace, deleteWorkspace, workspaceStatus,
} from "../lib/workspaces.mjs";
import { startApiServer } from "../lib/httpapi.mjs";
import { loadApiToken } from "../lib/state.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function git(cwd, args, env) {
  return execFileSync("git", args, {
    cwd, encoding: "utf8", env: { ...process.env, ...(env || {}) },
  }).trim();
}

/** Push one real commit into an already-created hosted repo. Returns the sha. */
function pushCommit(dir, owner, repo, subject) {
  const work = mkdtempSync(join(tmpdir(), "kiln-ws-seed-"));
  const bare = repoPath(dir, owner, repo);
  // A real client's second push clones the hosted repo and builds on
  // its HEAD. A fresh init would create unrelated history and the push
  // would be rejected as non-fast-forward — so clone when the hosted
  // repo already has a HEAD, init only when it is still empty.
  let hasHead = true;
  try { git(work, ["--git-dir", bare, "rev-parse", "-q", "--verify", "HEAD"]); }
  catch { hasHead = false; }
  if (hasHead) git(work, ["clone", "-q", bare, "."]);
  else git(work, ["init", "-q", "-b", "main"]);
  git(work, ["config", "user.email", "test@kiln.local"]);
  git(work, ["config", "user.name", "kiln-test"]);
  // The subject line keeps every commit's tree distinct (a second
  // commit with identical content would have nothing to commit).
  writeFileSync(join(work, "README.md"), `# ${repo}\n\n${subject}\n`);
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", subject]);
  git(work, ["push", "-q", bare, "main"]);
  return git(work, ["rev-parse", "HEAD"]);
}

/** Create a hosted repo and push one real commit to it. Returns the commit sha. */
function seedRepo(dir, owner, repo, subject) {
  createRepo(dir, owner, repo);
  return pushCommit(dir, owner, repo, subject);
}

/** Push a follow-up commit that builds on the hosted repo's current HEAD. */
function pushSecondCommit(dir, owner, repo, subject) {
  const work = mkdtempSync(join(tmpdir(), "kiln-ws-seed2-"));
  git(work, ["clone", "-q", repoPath(dir, owner, repo), "clone"]);
  const clone = join(work, "clone");
  git(clone, ["config", "user.email", "test@kiln.local"]);
  git(clone, ["config", "user.name", "kiln-test"]);
  writeFileSync(join(clone, "SECOND.md"), "second\n");
  git(clone, ["add", "-A"]);
  git(clone, ["commit", "-q", "-m", subject]);
  git(clone, ["push", "-q", "origin", "main"]);
  return git(clone, ["rev-parse", "HEAD"]);
}

function coreOf(dir, owner, repo) {
  const { core } = loadMemory(dir, owner, repo);
  return Object.fromEntries(core.map((c) => [c.label, c.value]));
}

/** A state dir with the four DFW-shaped repos + one site linking two of them. */
function dfwDir() {
  const dir = makeStateDir();
  const shas = {
    app: seedRepo(dir, "auro", "dfw-service-hub", "app: initial commit"),
    edge: seedRepo(dir, "auro", "dfw-edge", "edge: initial commit"),
    harness: seedRepo(dir, "auro", "dfw-harness", "harness: initial commit"),
    docs: seedRepo(dir, "auro", "dfw-workspace", "docs: initial commit"),
  };
  const site = createSite(dir, {
    name: "dfw-haul", frontend: "auro/dfw-service-hub", backend: "auro/dfw-edge",
    actor: "test",
  });
  return { dir, shas, site };
}

const DFW_REPOS = ["auro/dfw-service-hub", "auro/dfw-edge", "auro/dfw-harness", "auro/dfw-workspace"];

describe("workspaces: registry + memory linkage", () => {
  it("creates a workspace, persists it, and writes the workspace core block into every member repo", () => {
    const { dir, site } = dfwDir();
    const ws = createWorkspace(dir, {
      owner: "auro", slug: "dfw-haul", name: "DFW Haul",
      description: "Box truck / moving / hauling marketplace",
      repos: DFW_REPOS, siteIds: [site.id], actor: "test",
    });
    assert.ok(ws.id.startsWith("ws_"));
    assert.deepEqual(ws.repos, DFW_REPOS);
    assert.deepEqual(ws.siteIds, [site.id]);
    assert.equal(ws.createdAt, ws.updatedAt);

    const onDisk = JSON.parse(readFileSync(join(dir, "workspaces.json"), "utf8"));
    assert.equal(onDisk.workspaces[ws.id].slug, "dfw-haul");

    for (const ref of DFW_REPOS) {
      const [o, r] = ref.split("/");
      assert.equal(coreOf(dir, o, r).workspace, `dfw-haul (${ws.id})`, `${ref} memory`);
    }
  });

  it("lists (owner-filtered), gets, and resolves by id, prefix, and slug", () => {
    const { dir } = dfwDir();
    const ws = createWorkspace(dir, { owner: "auro", slug: "dfw-haul", name: "DFW Haul", repos: DFW_REPOS, actor: "test" });
    createWorkspace(dir, { owner: "other", slug: "side", name: "Side", repos: [], actor: "test" });
    assert.equal(listWorkspaces(dir).length, 2);
    assert.equal(listWorkspaces(dir, { owner: "auro" }).length, 1);
    assert.equal(getWorkspace(dir, ws.id).slug, "dfw-haul");
    assert.equal(resolveWorkspace(dir, "dfw-haul").id, ws.id);
    assert.equal(resolveWorkspace(dir, ws.id.slice(0, 8)).id, ws.id);
    assert.throws(() => getWorkspace(dir, "ws_nope"), (e) => e instanceof WorkspacesError && e.status === 404);
  });

  it("rejects duplicates, bad slugs, ghost repos, and ghost sites — leaving nothing behind", () => {
    const { dir, site } = dfwDir();
    const opts = { owner: "auro", slug: "dfw-haul", name: "DFW Haul", repos: DFW_REPOS, actor: "test" };
    createWorkspace(dir, opts);
    assert.throws(() => createWorkspace(dir, opts), (e) => e instanceof WorkspacesError && e.status === 409);
    assert.throws(
      () => createWorkspace(dir, { owner: "auro", slug: "Bad Slug", name: "X", repos: [] }),
      (e) => e instanceof WorkspacesError && e.status === 400
    );
    assert.throws(
      () => createWorkspace(dir, { owner: "auro", slug: "ghostly", name: "X", repos: ["auro/ghost"] }),
      (e) => e instanceof WorkspacesError && e.status === 404
    );
    assert.throws(
      () => createWorkspace(dir, { owner: "auro", slug: "ghostsite", name: "X", repos: [], siteIds: ["site_nope"] }),
      (e) => e instanceof WorkspacesError && e.status === 404
    );
    assert.equal(listWorkspaces(dir).length, 1);
    assert.ok(site.id); // fixture sanity
  });

  it("a failed create writes no registry file at all", () => {
    const dir = makeStateDir();
    seedRepo(dir, "auro", "only", "only commit");
    assert.throws(
      () => createWorkspace(dir, { owner: "auro", slug: "x", name: "X", repos: ["auro/only", "auro/ghost"] }),
      (e) => e instanceof WorkspacesError && e.status === 404
    );
    assert.equal(existsSync(join(dir, "workspaces.json")), false);
  });
});

describe("workspaces: update + guarded delete", () => {
  it("renames, redescribes, adds/removes repos (memory written for adds), links/unlinks sites", () => {
    const { dir, site } = dfwDir();
    seedRepo(dir, "auro", "extra", "extra commit");
    const ws = createWorkspace(dir, {
      owner: "auro", slug: "dfw-haul", name: "DFW Haul", repos: ["auro/dfw-service-hub"], actor: "test",
    });
    const next = updateWorkspace(dir, ws.id, {
      name: "DFW Haul - Marketplace", description: "now with words",
      addRepos: ["auro/extra", "auro/dfw-edge"], removeRepos: ["auro/dfw-service-hub"],
      linkSites: [site.id],
    }, { actor: "test" });
    assert.equal(next.name, "DFW Haul - Marketplace");
    assert.equal(next.description, "now with words");
    assert.deepEqual(next.repos, ["auro/extra", "auro/dfw-edge"]);
    assert.deepEqual(next.siteIds, [site.id]);
    assert.ok(next.updatedAt >= ws.updatedAt);
    assert.equal(coreOf(dir, "auro", "extra").workspace, `dfw-haul (${ws.id})`);

    const un = updateWorkspace(dir, ws.id, { unlinkSites: [site.id] }, { actor: "test" });
    assert.deepEqual(un.siteIds, []);
    assert.throws(
      () => updateWorkspace(dir, ws.id, { addRepos: ["auro/ghost"] }),
      (e) => e instanceof WorkspacesError && e.status === 404
    );
    assert.throws(
      () => updateWorkspace(dir, "ws_nope", { name: "X" }),
      (e) => e instanceof WorkspacesError && e.status === 404
    );
  });

  it("delete requires the slug as explicit confirmation and removes only the registry entry", () => {
    const { dir, shas } = dfwDir();
    const ws = createWorkspace(dir, { owner: "auro", slug: "dfw-haul", name: "DFW Haul", repos: DFW_REPOS, actor: "test" });
    assert.throws(
      () => deleteWorkspace(dir, ws.id, {}),
      (e) => e instanceof WorkspacesError && e.status === 400
    );
    assert.throws(
      () => deleteWorkspace(dir, ws.id, { confirm: "wrong" }),
      (e) => e instanceof WorkspacesError && e.status === 400
    );
    assert.equal(listWorkspaces(dir).length, 1);
    assert.deepEqual(deleteWorkspace(dir, ws.id, { confirm: "dfw-haul" }), { ok: true, id: ws.id });
    assert.equal(listWorkspaces(dir).length, 0);
    assert.throws(() => getWorkspace(dir, ws.id), (e) => e instanceof WorkspacesError && e.status === 404);
    // Repo + its memory linkage are untouched.
    assert.equal(coreOf(dir, "auro", "dfw-edge").workspace, `dfw-haul (${ws.id})`);
    assert.ok(shas.edge);
  });
});

describe("workspaces: aggregated live status", () => {
  it("reports member repo HEADs + branches, linked sites, and memory linkage — live", () => {
    const { dir, shas, site } = dfwDir();
    const ws = createWorkspace(dir, {
      owner: "auro", slug: "dfw-haul", name: "DFW Haul",
      repos: DFW_REPOS, siteIds: [site.id], actor: "test",
    });
    const st = workspaceStatus(dir, ws.id);
    assert.equal(st.workspace.id, ws.id);
    const byRepo = Object.fromEntries(st.repos.map((r) => [r.repo, r]));
    assert.equal(byRepo["auro/dfw-service-hub"].head.sha, shas.app);
    assert.equal(byRepo["auro/dfw-service-hub"].head.subject, "app: initial commit");
    assert.equal(byRepo["auro/dfw-service-hub"].branch, "main");
    assert.equal(byRepo["auro/dfw-edge"].head.sha, shas.edge);
    assert.equal(st.sites.length, 1);
    assert.equal(st.sites[0].found, true);
    assert.equal(st.sites[0].name, "dfw-haul");
    assert.equal(st.sites[0].frontend, "auro/dfw-service-hub");
    assert.equal(st.memory.linked, true);
    for (const ref of DFW_REPOS) assert.equal(st.memory.repos[ref].present, true);

    // A new commit moves the status — nothing is cached.
    const sha2 = pushSecondCommit(dir, "auro", "dfw-edge", "edge: second commit");
    const st2 = workspaceStatus(dir, ws.id);
    assert.equal(Object.fromEntries(st2.repos.map((r) => [r.repo, r]))["auro/dfw-edge"].head.sha, sha2);
  });

  it("an empty member repo reports head: null, not an error", () => {
    const dir = makeStateDir();
    // A legacy member with NO commits at all (hosted repos are born
    // with an initial commit now, so this state is hand-made the old way).
    const emptyPath = repoPath(dir, "auro", "empty-one");
    mkdirSync(dirname(emptyPath), { recursive: true });
    execFileSync("git", ["init", "--bare", "--initial-branch=main", emptyPath], { stdio: "ignore" });
    seedRepo(dir, "auro", "full-one", "full commit");
    const ws = createWorkspace(dir, {
      owner: "auro", slug: "mixed", name: "Mixed",
      repos: ["auro/empty-one", "auro/full-one"], actor: "test",
    });
    const st = workspaceStatus(dir, ws.id);
    const byRepo = Object.fromEntries(st.repos.map((r) => [r.repo, r]));
    assert.equal(byRepo["auro/empty-one"].exists, true);
    assert.equal(byRepo["auro/empty-one"].head, null);
    assert.ok(byRepo["auro/full-one"].head.sha);
  });
});

describe("workspaces: removing members that no longer exist", () => {
  it("a repo deleted from the forge stays removable; a deleted site stays unlinkable", () => {
    const { dir, site } = dfwDir();
    const ws = createWorkspace(dir, {
      owner: "auro", slug: "dfw-haul", name: "DFW Haul",
      repos: DFW_REPOS, siteIds: [site.id], actor: "test",
    });
    // The forge moves on first: member repo deleted, site deleted.
    rmSync(repoPath(dir, "auro", "dfw-harness"), { recursive: true, force: true });
    deleteSite(dir, site.id);

    const next = updateWorkspace(dir, ws.id, {
      removeRepos: ["auro/dfw-harness"], unlinkSites: [site.id],
    }, { actor: "test" });
    assert.deepEqual(next.repos, ["auro/dfw-service-hub", "auro/dfw-edge", "auro/dfw-workspace"]);
    assert.deepEqual(next.siteIds, []);

    // Status agrees: no ghost member remains to report on.
    const st = workspaceStatus(dir, ws.id);
    assert.deepEqual(st.repos.map((r) => r.repo), next.repos);
    assert.equal(st.sites.length, 0);
  });

  it("removals still reject malformed refs (400), and removing a non-member is a no-op", () => {
    const { dir } = dfwDir();
    const ws = createWorkspace(dir, {
      owner: "auro", slug: "dfw-haul", name: "DFW Haul", repos: ["auro/dfw-edge"], actor: "test",
    });
    assert.throws(
      () => updateWorkspace(dir, ws.id, { removeRepos: ["not-a-ref"] }),
      (e) => e instanceof WorkspacesError && e.status === 400
    );
    assert.throws(
      () => updateWorkspace(dir, ws.id, { unlinkSites: [""] }),
      (e) => e instanceof WorkspacesError && e.status === 400
    );
    const next = updateWorkspace(dir, ws.id, { removeRepos: ["auro/dfw-service-hub"] }, { actor: "test" });
    assert.deepEqual(next.repos, ["auro/dfw-edge"]);
  });

  it("an empty workspace reports memory.linked = true (nothing is unlinked)", () => {
    const dir = makeStateDir();
    const ws = createWorkspace(dir, { owner: "auro", slug: "empty", name: "Empty", repos: [], actor: "test" });
    const st = workspaceStatus(dir, ws.id);
    assert.deepEqual(st.repos, []);
    assert.equal(st.memory.linked, true);
  });
});

describe("workspaces: HTTP API", () => {
  let api;
  after(() => { try { api?.server?.close(); } catch { /* already closed */ } });

  it("serves the full workspaces lifecycle over HTTP (auth enforced, delete guarded)", async () => {
    const dir = makeStateDir();
    process.env.KILN_SWARM_API_PORT = "0";
    try {
      api = await startApiServer(dir, { apiPort: 0 });
    } finally {
      delete process.env.KILN_SWARM_API_PORT;
    }
    const base = api.url;
    const token = loadApiToken(dir);
    const call = async (method, path, body, auth = true) => {
      const res = await fetch(base + path, {
        method,
        headers: {
          ...(auth ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, data: await res.json().catch(() => ({})) };
    };

    // Auth gate: workspace routes are NOT public.
    assert.equal((await call("GET", "/v1/workspaces", null, false)).status, 401);
    assert.equal((await call("POST", "/v1/workspaces", {}, false)).status, 401);

    // Repos + a site first (hosted git create + sites are API routes too).
    for (const r of ["dfw-service-hub", "dfw-edge", "dfw-harness", "dfw-workspace"]) {
      assert.equal((await call("POST", `/git/auro/${r}`)).status, 201);
      pushCommit(dir, "auro", r, `${r}: initial commit`);
    }
    const siteRes = await call("POST", "/v1/sites", {
      name: "dfw-haul", frontend: "auro/dfw-service-hub", backend: "auro/dfw-edge",
    });
    assert.equal(siteRes.status, 201);
    const siteId = siteRes.data.site.id;

    // Create.
    const created = await call("POST", "/v1/workspaces", {
      owner: "auro", slug: "dfw-haul", name: "DFW Haul",
      description: "Box truck / moving / hauling marketplace",
      repos: DFW_REPOS, siteIds: [siteId],
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.ok, true);
    const id = created.data.workspace.id;
    assert.ok(id.startsWith("ws_"));

    // Memory linkage landed (checked through the memory API).
    const core = await call("GET", "/git/auro/dfw-harness/memory/core");
    const labels = Object.fromEntries(core.data.core.map((c) => [c.label, c.value]));
    assert.equal(labels.workspace, `dfw-haul (${id})`);

    // Duplicate + validation + ghost refs.
    assert.equal((await call("POST", "/v1/workspaces", { owner: "auro", slug: "dfw-haul", name: "Dup", repos: [] })).status, 409);
    assert.equal((await call("POST", "/v1/workspaces", { owner: "auro", slug: "Bad Slug", name: "X", repos: [] })).status, 400);
    assert.equal((await call("POST", "/v1/workspaces", { owner: "auro", slug: "ghostly", name: "X", repos: ["auro/ghost"] })).status, 404);

    // List + owner filter.
    const list = await call("GET", "/v1/workspaces");
    assert.equal(list.data.workspaces.length, 1);
    assert.equal((await call("GET", "/v1/workspaces?owner=auro")).data.workspaces.length, 1);
    assert.equal((await call("GET", "/v1/workspaces?owner=nobody")).data.workspaces.length, 0);

    // Tree view over HTTP: the single workspace is a root with no children.
    const treeRes = await call("GET", "/v1/workspaces?tree=1");
    assert.equal(treeRes.status, 200);
    assert.equal(treeRes.data.workspaces.length, 1);
    assert.equal(treeRes.data.workspaces[0].id, id);
    assert.equal(treeRes.data.workspaces[0].parentId, null);
    assert.deepEqual(treeRes.data.workspaces[0].children, []);

    // Aggregated status.
    const st = await call("GET", `/v1/workspaces/${id}`);
    assert.equal(st.status, 200);
    assert.equal(st.data.workspace.slug, "dfw-haul");
    const byRepo = Object.fromEntries(st.data.repos.map((r) => [r.repo, r]));
    assert.equal(byRepo["auro/dfw-edge"].head.subject, "dfw-edge: initial commit");
    assert.equal(byRepo["auro/dfw-edge"].branch, "main");
    assert.equal(st.data.sites[0].id, siteId);
    assert.equal(st.data.memory.linked, true);

    // Patch: rename + remove a repo + unlink the site.
    const patched = await call("PATCH", `/v1/workspaces/${id}`, {
      name: "DFW Haul - Marketplace", removeRepos: ["auro/dfw-harness"], unlinkSites: [siteId],
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.data.workspace.name, "DFW Haul - Marketplace");
    assert.deepEqual(patched.data.workspace.repos, ["auro/dfw-service-hub", "auro/dfw-edge", "auro/dfw-workspace"]);
    assert.deepEqual(patched.data.workspace.siteIds, []);

    // Nesting over HTTP: create a child under dfw-haul, then clear its
    // parent with setParent: null, then refuse a self-parent cycle.
    const childRes = await call("POST", "/v1/workspaces", {
      owner: "auro", slug: "dfw-child", name: "DFW Child", repos: [], parentId: id,
    });
    assert.equal(childRes.status, 201);
    assert.equal(childRes.data.workspace.parentId, id);
    const childId = childRes.data.workspace.id;
    assert.equal((await call("POST", "/v1/workspaces", {
      owner: "auro", slug: "dfw-orphan", name: "Orphan", repos: [], parentId: "ws_nope",
    })).status, 404);
    const cleared = await call("PATCH", `/v1/workspaces/${childId}`, { setParent: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.data.workspace.parentId, null);
    // A PATCH without setParent leaves the parent untouched.
    const renamed = await call("PATCH", `/v1/workspaces/${childId}`, { name: "DFW Child Renamed" });
    assert.equal(renamed.data.workspace.parentId, null);
    const reParented = await call("PATCH", `/v1/workspaces/${childId}`, { setParent: id });
    assert.equal(reParented.data.workspace.parentId, id);
    assert.equal((await call("PATCH", `/v1/workspaces/${childId}`, { setParent: childId })).status, 400);
    assert.equal((await call("DELETE", `/v1/workspaces/${childId}`, { confirm: "dfw-child" })).status, 200);

    // Delete is guarded: no confirm → 400; wrong confirm → 400; slug → 200.
    assert.equal((await call("DELETE", `/v1/workspaces/${id}`, {})).status, 400);
    assert.equal((await call("DELETE", `/v1/workspaces/${id}`, { confirm: "nope" })).status, 400);
    assert.equal((await call("DELETE", `/v1/workspaces/${id}`, { confirm: "dfw-haul" })).status, 200);
    assert.equal((await call("GET", `/v1/workspaces/${id}`)).status, 404);
    assert.equal((await call("GET", "/v1/workspaces")).data.workspaces.length, 0);
  });
});

describe("workspaces: nesting", () => {
  function bareWs(dir, slug, extra = {}) {
    return createWorkspace(dir, {
      owner: "auro", slug, name: slug, repos: [], actor: "test", ...extra,
    });
  }

  it("creates with a parent; a record without the field reads as a root (null)", () => {
    const dir = makeStateDir();
    const root = bareWs(dir, "lab");
    assert.equal(root.parentId, null);
    const child = bareWs(dir, "product", { parentId: root.id });
    assert.equal(child.parentId, root.id);
    assert.equal(getWorkspace(dir, child.id).parentId, root.id);

    // Pre-nesting record shape: strip parentId from the on-disk record —
    // it must read back as null everywhere, with no migration write.
    const p = join(dir, "workspaces.json");
    const onDisk = JSON.parse(readFileSync(p, "utf8"));
    delete onDisk.workspaces[root.id].parentId;
    writeFileSync(p, JSON.stringify(onDisk, null, 2) + "\n");
    assert.equal(getWorkspace(dir, root.id).parentId, null);
    assert.equal(listWorkspaces(dir).find((w) => w.id === root.id).parentId, null);
  });

  it("create refuses a missing parent (404) and a cross-owner parent (400, says the rule)", () => {
    const dir = makeStateDir();
    const foreign = createWorkspace(dir, { owner: "other", slug: "theirs", name: "Theirs", repos: [], actor: "test" });
    assert.throws(
      () => bareWs(dir, "orphan", { parentId: "ws_nope" }),
      (e) => e instanceof WorkspacesError && e.status === 404
    );
    assert.throws(
      () => bareWs(dir, "crossed", { parentId: foreign.id }),
      (e) => e instanceof WorkspacesError && e.status === 400 && /parents must share the workspace's owner/.test(e.message)
    );
    assert.equal(listWorkspaces(dir).length, 1); // nothing half-created
  });

  it("setParent reparents and clears; absent key leaves the parent untouched", () => {
    const dir = makeStateDir();
    const root = bareWs(dir, "lab");
    const child = bareWs(dir, "product");
    assert.equal(child.parentId, null);

    const moved = updateWorkspace(dir, child.id, { setParent: root.id }, { actor: "test" });
    assert.equal(moved.parentId, root.id);
    const renamed = updateWorkspace(dir, child.id, { name: "Product Renamed" }, { actor: "test" });
    assert.equal(renamed.parentId, root.id);
    const cleared = updateWorkspace(dir, child.id, { setParent: null }, { actor: "test" });
    assert.equal(cleared.parentId, null);
    assert.throws(
      () => updateWorkspace(dir, child.id, { setParent: "ws_nope" }),
      (e) => e instanceof WorkspacesError && e.status === 404
    );
  });

  it("refuses self-parenting and the indirect cycle A→B→C→A (400, names the chain rule)", () => {
    const dir = makeStateDir();
    const a = bareWs(dir, "a");
    const b = bareWs(dir, "b", { parentId: a.id });
    const c = bareWs(dir, "c", { parentId: b.id });
    assert.throws(
      () => updateWorkspace(dir, a.id, { setParent: a.id }),
      (e) => e instanceof WorkspacesError && e.status === 400 && /cannot be its own ancestor/.test(e.message)
    );
    assert.throws(
      () => updateWorkspace(dir, a.id, { setParent: c.id }),
      (e) => e instanceof WorkspacesError && e.status === 400 && /ancestor chain/.test(e.message)
    );
    // The refused updates changed nothing.
    assert.equal(getWorkspace(dir, a.id).parentId, null);
    assert.equal(getWorkspace(dir, b.id).parentId, a.id);
    assert.equal(getWorkspace(dir, c.id).parentId, b.id);
  });

  it("workspaceTree returns the recursive forest, owner-filtered", () => {
    const dir = makeStateDir();
    const a = bareWs(dir, "a");
    const b = bareWs(dir, "b", { parentId: a.id });
    bareWs(dir, "c", { parentId: b.id });
    bareWs(dir, "second-root");
    createWorkspace(dir, { owner: "other", slug: "foreign", name: "Foreign", repos: [], actor: "test" });

    const tree = workspaceTree(dir, { owner: "auro" });
    assert.deepEqual(tree.map((w) => w.slug), ["a", "second-root"]);
    assert.deepEqual(tree[0].children.map((w) => w.slug), ["b"]);
    assert.deepEqual(tree[0].children[0].children.map((w) => w.slug), ["c"]);
    assert.deepEqual(tree[0].children[0].children[0].children, []);
    assert.equal(workspaceTree(dir).length, 3); // unfiltered: foreign root too
  });

  it("delete reparents children to the deleted workspace's parent (tree never dangles)", () => {
    const dir = makeStateDir();
    const a = bareWs(dir, "a");
    const b = bareWs(dir, "b", { parentId: a.id });
    const c = bareWs(dir, "c", { parentId: b.id });

    deleteWorkspace(dir, b.id, { confirm: "b" });
    assert.equal(getWorkspace(dir, c.id).parentId, a.id);

    deleteWorkspace(dir, a.id, { confirm: "a" });
    assert.equal(getWorkspace(dir, c.id).parentId, null);
    const tree = workspaceTree(dir);
    assert.deepEqual(tree.map((w) => w.slug), ["c"]);
  });

  it("status reports parent/children and the subtree rollup (deduped, own repos first, details present)", () => {
    const dir = makeStateDir();
    seedRepo(dir, "auro", "roll-one", "one: initial commit");
    seedRepo(dir, "auro", "roll-two", "two: initial commit");
    seedRepo(dir, "auro", "roll-three", "three: initial commit");
    const site = createSite(dir, {
      name: "roll-site", frontend: "auro/roll-one", backend: "auro/roll-two", actor: "test",
    });
    const root = createWorkspace(dir, {
      owner: "auro", slug: "root", name: "Root", repos: ["auro/roll-one"], actor: "test",
    });
    const mid = createWorkspace(dir, {
      owner: "auro", slug: "mid", name: "Mid",
      repos: ["auro/roll-two", "auro/roll-one"], // roll-one duplicated vs root on purpose
      siteIds: [site.id], parentId: root.id, actor: "test",
    });
    const leaf = createWorkspace(dir, {
      owner: "auro", slug: "leaf", name: "Leaf",
      repos: ["auro/roll-three"], parentId: mid.id, actor: "test",
    });

    const st = workspaceStatus(dir, root.id);
    assert.equal(st.parent, null);
    assert.deepEqual(st.children, [{ id: mid.id, owner: "auro", slug: "mid", name: "Mid" }]);
    assert.equal(st.rollup.descendantCount, 2);
    assert.equal(st.rollup.repoCount, 3); // distinct subtree repos, as a field — not derived by counting
    // Own repos first, then mid's (duplicate skipped), then leaf's.
    assert.deepEqual(st.rollup.repos.map((r) => r.repo),
      ["auro/roll-one", "auro/roll-two", "auro/roll-three"]);
    assert.deepEqual(st.rollup.siteIds, [site.id]);

    // Details summary rides on BOTH the top-level repos and the rollup.
    for (const entry of [...st.repos, ...st.rollup.repos]) {
      assert.ok(entry.details, `${entry.repo} details`);
      assert.equal(entry.details.description, "");
      assert.deepEqual(entry.details.topics, []);
      assert.equal(entry.details.defaultBranch, "main");
      assert.equal(entry.details.commitCount, 2); // seeded initial commit + the pushed one
      assert.ok(entry.details.lastCommit.sha);
    }
    assert.equal(st.repos[0].details.lastCommit.subject, "one: initial commit");
    assert.equal(
      st.rollup.repos.find((r) => r.repo === "auro/roll-two").details.lastCommit.subject,
      "two: initial commit"
    );

    // The middle of the tree sees both directions.
    const midSt = workspaceStatus(dir, mid.id);
    assert.deepEqual(midSt.parent, { id: root.id, owner: "auro", slug: "root", name: "Root" });
    assert.deepEqual(midSt.children, [{ id: leaf.id, owner: "auro", slug: "leaf", name: "Leaf" }]);
    assert.equal(midSt.rollup.descendantCount, 1);
    assert.deepEqual(midSt.rollup.repos.map((r) => r.repo),
      ["auro/roll-two", "auro/roll-one", "auro/roll-three"]);

    // A leaf rolls up only itself.
    const leafSt = workspaceStatus(dir, leaf.id);
    assert.equal(leafSt.rollup.descendantCount, 0);
    assert.deepEqual(leafSt.children, []);
    assert.deepEqual(leafSt.rollup.repos.map((r) => r.repo), ["auro/roll-three"]);
  });
});
