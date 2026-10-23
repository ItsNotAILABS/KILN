/**
 * KILN Sites: first-class site linking (frontend repo + backend repo +
 * artifact + compute app). Real bare repos, real memory writes, real
 * HTTP API on an ephemeral port — no mocks.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeStateDir, makeGitRepo } from "./helpers.mjs";
import { createRepo, repoPath } from "../lib/git.mjs";
import { loadMemory, verifyMemory } from "../lib/memory.mjs";
import { deployApp } from "../lib/compute.mjs";
import {
  SitesError, createSite, listSites, getSite, resolveSite, deleteSite,
  siteStatus, repoHead,
} from "../lib/sites.mjs";
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
  const work = mkdtempSync(join(tmpdir(), "kiln-sites-seed-"));
  git(work, ["init", "-q", "-b", "main"]);
  git(work, ["config", "user.email", "test@kiln.local"]);
  git(work, ["config", "user.name", "kiln-test"]);
  writeFileSync(join(work, "README.md"), `# ${repo}\n`);
  git(work, ["add", "-A"]);
  git(work, ["commit", "-q", "-m", subject]);
  git(work, ["push", "-q", repoPath(dir, owner, repo), "main"]);
  return git(work, ["rev-parse", "HEAD"]);
}

/** Create a hosted repo and push one real commit to it. Returns the commit sha. */
function seedRepo(dir, owner, repo, subject) {
  createRepo(dir, owner, repo);
  return pushCommit(dir, owner, repo, subject);
}

function shopstreamDir() {
  const dir = makeStateDir();
  const fSha = seedRepo(dir, "auro", "shopstream-web", "storefront: initial commit");
  const bSha = seedRepo(dir, "auro", "shopstream-api", "api: initial commit");
  return { dir, fSha, bSha };
}

function coreOf(dir, owner, repo) {
  const { core } = loadMemory(dir, owner, repo);
  return Object.fromEntries(core.map((c) => [c.label, c.value]));
}

