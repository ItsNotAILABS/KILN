#!/usr/bin/env node
/**
 * swarm.mjs — CLI for the KILN headless agent runtime.
 *
 *   swarm.mjs init [--dir PATH]
 *   swarm.mjs daemon start|stop|status|token|watchdog [--dir PATH]
 *   swarm.mjs doctor start|stop|status|report|check [--dir PATH]
 *   swarm.mjs node spawn --name N --caps CAPS --ttl SEC [--repo PATH] [--mind script|http]
 *                        [--policy never|on-failure|always] [--max-restarts N] [--dir PATH]
 *   swarm.mjs node list [--dir PATH]
 *   swarm.mjs node stop <id|name> [--dir PATH]
 *   swarm.mjs node revive <id|name> [--dir PATH]
 *   swarm.mjs node logs <id|name> [--tail N] [--dir PATH]
 *   swarm.mjs job submit --plan FILE [--name N] [--mind M] [--node ID] [--dir PATH]
 *   swarm.mjs job list [--dir PATH]
 *   swarm.mjs receipts verify [--node ID] [--dir PATH]
 *   swarm.mjs repo create --owner O --repo R [--dir PATH]
 *   swarm.mjs repo list [--dir PATH]
 *   swarm.mjs promote <owner>/<repo> [--github OWNER/REPO] [--branch B]
 *                        [--rebase] [--force] [--dir PATH]
 *   swarm.mjs sites list [--dir PATH]
 *   swarm.mjs sites show <id|name> [--dir PATH]
 *   swarm.mjs sites add --name N --frontend O/R --backend O/R
 *                        [--artifact SLUG] [--app NAME|APPID] [--dir PATH]
 *   swarm.mjs sites remove <id|name> [--dir PATH]
 *   swarm.mjs workspaces list [--owner O] [--dir PATH]
 *   swarm.mjs workspaces show <id|slug> [--dir PATH]
 *   swarm.mjs workspaces add --owner O --slug S --name N [--description D]
 *                        [--repos O/R,O/R] [--sites ID,ID] [--dir PATH]
 *   swarm.mjs workspaces update <id|slug> [--name N] [--description D]
 *                        [--add-repo O/R] [--remove-repo O/R]
 *                        [--link-site ID] [--unlink-site ID] [--dir PATH]
 *   swarm.mjs workspaces remove <id|slug> --confirm SLUG [--dir PATH]
 *
 * State dir: --dir, else $KILN_SWARM_DIR, else ~/.kiln-swarm.
 */
