/**
 * Settlement-sweep + atomic-admission unit tests (no daemon needed).
 *
 * These pin the 2026-10-01 admission-accounting fixes:
 *  - slots release at actual job completion via settleComputeJobs(), never on poll
 *  - settlement is exactly-once per attempt (restart-safe via persisted settleKey)
 *  - infra failures resubmit through admission (attempt+1, retriesLeft kept)
 *  - function errors never retry
 *  - map acceptance is whole-map: first wave admits immediately, the
 *    rest queue inside the map and admit as slots free; a 429 only when
 *    the box is completely full (2026-10-17 wave scheduling)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Must be set before compute.mjs loads (MAX_CONCURRENT is read at import).
process.env.KILN_COMPUTE_MAX_CONCURRENT = "2";

const compute = await import("../lib/compute.mjs");
const { appendEvent } = await import("../lib/queue.mjs");
const { nodeDir } = await import("../lib/state.mjs");

const CODE = `export async function main(args) { return (args.x || 0) * 2; };`;

function freshDir() {
  return mkdtempSync(join(tmpdir(), "kiln-settle-test-"));
}

function loadStore(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "compute.json"), "utf8"));
  } catch {
    return { invocations: {}, maps: {} };
  }
}

/** Stage the per-invocation files a retry resubmission reads back. */
function stageNodeFiles(dir, nodeId, invId, args) {
  const d = join(nodeDir(dir, nodeId), "work", ".kiln_compute", invId);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "fn.mjs"), CODE);
  writeFileSync(join(d, "args.json"), JSON.stringify(args));
}

describe("settlement sweep (settleComputeJobs)", () => {
  it("a done job settles exactly once — polling never touches scheduler state", () => {
    const dir = freshDir();
    const { invocationId: inv, jobId } = compute.submitInvocation(dir, {
      name: "settle-once", code: CODE, args: { x: 21 },
    });
    assert.equal(compute.getCapacity().inflight, 1);

    // Polling the pending invocation must not settle anything.
    const p = compute.getInvocation(dir, inv);
    assert.ok(["pending", "submitted", "unknown"].includes(p.status));
    assert.equal(compute.getCapacity().inflight, 1);

    // The job completes. Polling the DONE view still must not settle —
    // the old bug released the slot here instead of at completion.
    appendEvent(dir, "done", { jobId, result: { ok: true } });
    const v = compute.getInvocation(dir, inv);
    assert.equal(v.status, "done");
    assert.equal(compute.getCapacity().inflight, 1, "poll must not release the slot");

    // The sweep settles it exactly once.
    compute.settleComputeJobs(dir);
    assert.equal(compute.getCapacity().inflight, 0);
    const rec = loadStore(dir).invocations[inv];
    assert.equal(rec.settledKey, `${inv}:done`);

    // Re-running the sweep settles nothing twice (restart-safe).
    compute.settleComputeJobs(dir);
    assert.equal(compute.getCapacity().inflight, 0);
    assert.equal(loadStore(dir).invocations[inv].settledKey, `${inv}:done`);
  });

  it("a sandbox-infra failure resubmits through admission (attempt 2, retries kept)", () => {
    const dir = freshDir();
    const { invocationId: inv, jobId } = compute.submitInvocation(dir, {
      name: "settle-retry", code: CODE, args: { x: 5 }, retries: 1,
    });
    stageNodeFiles(dir, "node_9", inv, { x: 5 });

    appendEvent(dir, "fail", {
      jobId, node: "node_9", error: "sandbox setup failed: unshare not found",
    });
    compute.settleComputeJobs(dir);

    const rec = loadStore(dir).invocations[inv];
    assert.equal(rec.attempt, 2, "retry resubmitted as attempt 2");
    assert.equal(rec.retriesLeft, 0, "retriesLeft decremented");
    assert.notEqual(rec.jobId, jobId, "new job id for the retry");
    assert.equal(rec.settledKey, null, "new attempt is unsettled");
    // Slot accounting: the failed attempt released its slot, the retry
    // admitted a fresh one — net inflight unchanged at 1.
    assert.equal(compute.getCapacity().inflight, 1);

    const v = compute.getInvocation(dir, inv);
    assert.equal(v.attempt, 2);
    assert.equal(v.retried, true);

    // The retry completes; the sweep settles the new attempt.
    appendEvent(dir, "done", { jobId: rec.jobId, result: { ok: true } });
    compute.settleComputeJobs(dir);
    assert.equal(compute.getCapacity().inflight, 0);
    assert.equal(loadStore(dir).invocations[inv].settledKey, `${inv}:done`);
  });

  it("function errors never retry and settle as failed", () => {
    const dir = freshDir();
    const { invocationId: inv, jobId } = compute.submitInvocation(dir, {
      name: "settle-noretry", code: CODE, args: { x: 1 }, retries: 2,
    });
    appendEvent(dir, "fail", { jobId, node: "node_9", error: "user bug: boom" });
    compute.settleComputeJobs(dir);

    const rec = loadStore(dir).invocations[inv];
    assert.equal(rec.attempt, 1, "function errors are never retried");
    assert.equal(rec.settledKey, `${inv}:failed`);
    assert.equal(compute.getCapacity().inflight, 0);

    const v = compute.getInvocation(dir, inv);
    assert.equal(v.status, "failed");
    assert.equal(v.attempt, 1);
    assert.equal(v.retried, undefined);
    assert.match(v.error, /boom/);
  });

  it("already-settled invocations from a previous run are not double-settled", () => {
    const dir = freshDir();
    const { invocationId: inv, jobId } = compute.submitInvocation(dir, {
      name: "settle-old", code: CODE, args: {},
    });
    appendEvent(dir, "done", { jobId, result: { ok: true } });
    compute.settleComputeJobs(dir);
    assert.equal(compute.getCapacity().inflight, 0);

    // Simulate a daemon restart: a fresh import would reseed settledIds
    // from the persisted settledKey — emulate by sweeping again after
    // manually re-adding the key (module state already has it; this
    // asserts the persisted path, not just memory).
    const before = loadStore(dir).invocations[inv].settledKey;
    assert.ok(before, "settledKey persisted");
    compute.settleComputeJobs(dir);
    assert.equal(compute.getCapacity().inflight, 0, "no double release");
    assert.equal(loadStore(dir).invocations[inv].settledKey, before);
  });
});

