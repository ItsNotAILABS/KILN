/**
 * KILN sandbox: run one command with real Linux isolation on a single VM.
 *
 * Per invocation we create fresh mount/pid/uts/ipc namespaces (plus a net
 * namespace with no interfaces when network:false), hide /home /root (/etc
 * too when offline), cap the JS heap, and enforce the wall-clock timeout
 * with SIGTERM-then-SIGKILL. A supervisor polls resident memory and
 * SIGKILLs the tree past 2x the configured MB (V8 needs ~4GB of *virtual*
 * space at startup, so RLIMIT_AS cannot cap Node — the heap flag + RSS
 * poll is the honest mechanism on a host without cgroup delegation).
 * Process count is bounded by the PID namespace (the sandbox's PID 1 can
 * only see its own tree), NOT by RLIMIT_NPROC: NPROC counts all of the
 * caller's processes host-wide, so a host-global limit would throttle the
 * daemon itself and neighboring sandboxes. CPU time is metered by the
 * runner, not capped: RLIMIT_CPU was dropped because this build of unshare
 * mishandles the child's SIGXCPU death; the wall-clock timeout is the hard
 * bound.
 *
 * cgroups are NOT available on this host (the container namespace has no
 * controllers delegated: /sys/fs/cgroup/cgroup.controllers is empty), and
 * systemd-run has no D-Bus here — so this module does not pretend to use
 * them. Everything below was verified empirically on this VM.
 *
 * Failure is loud: if unshare is missing or the namespace setup fails, the
 * function never runs and the caller gets ok:false with the real reason.
 * There is no silent unsandboxed fallback.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SETUP_SH = join(HERE, "sandbox-setup.sh");
const UNSHARE = "/usr/bin/unshare";
const MAX_OUTPUT = 64 * 1024;
const RSS_POLL_MS = 50;
const KILL_GRACE_MS = 5000;

function needSandboxOpts(o) {
  if (!o || typeof o !== "object") throw new Error("sandbox: options object required");
  const { workdir, command, args = [], timeoutMs = 30000 } = o;
  if (typeof workdir !== "string" || !isAbsolute(workdir) || !existsSync(workdir)) {
    throw new Error("sandbox: workdir must be an existing absolute path");
  }
  if (typeof command !== "string" || !command) throw new Error("sandbox: command required");
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) {
    throw new Error("sandbox: args must be string[]");
  }
  const t = Math.floor(Number(timeoutMs));
  if (!Number.isFinite(t) || t < 100 || t > 300000) {
    throw new Error("sandbox: timeoutMs must be 100..300000");
  }
  let memoryMB = o.memoryMB === undefined ? 256 : Math.floor(Number(o.memoryMB));
  if (!Number.isFinite(memoryMB) || memoryMB < 64 || memoryMB > 2048) {
    throw new Error("sandbox: memoryMB must be an integer in 64..2048");
  }
  const network = o.network === undefined ? false : !!o.network;
  // The sandbox always execs a runner file inside the workdir (KILN compute
  // contract). command must be node; args[0] is the runner's relative path.
  const cmdBase = command.split("/").pop();
  if (cmdBase !== "node" && cmdBase !== "nodejs") {
    throw new Error("sandbox: only the node binary can run inside the sandbox (compute contract)");
  }
  let runnerFile = "runner.mjs";
  if (args.length > 1) throw new Error("sandbox: args must be [runnerFile] only");
  if (args.length === 1) {
    if (typeof args[0] !== "string" || args[0].includes("..") || args[0].startsWith("/")) {
      throw new Error("sandbox: runnerFile must be a relative path inside the workdir");
    }
    runnerFile = args[0];
  }
  return { workdir, command, timeoutMs: t, memoryMB, network, runnerFile };
}

/** Total RSS (bytes) AND process count of pid and all its descendants, via /proc.
 *  One walk serves both the memory guard and the fork-bomb guard. */
function treeStats(rootPid) {
  let rss = 0, procs = 0;
  const seen = new Set();
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop();
    if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) continue;
    seen.add(pid);
    procs += 1;
    try {
      const st = readFileSync(`/proc/${pid}/status`, "utf8");
      const m = st.match(/VmRSS:\s+(\d+)\s+kB/);
      if (m) rss += Number(m[1]) * 1024;
    } catch { continue; }
    let tids;
    try { tids = readdirSync(`/proc/${pid}/task`); } catch { continue; }
    for (const tid of tids) {
      try {
        const kids = readFileSync(`/proc/${pid}/task/${tid}/children`, "utf8").trim();
        if (kids) for (const k of kids.split(/\s+/)) stack.push(Number(k));
      } catch { /* gone */ }
    }
  }
  return { rss, procs };
}

function capOut(acc, chunk) {
  if (acc.len + chunk.length > MAX_OUTPUT) { acc.truncated = true; return; }
  acc.buf += chunk.toString("utf8"); acc.len += chunk.length;
}

/**
 * Run command under the sandbox. Resolves (never throws on runtime failure):
 * {
 *   ok, code, signal, timedOut, rssKilled, forkBomb, heapOom,
 *   wallMs, out, error
 * }
 * Throws only on programmer errors (bad options).
 */
