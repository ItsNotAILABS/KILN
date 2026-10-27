/**
 * KILN Workspaces — first-class grouping of the repos + sites that make
 * one product or effort, owned by one owner.
 *
 * A site (lib/sites.mjs) ties exactly one frontend repo to one backend
 * repo. A workspace is the wider object: any number of member repos and
 * any number of linked sites under one owner + slug — e.g. DFW Haul is
 * four repos (app, edge, harness, workspace docs) plus its Site record.
 *
 * The registry is a disk-backed JSON store at <stateDir>/workspaces.json,
 * written atomically (tmp + rename) exactly like lib/sites.mjs's store.
 * The registry is an INDEX, never the source of truth for the pieces
 * themselves: repos stay in lib/git.mjs, sites in lib/sites.mjs, and the
 * durable cross-links live in each member repo's own KILN Memory
 * (refs/kiln/memory core blocks, written on create and on repo-add via
 * lib/memory.mjs). Deleting a workspace removes only the index entry —
 * repos, sites, and memory are untouched.
 *
 * Aggregated status (workspaceStatus) is computed live on every call:
 * repo HEADs and branches are read from the hosted bare repos with git
 * plumbing, linked sites are resolved from the sites registry, and
 * memory linkage is verified by replaying each repo's memory. Nothing
 * is cached, so status can never go stale and lie.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomicSync } from "./state.mjs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { repoPath, repoExists, validRepoName } from "./git.mjs";
import { setCore, loadMemory } from "./memory.mjs";
import { loadStore as loadSiteStore, repoHead } from "./sites.mjs";
import { repoFactsSummary } from "./repodetails.mjs";

const WORKSPACES_FILE = "workspaces.json";
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
// Product names are human names: Unicode letters/digits plus the
// punctuation people actually type — spaces, _ . : + & and the dash
// family (hyphen, en dash, em dash: "DFW Haul — Marketplace" and
// "Research + Build" must validate).
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.:+&—–-]{0,127}$/u;
const MAX_DESCRIPTION = 1024;
const MAX_REPOS = 256;

export class WorkspacesError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "WorkspacesError";
    this.status = status;
  }
}

// ---------------------------------------------------------------- store

function workspacesPath(dir) {
  return join(dir, WORKSPACES_FILE);
}

function loadStore(dir) {
  const p = workspacesPath(dir);
  if (!existsSync(p)) return { workspaces: {} };
  try {
    const s = JSON.parse(readFileSync(p, "utf8"));
    return { workspaces: s.workspaces || {} };
  } catch {
    return { workspaces: {} };
  }
}

/** Atomic store write (tmp + fsync + rename) — same discipline as lib/sites.mjs. */
function saveStore(dir, store) {
  writeFileAtomicSync(workspacesPath(dir), JSON.stringify(store, null, 2) + "\n");
}

export { loadStore, saveStore };

/**
 * Records written before nesting existed carry no parentId field. They
 * read as roots (null) everywhere — no migration write is ever needed.
 */
function parentIdOf(workspace) {
  return workspace.parentId ?? null;
}

/** Public view of a record: parentId always present (null for roots). */
function recordView(workspace) {
  return { ...workspace, parentId: parentIdOf(workspace) };
}

/** The {id, owner, slug, name} summary used for parent/children links. */
function workspaceSummary(workspace) {
  return { id: workspace.id, owner: workspace.owner, slug: workspace.slug, name: workspace.name };
}

/**
 * Validate a would-be parent for `owner`: it must exist (404) and share
 * the owner's namespace (400 — parents must share the workspace's owner,
 * so pick a parent owned by that owner or omit the parent).
 */
function needParent(store, parentId, owner) {
  if (typeof parentId !== "string" || !parentId) {
    throw new WorkspacesError(400, "parentId must be a workspace id string or null");
  }
  const parent = store.workspaces[parentId];
  if (!parent) {
    throw new WorkspacesError(404, `parent workspace not found: ${parentId} — create it first or omit the parent`);
  }
  if (parent.owner !== owner) {
    throw new WorkspacesError(400,
      `parents must share the workspace's owner: parent ${parent.owner}/${parent.slug} is owned by "${parent.owner}", this workspace is owned by "${owner}" — pick a parent owned by "${owner}" or omit the parent`);
  }
  return parent;
}

