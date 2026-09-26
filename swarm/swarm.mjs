#!/usr/bin/env node
/**
 * swarm.mjs — CLI for the KILN headless agent runtime.
 *
 *   swarm.mjs init [--dir PATH]
 *   swarm.mjs daemon start|stop|status|token|watchdog [--dir PATH]
 *   swarm.mjs node spawn --name N --caps CAPS --ttl SEC [--repo PATH] [--mind script|http]
 *                        [--policy never|on-failure|always] [--max-restarts N] [--dir PATH]
 *   swarm.mjs node list [--dir PATH]
 *   swarm.mjs node stop <id|name> [--dir PATH]
 *   swarm.mjs node logs <id|name> [--tail N] [--dir PATH]
 *   swarm.mjs job submit --plan FILE [--name N] [--mind M] [--node ID] [--dir PATH]
 *   swarm.mjs job list [--dir PATH]
 *   swarm.mjs receipts verify [--node ID] [--dir PATH]
 *   swarm.mjs repo create --owner O --repo R [--dir PATH]
 *   swarm.mjs repo list [--dir PATH]
 *
 * State dir: --dir, else $KILN_SWARM_DIR, else ~/.kiln-swarm.
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, existsSync, openSync, closeSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  stateDir as defaultStateDir, ensureStateDir, listNodeIds, loadNode, saveNode,
  resolveNode, pidAlive, pidIsDaemon, heartbeatAgeMs, nodeDir, loadApiToken,
} from "./lib/state.mjs";
import { createNode } from "./lib/nodes.mjs";
import { loadKeypair } from "./lib/keys.mjs";
import { loadKeyFile } from "./lib/state.mjs";
import { parseCaps, capsToNames, nowSec } from "./lib/grant.mjs";
import { appendEvent, replay, newJobId } from "./lib/queue.mjs";
import { verifyReceipts, receiptsPath } from "./lib/receipts.mjs";
import { createRepo, listRepos } from "./lib/git.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > -1) args[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) args[a.slice(2)] = argv[++i];
      else args[a.slice(2)] = true;
    } else args._.push(a);
  }
  return args;
}

function dirOf(args) {
  if (args.dir) return resolve(String(args.dir));
  return defaultStateDir();
}

function need(args, k) {
  if (args[k] === undefined) { console.error(`missing --${k}`); process.exit(2); }
  return args[k];
}

function fmtTs(ts) { return new Date(ts * 1000).toISOString(); }

// ---------------------------------------------------------------- init

function cmdInit(args) {
  const dir = dirOf(args);
  ensureStateDir(dir);
  console.log(`swarm state dir: ${dir}`);
}

// ---------------------------------------------------------------- daemon

function daemonJson(dir) {
  const p = join(dir, "daemon.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

function daemonStart(dir) {
  const d = daemonJson(dir);
  if (d && pidIsDaemon(d.pid, dir)) { console.error(`daemon already running pid=${d.pid}`); process.exit(1); }
  const out = openSync(join(dir, "daemon.log"), "a");
  const child = spawn(process.execPath, [join(HERE, "lib", "daemon.mjs")], {
    detached: true, stdio: ["ignore", out, out],
    env: { ...process.env, KILN_SWARM_DIR: dir },
  });
  child.unref();
  closeSync(out);
  console.log(`daemon starting pid=${child.pid} dir=${dir}`);
  return child.pid;
}

/**
 * True daemon health: the pid must be alive AND the HTTP API must answer.
 * A pid can be alive while the API is wedged, and (as ticket E2 showed) the
 * process can vanish with no log line — so check both, every time.
 */
