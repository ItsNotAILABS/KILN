/**
 * Tools: everything a worker can actually do. All real — no mocks.
 * Every tool runs jailed to the node's work dir; every call is
 * grant-checked BEFORE execution and receipted AFTER.
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join, resolve, sep, basename } from "node:path";
import {
  CAP_COMMIT, CAP_PROPOSE, CAP_DELEGATE, checkGrant, delegateGrant, nowSec, GrantError,
} from "./grant.mjs";
import { appendReceipt } from "./receipts.mjs";
import { appendEvent, newJobId } from "./queue.mjs";
import { createNode } from "./nodes.mjs";

export class ToolError extends Error {
  constructor(message) {
    super(message);
    this.code = "TOOL_FAILED";
  }
}

// ---------------------------------------------------------------- jail

/** Resolve p inside workdir; throw if it escapes. */
export function jailPath(workdir, p) {
  const base = resolve(workdir);
  const target = resolve(base, p || ".");
  if (target !== base && !target.startsWith(base + sep)) {
    throw new ToolError(`jail: path escapes work dir: ${p}`);
  }
  return target;
}

const SHELL_BINS = new Set(["sh", "bash", "zsh", "dash", "fish", "csh", "tcsh", "powershell", "pwsh", "cmd", "cmd.exe"]);
const DENY_PATTERNS = [
  "..", "/etc/", "/proc/", "/sys/", "/dev/", "/root/", "~", "$(", "${", "`",
  "&&", "||", ";", "|", ">", "<", "\n", "\r", "\0",
];

function checkShellArgs(command, args) {
  const bin = basename(String(command)).toLowerCase();
  if (SHELL_BINS.has(bin)) {
    throw new ToolError(`jail: shell binaries are not executable tools (got "${command}")`);
  }
  const joined = [command, ...(args || [])].join(" ");
  for (const pat of DENY_PATTERNS) {
    if (joined.includes(pat)) throw new ToolError(`jail: denied pattern ${JSON.stringify(pat)} in command`);
  }
  if (String(command).includes("/")) {
    // A path command must stay inside the work dir.
    return "path-command";
  }
  return "bin";
}

const MAX_OUTPUT = 64 * 1024;

function runCmd(command, args, { cwd, timeoutMs }) {
  return new Promise((resolveOut) => {
    let stdout = "", stderr = "", truncated = false, done = false;
    let child;
    try {
      child = spawn(command, args, { cwd, timeout: timeoutMs, shell: false });
    } catch (e) {
      resolveOut({ ok: false, error: `spawn failed: ${e.message}` });
      return;
    }
    const onData = (acc) => (chunk) => {
      if (acc.len + chunk.length > MAX_OUTPUT) { truncated = true; return; }
      acc.buf += chunk.toString("utf8"); acc.len += chunk.length;
    };
    const out = { buf: "", len: 0 }, err = { buf: "", len: 0 };
    child.stdout.on("data", onData(out));
    child.stderr.on("data", onData(err));
    child.on("error", (e) => {
      if (!done) { done = true; resolveOut({ ok: false, error: `exec error: ${e.message}` }); }
    });
    child.on("close", (code, signal) => {
      if (done) return;
      done = true;
      const timedOut = signal === "SIGTERM" && child.killed;
      if (timedOut) return resolveOut({ ok: false, error: `timeout after ${timeoutMs}ms` });
      resolveOut({
        ok: code === 0,
        out: out.buf + (truncated ? `\n[truncated at ${MAX_OUTPUT} bytes]` : ""),
        error: code === 0 ? null : `exit ${code}${signal ? ` signal ${signal}` : ""}: ${err.buf.slice(0, 2000)}`,
        code,
      });
    });
  });
}

// ---------------------------------------------------------------- defs

export const TOOL_DEFS = [
  { name: "fs.read", caps: 0, desc: "Read a file inside the work dir", args: { path: "string" } },
  { name: "fs.write", caps: 0, desc: "Write a file inside the work dir (creates parents)", args: { path: "string", content: "string" } },
  { name: "fs.list", caps: 0, desc: "List a directory inside the work dir", args: { path: "string?" } },
  { name: "shell.exec", caps: 0, desc: "Run a binary with argv, no shell, jailed cwd, timeout", args: { command: "string", args: "string[]?", timeoutMs: "number?" } },
  { name: "git.status", caps: 0, desc: "git status --porcelain in the work dir", args: {} },
  { name: "git.log", caps: 0, desc: "git log --oneline in the work dir", args: { n: "number?" } },
  { name: "git.commit", caps: CAP_COMMIT, desc: "git add -A && git commit (needs CAP_COMMIT)", args: { message: "string" } },
  { name: "swarm.spawn", caps: CAP_DELEGATE, desc: "Spawn a child node with subset caps (needs CAP_DELEGATE)", args: { name: "string", capabilities: "number", ttlSec: "number", repo: "string?", mind: "string?" } },
  { name: "swarm.submit", caps: CAP_PROPOSE, desc: "Submit a job plan to the queue (needs CAP_PROPOSE)", args: { plan: "object", name: "string?", mind: "string?" } },
];