export function newWorkspaceId() {
  return "ws_" + randomBytes(6).toString("hex");
}

// ---------------------------------------------------------------- validation

/** Parse + validate an "owner/repo" reference. Returns [owner, repo]. */
function parseRepoRef(v, what) {
  if (typeof v !== "string") throw new WorkspacesError(400, `${what} must be "owner/repo"`);
  const i = v.indexOf("/");
  if (i <= 0 || i === v.length - 1 || v.indexOf("/", i + 1) !== -1) {
    throw new WorkspacesError(400, `${what} must be "owner/repo"`);
  }
  const owner = v.slice(0, i), repo = v.slice(i + 1);
  if (!validRepoName(owner) || !validRepoName(repo)) {
    throw new WorkspacesError(400, `${what}: invalid owner/repo name "${v}"`);
  }
  return [owner, repo];
}

function needRepo(dir, ref, what) {
  const [owner, repo] = parseRepoRef(ref, what);
  if (!repoExists(dir, owner, repo)) {
    throw new WorkspacesError(404, `${what}: no such repo ${owner}/${repo}`);
  }
  return `${owner}/${repo}`;
}

function needSite(dir, id, what) {
  if (typeof id !== "string" || !id) throw new WorkspacesError(400, `${what} must be a site id`);
  const sites = loadSiteStore(dir).sites;
  if (!sites[id]) throw new WorkspacesError(404, `${what}: no such site ${id}`);
  return id;
}

function validOwner(owner) {
  if (typeof owner !== "string" || !validRepoName(owner)) {
    throw new WorkspacesError(400, `owner must be a valid owner name, got "${owner}"`);
  }
  return owner;
}

function validSlug(slug) {
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
    throw new WorkspacesError(400, "slug must match [a-z0-9][a-z0-9-]{0,63}");
  }
  return slug;
}

function validName(name) {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new WorkspacesError(400, "name must start with a letter or digit and use only letters, digits, spaces, and _ . : + & - – — (max 128 chars)");
  }
  return name;
}

function validDescription(description) {
  if (description === undefined || description === null) return "";
  if (typeof description !== "string" || description.length > MAX_DESCRIPTION) {
    throw new WorkspacesError(400, `description must be a string of at most ${MAX_DESCRIPTION} chars`);
  }
  return description;
}

function validRepoList(dir, repos, what) {
  if (repos === undefined || repos === null) return [];
  if (!Array.isArray(repos)) throw new WorkspacesError(400, `${what} must be an array of "owner/repo"`);
  if (repos.length > MAX_REPOS) throw new WorkspacesError(400, `${what}: at most ${MAX_REPOS} repos`);
  const out = [];
  for (const ref of repos) {
    const norm = needRepo(dir, ref, what);
    if (!out.includes(norm)) out.push(norm);
  }
  return out;
}

function validSiteList(dir, siteIds, what) {
  if (siteIds === undefined || siteIds === null) return [];
  if (!Array.isArray(siteIds)) throw new WorkspacesError(400, `${what} must be an array of site ids`);
  const out = [];
  for (const id of siteIds) {
    const norm = needSite(dir, id, what);
    if (!out.includes(norm)) out.push(norm);
  }
  return out;
}

/**
 * Format-only repo list for REMOVALS. A member whose repo has been
 * deleted from the forge must stay removable — requiring existence
 * (needRepo) would strand the ghost ref in the workspace forever,
 * because the only way out is this removal. Malformed refs still 400.
 */
function validRepoRefList(refs, what) {
  if (refs === undefined || refs === null) return [];
  if (!Array.isArray(refs)) throw new WorkspacesError(400, `${what} must be an array of "owner/repo"`);
  const out = [];
  for (const ref of refs) {
    const [owner, repo] = parseRepoRef(ref, what);
    const norm = `${owner}/${repo}`;
    if (!out.includes(norm)) out.push(norm);
  }
  return out;
}