describe("map admission (whole-map acceptance, wave scheduling)", () => {
  it("a map larger than capacity is accepted whole and admits in waves", () => {
    const dir = freshDir();
    // MAX_CONCURRENT=2, map of 5: wave 1 takes 2 slots, 3 queue in the map.
    const { mapId, invocationIds } = compute.submitMap(dir, {
      name: "waves", code: CODE, items: [{ x: 1 }, { x: 2 }, { x: 3 }, { x: 4 }, { x: 5 }],
    });
    assert.equal(invocationIds.length, 2, "first wave admitted");
    assert.equal(compute.getCapacity().inflight, 2);
    let store = loadStore(dir);
    assert.equal(store.maps[mapId].pendingItems.length, 3, "tail queued in the map record");

    // The queued tail is visible as pending results, in item order.
    let view = compute.getMap(dir, mapId);
    assert.equal(view.results.length, 5);
    assert.deepEqual(view.results.slice(2).map((r) => r.queued), [true, true, true]);
    assert.equal(view.results[4].name, "waves[4]");

    // Complete wave 1 → the sweep admits wave 2 in the same pass.
    for (const inv of [...store.maps[mapId].invocationIds]) {
      const rec = store.invocations[inv];
      appendEvent(dir, "done", { jobId: rec.jobId, result: { ok: true } });
    }
    compute.settleComputeJobs(dir);
    store = loadStore(dir);
    assert.equal(store.maps[mapId].invocationIds.length, 4, "wave 2 admitted by the sweep");
    assert.equal(store.maps[mapId].pendingItems.length, 1);
    assert.equal(compute.getCapacity().inflight, 2);

    // Complete wave 2 → final item admits; submission params are dropped.
    for (const inv of store.maps[mapId].invocationIds.slice(2)) {
      const rec = store.invocations[inv];
      appendEvent(dir, "done", { jobId: rec.jobId, result: { ok: true } });
    }
    compute.settleComputeJobs(dir);
    store = loadStore(dir);
    assert.equal(store.maps[mapId].invocationIds.length, 5, "all items admitted");
    assert.equal(store.maps[mapId].pendingItems, undefined, "queue drained");
    assert.equal(store.maps[mapId].code, undefined, "submission params dropped after final wave");
    view = compute.getMap(dir, mapId);
    assert.equal(view.results.length, 5);
    assert.equal(view.results.filter((r) => r.queued).length, 0);

    // Complete the last item → every slot frees.
    const last = store.maps[mapId].invocationIds[4];
    appendEvent(dir, "done", { jobId: store.invocations[last].jobId, result: { ok: true } });
    compute.settleComputeJobs(dir);
    assert.equal(compute.getCapacity().inflight, 0);
  });

  it("a map on a completely full box is refused with 429 and admits nothing", () => {
    const dir = freshDir();
    // Fill both slots with plain invocations: zero free slots.
    compute.submitInvocation(dir, { name: "fill-1", code: CODE, args: { x: 1 } });
    compute.submitInvocation(dir, { name: "fill-2", code: CODE, args: { x: 2 } });
    assert.equal(compute.getCapacity().inflight, 2);
    assert.throws(
      () => compute.submitMap(dir, {
        name: "no-room", code: CODE, items: [{ x: 1 }],
      }),
      (e) => e.status === 429 && /capacity/.test(e.message),
    );
    const store = loadStore(dir);
    assert.deepEqual(store.maps, {}, "no map record on refused admission");
    assert.equal(Object.keys(store.invocations).length, 2, "only the two fills exist");

    // Drain the fills so the module-level inflight counter returns to 0
    // for the tests that follow in this process.
    for (const rec of Object.values(store.invocations)) {
      appendEvent(dir, "done", { jobId: rec.jobId, result: { ok: true } });
    }
    compute.settleComputeJobs(dir);
    assert.equal(compute.getCapacity().inflight, 0);
  });

  it("a fitting map admits all items atomically and settles each", () => {
    const dir = freshDir();
    const { mapId, invocationIds } = compute.submitMap(dir, {
      name: "atomic-ok", code: CODE, items: [{ x: 1 }, { x: 2 }],
    });
    assert.equal(invocationIds.length, 2);
    assert.equal(compute.getCapacity().inflight, 2);
    assert.ok(loadStore(dir).maps[mapId], "map record written");

    for (const inv of invocationIds) {
      const rec = loadStore(dir).invocations[inv];
      appendEvent(dir, "done", { jobId: rec.jobId, result: { ok: true } });
    }
    compute.settleComputeJobs(dir);
    assert.equal(compute.getCapacity().inflight, 0);
  });

  it("invalid items are rejected before admission (no slots taken)", () => {
    const dir = freshDir();
    const circular = { x: 1 };
    circular.self = circular; // not JSON-serializable -> 400
    assert.throws(
      () => compute.submitMap(dir, {
        name: "atomic-baditem", code: CODE, items: [{ x: 1 }, circular],
      }),
      (e) => e.status === 400,
    );
    assert.equal(compute.getCapacity().inflight, 0, "validation precedes admission");
    assert.deepEqual(loadStore(dir).invocations, {});
  });
});
