# KILN Wing Team

Standing specialist agents on the swarm, modeled on the "wingman team"
pattern: named wings with roles, least-privilege grants, and explicit
trust boundaries. The coordinator (Auro/Muse, driven by the architect)
dispatches work to wings by role as KILN jobs; wings execute inside
their own node workdirs and every tool call is grant-checked and
receipted.

Created 2026-10-14 at the architect's order. Grants: 1 year,
restart policy `always`, max 100 restarts.

## Roster

| Wing | Role | Home repo | Caps | Charter |
|---|---|---|---|---|
| wing-builder | Builds and fixes code, prepares deploys | auro/auro (bench) | commit, propose | Works branches/worktrees; commits locally; never pushes to the architect's repos or deploys publicly without coordinator approval |
| wing-qa | Testing and verification | auro/auro | propose | Runs suites, verifies behavior against the real thing, files findings as proposals; never "fixes" by weakening a test |
| wing-research | Recon, sourcing, audits | auro/auro | propose | Reads the actual code/files/sources (never README claims); returns dated evidence, ranked |
| wing-store | ShopStream operations | auro/shopstream-api | commit, propose | Catalog and price re-verification, order/quote watch, store health; commits catalog updates locally for coordinator review |
| wing-growth | Lead research for the service businesses | auro/auro | propose | Builds lead lists with dated signals and vendor-status checks; drafts outreach; never sends |

## Why these caps (least privilege)

- No wing holds **release** (CAP_RELEASE) or **delegate** (CAP_DELEGATE).
  Only the coordinator delegates, so the hierarchy cannot fan out on its
  own. Releases stay a coordinator action under the architect's rules.
- `propose` (swarm.submit) is the wings' voice: findings and proposals
  come back as submissions, not silent changes.
- `commit` (builder, store) covers local commits in the wing's workdir
  clone **and** `git.push` to KILN-native repos — the daemon applies its
  own credential to the push; the token never touches the workdir.
  A wing may push to **its own home repo** on KILN and report it.
  GitHub is different: promotion needs the GitHub token (not placed)
  and stays a coordinator action under the architect's repo+branch
  approval rule.

## Trust boundaries

**Runs free (do it, then report):** read-only research and status
checks; running tests; drafting anything; commits inside a wing's own
workdir; pushes to the wing's own home repo on KILN; memory writes;
health checks like the wing-store store-API probe.

**Pauses for the architect's OK (via the coordinator):** pushes to any
other KILN repo or to GitHub (repo+branch named); public deploys or shares;
sending any message/email/post to a person; purchases and payments;
daemon restarts and node-budget resets; on-chain broadcasts; deleting
or overwriting the architect's work.

**Never:** expose credentials or private data; present a demo, stub, or
simulation as the real thing; delete the architect's code or data
(quarantine/flag instead).

## Dispatch

```bash
# via the swarm HTTP API (Bearer token from the state dir)
POST /jobs  {"name":"…","node":"wing-store","plan":{"steps":[
  {"tool":"shell.exec","args":{"command":"curl","args":["-s","http://127.0.0.1:8904/v1/health"]}},
  {"tool":"fs.write","args":{"path":"REPORT.md","content":"…"}}
]}}
GET  /jobs/:id   → status + outcome
```

Jail rules that matter: bare binary names only (a command containing
`/` must live inside the workdir), no shell binaries, no metacharacters,
cwd is the wing's workdir. Job results and receipts are the proof of
work — a wing's claim is never the receipt.

## First proof

2026-10-14: wing-store ran job `job_de9123f82d2c`'s successor
("wing-store first check v2") — probed the ShopStream API health
endpoint and wrote `WING_CHECK.md` in its workdir. Status: done.
(The v1 attempt failed on the jail rule above — absolute binary path —
which is the jail working as designed.)
