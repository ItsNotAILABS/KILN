/**
 * KILN Sites — first-class linking of a whole site, not just repos.
 *
 * A site record ties together the pieces that make one product:
 *
 *   frontend   "owner/repo"  — the KILN-native repo holding the site's UI
 *   backend    "owner/repo"  — the KILN-native repo holding its API/service
 *   artifact   slug          — the published Muse web artifact, if any
 *   computeApp name or appId — the compute app (lib/compute.mjs) that runs
 *                              the backend, if it is KILN-hosted
 *
 * The registry is a disk-backed JSON store at <stateDir>/sites.json,
 * written atomically (tmp + rename) exactly like lib/compute.mjs's
 * store. The registry is an INDEX, never the source of truth for the
 * pieces themselves: repos stay in lib/git.mjs, apps in lib/compute.mjs,
 * and the durable cross-links live in each repo's own KILN Memory
 * (refs/kiln/memory core blocks, written on create via lib/memory.mjs).
 * Deleting a site removes only the index entry — repos, apps, and
 * memory are untouched.
 *
 * Aggregated status (siteStatus) is computed live on every call: repo
 * HEADs are read from the hosted bare repos with git plumbing, the
 * compute app's status comes from the compute registry (including its
 * TCP readiness probe), and memory linkage is verified by replaying
 * each repo's memory and checking the expected core blocks are there.
 * Nothing is cached, so status can never go stale and lie.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomicSync } from "./state.mjs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { repoPath, repoExists, validRepoName } from "./git.mjs";
import { setCore, loadMemory } from "./memory.mjs";
import { listApps } from "./compute.mjs";

const SITES_FILE = "sites.json";
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/;
const ARTIFACT_RE = /^[a-z0-9][a-z0-9-]*$/;

export class SitesError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "SitesError";
    this.status = status;
  }
}

// ---------------------------------------------------------------- store

function sitesPath(dir) {
  return join(dir, SITES_FILE);
}

function loadStore(dir) {
  const p = sitesPath(dir);
  if (!existsSync(p)) return { sites: {} };
  try {
    const s = JSON.parse(readFileSync(p, "utf8"));
    return { sites: s.sites || {} };
  } catch {
    return { sites: {} };
  }
}

/** Atomic store write (tmp + fsync + rename) — same discipline as lib/compute.mjs. */
function saveStore(dir, store) {
  writeFileAtomicSync(sitesPath(dir), JSON.stringify(store, null, 2) + "\n");
}

export { loadStore, saveStore };

export function newSiteId() {
  return "site_" + randomBytes(6).toString("hex");
}

// ---------------------------------------------------------------- validation

/** Parse + validate an "owner/repo" reference. Returns [owner, repo]. */
function parseRepoRef(v, what) {
  if (typeof v !== "string") throw new SitesError(400, `${what} must be "owner/repo"`);
  const i = v.indexOf("/");
  if (i <= 0 || i === v.length - 1 || v.indexOf("/", i + 1) !== -1) {
    throw new SitesError(400, `${what} must be "owner/repo"`);
  }
  const owner = v.slice(0, i), repo = v.slice(i + 1);
  if (!validRepoName(owner) || !validRepoName(repo)) {
    throw new SitesError(400, `${what}: invalid owner/repo name "${v}"`);
  }
  return [owner, repo];
}

function needRepo(dir, ref, what) {
  const [owner, repo] = parseRepoRef(ref, what);
  if (!repoExists(dir, owner, repo)) {
    throw new SitesError(404, `${what}: no such repo ${owner}/${repo}`);
  }
  return [owner, repo];
}

// ---------------------------------------------------------------- CRUD

/**
 * Create a site and write the linkage into both repos' KILN Memory:
 * core blocks `backend_repo` (in the frontend repo), `frontend_repo`
 * (in the backend repo), plus `artifact` (when set) and `site` in both,
 * so either repo can walk to the whole site from its own memory.
 * The registry entry is saved only after the memory writes succeed —
 * a failed create leaves no half-linked site behind.
 */
