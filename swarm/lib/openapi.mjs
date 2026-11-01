/**
 * Discovery documents for the KILN daemon API — vendor-neutral, so any
 * AI client (or human) can discover the workspace + project-details
 * surface without insider knowledge:
 *
 *   GET /v1/capabilities  → buildCapabilities(): the ability index.
 *   GET /v1/openapi.json  → buildOpenApiDocument(): OpenAPI 3.1 for the
 *                           daemon's whole /v1 surface (accounts, forge,
 *                           packages, workspaces, sites, compute, promote,
 *                           discovery). test/openapi-drift.test.mjs pins
 *                           this document + the ability index to the
 *                           routes lib/httpapi.mjs actually registers.
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
        title: "Sites — first-class frontend+backend repo pairings: create links two repos (and optionally a published artifact + a compute app) into one site and writes the linkage into both repos' KILN Memory; status aggregates both repo HEADs, the compute app, and the memory linkage live. List sites to discover the site ids that workspace create/link calls require. Deleting a site removes only the registry entry — repos, apps, and memory are untouched. Operator-only (account/agent tokens do not reach this surface)",
        endpoints: [
          "POST /v1/sites",
          "GET /v1/sites",
          "GET /v1/sites/:id",
          "DELETE /v1/sites/:id",
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
        title: "Forge — the GitHub-shaped repo surface: branches, tree/contents (files written as real git commits by the acting principal — no local clone needed), commit history, compare/diff, pull requests (open, comment, review, merge: fast-forward or merge-commit, optional deleteBranch on merge, CI enqueued on the base), tags and releases with markdown notes. Repos are born with an initial commit on main (authored by the creator), so branch → PR → merge works immediately — no client-side seed commit. A repo can be deleted outright (DELETE /v1/repos/:owner/:repo) by its owner's account session or the operator only — agent tokens can never delete. Account/agent principals are walled to their own owner namespace; agents need the \"forge\" scope. Every mutation lands in the forge audit log",
        endpoints: [
          "DELETE /v1/repos/:owner/:repo",
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
          "kiln_forge_repo_delete",
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
      {
        id: "compute",
        title: "Compute — serverless functions on the swarm: invoke one function (optionally blocking with waitMs), fan one function over many items with map, read scheduler capacity, and host repo apps as supervised persistent services (with opt-in public preview URLs when a relay is configured). Operator-only. Programmatic access is the ComputeClient SDK (lib/compute-client.mjs), not MCP",
        endpoints: [
          "POST /v1/compute/invoke",
          "GET /v1/compute/invocations/:id",
          "POST /v1/compute/map",
          "GET /v1/compute/map/:id",
          "GET /v1/compute/capacity",
          "POST /v1/compute/apps",
          "GET /v1/compute/apps",
          "GET /v1/compute/apps/:id",
          "DELETE /v1/compute/apps/:id",
          "GET /v1/compute/apps/:id/logs",
          "POST /v1/compute/apps/:id/preview",
          "DELETE /v1/compute/apps/:id/preview",
        ],
        mcpTools: [],
      },
      {
        id: "promote",
        title: "Promote — push a KILN-native repo to GitHub (Git Data API rebuild) with a structured receipt that never throws: stages name exactly where a promotion stopped (no_target, not_fast_forward, no_github_credential, github_*, …). Operator-only",
        endpoints: [
          "POST /v1/promote",
        ],
        mcpTools: [],
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
      title: "KILN Swarm API",
      version: "1.0.0",
      description:
        "The KILN forge daemon's full /v1 surface: accounts + scoped agent identities, the GitHub-shaped forge (branches, contents-as-commits, pull requests, tags, releases, repo create/delete), packages, nested workspaces, sites, compute (serverless functions + app hosting), and GitHub promotion. Principals: the operator bearer token (root), account sessions (kiln_sess_…), and agent tokens (kiln_agt_…, scope-gated, owner-walled). Public repos additionally answer anonymous GETs. Errors are {error} objects whose message says what to do next. (The non-/v1 operator plane — /jobs, /nodes, /receipts/verify, the /git smart-HTTP + memory routes — is documented in lib/httpapi.mjs's header and swarm/README.md, not here.)",
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
                    scopes: { type: "array", items: { type: "string", enum: ["workspaces", "project-details", "forge"] }, description: "Default: all scopes" },
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
        post: {
          operationId: "createSite",
          summary: "Create a site: link a frontend repo + a backend repo (both must exist) into one site record, optionally with a published-artifact slug and a compute app ref. Also writes the linkage core blocks into both repos' KILN Memory; the registry entry is saved only after those writes succeed. Operator-only",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    name: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$" },
                    frontend: { type: "string", description: "\"owner/repo\" of the site's UI repo" },
                    backend: { type: "string", description: "\"owner/repo\" of the site's API/service repo" },
                    artifact: { type: ["string", "null"], description: "Published web-artifact slug, if any" },
                    computeApp: { type: ["string", "null"], description: "Compute app name or appId running the backend, if KILN-hosted" },
                  },
                  required: ["name", "frontend", "backend"],
                },
              },
            },
          },
          responses: {
            "201": jsonResponse("Created", {
              type: "object",
              properties: { ok: { type: "boolean" }, site: { $ref: "#/components/schemas/Site" } },
              required: ["ok", "site"],
            }),
            "400": errorResponse("Malformed name/refs/artifact"),
            "404": errorResponse("The frontend or backend repo does not exist"),
            "409": errorResponse("A site with this name already exists"),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
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
        delete: {
          operationId: "deleteSite",
          summary: "Delete a site — the registry entry only; repos, compute apps, and memory linkage are untouched. Operator-only",
          responses: {
            "200": jsonResponse("Deleted", {
              type: "object",
              properties: { ok: { type: "boolean" }, id: { type: "string" } },
              required: ["ok", "id"],
            }),
            "404": errorResponse("No such site"),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
      },
      "/v1/repos/{owner}/{repo}": {
        parameters: [
          { name: "owner", in: "path", required: true, schema: { type: "string" } },
          { name: "repo", in: "path", required: true, schema: { type: "string" } },
        ],
        delete: {
          operationId: "deleteRepo",
          summary: "Delete a repo outright: the bare git dir (with its kiln.json details and memory chain), its forge records (pulls/releases), and its stored CI results are removed; workspace/site registries keep their member refs and render the repo as missing. Authorization is the strictest on the forge: the repo owner's account session or the operator token — agent tokens can NEVER delete, a non-owner session answers 403, anonymous answers 401",
          responses: {
            "200": jsonResponse("Deleted", {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                owner: { type: "string" },
                repo: { type: "string" },
                deleted: { type: "boolean" },
              },
              required: ["ok", "owner", "repo", "deleted"],
            }),
            "400": errorResponse("Invalid owner/repo name"),
            "403": errorResponse("Agent token, or an account session that does not own this repo"),
            "404": errorResponse("No such repo"),
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
      "/v1/repos/{owner}/{repo}/branches": {
        parameters: [
          { name: "owner", in: "path", required: true, schema: { type: "string" } },
          { name: "repo", in: "path", required: true, schema: { type: "string" } },
        ],
        get: {
          operationId: "listBranches",
          summary: "List branches with tip shas (forge; public repos answer anyone, private repos owner-namespace only)",
          responses: {
            "200": jsonResponse("Branches", {
              type: "object",
              properties: { branches: { type: "array", items: { $ref: "#/components/schemas/Branch" } } },
              required: ["branches"],
            }),
            "404": errorResponse("No such repo"),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
        post: {
          operationId: "createBranch",
          summary: "Create a branch from a ref (default: the default branch's tip). Owner namespace / operator only",
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                name: { type: "string" },
                from: { type: "string", description: "Source ref/sha; defaults to the default branch" },
              },
              required: ["name"],
            } } },
          },
          responses: {
            "201": jsonResponse("Created", {
              type: "object",
              properties: { ok: { type: "boolean" }, branch: { $ref: "#/components/schemas/Branch" } },
              required: ["ok", "branch"],
            }),
            "400": errorResponse("Invalid branch name or source ref"),
            "404": errorResponse("No such repo"),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
      },
      "/v1/repos/{owner}/{repo}/branches/{name}": {
        parameters: [
          { name: "owner", in: "path", required: true, schema: { type: "string" } },
          { name: "repo", in: "path", required: true, schema: { type: "string" } },
          { name: "name", in: "path", required: true, schema: { type: "string" }, description: "Branch name, percent-encoded (slash-named branches encode as %2F)" },
        ],
        delete: {
          operationId: "deleteBranch",
          summary: "Delete a branch (the default branch is refused). Owner namespace / operator only",
          responses: {
            "200": jsonResponse("Deleted", { type: "object" }),
            "400": errorResponse("Refused (e.g. the default branch)"),
            "404": errorResponse("No such repo or branch"),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
      },
      "/v1/repos/{owner}/{repo}/tree": {
        parameters: [
          { name: "owner", in: "path", required: true, schema: { type: "string" } },
          { name: "repo", in: "path", required: true, schema: { type: "string" } },
        ],
        get: {
          operationId: "readTree",
          summary: "Read one directory level of a ref's tree",
          parameters: [
            { name: "ref", in: "query", required: false, schema: { type: "string" }, description: "Branch, tag, or sha; defaults to the default branch" },
            { name: "path", in: "query", required: false, schema: { type: "string" }, description: "Directory path within the tree (default: root)" },
          ],
          responses: {
            "200": jsonResponse("Tree level", { $ref: "#/components/schemas/Tree" }),
            "404": errorResponse("No such repo, ref, or path"),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
      },
      "/v1/repos/{owner}/{repo}/contents": {
        parameters: [
          { name: "owner", in: "path", required: true, schema: { type: "string" } },
          { name: "repo", in: "path", required: true, schema: { type: "string" } },
        ],
        get: {
          operationId: "getContents",
          summary: "Read one file at a ref. Default response is base64 JSON; ?raw=1 returns the raw bytes with an x-kiln-sha header",
          parameters: [
            { name: "path", in: "query", required: false, schema: { type: "string" } },
            { name: "ref", in: "query", required: false, schema: { type: "string" } },
            { name: "raw", in: "query", required: false, schema: { type: "string", enum: ["1"] } },
          ],
          responses: {
            "200": jsonResponse("File contents (base64) or raw bytes", { $ref: "#/components/schemas/Contents" }),
            "404": errorResponse("No such repo, ref, or file"),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
        put: {
          operationId: "putContents",
          summary: "Write a file — a REAL git commit authored by the acting principal (the agent write path; git push stays operator-only). Pass the current blob sha to guard against overwriting someone else's change. Owner namespace / operator only",
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                path: { type: "string" },
                content: { type: "string", description: "File content (base64 when encoding is base64; plain text otherwise)" },
                encoding: { type: "string", enum: ["base64", "utf8"], description: "Default utf8" },
                message: { type: "string", description: "Commit message (required)" },
                branch: { type: "string", description: "Target branch; defaults to the default branch" },
                sha: { type: "string", description: "Expected current blob sha (optimistic concurrency)" },
              },
              required: ["path", "content", "message"],
            } } },
          },
          responses: {
            "201": jsonResponse("Committed", { type: "object" }),
            "400": errorResponse("Malformed write"),
            "404": errorResponse("No such repo or branch"),
            "409": errorResponse("Sha mismatch — the file changed underneath you"),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
        delete: {
          operationId: "deleteContents",
          summary: "Delete a file — also a real commit by the acting principal. Owner namespace / operator only",
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                path: { type: "string" },
                message: { type: "string" },
                branch: { type: "string" },
                sha: { type: "string" },
              },
              required: ["path", "message"],
            } } },
          },
          responses: {
            "200": jsonResponse("Committed", { type: "object" }),
            "404": errorResponse("No such repo, branch, or file"),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
      },
      "/v1/repos/{owner}/{repo}/commits": {
        parameters: [
          { name: "owner", in: "path", required: true, schema: { type: "string" } },
          { name: "repo", in: "path", required: true, schema: { type: "string" } },
        ],
        get: {
          operationId: "listCommits",
          summary: "Commit history for a ref, newest first",
          parameters: [
            { name: "ref", in: "query", required: false, schema: { type: "string" } },
            { name: "limit", in: "query", required: false, schema: { type: "string" } },
            { name: "path", in: "query", required: false, schema: { type: "string" }, description: "Only commits touching this path" },
          ],
          responses: {
            "200": jsonResponse("Commits", { type: "object" }),
            "404": errorResponse("No such repo or ref"),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
      },
      "/v1/repos/{owner}/{repo}/commits/{sha}": {
        parameters: [
          { name: "owner", in: "path", required: true, schema: { type: "string" } },
          { name: "repo", in: "path", required: true, schema: { type: "string" } },
          { name: "sha", in: "path", required: true, schema: { type: "string" }, description: "Full or abbreviated (≥4 hex) commit sha" },
        ],
        get: {
          operationId: "getCommit",
          summary: "One commit with its file stats",
          responses: {
            "200": jsonResponse("Commit", { type: "object" }),
            "404": errorResponse("No such repo or commit"),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
      },
      "/v1/repos/{owner}/{repo}/compare": {
        parameters: [
          { name: "owner", in: "path", required: true, schema: { type: "string" } },
          { name: "repo", in: "path", required: true, schema: { type: "string" } },
        ],
        get: {
          operationId: "compareRefs",
          summary: "Compare two refs: ahead/behind counts, changed files, and a capped patch",
          parameters: [
            { name: "base", in: "query", required: true, schema: { type: "string" } },
            { name: "head", in: "query", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": jsonResponse("Comparison", { type: "object" }),
            "400": errorResponse("base/head missing or unresolvable"),
            "404": errorResponse("No such repo"),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
      },
      "/v1/repos/{owner}/{repo}/tags": {
        parameters: [
          { name: "owner", in: "path", required: true, schema: { type: "string" } },
          { name: "repo", in: "path", required: true, schema: { type: "string" } },
        ],
        get: {
          operationId: "listTags",
          summary: "List tags with their target shas",
          responses: {
            "200": jsonResponse("Tags", {
              type: "object",
              properties: { tags: { type: "array", items: { type: "object" } } },
              required: ["tags"],
            }),
            "404": errorResponse("No such repo"),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
      },
      "/v1/repos/{owner}/{repo}/releases": {
        parameters: [
          { name: "owner", in: "path", required: true, schema: { type: "string" } },
          { name: "repo", in: "path", required: true, schema: { type: "string" } },
        ],
        get: {
          operationId: "listReleases",
          summary: "List releases (tag + markdown notes, stored in the forge registry)",
          responses: {
            "200": jsonResponse("Releases", {
              type: "object",
              properties: { releases: { type: "array", items: { $ref: "#/components/schemas/Release" } } },
              required: ["releases"],
            }),
            "404": errorResponse("No such repo"),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
        post: {
          operationId: "createRelease",
          summary: "Create a release: tags the target ref and stores the notes. Owner namespace / operator only",
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                tag: { type: "string" },
                name: { type: "string" },
                notes: { type: "string", description: "Markdown release notes" },
                target: { type: "string", description: "Ref to tag; defaults to the default branch" },
              },
              required: ["tag"],
            } } },
          },
          responses: {
            "201": jsonResponse("Created", {
              type: "object",
              properties: { ok: { type: "boolean" }, release: { $ref: "#/components/schemas/Release" } },
              required: ["ok", "release"],
            }),
            "400": errorResponse("Invalid tag or target"),
            "404": errorResponse("No such repo"),
            "409": errorResponse("Tag or release already exists"),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
      },
      "/v1/repos/{owner}/{repo}/releases/{tag}": {
        parameters: [
          { name: "owner", in: "path", required: true, schema: { type: "string" } },
          { name: "repo", in: "path", required: true, schema: { type: "string" } },
          { name: "tag", in: "path", required: true, schema: { type: "string" } },
        ],
        get: {
          operationId: "getRelease",
          summary: "One release by tag",
          responses: {
            "200": jsonResponse("Release", {
              type: "object",
              properties: { release: { $ref: "#/components/schemas/Release" } },
              required: ["release"],
            }),
            "404": errorResponse("No such repo or release"),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
        patch: {
          operationId: "updateRelease",
          summary: "Edit a release's name/notes. Owner namespace / operator only",
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              properties: { name: { type: "string" }, notes: { type: "string" } },
            } } },
          },
          responses: {
            "200": jsonResponse("Updated", {
              type: "object",
              properties: { ok: { type: "boolean" }, release: { $ref: "#/components/schemas/Release" } },
              required: ["ok", "release"],
            }),
            "404": errorResponse("No such repo or release"),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
        delete: {
          operationId: "deleteRelease",
          summary: "Delete a release record; deleteTag:true also deletes the git tag. Owner namespace / operator only",
          requestBody: {
            required: false,
            content: { "application/json": { schema: {
              type: "object",
              properties: { deleteTag: { type: "boolean" } },
            } } },
          },
          responses: {
            "200": jsonResponse("Deleted", { type: "object" }),
            "404": errorResponse("No such repo or release"),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
      },
      "/v1/repos/{owner}/{repo}/pulls": {
        parameters: [
          { name: "owner", in: "path", required: true, schema: { type: "string" } },
          { name: "repo", in: "path", required: true, schema: { type: "string" } },
        ],
        get: {
          operationId: "listPulls",
          summary: "List pull requests, optionally filtered by ?state (open/closed/merged)",
          parameters: [
            { name: "state", in: "query", required: false, schema: { type: "string" } },
          ],
          responses: {
            "200": jsonResponse("Pull requests", {
              type: "object",
              properties: { pulls: { type: "array", items: { $ref: "#/components/schemas/Pull" } } },
              required: ["pulls"],
            }),
            "404": errorResponse("No such repo"),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
        post: {
          operationId: "createPull",
          summary: "Open a pull request (head → base). On a repo whose base has no commits yet (pre-lifecycle legacy repos only — new repos are born with an initial commit) this answers an explicit 409 naming the state and the way out. Owner namespace / operator only",
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                title: { type: "string" },
                body: { type: "string" },
                head: { type: "string", description: "Head branch" },
                base: { type: "string", description: "Base branch; defaults to the default branch" },
              },
              required: ["title", "head"],
            } } },
          },
          responses: {
            "201": jsonResponse("Created", {
              type: "object",
              properties: { ok: { type: "boolean" }, pull: { $ref: "#/components/schemas/Pull" } },
              required: ["ok", "pull"],
            }),
            "400": errorResponse("Malformed pull (missing head/base, same branch)"),
            "404": errorResponse("No such repo or branch"),
            "409": errorResponse("Base branch has no commits yet (legacy unborn repo)"),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
      },
      "/v1/repos/{owner}/{repo}/pulls/{n}": {
        parameters: [
          { name: "owner", in: "path", required: true, schema: { type: "string" } },
          { name: "repo", in: "path", required: true, schema: { type: "string" } },
          { name: "n", in: "path", required: true, schema: { type: "integer" }, description: "Pull request number" },
        ],
        get: {
          operationId: "getPull",
          summary: "One pull request with comments + reviews",
          responses: {
            "200": jsonResponse("Pull request", {
              type: "object",
              properties: { pull: { $ref: "#/components/schemas/Pull" } },
              required: ["pull"],
            }),
            "404": errorResponse("No such repo or pull"),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
        patch: {
          operationId: "updatePull",
          summary: "Edit title/body, or close/reopen (state). Owner namespace / operator only",
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                title: { type: "string" },
                body: { type: "string" },
                state: { type: "string", enum: ["open", "closed"] },
              },
            } } },
          },
          responses: {
            "200": jsonResponse("Updated", {
              type: "object",
              properties: { ok: { type: "boolean" }, pull: { $ref: "#/components/schemas/Pull" } },
              required: ["ok", "pull"],
            }),
            "404": errorResponse("No such repo or pull"),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
      },
      "/v1/repos/{owner}/{repo}/pulls/{n}/comments": {
        parameters: [
          { name: "owner", in: "path", required: true, schema: { type: "string" } },
          { name: "repo", in: "path", required: true, schema: { type: "string" } },
          { name: "n", in: "path", required: true, schema: { type: "integer" } },
        ],
        post: {
          operationId: "commentPull",
          summary: "Comment on a pull request. Owner namespace / operator only",
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              properties: { body: { type: "string" } },
              required: ["body"],
            } } },
          },
          responses: {
            "201": jsonResponse("Commented", { type: "object" }),
            "404": errorResponse("No such repo or pull"),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
      },
      "/v1/repos/{owner}/{repo}/pulls/{n}/reviews": {
        parameters: [
          { name: "owner", in: "path", required: true, schema: { type: "string" } },
          { name: "repo", in: "path", required: true, schema: { type: "string" } },
          { name: "n", in: "path", required: true, schema: { type: "integer" } },
        ],
        post: {
          operationId: "reviewPull",
          summary: "Review a pull request (approve / request_changes / comment). Owner namespace / operator only",
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                state: { type: "string", enum: ["approved", "changes_requested", "commented"] },
                body: { type: "string" },
              },
              required: ["state"],
            } } },
          },
          responses: {
            "201": jsonResponse("Reviewed", { type: "object" }),
            "400": errorResponse("Invalid review state"),
            "404": errorResponse("No such repo or pull"),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
      },
      "/v1/repos/{owner}/{repo}/pulls/{n}/merge": {
        parameters: [
          { name: "owner", in: "path", required: true, schema: { type: "string" } },
          { name: "repo", in: "path", required: true, schema: { type: "string" } },
          { name: "n", in: "path", required: true, schema: { type: "integer" } },
        ],
        post: {
          operationId: "mergePull",
          summary: "Merge a pull request: method \"merge\" (merge commit) or \"ff\" (fast-forward only). deleteBranch:true deletes the head branch after a successful merge (default off; a branch that must stay never fails the merge — the answer reports headBranchDeleted/headBranchKept). CI is enqueued on the base branch after merge, best-effort. Owner namespace / operator only",
          requestBody: {
            required: false,
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                method: { type: "string", enum: ["merge", "ff"] },
                message: { type: "string", description: "Merge commit message override" },
                deleteBranch: { type: "boolean" },
              },
            } } },
          },
          responses: {
            "200": jsonResponse("Merged", { type: "object" }),
            "400": errorResponse("Pull is not open, or method invalid"),
            "404": errorResponse("No such repo or pull"),
            "409": errorResponse("Merge conflict, or ff requested but not fast-forwardable"),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
      },
      "/v1/packages": {
        get: {
          operationId: "listPackages",
          summary: "List packages (operator: any owner or ?owner= filter; account/agent principals: only their own namespace)",
          parameters: [
            { name: "owner", in: "query", required: false, schema: { type: "string" } },
          ],
          responses: {
            "200": jsonResponse("Packages", {
              type: "object",
              properties: { packages: { type: "array", items: { $ref: "#/components/schemas/Package" } } },
              required: ["packages"],
            }),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
      },
      "/v1/packages/{owner}/{name}": {
        parameters: [
          { name: "owner", in: "path", required: true, schema: { type: "string" } },
          { name: "name", in: "path", required: true, schema: { type: "string" } },
        ],
        get: {
          operationId: "getPackage",
          summary: "One package with its versions",
          responses: {
            "200": jsonResponse("Package", {
              type: "object",
              properties: { package: { $ref: "#/components/schemas/Package" } },
              required: ["package"],
            }),
            "404": errorResponse("No such package"),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
      },
      "/v1/packages/{owner}/{name}/{version}": {
        parameters: [
          { name: "owner", in: "path", required: true, schema: { type: "string" } },
          { name: "name", in: "path", required: true, schema: { type: "string" } },
          { name: "version", in: "path", required: true, schema: { type: "string" } },
        ],
        get: {
          operationId: "getPackageVersion",
          summary: "One package version with its files",
          responses: {
            "200": jsonResponse("Package version", { type: "object" }),
            "404": errorResponse("No such package or version"),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
      },
      "/v1/packages/{owner}/{name}/{version}/{filename}": {
        parameters: [
          { name: "owner", in: "path", required: true, schema: { type: "string" } },
          { name: "name", in: "path", required: true, schema: { type: "string" } },
          { name: "version", in: "path", required: true, schema: { type: "string" } },
          { name: "filename", in: "path", required: true, schema: { type: "string" } },
        ],
        get: {
          operationId: "downloadPackageFile",
          summary: "Download a published file (raw bytes; x-kiln-sha256 header carries its digest)",
          responses: {
            "200": { description: "The file bytes", content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
            "404": errorResponse("No such package, version, or file"),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
        put: {
          operationId: "publishPackageFile",
          summary: "Publish a file (raw request body) under an immutable version: re-publishing identical bytes is idempotent (200); different bytes under the same version+file answer 409. ?description= and ?repo= attach metadata. Owner namespace / operator only",
          parameters: [
            { name: "description", in: "query", required: false, schema: { type: "string" } },
            { name: "repo", in: "query", required: false, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
          },
          responses: {
            "201": jsonResponse("Published", { type: "object" }),
            "200": jsonResponse("Idempotent re-publish (same bytes)", { type: "object" }),
            "409": errorResponse("Different bytes already published under this version+file"),
            "413": errorResponse("File too large"),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
      },
      "/v1/promote": {
        post: {
          operationId: "promoteRepo",
          summary: "Promote a KILN-native repo to GitHub (Git Data API rebuild). The receipt never throws: failures arrive as a receipt whose error.stage names where it stopped. Operator-only",
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                repo: { type: "string", description: "\"owner/repo\" of the KILN repo" },
                github: { type: "string", description: "\"owner/repo\" on GitHub; defaults to the same owner/repo" },
                branch: { type: "string" },
                rebase: { type: "boolean" },
                force: { type: "boolean" },
              },
              required: ["repo"],
            } } },
          },
          responses: {
            "200": jsonResponse("Promotion receipt (ok:true)", { type: "object" }),
            "400": errorResponse("Malformed repo/github (or receipt stage no_target/bad_target)"),
            "404": errorResponse("Receipt stage repo_not_found / github_repo_not_found"),
            "409": errorResponse("Receipt stage not_fast_forward / rebase_needs_root"),
            "412": errorResponse("Receipt stage no_github_credential"),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
      },
      "/v1/compute/invoke": {
        post: {
          operationId: "computeInvoke",
          summary: "Invoke a serverless function (code must export main(args)). Without waitMs: 201 + poll the invocation. With waitMs (1000..300000): blocks and returns the full result. Operator-only",
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                name: { type: "string" },
                code: { type: "string", description: "Module source, ≤256KB" },
                args: { description: "JSON arguments for main(args)" },
                timeoutMs: { type: "integer", minimum: 100, maximum: 300000 },
                memoryMB: { type: "integer" },
                network: { type: "boolean" },
                retries: { type: "integer" },
                waitMs: { type: "integer", minimum: 1000, maximum: 300000 },
              },
              required: ["code"],
            } } },
          },
          responses: {
            "201": jsonResponse("Accepted (no waitMs)", {
              type: "object",
              properties: {
                invocationId: { type: "string" }, jobId: { type: "string" }, status: { type: "string" },
              },
              required: ["invocationId", "jobId", "status"],
            }),
            "200": jsonResponse("Completed result (waitMs set)", { type: "object" }),
            "400": errorResponse("Malformed invocation or waitMs out of range"),
            "429": errorResponse("Compute admission limit — retry shortly"),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
      },
      "/v1/compute/invocations/{id}": {
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        get: {
          operationId: "computeGetInvocation",
          summary: "One invocation's status/result/logs",
          responses: {
            "200": jsonResponse("Invocation", { type: "object" }),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
      },
      "/v1/compute/map": {
        post: {
          operationId: "computeMap",
          summary: "Fan one function over many items (max 64); each item is its own job spread across idle workers. Operator-only",
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                name: { type: "string" },
                code: { type: "string" },
                items: { type: "array", maxItems: 64 },
                timeoutMs: { type: "integer" },
                memoryMB: { type: "integer" },
                network: { type: "boolean" },
                retries: { type: "integer" },
              },
              required: ["code", "items"],
            } } },
          },
          responses: {
            "201": jsonResponse("Map accepted", { type: "object" }),
            "400": errorResponse("Malformed map"),
            "429": errorResponse("Compute admission limit — retry shortly"),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
      },
      "/v1/compute/map/{id}": {
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        get: {
          operationId: "computeGetMap",
          summary: "One map's counts + per-item results",
          responses: {
            "200": jsonResponse("Map", { type: "object" }),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
      },
      "/v1/compute/capacity": {
        get: {
          operationId: "computeCapacity",
          summary: "Scheduler capacity telemetry (Little's-law admission view)",
          responses: {
            "200": jsonResponse("Capacity", { type: "object" }),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
      },
      "/v1/compute/apps": {
        post: {
          operationId: "computeDeployApp",
          summary: "Deploy a repo as a persistent supervised app (the worker boots the command, restarts it on crash; survives daemon restarts). public:true also enables a public preview URL when a relay is configured. Operator-only",
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                name: { type: "string" },
                repo: { type: "string", description: "Clone URL of the app repo" },
                command: { type: "string" },
                args: { type: "array", items: { type: "string" } },
                env: { type: "object", additionalProperties: { type: "string" } },
                port: { type: "integer" },
                memoryMB: { type: "integer" },
                public: { type: "boolean" },
              },
              required: ["name", "repo", "command"],
            } } },
          },
          responses: {
            "201": jsonResponse("Deployed", { type: "object" }),
            "400": errorResponse("Malformed app spec"),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
        get: {
          operationId: "computeListApps",
          summary: "List deployed apps, each with its preview state",
          responses: {
            "200": jsonResponse("Apps", {
              type: "object",
              properties: { apps: { type: "array", items: { type: "object" } } },
              required: ["apps"],
            }),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
      },
      "/v1/compute/apps/{id}": {
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        get: {
          operationId: "computeGetApp",
          summary: "One app's status + preview state",
          responses: {
            "200": jsonResponse("App status", { type: "object" }),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
        delete: {
          operationId: "computeUndeployApp",
          summary: "Undeploy an app (stops it for good; its preview is torn down first). Operator-only",
          responses: {
            "200": jsonResponse("Undeployed", { type: "object" }),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
      },
      "/v1/compute/apps/{id}/logs": {
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        get: {
          operationId: "computeAppLogs",
          summary: "An app's log tail (?tail=N, default 100)",
          parameters: [
            { name: "tail", in: "query", required: false, schema: { type: "integer" } },
          ],
          responses: {
            "200": jsonResponse("Logs", { type: "object" }),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
      },
      "/v1/compute/apps/{id}/preview": {
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        post: {
          operationId: "computeEnablePreview",
          summary: "Enable the app's public preview URL (needs a configured relay; the answer says so when there is none)",
          responses: {
            "200": jsonResponse("Preview state", { type: "object" }),
            "401": errorResponse("Missing or invalid bearer token"),
          },
        },
        delete: {
          operationId: "computeDisablePreview",
          summary: "Disable the app's public preview URL",
          responses: {
            "200": jsonResponse("Preview state", { type: "object" }),
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
            scopes: { type: "array", items: { type: "string", enum: ["workspaces", "project-details", "forge"] } },
            createdAt: { type: "string", format: "date-time" },
            revoked: { type: "boolean" },
          },
          required: ["id", "accountId", "name", "scopes", "createdAt", "revoked"],
        },
        Site: {
          type: "object",
          properties: {
            id: { type: "string", pattern: "^site_" },
            name: { type: "string" },
            frontend: { type: "string", description: "\"owner/repo\"" },
            backend: { type: "string", description: "\"owner/repo\"" },
            artifact: { type: ["string", "null"] },
            computeApp: { type: ["string", "null"] },
            createdAt: { type: "string", format: "date-time" },
          },
          required: ["id", "name", "frontend", "backend", "artifact", "computeApp", "createdAt"],
        },
        Branch: {
          type: "object",
          properties: {
            name: { type: "string" },
            sha: { type: "string" },
            shortSha: { type: "string" },
            isDefault: { type: "boolean" },
          },
          required: ["name", "sha"],
        },
        Tree: {
          type: "object",
          properties: {
            ref: { type: "string" },
            path: { type: "string" },
            entries: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  path: { type: "string" },
                  type: { type: "string", enum: ["blob", "tree"] },
                  sha: { type: "string" },
                  size: { type: ["integer", "null"] },
                },
                required: ["name", "path", "type", "sha"],
              },
            },
          },
          required: ["ref", "path", "entries"],
        },
        Contents: {
          type: "object",
          properties: {
            path: { type: "string" },
            ref: { type: "string" },
            commit: { type: "string" },
            sha: { type: "string", description: "Blob sha" },
            size: { type: "integer" },
            encoding: { type: "string", enum: ["base64"] },
            content: { type: "string", description: "Base64 file bytes (absent when ?raw=1 streams the bytes instead)" },
          },
          required: ["path", "sha", "size"],
        },
        Pull: {
          type: "object",
          properties: {
            number: { type: "integer" },
            title: { type: "string" },
            body: { type: "string" },
            state: { type: "string", enum: ["open", "closed", "merged"] },
            head: { type: "string" },
            base: { type: "string" },
            author: { type: "object" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
            comments: { type: "array", items: { type: "object" } },
            reviews: { type: "array", items: { type: "object" } },
          },
          required: ["number", "title", "state", "head", "base"],
        },
        Release: {
          type: "object",
          properties: {
            tag: { type: "string" },
            name: { type: "string" },
            notes: { type: "string" },
            target: { type: "string" },
            sha: { type: "string" },
            author: { type: "object" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
          required: ["tag"],
        },
        Package: {
          type: "object",
          properties: {
            owner: { type: "string" },
            name: { type: "string" },
            versions: { type: "array", items: { type: "string" } },
            description: { type: ["string", "null"] },
            repo: { type: ["string", "null"] },
            updatedAt: { type: ["string", "null"], format: "date-time" },
          },
          required: ["owner", "name"],
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