describe("sites: registry + memory linkage", () => {
  it("creates a site and writes linkage core blocks into BOTH repos' memory", () => {
    const { dir } = shopstreamDir();
    const site = createSite(dir, {
      name: "shopstream",
      frontend: "auro/shopstream-web",
      backend: "auro/shopstream-api",
      artifact: "shopstream",
      computeApp: "shopstream-api",
      actor: "test",
    });
    assert.ok(site.id.startsWith("site_"));
    assert.equal(site.frontend, "auro/shopstream-web");
    assert.equal(site.backend, "auro/shopstream-api");
    assert.equal(site.artifact, "shopstream");
    assert.equal(site.computeApp, "shopstream-api");
    assert.ok(site.createdAt);

    // Registry is disk-backed.
    const onDisk = JSON.parse(readFileSync(join(dir, "sites.json"), "utf8"));
    assert.equal(onDisk.sites[site.id].name, "shopstream");

    // Frontend memory knows its backend, its site, its artifact.
    const fCore = coreOf(dir, "auro", "shopstream-web");
    assert.equal(fCore.backend_repo, "auro/shopstream-api");
    assert.equal(fCore.artifact, "shopstream");
    assert.match(fCore.site, /^shopstream \(site_/);
    // Backend memory knows its frontend.
    const bCore = coreOf(dir, "auro", "shopstream-api");
    assert.equal(bCore.frontend_repo, "auro/shopstream-web");
    assert.equal(bCore.artifact, "shopstream");
    assert.match(bCore.site, /^shopstream \(site_/);
    // The chains are intact after the writes.
    assert.equal(verifyMemory(dir, "auro", "shopstream-web").ok, true);
    assert.equal(verifyMemory(dir, "auro", "shopstream-api").ok, true);

    const listed = listSites(dir);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, site.id);
    assert.equal(resolveSite(dir, "shopstream").id, site.id);
    assert.equal(resolveSite(dir, site.id.slice(0, 10)).id, site.id);
  });

  it("works without artifact/computeApp (both optional, no artifact block written)", () => {
    const { dir } = shopstreamDir();
    const site = createSite(dir, {
      name: "bare", frontend: "auro/shopstream-web", backend: "auro/shopstream-api", actor: "test",
    });
    assert.equal(site.artifact, null);
    assert.equal(site.computeApp, null);
    const fCore = coreOf(dir, "auro", "shopstream-web");
    assert.equal(fCore.backend_repo, "auro/shopstream-api");
    assert.equal(fCore.artifact, undefined);
  });

  it("refuses a missing repo and leaves no registry entry behind", () => {
    const dir = makeStateDir();
    createRepo(dir, "auro", "only-frontend");
    assert.throws(
      () => createSite(dir, { name: "x", frontend: "auro/only-frontend", backend: "auro/ghost", actor: "test" }),
      (e) => e instanceof SitesError && e.status === 404
    );
    assert.equal(listSites(dir).length, 0);
    assert.equal(existsSync(join(dir, "sites.json")), false);
  });

  it("refuses a duplicate name and malformed refs", () => {
    const { dir } = shopstreamDir();
    const opts = { name: "dup", frontend: "auro/shopstream-web", backend: "auro/shopstream-api", actor: "test" };
    createSite(dir, opts);
    assert.throws(() => createSite(dir, opts), (e) => e instanceof SitesError && e.status === 409);
    assert.throws(
      () => createSite(dir, { name: "bad", frontend: "noslash", backend: "auro/shopstream-api" }),
      (e) => e instanceof SitesError && e.status === 400
    );
    assert.throws(
      () => createSite(dir, { name: "bad2", frontend: "auro/shopstream-web", backend: "auro/shopstream-api", artifact: "Not A Slug" }),
      (e) => e instanceof SitesError && e.status === 400
    );
  });

  it("delete removes only the registry entry — repos and memory survive", async () => {
    const { dir, bSha } = shopstreamDir();
    const site = createSite(dir, {
      name: "shopstream", frontend: "auro/shopstream-web", backend: "auro/shopstream-api",
      artifact: "shopstream", actor: "test",
    });
    assert.deepEqual(deleteSite(dir, site.id), { ok: true, id: site.id });
    assert.equal(listSites(dir).length, 0);
    assert.throws(() => getSite(dir, site.id), (e) => e instanceof SitesError && e.status === 404);
    assert.throws(() => deleteSite(dir, site.id), (e) => e instanceof SitesError && e.status === 404);
    // Repo + its memory linkage are untouched.
    assert.equal(repoHead(dir, "auro", "shopstream-api").sha, bSha);
    assert.equal(coreOf(dir, "auro", "shopstream-api").frontend_repo, "auro/shopstream-web");
  });
});

describe("sites: aggregated live status", () => {
  it("reports repo HEADs, memory linkage, and null app when none is linked", async () => {
    const { dir, fSha, bSha } = shopstreamDir();
    const site = createSite(dir, {
      name: "shopstream", frontend: "auro/shopstream-web", backend: "auro/shopstream-api",
      artifact: "shopstream", actor: "test",
    });
    const st = await siteStatus(dir, site.id);
    assert.equal(st.site.id, site.id);
    assert.equal(st.frontend.exists, true);
    assert.equal(st.frontend.head.sha, fSha);
    assert.equal(st.frontend.head.shortSha, fSha.slice(0, 7));
    assert.equal(st.frontend.head.subject, "storefront: initial commit");
    assert.equal(st.backend.head.sha, bSha);
    assert.equal(st.backend.head.subject, "api: initial commit");
    assert.equal(st.artifact, "shopstream");
    assert.equal(st.computeApp, null);
    assert.equal(st.memory.frontend.present, true);
    assert.equal(st.memory.backend.present, true);
    assert.equal(st.memory.linked, true);
  });

  it("resolves a linked compute app by name AND by id, and says so when it's gone", async () => {
    const { dir } = shopstreamDir();
    // deployApp clones `repo` (a path/URL, as in production where it's the
    // clone URL) — the app's origin repo is irrelevant to site resolution.
    const app = await deployApp(dir, {
      name: "shopstream-api", repo: makeGitRepo(),
      command: "node", args: ["server.mjs"], port: 8904,
    });
    const byName = createSite(dir, {
      name: "by-name", frontend: "auro/shopstream-web", backend: "auro/shopstream-api",
      computeApp: "shopstream-api", actor: "test",
    });
    const stName = await siteStatus(dir, byName.id);
    assert.equal(stName.computeApp.found, true);
    assert.equal(stName.computeApp.appId, app.appId);
    assert.equal(stName.computeApp.name, "shopstream-api");
    assert.equal(stName.computeApp.port, 8904);
    assert.equal(stName.computeApp.status, "down"); // no worker runs in the test dir

    const byId = createSite(dir, {
      name: "by-id", frontend: "auro/shopstream-web", backend: "auro/shopstream-api",
      computeApp: app.appId, actor: "test",
    });
    const stId = await siteStatus(dir, byId.id);
    assert.equal(stId.computeApp.found, true);
    assert.equal(stId.computeApp.appId, app.appId);

    const ghost = createSite(dir, {
      name: "ghost-app", frontend: "auro/shopstream-web", backend: "auro/shopstream-api",
      computeApp: "no-such-app", actor: "test",
    });
    const stGhost = await siteStatus(dir, ghost.id);
    assert.equal(stGhost.computeApp.found, false);
    assert.equal(stGhost.computeApp.ref, "no-such-app");
  });

  it("an empty repo reports head: null, not an error", async () => {
    const dir = makeStateDir();
    createRepo(dir, "auro", "empty-web");
    seedRepo(dir, "auro", "some-api", "api commit");
    const site = createSite(dir, {
      name: "half", frontend: "auro/empty-web", backend: "auro/some-api", actor: "test",
    });
    const st = await siteStatus(dir, site.id);
    assert.equal(st.frontend.exists, true);
    assert.equal(st.frontend.head, null);
    assert.ok(st.backend.head.sha);
  });
});

describe("sites: HTTP API", () => {
  let dir, api, base, token;

  it("serves the full sites lifecycle over HTTP (auth enforced)", async () => {
    dir = makeStateDir();
    process.env.KILN_SWARM_API_PORT = "0";
    try {
      api = await startApiServer(dir, { apiPort: 0 });
    } finally {
      delete process.env.KILN_SWARM_API_PORT;
    }
    base = api.url;
    token = loadApiToken(dir);
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

    // Auth gate: sites routes are NOT public.
    assert.equal((await call("GET", "/v1/sites", null, false)).status, 401);
    assert.equal((await call("POST", "/v1/sites", {}, false)).status, 401);

    // Repos first (hosted git create is itself an API route).
    assert.equal((await call("POST", "/git/auro/shopstream-web")).status, 201);
    assert.equal((await call("POST", "/git/auro/shopstream-api")).status, 201);
    pushCommit(dir, "auro", "shopstream-api", "api: initial commit");
    pushCommit(dir, "auro", "shopstream-web", "storefront: initial commit");

    // Create.
    const created = await call("POST", "/v1/sites", {
      name: "shopstream", frontend: "auro/shopstream-web", backend: "auro/shopstream-api",
      artifact: "shopstream", computeApp: "shopstream-api",
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.ok, true);
    const id = created.data.site.id;
    assert.ok(id.startsWith("site_"));

    // The create wrote memory linkage (checked through the memory API).
    const core = await call("GET", "/git/auro/shopstream-web/memory/core");
    const labels = Object.fromEntries(core.data.core.map((c) => [c.label, c.value]));
    assert.equal(labels.backend_repo, "auro/shopstream-api");
    assert.equal(labels.artifact, "shopstream");

    // Validation + duplicate + missing repo surface as 400/409/404.
    assert.equal((await call("POST", "/v1/sites", { name: "bad", frontend: "noslash", backend: "auro/shopstream-api" })).status, 400);
    assert.equal((await call("POST", "/v1/sites", { name: "shopstream", frontend: "auro/shopstream-web", backend: "auro/shopstream-api" })).status, 409);
    assert.equal((await call("POST", "/v1/sites", { name: "ghost", frontend: "auro/shopstream-web", backend: "auro/ghost" })).status, 404);

    // List.
    const list = await call("GET", "/v1/sites");
    assert.equal(list.status, 200);
    assert.equal(list.data.sites.length, 1);
    assert.equal(list.data.sites[0].id, id);

    // Aggregated status.
    const st = await call("GET", `/v1/sites/${id}`);
    assert.equal(st.status, 200);
    assert.equal(st.data.backend.head.subject, "api: initial commit");
    assert.equal(st.data.frontend.head.subject, "storefront: initial commit");
    assert.equal(st.data.memory.linked, true);
    assert.equal(st.data.computeApp.found, false); // named but no app deployed in this dir

    // Delete -> gone; repos untouched.
    assert.equal((await call("DELETE", `/v1/sites/${id}`)).status, 200);
    assert.equal((await call("GET", `/v1/sites/${id}`)).status, 404);
    assert.equal((await call("DELETE", `/v1/sites/${id}`)).status, 404);
    assert.equal((await call("GET", "/v1/sites")).data.sites.length, 0);
    const coreAfter = await call("GET", "/git/auro/shopstream-api/memory/core");
    assert.ok(coreAfter.data.core.some((c) => c.label === "frontend_repo"));
  });

  after(async () => {
    if (api) await new Promise((r) => api.server.close(r));
  });
});