import { spawn } from "node:child_process";
import { readFileSync, appendFileSync, existsSync, openSync, closeSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  stateDir as defaultStateDir, ensureStateDir, listNodeIds, loadNode, saveNode,
  resolveNode, pidAlive, pidIsDaemon, heartbeatAgeMs, nodeDir, loadApiToken,
  writeFileAtomicSync,
} from "./lib/state.mjs";
import { createNode, reviveNode } from "./lib/nodes.mjs";
import { loadKeypair } from "./lib/keys.mjs";
import { loadKeyFile } from "./lib/state.mjs";
import { parseCaps, capsToNames, nowSec } from "./lib/grant.mjs";
import { appendEvent, replay, newJobId } from "./lib/queue.mjs";
import { verifyReceipts, receiptsPath } from "./lib/receipts.mjs";
import { createRepo, listRepos } from "./lib/git.mjs";
import { promoteRepo } from "./lib/promote.mjs";
import {
  createSite, listSites, resolveSite, deleteSite, siteStatus,
} from "./lib/sites.mjs";
import {
  createWorkspace, listWorkspaces, resolveWorkspace, updateWorkspace,
  deleteWorkspace, workspaceStatus,
} from "./lib/workspaces.mjs";
import {
  remember, assertFact, supersedeFact, linkMemories, setCore,
  proposeMemory, resolveProposal,
  loadMemory, factsAt, recall, recallCrossRepo, buildContext, memoryStats, verifyMemory, agentAwareness,
} from "./lib/memory.mjs";
import { memorySigningPubkey, signatureSummary } from "./lib/memory-signing.mjs";
import { tickJsonPath } from "./lib/tickwatch.mjs";
import { buildDaemonSpawnEnv } from "./lib/daemon-env.mjs";
import {
  doctorStart, doctorStop, doctorAlive, doctorRun, doctorCheck,
  daemonHealth, readJournal, diagnose, doctorDir, doctorAgents,
} from "./lib/doctor.mjs";

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
  // Persistent per-state-dir config: <dir>/daemon.env supplies env the
  // starting process did not specify (see lib/daemon-env.mjs). This is
  // the single spawn choke point — `daemon start`, `daemon watchdog`
  // and the Doctor's medic (which invokes the watchdog) all reach the
  // daemon through here, so the file takes effect on the next boot
  // through any of them. Malformed lines are warned about and skipped,
  // never fatal: config trouble must not strand a daemon.
  const spawnEnv = buildDaemonSpawnEnv(dir);
  for (const p of spawnEnv.problems) {
    console.error(`daemon.env: line ${p.line} skipped (${p.reason}): ${p.text.trim()}`);
  }
  const out = openSync(join(dir, "daemon.log"), "a");
  const child = spawn(process.execPath, [join(HERE, "lib", "daemon.mjs")], {
    detached: true, stdio: ["ignore", out, out],
    env: spawnEnv.env,
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
    try { writeFileAtomicSync(statePath, JSON.stringify(state) + "\n"); } catch { /* best effort */ }
    watchdogLog(dir, `restarted ok pid=${st2.pid}`);
    console.log(`daemon restarted pid=${st2.pid}`);
  } else {
    const msg = `daemon restart attempted but still down (${st2.reason})`;
    watchdogLog(dir, msg);
    console.error(msg);
    process.exit(1);
  }
}

