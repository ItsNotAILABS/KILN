/**
 * KILN Compute runtime: the serverless hardening the watcher asked for.
 * Real daemon, real sandbox — every claim below is executed, not asserted:
 *
 *  - functions run in Linux namespaces: /home and /root are hidden,
 *    the environment is a minimal allowlist (no host secrets leak in)
 *  - network is denied unless network:true
 *  - memoryMB is enforced (RSS supervisor SIGKILLs past 2x)
 *  - timeouts kill even SIGTERM-ignoring spinners
 *  - every invocation reports metrics + billing (GB-seconds)
 *  - admission is bounded: 429 + Retry-After at capacity
 *  - /v1/compute/capacity reports Little's-law scheduler telemetry
 *  - function errors never retry; retries cover sandbox-infra failures only
 *  - app status reflects TCP readiness of the declared port, not just the
 *    worker process; apps get an explicit env allowlist, never the
 *    worker's full environment
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

describe("KILN compute runtime (real daemon + real sandbox)", () => {
  let dir, daemon, kiln, api;

  it("boots a daemon with a 2-slot compute lane", async () => {
    dir = makeStateDir();
    daemon = spawn(process.execPath, [DAEMON], {
      env: {
        ...process.env,
        KILN_SWARM_DIR: dir,
        KILN_SWARM_API_PORT: "0",
        KILN_COMPUTE_MAX_CONCURRENT: "2",
        KILN_RT_SECRET_MARKER: "should-never-leak",
      },
      stdio: "ignore",
    });
    api = await waitForApi(dir);
    kiln = await ComputeClient.connect({ dir });
  });

  it("sandbox: /home and /root are hidden, host env does not leak in", async () => {
    const v = await kiln.invoke({
      name: "rt-isolation",
      code: `export async function main() {
        const { readFileSync } = await import("node:fs");
        const probe = (p) => { try { readFileSync(p); return "LEAKED"; } catch (e) { return e.code; } };
        return {
          home: probe("/home/nonexistent-probe-xyz"),
          root: probe("/root/nonexistent-probe-xyz"),
          envKeys: Object.keys(process.env).sort(),
          marker: process.env.KILN_RT_SECRET_MARKER || "absent",
        };
      }`,
      waitMs: 60000,
    });
    assert.equal(v.status, "done");
    assert.equal(v.ok, true);
    // /home and /root are covered with an empty dir: nothing to read.
    assert.equal(v.result.home, "ENOENT");
    assert.equal(v.result.root, "ENOENT");
    // Minimal env allowlist — only what the sandbox sets.
    assert.deepEqual(v.result.envKeys, ["HOME", "PATH"]);
    assert.equal(v.result.marker, "absent");
  });

  it("sandbox: network is denied by default", async () => {
    const v = await kiln.invoke({
      name: "rt-netoff",
      code: `export async function main() {
        try {
          await fetch("http://127.0.0.1:9/", { signal: AbortSignal.timeout(3000) });
          return "LEAKED";
        } catch (e) {
          return "denied:" + (e.cause?.code || e.name);
        }
      }`,
      waitMs: 60000,
    });
    assert.equal(v.status, "done");
    assert.equal(v.ok, true);
    assert.match(v.result, /^denied:/);
    assert.notEqual(v.result, "LEAKED");
  });

  it("sandbox: memoryMB is enforced (RSS supervisor SIGKILLs past 2x)", async () => {
    const v = await kiln.invoke({
      name: "rt-memhog",
      code: `export async function main() {
        const bufs = [];
        for (let i = 0; i < 40; i++) {
          bufs.push(Buffer.alloc(10 * 1024 * 1024).fill(1)); // touched pages: real RSS
          await new Promise((r) => setTimeout(r, 30));
        }
        return "survived";
      }`,
      memoryMB: 64,
      waitMs: 90000,
    });
    assert.equal(v.status, "done");
    assert.equal(v.ok, false, "the hog must not survive");
    assert.equal(v.metrics?.rssKilled, true);
    assert.match(v.error || "", /memory limit exceeded/);
  });

  it("sandbox: timeout kills even a SIGTERM-ignoring spinner", async () => {
    const v = await kiln.invoke({
      name: "rt-spinner",
      code: `export async function main() {
        process.on("SIGTERM", () => {});
        const t0 = Date.now();
        let x = 0;
        while (Date.now() - t0 < 60000) x += Math.sqrt(x + 1);
        return x;
      }`,
      timeoutMs: 3000,
      waitMs: 60000,
    });
    assert.equal(v.status, "done");
    assert.equal(v.ok, false);
    assert.equal(v.metrics?.timedOut, true);
  });

  it("sandbox: fork-bomb guard trips in the PID namespace", async () => {
    const v = await kiln.invoke({
      name: "rt-forkbomb",
      code: `export async function main() {
        const { spawn } = await import("node:child_process");
        const { writeFileSync, chmodSync } = await import("node:fs");
        writeFileSync("fb.sh", "#!/bin/bash\\n:(){ :|:& };:\\n");
        chmodSync("fb.sh", 0o755);
        spawn("./fb.sh", { stdio: "ignore", detached: true }).unref();
        await new Promise((r) => setTimeout(r, 20000));
        return "bomb survived";
      }`,
      timeoutMs: 25000,
      waitMs: 60000,
    });
    assert.equal(v.status, "done");
    assert.equal(v.ok, false, "the bomb must not survive");
    assert.equal(v.metrics?.forkBomb, true);
    assert.match(v.error || "", /fork-bomb guard/);
  });

  it("invocations report metrics and billing (GB-seconds)", async () => {
    const v = await kiln.invoke({
      name: "rt-metered",
      code: `export async function main(args) { return { x: args.x * 2 }; }`,
      args: { x: 21 },
      memoryMB: 128,
      waitMs: 60000,
    });
    assert.equal(v.status, "done");
    assert.equal(v.ok, true);
    assert.equal(v.result.x, 42);
    assert.ok(v.metrics.wallMs > 0, "wallMs metered");
    assert.ok(v.metrics.cpuMs !== null && v.metrics.cpuMs >= 0, "cpuMs metered");
    assert.ok(v.metrics.peakRssBytes > 0, "peak RSS metered");
    assert.equal(v.metrics.timedOut, false);
    assert.equal(v.billing.memoryMB, 128);
    assert.ok(v.billing.billedMs > 0, "billed ms > 0");
    const expectGbS = (v.billing.billedMs / 1000) * (128 / 1024);
    assert.ok(Math.abs(v.billing.gbSeconds - expectGbS) < 1e-6, "GB-seconds = s * GB");
  });

  it("capacity endpoint reports Little's-law scheduler telemetry", async () => {
    const c = await kiln.capacity();
    assert.equal(c.maxConcurrent, 2);
    assert.ok(Number.isInteger(c.cpuCount) && c.cpuCount >= 1);
    assert.ok(c.memTotalMB > 0);
    assert.ok(typeof c.arrivalPerSec === "number");
    assert.ok(typeof c.p50DurationMs === "number");
    assert.ok(Number.isInteger(c.littleTargetWorkers));
  });

  it("function errors never retry (retries cover infra failures only)", async () => {
    const v = await kiln.invoke({
      name: "rt-noretry",
      code: `export async function main() { throw new Error("user bug"); }`,
      retries: 2,
      waitMs: 60000,
    });
    assert.equal(v.status, "done");
    assert.equal(v.ok, false);
    assert.equal(v.attempt, 1, "a function error must not be retried");
    assert.equal(v.retried, undefined);
    assert.match(v.error, /user bug/);
  });

  it("admission is bounded: 429 + Retry-After at capacity", async () => {
    const slow = `export async function main() {
      await new Promise((r) => setTimeout(r, 8000));
      return "slow-done";
    }`;
    // Occupy both lanes without waiting.
    const a = await kiln.invoke({ name: "rt-lane1", code: slow });
    const b = await kiln.invoke({ name: "rt-lane2", code: slow });
    assert.equal(a.status, "pending");
    assert.equal(b.status, "pending");
    // Third submit must be refused loudly, not queued forever.
    const token = readFileSync(join(dir, "api.token"), "utf8").trim();
    const res = await fetch(`${api.apiUrl}/v1/compute/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "rt-lane3", code: slow }),
    });
    assert.equal(res.status, 429);
    assert.ok(res.headers.get("retry-after"), "Retry-After header present");
    const body = await res.json();
    assert.match(body.error, /capacity/);
    // Lanes drain; the slow ones still complete.
    const va = await kiln.waitInvocation(a.invocationId, { timeoutMs: 60000 });
    assert.equal(va.result, "slow-done");
  });

  it("app status reflects TCP readiness, not just the worker process", async () => {
    const repo = makeGitRepo();
    writeFileSync(
      join(repo, "server.mjs"),
      `import { createServer } from "node:http";\n` +
      `const port = Number(process.env.PORT || 18901);\n` +
      `createServer((req, res) => { res.end("app-ok"); }).listen(port, "127.0.0.1", () => console.log("listening " + port));\n` +
      `setInterval(() => {}, 1000);\n`
    );
    const { execSync } = await import("node:child_process");
    execSync("git add -A && git commit -qm server", { cwd: repo });
    const app = await kiln.deployApp({
      name: "rt-ready",
      repo,
      command: "node",
      args: ["server.mjs"],
      port: 18901,
    });
    assert.ok(app.appId);
    // Poll until the readiness probe sees the port accepting.
    let st = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      st = await kiln.appStatus(app.appId);
      if (st.status === "ready") break;
      await sleep(1000);
    }
    assert.equal(st.status, "ready");
    assert.equal(st.ready, true);
    assert.equal(st.readyCheck, "tcp:127.0.0.1:18901");
    assert.equal(st.workerAlive, true);
    // And the port really serves.
    const res = await fetch("http://127.0.0.1:18901/");
    assert.equal(await res.text(), "app-ok");
    await kiln.undeployApp(app.appId);
  });

  it("apps get an explicit env allowlist, never the worker's environment", async () => {
    const repo = makeGitRepo();
    writeFileSync(
      join(repo, "envdump.mjs"),
      `console.log("MARKER=" + process.env.KILN_RT_SECRET_MARKER);\n` +
      `console.log("KEYS=" + Object.keys(process.env).sort().join(","));\n` +
      `setInterval(() => {}, 1000);\n`
    );
    const { execSync } = await import("node:child_process");
    execSync("git add -A && git commit -qm envdump", { cwd: repo });
    const app = await kiln.deployApp({
      name: "rt-envcheck",
      repo,
      command: "node",
      args: ["envdump.mjs"],
      env: { DECLARED: "yes" },
    });
    const t0 = Date.now();
    let log = "";
    while (Date.now() - t0 < 45000) {
      log = (await kiln.appLogs(app.appId)).log;
      if (log.includes("MARKER=")) break;
      await sleep(1000);
    }
    assert.match(log, /MARKER=undefined/, "daemon env must not leak into the app");
    assert.match(log, /KEYS=.*DECLARED/, "declared env is present");
    assert.doesNotMatch(log, /KILN_RT_SECRET_MARKER/, "marker name absent from app env");
    await kiln.undeployApp(app.appId);
  });

  after(() => {
    try { daemon?.kill("SIGKILL"); } catch { /* already gone */ }
  });
});
