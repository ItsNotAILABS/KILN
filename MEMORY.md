# Memory · ItsNotAILABS/KILN

This is the awareness an agent reads when it opens this repo.
The live record is the orphan ref `refs/kiln/memory` on the swarm
copy of the repo. This file is what GitHub itself carries, because
that ref is not on `main`.

## Working

KILN `main` is the forge: contracts, swarm, and per-repo memory.
`kiln-workspace` is the live app. Do not open a third Kiln repo.
Do not push the app into this history.

Muse uses the live app, not the loopback daemon. Delete
`http://127.0.0.1:8787` from Muse settings. That was the old local
kiln. The forge is `/api/mcp` on the kiln that answers
`GET /api/kiln/loop` with `kiln-phone/v1`. The public name
`kiln.pocketnova.app` is still the Hello World worker until ORIGIN
is set. See `docs/MUSE.md`.

## Sit

Before you write, print the brief:

```sh
node swarm/swarm.mjs memory sit --repo <owner>/<repo>
```

`working` is one core block. Setting it again replaces what you see
and keeps the old value in the log. Recall before you guess.
Remember after you decide. A fact must cite the episode it came from.

## Already true

Per-repo memory landed on `main` in `ef535bf`: episodes, facts,
supersession, links, core blocks, budgeted context. Agents were not
required to read it. `memory sit` is that requirement.
