/**
 * KILN-native CI: push a commit, verify a verification job runs and the
 * status endpoints report it honestly.
 *
 * Real git round trip against the daemon's HTTP API (no mocks): create a
 * repo, seed ci/repos.json with a trivially-passing command, push a commit,
 * wait for the detached runner, then check /ci/status/:sha and /ci/latest.
 * Also proves a push to a repo WITHOUT ci config enqueues nothing.
 *
 * NOTE: async spawn, never spawnSync — the API server under test lives in
 * this same event loop, and spawnSync would deadlock it (git waits for the
 * server; the server can't run while the loop is blocked).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeStateDir } from "./helpers.mjs";
import { loadApiToken } from "../lib/state.mjs";
import { startApiServer } from "../lib/httpapi.mjs";
import { snapshotRefs, readLatest } from "../lib/ci.mjs";

const dir = makeStateDir();
const token = loadApiToken(dir);
let api = null;

/** Async git — keeps the event loop alive for the in-process API server. */
function git(cwd, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`git ${args.join(" ")} exited ${code}: ${stderr.slice(0, 300)}`));
      else resolve(stdout.trim());
    });
  });
}

async function apiGet(path) {
  const res = await fetch(`http://127.0.0.1:${api.port}${path}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function waitFor(cond, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

describe("kiln CI", () => {
  it("push triggers verification and status endpoints report it", async () => {
    api = await startApiServer(dir, { apiPort: 0 });
    const auth = { Authorization: `Bearer ${token}` };

    // Create repo via API.
    let res = await fetch(`http://127.0.0.1:${api.port}/git/auro/ci-probe`, {
      method: "POST", headers: auth,
    });
    assert.equal(res.status, 201);

    // Enroll it in CI with a fast always-pass command.
    mkdirSync(join(dir, "ci"), { recursive: true });
    writeFileSync(join(dir, "ci", "repos.json"), JSON.stringify({
      "auro/ci-probe": { command: "node -e \"process.exit(0)\"", timeoutMs: 30000 },
    }));

    // Push a real commit through smart HTTP (async — see NOTE above).
    const work = mkdtempSync(join(tmpdir(), "kiln-ci-test-"));
    const url = `http://oauth2:${token}@127.0.0.1:${api.port}/git/auro/ci-probe`;
    await git(work, ["init", "-q", "-b", "main", "src"]);
    writeFileSync(join(work, "src", "NOTE.md"), "ci probe\n");
    await git(join(work, "src"), ["add", "."]);
    await git(join(work, "src"), ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "probe"]);
    const sha = await git(join(work, "src"), ["rev-parse", "HEAD"]);
    await git(join(work, "src"), ["push", "-q", url, "main"]);

    // The detached runner should verify it.
    await waitFor(async () => {
      const doc = readLatest(dir, "auro", "ci-probe", "main");
      return doc && doc.sha === sha;
    }, 60000, "ci result");

    const doc = readLatest(dir, "auro", "ci-probe", "main");
    assert.equal(doc.status, "pass");
    assert.equal(doc.sha, sha);

    // Public status endpoints.
    const s1 = await apiGet(`/git/auro/ci-probe/ci/status/${sha}`);
    assert.equal(s1.status, 200);
    assert.equal(s1.body.status, "pass");
    const s2 = await apiGet(`/git/auro/ci-probe/ci/latest?branch=main`);
    assert.equal(s2.status, 200);
    assert.equal(s2.body.sha, sha);
    const s3 = await apiGet(`/git/auro/ci-probe/ci/status/deadbeef`);
    assert.equal(s3.status, 404);
  });

  it("push to a repo without CI config enqueues nothing", async () => {
    const auth = { Authorization: `Bearer ${token}` };
    let res = await fetch(`http://127.0.0.1:${api.port}/git/auro/ci-bare`, {
      method: "POST", headers: auth,
    });
    assert.equal(res.status, 201);
    const work = mkdtempSync(join(tmpdir(), "kiln-ci-test-"));
    const url = `http://oauth2:${token}@127.0.0.1:${api.port}/git/auro/ci-bare`;
    await git(work, ["init", "-q", "-b", "main", "src"]);
    writeFileSync(join(work, "src", "N.md"), "x\n");
    await git(join(work, "src"), ["add", "."]);
    await git(join(work, "src"), ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x"]);
    await git(join(work, "src"), ["push", "-q", url, "main"]);
    await new Promise((r) => setTimeout(r, 3000)); // let any runner finish
    assert.equal(readLatest(dir, "auro", "ci-bare"), null);
    const s = await apiGet(`/git/auro/ci-bare/ci/latest`);
    assert.equal(s.status, 404);
  });

  it("snapshotRefs sees pushed branches", async () => {
    const refs = snapshotRefs(dir, "auro", "ci-probe");
    assert.ok(refs["refs/heads/main"], "main ref present");
    assert.match(refs["refs/heads/main"], /^[0-9a-f]{40}$/);
  });
});

after(async () => {
  if (api) { try { api.server.close(); } catch {} }
});
