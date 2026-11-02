#!/usr/bin/env node
/**
 * mcp-server.mjs — KILN forge MCP server (zero dependencies).
 *
 * A Model Context Protocol server over stdio (JSON-RPC 2.0, newline-
 * delimited JSON, MCP protocol version 2024-11-05) that exposes the
 * KILN workspaces + project-details HTTP API as vendor-neutral tools,
 * plus the forge surface (kiln_forge_*: branches, tree, contents,
 * commits, compare, pull requests, tags, releases, packages).
 * Any MCP client — any vendor, any model — can spawn it:
 *
 *   { "command": "node", "args": ["<path-to>/swarm/mcp-server.mjs"],
 *     "env": { "KILN_SWARM_DIR": "<state dir>" } }
 *
 * Connection config mirrors lib/client.mjs: the API base URL comes from
 * <stateDir>/daemon.json (`apiUrl`) and the bearer token from
 * <stateDir>/api.token, where <stateDir> is $KILN_SWARM_DIR or
 * ~/.kiln-swarm. Environment overrides win: KILN_SWARM_API_URL replaces
 * the daemon.json lookup and KILN_SWARM_TOKEN replaces the token file.
 * The token is read per tool call, never printed, logged, or cached to
 * disk by this server.
 *
 * The server starts and answers initialize / tools/list with NO daemon
 * running — connection config is resolved lazily, only when a tool is
 * called. A tool call that cannot reach the daemon returns an isError
 * result naming the fix instead of a stack dump.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "kiln-forge", version: "1.0.0" };

// ---------------------------------------------------------------------------
// Connection config (lib/client.mjs in spirit: state dir daemon.json + token)
// ---------------------------------------------------------------------------

function stateDir() {
  return process.env.KILN_SWARM_DIR || join(homedir(), ".kiln-swarm");
}

/** Error whose message is shown to the agent verbatim in an isError result. */
class ToolFailure extends Error {}

function unreachableHint(dir, baseUrl) {
  const where = baseUrl ? ` at ${baseUrl}` : "";
  return (
    `KILN daemon unreachable${where}. Start the daemon ` +
    `(node swarm.mjs daemon start) or check KILN_SWARM_DIR — ` +
    `this server looked in ${dir}. You can also set KILN_SWARM_API_URL ` +
    `to the daemon's API base URL directly.`
  );
}

/**
 * Resolve { baseUrl, token, dir } for one tool call. Env overrides win.
 * Throws ToolFailure with an actionable message (never the token).
 */
function resolveConfig() {
  const dir = stateDir();
  let baseUrl = process.env.KILN_SWARM_API_URL || null;
  if (!baseUrl) {
    const djPath = join(dir, "daemon.json");
    if (!existsSync(djPath)) {
      throw new ToolFailure(
        `KILN daemon not configured: no daemon.json in state dir ${dir} ` +
        `and KILN_SWARM_API_URL is not set. Start the daemon ` +
        `(node swarm.mjs daemon start) or check KILN_SWARM_DIR points at ` +
        `the daemon's state dir.`
      );
    }
    let dj;
    try {
      dj = JSON.parse(readFileSync(djPath, "utf8"));
    } catch {
      throw new ToolFailure(
        `KILN daemon not configured: ${djPath} is not valid JSON. ` +
        `Restart the daemon (node swarm.mjs daemon start) or check ` +
        `KILN_SWARM_DIR — this server looked in ${dir}.`
      );
    }
    if (!dj.apiUrl) {
      throw new ToolFailure(
        `KILN daemon not configured: daemon.json in ${dir} has no apiUrl ` +
        `— the daemon predates the HTTP API or is not running. Start the ` +
        `daemon (node swarm.mjs daemon start) or set KILN_SWARM_API_URL.`
      );
    }
    baseUrl = dj.apiUrl;
  }
  let token = process.env.KILN_SWARM_TOKEN || null;
  if (!token) {
    const tokPath = join(dir, "api.token");
    if (!existsSync(tokPath)) {
      throw new ToolFailure(
        `KILN daemon not configured: no api.token in state dir ${dir} ` +
        `and KILN_SWARM_TOKEN is not set. Start the daemon ` +
        `(node swarm.mjs daemon start) so it writes its token file, or ` +
        `check KILN_SWARM_DIR points at the daemon's state dir.`
      );
    }
    token = readFileSync(tokPath, "utf8").trim();
  }
  return { baseUrl: String(baseUrl).replace(/\/$/, ""), token, dir };
}

/**
 * One HTTP call against the daemon API.
 * - API errors: throws ToolFailure carrying the API's error message
 *   VERBATIM (the API's errors are self-describing; we add nothing).
 * - Connection failures: throws ToolFailure naming the fix.
 */
async function apiFetch(method, path, headers, body) {
  const { baseUrl, token, dir } = resolveConfig();
  let res;
  try {
    res = await fetch(baseUrl + path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...headers },
      body,
    });
  } catch {
    // fetch() hides the cause behind a bare TypeError on connection
    // failure — translate it into the actionable message, always.
    throw new ToolFailure(unreachableHint(dir, baseUrl));
  }
  return { res, baseUrl };
}

async function apiError(res, baseUrl) {
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  const msg =
    data && typeof data.error === "string" && data.error
      ? data.error
      : `HTTP ${res.status} from the KILN daemon at ${baseUrl}`;
  return new ToolFailure(msg);
}

async function apiRequest(method, path, body) {
  const { res, baseUrl } = await apiFetch(
    method,
    path,
    body === undefined ? {} : { "content-type": "application/json" },
    body === undefined ? undefined : JSON.stringify(body)
  );
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!res.ok) {
    const msg =
      data && typeof data.error === "string" && data.error
        ? data.error
        : `HTTP ${res.status} from the KILN daemon at ${baseUrl}`;
    throw new ToolFailure(msg);
  }
  return data === null ? { raw: text } : data;
}

/** Raw-bytes request body (package publish), JSON/text reply parsed like apiRequest. */
async function apiRequestRawBody(method, path, bytes) {
  const { res, baseUrl } = await apiFetch(
    method, path, { "content-type": "application/octet-stream" }, bytes
  );
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!res.ok) {
    const msg =
      data && typeof data.error === "string" && data.error
        ? data.error
        : `HTTP ${res.status} from the KILN daemon at ${baseUrl}`;
    throw new ToolFailure(msg);
  }
  return data === null ? { raw: text } : data;
}

