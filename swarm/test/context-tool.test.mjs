import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runTool } from "../lib/tools.mjs";
import { makeStateDir, makeNode } from "./helpers.mjs";
import { receiptsPath, verifyReceipts } from "../lib/receipts.mjs";
import { verifyContextReceipts } from "../lib/context-receipts.mjs";

test("context.query returns code while keeping signed tool receipt privacy-bounded", async () => {
  const dir = makeStateDir();
  const { ctx, node, keypair } = await makeNode(dir);
  writeFileSync(join(node.workdir, "context-target.js"), [
    "export function promotionGate(actor) {",
    "  return actor.approved === true;",
    "}",
    ""
  ].join("\n"));
  // Track the file: Context Fabric intentionally indexes Git-tracked state.
  const { spawnSync } = await import("node:child_process");
  spawnSync("git", ["add", "context-target.js"], { cwd: node.workdir });
  spawnSync("git", ["commit", "-q", "-m", "context fixture"], { cwd: node.workdir });

  const rawQuery = "promotion gate approval";
  const r = await runTool(ctx, "context.query", { query: rawQuery, maxBytes: 4096, maxChunks: 4 });
  assert.equal(r.ok, true);
  const pack = JSON.parse(r.out);
  assert.equal(pack.schema, "kiln.context-pack.v2");
  assert.ok(pack.items.some((x) => x.path === "context-target.js"));
  assert.match(pack.items.map((x) => x.excerpt).join("\n"), /promotionGate/);

  const receipts = verifyReceipts(dir, node.id, keypair);
  assert.equal(receipts.ok, true);
  assert.equal(receipts.count, 1);

  const rawToolReceipts = readFileSync(receiptsPath(dir, node.id), "utf8");
  assert.equal(rawToolReceipts.includes(rawQuery), false);
  assert.equal(rawToolReceipts.includes("promotionGate"), false);
  assert.match(rawToolReceipts, /queryDigest/);
  assert.match(rawToolReceipts, /packDigest/);

  const contextReceipts = verifyContextReceipts(dir);
  assert.equal(contextReceipts.ok, true);
  assert.equal(contextReceipts.count, 1);
});
