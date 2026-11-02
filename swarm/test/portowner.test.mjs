/**
 * Port ownership + the stale-listener reaper (lib/portowner.mjs).
 * The reaper is the code-level fix for the orphan mechanism proven
 * live on 2026-10-31: a hard worker death leaves its app child
 * orphaned on the port; the next worker must reap THAT child (and
 * only that child) before binding. All I/O is injected — synthetic
 * /proc fixtures, scripted listener sets, recorded signals.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseListeners, isSelfOrDescendant, reapStaleListener } from "../lib/portowner.mjs";

const TCP_FIXTURE = [
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
  "   0: 0100007F:22C5 00000000:0000 0A 00000000:00000000 00:00000000 00000000   999        0 11111 1 0000000000000000 100 0 0 10 0",
  "   1: 0100007F:22C5 0200007F:C350 01 00000000:00000000 00:00000000 00000000   999        0 22222 1 0000000000000000 100 0 0 10 0",
  "   2: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 33333 1 0000000000000000 100 0 0 10 0",
].join("\n");
// port 8901 = 0x22C5 (LISTEN inode 11111; the state-01 row is not a listener)

describe("portowner: parseListeners", () => {
  it("returns only LISTEN inodes for the port", () => {
    assert.deepEqual([...parseListeners(TCP_FIXTURE, 8901)], ["11111"]);
    assert.deepEqual([...parseListeners(TCP_FIXTURE, 22)], ["33333"]);
    assert.deepEqual([...parseListeners(TCP_FIXTURE, 9999)], []);
    assert.deepEqual([...parseListeners("", 8901)], []);
    assert.deepEqual([...parseListeners(null, 8901)], []);
  });
});

describe("portowner: isSelfOrDescendant", () => {
  it("walks the ppid chain", () => {
    const ppid = new Map([[500, 400], [400, 300], [300, 1], [900, 1]]);
    assert.equal(isSelfOrDescendant(ppid, 500, 300), true);
    assert.equal(isSelfOrDescendant(ppid, 300, 300), true);
    assert.equal(isSelfOrDescendant(ppid, 900, 300), false);
    assert.equal(isSelfOrDescendant(ppid, 500, 999), false);
  });
});

/** Scripted world for the reaper: listener sequence + recorded kills. */
function world({ sequence, cwds }) {
  const kills = [];
  let step = 0;
  return {
    kills,
    deps: {
      port: 8901,
      workdir: "/work/app",
      selfPid: 100,
      graceMs: 100,
      pollMs: 10,
      sleep: async () => {},
      findPids: () => sequence[Math.min(step++, sequence.length - 1)],
      cwdOf: (pid) => cwds[pid] ?? "",
      parentsOf: () => new Map([[4242, 1], [777, 1]]),
      kill: (pid, sig) => kills.push([pid, sig]),
    },
  };
}

describe("portowner: reapStaleListener", () => {
  it("free port: nothing to do", async () => {
    const w = world({ sequence: [[]], cwds: {} });
    assert.deepEqual(await reapStaleListener(w.deps), { action: "free" });
    assert.deepEqual(w.kills, []);
  });

  it("reaps a previous incarnation (ppid 1, cwd == workdir) with SIGTERM", async () => {
    const w = world({ sequence: [[4242], []], cwds: { 4242: "/work/app" } });
    const r = await reapStaleListener(w.deps);
    assert.equal(r.action, "reaped");
    assert.equal(r.pid, 4242);
    assert.deepEqual(w.kills, [[4242, "SIGTERM"]]);
  });

  it("escalates to SIGKILL when SIGTERM is ignored", async () => {
    const w = world({ sequence: [[4242]], cwds: { 4242: "/work/app" } });
    // listener never leaves the scripted set until after SIGKILL:
    let killed = false;
    w.deps.kill = (pid, sig) => { w.kills.push([pid, sig]); if (sig === "SIGKILL") killed = true; };
    w.deps.findPids = () => (killed ? [] : [4242]);
    const r = await reapStaleListener(w.deps);
    assert.equal(r.action, "reaped");
    assert.equal(r.signal, "SIGKILL");
    assert.deepEqual(w.kills.map((k) => k[1]), ["SIGTERM", "SIGKILL"]);
  });

  it("never signals a foreign holder (different cwd)", async () => {
    const w = world({ sequence: [[777]], cwds: { 777: "/someone/else" } });
    const r = await reapStaleListener(w.deps);
    assert.equal(r.action, "foreign");
    assert.equal(r.pid, 777);
    assert.deepEqual(w.kills, []);
  });

  it("never signals our own live child (descendant of self)", async () => {
    const w = world({ sequence: [[150]], cwds: { 150: "/work/app" } });
    w.deps.parentsOf = () => new Map([[150, 100]]);
    const r = await reapStaleListener(w.deps);
    assert.equal(r.action, "free");
    assert.deepEqual(w.kills, []);
  });
});
