/**
 * Discovery documents for the KILN daemon API — vendor-neutral, so any
 * AI client (or human) can discover the workspace + project-details
 * surface without insider knowledge:
 *
 *   GET /v1/capabilities  → buildCapabilities(): the ability index.
 *   GET /v1/openapi.json  → buildOpenApiDocument(): OpenAPI 3.1 for the
 *                           workspace, repo-details, and discovery routes.
 *
 * Both are served bearer-gated like every other /v1 route (the forge
 * idiom — see docs/WORKSPACES.md). The documents describe the routes
 * lib/httpapi.mjs actually serves; if a route changes, this file must
 * change in the same commit.
 */

const ERROR_SCHEMA = {
  type: "object",
  properties: { error: { type: "string" } },
  required: ["error"],
};

const COMMIT_SCHEMA = {
  type: ["object", "null"],
  properties: {
    sha: { type: "string" },
    shortSha: { type: "string" },
    subject: { type: "string" },
    author: { type: "string" },
    date: { type: "string", format: "date-time" },
  },
  required: ["sha", "shortSha", "subject", "author", "date"],
};

const WORKSPACE_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", pattern: "^ws_" },
    owner: { type: "string" },
    slug: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,63}$" },
    name: { type: "string" },
    description: { type: "string", maxLength: 1024 },
    repos: { type: "array", items: { type: "string" }, description: "\"owner/repo\" member refs" },
    siteIds: { type: "array", items: { type: "string" } },
    parentId: { type: ["string", "null"], description: "Parent workspace id (same owner), or null for a root workspace" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
  required: ["id", "owner", "slug", "name", "description", "repos", "siteIds", "parentId", "createdAt", "updatedAt"],
};

const WORKSPACE_TREE_NODE_SCHEMA = {
  allOf: [
    { $ref: "#/components/schemas/Workspace" },
    {
      type: "object",
      properties: {
        children: {
          type: "array",
          items: { $ref: "#/components/schemas/WorkspaceTreeNode" },
        },
      },
      required: ["children"],
    },
  ],
};

const DETAILS_SUMMARY_SCHEMA = {
  type: ["object", "null"],
  description: "Project-details summary (lib/repodetails.mjs repoFactsSummary); null when the repo does not exist",
  properties: {
    description: { type: "string" },
    topics: { type: "array", items: { type: "string" } },
    defaultBranch: { type: ["string", "null"] },
    commitCount: { type: "integer", minimum: 0 },
    lastCommit: COMMIT_SCHEMA,
  },
  required: ["description", "topics", "defaultBranch", "commitCount", "lastCommit"],
};

const REPO_STATUS_SCHEMA = {
  type: "object",
  properties: {
    repo: { type: "string", description: "\"owner/repo\"" },
    exists: { type: "boolean" },
    branch: { type: ["string", "null"] },
    head: {
      type: ["object", "null"],
      properties: {
        sha: { type: "string" },
        shortSha: { type: "string" },
        subject: { type: "string" },
      },
      required: ["sha", "shortSha", "subject"],
    },
    details: DETAILS_SUMMARY_SCHEMA,
  },
  required: ["repo", "exists", "branch", "head", "details"],
};

const WORKSPACE_SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string" },
    owner: { type: "string" },
    slug: { type: "string" },
    name: { type: "string" },
  },
  required: ["id", "owner", "slug", "name"],
};

