# KILN Workspaces

A **workspace** is the whole effort, not just a site: any number of
member repos plus any number of linked [sites](SITES.md), grouped under
one owner and one slug. A site ties exactly one frontend repo to one
backend repo; real products are wider than that. DFW Haul is four repos
(app, edge port, verification harness, workspace docs) plus its Site
record — before Workspaces, that grouping lived in people's heads and
in prose docs. Workspaces makes it a first-class record the daemon can
serve, check, and keep honest.

## The record

Workspaces live in a disk-backed registry at `<stateDir>/workspaces.json`
(atomic tmp+rename writes, same discipline as the sites and compute
stores):

```json
{
  "id": "ws_…",
  "owner": "auro",
  "slug": "dfw-haul",
  "name": "DFW Haul",
  "description": "Box truck / moving / hauling marketplace",
  "repos": ["auro/dfw-service-hub", "auro/dfw-edge",
            "auro/dfw-harness", "auro/dfw-workspace"],
  "siteIds": ["site_7c0b5922d708"],
  "parentId": null,
  "createdAt": "2026-10-27T…Z",
  "updatedAt": "2026-10-27T…Z"
}
```

`(owner, slug)` is unique (`409` on collision). Member repos must be
existing KILN-native repos (`404` otherwise); linked sites must exist in
the sites registry (`404`). The same existence rule applies to repos
**added** and sites **linked** by an update — but removals and unlinks
are validated by format only, so a member whose repo or site was deleted
from the forge first can still be removed from the workspace (never a
stranded ghost). Names are human names: Unicode letters/digits plus
spaces and `_ . : + & - – —` (max 128 chars — "DFW Haul — Marketplace"
validates). Descriptions ≤ 1024 chars.

## Nesting: workspaces inside workspaces

A workspace may live under another workspace. The record carries one
extra field:

- **`parentId`** — the id of the parent workspace, or `null` for a root
  workspace. Records written before nesting existed have no such field
  and read as `null` everywhere (no migration write).

The rules are strict, and every error says what to do instead:

