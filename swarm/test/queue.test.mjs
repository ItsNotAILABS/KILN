/** Queue: append-only JSONL, replay survives a simulated daemon restart. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendEvent, replay, pendingJobs, newJobId, readEvents } from "../lib/queue.mjs";
import { makeStateDir } from "./helpers.mjs";

describe("queue", () => {
  it("replays submit -> assign -> done", () => {
    const dir = makeStateDir();
    const job = { id: newJobId(), name: "j1", plan: { steps: [] }, mind: "script" };
    appendEvent(dir, "submit", { job });
    assert.equal(pendingJobs(dir).length, 1);
    appendEvent(dir, "assign", { jobId: job.id, node: "nodeA" });
    assert.equal(pendingJobs(dir).length, 0);
    appendEvent(dir, "done", { jobId: job.id, node: "nodeA", summary: "ok" });
    const jobs = replay(dir);
    assert.equal(jobs.get(job.id).status, "done");
    assert.equal(jobs.get(job.id).summary, "ok");
  });
  it("records failures", () => {
    const dir = makeStateDir();
    const job = { id: newJobId(), name: "j2", plan: { steps: [] }, mind: "script" };
    appendEvent(dir, "submit", { job });
    appendEvent(dir, "fail", { jobId: job.id, node: "nodeA", error: "boom" });
    assert.equal(replay(dir).get(job.id).status, "failed");
  });
  it("state survives a simulated daemon restart (new reader, same dir)", () => {
    const dir = makeStateDir();
    const job = { id: newJobId(), name: "j3", plan: { steps: [{ tool: "fs.list", args: {} }] }, mind: "script" };
    appendEvent(dir, "submit", { job });
    appendEvent(dir, "assign", { jobId: job.id, node: "nodeB" });
    // "restart": drop all in-memory state, re-read from disk only
    const eventsAfter = readEvents(dir);
    assert.equal(eventsAfter.length, 2);
    const jobs = replay(dir);
    const j = jobs.get(job.id);
    assert.equal(j.status, "assigned");
    assert.equal(j.node, "nodeB");
    assert.deepEqual(j.plan.steps, [{ tool: "fs.list", args: {} }]);
  });
  it("events are append-only and sequenced", () => {
    const dir = makeStateDir();
    appendEvent(dir, "submit", { job: { id: "a", name: "a", plan: { steps: [] }, mind: "script" } });
    appendEvent(dir, "submit", { job: { id: "b", name: "b", plan: { steps: [] }, mind: "script" } });
    const events = readEvents(dir);
    assert.equal(events[0].seq, 0);
    assert.equal(events[1].seq, 1);
    assert.ok(events[1].ts >= events[0].ts);
  });
});