const WORKSPACE_STATUS_SCHEMA = {
  type: "object",
  properties: {
    workspace: { $ref: "#/components/schemas/Workspace" },
    repos: { type: "array", items: { $ref: "#/components/schemas/RepoStatus" } },
    sites: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: ["string", "null"] },
          frontend: { type: ["string", "null"] },
          backend: { type: ["string", "null"] },
          found: { type: "boolean" },
        },
        required: ["id", "name", "frontend", "backend", "found"],
      },
    },
    memory: {
      type: "object",
      properties: {
        repos: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              present: { type: "boolean" },
              coreLabels: { type: "array", items: { type: "string" } },
            },
            required: ["present", "coreLabels"],
          },
        },
        linked: { type: "boolean" },
      },
      required: ["repos", "linked"],
    },
    parent: { anyOf: [{ $ref: "#/components/schemas/WorkspaceSummary" }, { type: "null" }] },
    children: { type: "array", items: { $ref: "#/components/schemas/WorkspaceSummary" } },
    rollup: {
      type: "object",
      properties: {
        descendantCount: { type: "integer", minimum: 0 },
        repos: { type: "array", items: { $ref: "#/components/schemas/RepoStatus" } },
        siteIds: { type: "array", items: { type: "string" } },
      },
      required: ["descendantCount", "repos", "siteIds"],
    },
  },
  required: ["workspace", "repos", "sites", "memory", "parent", "children", "rollup"],
};

const REPO_DETAILS_SCHEMA = {
  type: "object",
  properties: {
    repo: { type: "string", description: "\"owner/repo\"" },
    owner: { type: "string" },
    name: { type: "string" },
    createdAt: { type: ["string", "null"], format: "date-time" },
    description: { type: "string", maxLength: 1024 },
    topics: {
      type: "array", maxItems: 16,
      items: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,31}$" },
    },
    empty: { type: "boolean" },
    defaultBranch: { type: ["string", "null"] },
    commitCount: { type: "integer", minimum: 0 },
    fileCount: { type: "integer", minimum: 0 },
    treeBytes: { type: "integer", minimum: 0 },
    diskBytes: { type: "integer", minimum: 0 },
    lastCommit: COMMIT_SCHEMA,
    recentActivity: {
      type: "array", maxItems: 5,
      items: { type: "object", properties: COMMIT_SCHEMA.properties, required: COMMIT_SCHEMA.required },
    },
    languages: {
      type: "array", maxItems: 8,
      items: {
        type: "object",
        properties: {
          language: { type: "string" },
          files: { type: "integer", minimum: 0 },
          bytes: { type: "integer", minimum: 0 },
          pct: { type: "number", minimum: 0, maximum: 100 },
        },
        required: ["language", "files", "bytes", "pct"],
      },
    },
    readme: {
      type: ["object", "null"],
      properties: {
        path: { type: "string" },
        content: { type: "string", description: "Root README content, capped at 128KB" },
        truncated: { type: "boolean" },
      },
      required: ["path", "content", "truncated"],
    },
    workspaces: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          owner: { type: "string" },
          slug: { type: "string" },
          name: { type: "string" },
          parentId: { type: ["string", "null"] },
        },
        required: ["id", "owner", "slug", "name", "parentId"],
      },
    },
    site: {
      type: ["object", "null"],
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        role: { type: "string", enum: ["frontend", "backend"] },
      },
      required: ["id", "name", "role"],
    },
    ci: {
      type: ["object", "null"],
      description: "Latest CI result object (lib/ci.mjs readLatest), or null when the repo has no CI result",
    },
  },
  required: [
    "repo", "owner", "name", "createdAt", "description", "topics", "empty",
    "defaultBranch", "commitCount", "fileCount", "treeBytes", "diskBytes",
    "lastCommit", "recentActivity", "languages", "readme", "workspaces",
    "site", "ci",
  ],
};

function jsonResponse(description, schema) {
  return { description, content: { "application/json": { schema } } };
}

function errorResponse(description) {
  return jsonResponse(description, { $ref: "#/components/schemas/Error" });
}

/** The ability index served at GET /v1/capabilities. */
export function buildCapabilities() {
  return {
    version: 1,
    abilities: [
      {
        id: "workspaces",
        title: "Workspaces — group repos + sites under one owner, nestable into trees",
        endpoints: [
          "POST /v1/workspaces",
          "GET /v1/workspaces",
          "GET /v1/workspaces/:id",
          "PATCH /v1/workspaces/:id",
          "DELETE /v1/workspaces/:id",
        ],
        mcpTools: [
          "kiln_workspace_create",
          "kiln_workspace_list",
          "kiln_workspace_get",
          "kiln_workspace_update",
          "kiln_workspace_tree",
          "kiln_workspace_delete",
        ],
      },
      {
        id: "project-details",
        title: "Project details — live per-repo facts (history, languages, README) plus editable description/topics",
        endpoints: [
          "GET /v1/repos/:owner/:repo/details",
          "PATCH /v1/repos/:owner/:repo/details",
        ],
        mcpTools: ["kiln_repo_details"],
      },
    ],
    openapi: "/v1/openapi.json",
    docs: "swarm/docs/WORKSPACES.md",
  };
}