- **Create** accepts `parentId?`. The parent must exist (`404`) and
  must have the **same owner** as the new workspace (`400` — parents
  must share the workspace's owner).
- **Update** uses a dedicated patch key, **`setParent`**: present means
  change (an id string reparents, `null` clears to root), absent means
  unchanged — a rename patch can never silently move a workspace.
  **Cycle protection:** walking the new parent's ancestor chain must
  never reach this workspace — that one walk refuses both self-parenting
  and parenting a workspace under one of its own descendants (`400`,
  message names the chain rule).
- **Delete** reparents the deleted workspace's children to the deleted
  workspace's own parent (or root) in the same write — the tree never
  dangles.

Reads come in three shapes:

- **Flat list** (unchanged): `GET /v1/workspaces?owner=` →
  `{workspaces: [...]}`; lib `listWorkspaces(dir, {owner})`.
- **Tree**: `GET /v1/workspaces?tree=1` → `{workspaces: [roots…]}`,
  where each node is the record plus a recursive `children: [...]`;
  lib `workspaceTree(dir, {owner})`; CLI `workspaces tree`.
- **Status** (below) gains `parent` (`{id, owner, slug, name} | null`),
  `children` (direct children, same summary shape), and **`rollup`**:
  the whole subtree in one object — `descendantCount`, `siteIds`
  unioned across the subtree, and `repos`: member repos of this
  workspace **and all descendants**, deduped by repo ref (first
  occurrence wins, own repos first), each entry the usual repo status
  plus a [project-details summary](#project-details-per-repo).

## Linkage lives in the repos, not just the registry

The registry is an index. The durable link is written into each member
repo's own **KILN Memory** (`refs/kiln/memory` core blocks) at create
time — and whenever a repo is added later — so any member repo can walk
to the workspace on its own:

| Repo | Core block written |
|---|---|
| every member repo | `workspace` = `"<slug> (<id>)"` |

Creating a workspace writes memory first and saves the registry entry
only after the writes succeed — a failed create leaves nothing
half-linked. Deleting a workspace removes **only** the registry entry:
repos, sites, and the memory links are deliberately untouched (memory
is append-only history; supersede there if a link ever needs
retracting). Because the link must never be deletable by accident,
delete is **guarded**: the caller must explicitly pass the workspace's
slug as `confirm`.

## HTTP API (bearer <redacted>, like every `/v1` route)

| Route | What it does |
|---|---|
| `POST /v1/workspaces` | Create `{owner, slug, name, description?, repos?, siteIds?, parentId?}` → `201 {ok, workspace}`. Errors: `400` malformed or cross-owner parent, `404` repo/site/parent missing, `409` `(owner, slug)` taken. |
| `GET /v1/workspaces?owner=` | List registry records → `{workspaces: [...]}` (owner filter optional). `?tree=1` returns the nesting tree instead (roots with recursive `children`). |
| `GET /v1/workspaces/:id` | Aggregated **live** status (below) |
| `PATCH /v1/workspaces/:id` | Update `{name?, description?, addRepos?, removeRepos?, linkSites?, unlinkSites?, setParent?}` → `{ok, workspace}`. `setParent` present = reparent (id or `null`); a cycle → `400`. |
| `DELETE /v1/workspaces/:id` | Body `{confirm: "<slug>"}` → `{ok: true, id}`. Missing/wrong confirm → `400`. Children reparent to the deleted workspace's parent. |
| `GET /v1/repos/:owner/:repo/details` | [Project details](#project-details-per-repo) for one repo → the details object. Unknown repo → `404`. |
| `PATCH /v1/repos/:owner/:repo/details` | Edit `{description?, topics?}` → `{ok, details}`. Invalid values → `400`. |

### Aggregated status

`GET /v1/workspaces/:id` computes everything fresh on every call —
nothing is cached, so it cannot go stale:

```json
{
  "workspace": { "…": "the registry record" },
  "repos": [
    { "repo": "auro/dfw-edge", "exists": true, "branch": "main",
      "head": { "sha": "…", "shortSha": "e9b1f75", "subject": "…" },
      "details": { "description": "", "topics": [],
                   "defaultBranch": "main", "commitCount": 12,
                   "lastCommit": { "sha": "…", "…": "…" } } }
  ],
  "sites": [
    { "id": "site_7c0b5922d708", "name": "dfw-haul",
      "frontend": "auro/dfw-service-hub", "backend": "auro/dfw-edge",
      "found": true }
  ],
  "memory": {
    "repos": { "auro/dfw-edge": { "present": true, "coreLabels": ["workspace", "…"] } },
    "linked": true
  },
  "parent": null,
  "children": [ { "id": "ws_…", "owner": "auro", "slug": "…", "name": "…" } ],
  "rollup": {
    "descendantCount": 1,
    "repos": [ "…repo status entries for the whole subtree, deduped…" ],
    "siteIds": ["site_7c0b5922d708"]
  }
}
```

- **Repo HEADs and branches** are read from the hosted bare repos with
  git plumbing. An existing but empty repo reports `head: null` — a
  state, not an error.
- **Linked sites** are resolved from the sites registry at call time; a
  site deleted after linking reports `found: false` rather than failing.
- **Memory linkage** replays each member repo's memory and checks the
  `workspace` core block is present; `memory.linked` is true only when
  **every** member repo carries the link. A workspace with no member
  repos reports `linked: true` — vacuous truth, not a broken-link claim
  about nothing.
- **Nesting** reports `parent` / `children` summaries and the `rollup`
  over the whole subtree (see [Nesting](#nesting-workspaces-inside-workspaces)).
  Every repo entry — top-level and rollup — carries a `details`
  summary (description, topics, default branch, commit count, last
  commit) from the project-details layer below; a repo that no longer
  exists reports `details: null` alongside `exists: false`.

## Project details (per repo)

Every hosted repo — existing and future, no setup — answers one
aggregated details object (`lib/repodetails.mjs`), computed **live**
from the bare repo on every call, the same no-cache discipline as
status above:

```json
{
  "repo": "auro/dfw-edge", "owner": "auro", "name": "dfw-edge",
  "createdAt": "2026-10-26T…Z",
  "description": "", "topics": [],
  "empty": false, "defaultBranch": "main",
  "commitCount": 12, "fileCount": 34, "treeBytes": 81234, "diskBytes": 402112,
  "lastCommit": { "sha": "…", "shortSha": "e9b1f75", "subject": "…",
                  "author": "…", "date": "2026-10-26T…Z" },
  "recentActivity": [ "…up to 5 commits, same shape…" ],
  "languages": [ { "language": "JavaScript", "files": 20, "bytes": 60123, "pct": 74.0 } ],
  "readme": { "path": "README.md", "content": "# …", "truncated": false },
  "workspaces": [ { "id": "ws_…", "owner": "auro", "slug": "dfw-haul",
                    "name": "DFW Haul", "parentId": null } ],
  "site": { "id": "site_…", "name": "dfw-haul", "role": "backend" },
  "ci": null
}
```

How each part is derived:

- **Facts** are pure git plumbing on the hosted bare repo
  (`rev-list --count`, `ls-tree -r -l` for file count + tree bytes,
  `log` for last/recent commits, `cat-file` for the README) plus an fs
  walk of the bare repo for `diskBytes`. Languages are bytes-weighted
  by file extension (small in-module table), top 8. The root `README*`
  is returned capped at 128KB with `truncated: true` when it had to be
  cut — never silently.
- **An empty repo is a state, not an error**: zeros, `empty: true`,
  `lastCommit: null`, `readme: null`.
- **`workspaces`** lists every workspace the repo is a member of (from
  the workspaces registry); **`site`** is the linked Site with this
  repo's `role` (`"frontend"` or `"backend"`), or `null`; **`ci`** is
  the latest CI result (`lib/ci.mjs` `readLatest`), or `null` when the
  repo has none — CI state is never invented.
- **Editable metadata** — `description` (≤ 1024 chars) and `topics`
  (≤ 16, each `^[a-z0-9][a-z0-9-]{0,31}$`) — persists in the bare
  repo's own **`kiln.json`** (the metadata file repo creation writes).
  Updates merge atomically and **preserve unknown fields**; repos
  without a `kiln.json` read defaults and the first update creates the
  file (without inventing a `createdAt`).

Workspace status uses the context-economical slice of this object via
`repoFactsSummary` — `{description, topics, defaultBranch,
commitCount, lastCommit}`, deliberately **no README body**.

```bash
# API (bearer <redacted>)
GET   /v1/repos/:owner/:repo/details
PATCH /v1/repos/:owner/:repo/details   {description?, topics?}

# CLI (local state, no daemon needed)
swarm.mjs repo details auro/dfw-edge
swarm.mjs repo describe auro/dfw-edge --description "Edge port" --topics edge,api
```

## CLI

```bash
swarm.mjs workspaces add --owner auro --slug dfw-haul --name "DFW Haul" \
  --description "Box truck / moving / hauling marketplace" \
  --repos auro/dfw-service-hub,auro/dfw-edge,auro/dfw-harness,auro/dfw-workspace \
  --sites site_7c0b5922d708
swarm.mjs workspaces add --owner auro --slug dfw-fleet --name "DFW Fleet" \
  --parent dfw-haul                           # nest under a parent (id or slug)
swarm.mjs workspaces list [--owner auro]
swarm.mjs workspaces tree [--owner auro]      # indented forest
swarm.mjs workspaces show dfw-haul            # id, id prefix, or slug
swarm.mjs workspaces update dfw-haul --add-repo auro/extra
swarm.mjs workspaces update dfw-fleet --parent dfw-haul      # reparent
swarm.mjs workspaces update dfw-fleet --no-parent            # back to root
swarm.mjs workspaces remove dfw-haul --confirm dfw-haul
```

The CLI works directly on local state (registry + git + memory), like
`swarm.mjs sites` — no daemon needs to be running.

## On-chain anchoring: deliberately not faked

Sites set the precedent: registry objects are forge-native, and nothing
in the L1 contracts (KilnOwnershipRegistry) anchors a site today.
Workspaces follow the same line — there is **no** workspace anchor on
chain, and this doc does not pretend otherwise. Anchoring a workspace
(e.g. a registry entry binding owner + slug + member-repo set) is named
follow-up work: it needs new contract surface and a deploy, and belongs
with the L1 lane, not inside a forge feature PR.

## Dogfood: DFW Haul

DFW Haul is the first workspace, and the shape the feature was cut
from. Its Site record (`site_7c0b5922d708`) already linked the app repo
to the edge repo; the workspace completes the picture — the harness
repo (the verification estate) and the workspace-docs repo are members
too, and the Site is linked rather than duplicated. `workspaces show
dfw-haul` answers "what is DFW Haul, in the forge's own records, right
now" in one call — the question the 2026-10-26 team round had to
assemble by hand from four repos and a Site.
