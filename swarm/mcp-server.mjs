#!/usr/bin/env node
/**
 * mcp-server.mjs — KILN forge MCP server (zero dependencies).
 *
 * A Model Context Protocol server over stdio (JSON-RPC 2.0, newline-
 * delimited JSON, MCP protocol version 2024-11-05) that exposes the
 * KILN workspaces + project-details HTTP API as vendor-neutral tools.
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
import { existsSync, readFileSync } from "node:fs";
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
async function apiRequest(method, path, body) {
  const { baseUrl, token, dir } = resolveConfig();
  let res;
  try {
    res = await fetch(baseUrl + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // fetch() hides the cause behind a bare TypeError on connection
    // failure — translate it into the actionable message, always.
    throw new ToolFailure(unreachableHint(dir, baseUrl));
  }
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