/** The OpenAPI 3.1 document served at GET /v1/openapi.json. */
export function buildOpenApiDocument() {
  return {
    openapi: "3.1.0",
    info: {
      title: "KILN Swarm API — workspaces & project details",
      version: "1.0.0",
      description:
        "Discovery surface for the KILN forge daemon: nested workspaces (groupings of repos + sites under one owner) and live per-repo project details. All routes require the daemon bearer token (Authorization: Bearer <token from <stateDir>/api.token>). Errors are {error} objects whose message says what to do next.",
    },
    servers: [{ url: "http://127.0.0.1:18787" }],
    security: [{ bearerAuth: [] }],
    paths: {
      "/v1/workspaces": {
        post: {
          operationId: "createWorkspace",
          summary: "Create a workspace (optionally nested under a same-owner parent)",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    owner: { type: "string" },
                    slug: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,63}$" },
                    name: { type: "string" },
                    description: { type: "string", maxLength: 1024 },
                    repos: { type: "array", items: { type: "string" }, description: "\"owner/repo\" refs; each must exist (404 otherwise)" },
                    siteIds: { type: "array", items: { type: "string" }, description: "Site ids; each must exist (404 otherwise)" },
                    parentId: { type: ["string", "null"], description: "Parent workspace id — must exist (404) and share the owner (400)" },
                  },
                  required: ["owner", "slug", "name"],
                },
              },
            },
          },
          responses: {
            "201": jsonResponse("Created", {
              type: "object",
              properties: { ok: { type: "boolean" }, workspace: { $ref: "#/components/schemas/Workspace" } },
              required: ["ok", "workspace"],
            }),
            "400": errorResponse("Malformed input, or parent owned by a different owner"),
            "404": errorResponse("A member repo, linked site, or the parent workspace does not exist"),
            "409": errorResponse("(owner, slug) already taken"),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
        get: {
          operationId: "listWorkspaces",
          summary: "List workspace records, or the nesting tree with ?tree=1",
          parameters: [
            { name: "owner", in: "query", required: false, schema: { type: "string" }, description: "Only this owner's workspaces" },
            { name: "tree", in: "query", required: false, schema: { type: "string", enum: ["1"] }, description: "tree=1 returns roots with recursive children arrays instead of the flat list" },
          ],
          responses: {
            "200": jsonResponse("Workspace list (flat, or tree nodes when ?tree=1)", {
              type: "object",
              properties: {
                workspaces: {
                  type: "array",
                  items: { anyOf: [{ $ref: "#/components/schemas/Workspace" }, { $ref: "#/components/schemas/WorkspaceTreeNode" }] },
                },
              },
              required: ["workspaces"],
            }),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
      },
      "/v1/workspaces/{id}": {
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" }, description: "Workspace id (ws_…)" },
        ],
        get: {
          operationId: "getWorkspaceStatus",
          summary: "Aggregated live status: member repos (+details summaries), linked sites, memory linkage, parent/children/subtree rollup",
          responses: {
            "200": jsonResponse("Aggregated workspace status", { $ref: "#/components/schemas/WorkspaceStatus" }),
            "404": errorResponse("No such workspace"),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
        patch: {
          operationId: "updateWorkspace",
          summary: "Update a workspace; setParent present = reparent (id or null), absent = unchanged; cycles refused",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    description: { type: "string", maxLength: 1024 },
                    addRepos: { type: "array", items: { type: "string" } },
                    removeRepos: { type: "array", items: { type: "string" } },
                    linkSites: { type: "array", items: { type: "string" } },
                    unlinkSites: { type: "array", items: { type: "string" } },
                    setParent: { type: ["string", "null"], description: "New parent workspace id, or null to make this a root workspace" },
                  },
                },
              },
            },
          },
          responses: {
            "200": jsonResponse("Updated", {
              type: "object",
              properties: { ok: { type: "boolean" }, workspace: { $ref: "#/components/schemas/Workspace" } },
              required: ["ok", "workspace"],
            }),
            "400": errorResponse("Malformed input, cross-owner parent, or setParent would create a cycle"),
            "404": errorResponse("No such workspace, or an added repo / linked site / new parent does not exist"),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
        delete: {
          operationId: "deleteWorkspace",
          summary: "Delete the registry entry (guarded by the slug); children reparent to the deleted workspace's parent",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { confirm: { type: "string", description: "Must equal the workspace's slug" } },
                  required: ["confirm"],
                },
              },
            },
          },
          responses: {
            "200": jsonResponse("Deleted", {
              type: "object",
              properties: { ok: { type: "boolean" }, id: { type: "string" } },
              required: ["ok", "id"],
            }),
            "400": errorResponse("confirm missing or not equal to the workspace slug"),
            "404": errorResponse("No such workspace"),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
      },
      "/v1/repos/{owner}/{repo}/details": {
        parameters: [
          { name: "owner", in: "path", required: true, schema: { type: "string" } },
          { name: "repo", in: "path", required: true, schema: { type: "string" } },
        ],
        get: {
          operationId: "getRepoDetails",
          summary: "Live project details for one hosted repo (derived from the bare repo on every call)",
          responses: {
            "200": jsonResponse("Project details", { $ref: "#/components/schemas/RepoDetails" }),
            "404": errorResponse("No such repo"),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
        patch: {
          operationId: "updateRepoDetails",
          summary: "Edit description/topics (persisted in the repo's kiln.json, unknown fields preserved)",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    description: { type: "string", maxLength: 1024 },
                    topics: {
                      type: "array", maxItems: 16,
                      items: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,31}$" },
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": jsonResponse("Updated project details", {
              type: "object",
              properties: { ok: { type: "boolean" }, details: { $ref: "#/components/schemas/RepoDetails" } },
              required: ["ok", "details"],
            }),
            "400": errorResponse("Description too long, or a topic is invalid"),
            "404": errorResponse("No such repo"),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
      },
      "/v1/capabilities": {
        get: {
          operationId: "getCapabilities",
          summary: "Ability index: what this daemon offers, where the OpenAPI document and docs live",
          responses: {
            "200": jsonResponse("Capabilities", { $ref: "#/components/schemas/Capabilities" }),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
      },
      "/v1/openapi.json": {
        get: {
          operationId: "getOpenApiDocument",
          summary: "This OpenAPI 3.1 document",
          responses: {
            "200": jsonResponse("OpenAPI document", { type: "object" }),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "Token from <stateDir>/api.token" },
      },
      schemas: {
        Error: ERROR_SCHEMA,
        Workspace: WORKSPACE_SCHEMA,
        WorkspaceTreeNode: WORKSPACE_TREE_NODE_SCHEMA,
        WorkspaceSummary: WORKSPACE_SUMMARY_SCHEMA,
        RepoStatus: REPO_STATUS_SCHEMA,
        WorkspaceStatus: WORKSPACE_STATUS_SCHEMA,
        RepoDetails: REPO_DETAILS_SCHEMA,
        Capabilities: {
          type: "object",
          properties: {
            version: { type: "integer" },
            abilities: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  title: { type: "string" },
                  endpoints: { type: "array", items: { type: "string" } },
                  mcpTools: { type: "array", items: { type: "string" } },
                },
                required: ["id", "title", "endpoints", "mcpTools"],
              },
            },
            openapi: { type: "string" },
            docs: { type: "string" },
          },
          required: ["version", "abilities", "openapi", "docs"],
        },
      },
    },
  };
}