async function daemonStatus(dir) {
  const d = daemonJson(dir);
  if (!d || !d.pid) return { up: false, reason: "no daemon.json — the daemon was never started here" };
  if (!pidAlive(d.pid)) {
    return { up: false, pid: d.pid, startedAt: d.startedAt, reason: `pid ${d.pid} is not alive` };
  }
  const apiUrl = d.apiUrl || "http://127.0.0.1:18787";
  try {
    const res = await fetch(apiUrl + "/health", { signal: AbortSignal.timeout(5000) });
    if (res.ok) return { up: true, pid: d.pid, startedAt: d.startedAt, apiUrl };
    return { up: false, pid: d.pid, startedAt: d.startedAt, reason: `pid ${d.pid} alive but API returned HTTP ${res.status}` };
  } catch {
    return { up: false, pid: d.pid, startedAt: d.startedAt, reason: `pid ${d.pid} alive but API not responding at ${apiUrl}` };
  }
}

function watchdogLog(dir, msg) {
  const line = `[watchdog ${new Date().toISOString()}] ${msg}\n`;
  try { appendFileSync(join(dir, "watchdog.log"), line); } catch { /* best effort */ }
}

/**
 * daemon watchdog — meant to run on a schedule (every 1–2 min). Checks true
 * health; restarts the daemon if down. Crash-loop guard: more than 5
 * watchdog restarts in the last hour means something is fundamentally wrong —
 * stop restarting and say so loudly instead of spinning forever.
 */
async function daemonWatchdog(dir) {
  const st = await daemonStatus(dir);
  if (st.up) return; // healthy — stay silent, the log is noise otherwise
  const statePath = join(dir, "watchdog.json");
  let state = { restarts: [] };
  try { state = JSON.parse(readFileSync(statePath, "utf8")); } catch { /* fresh */ }
  const hourAgo = Date.now() - 3600_000;
  state.restarts = (state.restarts || []).filter((t) => t > hourAgo);
  if (state.restarts.length >= 5) {
    const msg = `daemon down (${st.reason}) — NOT restarting: ${state.restarts.length} watchdog restarts in the last hour, crash loop suspected. Investigate ${join(dir, "daemon.log")} manually.`;
    watchdogLog(dir, msg);
    console.error(msg);
    process.exit(1);
  }
  watchdogLog(dir, `daemon down (${st.reason}) — restarting`);
  daemonStart(dir);
  // Give it a moment, then verify the restart actually took.
  await new Promise((r) => setTimeout(r, 4000));
  const st2 = await daemonStatus(dir);
  if (st2.up) {
    state.restarts.push(Date.now());
    try { writeFileSync(statePath, JSON.stringify(state) + "\n"); } catch { /* best effort */ }
    watchdogLog(dir, `restarted ok pid=${st2.pid}`);
    console.log(`daemon restarted pid=${st2.pid}`);
  } else {
    const msg = `daemon restart attempted but still down (${st2.reason})`;
    watchdogLog(dir, msg);
    console.error(msg);
    process.exit(1);
  }
}

async function cmdDaemon(args) {
  const sub = args._[1];
  const dir = dirOf(args);
  ensureStateDir(dir);
  if (sub === "start") {
    daemonStart(dir);
  } else if (sub === "stop") {
    const d = daemonJson(dir);
    if (!d || !pidIsDaemon(d.pid, dir)) { console.log("daemon not running"); return; }
    process.kill(d.pid, "SIGTERM");
    console.log(`daemon stop signaled pid=${d.pid} (workers left running — persistent)`);
  } else if (sub === "status") {
    const st = await daemonStatus(dir);
    if (st.up) {
      console.log(`daemon: running pid=${st.pid} since ${st.startedAt}`);
      console.log(`api: ${st.apiUrl} (127.0.0.1 only, bearer token in ${join(dir, "api.token")})`);
    } else {
      console.log(`daemon: DOWN (${st.reason})`);
      console.log(`fix: start it with: node swarm.mjs daemon start`);
    }
    const ids = listNodeIds(dir);
    let idle = 0, working = 0, dead = 0;
    for (const id of ids) {
      const n = loadNode(dir, id);
      const a = pidAlive(n.workerPid);
      if (!a) dead++;
      else if (existsSync(join(nodeDir(dir, id), "job.json"))) working++;
      else idle++;
    }
    const jobs = replay(dir);
    const pending = [...jobs.values()].filter((j) => j.status === "pending").length;
    console.log(`nodes: ${ids.length} (idle=${idle} working=${working} dead=${dead})  jobs: ${jobs.size} total, ${pending} pending`);
    if (!st.up) process.exit(1);
  } else if (sub === "watchdog") {
    await daemonWatchdog(dir);
  } else if (sub === "token") {
    console.log(loadApiToken(dir));
  } else { console.error("usage: daemon start|stop|status|token|watchdog"); process.exit(2); }
}

