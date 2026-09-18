/** Receipts: real ed25519 signatures, tamper + chain-break detection. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { newKeypair, loadKeypair } from "../lib/keys.mjs";
import { appendReceipt, verifyReceipts, receiptsPath } from "../lib/receipts.mjs";
import { makeStateDir } from "./helpers.mjs";

function setup() {
  const dir = makeStateDir();
  const stored = newKeypair();
  const kp = loadKeypair({ privPkcs8B64: stored.privPkcs8B64, pubSpkiB64: stored.pubSpkiB64 });
  mkdirSync(join(dir, "nodes", stored.id), { recursive: true });
  // node id must equal keypair id for sanity
  assert.equal(kp.id, stored.id);
  return { dir, id: stored.id, kp };
}

describe("receipts", () => {
  it("signs and verifies a chain", () => {
    const { dir, id, kp } = setup();
    appendReceipt(dir, id, kp, "fs.write", { path: "a.txt" }, { ok: true, out: "wrote" });
    appendReceipt(dir, id, kp, "shell.exec", { command: "ls" }, { ok: true, out: "a.txt" });
    const v = verifyReceipts(dir, id, kp);
    assert.equal(v.ok, true);
    assert.equal(v.count, 2);
  });
  it("detects a tampered receipt", () => {
    const { dir, id, kp } = setup();
    appendReceipt(dir, id, kp, "fs.write", { path: "a.txt" }, { ok: true, out: "wrote" });
    appendReceipt(dir, id, kp, "fs.write", { path: "b.txt" }, { ok: true, out: "wrote" });
    const p = receiptsPath(dir, id);
    const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
    const rec = JSON.parse(lines[1]);
    rec.r.tool = "shell.exec"; // tamper: signature now invalid
    lines[1] = JSON.stringify(rec);
    writeFileSync(p, lines.join("\n") + "\n");
    const v = verifyReceipts(dir, id, kp);
    assert.equal(v.ok, false);
    assert.match(v.error, /bad signature/);
  });
  it("detects a broken hash chain (receipt removed)", () => {
    const { dir, id, kp } = setup();
    appendReceipt(dir, id, kp, "a", {}, { ok: true });
    appendReceipt(dir, id, kp, "b", {}, { ok: true });
    appendReceipt(dir, id, kp, "c", {}, { ok: true });
    const p = receiptsPath(dir, id);
    const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
    lines.splice(1, 1); // remove middle receipt
    writeFileSync(p, lines.join("\n") + "\n");
    const v = verifyReceipts(dir, id, kp);
    assert.equal(v.ok, false);
    assert.match(v.error, /seq|hash chain/);
  });
  it("fails verification with the wrong key", () => {
    const { dir, id, kp } = setup();
    appendReceipt(dir, id, kp, "a", {}, { ok: true });
    const other = newKeypair();
    const otherKp = loadKeypair({ privPkcs8B64: other.privPkcs8B64, pubSpkiB64: other.pubSpkiB64 });
    const v = verifyReceipts(dir, id, otherKp);
    assert.equal(v.ok, false);
  });
  it("node id is sha256 of the raw pubkey, not an ethereum address", () => {
    const { id, kp } = setup();
    assert.equal(id.length, 64);
    assert.match(id, /^[0-9a-f]{64}$/);
    assert.equal(kp.pubRawHex.length, 64);
  });
});
