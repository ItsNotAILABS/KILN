/**
 * Job queue: append-only JSONL event log. Every mutation is an appended,
 * fsync'd event; state is derived by replay — crash-safe by construction.
 *
 * Events: submit {job}, assign {jobId, node}, done {jobId, node, summary},
 *         fail {jobId, node, error}
 */
import { openSync, writeSync, fsyncSync, closeSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export function queuePath(dir) {
  return join(dir, "queue.jsonl");
}

export function newJobId() {
  return "job_" + randomBytes(6).toString("hex");
}

export function appendEvent(dir, type, data) {
  const event = { seq: nextSeq(dir), ts: Math.floor(Date.now() / 1000), type, ...data };
  const line = JSON.stringify(event) + "\n";
  const fd = openSync(queuePath(dir), "a");
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return event;
}

function nextSeq(dir) {
  const p = queuePath(dir);
  if (!existsSync(p)) return 0;
  let n = 0;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (line.trim()) n++;
  }
  return n;
}

export function readEvents(dir) {
  const p = queuePath(dir);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/**
 * Replay events into job state.
 * Returns Map jobId -> {id, name, plan, mind, node?, status, ts, summary?, error?}
 */
export function replay(dir) {
  const jobs = new Map();
  for (const e of readEvents(dir)) {
    if (e.type === "submit") {
      jobs.set(e.job.id, { ...e.job, node: null, status: "pending", submittedAt: e.ts });
    } else if (e.type === "assign") {
      const j = jobs.get(e.jobId);
      if (j) { j.status = "assigned"; j.node = e.node; j.assignedAt = e.ts; }
    } else if (e.type === "done") {
      const j = jobs.get(e.jobId);
      if (j) { j.status = "done"; j.summary = e.summary; j.finishedAt = e.ts; }
    } else if (e.type === "fail") {
      const j = jobs.get(e.jobId);
      if (j) { j.status = "failed"; j.error = e.error; j.finishedAt = e.ts; }
    }
  }
  return jobs;
}

export function pendingJobs(dir) {
  return [...replay(dir).values()].filter((j) => j.status === "pending");
}
