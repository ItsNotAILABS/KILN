# KILN MCP Tool Contract

The first governed tool surface is project-oriented:

- kiln.project.list
- kiln.project.open
- kiln.workspace.create
- kiln.workspace.status
- kiln.memory.search
- kiln.files.read
- kiln.files.write
- kiln.git.diff
- kiln.checks.run
- kiln.approval.request
- kiln.git.commit
- kiln.github.push
- kiln.github.pull_request
- kiln.receipts.list

Monad lane additions:

- kiln.monad.read
- kiln.monad.simulate
- kiln.monad.deploy_proposal
- kiln.monad.verify_proposal

Sovereign Books lane additions:

- kiln.sovereign.run_workflow
- kiln.sovereign.generate_book_artifact
- kiln.sovereign.mcp_call
- kiln.sovereign.virtual_workspace

All write, commit, push, deploy, wallet, and external side-effect tools must be policy-evaluated and approval-gated. Read operations should be namespace-scoped and receipt-visible.