// ---------------------------------------------------------------- node

async function cmdNode(args) {
  const sub = args._[1];
  const dir = dirOf(args);
  ensureStateDir(dir);
  if (sub === "spawn") {
    const name = need(args, "name");
    const caps = parseCaps(need(args, "caps"));
    const ttl = parseInt(need(args, "ttl"), 10);
    if (!(ttl > 0)) { console.error("--ttl must be positive seconds"); process.exit(2); }
    const node = await createNode(dir, {
      name: String(name),
      caps,
      expiresAt: nowSec() + ttl,
      repo: args.repo ? String(args.repo) : null,
      mind: String(args.mind || "script"),
      restartPolicy: String(args.policy || "on-failure"),
      maxRestarts: args["max-restarts"] ? parseInt(args["max-restarts"], 10) : 3,
    });
    console.log(`spawned node ${node.name}`);
    console.log(`  id:   ${node.id}`);
    console.log(`  caps: ${node.grant.capabilities} [${capsToNames(node.grant.capabilities).join(",")}] until ${fmtTs(node.grant.expiresAt)}`);
    console.log(`  work: ${node.workdir}`);
    const d = daemonJson(dir);
    console.log(d && pidAlive(d.pid)
      ? "  daemon will start the worker on its next tick"
      : "  daemon not running — start it to launch the worker");
  } else if (sub === "list") {
    const ids = listNodeIds(dir);
    if (!ids.length) { console.log("(no nodes)"); return; }
    for (const id of ids) {
      const n = loadNode(dir, id);
      const alive = pidAlive(n.workerPid);
      const hb = heartbeatAgeMs(dir, id);
      const st = !alive ? "dead" : hb > 30000 ? "stale" : existsSync(join(nodeDir(dir, id), "job.json")) ? "working" : "idle";
      const exp = n.grant.expiresAt <= nowSec() ? "EXPIRED" : `until ${fmtTs(n.grant.expiresAt)}`;
      console.log(`${id.slice(0, 12)}…  ${n.name.padEnd(14)} ${st.padEnd(7)} pid=${String(n.workerPid || "-").padEnd(7)} caps=[${capsToNames(n.grant.capabilities).join(",")}] ${exp}${n.grant.parent ? ` parent=${n.grant.parent.slice(0, 8)}…` : ""}`);
    }
  } else if (sub === "stop") {
    if (!args._[2]) { console.error("usage: node stop <id|name>"); process.exit(2); }
    const id = resolveNode(dir, args._[2]);
    const n = loadNode(dir, id);
    if (n.workerPid && pidAlive(n.workerPid)) {
      process.kill(n.workerPid, "SIGTERM");
      n.workerPid = null; n.lastExit = 0; saveNode(dir, n);
      console.log(`stopped worker for ${n.name}`);
    } else console.log(`${n.name}: no live worker`);
  } else if (sub === "logs") {
    if (!args._[2]) { console.error("usage: node logs <id|name>"); process.exit(2); }
    const id = resolveNode(dir, args._[2]);
    const n = loadNode(dir, id);
    const tail = args.tail ? parseInt(args.tail, 10) : 50;
    for (const f of ["stdout.log", "stderr.log"]) {
      const p = join(nodeDir(dir, id), f);
      console.log(`--- ${n.name} ${f} ---`);
      if (!existsSync(p)) { console.log("(empty)"); continue; }
      const lines = readFileSync(p, "utf8").split("\n");
      console.log(lines.slice(-tail).join("\n"));
    }
  } else { console.error("usage: node spawn|list|stop|logs"); process.exit(2); }
}

