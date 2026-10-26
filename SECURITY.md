# Security policy

## Reporting

Report vulnerabilities privately to the repository owner (ItsNotAILABS)
through GitHub's private vulnerability reporting on this repository, or
directly to the owner off-channel. Do not open a public issue for a
security problem, and do not include live credentials in a report.

## Supported surface

- `contracts/` — KilnOwnershipRegistry and the L1 governance surface.
- `swarm/` — the forge daemon: git smart-HTTP, CI runner, memory,
  Doctor/VIVAX supervision.
- `relay/`, `relay-py/` — relay services.

## Handling rules (contributors)

- Capability tokens are least-privilege and file-scoped: the KILN API
  token lives at `~/.kiln-swarm/api.token` (0600) and is sent only as an
  `Authorization: Bearer` header — never in a URL, a log line, or chat.
- GitHub tokens used by automation are fine-grained, repository-scoped,
  and stored outside the repo. A token that has appeared in chat, a log,
  or a commit is treated as compromised: revoke first, investigate second.
- Wallet signing is always outside agent/tool reasoning: tools propose,
  receipts record, the owner signs.
- Every material action in the swarm produces a receipt (actor, request
  digest, policy outcome). If an action cannot produce a receipt, it does
  not run.