/** One-line tick-instrumentation summary for `daemon status`, from tick.json. */
function tickStatusLine(dir) {
  try {
    const p = tickJsonPath(dir);
    if (!existsSync(p)) return "tick: no tick data yet";
    const t = JSON.parse(readFileSync(p, "utf8"));
    if (!t || !Number.isFinite(t.lastTickEndMs)) return "tick: tick data unreadable";
    const ageS = Math.max(0, Math.round((Date.now() - t.lastTickEndMs) / 1000));
    const avg = Number.isFinite(t.avgTickMs) ? Math.round(t.avgTickMs) : "?";
    const max = Number.isFinite(t.maxTickMs) ? Math.round(t.maxTickMs) : "?";
    const n = Number.isFinite(t.tickCount) ? t.tickCount : "?";
    return `tick: last completed ${ageS}s ago, avg=${avg}ms max=${max}ms count=${n}`;
  } catch {
    return "tick: tick data unreadable";
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
      console.log(tickStatusLine(dir));
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

// ---------------------------------------------------------------- doctor

async function cmdDoctor(args) {
  const sub = args._[1];
  const dir = dirOf(args);
  ensureStateDir(dir);
  if (sub === "_run") { await doctorRun(dir); return; } // detached loop; not for humans
  if (sub === "start") {
    const r = doctorStart(dir);
    console.log(r.already ? `doctor already running pid=${r.pid}` : `doctor starting pid=${r.pid} dir=${dir}`);
  } else if (sub === "stop") {
    const r = doctorStop(dir);
    console.log(r.stopped ? `doctor stop signaled pid=${r.pid}` : `doctor not running (${r.reason})`);
  } else if (sub === "status") {
    const alive = doctorAlive(dir);
    let since = "";
    try {
      const d = JSON.parse(readFileSync(join(doctorDir(dir), "doctor.json"), "utf8"));
      since = d.startedAt ? ` since ${d.startedAt}` : "";
    } catch { /* no pidfile */ }
    console.log(alive ? `doctor: running${since}` : "doctor: not running");
    const st = await daemonHealth(dir);
    console.log(st.up ? `daemon: running pid=${st.pid} since ${st.startedAt}` : `daemon: DOWN (${st.reason})`);
    const deaths = readJournal(dir).filter((e) => e.type === "death");
    const last = deaths.length ? deaths[deaths.length - 1].ts : null;
    console.log(`deaths recorded: ${deaths.length}${last ? ` (last ${last})` : ""}`);
    console.log(`agents: ${doctorAgents(dir).map((a) => `${a.name}=${a.state}`).join(" ")}`);
    if (!alive) process.exit(1);
  } else if (sub === "report") {
    const dg = diagnose(dir);
    const events = readJournal(dir);
    const deaths = events.filter((e) => e.type === "death");
    console.log(`doctor report for ${dir}`);
    console.log(`journal: ${events.length} events, ${deaths.length} deaths`);
    for (const e of deaths.slice(-5)) {
      console.log(`  death ${e.ts} pid=${e.pid ?? "?"} uptime=${e.uptimeSec ?? "?"}s mem=${e.memAvailableMb ?? "?"}MB stale=[${(e.preDeathStaleWorkers || []).join(",")}]`);
      console.log(`        reason: ${e.reason}`);
    }
    console.log(`diagnosis: ${dg.verdict}`);
    console.log(dg.hypothesis);
  } else if (sub === "check") {
    const { lines, exitCode } = await doctorCheck(dir);
    for (const l of lines) console.log(l);
    if (exitCode !== 0) process.exit(1);
  } else { console.error("usage: doctor start|stop|status|report|check"); process.exit(2); }
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
  } else if (sub === "revive") {
    if (!args._[2]) { console.error("usage: node revive <id|name>"); process.exit(2); }
    const { node: n, was } = reviveNode(dir, args._[2]);
    console.log(`revived node ${n.name}: restart budget reset (${was} → 0), last exit cleared`);
    const d = daemonJson(dir);
    console.log(d && pidAlive(d.pid)
      ? "  daemon will respawn the worker on its next tick (autostart + restart policy permitting)"
      : "  daemon not running — the worker starts when the daemon does");
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

// ---------------------------------------------------------------- promote (KILN -> GitHub)

function splitOwnerRepo(s, what) {
  const i = typeof s === "string" ? s.indexOf("/") : -1;
  if (i <= 0 || i === s.length - 1) {
    console.error(`usage: ${what} must be <owner>/<repo>`);
    process.exit(2);
  }
  return [s.slice(0, i), s.slice(i + 1)];
}

async function cmdPromote(args) {
  const dir = dirOf(args);
  ensureStateDir(dir);
  const target = args._[1];
  if (!target) {
    console.error("usage: promote <owner>/<repo> [--github OWNER/REPO] [--branch B] [--rebase] [--force]");
    process.exit(2);
  }
  const [owner, repo] = splitOwnerRepo(target, "promote target");
  let githubOwner, githubRepo;
  if (args.github) [githubOwner, githubRepo] = splitOwnerRepo(String(args.github), "--github");
  const r = await promoteRepo(dir, owner, repo, {
    githubOwner,
    githubRepo,
    branch: args.branch ? String(args.branch) : undefined,
    rebase: !!args.rebase,
    force: !!args.force,
  });
  // One-screen receipt (KILN standard shape; token never printed).
  console.log(`🔥 KILN · ${r.repo} → GitHub ${r.github || "(no destination)"}${r.branch ? "@" + r.branch : ""}`);
  console.log(`  source ${r.sourceBranch || "?"} @ ${(r.sourceTip || "").slice(0, 7)} · ${r.commitsPlanned} of ${r.commitsTotal} commit(s)${r.rebased ? " · rebased onto GitHub tip" : ""}${r.forced ? " · FORCED" : ""}`);
  for (const c of r.commits) {
    console.log(`  built ${c.from.slice(0, 12)} -> ${c.to.slice(0, 12)} (${c.blobs} blobs) ${c.subject}`);
  }
  for (const w of r.warnings) console.log(`  ⚠ ${w}`);
  if (r.ok) {
    console.log(r.note ? `✅ ${r.note}` : `✅ promoted${r.newTip ? ` → ${r.newTip.slice(0, 12)}` : ""}`);
    console.log(`  ${r.url}`);
  } else {
    console.log(`❌ ${r.error.stage}: ${r.error.message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------- memory (per-repo)

function repoArg(args) {
  const s = need(args, "repo");
  const i = String(s).indexOf("/");
  if (i <= 0 || i === String(s).length - 1) { console.error("--repo must be <owner>/<repo>"); process.exit(2); }
  return [String(s).slice(0, i), String(s).slice(i + 1)];
}
function csv(v) {
  return v === undefined || v === true ? [] : String(v).split(",").map((x) => x.trim()).filter(Boolean);
}

async function cmdMemory(args) {
  const sub = args._[1];
  const dir = dirOf(args);
  ensureStateDir(dir);
  // Phase 6 cross-repo recall: `memory recall-all --q <query>` (or
  // `memory recall --repo '*'`). No --repo: the query fans out over
  // every repo chain in the state dir; excluded (unverifiable)
  // chains are reported on stderr, never silently skipped.
  if (sub === "recall-all" || (sub === "recall" && (args.all === true || args.repo === "*" || args.repo === "*/*"))) {
    const r = recallCrossRepo(dir, String(need(args, "q")), {
      limit: args.limit ? Number(args.limit) : 10,
      kinds: csv(args.kinds),
      tags: csv(args.tags),
      asOf: args.asof ? String(args.asof) : undefined,
      since: args.since ? String(args.since) : undefined,
      until: args.until ? String(args.until) : undefined,
      includeSuperseded: !!args.superseded,
    });
    if (args.json) {
      console.log(JSON.stringify(r, null, 2));
    } else {
      for (const x of r.results) {
        console.log(`${x.score.toFixed(3)}  ${x.repo}  ${x.kind.padEnd(7)} seq=${x.seq} via=${x.via} engine=${x.engine}  ${x.title || x.text.slice(0, 80)}`);
      }
      if (!r.results.length) console.log("(no recall hits)");
      for (const s of r.repos) {
        if (s.status === "empty") console.error(`[memory: ${s.repo} has no memory]`);
      }
    }
    for (const ex of r.excluded) {
      console.error(`[memory: EXCLUDED ${ex.repo} — chain failed verification: ${ex.error}]`);
    }
    return;
  }
  const [owner, repo] = repoArg(args);
  const actor = args.actor ? String(args.actor) : "cli";
  if (sub === "remember") {
    const content = args.file ? readFileSync(resolve(String(args.file)), "utf8") : need(args, "content");
    const r = remember(dir, owner, repo, {
      title: args.title, kind: args.kind, content: String(content),
      tags: csv(args.tags), entities: csv(args.entities),
      eventDate: args.date, actor,
      source: args.source ? { type: "ref", ref: String(args.source) } : undefined,
    });
    console.log(`remembered ${r.event.id} (seq ${r.event.seq}) in ${owner}/${repo} @ ${r.commit.slice(0, 12)}`);
  } else if (sub === "fact") {
    const r = assertFact(dir, owner, repo, {
      subject: need(args, "subject"), predicate: need(args, "predicate"), object: need(args, "object"),
      sourceEpisodes: csv(need(args, "sources")), supersedes: csv(args.supersedes),
      validFrom: args.from, actor,
    });
    console.log(`fact ${r.event.id} (seq ${r.event.seq}) @ ${r.commit.slice(0, 12)}`);
  } else if (sub === "supersede") {
    const r = supersedeFact(dir, owner, repo, { fact: need(args, "fact"), reason: args.reason, actor });
    console.log(`superseded via ${r.event.id} (seq ${r.event.seq}) @ ${r.commit.slice(0, 12)}`);
  } else if (sub === "link") {
    const r = linkMemories(dir, owner, repo, { from: need(args, "from"), to: need(args, "to"), relation: need(args, "relation"), actor });
    console.log(`linked ${r.event.id} (seq ${r.event.seq}) @ ${r.commit.slice(0, 12)}`);
  } else if (sub === "core") {
    const r = setCore(dir, owner, repo, { label: need(args, "label"), value: need(args, "value"), description: args.description, actor });
    console.log(`core "${r.event.label}" set (seq ${r.event.seq}) @ ${r.commit.slice(0, 12)}`);
  } else if (sub === "core-get") {
    console.log(JSON.stringify(loadMemory(dir, owner, repo).core, null, 2));
  } else if (sub === "facts") {
    const st = loadMemory(dir, owner, repo);
    const asOf = args.asof ? Math.floor(Date.parse(String(args.asof)) / 1000) : Math.floor(Date.now() / 1000);
    console.log(JSON.stringify(factsAt(st, asOf, !!args.all), null, 2));
  } else if (sub === "recall") {
    const r = recall(dir, owner, repo, String(need(args, "q")), { limit: args.limit ? Number(args.limit) : 10 });
    for (const x of r.results) {
      console.log(`${x.score.toFixed(3)}  ${x.kind.padEnd(7)} seq=${x.seq} via=${x.via}  ${x.title || x.text.slice(0, 80)}`);
    }
    if (!r.results.length) console.log("(no recall hits)");
  } else if (sub === "context") {
    const pack = buildContext(dir, owner, repo, {
      query: args.q ? String(args.q) : undefined,
      budgetTokens: args.budget ? Number(args.budget) : 4000,
    });
    console.log(pack.text);
    console.error(`[memory: ${pack.usedTokens}/${pack.budgetTokens} tokens${pack.overBudget ? " OVER BUDGET (core alone exceeds it)" : ""}]`);
  } else if (sub === "sit") {
    const brief = agentAwareness(dir, owner, repo, {
      query: args.q ? String(args.q) : undefined,
      budgetTokens: args.budget ? Number(args.budget) : 1200,
    });
    console.log(brief.text);
  } else if (sub === "propose-fact") {
    const r = proposeMemory(dir, owner, repo, {
      kind: "fact",
      payload: {
        subject: need(args, "subject"), predicate: need(args, "predicate"), object: need(args, "object"),
        sourceEpisodes: csv(need(args, "sources")), supersedes: csv(args.supersedes),
        validFrom: args.from, confidence: args.confidence ? Number(args.confidence) : undefined,
      },
      rationale: args.rationale ? String(args.rationale) : "",
      actor,
    });
    console.log(`proposed fact ${r.event.id} (seq ${r.event.seq}) — pending ratification`);
  } else if (sub === "propose-link") {
    const r = proposeMemory(dir, owner, repo, {
      kind: "link",
      payload: { from: need(args, "from"), to: need(args, "to"), relation: need(args, "relation") },
      rationale: args.rationale ? String(args.rationale) : "",
      actor,
    });
    console.log(`proposed link ${r.event.id} (seq ${r.event.seq}) — pending ratification`);
  } else if (sub === "propose-core") {
    const r = proposeMemory(dir, owner, repo, {
      kind: "core",
      payload: { label: need(args, "label"), value: need(args, "value"), description: args.description },
      rationale: args.rationale ? String(args.rationale) : "",
      actor,
    });
    console.log(`proposed core ${r.event.id} (seq ${r.event.seq}) — pending ratification`);
  } else if (sub === "proposals") {
    const st = loadMemory(dir, owner, repo);
    const want = args.status ? String(args.status) : null;
    const list = want ? st.proposals.filter((x) => x.status === want) : st.proposals;
    for (const p of list) {
      const what = p.proposalKind === "fact"
        ? `${p.payload.subject} ${p.payload.predicate} ${p.payload.object}`
        : p.proposalKind === "link" ? `${p.payload.from} -[${p.payload.relation}]-> ${p.payload.to}` : `core "${p.payload.label}"`;
      console.log(`${p.id}  ${p.status.padEnd(8)} ${p.proposalKind.padEnd(4)} by ${p.actor}  ${what}${p.rationale ? `  — ${p.rationale}` : ""}`);
    }
    if (!list.length) console.log("(no proposals)");
  } else if (sub === "ratify" || sub === "reject") {
    const r = resolveProposal(dir, owner, repo, {
      proposal: need(args, "proposal"),
      decision: sub === "ratify" ? "ratified" : "rejected",
      reason: args.reason ? String(args.reason) : "",
      actor,
    });
    console.log(`${r.decision} ${r.proposal.id}${r.materialized ? ` → materialized as ${r.materialized.type} ${r.materialized.id}` : ""} @ ${r.commit.slice(0, 12)}`);
  } else if (sub === "stats") {
    console.log(JSON.stringify(memoryStats(dir, owner, repo), null, 2));
  } else if (sub === "verify") {
    const v = verifyMemory(dir, owner, repo);
    console.log(JSON.stringify(v, null, 2));
    if (!v.ok) process.exit(1);
  } else if (sub === "pubkey") {
    // Phase 2 discovery: the state dir's memory signing key (public
    // half only — the private key never leaves <dir>/memory-signing.key)
    // plus this repo's signature posture. Creates the key on first use.
    const pub = memorySigningPubkey(dir, { create: true });
    const st = loadMemory(dir, owner, repo);
    console.log(JSON.stringify({ ...pub, repo: `${owner}/${repo}`, signatures: signatureSummary(st.events) }, null, 2));
  } else {
    console.error("usage: memory remember|fact|supersede|link|core|core-get|facts|recall|context|sit|stats|verify|pubkey|propose-fact|propose-link|propose-core|proposals|ratify|reject --repo <owner>/<repo> [...]  ·  memory recall-all --q <query> [--limit N] [--json] (cross-repo, phase 6)");
    process.exit(2);
  }
}

// ---------------------------------------------------------------- sites (frontend + backend + artifact + app)

async function cmdSites(args) {
  const sub = args._[1];
  const dir = dirOf(args);
  ensureStateDir(dir);
  if (sub === "add") {
    // Works purely on local state (registry + repo memory + git), like
    // `memory` — no daemon needed. Memory linkage is written on create.
    const site = createSite(dir, {
      name: need(args, "name"),
      frontend: String(need(args, "frontend")),
      backend: String(need(args, "backend")),
      artifact: args.artifact ? String(args.artifact) : undefined,
      computeApp: args.app ? String(args.app) : undefined,
      actor: "cli",
    });
    console.log(`site ${site.name} (${site.id})`);
    console.log(`  frontend: ${site.frontend}`);
    console.log(`  backend:  ${site.backend}`);
    if (site.artifact) console.log(`  artifact: ${site.artifact}`);
    if (site.computeApp) console.log(`  app:      ${site.computeApp}`);
    console.log(`  memory linkage written to both repos (backend_repo/frontend_repo${site.artifact ? "/artifact" : ""}/site core blocks)`);
  } else if (sub === "list") {
    const sites = listSites(dir);
    if (!sites.length) { console.log("(no sites)"); return; }
    for (const s of sites) {
      console.log(`${s.id.slice(0, 12)}…  ${s.name.padEnd(16)} ${s.frontend} ⇄ ${s.backend}${s.artifact ? `  artifact=${s.artifact}` : ""}${s.computeApp ? `  app=${s.computeApp}` : ""}`);
    }
  } else if (sub === "show") {
    if (!args._[2]) { console.error("usage: sites show <id|name>"); process.exit(2); }
    const site = resolveSite(dir, args._[2]);
    console.log(JSON.stringify(await siteStatus(dir, site.id), null, 2));
  } else if (sub === "remove") {
    if (!args._[2]) { console.error("usage: sites remove <id|name>"); process.exit(2); }
    const site = resolveSite(dir, args._[2]);
    deleteSite(dir, site.id);
    console.log(`removed site ${site.name} (${site.id}) — registry entry only; repos, app, and memory untouched`);
  } else { console.error("usage: sites list|show|add|remove"); process.exit(2); }
}

// ---------------------------------------------------------------- workspaces (member repos + linked sites, one owner)

function oneOrUndef(v) {
  return v === undefined ? undefined : [String(v)];
}

async function cmdWorkspaces(args) {
  const sub = args._[1];
  const dir = dirOf(args);
  ensureStateDir(dir);
  if (sub === "add") {
    // Works purely on local state (registry + repo memory + git), like
    // `sites add` — no daemon needed. Memory linkage is written on create.
    const ws = createWorkspace(dir, {
      owner: String(need(args, "owner")),
      slug: String(need(args, "slug")),
      name: String(need(args, "name")),
      description: args.description ? String(args.description) : undefined,
      repos: csv(args.repos),
      siteIds: csv(args.sites),
      actor: "cli",
    });
    console.log(`workspace ${ws.owner}/${ws.slug} (${ws.id}) — ${ws.name}`);
    for (const r of ws.repos) console.log(`  repo: ${r}`);
    for (const s of ws.siteIds) console.log(`  site: ${s}`);
    console.log(`  memory linkage written to member repos (workspace core block)`);
  } else if (sub === "list") {
    const all = listWorkspaces(dir, { owner: args.owner ? String(args.owner) : undefined });
    if (!all.length) { console.log("(no workspaces)"); return; }
    for (const w of all) {
      console.log(`${w.id.slice(0, 12)}…  ${w.owner}/${w.slug.padEnd(16)} ${w.name}  repos=${w.repos.length} sites=${w.siteIds.length}`);
    }
  } else if (sub === "show") {
    if (!args._[2]) { console.error("usage: workspaces show <id|slug>"); process.exit(2); }
    const ws = resolveWorkspace(dir, args._[2], { owner: args.owner ? String(args.owner) : undefined });
    console.log(JSON.stringify(workspaceStatus(dir, ws.id), null, 2));
  } else if (sub === "update") {
    if (!args._[2]) { console.error("usage: workspaces update <id|slug> [--name N] [--description D] [--add-repo O/R] [--remove-repo O/R] [--link-site ID] [--unlink-site ID]"); process.exit(2); }
    const ws = resolveWorkspace(dir, args._[2], { owner: args.owner ? String(args.owner) : undefined });
    const next = updateWorkspace(dir, ws.id, {
      name: args.name ? String(args.name) : undefined,
      description: args.description !== undefined ? String(args.description) : undefined,
      addRepos: oneOrUndef(args["add-repo"]),
      removeRepos: oneOrUndef(args["remove-repo"]),
      linkSites: oneOrUndef(args["link-site"]),
      unlinkSites: oneOrUndef(args["unlink-site"]),
    }, { actor: "cli" });
    console.log(`workspace ${next.owner}/${next.slug} (${next.id}) updated`);
    for (const r of next.repos) console.log(`  repo: ${r}`);
    for (const s of next.siteIds) console.log(`  site: ${s}`);
  } else if (sub === "remove") {
    if (!args._[2]) { console.error("usage: workspaces remove <id|slug> --confirm <slug>"); process.exit(2); }
    const ws = resolveWorkspace(dir, args._[2], { owner: args.owner ? String(args.owner) : undefined });
    deleteWorkspace(dir, ws.id, { confirm: args.confirm ? String(args.confirm) : undefined });
    console.log(`removed workspace ${ws.owner}/${ws.slug} (${ws.id}) — registry entry only; repos, sites, and memory untouched`);
  } else { console.error("usage: workspaces list|show|add|update|remove"); process.exit(2); }
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
      memoryMB: args.memory ? Number(args.memory) : undefined,
      network: args.network ? true : undefined,
      retries: args.retries ? Number(args.retries) : undefined,
    };
    if (args.args) body.args = JSON.parse(String(args.args));
    const r = await apiCall(dir, "POST", "/v1/compute/invoke", body);
    if (r.status === "done") {
      console.log(`done ok=${r.ok} (${r.durationMs}ms)`);
      if (r.ok) console.log(JSON.stringify(r.result, null, 2));
      else console.log(`error: ${r.error}`);
      if (r.logs && r.logs.length) console.log(`logs:\n${r.logs.join("\n")}`);
      if (r.metrics) console.log(`metrics: wall=${r.metrics.wallMs}ms cpu=${r.metrics.cpuMs}ms rss=${Math.round((r.metrics.peakRssBytes || 0) / 1048576)}MB`);
      if (r.billing) console.log(`billing: ${r.billing.gbSeconds} GB-s (${r.billing.billedMs}ms @ ${r.billing.memoryMB}MB)`);
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
      memoryMB: args.memory ? Number(args.memory) : undefined,
      network: args.network ? true : undefined,
      retries: args.retries ? Number(args.retries) : undefined,
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
      public: args.public ? true : undefined, // Caffeine-style: public app gets a preview URL
    };
    const r = await apiCall(dir, "POST", "/v1/compute/apps", body);
    console.log(`deployed ${r.name} -> app ${r.appId.slice(0, 12)}… (${r.status})`);
    if (r.previewUrl) console.log(`  preview: ${r.previewUrl}`);
    else if (r.preview && r.preview.note) console.log(`  preview: not enabled (${r.preview.note})`);
  } else if (sub === "apps") {
    const r = await apiCall(dir, "GET", "/v1/compute/apps");
    if (!r.apps.length) { console.log("(no apps)"); return; }
    for (const a of r.apps) console.log(`${a.appId.slice(0, 12)}…  ${a.status.padEnd(8)} ${a.name}  ${a.command}${a.port ? ` :${a.port}` : ""}${a.ready === false ? "  (port not accepting)" : ""}${a.previewUrl ? `\n  preview: ${a.previewUrl}` : ""}`);
  } else if (sub === "preview") {
    const app = need(args, "app");
    if (args.enable) {
      const r = await apiCall(dir, "POST", `/v1/compute/apps/${app}/preview`);
      console.log(r.previewUrl ? `preview enabled: ${r.previewUrl}` : `preview requested (tunnel pending: ${r.preview.note || "reconciling"})`);
    } else if (args.disable) {
      await apiCall(dir, "DELETE", `/v1/compute/apps/${app}/preview`);
      console.log("preview disabled");
    } else {
      // --show (default)
      const r = await apiCall(dir, "GET", `/v1/compute/apps/${app}`);
      const p = r.preview || {};
      console.log(`app:     ${r.name} (${r.appId.slice(0, 12)}…)`);
      console.log(`preview: ${p.enabled ? "enabled" : "disabled"}`);
      if (p.url) console.log(`url:     ${p.url}`);
      if (p.relayPort) console.log(`relay:   127.0.0.1:${p.relayPort} -> 127.0.0.1:${r.port}`);
      if (p.note) console.log(`note:    ${p.note}`);
    }
  } else if (sub === "app-status") {
    const r = await apiCall(dir, "GET", `/v1/compute/apps/${need(args, "app")}`);
    console.log(JSON.stringify(r, null, 2));
  } else if (sub === "logs") {
    const tail = args.tail ? Number(args.tail) : 100;
    const r = await apiCall(dir, "GET", `/v1/compute/apps/${need(args, "app")}/logs?tail=${tail}`);
    console.log(r.log);
  } else if (sub === "undeploy") {
    await apiCall(dir, "DELETE", `/v1/compute/apps/${need(args, "app")}`);
    console.log("undeployed");
  } else if (sub === "capacity") {
    const r = await apiCall(dir, "GET", "/v1/compute/capacity");
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.error("usage: compute invoke|invocation|map|map-status|deploy|apps|app-status|logs|undeploy|capacity|preview");
    process.exit(2);
  }
}

// ---------------------------------------------------------------- main

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
try {
  if (cmd === "init") cmdInit(args);
  else if (cmd === "daemon") await cmdDaemon(args);
  else if (cmd === "doctor") await cmdDoctor(args);
  else if (cmd === "node") await cmdNode(args);
  else if (cmd === "job") cmdJob(args);
  else if (cmd === "compute") await cmdCompute(args);
  else if (cmd === "receipts") cmdReceipts(args);
  else if (cmd === "repo") await cmdRepo(args);
  else if (cmd === "promote") await cmdPromote(args);
  else if (cmd === "memory") await cmdMemory(args);
  else if (cmd === "sites") await cmdSites(args);
  else if (cmd === "workspaces") await cmdWorkspaces(args);
  else {
    console.error("usage: swarm.mjs init|daemon|doctor|node|job|compute|receipts|repo|promote|memory|sites|workspaces");
    process.exit(2);
  }
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}
