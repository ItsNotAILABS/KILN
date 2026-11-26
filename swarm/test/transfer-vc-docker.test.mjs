/**
 * KILN agent transfer into and out of a REAL docker virtual computer's
 * home (/home/agent on its named volume). Skips (loudly) when docker or
 * the kiln-vc image isn't available.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerBackend } from "../lib/vcomputer-backends.mjs";
import { createComputer, deleteComputer, getBackends } from "../lib/vcomputer.mjs";
import { startReceiver, sendFile, receiveIntoComputer, sendFromComputer, generateKeypair } from "../lib/transfer.mjs";
import { makeStateDir } from "./helpers.mjs";

const av = new DockerBackend().available();
const skip = av.ok ? false : `docker backend unavailable: ${av.reason}`;
const sha = (b) => createHash("sha256").update(b).digest("hex");

describe("transfer <-> docker vc home", { skip }, () => {
  const dir = makeStateDir();
  const tmp = mkdtempSync(join(tmpdir(), "kiln-tx-vc-"));
  let vc;
  after(async () => {
    if (vc) await deleteComputer(dir, vc.id, { purge: true }).catch(() => {});
    rmSync(tmp, { recursive: true, force: true });
  });
  it("receives into /home/agent/<subdir> owned by the agent user, and sends back out", { timeout: 180000 }, async () => {
    vc = await createComputer(dir, { name: "tx-docker", backend: "docker", browser: false });
    const data = randomBytes(24 * 1024 * 1024 + 5);
    const src = join(tmp, "bundle.zip"); writeFileSync(src, data);
    const rx = await receiveIntoComputer(dir, vc.id, { subdir: "inbox", keypair: generateKeypair() });
    const r = await sendFile(src, { port: rx.port, keypair: generateKeypair() });
    await rx.close();
    assert.equal(r.result.homePath, "/home/agent/inbox/bundle.zip");
    const b = getBackends().docker;
    const inside = await b.exec(vc, ["sh", "-c", "sha256sum /home/agent/inbox/bundle.zip | cut -d' ' -f1; stat -c %U /home/agent/inbox/bundle.zip"]);
    const [h, owner] = inside.stdout.trim().split("\n");
    assert.equal(h, sha(data));
    assert.equal(owner, "agent");
    // out of the vc
    const out = join(tmp, "out");
    const back = await startReceiver({ outDir: out, keypair: generateKeypair() });
    const r2 = await sendFromComputer(dir, vc.id, "inbox/bundle.zip", { port: back.port, keypair: generateKeypair() });
    await back.close();
    assert.equal(r2.result.status, "complete");
    assert.equal(sha(readFileSync(join(out, "bundle.zip"))), sha(data));
  });
});
