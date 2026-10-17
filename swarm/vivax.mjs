#!/usr/bin/env node
// VIVAX — stay-alive protocol for the KILN Daemon (δαίμων).
//
// KILN-native since 2026-10-17 (the architect: "update this to kiln's own
// infra"). Lives in swarm/ beside swarm.mjs; runtime home (log + dedupe
// state) is <state-dir>/vivax/. The old ~/workspace/ops/vivax/vivax.mjs is
// a forwarding shim kept for stale references.
//
// Standing directive (the architect, 2026-10-15): when the Daemon dies and
// the Medicus (the KILN doctor) latches recoveryExhausted, VIVAX clears the
// latch automatically so the Medicus's own Sanator starts the Daemon under
// supervision. No per-incident approval — the protocol IS the approval.
//
// Fence-aware extension (the architect, 2026-10-17, from the 2026-10-16
// FENCE_FIX_DRAFT): a foreign-alive Daemon — healthy API, but its bootId
// does not match the Medicus's fence (expectedBootId) — is NOT healthy.
// The outside booter restarts the Daemon within ~1 minute of a death, so
// the down+exhausted window almost never occurs; on 2026-10-16 two
// foreign boots (1697, 1712) held the service unsupervised for hours
// while VIVAX logged "pulsus ok · Medicus exhausted=true". Rule now:
//   foreign-alive ∧ Medicus still has budget → stand down (its budget
//     runs first, exactly like the down case).
//   foreign-alive ∧ recoveryExhausted latched → hand-back: the SAME
//     proven latch-clear act. The Medicus's recovery authority then
//     restarts the fenced Daemon under supervision or re-stamps the fence
//     onto it — VIVAX never starts or stops the Daemon directly, ever.
//
// Nomina: VIVAX protocol · Medicus = doctor · its agents Vigil (watcher),
// Examinator (coroner), Inquisitor (detective), Sanator (medic) ·
// Daemon stays Greek (δαίμων).
//
// Stdout carries exactly ONE structured result line; everything else is
// written to vivax.log in the runtime home.
//   VIVAX HEALTHY       bootId=<id> medicus=ok
//   VIVAX ACTED         death=<deathId> bootId=<newBootId> health=ok port8901=<code>
//   VIVAX ACTED         death=<deathId> reason=fence-handback mode=<adopted|restarted> bootId=<bootId> health=ok port8901=<code>
//   VIVAX FAILED        death=<deathId|-> reason=<token> [facts...]
//   VIVAX STANDING-DOWN death=<deathId|-> reason=<medicus-recovering|foreign-alive-medicus-working>
// Exit: 0 = HEALTHY / ACTED / STANDING-DOWN · 2 = FAILED.
// Dedupe: one act per death id (down case) and one per foreign bootId
// (fence case, key fence@<bootId>), recorded in vivax-state.json. Never loops.
//
// Env overrides (tests + nonstandard layouts):
//   KILN_SWARM_DIR — the daemon state dir (default ~/.kiln-swarm)
//   VIVAX_HOME     — log/state home (default <state-dir>/vivax)

