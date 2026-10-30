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
        repoCount: { type: "integer", minimum: 0, description: "Distinct repos across the whole subtree (= repos.length, deduped own-first)" },
        repos: { type: "array", items: { $ref: "#/components/schemas/RepoStatus" } },
        siteIds: { type: "array", items: { type: "string" } },
      },
      required: ["descendantCount", "repoCount", "repos", "siteIds"],
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
    visibility: {
      type: "string", enum: ["private", "public"],
      description: "Owner-chosen read visibility (GitHub-shaped): \"private\" (the default) = accounts-only reads; \"public\" = anyone, including anonymous readers, may read (list, clone/fetch, details, forge GETs). Writes stay owner/operator-only either way.",
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
      description: "Bytes-weighted language breakdown, sorted by bytes descending — languages[0] is the primary language",
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
        title: { type: ["string", "null"], description: "The README's first ATX H1 heading, without the leading '#'; null when it has none" },
        content: { type: "string", description: "Root README content, capped at 128KB" },
        truncated: { type: "boolean" },
      },
      required: ["path", "title", "content", "truncated"],
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
        title: "Project details — live per-repo facts (history, languages, README) plus editable description/topics/visibility",
        endpoints: [
          "GET /v1/repos/:owner/:repo/details",
          "PATCH /v1/repos/:owner/:repo/details",
        ],
        mcpTools: ["kiln_repo_details"],
      },
      {
        id: "sites",
        title: "Sites — first-class frontend+backend repo pairings. Read-only here: list sites to discover the site ids that workspace create/link calls require",
        endpoints: [
          "GET /v1/sites",
          "GET /v1/sites/:id",
        ],
        mcpTools: [],
      },
      {
        id: "accounts",
        title: "Accounts + agent identities — people sign up and log in (sessions), and mint scoped tokens for their own agents. Account/agent principals are owner-scoped: they act only under their own owner namespace, on workspaces + project details + the forge + their own account routes; everything else stays operator-only. Model: swarm/docs/ACCOUNTS.md",
        endpoints: [
          "POST /v1/accounts",
          "POST /v1/accounts/login",
          "GET /v1/accounts/me",
          "POST /v1/accounts/me/agents",
          "GET /v1/accounts/me/agents",
          "DELETE /v1/accounts/me/agents/:id",
        ],
        mcpTools: [],
      },
      {
        id: "forge",
        title: "Forge — the GitHub-shaped repo surface: branches, tree/contents (files written as real git commits by the acting principal — no local clone needed), commit history, compare/diff, pull requests (open, comment, review, merge: fast-forward or merge-commit, CI enqueued on the base), tags and releases with markdown notes. Account/agent principals are walled to their own owner namespace; agents need the \"forge\" scope. Every mutation lands in the forge audit log",
        endpoints: [
          "GET /v1/repos/:owner/:repo/branches",
          "POST /v1/repos/:owner/:repo/branches",
          "DELETE /v1/repos/:owner/:repo/branches/:name",
          "GET /v1/repos/:owner/:repo/tree?ref&path",
          "GET /v1/repos/:owner/:repo/contents?path&ref",
          "PUT /v1/repos/:owner/:repo/contents",
          "DELETE /v1/repos/:owner/:repo/contents",
          "GET /v1/repos/:owner/:repo/commits",
          "GET /v1/repos/:owner/:repo/commits/:sha",
          "GET /v1/repos/:owner/:repo/compare?base&head",
          "GET /v1/repos/:owner/:repo/pulls",
          "POST /v1/repos/:owner/:repo/pulls",
          "GET /v1/repos/:owner/:repo/pulls/:n",
          "PATCH /v1/repos/:owner/:repo/pulls/:n",
          "POST /v1/repos/:owner/:repo/pulls/:n/comments",
          "POST /v1/repos/:owner/:repo/pulls/:n/reviews",
          "POST /v1/repos/:owner/:repo/pulls/:n/merge",
          "GET /v1/repos/:owner/:repo/tags",
          "GET /v1/repos/:owner/:repo/releases",
          "POST /v1/repos/:owner/:repo/releases",
          "GET /v1/repos/:owner/:repo/releases/:tag",
          "PATCH /v1/repos/:owner/:repo/releases/:tag",
          "DELETE /v1/repos/:owner/:repo/releases/:tag",
        ],
        mcpTools: [
          "kiln_forge_branches_list",
          "kiln_forge_branch_create",
          "kiln_forge_branch_delete",
          "kiln_forge_tree",
          "kiln_forge_contents_get",
          "kiln_forge_contents_put",
          "kiln_forge_contents_delete",
          "kiln_forge_commits_list",
          "kiln_forge_commit_get",
          "kiln_forge_compare",
          "kiln_forge_pull_create",
          "kiln_forge_pulls_list",
          "kiln_forge_pull_get",
          "kiln_forge_pull_update",
          "kiln_forge_pull_comment",
          "kiln_forge_pull_review",
          "kiln_forge_pull_merge",
          "kiln_forge_tags_list",
          "kiln_forge_releases_list",
          "kiln_forge_release_create",
          "kiln_forge_release_get",
          "kiln_forge_release_update",
          "kiln_forge_release_delete",
        ],
      },
      {
        id: "packages",
        title: "Packages — versioned package publishing under your owner namespace: publish immutable versioned files (re-publishing different bytes under the same version answers 409), list, resolve and download. Accounts-only, like everything on the forge. A publish/list/get store — not an npm-protocol registry (no dependency resolution)",
        endpoints: [
          "GET /v1/packages",
          "GET /v1/packages/:owner/:name",
          "GET /v1/packages/:owner/:name/:version",
          "GET /v1/packages/:owner/:name/:version/:filename",
          "PUT /v1/packages/:owner/:name/:version/:filename",
        ],
        mcpTools: ["kiln_forge_packages_list", "kiln_forge_package_get", "kiln_forge_package_version_get", "kiln_forge_package_publish", "kiln_forge_package_download"],
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
    // Relative on purpose: this document is served by the instance it
    // describes, whose port/base is deployment-specific (daemon.json's
    // apiUrl). A generated client resolves "/" against the URL it fetched
    // the spec from — a hardcoded port points at the wrong instance.
    servers: [{ url: "/" }],
    security: [{ bearerAuth: [] }],
    paths: {
      "/v1/accounts": {
        post: {
          operationId: "createAccount",
          summary: "Sign up (public bootstrap — authenticates by the new password). The owner is your namespace on the forge; a namespace that already has repos/workspaces is reserved unless an operator-signed signup claims it",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    email: { type: "string", format: "email" },
                    name: { type: "string", maxLength: 120 },
                    owner: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,63}$" },
                    password: { type: "string", minLength: 10 },
                  },
                  required: ["email", "name", "owner", "password"],
                },
              },
            },
          },
          responses: {
            "201": jsonResponse("Created", {
              type: "object",
              properties: { ok: { type: "boolean" }, account: { $ref: "#/components/schemas/Account" } },
              required: ["ok", "account"],
            }),
            "400": errorResponse("Validation failed — the message says what to fix"),
            "409": errorResponse("Email already registered, or owner namespace already claimed/reserved"),
          },
        },
      },
      "/v1/accounts/login": {
        post: {
          operationId: "login",
          summary: "Log in with email + password; returns a session bearer token (kiln_sess_…, 30 days)",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    email: { type: "string", format: "email" },
                    password: { type: "string" },
                  },
                  required: ["email", "password"],
                },
              },
            },
          },
          responses: {
            "200": jsonResponse("Logged in", {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                account: { $ref: "#/components/schemas/Account" },
                sessionToken: { type: "string" },
                expiresAt: { type: "string", format: "date-time" },
              },
              required: ["ok", "account", "sessionToken", "expiresAt"],
            }),
            "401": errorResponse("Invalid email or password (one message for every failure mode)"),
          },
        },
      },
      "/v1/accounts/me": {
        get: {
          operationId: "getMe",
          summary: "The caller's account + principal kind (session or agent token; the operator token is not an account)",
          responses: {
            "200": jsonResponse("The caller's account", {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                account: { $ref: "#/components/schemas/Account" },
                principal: { type: "object" },
              },
              required: ["ok", "account", "principal"],
            }),
            "403": errorResponse("Operator token is not an account"),
          },
        },
      },
      "/v1/accounts/me/agents": {
        post: {
          operationId: "createAgent",
          summary: "Mint an agent identity for your account (session required — agent tokens cannot mint agents). The raw token (kiln_agt_…) is returned exactly once; only its sha256 is stored",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    name: { type: "string", maxLength: 120 },
                    scopes: { type: "array", items: { type: "string", enum: ["workspaces", "project-details"] }, description: "Default: both scopes" },
                  },
                  required: ["name"],
                },
              },
            },
          },
          responses: {
            "201": jsonResponse("Created — token shown once", {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                agent: { $ref: "#/components/schemas/AgentIdentity" },
                token: { type: "string" },
              },
              required: ["ok", "agent", "token"],
            }),
            "403": errorResponse("Agent management requires an account session"),
          },
        },
        get: {
          operationId: "listAgents",
          summary: "List your account's agent identities (session required; tokens/hashes never appear)",
          responses: {
            "200": jsonResponse("Your agents", {
              type: "object",
              properties: { agents: { type: "array", items: { $ref: "#/components/schemas/AgentIdentity" } } },
              required: ["agents"],
            }),
          },
        },
      },
      "/v1/accounts/me/agents/{id}": {
        delete: {
          operationId: "revokeAgent",
          summary: "Revoke one of your agent identities (session required). The record stays for audit; the token dies immediately",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": jsonResponse("Revoked", {
              type: "object",
              properties: { ok: { type: "boolean" }, agent: { $ref: "#/components/schemas/AgentIdentity" } },
              required: ["ok", "agent"],
            }),
            "404": errorResponse("No such agent on your account"),
          },
        },
      },
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
                    siteIds: { type: "array", items: { type: "string" }, description: "Site ids; each must exist (404 otherwise). Discover ids with GET /v1/sites, or from a member repo's project details (details.site.id)" },
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
                    linkSites: { type: "array", items: { type: "string" }, description: "Site ids to link; each must exist (404 otherwise). Discover ids with GET /v1/sites" },
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
      "/v1/sites": {
        get: {
          operationId: "listSites",
          summary: "List site registry records — the discovery read for site ids (workspace create/link validates ids; this is where they come from)",
          responses: {
            "200": jsonResponse("Site records", {
              type: "object",
              properties: {
                sites: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      name: { type: "string" },
                      frontend: { type: "string", description: "\"owner/repo\"" },
                      backend: { type: "string", description: "\"owner/repo\"" },
                      artifact: { type: ["string", "null"] },
                      computeApp: { type: ["string", "null"] },
                      createdAt: { type: "string", format: "date-time" },
                    },
                    required: ["id", "name", "frontend", "backend"],
                  },
                },
              },
              required: ["sites"],
            }),
            "401": errorResponse("Missing or invalid bearer <redacted>"),
          },
        },
      },
      "/v1/sites/{id}": {
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" }, description: "Site id (site_…)" },
        ],
        get: {
          operationId: "getSiteStatus",
          summary: "Aggregated live status for one site (repo HEADs, artifact, compute app)",
          responses: {
            "200": jsonResponse("Site status", { type: "object" }),
            "404": errorResponse("No such site"),
            "401": errorResponse("Missing or invalid bearer <redacted>"),
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
          summary: "Edit description/topics/visibility (persisted in the repo's kiln.json, unknown fields preserved)",
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
                    visibility: { type: "string", enum: ["private", "public"] },
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
        Account: {
          type: "object",
          description: "A forge account. Password hashes and token hashes are never part of any response.",
          properties: {
            id: { type: "string" },
            email: { type: "string", format: "email" },
            name: { type: "string" },
            owner: { type: "string", description: "The account's namespace on the forge — its workspaces and repos live under this owner" },
            createdAt: { type: "string", format: "date-time" },
          },
          required: ["id", "email", "name", "owner", "createdAt"],
        },
        AgentIdentity: {
          type: "object",
          description: "An agent identity owned by an account. The raw token is returned once at creation and never stored or shown again.",
          properties: {
            id: { type: "string" },
            accountId: { type: "string" },
            name: { type: "string" },
            scopes: { type: "array", items: { type: "string", enum: ["workspaces", "project-details"] } },
            createdAt: { type: "string", format: "date-time" },
            revoked: { type: "boolean" },
          },
          required: ["id", "accountId", "name", "scopes", "createdAt", "revoked"],
        },
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
