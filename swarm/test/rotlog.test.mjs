/**
 * Rotating app log tests (2026-10-17): app.log used to grow unbounded
 * for an app's whole lifetime. Pins rotation at the byte threshold,
 * bounded total files, and rotation of an already-oversized log on open.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createRotatingLog } from "../lib/rotlog.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("createRotatingLog", () => {
  it("rotates at the threshold and keeps a bounded file set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kiln-rotlog-"));
    const p = join(dir, "app.log");
    const log = createRotatingLog(p, { maxBytes: 4096, keep: 2 });
    const chunk = "y".repeat(1024);
    for (let i = 0; i < 20; i++) log.write(chunk);
    log.end();
    await sleep(150); // let stream flushes land
    assert.ok(existsSync(`${p}.1`), "first rotation exists");
    assert.ok(existsSync(`${p}.2`), "second rotation exists");
    assert.ok(!existsSync(`${p}.3`), "nothing beyond keep=2");
    const total = [p, `${p}.1`, `${p}.2`].reduce((s, f) => s + statSync(f).size, 0);
    assert.ok(total <= 3 * 4096 + 4096, `total bounded, got ${total}`);
    assert.ok(log.rotations >= 2, "rotations counted");
  });

  it("an already-oversized log rotates on open", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kiln-rotlog-"));
    const p = join(dir, "app.log");
    writeFileSync(p, "z".repeat(10000));
    const log = createRotatingLog(p, { maxBytes: 4096, keep: 2 });
    assert.ok(existsSync(`${p}.1`), "pre-existing oversize rotated at open");
    assert.equal(readFileSync(`${p}.1`, "utf8").length, 10000);
    log.write("fresh\n");
    log.end();
    await sleep(100);
    assert.match(readFileSync(p, "utf8"), /fresh/);
  });
});