// ---------------------------------------------------------------- job

function cmdJob(args) {
  const sub = args._[1];
  const dir = dirOf(args);
  ensureStateDir(dir);
  if (sub === "submit") {
    const planFile = need(args, "plan");
    const plan = JSON.parse(readFileSync(resolve(String(planFile)), "utf8"));
    if (!plan || !Array.isArray(plan.steps)) { console.error("plan file must be JSON with steps[]"); process.exit(2); }
    const job = {
      id: newJobId(),
      name: String(args.name || `job-${Date.now()}`),
      plan, mind: String(args.mind || "script"),
    };
    if (args.node) job.node = resolveNode(dir, String(args.node));
    if (args.repo) job.repo = String(args.repo);
    appendEvent(dir, "submit", { job });
    console.log(`submitted ${job.id} (${job.plan.steps.length} steps, mind=${job.mind})`);
  } else if (sub === "list") {
    const jobs = [...replay(dir).values()].sort((a, b) => a.submittedAt - b.submittedAt);
    if (!jobs.length) { console.log("(no jobs)"); return; }
    for (const j of jobs) {
      console.log(`${j.id}  ${j.status.padEnd(8)} ${j.name}  node=${j.node ? j.node.slice(0, 8) + "…" : "-"}${j.summary ? `  ${j.summary.slice(0, 80)}` : ""}${j.error ? `  ERROR: ${j.error.slice(0, 80)}` : ""}`);
    }
  } else { console.error("usage: job submit|list"); process.exit(2); }
}

// ---------------------------------------------------------------- receipts

function cmdReceipts(args) {
  const sub = args._[1];
  const dir = dirOf(args);
  if (sub === "verify") {
    let ids = listNodeIds(dir);
    if (args.node) ids = [resolveNode(dir, String(args.node))];
    let allOk = true;
    for (const id of ids) {
      const n = loadNode(dir, id);
      const kp = loadKeypair(loadKeyFile(dir, id));
      const v = verifyReceipts(dir, id, kp);
      console.log(`${n.name} (${id.slice(0, 12)}…): ${v.ok ? `OK — ${v.count} receipts, chain intact` : `FAIL — ${v.error}`}`);
      if (!v.ok) allOk = false;
    }
    process.exit(allOk ? 0 : 1);
  } else { console.error("usage: receipts verify"); process.exit(2); }
}

// ---------------------------------------------------------------- repo (KILN-native git hosting)

function apiBase(dir) {
  const d = daemonJson(dir);
  if (d && d.apiUrl) return d.apiUrl;
  return "http://127.0.0.1:18787";
}

