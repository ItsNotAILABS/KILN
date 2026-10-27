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
  "createdAt": "2026-10-27T…Z",
  "updatedAt": "2026-10-27T…Z"
}
```

`(owner, slug)` is unique (`409` on collision). Member repos must be
existing KILN-native repos (`404` otherwise); linked sites must exist in
the sites registry (`404`). Names and descriptions are plain text
(name: `[A-Za-z0-9][A-Za-z0-9 _.:-]{0,127}`, description ≤ 1024 chars).

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
| `POST /v1/workspaces` | Create `{owner, slug, name, description?, repos?, siteIds?}` → `201 {ok, workspace}`. Errors: `400` malformed, `404` repo/site missing, `409` `(owner, slug)` taken. |
| `GET /v1/workspaces?owner=` | List registry records → `{workspaces: [...]}` (owner filter optional) |
| `GET /v1/workspaces/:id` | Aggregated **live** status (below) |
| `PATCH /v1/workspaces/:id` | Update `{name?, description?, addRepos?, removeRepos?, linkSites?, unlinkSites?}` → `{ok, workspace}` |
| `DELETE /v1/workspaces/:id` | Body `{confirm: "<slug>"}` → `{ok: true, id}`. Missing/wrong confirm → `400`. |

### Aggregated status

`GET /v1/workspaces/:id` computes everything fresh on every call —
nothing is cached, so it cannot go stale:

```json
{
  "workspace": { "…": "the registry record" },
  "repos": [
    { "repo": "auro/dfw-edge", "exists": true, "branch": "main",
      "head": { "sha": "…", "shortSha": "e9b1f75", "subject": "…" } }
  ],
  "sites": [
    { "id": "site_7c0b5922d708", "name": "dfw-haul",
      "frontend": "auro/dfw-service-hub", "backend": "auro/dfw-edge",
      "found": true }
  ],
  "memory": {
    "repos": { "auro/dfw-edge": { "present": true, "coreLabels": ["workspace", "…"] } },
    "linked": true
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
  **every** member repo carries the link.

## CLI

```bash
swarm.mjs workspaces add --owner auro --slug dfw-haul --name "DFW Haul" \
  --description "Box truck / moving / hauling marketplace" \
  --repos auro/dfw-service-hub,auro/dfw-edge,auro/dfw-harness,auro/dfw-workspace \
  --sites site_7c0b5922d708
swarm.mjs workspaces list [--owner auro]
swarm.mjs workspaces show dfw-haul        # id, id prefix, or slug
swarm.mjs workspaces update dfw-haul --add-repo auro/extra
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