import { readFileSync, writeFileSync, appendFileSync, copyFileSync, renameSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const KILN = process.env.KILN_SWARM_DIR || join(homedir(), '.kiln-swarm');
const HOME_DIR = process.env.VIVAX_HOME || join(KILN, 'vivax');
const LOG = join(HOME_DIR, 'vivax.log');
const VSTATE = join(HOME_DIR, 'vivax-state.json');
const MEDICUS_STATE = join(KILN, 'doctor', 'state.json'); // Medicus state
const DAEMON_JSON = join(KILN, 'daemon.json');           // live Daemon identity
const TOKEN_FILE = join(KILN, 'api.token');               // read, never printed
const SWARM = join(HERE, 'swarm.mjs');
const API = 'http://127.0.0.1:18787';
const VERIFY_DEADLINE_MS = 150_000;
const VERIFY_POLL_MS = 3_000;

// ---------------------------------------------------------------- decision
// Pure decision core — unit-tested in test/vivax.test.mjs. No I/O here.
/**
 * @param {{healthy:boolean, medicusReadable:boolean, liveBootId:?string,
 *          expectedBootId:?string, exhausted:boolean}} s
 * @returns {{action:'healthy'|'stand-down'|'act-down'|'act-fence'|'fail', reason:string, foreign:boolean}}
 */
export function decideVivax(s) {
  const foreign = !!(s.liveBootId && s.expectedBootId && s.liveBootId !== s.expectedBootId);
  if (s.healthy) {
    if (!foreign) return { action: 'healthy', reason: 'fence-match', foreign: false };
    if (!s.exhausted) return { action: 'stand-down', reason: 'foreign-alive-medicus-working', foreign: true };
    return { action: 'act-fence', reason: 'fence-handback', foreign: true };
  }
  if (!s.medicusReadable) return { action: 'fail', reason: 'medicus-state-unreadable', foreign };
  if (!s.exhausted) return { action: 'stand-down', reason: 'medicus-recovering', foreign };
  return { action: 'act-down', reason: 'stay-alive', foreign };
}

// ---------------------------------------------------------------- helpers
const nowIso = () => new Date().toISOString();
function log(line) {
  try {
    mkdirSync(HOME_DIR, { recursive: true });
    appendFileSync(LOG, `[${nowIso()}] ${line}\n`);
  } catch { /* logging never kills the protocol */ }
}
function emit(line, code) {
  process.stdout.write(line + '\n');
  process.exit(code);
}
function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}
function fetchTimeout(url, opts = {}, ms = 4000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  return fetch(url, { ...opts, signal: ctl.signal }).finally(() => clearTimeout(t));
}
async function daemonHealth() {
  try {
    const token = readFileSync(TOKEN_FILE, 'utf8').trim();
    const r = await fetchTimeout(`${API}/health`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return false;
    const j = await r.json().catch(() => null);
    return !!(j && j.ok === true);
  } catch { return false; }
}
async function portAnswers(port) {
  try {
    const r = await fetchTimeout(`http://127.0.0.1:${port}/`, {}, 3000);
    return r.status; // any HTTP status = the port answers
  } catch { return 0; }
}
function runSwarm(args) {
  return new Promise((resolve) => {
    execFile('node', [SWARM, ...args], { timeout: 90_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- the act
// The one proven act, shared by the down case and the fence hand-back:
// Medicus stop → timestamped state backup → clear exactly the latch fields
// → Medicus start → verify health ∧ fence == live bootId ∧ :8901 answers.
// VIVAX never starts or stops the Daemon itself.
async function act({ dedupeKey, deathId, mode, foreignBootId }) {
  const vstate = readJson(VSTATE) || { actions: {} };
  vstate.actions = vstate.actions || {};
  if (vstate.actions[dedupeKey]) {
    log(`‼ FAILED death=${deathId} reason=already-acted outcome=${vstate.actions[dedupeKey].outcome} — VIVAX acted on ${dedupeKey} once and will not loop. Manual attention required.`);
    emit(`VIVAX FAILED death=${deathId} reason=already-acted outcome=${vstate.actions[dedupeKey].outcome}`, 2);
  }

  log(`ACTING death=${deathId} mode=${mode} — clearing the Medicus exhaustion latch (VIVAX protocol, standing directive).`);

  // a · Medicus stop (non-fatal if already stopped; start is the key half).
  const stop = await runSwarm(['doctor', 'stop', '--dir', KILN]);
  if (stop.err) log(`doctor stop note: ${stop.err.message} stderr=${stop.stderr.trim().slice(-300)}`);
  else log(`Medicus stopped. ${stop.stdout.trim().slice(-200)}`);

  // b · Backup the Medicus state — kept, timestamped, never deleted.
  const medicus = readJson(MEDICUS_STATE);
  if (!medicus) {
    log(`‼ FAILED death=${deathId} reason=medicus-state-unreadable — aborting before any state edit.`);
    emit(`VIVAX FAILED death=${deathId} reason=medicus-state-unreadable`, 2);
  }
  const stamp = nowIso().replace(/[:.]/g, '');
  const backup = `${MEDICUS_STATE}.bak-vivax-${stamp}`;
  try {
    copyFileSync(MEDICUS_STATE, backup);
    log(`Medicus state backed up → ${backup}`);
  } catch (e) {
    log(`‼ FAILED death=${deathId} reason=backup-failed ${e.message} — aborting before any state edit.`);
    emit(`VIVAX FAILED death=${deathId} reason=backup-failed`, 2);
  }

  // c · Clear the latch — exactly the proven field set, nothing else.
  const cleared = { ...medicus };
  cleared.recoveryExhausted = false;
  cleared.recoveryAttempts = 0;
  cleared.nextRecoveryRetryTs = 0;
  cleared.expectedBootId = null;
  cleared.expectedStartId = null;
  delete cleared.recoveryExhaustedTs;
  try {
    const tmp = `${MEDICUS_STATE}.vivax-tmp`;
    writeFileSync(tmp, JSON.stringify(cleared, null, 2) + '\n');
    renameSync(tmp, MEDICUS_STATE);
    log('Latch cleared: recoveryExhausted=false recoveryAttempts=0 nextRecoveryRetryTs=0 expectedBootId=null expectedStartId=null');
  } catch (e) {
    log(`‼ FAILED death=${deathId} reason=state-edit-failed ${e.message}`);
    emit(`VIVAX FAILED death=${deathId} reason=state-edit-failed`, 2);
  }

  // Record the act BEFORE verification — dedupe holds whatever happens next.
  vstate.actions[dedupeKey] = { at: nowIso(), outcome: 'acted-unverified', backup, mode };
  try { mkdirSync(HOME_DIR, { recursive: true }); writeFileSync(VSTATE, JSON.stringify(vstate, null, 2) + '\n'); } catch (e) { log(`vivax-state write failed: ${e.message}`); }

  // d · Medicus start — its Sanator/recovery authority handles the Daemon.
  const start = await runSwarm(['doctor', 'start', '--dir', KILN]);
  if (start.err) {
    vstate.actions[dedupeKey].outcome = 'acted-failed-doctor-start';
    try { writeFileSync(VSTATE, JSON.stringify(vstate, null, 2) + '\n'); } catch { /* logged below */ }
    log(`‼ FAILED death=${deathId} reason=doctor-start-failed ${start.err.message} stderr=${start.stderr.trim().slice(-300)}`);
    emit(`VIVAX FAILED death=${deathId} reason=doctor-start-failed`, 2);
  }
  log(`Medicus started. ${start.stdout.trim().slice(-200)}`);

  // e · Verify: health ok ∧ fence (expectedBootId) == live Daemon bootId ∧ :8901 answers.
  // Fence mode: the final bootId tells us which hand-back happened — equal to
  // the foreign boot means the Medicus re-stamped/adopted it; different means
  // its recovery authority restarted the Daemon under supervision.
  const deadline = Date.now() + VERIFY_DEADLINE_MS;
  let lastFacts = '';
  while (Date.now() < deadline) {
    await sleep(VERIFY_POLL_MS);
    const h = await daemonHealth();
    const ms = readJson(MEDICUS_STATE);
    const dj = readJson(DAEMON_JSON);
    const p8901 = h ? await portAnswers(8901) : 0;
    lastFacts = `health=${h} expectedBootId=${ms?.expectedBootId || '-'} daemonBootId=${dj?.bootId || '-'} port8901=${p8901}`;
    if (h && ms?.expectedBootId && dj?.bootId && ms.expectedBootId === dj.bootId && p8901 > 0) {
      vstate.actions[dedupeKey].outcome = 'acted-verified';
      vstate.actions[dedupeKey].newBootId = dj.bootId;
      try { writeFileSync(VSTATE, JSON.stringify(vstate, null, 2) + '\n'); } catch { /* non-fatal */ }
      if (mode === 'fence') {
        const how = dj.bootId === foreignBootId ? 'adopted' : 'restarted';
        vstate.actions[dedupeKey].handback = how;
        try { writeFileSync(VSTATE, JSON.stringify(vstate, null, 2) + '\n'); } catch { /* non-fatal */ }
        log(`✓ HANDBACK death=${deathId} — foreign boot ${foreignBootId} ${how === 'adopted' ? 'adopted by' : 'restarted under'} Medicus. ${lastFacts}`);
        emit(`VIVAX ACTED death=${deathId} reason=fence-handback mode=${how} bootId=${dj.bootId} health=ok port8901=${p8901}`, 0);
      }
      log(`✓ ACTED death=${deathId} — Daemon alive under Medicus. ${lastFacts}`);
      emit(`VIVAX ACTED death=${deathId} bootId=${dj.bootId} health=ok port8901=${p8901}`, 0);
    }
  }
  vstate.actions[dedupeKey].outcome = 'acted-failed-verify';
  try { writeFileSync(VSTATE, JSON.stringify(vstate, null, 2) + '\n'); } catch { /* non-fatal */ }
  log(`‼ FAILED death=${deathId} reason=verify-timeout ${lastFacts} — VIVAX does not retry. Manual attention required.`);
  emit(`VIVAX FAILED death=${deathId} reason=verify-timeout ${lastFacts}`, 2);
}

// ---------------------------------------------------------------- main
async function main() {
  const healthy = await daemonHealth();
  const medicus = readJson(MEDICUS_STATE);
  const daemonJson = readJson(DAEMON_JSON);
  const liveBootId = daemonJson?.bootId || null;
  const expectedBootId = medicus?.expectedBootId || null;

  const d = decideVivax({
    healthy,
    medicusReadable: !!medicus,
    liveBootId,
    expectedBootId,
    exhausted: medicus?.recoveryExhausted === true,
  });
  const deathId = medicus?.lastHandledDeathId || `exhausted@${medicus?.lastRecoveryAttemptTs || 'unknown'}`;

  if (d.action === 'healthy') {
    const shown = liveBootId || expectedBootId || '-';
    log(`pulsus ok · Daemon bootId=${shown} · fence=${liveBootId && expectedBootId ? 'match' : 'unstamped'} · Medicus exhausted=${medicus?.recoveryExhausted === true}`);
    emit(`VIVAX HEALTHY bootId=${shown} medicus=ok`, 0);
  }
  if (d.action === 'fail') {
    log('‼ FAILED reason=medicus-state-unreadable — Daemon health check failed and doctor state.json could not be read. No action taken.');
    emit('VIVAX FAILED death=- reason=medicus-state-unreadable', 2);
  }
  if (d.action === 'stand-down') {
    if (d.foreign) {
      log(`foreign-alive · Daemon bootId=${liveBootId} != Medicus fence ${expectedBootId} · standing down — Medicus recovery still in progress (attempts=${medicus.recoveryAttempts}) death=${deathId}`);
    } else {
      log(`standing down · Daemon down, Medicus recovery still in progress (attempts=${medicus.recoveryAttempts}) death=${deathId}`);
    }
    emit(`VIVAX STANDING-DOWN death=${deathId} reason=${d.reason}`, 0);
  }
  if (d.action === 'act-fence') {
    log(`foreign-alive ∧ exhausted · Daemon bootId=${liveBootId} != Medicus fence ${expectedBootId} · hand-back warranted death=${deathId}`);
    await act({ dedupeKey: `fence@${liveBootId}`, deathId, mode: 'fence', foreignBootId: liveBootId });
    return;
  }
  // act-down: the original proven state — Daemon down + latch exhausted.
  await act({ dedupeKey: deathId, deathId, mode: 'down', foreignBootId: null });
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().catch((e) => {
    log(`‼ FAILED reason=exception ${e?.stack || e}`);
    emit(`VIVAX FAILED death=- reason=exception message=${String(e?.message || e).replace(/\s+/g, '_')}`, 2);
  });
}