/** Raw-bytes reply (contents ?raw=1, package download), returned as a Buffer. */
async function apiRequestBytes(method, path) {
  const { res, baseUrl } = await apiFetch(method, path, {}, undefined);
  if (!res.ok) throw await apiError(res, baseUrl);
  return Buffer.from(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const str = { type: "string" };
const strArray = { type: "array", items: { type: "string" } };
const strOrNull = { type: ["string", "null"] };

function objectSchema(properties, required) {
  return {
    type: "object",
    properties,
    ...(required && required.length ? { required } : {}),
    additionalProperties: false,
  };
}

/** Base path for one repo's forge routes: /v1/repos/:owner/:repo. */
function forgeRepoBase(args) {
  return `/v1/repos/${encodeURIComponent(String(args.owner))}/${encodeURIComponent(String(args.repo))}`;
}

/** Pick only the keys that are PRESENT in args (so a null survives). */
function pickPresent(args, keys) {
  const out = {};
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(args, k)) out[k] = args[k];
  }
  return out;
}

const TOOLS = [
  {
    name: "kiln_workspace_create",
    description:
      "Create a KILN workspace: a named grouping of member repos and linked sites under one owner, optionally nested under a parent workspace. Repos and siteIds must already exist on the forge (member repos are named \"owner/repo\"); parentId, when given, must be the id of an existing workspace with the SAME owner. Writing the workspace also writes a `workspace` core block into each member repo's KILN Memory. Returns { ok, workspace } with the full record including its generated `id` (ws_…) — keep that id for kiln_workspace_get / kiln_workspace_update / kiln_workspace_delete. Discover existing workspaces first with kiln_workspace_list, and repos with the forge's repo listing, if you are unsure what exists.",
    inputSchema: objectSchema(
      {
        owner: { ...str, description: "Workspace owner (forge owner name)." },
        slug: { ...str, description: "URL-safe slug, unique per owner: [a-z0-9][a-z0-9-]{0,63}." },
        name: { ...str, description: "Human-readable workspace name." },
        description: { ...str, description: "Optional description (max 1024 chars)." },
        repos: { ...strArray, description: "Optional member repos, each \"owner/repo\"; each must exist on the forge." },
        siteIds: { ...strArray, description: "Optional linked site ids (site_…); each must exist in the sites registry." },
        parentId: { ...strOrNull, description: "Optional parent workspace id (same owner), or null for a root workspace." },
      },
      ["owner", "slug", "name"]
    ),
    async call(args) {
      const body = pickPresent(args, ["owner", "slug", "name", "description", "repos", "siteIds", "parentId"]);
      return apiRequest("POST", "/v1/workspaces", body);
    },
  },
  {
    name: "kiln_workspace_list",
    description:
      "List KILN workspaces as flat registry records ({ workspaces: [...] }). Pass owner to filter to one owner; omit it to list every workspace. This is the discovery entry point: call it first to find workspace ids, slugs, owners, member repos, and parentId before calling kiln_workspace_get, kiln_workspace_update, or kiln_workspace_delete. For the nested hierarchy instead of a flat list, use kiln_workspace_tree.",
    inputSchema: objectSchema({
      owner: { ...str, description: "Optional owner filter." },
    }),
    async call(args) {
      const qs = new URLSearchParams();
      if (args.owner !== undefined) qs.set("owner", String(args.owner));
      const s = qs.toString();
      return apiRequest("GET", `/v1/workspaces${s ? "?" + s : ""}`);
    },
  },
  {
    name: "kiln_workspace_get",
    description:
      "Get one workspace's aggregated LIVE status in a single call: the registry record, each member repo's existence / branch / HEAD plus a project-details summary (description, topics, defaultBranch, commitCount, lastCommit), linked sites, memory-linkage state, its parent and direct children, and a rollup over the whole subtree (descendant repos deduped, site ids unioned). Nothing is cached — this is the verify step after creating or updating a workspace. The id is the workspace `id` (ws_…) returned by kiln_workspace_create or kiln_workspace_list.",
    inputSchema: objectSchema(
      { id: { ...str, description: "Workspace id (ws_…)." } },
      ["id"]
    ),
    async call(args) {
      return apiRequest("GET", `/v1/workspaces/${encodeURIComponent(String(args.id))}`);
    },
  },
  {
    name: "kiln_workspace_update",
    description:
      "Update a workspace in place. Only the fields you pass change: name and description replace; addRepos / removeRepos add or remove member repos (\"owner/repo\" — adds must exist on the forge, removals are format-checked only so a repo deleted from the forge can still be removed); linkSites / unlinkSites do the same for site ids; setParent changes nesting — pass a parent workspace id (same owner) to nest, pass null to un-nest to a root, and OMIT setParent entirely to leave the parent unchanged. A parent chain that would create a cycle (parenting to itself or to a descendant) is rejected. Returns { ok, workspace } with the updated record. Verify afterwards with kiln_workspace_get.",
    inputSchema: objectSchema(
      {
        id: { ...str, description: "Workspace id (ws_…) to update." },
        name: { ...str, description: "New human-readable name." },
        description: { ...str, description: "New description (max 1024 chars)." },
        addRepos: { ...strArray, description: "Member repos to add, each \"owner/repo\"; each must exist on the forge." },
        removeRepos: { ...strArray, description: "Member repos to remove, each \"owner/repo\"." },
        linkSites: { ...strArray, description: "Site ids (site_…) to link; each must exist." },
        unlinkSites: { ...strArray, description: "Site ids to unlink." },
        setParent: { ...strOrNull, description: "New parent workspace id, or null to make this a root workspace. Omit to leave the parent unchanged." },
      },
      ["id"]
    ),
    async call(args) {
      const body = pickPresent(args, [
        "name", "description", "addRepos", "removeRepos", "linkSites", "unlinkSites", "setParent",
      ]);
      return apiRequest("PATCH", `/v1/workspaces/${encodeURIComponent(String(args.id))}`, body);
    },
  },
  {
    name: "kiln_workspace_tree",
    description:
      "Get the workspace hierarchy as a nested tree: { workspaces: [roots…] } where each node is the workspace record plus a recursive `children` array (workspaces nested via parentId / setParent). Pass owner to restrict the tree to one owner. Use this to see how workspaces are organized before creating a nested workspace or reparenting with kiln_workspace_update's setParent. For a flat list without nesting, use kiln_workspace_list.",
    inputSchema: objectSchema({
      owner: { ...str, description: "Optional owner filter." },
    }),
    async call(args) {
      const qs = new URLSearchParams();
      qs.set("tree", "1");
      if (args.owner !== undefined) qs.set("owner", String(args.owner));
      return apiRequest("GET", `/v1/workspaces?${qs.toString()}`);
    },
  },
  {
    name: "kiln_workspace_delete",
    description:
      "Delete a workspace's registry entry ONLY — member repos, linked sites, and their KILN Memory links are deliberately untouched, and any child workspaces are reparented to the deleted workspace's parent (or become roots) so the tree never dangles. This is guarded: `confirm` must equal the workspace's slug exactly, otherwise the delete is refused. Get the slug from kiln_workspace_list or kiln_workspace_get first. Returns { ok: true, id }.",
    inputSchema: objectSchema(
      {
        id: { ...str, description: "Workspace id (ws_…) to delete." },
        confirm: { ...str, description: "The workspace's slug, exactly — the delete guard." },
      },
      ["id", "confirm"]
    ),
    async call(args) {
      return apiRequest("DELETE", `/v1/workspaces/${encodeURIComponent(String(args.id))}`, {
        confirm: args.confirm,
      });
    },
  },
  {
    name: "kiln_repo_details",
    description:
      "Read the project details for one forge-hosted repo, computed live from the hosted bare repo: description and topics (editable metadata stored in the repo's kiln.json), empty / defaultBranch / commitCount / fileCount / treeBytes / diskBytes, lastCommit and recentActivity (up to 5 commits), byte-weighted languages, the root README (when present), the workspaces this repo belongs to, its linked site (if any), and its latest CI result (if any). Use it to understand a repo before adding it to a workspace with kiln_workspace_create or kiln_workspace_update, or to read a member repo in depth after kiln_workspace_get's summary. Unknown repos return an error.",
    inputSchema: objectSchema(
      {
        owner: { ...str, description: "Repo owner (forge owner name)." },
        repo: { ...str, description: "Repo name." },
      },
      ["owner", "repo"]
    ),
    async call(args) {
      return apiRequest(
        "GET",
        `/v1/repos/${encodeURIComponent(String(args.owner))}/${encodeURIComponent(String(args.repo))}/details`
      );
    },
  },

  // -------------------------------------------------------------------------
  // Forge tools (kiln_forge_*) — branches, tree, contents, commits, compare,
  // pull requests, tags, releases, packages. Same daemon, same bearer token.
  // Principals: operator is root; account sessions + agent tokens are
  // owner-scoped and agents need scope `forge`. The contents API is the
  // agent write path (git push stays operator-only). A 404 from the daemon
  // means the route is staged for its next boot, not broken — the error
  // surfaces verbatim.
  // -------------------------------------------------------------------------
  {
    name: "kiln_forge_repo_delete",
    description:
      "Delete a forge repo OUTRIGHT: the bare git dir (with its details and memory chain), its forge records (pulls/releases), and its stored CI results are removed; workspace/site registries keep their member refs and render the repo as missing. This is the strictest write on the forge: only the repo owner's account session or the operator token may delete — an agent token (this tool's usual caller) is refused with 403 by design; repo creation is operator-only and deletion never drops below that bar. A non-owner session also answers 403, anonymous 401, an unknown repo 404. There is no undo. Verify with a repo list (the repo is gone) or kiln_repo_details (404).",
    inputSchema: objectSchema(
      { owner: { ...str }, repo: { ...str } },
      ["owner", "repo"]
    ),
    async call(args) {
      return apiRequest("DELETE", `${forgeRepoBase(args)}`);
    },
  },
  {
    name: "kiln_forge_branches_list",
    description:
      "List a forge repo's branches: { branches: [{ name, sha }] }. Repo is \"owner/repo\" under /v1/repos/:owner/:repo.",
    inputSchema: objectSchema(
      { owner: { ...str }, repo: { ...str } },
      ["owner", "repo"]
    ),
    async call(args) {
      return apiRequest("GET", `${forgeRepoBase(args)}/branches`);
    },
  },
  {
    name: "kiln_forge_branch_create",
    description:
      "Create a branch in a forge repo. `from` (a ref or sha) is optional — omit it to branch from the daemon's default. Returns the daemon's answer verbatim. Verify with kiln_forge_branches_list.",
    inputSchema: objectSchema(
      {
        owner: { ...str }, repo: { ...str },
        name: { ...str, description: "New branch name." },
        from: { ...str, description: "Optional ref/sha to branch from." },
      },
      ["owner", "repo", "name"]
    ),
    async call(args) {
      const body = pickPresent(args, ["name", "from"]);
      return apiRequest("POST", `${forgeRepoBase(args)}/branches`, body);
    },
  },
  {
    name: "kiln_forge_branch_delete",
    description:
      "Delete a branch from a forge repo by name. Returns the daemon's answer verbatim. Verify with kiln_forge_branches_list.",
    inputSchema: objectSchema(
      {
        owner: { ...str }, repo: { ...str },
        name: { ...str, description: "Branch name to delete." },
      },
      ["owner", "repo", "name"]
    ),
    async call(args) {
      return apiRequest("DELETE", `${forgeRepoBase(args)}/branches/${encodeURIComponent(String(args.name))}`);
    },
  },
  {
    name: "kiln_forge_tree",
    description:
      "List one level of a forge repo's tree: { entries: [{ name, type, sha, size }] }. Optional `ref` (branch/tag/sha; daemon default when omitted) and `path` (directory prefix; root when omitted).",
    inputSchema: objectSchema(
      {
        owner: { ...str }, repo: { ...str },
        ref: { ...str, description: "Optional ref (branch, tag, or sha)." },
        path: { ...str, description: "Optional directory path within the repo." },
      },
      ["owner", "repo"]
    ),
    async call(args) {
      const qs = new URLSearchParams();
      if (args.ref !== undefined) qs.set("ref", String(args.ref));
      if (args.path !== undefined) qs.set("path", String(args.path));
      const s = qs.toString();
      return apiRequest("GET", `${forgeRepoBase(args)}/tree${s ? "?" + s : ""}`);
    },
  },
  {
    name: "kiln_forge_contents_get",
    description:
      "Read one file from a forge repo. Default answer is the daemon's JSON envelope { path, ref, sha, size, encoding, content }. Pass raw=true to get the file's raw bytes instead, returned as { size, contentBase64 } (base64 because MCP results are text). `path` is required; `ref` is optional.",
    inputSchema: objectSchema(
      {
        owner: { ...str }, repo: { ...str },
        path: { ...str, description: "File path within the repo." },
        ref: { ...str, description: "Optional ref (branch, tag, or sha)." },
        raw: { type: "boolean", description: "Return raw bytes as base64 instead of the JSON envelope." },
      },
      ["owner", "repo", "path"]
    ),
    async call(args) {
      const qs = new URLSearchParams();
      qs.set("path", String(args.path));
      if (args.ref !== undefined) qs.set("ref", String(args.ref));
      if (args.raw === true) {
        qs.set("raw", "1");
        const buf = await apiRequestBytes("GET", `${forgeRepoBase(args)}/contents?${qs.toString()}`);
        return { size: buf.length, contentBase64: buf.toString("base64") };
      }
      return apiRequest("GET", `${forgeRepoBase(args)}/contents?${qs.toString()}`);
    },
  },
  {
    name: "kiln_forge_contents_put",
    description:
      "Create or update one file in a forge repo as a REAL git commit (author = the calling principal) — this is the agent write path; git push stays operator-only. `content` is the file text (utf8 default); for binary content pass encoding \"base64\" with base64 content. `message` is the commit message (required). `branch` targets a non-default branch; `sha` is the current blob sha when updating an existing file. Returns { commit, sha }. Verify with kiln_forge_contents_get.",
    inputSchema: objectSchema(
      {
        owner: { ...str }, repo: { ...str },
        path: { ...str, description: "File path within the repo." },
        content: { ...str, description: "File content (utf8 text, or base64 when encoding is \"base64\")." },
        encoding: { ...str, description: "Optional: \"utf8\" (default) or \"base64\"." },
        message: { ...str, description: "Commit message." },
        branch: { ...str, description: "Optional target branch." },
        sha: { ...str, description: "Optional current blob sha when updating." },
      },
      ["owner", "repo", "path", "content", "message"]
    ),
    async call(args) {
      const body = pickPresent(args, ["path", "content", "encoding", "message", "branch", "sha"]);
      return apiRequest("PUT", `${forgeRepoBase(args)}/contents`, body);
    },
  },
  {
    name: "kiln_forge_contents_delete",
    description:
      "Delete one file from a forge repo as a real git commit. `message` is the commit message (required); `sha` is the file's current blob sha; `branch` targets a non-default branch. Returns { commit }. Verify with kiln_forge_tree or kiln_forge_contents_get.",
    inputSchema: objectSchema(
      {
        owner: { ...str }, repo: { ...str },
        path: { ...str, description: "File path within the repo." },
        message: { ...str, description: "Commit message." },
        branch: { ...str, description: "Optional target branch." },
        sha: { ...str, description: "Optional current blob sha." },
      },
      ["owner", "repo", "path", "message"]
    ),
    async call(args) {
      const body = pickPresent(args, ["path", "message", "branch", "sha"]);
      return apiRequest("DELETE", `${forgeRepoBase(args)}/contents`, body);
    },
  },
  {
    name: "kiln_forge_commits_list",
    description:
      "List a forge repo's commits, newest first. Optional `ref` (branch/tag/sha), `limit`, and `path` (only commits touching that path).",
    inputSchema: objectSchema(
      {
        owner: { ...str }, repo: { ...str },
        ref: { ...str, description: "Optional ref (branch, tag, or sha)." },
        limit: { type: "integer", description: "Optional maximum number of commits." },
        path: { ...str, description: "Optional path filter." },
      },
      ["owner", "repo"]
    ),
    async call(args) {
      const qs = new URLSearchParams();
      if (args.ref !== undefined) qs.set("ref", String(args.ref));
      if (args.limit !== undefined) qs.set("limit", String(args.limit));
      if (args.path !== undefined) qs.set("path", String(args.path));
      const s = qs.toString();
      return apiRequest("GET", `${forgeRepoBase(args)}/commits${s ? "?" + s : ""}`);
    },
  },
  {
    name: "kiln_forge_commit_get",
    description:
      "Get one commit from a forge repo by its sha: message, author, parents, and the daemon's change detail.",
    inputSchema: objectSchema(
      {
        owner: { ...str }, repo: { ...str },
        sha: { ...str, description: "Commit sha." },
      },
      ["owner", "repo", "sha"]
    ),
    async call(args) {
      return apiRequest("GET", `${forgeRepoBase(args)}/commits/${encodeURIComponent(String(args.sha))}`);
    },
  },
  {
    name: "kiln_forge_compare",
    description:
      "Compare two refs in a forge repo: ahead/behind counts, the commits between them, changed files, and a capped patch. Both `base` and `head` are required.",
    inputSchema: objectSchema(
      {
        owner: { ...str }, repo: { ...str },
        base: { ...str, description: "Base ref." },
        head: { ...str, description: "Head ref." },
      },
      ["owner", "repo", "base", "head"]
    ),
    async call(args) {
      const qs = new URLSearchParams({ base: String(args.base), head: String(args.head) });
      return apiRequest("GET", `${forgeRepoBase(args)}/compare?${qs.toString()}`);
    },
  },
  {
    name: "kiln_forge_pull_create",
    description:
      "Open a pull request in a forge repo: { title, body?, head, base } — head is the source branch, base the target branch. Returns the created pull (keep its number for the other kiln_forge_pull_* tools). Verify with kiln_forge_pull_get.",
    inputSchema: objectSchema(
      {
        owner: { ...str }, repo: { ...str },
        title: { ...str, description: "Pull title." },
        body: { ...str, description: "Optional pull body." },
        head: { ...str, description: "Source branch." },
        base: { ...str, description: "Target branch." },
      },
      ["owner", "repo", "title", "head", "base"]
    ),
    async call(args) {
      const body = pickPresent(args, ["title", "body", "head", "base"]);
      return apiRequest("POST", `${forgeRepoBase(args)}/pulls`, body);
    },
  },
  {
    name: "kiln_forge_pulls_list",
    description:
      "List a forge repo's pull requests. Optional `state` filter (the daemon's state vocabulary, e.g. open/closed/merged).",
    inputSchema: objectSchema(
      {
        owner: { ...str }, repo: { ...str },
        state: { ...str, description: "Optional state filter." },
      },
      ["owner", "repo"]
    ),
    async call(args) {
      const qs = new URLSearchParams();
      if (args.state !== undefined) qs.set("state", String(args.state));
      const s = qs.toString();
      return apiRequest("GET", `${forgeRepoBase(args)}/pulls${s ? "?" + s : ""}`);
    },
  },
  {
    name: "kiln_forge_pull_get",
    description:
      "Get one pull request by number: title, body, head/base, state, reviews and comments as the daemon records them.",
    inputSchema: objectSchema(
      {
        owner: { ...str }, repo: { ...str },
        number: { type: "integer", description: "Pull number." },
      },
      ["owner", "repo", "number"]
    ),
    async call(args) {
      return apiRequest("GET", `${forgeRepoBase(args)}/pulls/${encodeURIComponent(String(args.number))}`);
    },
  },
  {
    name: "kiln_forge_pull_update",
    description:
      "Update a pull request in place: only the fields you pass change — title, body, or state (e.g. close by setting the daemon's closed state). Returns the daemon's updated record. Verify with kiln_forge_pull_get.",
    inputSchema: objectSchema(
      {
        owner: { ...str }, repo: { ...str },
        number: { type: "integer", description: "Pull number." },
        title: { ...str, description: "New title." },
        body: { ...str, description: "New body." },
        state: { ...str, description: "New state." },
      },
      ["owner", "repo", "number"]
    ),
    async call(args) {
      const body = pickPresent(args, ["title", "body", "state"]);
      return apiRequest("PATCH", `${forgeRepoBase(args)}/pulls/${encodeURIComponent(String(args.number))}`, body);
    },
  },
  {
    name: "kiln_forge_pull_comment",
    description:
      "Comment on a pull request: { body }. Returns the daemon's answer verbatim. Verify with kiln_forge_pull_get.",
    inputSchema: objectSchema(
      {
        owner: { ...str }, repo: { ...str },
        number: { type: "integer", description: "Pull number." },
        body: { ...str, description: "Comment text." },
      },
      ["owner", "repo", "number", "body"]
    ),
    async call(args) {
      return apiRequest("POST", `${forgeRepoBase(args)}/pulls/${encodeURIComponent(String(args.number))}/comments`, { body: args.body });
    },
  },
  {
    name: "kiln_forge_pull_review",
    description:
      "Review a pull request: state is one of \"approved\", \"changes_requested\", \"commented\"; body is optional review text. A changes-requested review blocks merge for non-operator principals (merge answers 409). Returns the daemon's answer verbatim.",
    inputSchema: objectSchema(
      {
        owner: { ...str }, repo: { ...str },
        number: { type: "integer", description: "Pull number." },
        state: { ...str, description: "approved | changes_requested | commented." },
        body: { ...str, description: "Optional review text." },
      },
      ["owner", "repo", "number", "state"]
    ),
    async call(args) {
      const body = pickPresent(args, ["state", "body"]);
      return apiRequest("POST", `${forgeRepoBase(args)}/pulls/${encodeURIComponent(String(args.number))}/reviews`, body);
    },
  },
  {
    name: "kiln_forge_pull_merge",
    description:
      "Merge a pull request for real: method \"merge\" (default daemon behavior) or \"fast-forward\", with an optional merge message. Pass deleteBranch=true to also delete the head branch after the merge (default off, GitHub-style delete-on-merge); the answer reports headBranchDeleted, or headBranchKept with the reason when the branch had to stay (e.g. it is the default branch). Answers 409 on conflicts, on changes-requested for non-operator principals, and when the base branch carries a protection rule whose requirements are unmet (kiln_forge_protection_get reads the rule; the 409 names every unmet requirement). CI is enqueued on the base branch after a merge. Verify with kiln_forge_pull_get and kiln_forge_commits_list.",
    inputSchema: objectSchema(
      {
        owner: { ...str }, repo: { ...str },
        number: { type: "integer", description: "Pull number." },
        method: { ...str, description: "merge | fast-forward." },
        message: { ...str, description: "Optional merge commit message." },
        deleteBranch: { type: "boolean", description: "Delete the head branch after a successful merge (default false)." },
      },
      ["owner", "repo", "number"]
    ),
    async call(args) {
      const body = pickPresent(args, ["method", "message", "deleteBranch"]);
      return apiRequest("POST", `${forgeRepoBase(args)}/pulls/${encodeURIComponent(String(args.number))}/merge`, body);
    },
  },
  {
    name: "kiln_forge_protection_list",
    description:
      "List a forge repo's branch-protection rules: { protection: { [branch]: rule } }. An empty object means no branch is protected — unruled branches merge exactly as the forge always has. A rule may require approving reviews from non-author reviewers (requiredApprovals), a recorded CI verdict of \\\"pass\\\" for the PR head commit (requireCiPass), and may bind operators too (allowOperatorOverride: false). Enforcement lives in the merge path itself (kiln_forge_pull_merge answers 409 naming every unmet requirement).",
    inputSchema: objectSchema(
      { owner: { ...str }, repo: { ...str } },
      ["owner", "repo"]
    ),
    async call(args) {
      return apiRequest("GET", `${forgeRepoBase(args)}/protection`);
    },
  },
  {
    name: "kiln_forge_protection_get",
    description:
      "Read one branch's protection rule: { branch, rule } — rule is null when the branch is unprotected. Branch names may contain slashes.",
    inputSchema: objectSchema(
      {
        owner: { ...str }, repo: { ...str },
        branch: { ...str, description: "Branch name, e.g. main or release/1.x." },
      },
      ["owner", "repo", "branch"]
    ),
    async call(args) {
      return apiRequest("GET", `${forgeRepoBase(args)}/protection/${encodeURIComponent(String(args.branch))}`);
    },
  },
  {
    name: "kiln_forge_protection_set",
    description:
      "Create or update a branch's protection rule (patch semantics: omitted keys keep their stored values; a fresh rule starts from requiredApprovals 0, requireCiPass false, allowOperatorOverride true). Unknown keys or wrong types are a loud 400 from the daemon, never a silent no-op. Returns { ok: true, branch, rule } including updatedBy/updatedAt. Verify with kiln_forge_protection_get.",
    inputSchema: objectSchema(
      {
        owner: { ...str }, repo: { ...str },
        branch: { ...str, description: "Branch name, e.g. main or release/1.x." },
        requiredApprovals: { type: "integer", description: "Distinct non-author reviewers whose latest review must be \\\"approved\\\" (0..100)." },
        requireCiPass: { type: "boolean", description: "Require a recorded CI verdict of \\\"pass\\\" for the PR head commit." },
        allowOperatorOverride: { type: "boolean", description: "Default true: the operator may merge past the rule. False binds operators too — the strongest setting." },
      },
      ["owner", "repo", "branch"]
    ),
    async call(args) {
      const body = pickPresent(args, ["requiredApprovals", "requireCiPass", "allowOperatorOverride"]);
      return apiRequest("PUT", `${forgeRepoBase(args)}/protection/${encodeURIComponent(String(args.branch))}`, body);
    },
  },
  {
    name: "kiln_forge_protection_delete",
    description:
      "Remove a branch's protection rule; the branch returns to forge-default merge behavior. 404 when the branch has no rule. Returns { ok: true, branch, deleted: true }. Verify with kiln_forge_protection_list.",
    inputSchema: objectSchema(
      {
        owner: { ...str }, repo: { ...str },
        branch: { ...str, description: "Branch name, e.g. main or release/1.x." },
      },
      ["owner", "repo", "branch"]
    ),
    async call(args) {
      return apiRequest("DELETE", `${forgeRepoBase(args)}/protection/${encodeURIComponent(String(args.branch))}`);
    },
  },
  {
    name: "kiln_forge_tags_list",
    description:
      "List a forge repo's tags (the daemon's tag records: names and their target shas).",
    inputSchema: objectSchema(
      { owner: { ...str }, repo: { ...str } },
      ["owner", "repo"]
    ),
    async call(args) {
      return apiRequest("GET", `${forgeRepoBase(args)}/tags`);
    },
  },
  {
    name: "kiln_forge_release_create",
    description:
      "Create a release in a forge repo: { tag, name?, notes?, target? }. Creates the annotated tag if it does not exist yet (target is the ref/sha to tag). Returns the created release. Verify with kiln_forge_release_get or kiln_forge_releases_list.",
    inputSchema: objectSchema(
      {
        owner: { ...str }, repo: { ...str },
        tag: { ...str, description: "Release tag, e.g. v1.2.0." },
        name: { ...str, description: "Optional release name." },
        notes: { ...str, description: "Optional release notes." },
        target: { ...str, description: "Optional ref/sha the tag should point at." },
      },
      ["owner", "repo", "tag"]
    ),
    async call(args) {
      const body = pickPresent(args, ["tag", "name", "notes", "target"]);
      return apiRequest("POST", `${forgeRepoBase(args)}/releases`, body);
    },
  },
  {
    name: "kiln_forge_releases_list",
    description:
      "List a forge repo's releases (tag, name, notes, target as recorded by the daemon).",
    inputSchema: objectSchema(
      { owner: { ...str }, repo: { ...str } },
      ["owner", "repo"]
    ),
    async call(args) {
      return apiRequest("GET", `${forgeRepoBase(args)}/releases`);
    },
  },
  {
    name: "kiln_forge_release_get",
    description:
      "Get one release by its tag: name, markdown notes, target, the commit it points at, and who published it.",
    inputSchema: objectSchema(
      {
        owner: { ...str }, repo: { ...str },
        tag: { ...str, description: "Release tag." },
      },
      ["owner", "repo", "tag"]
    ),
    async call(args) {
      return apiRequest("GET", `${forgeRepoBase(args)}/releases/${encodeURIComponent(String(args.tag))}`);
    },
  },
  {
    name: "kiln_forge_release_update",
    description:
      "Update a release in place by tag: only the fields you pass change — name and/or notes. Returns the daemon's updated record. Verify with kiln_forge_release_get.",
    inputSchema: objectSchema(
      {
        owner: { ...str }, repo: { ...str },
        tag: { ...str, description: "Release tag." },
        name: { ...str, description: "New release name." },
        notes: { ...str, description: "New release notes." },
      },
      ["owner", "repo", "tag"]
    ),
    async call(args) {
      const body = pickPresent(args, ["name", "notes"]);
      return apiRequest("PATCH", `${forgeRepoBase(args)}/releases/${encodeURIComponent(String(args.tag))}`, body);
    },
  },
  {
    name: "kiln_forge_release_delete",
    description:
      "Delete a release by tag. Returns the daemon's answer verbatim. Verify with kiln_forge_releases_list.",
    inputSchema: objectSchema(
      {
        owner: { ...str }, repo: { ...str },
        tag: { ...str, description: "Release tag." },
      },
      ["owner", "repo", "tag"]
    ),
    async call(args) {
      return apiRequest("DELETE", `${forgeRepoBase(args)}/releases/${encodeURIComponent(String(args.tag))}`);
    },
  },
  {
    name: "kiln_forge_packages_list",
    description:
      "List forge packages: { packages: [...] } as the daemon records them. Optional `owner` filter; omit it to list across owners your token can see. Packages live at /v1/packages, separate from repos.",
    inputSchema: objectSchema(
      { owner: { ...str, description: "Optional owner filter." } },
      []
    ),
    async call(args) {
      const qs = new URLSearchParams();
      if (args.owner !== undefined) qs.set("owner", String(args.owner));
      const s = qs.toString();
      return apiRequest("GET", `/v1/packages${s ? "?" + s : ""}`);
    },
  },
  {
    name: "kiln_forge_package_get",
    description:
      "Get one package's metadata by owner + name: its versions and files as recorded by the daemon.",
    inputSchema: objectSchema(
      {
        owner: { ...str, description: "Package owner." },
        name: { ...str, description: "Package name." },
      },
      ["owner", "name"]
    ),
    async call(args) {
      return apiRequest("GET", `/v1/packages/${encodeURIComponent(String(args.owner))}/${encodeURIComponent(String(args.name))}`);
    },
  },
  {
    name: "kiln_forge_package_version_get",
    description:
      "Get one package version's metadata by owner + name + version: the files published under that version.",
    inputSchema: objectSchema(
      {
        owner: { ...str, description: "Package owner." },
        name: { ...str, description: "Package name." },
        version: { ...str, description: "Version string." },
      },
      ["owner", "name", "version"]
    ),
    async call(args) {
      return apiRequest(
        "GET",
        `/v1/packages/${encodeURIComponent(String(args.owner))}/${encodeURIComponent(String(args.name))}/${encodeURIComponent(String(args.version))}`
      );
    },
  },
  {
    name: "kiln_forge_package_publish",
    description:
      "Publish one file to a package version: reads `filePath` (a local path on the machine running this MCP server) and PUTs its raw bytes to /v1/packages/:owner/:name/:version/:filename. `filename` defaults to the file's basename. Publishing is IMMUTABLE — different bytes for an existing version+filename answer 409. Returns the daemon's answer verbatim. Verify with kiln_forge_package_version_get.",
    inputSchema: objectSchema(
      {
        owner: { ...str, description: "Package owner." },
        name: { ...str, description: "Package name." },
        version: { ...str, description: "Version string." },
        filePath: { ...str, description: "Local path of the file to publish." },
        filename: { ...str, description: "Optional published filename (default: the file's basename)." },
      },
      ["owner", "name", "version", "filePath"]
    ),
    async call(args) {
      const filePath = String(args.filePath);
      if (!existsSync(filePath)) {
        throw new ToolFailure(`Package publish failed: no such local file: ${filePath}`);
      }
      const bytes = readFileSync(filePath);
      const filename = args.filename !== undefined ? String(args.filename) : filePath.split(/[\\/]/).pop();
      return apiRequestRawBody(
        "PUT",
        `/v1/packages/${encodeURIComponent(String(args.owner))}/${encodeURIComponent(String(args.name))}/${encodeURIComponent(String(args.version))}/${encodeURIComponent(filename)}`,
        bytes
      );
    },
  },
  {
    name: "kiln_forge_package_download",
    description:
      "Download one published package file's raw bytes, returned as { filename, size, contentBase64 } (base64 because MCP results are text). With `saveTo` (a local path on the machine running this MCP server) the bytes are also written to that file and the result names the path. Verify a download against kiln_forge_package_version_get's metadata.",
    inputSchema: objectSchema(
      {
        owner: { ...str, description: "Package owner." },
        name: { ...str, description: "Package name." },
        version: { ...str, description: "Version string." },
        filename: { ...str, description: "Published filename." },
        saveTo: { ...str, description: "Optional local path to also write the bytes to." },
      },
      ["owner", "name", "version", "filename"]
    ),
    async call(args) {
      const buf = await apiRequestBytes(
        "GET",
        `/v1/packages/${encodeURIComponent(String(args.owner))}/${encodeURIComponent(String(args.name))}/${encodeURIComponent(String(args.version))}/${encodeURIComponent(String(args.filename))}`
      );
      const out = { filename: String(args.filename), size: buf.length, contentBase64: buf.toString("base64") };
      if (args.saveTo !== undefined) {
        writeFileSync(String(args.saveTo), buf);
        out.savedTo = String(args.saveTo);
      }
      return out;
    },
  },
  {
    name: "kiln_papers_list",
    description:
      "List KILN Papers concept records visible to your token: { papers: [...] }. Each concept carries its permanent id (kiln:<owner>/<slug>), a `resolver` URL — the identifier's address under https://kiln.pocketnova.app/doi/<owner>/<slug> — the latest release's manifest (title, authors, abstract, license, keywords), and every released version with its generated citations. Visibility is the forge law read live from each paper's repo: public papers answer anyone, private ones only their owner's namespace and the operator. `owner` narrows the list to one namespace; it never widens it. The `doi` field is null on every record until a real DataCite/Crossref prefix exists — a KILN ID is KILN-registered, never a registered DOI. If the daemon answers 404, its running build predates the papers ability (the route is staged for the daemon's next boot): that is the honest state, not a broken tool. Publishing rides the forge doors (repo + paper.json + details designation + release) — start from kiln_workspace_list / the forge tools if you are unsure what exists.",
    inputSchema: objectSchema(
      {
        owner: { ...str, description: "Optional owner namespace to narrow to (never widens visibility)." },
      }
    ),
    async call(args) {
      const qs = new URLSearchParams();
      if (args.owner) qs.set("owner", String(args.owner));
      const s = qs.toString();
      return apiRequest("GET", `/v1/papers${s ? "?" + s : ""}`);
    },
  },
  {
    name: "kiln_papers_get",
    description:
      "Read one KILN Papers concept record: { id, owner, slug, doi, resolver, pagesUrl, title, manifest, versionCount, firstReleasedAt, latestReleasedAt, versions } — the latest manifest plus every immutable version snapshot (tag, commit, releasedAt, releasedBy, manifest, files, citations, and each version's own resolver URL). The record follows the repo's LIVE visibility: flipping the repo private hides it from everyone but its owner's namespace and the operator. A paper registers at its first forge release on a paper-designated repo, so a designated-but-unreleased repo has no record yet and answers 404. `doi` is null until a real DataCite/Crossref prefix exists — never present a KILN ID as a registered DOI.",
    inputSchema: objectSchema(
      {
        owner: { ...str, description: "Paper owner (forge owner name)." },
        slug: { ...str, description: "Paper slug — the repo name under the owner." },
      },
      ["owner", "slug"]
    ),
    async call(args) {
      return apiRequest(
        "GET",
        `/v1/papers/${encodeURIComponent(String(args.owner))}/${encodeURIComponent(String(args.slug))}`
      );
    },
  },
  // -------------------------------------------------------------------------
  // Agent accounts + invite links (Lane C) — the SPONSOR-side verbs.
  // This server calls the daemon with the OPERATOR token, so every
  // tool names the sponsoring account explicitly (sponsorOwner): the
  // operator holds no account of its own. With a session bearer the
  // same routes sponsor the caller — these tools are the operator
  // door onto them. Redemption is deliberately NOT a tool: it is the
  // unauthenticated bootstrap for an agent holding ONLY a link, and
  // belongs to the kit's no-token redeem door, not to a server
  // configured with the forge's root token.
  // -------------------------------------------------------------------------
  {
    name: "kiln_agent_invite_create",
    description:
      "Mint an agent invite LINK sponsored by the account named sponsorOwner: { invite, token, tokenShownOnce } — the plaintext token (kiln_ainv_…) is returned exactly once; only its sha256 is stored. Hand the token to the agent out of band: ANY agent holding it (any model, any framework) redeems it unauthenticated at POST /v1/agent-invites/:token/redeem, choosing its own owner handle + display name, and receives a first-class agent account plus its first agent token. Links expire in 7 days and work once; consumed/revoked tokens answer 404 at redemption, expired 410. `label` is the sponsor's optional note (e.g. \"for my research agent\"). There is no email path — agent accounts have no email by design. Verify with kiln_agent_invite_list. If the daemon answers 404, its running build predates agent invites (staged for the next boot), not broken.",
    inputSchema: objectSchema(
      {
        sponsorOwner: { ...str, description: "The sponsoring account's owner namespace." },
        label: { ...str, description: "Optional sponsor note for this link (max 200 chars)." },
      },
      ["sponsorOwner"]
    ),
    async call(args) {
      const body = pickPresent(args, ["label", "sponsorOwner"]);
      return apiRequest("POST", "/v1/accounts/me/agent-invites", body);
    },
  },
  {
    name: "kiln_agent_invite_list",
    description:
      "List the agent invites sponsored by the account named sponsorOwner, every status (pending/accepted/revoked/expired), oldest first: { invites: [...] }. Accepted invites name the created agent account (redeemedBy = its owner, redeemedAccountId). The record is the audit trail and never carries the token or its hash. Use it to verify a mint, find an invite id for kiln_agent_invite_revoke, or see which links an agent has already redeemed.",
    inputSchema: objectSchema(
      { sponsorOwner: { ...str, description: "The sponsoring account's owner namespace." } },
      ["sponsorOwner"]
    ),
    async call(args) {
      const qs = new URLSearchParams({ sponsorOwner: String(args.sponsorOwner) });
      return apiRequest("GET", `/v1/accounts/me/agent-invites?${qs.toString()}`);
    },
  },
  {
    name: "kiln_agent_invite_revoke",
    description:
      "Revoke one pending agent invite (id from kiln_agent_invite_list) sponsored by sponsorOwner. Redemption of a revoked token fails with 404, like a consumed or unknown one. Only a pending invite can be revoked — a spent or expired one answers 409. Returns { ok, invite }. Verify with kiln_agent_invite_list.",
    inputSchema: objectSchema(
      {
        sponsorOwner: { ...str, description: "The sponsoring account's owner namespace." },
        id: { ...str, description: "Invite id (ainv_…)." },
      },
      ["sponsorOwner", "id"]
    ),
    async call(args) {
      const qs = new URLSearchParams({ sponsorOwner: String(args.sponsorOwner) });
      return apiRequest("DELETE", `/v1/accounts/me/agent-invites/${encodeURIComponent(String(args.id))}?${qs.toString()}`);
    },
  },
  {
    name: "kiln_agent_account_create",
    description:
      "Create a first-class AGENT ACCOUNT directly under the sponsorship of the account named sponsorOwner — the no-link path (for an agent you can hand a token to right now; use kiln_agent_invite_create when the agent should onboard itself from a link). The new account is its own principal: own namespace (owner), own repos, own tokens, kind \"agent\", NO email and NO password by design. Returns { ok, account, agent, token } — the token (kiln_agt_…) is the agent account's first credential, shown exactly once; it resolves to the agent account itself. The sponsor link is visibility, never control: the sponsor can see the account (kiln_agent_accounts_list) but cannot act as it. A namespace carrying forge content but claimed by no account may be claimed through this operator door. Verify with kiln_agent_accounts_list.",
    inputSchema: objectSchema(
      {
        sponsorOwner: { ...str, description: "The sponsoring account's owner namespace." },
        owner: { ...str, description: "The new agent account's namespace: [a-z0-9][a-z0-9-]{0,63}." },
        name: { ...str, description: "The agent account's display name." },
        modelLabel: { ...str, description: "Optional free-form model/framework label (display metadata, gates nothing)." },
        scopes: { ...strArray, description: "Optional scopes for the first token (workspaces, project-details, forge; default all)." },
      },
      ["sponsorOwner", "owner", "name"]
    ),
    async call(args) {
      const body = pickPresent(args, ["sponsorOwner", "owner", "name", "modelLabel", "scopes"]);
      return apiRequest("POST", "/v1/accounts/me/agent-accounts", body);
    },
  },
  {
    name: "kiln_agent_accounts_list",
    description:
      "List the agent accounts sponsored by the account named sponsorOwner: { accounts: [...] } — each the child's public shape (id, kind \"agent\", owner, name, modelLabel, sponsor, createdAt; never any credential). The same link is readable from the child's side via its own GET /v1/accounts/me (sponsor field). Use it to verify a create or a redemption landed under the right sponsor.",
    inputSchema: objectSchema(
      { sponsorOwner: { ...str, description: "The sponsoring account's owner namespace." } },
      ["sponsorOwner"]
    ),
    async call(args) {
      const qs = new URLSearchParams({ sponsorOwner: String(args.sponsorOwner) });
      return apiRequest("GET", `/v1/accounts/me/agent-accounts?${qs.toString()}`);
    },
  },
  {
    name: "kiln_papers_version",
    description:
      "Read one immutable KILN Papers version: the release snapshot exactly as recorded (manifest + file list at the release commit), its generated citations (plain text + BibTeX), its permanent version id (kiln:<owner>/<slug>.v<n>) and its own resolver URL (https://kiln.pocketnova.app/doi/<owner>/<slug>/v/<n>). Versions are append-only: a later release never rewrites an earlier version, and a forge release deletion does not retract a recorded version. `n` is the 1-based version number from kiln_papers_get's versions list. `doi` is null until a real DataCite/Crossref prefix exists.",
    inputSchema: objectSchema(
      {
        owner: { ...str, description: "Paper owner (forge owner name)." },
        slug: { ...str, description: "Paper slug — the repo name under the owner." },
        n: { type: "integer", description: "Version number (1-based, as listed by kiln_papers_get)." },
      },
      ["owner", "slug", "n"]
    ),
    async call(args) {
      return apiRequest(
        "GET",
        `/v1/papers/${encodeURIComponent(String(args.owner))}/${encodeURIComponent(String(args.slug))}/v/${encodeURIComponent(String(args.n))}`
      );
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------
// Argument validation (malformed calls -> JSON-RPC -32602, before any API call)
// ---------------------------------------------------------------------------

function invalidParams(message) {
  const e = new Error(message);
  e.rpcCode = -32602;
  return e;
}

function typeOk(value, type) {
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number";
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "null") return value === null;
  return true;
}

function validateArgs(tool, args) {
  if (args === undefined || args === null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) {
    throw invalidParams(`tool ${tool.name}: arguments must be an object`);
  }
  const schema = tool.inputSchema;
  for (const field of schema.required || []) {
    if (!Object.prototype.hasOwnProperty.call(args, field) || args[field] === undefined) {
      throw invalidParams(`tool ${tool.name}: missing required argument "${field}"`);
    }
  }
  for (const [field, value] of Object.entries(args)) {
    const prop = schema.properties[field];
    if (!prop) {
      if (schema.additionalProperties === false) {
        throw invalidParams(`tool ${tool.name}: unknown argument "${field}"`);
      }
      continue;
    }
    const types = Array.isArray(prop.type) ? prop.type : [prop.type];
    if (!types.some((t) => typeOk(value, t))) {
      throw invalidParams(
        `tool ${tool.name}: argument "${field}" must be of type ${types.join(" or ")}`
      );
    }
    if (prop.type === "array" && prop.items && prop.items.type === "string") {
      if (!value.every((v) => typeof v === "string")) {
        throw invalidParams(`tool ${tool.name}: argument "${field}" must be an array of strings`);
      }
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 / MCP dispatch
// ---------------------------------------------------------------------------

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id === undefined ? null : id, error: { code, message } };
}

async function handleMessage(msg) {
  // Notifications (no id) never get a reply — including
  // notifications/initialized and any unknown notification.
  if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
    return rpcError(null, -32600, "Invalid Request: expected a single JSON-RPC object (batch requests are not supported)");
  }
  if (typeof msg.method !== "string") {
    if (msg.id === undefined) return null; // a response/notification shape we do not answer
    return rpcError(msg.id, -32600, "Invalid Request: missing string \"method\"");
  }
  if (msg.method.startsWith("notifications/")) return null;
  if (msg.id === undefined) return null; // notification-shaped: no reply, ever

  const id = msg.id;
  switch (msg.method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
      });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    case "tools/call": {
      const params = msg.params;
      if (!params || typeof params !== "object" || typeof params.name !== "string") {
        return rpcError(id, -32602, "Invalid params: tools/call requires params.name (string)");
      }
      const tool = TOOL_BY_NAME.get(params.name);
      if (!tool) {
        return rpcError(id, -32602, `Invalid params: unknown tool "${params.name}" — call tools/list for the available tools`);
      }
      let args;
      try {
        args = validateArgs(tool, params.arguments === undefined ? {} : params.arguments);
      } catch (e) {
        return rpcError(id, e.rpcCode || -32602, e.message);
      }
      try {
        const data = await tool.call(args);
        return rpcResult(id, {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          isError: false,
        });
      } catch (e) {
        // Tool execution failures are RESULTS with isError, per MCP —
        // the message is the API's own error, verbatim, or the clear
        // daemon-unreachable message. Never a stack dump.
        const message = e instanceof Error ? e.message : String(e);
        return rpcResult(id, {
          content: [{ type: "text", text: message }],
          isError: true,
        });
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${msg.method}`);
  }
}

// ---------------------------------------------------------------------------
// stdio transport: newline-delimited JSON (MCP stdio framing)
// ---------------------------------------------------------------------------

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

let buffer = "";
// Messages are handled strictly in arrival order: a pipelining client
// must never see a later reply overtake an earlier one on stdout.
let chain = Promise.resolve();
function dispatchLine(line) {
  chain = chain.then(async () => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      send(rpcError(null, -32700, `Parse error: ${e.message}`));
      return;
    }
    try {
      const reply = await handleMessage(msg);
      if (reply) send(reply);
    } catch (e) {
      const id = msg && typeof msg === "object" ? msg.id : null;
      if (id !== undefined && id !== null) {
        send(rpcError(id, -32603, `Internal error: ${e instanceof Error ? e.message : String(e)}`));
      }
    }
  });
  return chain;
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) void dispatchLine(line);
  }
});
process.stdin.on("end", () => {
  // Flush a trailing message with no newline, then exit with the client.
  const line = buffer.trim();
  buffer = "";
  if (line) void dispatchLine(line);
});

// Diagnostics go to stderr ONLY — stdout is the protocol channel, and
// nothing here may ever carry the token.
process.stderr.write(
  `${SERVER_INFO.name} MCP server ${SERVER_INFO.version} ready on stdio ` +
  `(protocol ${PROTOCOL_VERSION}, state dir ${stateDir()})\n`
);
