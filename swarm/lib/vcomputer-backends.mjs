/**
 * Backends for KILN virtual computers. A backend owns one machine's
 * lifecycle and runs argv inside it; everything above (control API,
 * hand-off, jobs, idle shutdown) is backend-agnostic and lives in
 * vcomputer.mjs.
 *
 *   docker  — the real thing: one container per computer from the
 *             kiln-vc image (swarm/vcomputer/image), its own pid/net/mount
 *             namespaces, cgroup CPU/memory/pids limits, a named volume
 *             for /home/agent (survives stop/start/upgrade). `isolation:
 *             "container"`. Works with podman via KILN_VC_DOCKER=podman.
 *   local   — the same desktop scripts run as host processes under the
 *             daemon's user with a per-computer HOME. NO isolation
 *             (`isolation: "none"`): for development and tests on a box
 *             without a container runtime. Refused unless the daemon runs
 *             with KILN_VC_ALLOW_LOCAL=1.
 *
 * Both backends run the SAME scripts (swarm/vcomputer/image/bin/kiln-vc-*),
 * so the desktop a test drives locally is the desktop the image ships.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync, unlinkSync,
  openSync, closeSync,
} from "node:fs";
import { createServer } from "node:net";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const VC_BIN_DIR = join(HERE, "..", "vcomputer", "image", "bin");
export const VC_IMAGE_DIR = join(HERE, "..", "vcomputer", "image");

export class VcError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MAX_OUTPUT = 1024 * 1024;

/**
 * Run argv; never through a shell on the host. New process group so a
 * timeout kills the whole tree (SIGTERM, then SIGKILL 2s later).
 * Resolves {code, signal, stdout, stderr, timedOut, truncated, durationMs}.
 */
export function runArgv(argv, { timeoutMs = 60000, input, env, cwd, maxBytes = MAX_OUTPUT, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) { reject(e); return; }
    const out = []; const err = [];
    let outLen = 0, errLen = 0, truncated = false, timedOut = false;
    child.stdout.on("data", (d) => {
      if (outLen < maxBytes) { out.push(d.subarray(0, maxBytes - outLen)); }
      if (outLen + d.length > maxBytes) truncated = true;
      outLen += d.length;
    });
    child.stderr.on("data", (d) => {
      if (errLen < maxBytes) { err.push(d.subarray(0, maxBytes - errLen)); }
      if (errLen + d.length > maxBytes) truncated = true;
      errLen += d.length;
    });
    const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} } };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 2000).unref();
    }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const so = Buffer.concat(out); const se = Buffer.concat(err);
      resolve({
        code, signal, timedOut, truncated,
        stdout: binary ? so : so.toString("utf8"),
        stderr: se.toString("utf8"),
        durationMs: Date.now() - t0,
      });
    });
    child.stdin.on("error", () => {});
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

