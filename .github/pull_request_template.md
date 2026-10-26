## What landed

<!-- One or two lines: the change, in product terms. -->

## Proof

<!-- The receipts: suite names + counts on the final tree, CI run links,
     before/after behavior. "It works" is not proof. -->

- [ ] Swarm suite green on the final tree (`node --test swarm/test/*.test.mjs`)
- [ ] Contracts: `forge test` + `forge fmt --check` (if contracts touched)
- [ ] Daemon/supervision change: two consecutive clean suite runs

## What is deliberately NOT in this change

<!-- Boundaries, follow-ups, known gaps. Label anything staged or partial
     exactly as what it is. -->

## Risk / rollback

<!-- What breaks if this is wrong, and the one command that undoes it. -->