function findDef(name) {
  const d = TOOL_DEFS.find((t) => t.name === name);
  if (!d) throw new ToolError(`unknown tool: ${name}`);
  return d;
}

// ---------------------------------------------------------------- impl

async function impl(ctx, name, args) {
  const { workdir } = ctx;
  switch (name) {
    case "fs.read": {
      const p = jailPath(workdir, needStr(args, "path"));
      return { ok: true, out: readFileSync(p, "utf8") };
    }
    case "fs.write": {
      const p = jailPath(workdir, needStr(args, "path"));
      const content = needStr(args, "content");
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, content);
      return { ok: true, out: `wrote ${content.length} bytes to ${p}` };
    }
    case "fs.list": {
      const p = jailPath(workdir, args.path || ".");
      const st = statSync(p);
      if (!st.isDirectory()) throw new ToolError(`fs.list: not a directory: ${args.path}`);
      return { ok: true, out: readdirSync(p).join("\n") };
    }
    case "shell.exec": {
      const command = needStr(args, "command");
      const cmdArgs = args.args === undefined ? [] : needArr(args, "args");
      const timeoutMs = args.timeoutMs === undefined ? 30000 : needNum(args, "timeoutMs");
      if (!(timeoutMs >= 100 && timeoutMs <= 300000)) throw new ToolError("shell.exec: timeoutMs out of range 100..300000");
      const kind = checkShellArgs(command, cmdArgs);
      let bin = command;
      if (kind === "path-command") bin = jailPath(workdir, command);
      return await runCmd(bin, cmdArgs.map(String), { cwd: workdir, timeoutMs });
    }
    case "git.status": {
      return await runCmd("git", ["status", "--porcelain=v1"], { cwd: workdir, timeoutMs: 15000 });
    }
    case "git.log": {
      const n = args.n === undefined ? 10 : needNum(args, "n");
      return await runCmd("git", ["log", "--oneline", "-n", String(Math.min(Math.max(n, 1), 100))], { cwd: workdir, timeoutMs: 15000 });
    }
    case "git.commit": {
      const message = needStr(args, "message");
      if (!message.trim()) throw new ToolError("git.commit: empty message");
      const add = await runCmd("git", ["add", "-A"], { cwd: workdir, timeoutMs: 30000 });
      if (!add.ok) return add;
      return await runCmd("git", ["commit", "-m", message], { cwd: workdir, timeoutMs: 30000 });
    }
    case "swarm.spawn": {
      const childCaps = needNum(args, "capabilities");
      const ttlSec = needNum(args, "ttlSec");
      if (!(ttlSec > 0 && ttlSec <= 10 * 365 * 24 * 3600)) throw new ToolError("swarm.spawn: ttlSec out of range");
      const childGrant = delegateGrant(ctx.grant, ctx.nodeId, childCaps, nowSec() + Math.floor(ttlSec));
      const child = createNode(ctx.dir, {
        name: needStr(args, "name"),
        caps: childGrant.capabilities,
        expiresAt: childGrant.expiresAt,
        parent: childGrant.parent,
        repo: args.repo || ctx.node.repo || null,
        mind: args.mind || "script",
      });
      return { ok: true, out: `spawned child node ${child.name} (${child.id.slice(0, 12)}…) caps=${childGrant.capabilities} parent=${ctx.nodeId.slice(0, 12)}…` };
    }
    case "swarm.submit": {
      const plan = args.plan;
      if (!plan || typeof plan !== "object" || !Array.isArray(plan.steps)) {
        throw new ToolError("swarm.submit: plan.steps[] is required");
      }
      const job = {
        id: newJobId(),
        name: args.name || `job-from-${ctx.nodeId.slice(0, 8)}`,
        plan,
        mind: args.mind || "script",
        submittedBy: ctx.nodeId,
      };
      appendEvent(ctx.dir, "submit", { job });
      return { ok: true, out: `submitted ${job.id}` };
    }
    default:
      throw new ToolError(`unknown tool: ${name}`);
  }
}

function needStr(args, k) {
  if (typeof args?.[k] !== "string") throw new ToolError(`${k} must be a string`);
  return args[k];
}
function needNum(args, k) {
  if (typeof args?.[k] !== "number" || !Number.isFinite(args[k])) throw new ToolError(`${k} must be a number`);
  return args[k];
}
function needArr(args, k) {
  if (!Array.isArray(args?.[k])) throw new ToolError(`${k} must be an array`);
  return args[k];
}

/**
 * Run one tool call: grant-check first, real execution, signed receipt after.
 * ctx = {dir, nodeId, grant, keypair, workdir, node}
 */
export async function runTool(ctx, name, args) {
  const def = findDef(name);
  checkGrant(ctx.grant, def.caps, name); // throws GrantError before anything runs
  let result;
  try {
    result = await impl(ctx, name, args || {});
    if (!result || typeof result.ok !== "boolean") result = { ok: true, out: result };
  } catch (e) {
    result = { ok: false, error: e.code ? `${e.code}: ${e.message}` : e.message };
  }
  appendReceipt(ctx.dir, ctx.nodeId, ctx.keypair, name, args || {}, result);
  return result;
}
