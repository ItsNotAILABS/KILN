/**
 * KILN virtual computers end to end against a REAL daemon, local backend
 * (real Xvfb + xfwm4 + xdotool + ffmpeg + x11vnc + websockify on this
 * host). Covers the control API, shell exec + background jobs, the
 * hand-off lock / page / websocket proxy / hand-back, secret hygiene,
 * persistence across stop/start, and idle shutdown.
 *
 * Skips (loudly) when the desktop tools aren't installed. The docker
 * backend has its own suite (vcomputer-docker.test.mjs).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { connect } from "node:net";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { VComputerClient } from "../lib/vcomputer-client.mjs";
import { makeStateDir } from "./helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON = join(HERE, "..", "lib", "daemon.mjs");
const TOOLS = ["Xvfb", "xfwm4", "xdotool", "ffmpeg", "x11vnc", "websockify"];
const missing = TOOLS.filter((t) => spawnSync("sh", ["-c", `command -v ${t}`]).status !== 0);
const skip = missing.length ? `desktop tools not installed: ${missing.join(", ")}` : false;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForApi(dir, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const p = join(dir, "daemon.json");
    if (existsSync(p)) {
      try { const dj = JSON.parse(readFileSync(p, "utf8")); if (dj.apiPort) return dj; } catch {}
    }
    await sleep(200);
  }
  throw new Error("timed out waiting for daemon api");
}

async function status(p) {
  try { await p; return 200; } catch (e) { return e.status; }
}

/** Raw WebSocket upgrade through the daemon; resolves the status line. */
function wsUpgrade(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const s = connect(port, "127.0.0.1", () => {
      let h = `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: binary\r\n";
      for (const [k, v] of Object.entries(headers)) h += `${k}: ${v}\r\n`;
      s.write(h + "\r\n");
    });
    s.setTimeout(10000, () => { s.destroy(); reject(new Error("ws timeout")); });
    s.once("data", (d) => { resolve(d.toString("latin1").split("\r\n")[0]); s.destroy(); });
    s.on("error", reject);
  });
}

describe("KILN virtual computers — local backend (real daemon)", { skip }, () => {
  let dir, daemon, kiln, port, vc, logBuf = "";

  after(async () => {
    try { for (const c of await kiln.listComputers()) await kiln.stopComputer(c.id).catch(() => {}); } catch {}
    if (daemon) daemon.kill("SIGTERM");
  });

  it("boots a daemon", async () => {
    dir = makeStateDir();
    daemon = spawn(process.execPath, [DAEMON], {
      env: { ...process.env, KILN_SWARM_DIR: dir, KILN_SWARM_API_PORT: "0", KILN_VC_ALLOW_LOCAL: "1", KILN_VC_SWEEP_MS: "500" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    daemon.stdout.on("data", (d) => { logBuf += d; });
    daemon.stderr.on("data", (d) => { logBuf += d; });
    port = (await waitForApi(dir)).apiPort;
    kiln = await VComputerClient.connect({ dir });
  });

  it("refuses unauthenticated callers", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/vcomputers`);
    assert.equal(r.status, 401);
  });

  it("creates and starts a computer (no browser, for speed)", async () => {
    vc = await kiln.createComputer({ name: "agent-1", backend: "local", browser: false, width: 800, height: 600, idleTimeoutSec: 0 });
    assert.match(vc.id, /^vc_[0-9a-f]{12}$/);
    assert.equal(vc.status, "running");
    assert.equal(vc.isolation, "none");
    assert.equal(vc.control, "agent");
    assert.equal(await status(kiln.createComputer({ name: "agent-1", backend: "local" })), 409, "names are unique");
    assert.equal(await status(kiln.getComputer("vc_000000000000")), 404);
  });

  it("screenshot returns a PNG of the configured size", async () => {
    const s = await kiln.screenshot(vc.id);
    assert.equal(s.png.subarray(1, 4).toString(), "PNG");
    assert.equal(s.png.readUInt32BE(16), 800);
    assert.equal(s.png.readUInt32BE(20), 600);
    const raw = await fetch(`http://127.0.0.1:${port}/v1/vcomputers/${vc.id}/screenshot?format=png`, { headers: { authorization: `Bearer ${kiln.token}` } });
    assert.equal(raw.headers.get("content-type"), "image/png");
  });

  it("input moves the real pointer (pixels and 0..1 coordinates)", async () => {
    await kiln.move(vc.id, { x: 123, y: 45 });
    let loc = await kiln.exec(vc.id, "xdotool getmouselocation --shell");
    assert.match(loc.stdout, /X=123\nY=45\n/);
    await kiln.click(vc.id, { nx: 1, ny: 1 });
    loc = await kiln.exec(vc.id, "xdotool getmouselocation --shell");
    assert.match(loc.stdout, /X=799\nY=599\n/);
    await kiln.key(vc.id, "ctrl+a");
    await kiln.scroll(vc.id, { dy: 2 });
    await kiln.input(vc.id, { action: "drag", x: 10, y: 10, x2: 50, y2: 60 });
    assert.equal(await status(kiln.input(vc.id, { action: "move", x: 800, y: 0 })), 400);
  });

  it("type delivers text to the focused window and never logs it", async () => {
    // xev (x11-utils, also in the image) prints the keysyms its window receives.
    const hasXev = spawnSync("sh", ["-c", "command -v xev"]).status === 0;
    if (hasXev) {
      const { jobId } = await kiln.startJob(vc.id, "exec xev -event keyboard -geometry 300x200+0+0 > ~/xev.log");
      await sleep(800);
      await kiln.click(vc.id, { x: 100, y: 100 });
      await kiln.type(vc.id, "kiln");
      await sleep(300);
      const log = (await kiln.exec(vc.id, "grep -A3 KeyPress ~/xev.log | grep -o 'keysym 0x[0-9a-f]*, [a-z]'  | awk '{print $3}' | tr -d '\\n'")).stdout;
      assert.ok(log.includes("kiln"), `xev saw ${JSON.stringify(log)}`);
      await kiln.killJob(vc.id, jobId);
    }
    const secret = "s3cret-Pa55-" + Date.now();
    await kiln.type(vc.id, secret);
    const act = readFileSync(join(dir, "vcomputers", vc.id, "activity.jsonl"), "utf8");
    assert.ok(!act.includes(secret), "typed text is not in the activity log");
    assert.match(act, new RegExp(`"kind":"type","chars":${secret.length}`));
    assert.ok(!readFileSync(join(dir, "vcomputers", vc.id, "computer.json"), "utf8").includes(secret));
    assert.ok(!logBuf.includes(secret), "typed text is not in daemon output");
  });

  it("exec: stdout/stderr/exit code, HOME is the computer's home, no daemon env", async () => {
    const r = await kiln.exec(vc.id, "echo out; echo err >&2; echo $HOME; echo ${KILN_SWARM_DIR:-unset}; exit 3");
    assert.equal(r.exitCode, 3);
    assert.equal(r.timedOut, false);
    const [o1, home, swarmDir] = r.stdout.trim().split("\n");
    assert.equal(o1, "out");
    assert.equal(r.stderr.trim(), "err");
    assert.equal(home, join(dir, "vcomputers", vc.id, "home"));
    assert.equal(swarmDir, "unset", "the daemon's environment does not leak into the machine");
    const s = await kiln.exec(vc.id, "cat", { stdin: "piped" });
    assert.equal(s.stdout, "piped");
  });

  it("exec: timeout kills the command tree", async () => {
    const t0 = Date.now();
    const r = await kiln.exec(vc.id, "sleep 30 & sleep 30; echo never", { timeoutMs: 1000 });
    assert.equal(r.timedOut, true);
    assert.ok(Date.now() - t0 < 8000, "returned promptly");
    assert.ok(!r.stdout.includes("never"));
    assert.equal(await status(kiln.exec(vc.id, "true", { timeoutMs: 10 })), 400);
    assert.equal(await status(kiln.exec(vc.id, "")), 400);
  });

  it("background jobs: run, report output and exit code, can be killed", async () => {
    const { jobId } = await kiln.startJob(vc.id, "echo start; sleep 1; echo end; exit 7");
    assert.match(jobId, /^job_[0-9a-f]{12}$/);
    let j;
    for (let i = 0; i < 40; i++) { j = await kiln.job(vc.id, jobId); if (j.status === "exited") break; await sleep(250); }
    assert.equal(j.status, "exited");
    assert.equal(j.exitCode, 7);
    assert.equal(j.log, "start\nend\n");

    const long = await kiln.startJob(vc.id, "sleep 300");
    await sleep(500);
    assert.equal((await kiln.job(vc.id, long.jobId)).status, "running");
    await kiln.killJob(vc.id, long.jobId);
    let k;
    for (let i = 0; i < 20; i++) { k = await kiln.job(vc.id, long.jobId); if (k.status !== "running") break; await sleep(250); }
    assert.notEqual(k.status, "running", "killed job is no longer running");
    const list = await kiln.jobs(vc.id);
    assert.ok(list.some((x) => x.id === jobId) && list.some((x) => x.id === long.jobId));
    assert.equal(await status(kiln.job(vc.id, "job_000000000000")), 404);
  });

  let handoffUrl, token;

  it("hand-off: returns an owner URL once, locks the agent out (423)", async () => {
    const r = await kiln.handoff(vc.id, { reason: "Sign in to GitHub", instructions: "Enter the device code shown", timeoutSec: 300 });
    handoffUrl = r.url;
    token = r.url.split("/handoff/")[1];
    assert.equal(r.handoff.state, "pending");
    assert.equal(r.handoff.tokenHash, undefined);
    assert.ok(handoffUrl.startsWith(`http://127.0.0.1:${port}/handoff/`));
    assert.equal(await status(kiln.screenshot(vc.id)), 423);
    assert.equal(await status(kiln.click(vc.id, { x: 1, y: 1 })), 423);
    assert.equal(await status(kiln.exec(vc.id, "true")), 423);
    assert.equal(await status(kiln.handoff(vc.id, { reason: "again" })), 409, "one hand-off at a time");
    const v = await kiln.getComputer(vc.id);
    assert.equal(v.control, "owner");
    // The token is never stored or logged anywhere in the state dir.
    const files = spawnSync("grep", ["-rl", token, dir], { encoding: "utf8" }).stdout.trim();
    assert.equal(files, "", `token found in: ${files}`);
    assert.ok(!logBuf.includes(token), "token not in daemon output");
  });

  it("hand-off page: banner, instructions, safe headers; bad tokens 404", async () => {
    const r = await fetch(handoffUrl);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes("Sign in to GitHub") && html.includes("Enter the device code shown"));
    assert.ok(html.includes("hand back"));
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(r.headers.get("referrer-policy"), "no-referrer");
    assert.equal(r.headers.get("x-frame-options"), "DENY");
    assert.match(r.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/handoff/${"A".repeat(43)}`)).status, 404);
    const asset = await fetch(`http://127.0.0.1:${port}/handoff-assets/novnc/core/rfb.js`);
    if (existsSync("/usr/share/novnc/core/rfb.js")) assert.equal(asset.status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/handoff-assets/novnc/..%2f..%2fetc%2fpasswd`)).status, 404, "no path escape");
    const v = await kiln.handoffStatus(vc.id);
    assert.equal(v.handoff.state, "active", "opening the page marks it active");
  });

  it("hand-off viewer: websocket proxied to the machine; wrong token or foreign origin refused", async () => {
    assert.match(await wsUpgrade(port, `/handoff/${token}/websockify`), /^HTTP\/1\.1 101/);
    assert.match(await wsUpgrade(port, `/handoff/${"B".repeat(43)}/websockify`), /^HTTP\/1\.1 404/);
    assert.match(await wsUpgrade(port, `/handoff/${token}/websockify`, { Origin: "https://evil.example" }), /^HTTP\/1\.1 403/);
  });

  it("hand back: agent waiting on the long-poll resumes; link is dead after", async () => {
    const waiting = kiln.waitForHandBack(vc.id, { timeoutMs: 20000 });
    await sleep(500);
    const r = await fetch(`${handoffUrl}/return`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ outcome: "done", typed: "should-be-ignored-secret" }),
    });
    assert.equal(r.status, 200);
    const h = await waiting;
    assert.deepEqual([h.state, h.outcome, h.endedBy], ["returned", "done", "owner"]);
    assert.ok(!readFileSync(join(dir, "vcomputers", vc.id, "computer.json"), "utf8").includes("should-be-ignored-secret"));
    assert.equal((await fetch(`${handoffUrl}/return`, { method: "POST", body: "{}" })).status, 410);
    assert.equal((await fetch(handoffUrl)).status, 410);
    assert.match(await wsUpgrade(port, `/handoff/${token}/websockify`), /^HTTP\/1\.1 404/);
    // the viewer is torn down and the agent has the machine back
    assert.equal((await kiln.exec(vc.id, "echo back")).stdout, "back\n");
    const vnc = spawnSync("pgrep", ["-f", `x11vnc -display ${(JSON.parse(readFileSync(join(dir, "vcomputers", vc.id, "computer.json"), "utf8"))).runtime.display} `]);
    assert.notEqual(vnc.status, 0, "x11vnc stopped after hand-back");
  });

  it("agent can withdraw a hand-off", async () => {
    await kiln.handoff(vc.id, { reason: "Solve the captcha" });
    const c = await kiln.cancelHandoff(vc.id);
    assert.equal(c.handoff.state, "cancelled");
    assert.equal((await kiln.getComputer(vc.id)).control, "agent");
    assert.equal(await status(kiln.cancelHandoff(vc.id)), 409);
  });

  it("the home persists across stop/start", async () => {
    await kiln.exec(vc.id, "mkdir -p ~/.config/kiln-chrome && echo cookie > ~/.config/kiln-chrome/Cookies-marker");
    const stopped = await kiln.stopComputer(vc.id);
    assert.equal(stopped.status, "stopped");
    assert.equal(await status(kiln.exec(vc.id, "true")), 409, "stopped machines refuse work");
    const started = await kiln.startComputer(vc.id);
    assert.equal(started.status, "running");
    assert.equal((await kiln.exec(vc.id, "cat ~/.config/kiln-chrome/Cookies-marker")).stdout, "cookie\n");
  });

  it("idle computers are stopped by the daemon sweep", async () => {
    const idle = await kiln.createComputer({ name: "idle-1", backend: "local", browser: false, width: 640, height: 480, idleTimeoutSec: 1 });
    let v;
    for (let i = 0; i < 60; i++) { v = await kiln.getComputer(idle.id); if (v.status === "stopped") break; await sleep(250); }
    assert.equal(v.status, "stopped");
    assert.equal(v.stoppedReason, "idle");
    assert.equal(v.desired, "running", "an idle stop is not an operator stop");
  });

  it("doctor reports backends and computers", async () => {
    const d = await kiln.doctor();
    assert.equal(d.backends.local.ok, true);
    assert.equal(typeof d.backends.docker.ok, "boolean");
    assert.ok(d.computers.some((c) => c.id === vc.id && c.status === "running"));
    assert.equal(d.ok, true, JSON.stringify(d.problems));
  });

  it("delete with purge removes the machine and its home", async () => {
    const tmp = await kiln.createComputer({ name: "scratch", backend: "local", browser: false, width: 640, height: 480 });
    await kiln.deleteComputer(tmp.id, { purge: true });
    assert.equal(await status(kiln.getComputer(tmp.id)), 404);
    assert.ok(!existsSync(join(dir, "vcomputers", tmp.id)));
  });

  it("local backend is refused unless the daemon opts in", async () => {
    // A second daemon without KILN_VC_ALLOW_LOCAL.
    const d2 = makeStateDir();
    const p = spawn(process.execPath, [DAEMON], {
      env: { ...process.env, KILN_SWARM_DIR: d2, KILN_SWARM_API_PORT: "0", KILN_VC_ALLOW_LOCAL: "" },
      stdio: "ignore",
    });
    try {
      await waitForApi(d2);
      const k2 = await VComputerClient.connect({ dir: d2 });
      assert.equal(await status(k2.createComputer({ name: "nope", backend: "local" })), 503);
      const root = join(d2, "vcomputers");
      assert.ok(!existsSync(root) || readdirSync(root).every((f) => !f.startsWith("vc_")), "nothing was created");
    } finally { p.kill("SIGTERM"); }
  });
});
