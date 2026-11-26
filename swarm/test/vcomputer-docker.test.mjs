/**
 * KILN virtual computers, docker backend, against a REAL daemon and the
 * real kiln-vc image. Proves the container story: isolation (own user,
 * hostname, pid namespace), cgroup limits applied, the pinned toolchain
 * inside, Chrome on the desktop, the hand-off viewer through the daemon
 * proxy, and the home volume surviving stop/start.
 *
 * Skips (loudly) when docker isn't usable or the image isn't built
 * (swarm/vcomputer/image/build.sh). Set KILN_VC_IMAGE to test another tag.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { connect } from "node:net";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { VComputerClient } from "../lib/vcomputer-client.mjs";
import { DockerBackend } from "../lib/vcomputer-backends.mjs";
import { makeStateDir } from "./helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON = join(HERE, "..", "lib", "daemon.mjs");
const av = new DockerBackend().available();
const skip = av.ok ? false : `docker backend unavailable: ${av.reason}`;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitForApi(dir, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const p = join(dir, "daemon.json");
    if (existsSync(p)) { try { const dj = JSON.parse(readFileSync(p, "utf8")); if (dj.apiPort) return dj; } catch {} }
    await sleep(200);
  }
  throw new Error("timed out waiting for daemon api");
}
async function status(p) { try { await p; return 200; } catch (e) { return e.status; } }
function wsUpgrade(port, path) {
  return new Promise((resolve, reject) => {
    const s = connect(port, "127.0.0.1", () => s.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: binary\r\n\r\n`));
    s.setTimeout(10000, () => { s.destroy(); reject(new Error("ws timeout")); });
    s.once("data", (d) => { resolve(d.toString("latin1").split("\r\n")[0]); s.destroy(); });
    s.on("error", reject);
  });
}
const docker = (...a) => spawnSync(process.env.KILN_VC_DOCKER || "docker", a, { encoding: "utf8" });

describe("KILN virtual computers — docker backend (real image)", { skip }, () => {
  let dir, daemon, kiln, port, vc;

  after(async () => {
    try { if (vc) await kiln.deleteComputer(vc.id, { purge: true }); } catch {}
    if (daemon) daemon.kill("SIGTERM");
  });

  it("boots a daemon", async () => {
    dir = makeStateDir();
    daemon = spawn(process.execPath, [DAEMON], {
      env: { ...process.env, KILN_SWARM_DIR: dir, KILN_SWARM_API_PORT: "0" },
      stdio: "ignore",
    });
    port = (await waitForApi(dir)).apiPort;
    kiln = await VComputerClient.connect({ dir });
  });

  it("creates a container computer with limits applied", async () => {
    vc = await kiln.createComputer({ name: "dock-1", cpus: 1.5, memoryMB: 2048, pidsLimit: 1024, width: 1280, height: 800 });
    assert.equal(vc.backend, "docker");
    assert.equal(vc.isolation, "container");
    assert.equal(vc.status, "running");
    const hc = JSON.parse(docker("inspect", `kiln-vc-${vc.id}`).stdout)[0].HostConfig;
    assert.equal(hc.NanoCpus, 1.5e9);
    assert.equal(hc.Memory, 2048 * 1024 * 1024);
    assert.equal(hc.MemorySwap, 2048 * 1024 * 1024, "no swap beyond the memory cap");
    assert.equal(hc.PidsLimit, 1024);
    assert.deepEqual(hc.CapDrop, ["ALL"]);
    assert.ok(hc.SecurityOpt.includes("no-new-privileges"));
    const ports = Object.values(hc.PortBindings).flat();
    assert.ok(ports.every((p) => p.HostIp === "127.0.0.1"), "viewer port binds loopback only");
  });

  it("runs as an unprivileged user in its own namespaces", async () => {
    const r = await kiln.exec(vc.id, "id -un; hostname; echo $HOME; ps -e --no-headers | wc -l");
    const [user, host, home, procs] = r.stdout.trim().split("\n");
    assert.equal(user, "agent");
    assert.equal(host, "dock-1");
    assert.equal(home, "/home/agent");
    assert.ok(Number(procs) < 60, `own pid namespace (saw ${procs} processes)`);
  });

  it("ships the pinned toolchain", async () => {
    const t = await kiln._req("GET", `/v1/vcomputers/${vc.id}/toolcheck`);
    assert.equal(t.ok, true, t.output);
    for (const want of ["node       v24.22.3", "pnpm       10.34.6", "anchor-cli 0.30.1", "solana-cli 1.18.26", "rustc 1.79.0", "gh version 2.103.0", "Chrome for Testing 158.0.8127.88"]) {
      assert.ok(t.output.includes(want), `missing ${want} in:\n${t.output}`);
    }
  });

  it("Chrome is up on the desktop and the agent can drive it", async () => {
    let ok = false;
    for (let i = 0; i < 40 && !ok; i++) {
      ok = (await kiln.exec(vc.id, "pgrep -f /opt/chrome/chrome >/dev/null && echo up")).stdout.includes("up");
      if (!ok) await sleep(500);
    }
    assert.ok(ok, "chrome running");
    await sleep(2000);
    await kiln.key(vc.id, "ctrl+l");
    await kiln.type(vc.id, "data:text/html,<title>kiln-vc-docker</title>\n");
    let title = "";
    for (let i = 0; i < 20 && !title.includes("kiln-vc-docker"); i++) {
      await sleep(500);
      title = (await kiln.exec(vc.id, "xdotool search --name kiln-vc-docker getwindowname %@ 2>/dev/null")).stdout;
    }
    assert.match(title, /kiln-vc-docker/);
    const s = await kiln.screenshot(vc.id);
    assert.equal(s.png.readUInt32BE(16), 1280);
  });

  it("hand-off viewer is reachable through the daemon proxy and torn down after", async () => {
    const r = await kiln.handoff(vc.id, { reason: "Sign in to GitHub" });
    const token = r.url.split("/handoff/")[1];
    assert.equal((await fetch(r.url)).status, 200);
    assert.match(await wsUpgrade(port, `/handoff/${token}/websockify`), /^HTTP\/1\.1 101/);
    assert.equal(await status(kiln.exec(vc.id, "true")), 423);
    const back = await fetch(`${r.url}/return`, { method: "POST", body: JSON.stringify({ outcome: "done" }), headers: { "content-type": "application/json" } });
    assert.equal(back.status, 200);
    const vnc = await kiln.exec(vc.id, "pgrep x11vnc || echo none");
    assert.equal(vnc.stdout.trim(), "none");
    const pass = await kiln.exec(vc.id, "ls /tmp/kiln-vc/vnc.pass 2>&1 || true");
    assert.match(pass.stdout, /No such file/, "one-time VNC password file is gone");
  });

  it("the home volume (incl. the Chrome profile) survives stop/start", async () => {
    await kiln.exec(vc.id, "echo kept > ~/marker");
    assert.equal((await kiln.stopComputer(vc.id)).status, "stopped");
    assert.equal(await status(kiln.exec(vc.id, "true")), 409);
    assert.equal((await kiln.startComputer(vc.id)).status, "running");
    const r = await kiln.exec(vc.id, "cat ~/marker; test -d ~/.config/kiln-chrome/Default && echo profile");
    assert.equal(r.stdout, "kept\nprofile\n");
  });

  it("purge removes the container and its volume", async () => {
    await kiln.deleteComputer(vc.id, { purge: true });
    assert.notEqual(docker("inspect", `kiln-vc-${vc.id}`).status, 0);
    assert.notEqual(docker("volume", "inspect", `kiln-vc-${vc.id}-home`).status, 0);
    vc = null;
  });
});