function which(bin) {
  const r = spawnSync("sh", ["-c", `command -v -- "$1"`, "sh", bin], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** A free 127.0.0.1 TCP port (bind :0, read it, close). */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** The shell-exec wrapper: coreutils `timeout` kills the command's group. */
export function shellArgv(command, timeoutMs) {
  const secs = Math.max(1, Math.ceil(timeoutMs / 1000));
  return ["timeout", "-k", "2", String(secs), "bash", "-lc", command];
}

/** Background job wrapper (runs inside the machine, own session). */
export const JOB_WRAPPER = [
  'd="$HOME/.kiln/jobs/$KILN_JOB_ID"; mkdir -p "$d"; chmod 700 "$HOME/.kiln" "$d" 2>/dev/null',
  'echo $$ > "$d/pid"; date +%s > "$d/started"',
  'cd "${KILN_JOB_CWD:-$HOME}" 2>/dev/null || cd "$HOME"',
  'bash -lc "$KILN_JOB_CMD" > "$d/out.log" 2>&1 < /dev/null',
  'echo $? > "$d/exit"',
].join("\n");

export const JOB_STATUS_SCRIPT = [
  'd="$HOME/.kiln/jobs/$1"; [ -d "$d" ] || { echo missing; exit 0; }',
  'pid=$(cat "$d/pid" 2>/dev/null); ex=$(cat "$d/exit" 2>/dev/null)',
  'if [ -n "$ex" ]; then echo "exited $ex"; elif [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then echo "running $pid"; else echo lost; fi',
].join("\n");

export const JOB_KILL_SCRIPT = [
  'd="$HOME/.kiln/jobs/$1"; pid=$(cat "$d/pid" 2>/dev/null) || exit 3',
  'kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null',
  'for _ in 1 2 3 4 5 6; do kill -0 "$pid" 2>/dev/null || exit 0; sleep 0.5; done',
  'kill -KILL -- "-$pid" 2>/dev/null; exit 0',
].join("\n");

// ---------------------------------------------------------------- local

const LOCAL_TOOLS = ["Xvfb", "xfwm4", "xdotool", "ffmpeg", "x11vnc", "websockify", "setsid", "timeout", "bash"];

export class LocalBackend {
  constructor({ allow = process.env.KILN_VC_ALLOW_LOCAL === "1", chrome } = {}) {
    this.name = "local";
    this.isolation = "none";
    this.allow = allow;
    this.chrome = chrome || process.env.KILN_VC_LOCAL_CHROME || which("google-chrome") || which("chromium") || which("chromium-browser") || "chrome";
  }

  available() {
    const missing = LOCAL_TOOLS.filter((t) => !which(t));
    if (!this.allow) {
      return { ok: false, missing, reason: "local backend is disabled — it runs machines as host processes with no isolation; set KILN_VC_ALLOW_LOCAL=1 on the daemon to allow it (dev/test only)" };
    }
    return missing.length
      ? { ok: false, missing, reason: `missing host tools: ${missing.join(", ")}` }
      : { ok: true, missing: [] };
  }

  paths(vc) {
    return { home: join(vc.baseDir, "home"), run: join(vc.baseDir, "run") };
  }

  env(vc, extra = {}) {
    const { home } = this.paths(vc);
    return {
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
      HOME: home,
      USER: process.env.USER || "agent",
      LANG: process.env.LANG || "C.UTF-8",
      TERM: "xterm-256color",
      DISPLAY: vc.runtime?.display || ":0",
      ...extra,
    };
  }

  pickDisplay(taken) {
    for (let n = 100; n < 400; n++) {
      if (taken.has(`:${n}`)) continue;
      if (existsSync(`/tmp/.X11-unix/X${n}`) || existsSync(`/tmp/.X${n}-lock`)) continue;
      return `:${n}`;
    }
    throw new VcError(503, "no free X display number in :100..:399");
  }

  sessionAlive(vc) {
    const pid = vc.runtime?.sessionPid;
    if (!pid) return false;
    try { process.kill(pid, 0); } catch { return false; }
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("kiln-vc-session");
    } catch { return false; }
  }

  async status(vc) { return this.sessionAlive(vc) ? "running" : "stopped"; }

  async start(vc, { takenDisplays = new Set() } = {}) {
    const av = this.available();
    if (!av.ok) throw new VcError(503, av.reason);
    const { home, run } = this.paths(vc);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(run, { recursive: true, mode: 0o700 });
    if (this.sessionAlive(vc)) return { ...vc.runtime };
    const display = this.pickDisplay(takenDisplays);
    try { unlinkSync(join(run, "session.state")); } catch {}
    const env = this.env({ ...vc, runtime: { display } }, {
      KILN_VC_DISPLAY: display,
      KILN_VC_WIDTH: String(vc.config.width),
      KILN_VC_HEIGHT: String(vc.config.height),
      KILN_VC_BROWSER: vc.config.browser ? "1" : "0",
      KILN_VC_RUNDIR: run,
      KILN_VC_CHROME: this.chrome,
      KILN_VC_CHROME_FLAGS: process.env.KILN_VC_LOCAL_CHROME_FLAGS || "",
    });
    const logFd = openSync(join(run, "session.log"), "a", 0o600);
    const child = spawn("bash", [join(VC_BIN_DIR, "kiln-vc-session")], {
      env, cwd: home, detached: true, stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    closeSync(logFd);
    const runtime = { display, sessionPid: child.pid };
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      if (existsSync(join(run, "session.state"))) return runtime;
      try { process.kill(child.pid, 0); } catch {
        throw new VcError(500, `desktop session exited at start — see ${join(run, "session.log")}`);
      }
      await sleep(100);
    }
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
    throw new VcError(504, "desktop session did not become ready in 20s");
  }

  async stop(vc) {
    await this.vncStop(vc).catch(() => {});
    const pid = vc.runtime?.sessionPid;
    if (!pid || !this.sessionAlive(vc)) return;
    try { process.kill(-pid, "SIGTERM"); } catch {}
    for (let i = 0; i < 50; i++) {
      if (!this.sessionAlive(vc)) return;
      await sleep(100);
    }
    try { process.kill(-pid, "SIGKILL"); } catch {}
  }

  async exec(vc, argv, opts = {}) {
    const { home } = this.paths(vc);
    return runArgv(argv, { ...opts, env: this.env(vc, opts.env || {}), cwd: opts.cwd || home });
  }

  async spawnDetached(vc, argv, extraEnv = {}) {
    const { home } = this.paths(vc);
    const child = spawn(argv[0], argv.slice(1), {
      env: this.env(vc, extraEnv), cwd: home, detached: true, stdio: "ignore",
    });
    child.unref();
  }

  async vncStart(vc, password) {
    const { run } = this.paths(vc);
    const passfile = join(run, "vnc.pass");
    writeFileSync(passfile, password + "\n", { mode: 0o600 });
    chmodSync(passfile, 0o600);
    const vncPort = await freePort();
    const wsPort = await freePort();
    const r = await this.exec(vc, ["bash", join(VC_BIN_DIR, "kiln-vc-vnc"), "start"], {
      timeoutMs: 20000,
      env: {
        KILN_VC_DISPLAY: vc.runtime.display, KILN_VC_RUNDIR: run,
        KILN_VC_VNC_PORT: String(vncPort), KILN_VC_WS_PORT: String(wsPort),
        KILN_VC_WS_LISTEN: "127.0.0.1", KILN_VC_VNC_PASSFILE: passfile,
      },
    });
    try { unlinkSync(passfile); } catch {}
    if (r.code !== 0) throw new VcError(500, `could not start the hand-off viewer: ${r.stderr.trim().slice(0, 300)}`);
    return { wsHost: "127.0.0.1", wsPort };
  }

  async vncStop(vc) {
    const { run } = this.paths(vc);
    if (!existsSync(run)) return;
    await this.exec(vc, ["bash", join(VC_BIN_DIR, "kiln-vc-vnc"), "stop"], {
      timeoutMs: 10000, env: { KILN_VC_RUNDIR: run },
    });
  }

  async diskUsageBytes(vc) {
    const { home } = this.paths(vc);
    if (!existsSync(home)) return 0;
    const r = await runArgv(["du", "-sb", home], { timeoutMs: 60000 });
    return parseInt(r.stdout, 10) || 0;
  }

  async destroy(vc, { purge = false } = {}) {
    await this.stop(vc);
    if (purge) rmSync(vc.baseDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- docker

export class DockerBackend {
  constructor({ bin = process.env.KILN_VC_DOCKER || "docker", image = process.env.KILN_VC_IMAGE || null } = {}) {
    this.name = "docker";
    this.isolation = "container";
    this.bin = bin;
    this.image = image || `kiln-vc:${imageVersion()}`;
  }

  ctr(vc) { return `kiln-vc-${vc.id}`; }
  vol(vc) { return `kiln-vc-${vc.id}-home`; }

  docker(args, opts = {}) { return runArgv([this.bin, ...args], { timeoutMs: 120000, ...opts }); }

  available() {
    if (!which(this.bin)) return { ok: false, missing: [this.bin], reason: `${this.bin} is not installed on this host` };
    const r = spawnSync(this.bin, ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8", timeout: 10000 });
    if (r.status !== 0) return { ok: false, missing: [], reason: `${this.bin} daemon unreachable: ${(r.stderr || "").trim().slice(0, 200)}` };
    const img = spawnSync(this.bin, ["image", "inspect", "--format", "{{.Id}}", this.image], { encoding: "utf8", timeout: 10000 });
    if (img.status !== 0) {
      return { ok: false, missing: [this.image], reason: `image ${this.image} is not built — run swarm/vcomputer/image/build.sh` };
    }
    return { ok: true, missing: [], server: r.stdout.trim(), imageId: img.stdout.trim() };
  }

  async inspectState(vc) {
    const r = await this.docker(["inspect", "--format", "{{.State.Status}}", this.ctr(vc)], { timeoutMs: 15000 });
    if (r.code !== 0) return "absent";
    return r.stdout.trim(); // created|running|exited|paused|restarting|dead
  }

  async status(vc) {
    const s = await this.inspectState(vc);
    return s === "running" ? "running" : "stopped";
  }

  async start(vc) {
    const av = this.available();
    if (!av.ok) throw new VcError(503, av.reason);
    const state = await this.inspectState(vc);
    if (state === "absent") {
      const c = vc.config;
      const args = [
        "run", "-d", "--name", this.ctr(vc),
        "--label", `kiln.vc.id=${vc.id}`, "--label", `kiln.vc.name=${vc.name}`,
        "--hostname", vc.name.slice(0, 63),
        "--cpus", String(c.cpus), "--memory", `${c.memoryMB}m`, "--memory-swap", `${c.memoryMB}m`,
        "--pids-limit", String(c.pidsLimit), "--shm-size", "512m",
        "--security-opt", "no-new-privileges", "--cap-drop", "ALL",
        "--restart", "on-failure:5",
        "-e", `KILN_VC_WIDTH=${c.width}`, "-e", `KILN_VC_HEIGHT=${c.height}`,
        "-e", `KILN_VC_BROWSER=${c.browser ? 1 : 0}`,
        "-v", `${this.vol(vc)}:/home/agent`,
      ];
      if (c.network) args.push("-p", "127.0.0.1::6080");
      else args.push("--network", "none");
      args.push(this.image);
      const r = await this.docker(args);
      if (r.code !== 0) throw new VcError(500, `docker run failed: ${r.stderr.trim().slice(0, 400)}`);
    } else if (state !== "running") {
      const r = await this.docker(["start", this.ctr(vc)]);
      if (r.code !== 0) throw new VcError(500, `docker start failed: ${r.stderr.trim().slice(0, 400)}`);
    }
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      const r = await this.exec({ ...vc, runtime: { display: ":0" } }, ["cat", "/tmp/kiln-vc/session.state"], { timeoutMs: 5000 });
      if (r.code === 0 && r.stdout.trim() === "ready") return { display: ":0", container: this.ctr(vc), volume: this.vol(vc) };
      if ((await this.inspectState(vc)) !== "running") {
        const logs = await this.docker(["logs", "--tail", "20", this.ctr(vc)]);
        throw new VcError(500, `container exited at start: ${(logs.stderr || logs.stdout).trim().slice(-400)}`);
      }
      await sleep(250);
    }
    throw new VcError(504, "desktop session did not become ready in 30s");
  }

  async stop(vc) {
    if ((await this.inspectState(vc)) === "absent") return;
    await this.docker(["stop", "-t", "10", this.ctr(vc)]);
  }

  envArgs(env) {
    const out = [];
    for (const [k, v] of Object.entries(env || {})) out.push("-e", `${k}=${v}`);
    return out;
  }

  async exec(vc, argv, opts = {}) {
    const args = ["exec", "-i", "-u", "agent", "-w", opts.cwd || "/home/agent",
      "-e", `DISPLAY=${vc.runtime?.display || ":0"}`, ...this.envArgs(opts.env), this.ctr(vc), ...argv];
    return runArgv([this.bin, ...args], { ...opts, cwd: undefined, env: process.env });
  }

  async spawnDetached(vc, argv, extraEnv = {}) {
    const r = await this.docker(["exec", "-d", "-u", "agent", "-w", "/home/agent",
      "-e", "DISPLAY=:0", ...this.envArgs(extraEnv), this.ctr(vc), ...argv], { timeoutMs: 20000 });
    if (r.code !== 0) throw new VcError(500, `docker exec -d failed: ${r.stderr.trim().slice(0, 300)}`);
  }

  async vncStart(vc, password) {
    if (!vc.config.network) throw new VcError(409, "this computer was created with network:false, so there is no port for the hand-off viewer");
    const w = await this.exec(vc, ["sh", "-c", "umask 077; mkdir -p /tmp/kiln-vc; cat > /tmp/kiln-vc/vnc.pass"], { input: password + "\n", timeoutMs: 10000 });
    if (w.code !== 0) throw new VcError(500, "could not stage the hand-off viewer password");
    const r = await this.exec(vc, ["kiln-vc-vnc", "start"], {
      timeoutMs: 20000, env: { KILN_VC_VNC_PASSFILE: "/tmp/kiln-vc/vnc.pass", KILN_VC_WS_LISTEN: "0.0.0.0" },
    });
    if (r.code !== 0) throw new VcError(500, `could not start the hand-off viewer: ${r.stderr.trim().slice(0, 300)}`);
    const p = await this.docker(["port", this.ctr(vc), "6080/tcp"], { timeoutMs: 10000 });
    const m = /127\.0\.0\.1:(\d+)/.exec(p.stdout);
    if (!m) throw new VcError(500, `hand-off viewer port is not published: ${p.stdout.trim()}`);
    return { wsHost: "127.0.0.1", wsPort: parseInt(m[1], 10) };
  }

  async vncStop(vc) {
    if ((await this.inspectState(vc)) !== "running") return;
    await this.exec(vc, ["kiln-vc-vnc", "stop"], { timeoutMs: 10000 });
  }

  async diskUsageBytes(vc) {
    if ((await this.inspectState(vc)) !== "running") return vc.usage?.diskBytes ?? 0;
    const r = await this.exec(vc, ["du", "-sb", "/home/agent"], { timeoutMs: 60000 });
    return parseInt(r.stdout, 10) || 0;
  }

  async destroy(vc, { purge = false } = {}) {
    await this.docker(["rm", "-f", this.ctr(vc)]);
    if (purge) await this.docker(["volume", "rm", "-f", this.vol(vc)]);
  }
}

export function imageVersion() {
  try {
    const txt = readFileSync(join(VC_IMAGE_DIR, "versions.env"), "utf8");
    const m = /^KILN_VC_IMAGE_VERSION=(.+)$/m.exec(txt);
    return m ? m[1].trim() : "dev";
  } catch { return "dev"; }
}

export function makeBackends(opts = {}) {
  return {
    local: new LocalBackend(opts.local || {}),
    docker: new DockerBackend(opts.docker || {}),
  };
}
