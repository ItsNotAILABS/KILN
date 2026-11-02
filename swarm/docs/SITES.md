# KILN Sites

A **site** is the whole product, not just a repo: a frontend repo, a
backend repo, the published artifact customers actually open, and the
compute app that runs the backend. Before Sites, KILN knew each piece
separately — repos in git hosting, apps in compute, linkage conventions
in people's heads. Sites makes the connection a first-class record the
daemon can serve, check, and keep honest.

## The record

Sites live in a disk-backed registry at `<stateDir>/sites.json`
(atomic tmp+rename writes, same discipline as the compute store):

```json
{
  "id": "site_20e63d366638",
  "name": "shopstream",
  "frontend": "auro/shopstream-web",
  "backend": "auro/shopstream-api",
  "artifact": "shopstream",
  "computeApp": "shopstream-api",
  "createdAt": "2026-10-14T…Z"
}
```

`frontend` and `backend` are required and must name existing KILN-native
repos. `artifact` (a Muse web-artifact slug) and `computeApp` (an app
name **or** appId from KILN Compute) are optional. Site names are unique.

## Linkage lives in the repos, not just the registry

The registry is an index. The durable links are written into each
repo's own **KILN Memory** (`refs/kiln/memory` core blocks) at create
time, so either repo can walk to the whole site on its own:

| Repo | Core blocks written |
|---|---|
| frontend | `backend_repo` = the backend `owner/repo`, `site`, `artifact` (when set) |
| backend | `frontend_repo` = the frontend `owner/repo`, `site`, `artifact` (when set) |

Creating a site writes memory first and saves the registry entry only
after both writes succeed — a failed create leaves nothing half-linked.
Deleting a site removes **only** the registry entry: repos, the compute
app, and the memory links are deliberately untouched (memory is
append-only history; supersede there if a link ever needs retracting).

## HTTP API (bearer auth, like every `/v1` route)

| Route | What it does |
|---|---|
| `POST /v1/sites` | Create `{name, frontend, backend, artifact?, computeApp?}` → `201 {ok, site}`. Errors: `400` malformed, `404` repo missing, `409` name taken. |
| `GET /v1/sites` | List registry records → `{sites: [...]}` |
| `GET /v1/sites/:id` | Aggregated **live** status (below) |
| `DELETE /v1/sites/:id` | Remove the registry entry → `{ok: true, id}` |

### Aggregated status

`GET /v1/sites/:id` computes everything fresh on every call — nothing
is cached, so it cannot go stale:

```json
{
  "site": { "…": "the registry record" },
  "frontend": { "repo": "auro/shopstream-web", "exists": true,
                "head": { "sha": "…", "shortSha": "0685a9d", "subject": "…" } },
  "backend":  { "repo": "auro/shopstream-api", "exists": true, "head": { "…" } },
  "artifact": "shopstream",
  "computeApp": { "ref": "shopstream-api", "found": true, "appId": "…",
                  "name": "shopstream-api", "status": "ready",
                  "workerAlive": true, "port": 8904, "ready": true,
                  "deployedAt": "…" },
  "memory": {
    "frontend": { "present": true, "coreLabels": ["backend_repo", "site", "artifact"] },
    "backend":  { "present": true, "coreLabels": ["frontend_repo", "site", "artifact"] },
    "linked": true
  }
}
```

- **Repo HEADs** are read from the hosted bare repos with git plumbing
  (`HEAD` of the default branch). An existing but empty repo reports
  `head: null` — a state, not an error.
- **Compute app** status is the compute registry's own view
  (`lib/compute.mjs` `listApps`), including its TCP readiness probe:
  `ready` means the port actually accepts, not just that a process
  exists. A `computeApp` ref that matches no deployed app reports
  `found: false` rather than failing.
- **Memory linkage** replays each repo's memory and checks the expected
  core blocks are present; `memory.linked` is true only when **both**
  repos carry their half of the link.

## CLI

```bash
swarm.mjs sites add --name shopstream \
  --frontend auro/shopstream-web --backend auro/shopstream-api \
  --artifact shopstream --app shopstream-api
swarm.mjs sites list
swarm.mjs sites show shopstream      # id, id prefix, or name
swarm.mjs sites remove shopstream
```

The CLI works directly on local state (registry + git + memory), like
`swarm.mjs memory` — no daemon needs to be running.

## Dogfood: ShopStream

ShopStream is the first site, and the shape the feature was cut from:

- **Frontend** `auro/shopstream-web` — the TikTok-style storefront,
  also published as the Muse artifact **`shopstream`** (its KILN tab
  shows this same wiring: artifact ⇄ `auro/shopstream-api` over
  REST `/v1`).
- **Backend** `auro/shopstream-api` — catalog, orders, quotes, and the
  AI design gallery; runs as the compute app **`shopstream-api`**
  (port 8904, supervised by KILN with restart-on-crash).

Registering it is the `sites add` command above; from then on,
`GET /v1/sites/<id>` answers "is the whole store up, and is it wired
together?" in one call — repo tips, app readiness, and memory linkage —
instead of three subsystems being checked by hand.

## Boundaries (v1, honestly)

- The artifact itself is still published through the Muse artifact
  builder; Sites records the slug and the linkage but does not
  republish artifacts.
- One frontend + one backend per site. Multi-service sites (several
  backends behind one frontend) are a later shape.
- Status is read-only aggregation: Sites never restarts apps, pushes
  repos, or repairs linkage on its own. It reports; operators (human
  or agent) act.
