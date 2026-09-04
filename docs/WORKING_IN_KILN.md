# Working in KILN

## Project workflow

1. Open a registered project from the KILN project registry.
2. Create or resume its named workspace.
3. Inspect source, memory context, current checks, and pending changes.
4. Make edits inside the workspace.
5. Run project checks and record the result.
6. Review the diff and generated receipt.
7. Request approval for commits, pushes, deployments, wallet actions, or other sensitive tools.
8. Commit to a KILN work branch.
9. Push or open a pull request against the source repository.
10. Keep KILN’s registry, memory reference, and receipt linked to the landed commit.

## Project lanes

- monadbuilder-thesis: CapsulaBuilder web, desktop, MCP Spine, contracts, and Monad integrations.
- sovereign-books: Sovereign Engine OS, Sovereign Books, agent workflows, MCP adapters, and artifacts.
- neurospaceai-deep-lab: NeuroEmergence Core research, cognition, memory, brain atlas, doctrine, simulation, economics, ICP canisters, and React console.

## Port allocation

- KILN web forge: 8080
- CapsulaBuilder MCP Spine: 8081
- Sovereign Engine MCP/control services: 8082 and above as needed

## Authority boundary

KILN may read and propose changes through tools. Sensitive writes require an owner approval record. Wallet signing remains outside agent reasoning. Every material action must produce a receipt with actor, namespace, request digest, policy outcome, and source commit when available.
