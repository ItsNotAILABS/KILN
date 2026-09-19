/** nightly.mjs: plan building, binary resolution, and the loud daemon-down failure. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildNightlyPlan, whichBin, expandPath } from "../nightly.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("buildNightlyPlan", () => {
  it("mirrors the nightly template: setup, test, report, commit", () => {
    const plan = buildNightlyPlan({
      project: "kiln",
      setup: [["/usr/bin/git", "submodule", "update", "--init"]],
      test: { bin: "/usr/local/bin/forge", args: ["test"], timeoutMs: 300000 },
      stamp: "2026-09-18T00:00:00.000Z",
    });
    assert.equal(plan.steps.length, 4);
    assert.equal(plan.steps[0].tool, "shell.exec");
    assert.deepEqual(plan.steps[0].args.args, ["submodule", "update", "--init"]);
    assert.equal(plan.steps[1].tool, "shell.exec");
    assert.equal(plan.steps[1].args.command, "/usr/local/bin/forge");
    assert.equal(plan.steps[2].tool, "fs.write");
    assert.equal(plan.steps[2].args.path, "TEST_REPORT.md");
    assert.match(plan.steps[2].args.content, /2026-09-18T00:00:00\.000Z/); // timestamp => tree always changes
    assert.equal(plan.steps[3].tool, "git.commit");
  });
  it("works with no setup steps", () => {
    const plan = buildNightlyPlan({
      project: "x",
      test: { bin: "/usr/bin/true", args: [] },
      stamp: "s",
    });
    assert.equal(plan.steps.length, 3);
    assert.equal(plan.steps[0].tool, "shell.exec");
  });
});

describe("whichBin / expandPath", () => {
  it("finds node on PATH", () => {
    const p = whichBin("node");
    assert.ok(p && p.includes("node"), `got ${p}`);
  });
  it("returns null for a missing binary", () => {
    assert.equal(whichBin("kiln-no-such-binary-xyz"), null);
  });
  it("rejects metacharacters instead of running them", () => {
    assert.equal(whichBin("node; echo pwned"), null);
  });
  it("expands ~", () => {
    assert.ok(expandPath("~/x").startsWith("/"), expandPath("~/x"));
    assert.ok(!expandPath("~/x").includes("~"));
  });
});

describe("daemon-down behavior", () => {
  it("fails LOUDLY with the fix command when no daemon is reachable", () => {
    const empty = mkdtempSync(join(tmpdir(), "kiln-nightly-test-"));
    const r = spawnSync(process.execPath, [join(HERE, "..", "nightly.mjs"), "--dir", empty], {
      encoding: "utf8",
      timeout: 30000,
    });
    assert.notEqual(r.status, 0, "must exit non-zero");
    const out = (r.stdout || "") + (r.stderr || "");
    assert.match(out, /daemon/i);
    assert.match(out, /daemon start/);
  });
});
