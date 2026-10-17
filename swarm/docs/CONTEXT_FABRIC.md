# KILN Context Fabric v1
Local-first, read-only, deterministic repository context retrieval for agents. No external model call, no embedding dependency, no full-repository prompt dump.

Usage:
```js
import {contextPack} from "./context-fabric.mjs";
console.log(JSON.stringify(contextPack("/path/to/checkout","agent approval git push"),null,2));
```
Uses tracked Git files only; bounds file size, total output and result count; skips symlinks and binary files; emits SHA-256 provenance and Git revision. A context pack is a *retrieval slice*, not a claim that an agent has read the whole repository. Agent-facing authorization and tenant-scoped policy must be applied before exposing private repositories. Token savings must be benchmarked against baseline prompts; no fixed reduction is promised. Dirty worktree content is read and hashed, while revision identifies only HEAD; compare per-file hashes for exact freshness.