export function createSite(dir, { name, frontend, backend, artifact, computeApp, actor } = {}) {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new SitesError(400, "name must match [A-Za-z0-9][A-Za-z0-9 _.-]{0,63}");
  }
  const [fOwner, fRepo] = needRepo(dir, frontend, "frontend");
  const [bOwner, bRepo] = needRepo(dir, backend, "backend");
  if (artifact !== undefined && artifact !== null && artifact !== "") {
    if (typeof artifact !== "string" || !ARTIFACT_RE.test(artifact)) {
      throw new SitesError(400, "artifact must be a slug ([a-z0-9-])");
    }
  }
  if (computeApp !== undefined && computeApp !== null && computeApp !== "") {
    if (typeof computeApp !== "string" || computeApp.length > 128) {
      throw new SitesError(400, "computeApp must be an app name or app id string");
    }
  }
  const store = loadStore(dir);
  if (Object.values(store.sites).some((s) => s.name === name)) {
    throw new SitesError(409, `site exists: ${name}`);
  }
  const site = {
    id: newSiteId(),
    name,
    frontend: `${fOwner}/${fRepo}`,
    backend: `${bOwner}/${bRepo}`,
    artifact: artifact || null,
    computeApp: computeApp || null,
    createdAt: new Date().toISOString(),
  };

  const who = actor || "sites";
  const linkNote = `Linked by KILN Sites as site "${name}" (${site.id})`;
  setCore(dir, fOwner, fRepo, { label: "backend_repo", value: site.backend, description: linkNote, actor: who });
  setCore(dir, fOwner, fRepo, { label: "site", value: `${name} (${site.id})`, description: linkNote, actor: who });
  setCore(dir, bOwner, bRepo, { label: "frontend_repo", value: site.frontend, description: linkNote, actor: who });
  setCore(dir, bOwner, bRepo, { label: "site", value: `${name} (${site.id})`, description: linkNote, actor: who });
  if (site.artifact) {
    setCore(dir, fOwner, fRepo, { label: "artifact", value: site.artifact, description: linkNote, actor: who });
    setCore(dir, bOwner, bRepo, { label: "artifact", value: site.artifact, description: linkNote, actor: who });
  }

  store.sites[site.id] = site;
  saveStore(dir, store);
  return site;
}

export function listSites(dir) {
  return Object.values(loadStore(dir).sites)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name));
}

export function getSite(dir, id) {
  const site = loadStore(dir).sites[id];
  if (!site) throw new SitesError(404, `no such site: ${id}`);
  return site;
}

/** Resolve a site by id, id prefix, or exact name (CLI convenience). */
export function resolveSite(dir, idOrName) {
  const sites = Object.values(loadStore(dir).sites);
  const byId = sites.find((s) => s.id === idOrName);
  if (byId) return byId;
  const byPrefix = sites.filter((s) => s.id.startsWith(idOrName));
  if (byPrefix.length === 1) return byPrefix[0];
  if (byPrefix.length > 1) throw new SitesError(400, `site: ambiguous prefix "${idOrName}"`);
  const byName = sites.find((s) => s.name === idOrName);
  if (byName) return byName;
  throw new SitesError(404, `site: no such site "${idOrName}"`);
}

/** Remove the registry entry only. Repos, apps, and memory are untouched. */
export function deleteSite(dir, id) {
  const store = loadStore(dir);
  if (!store.sites[id]) throw new SitesError(404, `no such site: ${id}`);
  delete store.sites[id];
  saveStore(dir, store);
  return { ok: true, id };
}

// ---------------------------------------------------------------- live status

/** HEAD of the hosted bare repo's default branch: {sha, shortSha, subject} or null (empty repo). */
export function repoHead(dir, owner, repo) {
  const gd = repoPath(dir, owner, repo); // throws on invalid names
  if (!repoExists(dir, owner, repo)) return null;
  try {
    // --format with a NUL separator: subjects cannot contain NUL.
    const out = execFileSync(
      "git", ["--git-dir", gd, "log", "-1", "--format=%H%x00%s", "HEAD"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
    if (!out) return null;
    const [sha, subject] = out.split("\0");
    return { sha, shortSha: sha.slice(0, 7), subject: subject || "" };
  } catch {
    return null; // empty repo (no commits yet) — a state, not an error
  }
}

function repoStatusView(dir, ref) {
  const [owner, repo] = ref.split("/");
  const exists = repoExists(dir, owner, repo);
  return { repo: ref, exists, head: exists ? repoHead(dir, owner, repo) : null };
}

function memoryLinkage(dir, ref, expectedLabels) {
  const [owner, repo] = ref.split("/");
  if (!repoExists(dir, owner, repo)) return { present: false, coreLabels: [] };
  try {
    const { core } = loadMemory(dir, owner, repo);
    const labels = core.map((c) => c.label);
    return { present: expectedLabels.every((l) => labels.includes(l)), coreLabels: labels };
  } catch {
    return { present: false, coreLabels: [] };
  }
}

/**
 * Aggregated live status for one site. Async because the compute app's
 * readiness probe is a TCP connect (lib/compute.mjs appStatus).
 */
export async function siteStatus(dir, id) {
  const site = getSite(dir, id);
  const frontend = repoStatusView(dir, site.frontend);
  const backend = repoStatusView(dir, site.backend);

  let app = null;
  if (site.computeApp) {
    const apps = await listApps(dir);
    const found = apps.find((a) => a.appId === site.computeApp || a.name === site.computeApp);
    app = found
      ? {
          ref: site.computeApp, found: true, appId: found.appId, name: found.name,
          status: found.status, workerAlive: found.workerAlive,
          port: found.port, ready: found.ready, deployedAt: found.deployedAt,
        }
      : { ref: site.computeApp, found: false };
  }

  const fMem = memoryLinkage(dir, site.frontend, ["backend_repo", "site"]);
  const bMem = memoryLinkage(dir, site.backend, ["frontend_repo", "site"]);
  return {
    site,
    frontend,
    backend,
    artifact: site.artifact,
    computeApp: app,
    memory: {
      frontend: fMem,
      backend: bMem,
      linked: fMem.present && bMem.present,
    },
  };
}
