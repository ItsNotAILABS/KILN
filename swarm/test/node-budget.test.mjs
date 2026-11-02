/**
 * Restart-budget renewal tests (2026-10-17).
 *
 * The budget used to be a one-way ratchet — the auro node sat dead at
 * 100/100 for a week because daemon/host deaths burned restarts the
 * node never caused. Pins the two exits:
 *  - budgetRestoreDue: only sustained health (alive ≥1h since spawn,
 *    restarts > 0) earns a refill — a crash loop never qualifies.
 *  - reviveNode: the operator reset clears budget + last exit and
 *    persists, resolvable by name like every other node verb.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createNode, reviveNode, budgetRestoreDue, restoreBudget,
  RESTART_BUDGET_RESTORE_MS,
} from "../lib/nodes.mjs";
import { loadNode, saveNode } from "../lib/state.mjs";
import { nowSec } from "../lib/grant.mjs";

const H = RESTART_BUDGET_RESTORE_MS;

describe("budgetRestoreDue (earned refill)", () => {
  it("a node healthy for the full window earns its budget back", () => {
    assert.equal(budgetRestoreDue({ restarts: 3, workerSpawnedAt: 1_000 }, 1_000 + H), true);
    assert.equal(budgetRestoreDue({ restarts: 3, workerSpawnedAt: 1_000 }, 1_000 + H + 1), true);
  });

  it("a crash-looping node (young worker) never earns a refill", () => {
    assert.equal(budgetRestoreDue({ restarts: 3, workerSpawnedAt: 1_000 }, 1_000 + H - 1), false);
    assert.equal(budgetRestoreDue({ restarts: 99, workerSpawnedAt: 5_000 }, 6_000), false);
  });

  it("no spend, no refill; no spawn stamp, no refill", () => {
    assert.equal(budgetRestoreDue({ restarts: 0, workerSpawnedAt: 0 }, H * 10), false);
    assert.equal(budgetRestoreDue({ restarts: 5 }, H * 10), false);
    assert.equal(budgetRestoreDue({ restarts: 5, workerSpawnedAt: undefined }, H * 10), false);
  });

  it("restoreBudget zeroes the count and reports what it cleared", () => {
    const n = { restarts: 42 };
    assert.equal(restoreBudget(n), 42);
    assert.equal(n.restarts, 0);
    assert.equal(restoreBudget(n), 0);
  });
});

describe("reviveNode (operator reset)", () => {
  it("clears a capped node's budget + last exit, persisted, by name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kiln-budget-test-"));
    const node = await createNode(dir, {
      name: "capped", caps: 1, expiresAt: nowSec() + 3600,
      restartPolicy: "always", maxRestarts: 100,
    });
    const rec = loadNode(dir, node.id);
    rec.restarts = 100;
    rec.lastExit = 1;
    saveNode(dir, rec);

    const { node: revived, was } = reviveNode(dir, "capped");
    assert.equal(was, 100);
    assert.equal(revived.restarts, 0);
    assert.equal(revived.lastExit, null);
    const persisted = loadNode(dir, node.id);
    assert.equal(persisted.restarts, 0, "reset persisted to node.json");
    assert.equal(persisted.lastExit, null);
  });

  it("an unknown node is a loud error, not a silent no-op", () => {
    const dir = mkdtempSync(join(tmpdir(), "kiln-budget-test-"));
    assert.throws(() => reviveNode(dir, "ghost"), /no such node/);
  });
});