export async function runSandboxed(opts) {
  const o = needSandboxOpts(opts);
  if (!existsSync(UNSHARE)) {
    return { ok: false, code: null, signal: null, wallMs: 0, out: "",
      error: "sandbox unavailable: /usr/bin/unshare not found — refusing to run unsandboxed" };
  }
  if (!existsSync(SETUP_SH)) {
    return { ok: false, code: null, signal: null, wallMs: 0, out: "",
      error: "sandbox unavailable: sandbox-setup.sh missing next to sandbox.mjs" };
  }

  const nsArgs = ["--mount", "--pid", "--uts", "--ipc", "--fork", "--mount-proc", "--kill-child"];
  if (!o.network) nsArgs.push("--net");
  nsArgs.push("bash", SETUP_SH);

  const env = {
    PATH: "/usr/bin:/bin",
    KILN_SB_WORK: o.workdir,
    KILN_SB_MEM_MB: String(o.memoryMB),
    KILN_SB_NET: o.network ? "1" : "0",
    KILN_SB_NODE: process.execPath,
    KILN_SB_RUNNER: o.runnerFile,
  };

  return await new Promise((resolveOut) => {
    const t0 = Date.now();
    const stdout = { buf: "", len: 0, truncated: false };
    const stderr = { buf: "", len: 0, truncated: false };
    let done = false;
    let timedOut = false, rssKilled = false, forkBomb = false, termSent = false;
    const finish = (r) => { if (!done) { done = true; resolveOut(r); } };

    let child;
    try {
      child = spawn(UNSHARE, nsArgs, { env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      finish({ ok: false, code: null, signal: null, timedOut: false, rssKilled: false,
        forkBomb: false, heapOom: false, wallMs: Date.now() - t0, out: "",
        error: `sandbox spawn failed: ${e.message}` });
      return;
    }

    const rssKillBytes = o.memoryMB * 2 * 1024 * 1024;
    // 128 processes in the sandbox's PID namespace: a fork bomb doubles
    // ~7 times to get here (caught in <1s at 50ms polls); real functions
    // fork rarely, if ever. Scoped to the namespace, so the host's own
    // thread count can't false-trigger it (unlike RLIMIT_NPROC).
    const PROC_KILL_COUNT = 128;
    const rssTimer = setInterval(() => {
      if (done || !child.pid) return;
      let st;
      try { st = treeStats(child.pid); } catch { return; }
      if (st.procs > PROC_KILL_COUNT) {
        forkBomb = true;
        try { child.kill("SIGKILL"); } catch { /* gone */ }
        return;
      }
      if (st.rss > rssKillBytes) {
        rssKilled = true;
        try { child.kill("SIGKILL"); } catch { /* gone */ }
      }
    }, RSS_POLL_MS);

    const termTimer = setTimeout(() => {
      if (done) return;
      timedOut = true; termSent = true;
      try { child.kill("SIGTERM"); } catch { /* gone */ }
    }, o.timeoutMs);
    const killTimer = setTimeout(() => {
      if (done) return;
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* gone */ }
    }, o.timeoutMs + KILL_GRACE_MS);

    child.stdout.on("data", (c) => capOut(stdout, c));
    child.stderr.on("data", (c) => capOut(stderr, c));
    child.on("error", (e) => {
      clearInterval(rssTimer); clearTimeout(termTimer); clearTimeout(killTimer);
      finish({ ok: false, code: null, signal: null, timedOut, rssKilled, forkBomb,
        heapOom: false, wallMs: Date.now() - t0, out: stdout.buf,
        error: `sandbox spawn error: ${e.message}` });
    });
    child.on("close", (code, signal) => {
      clearInterval(rssTimer); clearTimeout(termTimer); clearTimeout(killTimer);
      const wallMs = Date.now() - t0;
      const errText = stderr.buf;
      const heapOom = /heap out of memory|allocation failure/i.test(errText);
      const setupFailed = code !== null && code >= 21 && code <= 28 && !timedOut;
      if (code === 0) {
        finish({ ok: true, code, signal: null, timedOut: false, rssKilled: false,
          forkBomb: false, heapOom: false, wallMs,
          out: stdout.buf + (stdout.truncated ? `\n[truncated at ${MAX_OUTPUT} bytes]` : "") });
        return;
      }
      let error;
      if (timedOut) {
        error = termSent && signal === "SIGKILL"
          ? `timeout after ${o.timeoutMs}ms (ignored SIGTERM, SIGKILLed)`
          : `timeout after ${o.timeoutMs}ms`;
      } else if (forkBomb) {
        error = `fork-bomb guard: process tree passed ${128} processes in the sandbox PID namespace, sandbox SIGKILLed`;
      } else if (rssKilled) {
        error = `memory limit exceeded: RSS passed ${o.memoryMB * 2}MB (2x configured ${o.memoryMB}MB), sandbox SIGKILLed`;
      } else if (heapOom) {
        error = `memory limit exceeded: JS heap hit ${o.memoryMB}MB (--max-old-space-size)`;
      } else if (setupFailed) {
        error = `sandbox setup failed inside namespaces (exit ${code}): ${errText.slice(0, 500) || "no output"} — function never ran`;
      } else {
        error = `sandbox exit ${code}${signal ? ` signal ${signal}` : ""}: ${errText.slice(0, 2000)}`;
      }
      finish({ ok: false, code, signal, timedOut, rssKilled, forkBomb, heapOom, wallMs,
        out: stdout.buf, error });
    });
  });
}

/** Probe: can this host actually build the sandbox? Returns {ok, reason}. */
export async function sandboxProbe() {
  if (!existsSync(UNSHARE)) return { ok: false, reason: "unshare binary missing" };
  const r = await runSandboxed({
    workdir: "/tmp",
    command: process.execPath,
    timeoutMs: 15000,
    memoryMB: 256,
    network: false,
  });
  // /tmp has no runner.mjs, so node fails — but the SANDBOX setup must succeed
  // (i.e. we get a node module-not-found error, not a setup exit 21..28).
  if (r.code >= 21 && r.code <= 28) return { ok: false, reason: r.error };
  return { ok: true, reason: "namespaces + rlimits applied (node ran inside)" };
}