/** Format-only site id list for UNLINKS — same removal rule as repos. */
function validSiteIdList(ids, what) {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids)) throw new WorkspacesError(400, `${what} must be an array of site ids`);
  const out = [];
  for (const id of ids) {
    if (typeof id !== "string" || !id) throw new WorkspacesError(400, `${what} must be a site id`);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

// ---------------------------------------------------------------- memory linkage

/** Write the `workspace` core block into one member repo's KILN Memory. */
function linkRepoMemory(dir, ref, workspace, actor) {
  const [owner, repo] = ref.split("/");
  setCore(dir, owner, repo, {
    label: "workspace",
    value: `${workspace.slug} (${workspace.id})`,
    description: `Member of KILN workspace "${workspace.name}" (${workspace.id}), owned by ${workspace.owner}`,
    actor: actor || "workspaces",
  });
}

// ---------------------------------------------------------------- CRUD

/**
 * Create a workspace and write the linkage into every member repo's KILN
 * Memory (a `workspace` core block naming the slug + id), so any member
 * repo can walk to the workspace from its own memory. The registry entry
 * is saved only after the memory writes succeed — a failed create leaves
 * no half-linked workspace behind.
 */
export function createWorkspace(dir, { owner, slug, name, description, repos, siteIds, parentId, actor } = {}) {
  validOwner(owner);
  validSlug(slug);
  validName(name);
  const desc = validDescription(description);
  const repoRefs = validRepoList(dir, repos, "repos");
  const siteIdList = validSiteList(dir, siteIds, "siteIds");

  const store = loadStore(dir);
  const parent = parentId === undefined || parentId === null
    ? null
    : needParent(store, parentId, owner);
  if (Object.values(store.workspaces).some((w) => w.owner === owner && w.slug === slug)) {
    throw new WorkspacesError(409, `workspace exists: ${owner}/${slug}`);
  }
  const workspace = {
    id: newWorkspaceId(),
    owner,
    slug,
    name,
    description: desc,
    repos: repoRefs,
    siteIds: siteIdList,
    parentId: parent ? parent.id : null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  for (const ref of workspace.repos) linkRepoMemory(dir, ref, workspace, actor);

  store.workspaces[workspace.id] = workspace;
  saveStore(dir, store);
  return workspace;
}

export function listWorkspaces(dir, { owner } = {}) {
  return Object.values(loadStore(dir).workspaces)
    .filter((w) => owner === undefined || w.owner === owner)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.slug.localeCompare(b.slug))
    .map(recordView);
}

/**
 * The workspace forest: root records (parentId null, or pointing outside
 * the returned set), each with a recursive `children` array of the same
 * shape. Flat list ordering (createdAt, then slug) is preserved at
 * every level.
 */
export function workspaceTree(dir, { owner } = {}) {
  const all = listWorkspaces(dir, { owner });
  const byId = new Map(all.map((w) => [w.id, { ...w, children: [] }]));
  const roots = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export function getWorkspace(dir, id) {
  const workspace = loadStore(dir).workspaces[id];
  if (!workspace) throw new WorkspacesError(404, `no such workspace: ${id}`);
  return recordView(workspace);
}

/** Resolve a workspace by id, id prefix, or exact slug (optionally within an owner). */
export function resolveWorkspace(dir, idOrSlug, { owner } = {}) {
  const all = Object.values(loadStore(dir).workspaces);
  const pool = owner === undefined ? all : all.filter((w) => w.owner === owner);
  const byId = pool.find((w) => w.id === idOrSlug);
  if (byId) return recordView(byId);
  const byPrefix = pool.filter((w) => w.id.startsWith(idOrSlug));
  if (byPrefix.length === 1) return recordView(byPrefix[0]);
  if (byPrefix.length > 1) throw new WorkspacesError(400, `workspace: ambiguous prefix "${idOrSlug}"`);
  const bySlug = pool.find((w) => w.slug === idOrSlug);
  if (bySlug) return recordView(bySlug);
  throw new WorkspacesError(404, `workspace: no such workspace "${idOrSlug}"`);
}

/**
 * Update a workspace: rename, redescribe, add/remove member repos,
 * link/unlink sites, and reparent via `setParent` (present = change,
 * id string or null; absent = unchanged; cycles refused). Repos added here get the `workspace` core block
 * written into their memory before the registry entry is saved, same
 * discipline as create. Removals never retract memory (append-only
 * history — supersede there if a link ever needs retracting).
 * Adds/links must exist on the forge; removals/unlinks are validated
 * by format only, so a member that was deleted from the forge first
 * can still be removed from the workspace (never a stranded ghost).
 */
export function updateWorkspace(dir, id, patch = {}, { actor } = {}) {
  const store = loadStore(dir);
  const workspace = store.workspaces[id];
  if (!workspace) throw new WorkspacesError(404, `no such workspace: ${id}`);

  const next = {
    ...workspace, parentId: parentIdOf(workspace),
    repos: [...workspace.repos], siteIds: [...workspace.siteIds],
  };
  if (patch.name !== undefined) next.name = validName(patch.name);
  if (patch.description !== undefined) next.description = validDescription(patch.description);

  // setParent: the key being PRESENT is the change signal (an id string
  // reparents, null clears to root); absent leaves the parent untouched.
  if (Object.prototype.hasOwnProperty.call(patch, "setParent")) {
    if (patch.setParent === null) {
      next.parentId = null;
    } else {
      const parent = needParent(store, patch.setParent, workspace.owner);
      // Cycle protection: walking the new parent's ancestor chain must
      // never reach this workspace — that one walk covers both the
      // self-parent case and parenting under a descendant.
      const seen = new Set();
      let cursor = parent;
      while (cursor) {
        if (cursor.id === id) {
          throw new WorkspacesError(400,
            `setParent would create a cycle: a workspace cannot be its own ancestor — walking the new parent's ancestor chain reaches this workspace (${workspace.owner}/${workspace.slug}); pick a parent outside this workspace's subtree`);
        }
        if (seen.has(cursor.id)) break; // pre-existing loop in stored data: stop, don't spin
        seen.add(cursor.id);
        const pid = parentIdOf(cursor);
        cursor = pid ? store.workspaces[pid] : null;
      }
      next.parentId = parent.id;
    }
  }

  const addedRepos = validRepoList(dir, patch.addRepos, "addRepos");
  const removedRepos = validRepoRefList(patch.removeRepos, "removeRepos");
  for (const ref of addedRepos) if (!next.repos.includes(ref)) next.repos.push(ref);
  if (removedRepos.length) next.repos = next.repos.filter((r) => !removedRepos.includes(r));

  const linkedSites = validSiteList(dir, patch.linkSites, "linkSites");
  const unlinkedSites = validSiteIdList(patch.unlinkSites, "unlinkSites");
  for (const sid of linkedSites) if (!next.siteIds.includes(sid)) next.siteIds.push(sid);
  if (unlinkedSites.length) next.siteIds = next.siteIds.filter((s) => !unlinkedSites.includes(s));

  for (const ref of addedRepos) {
    if (!workspace.repos.includes(ref)) linkRepoMemory(dir, ref, next, actor);
  }

  next.updatedAt = new Date().toISOString();
  store.workspaces[id] = next;
  saveStore(dir, store);
  return next;
}

/**
 * Remove the registry entry only — guarded: the caller must explicitly
 * confirm the workspace's slug, so a bare id can never delete by
 * accident. Repos, sites, and memory are untouched. Direct children are
 * reparented to the deleted workspace's own parent (or root) in the
 * same write, so the tree never dangles.
 */
export function deleteWorkspace(dir, id, { confirm } = {}) {
  const store = loadStore(dir);
  const workspace = store.workspaces[id];
  if (!workspace) throw new WorkspacesError(404, `no such workspace: ${id}`);
  if (confirm !== workspace.slug) {
    throw new WorkspacesError(400,
      `delete is guarded: confirm must equal the workspace slug "${workspace.slug}"`);
  }
  const inheritParentId = parentIdOf(workspace);
  const now = new Date().toISOString();
  for (const other of Object.values(store.workspaces)) {
    if (other.id !== id && parentIdOf(other) === id) {
      other.parentId = inheritParentId;
      other.updatedAt = now;
    }
  }
  delete store.workspaces[id];
  saveStore(dir, store);
  return { ok: true, id };
}

// ---------------------------------------------------------------- live status

/** Default branch of the hosted bare repo (symbolic HEAD), or null. */
export function repoBranch(dir, owner, repo) {
  const gd = repoPath(dir, owner, repo); // throws on invalid names
  if (!repoExists(dir, owner, repo)) return null;
  try {
    const out = execFileSync(
      "git", ["--git-dir", gd, "symbolic-ref", "--short", "-q", "HEAD"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
    return out || null;
  } catch {
    return null;
  }
}

function repoStatusView(dir, ref) {
  const [owner, repo] = ref.split("/");
  const exists = repoExists(dir, owner, repo);
  let details = null;
  if (exists) {
    // A repo that vanishes (or turns unreadable) between the existence
    // check and the summary read reports details: null — the status of
    // the whole workspace must not fail over one member's race.
    try { details = repoFactsSummary(dir, owner, repo); } catch { details = null; }
  }
  return {
    repo: ref,
    exists,
    branch: exists ? repoBranch(dir, owner, repo) : null,
    head: exists ? repoHead(dir, owner, repo) : null,
    details,
  };
}

function memoryLinkage(dir, ref) {
  const [owner, repo] = ref.split("/");
  if (!repoExists(dir, owner, repo)) return { present: false, coreLabels: [] };
  try {
    const { core } = loadMemory(dir, owner, repo);
    const labels = core.map((c) => c.label);
    return { present: labels.includes("workspace"), coreLabels: labels };
  } catch {
    return { present: false, coreLabels: [] };
  }
}

/**
 * Aggregated live status for one workspace: member repos with live HEADs
 * read from the forge itself (each with a project-details summary),
 * linked sites resolved from the sites registry, per-repo memory-linkage
 * verification, and the nesting view — parent, direct children, and a
 * rollup over the whole subtree (member repos of this workspace AND all
 * descendants, deduped by repo ref with own repos first; siteIds
 * unioned across the subtree).
 */
export function workspaceStatus(dir, id) {
  const workspace = getWorkspace(dir, id);
  const repos = workspace.repos.map((ref) => repoStatusView(dir, ref));

  const sites = loadSiteStore(dir).sites;
  const linkedSites = workspace.siteIds.map((sid) => {
    const s = sites[sid];
    return s
      ? { id: s.id, name: s.name, frontend: s.frontend, backend: s.backend, found: true }
      : { id: sid, name: null, frontend: null, backend: null, found: false };
  });

  const memory = {};
  // Vacuous truth: with no member repos there is nothing unlinked, so an
  // empty workspace reports linked — false would claim a broken linkage
  // that does not exist.
  let allLinked = true;
  for (const ref of workspace.repos) {
    const m = memoryLinkage(dir, ref);
    memory[ref] = m;
    if (!m.present) allLinked = false;
  }

  // ---- nesting: parent, direct children, subtree rollup ----
  const all = listWorkspaces(dir); // sorted (createdAt, slug) at every level
  const byId = new Map(all.map((w) => [w.id, w]));
  const parentRecord = workspace.parentId ? byId.get(workspace.parentId) : null;
  const parent = parentRecord ? workspaceSummary(parentRecord) : null;
  const childRecords = all.filter((w) => parentIdOf(w) === id);
  const children = childRecords.map(workspaceSummary);

  // Pre-order walk, own workspace first, children in list order:
  // rollup repos keep first occurrence (own repos win duplicates).
  const subtree = [];
  const visited = new Set();
  const walkSubtree = (wsId) => {
    if (visited.has(wsId)) return;
    visited.add(wsId);
    const record = byId.get(wsId);
    if (!record) return;
    subtree.push(record);
    for (const child of all.filter((w) => parentIdOf(w) === wsId)) walkSubtree(child.id);
  };
  walkSubtree(id);

  const rollupRepos = [];
  const seenRepos = new Set();
  const rollupSiteIds = [];
  for (const record of subtree) {
    for (const ref of record.repos) {
      if (seenRepos.has(ref)) continue;
      seenRepos.add(ref);
      rollupRepos.push(repoStatusView(dir, ref));
    }
    for (const sid of record.siteIds) {
      if (!rollupSiteIds.includes(sid)) rollupSiteIds.push(sid);
    }
  }
  const rollup = {
    descendantCount: subtree.length - 1,
    repos: rollupRepos,
    siteIds: rollupSiteIds,
  };

  return {
    workspace, repos, sites: linkedSites,
    memory: { repos: memory, linked: allLinked },
    parent, children, rollup,
  };
}
