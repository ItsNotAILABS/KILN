/**
 * KILN Compute, end to end against a REAL daemon process:
 * invoke (sync/async/failing/validation), map fan-out, app deploy lifecycle.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ComputeClient } from "../lib/compute-client.mjs";
import { makeStateDir, makeGitRepo } from "./helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON = join(HERE, "..", "lib", "daemon.mjs");

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForApi(dir, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const p = join(dir, "daemon.json");
    if (existsSync(p)) {
      try {
        const dj = JSON.parse(readFileSync(p, "utf8"));
        if (dj.apiPort) return dj;
      } catch { /* still writing */ }
    }
    await sleep(200);
  }
  throw new Error("timed out waiting for daemon api");
}

describe("KILN compute (real daemon)", () => {
  let dir, daemon, kiln;

  it("boots a daemon", async () => {
    dir = makeStateDir();
    daemon = spawn(process.execPath, [DAEMON], {
      env: { ...process.env, KILN_SWARM_DIR: dir, KILN_SWARM_API_PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    daemon.on("error", (e) => { throw e; });
    await waitForApi(dir);
    kiln = await ComputeClient.connect({ dir });
    assert.equal((await kiln.health()).ok, true);
  });

  it("invoke runs code synchronously and returns the result", async () => {
    const r = await kiln.invoke({
      name: "compute-e2e-sync",
      code: `export async function main(args) { console.log("hello from kiln"); return { doubled: args.x * 2 }; }`,
      args: { x: 21 },
      waitMs: 90000,
    });
    assert.equal(r.status, "done");
    assert.equal(r.ok, true);
    assert.deepEqual(r.result, { doubled: 42 });
    assert.ok(r.logs.join("\n").includes("hello from kiln"), "console.log captured");
    assert.ok(r.durationMs >= 0);
  });

  it("async invoke can be polled to completion", async () => {
    const sub = await kiln.invoke({
      code: `export async function main(args) { return args.n + 1; }`,
      args: { n: 41 },
    });
    assert.equal(sub.status, "pending");
    assert.ok(sub.invocationId.startsWith("inv_"));
    const v = await kiln.waitInvocation(sub.invocationId, { timeoutMs: 90000 });
    assert.equal(v.ok, true);
    assert.equal(v.result, 42);
  });

  it("failing code reports ok:false with the real error", async () => {
    const r = await kiln.invoke({
      code: `export async function main() { throw new Error("boom-12345"); }`,
      waitMs: 90000,
    });
    assert.equal(r.status, "done");
    assert.equal(r.ok, false);
    assert.ok(r.error.includes("boom-12345"), `error was: ${r.error}`);
  });

  it("a module without main() fails loudly, not silently", async () => {
    const r = await kiln.invoke({
      code: `export const x = 1;`,
      waitMs: 90000,
    });
    assert.equal(r.ok, false);
    assert.ok(r.error.includes("main"), `error was: ${r.error}`);
  });

  it("validation rejects bad input with 400", async () => {
    // Raw fetch: prove the SERVER validates, bypassing client pre-checks.
    async function post(path, body) {
      const res = await fetch(kiln.baseUrl + path, {
        method: "POST",
        headers: { "content-type": "application/json", "authorization": `Bearer ${kiln.token}` },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    }
    let r = await post("/v1/compute/invoke", { code: "" });
    assert.equal(r.status, 400, `empty code: ${JSON.stringify(r.body)}`);
    r = await post("/v1/compute/invoke", {
      code: "export async function main(){ return 1; }", timeoutMs: 999999,
    });
    assert.equal(r.status, 400, `bad timeout: ${JSON.stringify(r.body)}`);
    r = await post("/v1/compute/map", { code: "export async function main(){ return 1; }", items: [] });
    assert.equal(r.status, 400, `empty items: ${JSON.stringify(r.body)}`);
    r = await post("/v1/compute/apps", { name: "x", repo: makeGitRepo(), command: "sh" });
    assert.equal(r.status, 400, `shell binary rejected: ${JSON.stringify(r.body)}`);
    const g = await fetch(kiln.baseUrl + "/v1/compute/invocations/inv_doesnotexist", {
      headers: { authorization: `Bearer ${kiln.token}` },
    });
    assert.equal(g.status, 404);
  });

  it("map fans out across workers and gathers results", async () => {
    const { mapId, count } = await kiln.map({
      name: "compute-e2e-map",
      code: `export async function main(n) { return n * n; }`,
      items: [1, 2, 3, 4, 5, 6],
      timeoutMs: 60000,
    });
    assert.equal(count, 6);
    const m = await kiln.waitMap(mapId, { timeoutMs: 180000 });
    assert.equal(m.results.length, 6);
    const squares = m.results.map((r) => r.result).sort((a, b) => a - b);
    assert.deepEqual(squares, [1, 4, 9, 16, 25, 36]);
    assert.ok(m.results.every((r) => r.status === "done" && r.ok === true));
  });

  it("deploy/undeploy runs a real supervised app", async () => {
    // A tiny git repo whose "server" appends a heartbeat line, then sleeps.
    const repo = makeGitRepo();
    writeFileSync(
      join(repo, "app.mjs"),
      `import { appendFileSync } from "node:fs";\n` +
      `appendFileSync("heartbeat.txt", "alive\\n");\n` +
      `setInterval(() => {}, 1000);\n`
    );
    const { execSync } = await import("node:child_process");
    execSync("git add -A && git commit -qm app", { cwd: repo });

    const app = await kiln.deployApp({
      name: "e2e-heartbeat",
      repo,
      command: "node",
      args: ["app.mjs"],
    });
    assert.ok(app.appId, "got an app id");

    // The daemon spawns the worker on its next tick; the worker boots the app.
    // Proof the supervisor spawned the child: app.log appears.
    const appLogPath = join(dir, "nodes", app.appId, "app.log");
    const t0 = Date.now();
    while (!existsSync(appLogPath) && Date.now() - t0 < 45000) await sleep(1000);
    assert.ok(existsSync(appLogPath), "supervisor spawned the app (app.log exists)");
    const apps = await kiln.listApps();
    assert.ok(apps.some((a) => a.appId === app.appId && a.name === "e2e-heartbeat"));

    // The app itself wrote its heartbeat file into the cloned workdir.
    const hbPath = join(dir, "nodes", app.appId, "work", "heartbeat.txt");
    const t1 = Date.now();
    let beat = false;
    while (Date.now() - t1 < 30000) {
      if (existsSync(hbPath)) { beat = true; break; }
      await sleep(1000);
    }
    assert.ok(beat, "deployed app actually ran and wrote heartbeat.txt");

    const un = await kiln.undeployApp(app.appId);
    assert.equal(un.ok, true);
  });

  after(() => {
    try { daemon.kill("SIGTERM"); } catch { /* already gone */ }
  });
});
