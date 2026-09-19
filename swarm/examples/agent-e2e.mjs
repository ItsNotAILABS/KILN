/**
 * Agent end-to-end: use ONLY the SwarmClient SDK (no CLI, no shell git) to
 * buffer real compute through the swarm — the way any agent would.
 *
 * 1. createRepo  → KILN-native scratch repo
 * 2. spawnNode   → worker clones it
 * 3. submitJob   → real computation + file write + real git commit
 * 4. waitForJob  → throws on failure, never a maybe
 * 5. nodeLogs + verifyReceipts
 * 6. Independent check: plain `git clone` sees the commit (done by caller)
 */
import { SwarmClient } from "../lib/client.mjs";

const swarm = await SwarmClient.connect();
console.log("connected:", await swarm.health().then((h) => h.service).catch(() => "?"));

const owner = "auro", repo = "agent-e2e";
const existing = await swarm.listRepos();
if (!existing.some((r) => r.owner === owner && r.repo === repo)) {
  const c = await swarm.createRepo({ owner, repo });
  console.log("repo created:", c.cloneUrl);
} else {
  console.log("repo exists: auro/agent-e2e");
}

const node = await swarm.spawnNode({
  name: `agent-e2e-${Date.now().toString(36)}`,
  caps: 1, // commit only — least privilege
  ttlSec: 600,
  repo: "http://127.0.0.1:18787/git/auro/agent-e2e",
  mind: "script",
  policy: "on-failure",
});
console.log("node spawned:", node.id);

// Real computation: the worker itself runs node, writes the result, commits.
const job = await swarm.submitJob({
  name: "agent-e2e-compute",
  node: node.id,
  mind: "script",
  plan: { steps: [
    // shell.exec is argv-based, no shell, with an aggressive jail
    // (no ; && || $() etc). The intended pattern: write a script file
    // with fs.write, then execute it.
    { tool: "fs.write", args: { path: "compute.cjs", content: "let s = 0;\nfor (let i = 1; i <= 1000; i++) s += i;\nrequire('fs').writeFileSync('SUM.md', '# sum 1 to 1000\\n\\n' + s + '\\n');\n" } },
    { tool: "shell.exec", args: { command: "node", args: ["compute.cjs"] } },
    { tool: "shell.exec", args: { command: "cat", args: ["SUM.md"] } },
    { tool: "git.commit", args: { message: "agent: sum 1 to 1000 via swarm SDK" } },
    { tool: "git.push", args: {} },
  ]}
});
console.log("job submitted:", job.id);

const done = await swarm.waitForJob(job.id, { timeoutMs: 120000 });
console.log("job done. summary:");
console.log(done.summary);

const receipts = await swarm.verifyReceipts(node.id);
console.log("receipts:", JSON.stringify(receipts).slice(0, 200));

const logs = await swarm.nodeLogs(node.id, { tail: 5 });
console.log("log tail:", JSON.stringify(logs).slice(0, 300));

await swarm.stopNode(node.id);
console.log("node stopped. E2E OK");