async function apiCall(dir, method, p, body) {
  const token = loadApiToken(dir);
  let res;
  try {
    res = await fetch(apiBase(dir) + p, {
      method,
      headers: {
        "authorization": `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    // fetch() throws a bare TypeError("fetch failed") when nothing listens.
    // Translate connection-level failures into an actionable message.
    if (isConnFailure(e)) throw new DaemonDownError(dir);
    throw e;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `api ${res.status}`);
  return data;
}

/** Thrown when the swarm daemon API doesn't answer. Carries the fix. */
class DaemonDownError extends Error {
  constructor(dir) {
    super(daemonDownMessage(dir));
    this.name = "DaemonDownError";
  }
}

function daemonDownMessage(dir) {
  const url = apiBase(dir);
  const d = daemonJson(dir);
  const startHint = "start it with: node swarm.mjs daemon start";
  if (d && d.pid) {
    return `swarm daemon not responding at ${url} ` +
      `(it was started as pid ${d.pid}${d.startedAt ? ` at ${d.startedAt}` : ""} — it may have died). ${startHint}`;
  }
  return `swarm daemon is not running (no answer at ${url}). ${startHint}`;
}

/** Short stderr note for the repo local-fallback path. */
function daemonDownNote(dir) {
  const d = daemonJson(dir);
  if (d && d.pid) return `(daemon was started as pid ${d.pid} but isn't responding — working from local state)`;
  return `(daemon not running — working from local state)`;
}

function isConnFailure(e) {
  if (!(e instanceof Error)) return false;
  const code = e.cause && typeof e.cause === "object" ? e.cause.code : undefined;
  if (code) {
    return ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ECONNRESET", "ETIMEDOUT"].includes(code);
  }
  // undici throws TypeError("fetch failed") with a cause in practice, but
  // match the message as a last resort so the user never sees the bare form.
  return /fetch failed/i.test(e.message);
}

/** Clone URL the daemon will serve this repo at once it is up. */
function localCloneUrl(dir, owner, repo) {
  try {
    const port = new URL(apiBase(dir)).port || "18787";
    return `http://127.0.0.1:${port}/git/${owner}/${repo}`;
  } catch {
    return `http://127.0.0.1:18787/git/${owner}/${repo}`;
  }
}

function printRepoRows(repos) {
  if (!repos.length) { console.log("(no repos)"); return; }
  for (const x of repos) {
    console.log(`${x.owner}/${x.repo}${x.createdAt ? `  created ${x.createdAt}` : ""}`);
  }
}

async function cmdRepo(args) {
  const sub = args._[1];
  const dir = dirOf(args);
  ensureStateDir(dir);
  if (sub === "create") {
    const owner = need(args, "owner");
    const repo = need(args, "repo");
    try {
      const r = await apiCall(dir, "POST", `/git/${owner}/${repo}`);
      console.log(`created repo ${r.owner}/${r.repo}`);
      console.log(`  clone: ${r.cloneUrl}`);
    } catch (e) {
      if (!(e instanceof DaemonDownError)) throw e;
      // Local fallback: the daemon's create path is literally this same
      // function (lib/git.mjs createRepo), so a locally-created repo is
      // served identically once the daemon starts.
      const r = createRepo(dir, owner, repo);
      console.log(`created repo ${r.owner}/${r.repo} ${daemonDownNote(dir)}`);
      console.log(`  clone: ${localCloneUrl(dir, r.owner, r.repo)} (works once the daemon is up)`);
      console.log(`  start it with: node swarm.mjs daemon start`);
    }
  } else if (sub === "list") {
    try {
      const r = await apiCall(dir, "GET", "/git");
      printRepoRows(r.repos);
    } catch (e) {
      if (!(e instanceof DaemonDownError)) throw e;
      // Local fallback: the daemon's list path scans the same directory.
      const repos = listRepos(dir);
      if (repos.length) console.error(daemonDownNote(dir));
      printRepoRows(repos);
    }
  } else { console.error("usage: repo create|list"); process.exit(2); }
}

// ---------------------------------------------------------------- compute (serverless)

function readCode(args) {
  if (args["code-file"]) return readFileSync(resolve(String(args["code-file"])), "utf8");
  return need(args, "code");
}

async function cmdCompute(args) {
  const sub = args._[1];
  const dir = dirOf(args);
  ensureStateDir(dir);
  if (sub === "invoke") {
    const body = {
      code: readCode(args),
      name: args.name,
      timeoutMs: args.timeout ? Number(args.timeout) : undefined,
      waitMs: args.wait ? Number(args.wait) : undefined,
    };
    if (args.args) body.args = JSON.parse(String(args.args));
    const r = await apiCall(dir, "POST", "/v1/compute/invoke", body);
    if (r.status === "done") {
      console.log(`done ok=${r.ok} (${r.durationMs}ms)`);
      if (r.ok) console.log(JSON.stringify(r.result, null, 2));
      else console.log(`error: ${r.error}`);
      if (r.logs && r.logs.length) console.log(`logs:\n${r.logs.join("\n")}`);
      process.exit(r.ok ? 0 : 1);
    }
    console.log(`${r.invocationId} ${r.status} (job ${r.jobId})`);
  } else if (sub === "invocation") {
    const r = await apiCall(dir, "GET", `/v1/compute/invocations/${need(args, "id")}`);
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.status === "done" && r.ok === false ? 1 : 0);
  } else if (sub === "map") {
    const body = {
      code: readCode(args),
      items: JSON.parse(need(args, "items")),
      name: args.name,
      timeoutMs: args.timeout ? Number(args.timeout) : undefined,
    };
    const r = await apiCall(dir, "POST", "/v1/compute/map", body);
    console.log(`${r.mapId}  ${r.count} items`);
    if (args.wait) {
      const t0 = Date.now();
      const waitMs = Number(args.wait) || 300000;
      for (;;) {
        const m = await apiCall(dir, "GET", `/v1/compute/map/${r.mapId}`);
        const pending = (m.counts.pending || 0) + (m.counts.assigned || 0);
        if (!pending) {
          for (const x of m.results) {
            console.log(`${x.status} ${x.ok === false ? "ok=false " : ""}${JSON.stringify(x.result)}${x.error ? ` ERROR: ${x.error}` : ""}`);
          }
          process.exit(m.results.some((x) => x.ok === false) ? 1 : 0);
        }
        if (Date.now() - t0 > waitMs) { console.error("map wait timed out"); process.exit(1); }
        await new Promise((rr) => setTimeout(rr, 1500));
      }
    }
  } else if (sub === "map-status") {
    const r = await apiCall(dir, "GET", `/v1/compute/map/${need(args, "id")}`);
    console.log(JSON.stringify(r.counts));
  } else if (sub === "deploy") {
    const body = {
      name: need(args, "name"),
      repo: need(args, "repo"),
      command: need(args, "command"),
      args: args.args ? JSON.parse(String(args.args)) : undefined,
      port: args.port ? Number(args.port) : undefined,
    };
    const r = await apiCall(dir, "POST", "/v1/compute/apps", body);
    console.log(`deployed ${r.name} -> app ${r.appId.slice(0, 12)}… (${r.status})`);
  } else if (sub === "apps") {
    const r = await apiCall(dir, "GET", "/v1/compute/apps");
    if (!r.apps.length) { console.log("(no apps)"); return; }
    for (const a of r.apps) console.log(`${a.appId.slice(0, 12)}…  ${a.status.padEnd(8)} ${a.name}  ${a.command}${a.port ? ` :${a.port}` : ""}`);
  } else if (sub === "logs") {
    const tail = args.tail ? Number(args.tail) : 100;
    const r = await apiCall(dir, "GET", `/v1/compute/apps/${need(args, "app")}/logs?tail=${tail}`);
    console.log(r.log);
  } else if (sub === "undeploy") {
    await apiCall(dir, "DELETE", `/v1/compute/apps/${need(args, "app")}`);
    console.log("undeployed");
  } else {
    console.error("usage: compute invoke|invocation|map|map-status|deploy|apps|logs|undeploy");
    process.exit(2);
  }
}

// ---------------------------------------------------------------- main

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
try {
  if (cmd === "init") cmdInit(args);
  else if (cmd === "daemon") await cmdDaemon(args);
  else if (cmd === "node") await cmdNode(args);
  else if (cmd === "job") cmdJob(args);
  else if (cmd === "compute") await cmdCompute(args);
  else if (cmd === "receipts") cmdReceipts(args);
  else if (cmd === "repo") await cmdRepo(args);
  else {
    console.error("usage: swarm.mjs init|daemon|node|job|compute|receipts|repo");
    process.exit(2);
  }
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}
