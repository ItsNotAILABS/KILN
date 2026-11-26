/**
 * KILN agent transfer — end to end through the real CLI, two processes:
 * `swarm.mjs recv` and `swarm.mjs send`, a >= 1 GiB random file (256 MiB
 * when the temp disk has < 3 GiB free; override with KILN_TRANSFER_E2E_MB),
 * byte-exact check by SHA-256 of both files, plus a SIGKILLed sender that
 * resumes from the receiver's stripe bitmap.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomFillSync } from "node:crypto";
import { mkdtempSync, openSync, writeSync, closeSync, statfsSync, createReadStream, readdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SWARM = join(dirname(fileURLToPath(import.meta.url)), "..", "swarm.mjs");
const root = mkdtempSync(join(tmpdir(), "kiln-tx-e2e-"));
after(() => rmSync(root, { recursive: true, force: true }));
const fs = statfsSync(tmpdir());
const freeGiB = (fs.bavail * fs.bsize) / 2 ** 30;
const MB = Number(process.env.KILN_TRANSFER_E2E_MB) || (freeGiB >= 3.5 ? 1024 : 256);

function makeFile(path, mb) {
  const fd = openSync(path, "w");
  const buf = Buffer.allocUnsafe(4 << 20);
  for (let i = 0; i < mb / 4; i++) { randomFillSync(buf); writeSync(fd, buf); }
  closeSync(fd);
}
function sha(path) {
  return new Promise((res, rej) => {
    const h = createHash("sha256");
    createReadStream(path, { highWaterMark: 4 << 20 }).on("data", (d) => h.update(d)).on("end", () => res(h.digest("hex"))).on("error", rej);
  });
}
function startRecv(args) {
  const p = spawn(process.execPath, [SWARM, "recv", ...args], { stdio: ["ignore", "pipe", "pipe"] });
  const lines = []; let buf = "", err = "";
  const waiters = [];
  p.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); lines.push(l);
      for (const w of [...waiters]) if (w.pred(l)) { waiters.splice(waiters.indexOf(w), 1); w.res(l); }
    }
  });
  p.stderr.on("data", (d) => { err += d; });
  const next = (pred) => new Promise((res, rej) => {
    const hit = lines.find(pred); if (hit) return res(hit);
    waiters.push({ pred, res });
    p.on("exit", (c) => rej(new Error(`recv exited ${c}: ${err}`)));
  });
  return { p, next };
}
function runSend(args) {
  const p = spawn(process.execPath, [SWARM, "send", ...args, "--json"], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { err += d; });
  const done = new Promise((res, rej) => p.on("exit", (code, sig) => code === 0 ? res(JSON.parse(out)) : rej(Object.assign(new Error(`send exited ${code ?? sig}: ${err}`), { sig }))));
  return { p, done };
}

describe(`transfer e2e (${MB} MiB, two CLI processes)`, () => {
  const src = join(root, "payload.zip");
  it(`moves a ${MB} MiB file byte-exact`, { timeout: 600000 }, async () => {
    makeFile(src, MB);
    const out = join(root, "out");
    const rx = startRecv(["--dir", join(root, "rx"), "--out", out, "--once"]);
    const l = await rx.next((x) => x.event === "listening");
    const s = await runSend([src, "--to", l.address, "--dir", join(root, "tx"), "--expect", l.publicKey]).done;
    const got = await rx.next((x) => x.event === "received");
    assert.equal(s.result.status, "complete");
    assert.equal(got.bytes, MB * 2 ** 20);
    assert.equal(await sha(join(out, "payload.zip")), await sha(src));
    console.log(`# e2e ${MB} MiB: hash ${s.hashSeconds.toFixed(2)}s, wire ${s.transferSeconds.toFixed(2)}s, ` +
      `${s.throughputMBps.toFixed(1)} MiB/s, sender peak RSS ${s.peakRssMB} MB, receiver peak RSS ${got.receiverPeakRssMB} MB`);
    // Memory is bounded: neither side holds anything near the file in RAM.
    assert.ok(s.peakRssMB < 1024 && got.receiverPeakRssMB < 1024, "constant-memory streaming");
  });
  it("resumes after the sender is SIGKILLed mid-transfer", { timeout: 600000 }, async () => {
    const out = join(root, "out2");
    const rx = startRecv(["--dir", join(root, "rx2"), "--out", out, "--once"]);
    const l = await rx.next((x) => x.event === "listening");
    const args = [src, "--to", l.address, "--dir", join(root, "tx"), "--streams", "4"];
    const first = runSend(args);
    const stateDir = join(out, ".kiln-recv");
    // wait until the receiver has persisted some finished stripes, then kill the sender hard
    for (let i = 0; i < 2000; i++) {
      const js = existsSync(stateDir) ? readdirSync(stateDir).filter((f) => f.endsWith(".json")) : [];
      if (js.length) {
        try {
          const have = Buffer.from(JSON.parse(readFileSync(join(stateDir, js[0]), "utf8")).have, "base64");
          if (have.some((b) => b)) break;
        } catch { /* mid-write */ }
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    first.p.kill("SIGKILL");
    await assert.rejects(first.done);
    await new Promise((r) => setTimeout(r, 500));
    const s = await runSend(args).done;
    await rx.next((x) => x.event === "received");
    assert.ok(s.skippedStripes > 0, `skipped ${s.skippedStripes}`);
    console.log(`# resume: ${s.skippedStripes}/${s.stripes} stripes already on the receiver; second run sent ${(s.wireBytes / 2 ** 20).toFixed(0)} MiB`);
    assert.equal(await sha(join(out, "payload.zip")), await sha(src));
  });
});
