/**
 * detective.mjs — the Detective agent.
 *
 * Mines the death journal (deaths.jsonl) for patterns and emits a
 * clearly-labeled leading HYPOTHESIS — never a conclusion. Below 3 recorded
 * deaths it returns "insufficient-data" and never fabricates a root cause.
 *
 * Signals: median death interval, UTC time-of-day histogram (60% clustering
 * rule), stale-heartbeat fraction with recurring-name detection, available-
 * memory trend, OOM-killer evidence, and the tick-age wedge check: when the
 * most recent death's last completed tick is older than 5 minutes, the
 * supervised loop wedged — CONFIRMED, not hypothesized.
 */
import { readJournal, medianOf, fmtDur } from "./helpers.mjs";

export const MIN_DEATHS_FOR_DIAGNOSIS = 3;
export const WEDGE_CONFIRM_MS = 300000; // 5 minutes

/**
 * Mine the death journal for patterns. Returns:
 *   { verdict: "insufficient-data" | "hypothesis", deaths, hypothesis, …signals }
 */
export function diagnose(dir) {
  const deaths = readJournal(dir)
    .filter((e) => e.type === "death" && Number.isFinite(Date.parse(e.ts)))
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  if (deaths.length < MIN_DEATHS_FOR_DIAGNOSIS) {
    return {
      verdict: "insufficient-data",
      deaths: deaths.length,
      hypothesis: `insufficient data — need at least ${MIN_DEATHS_FOR_DIAGNOSIS} recorded deaths to form a hypothesis (have ${deaths.length}). The doctor keeps watching; every death is journaled.`,
    };
  }
  const ts = deaths.map((e) => Date.parse(e.ts));
  const intervals = ts.slice(1).map((t, i) => t - ts[i]);
  const medianIntervalMs = medianOf(intervals);

  const tod = new Array(24).fill(0);
  for (const t of ts) tod[new Date(t).getUTCHours()]++;
  const peakHour = tod.indexOf(Math.max(...tod));
  const clustered = tod[peakHour] >= Math.ceil(deaths.length * 0.6);

  const withStale = deaths.filter((e) => (e.preDeathStaleWorkers || []).length > 0);
  const staleFrac = withStale.length / deaths.length;
  const nameCounts = {};
  for (const e of deaths) {
    for (const n of e.preDeathStaleWorkers || []) nameCounts[n] = (nameCounts[n] || 0) + 1;
  }
  const recurring = Object.entries(nameCounts)
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([n, c]) => `${n} x${c}`);

  const mems = deaths.map((e) => e.memAvailableMb).filter((m) => Number.isFinite(m));
  const memTrendMb = mems.length >= 2 ? mems[mems.length - 1] - mems[0] : null;
  const oomDeaths = deaths.filter((e) => e.oomEvidence);

  // The wedge check: the freshest death carries the freshest evidence. If the
  // subject's own tick tracker says its last completed tick predates the
  // death by more than 5 minutes, the supervised loop wedged — confirmed.
  const tickAges = deaths.map((e) => e.lastTickAgeMs).filter((a) => Number.isFinite(a));
  const recentTickAgeMs = tickAges.length ? tickAges[tickAges.length - 1] : null;
  const wedgeConfirmed = Number.isFinite(recentTickAgeMs) && recentTickAgeMs > WEDGE_CONFIRM_MS;

  const parts = [];
  parts.push(`${deaths.length} deaths recorded; median interval ${fmtDur(medianIntervalMs)}.`);
  parts.push(clustered
    ? `Time-of-day clustering: ${tod[peakHour]}/${deaths.length} deaths fell in the ${String(peakHour).padStart(2, "0")}:00 UTC hour.`
    : "No strong time-of-day clustering.");
  parts.push(staleFrac >= 0.5
    ? `${withStale.length}/${deaths.length} deaths were preceded by stale worker heartbeats${recurring.length ? ` (recurring: ${recurring.join(", ")})` : ""}.`
    : "Stale worker heartbeats did not consistently precede deaths.");
  parts.push(oomDeaths.length
    ? `dmesg showed OOM-killer activity in the capture window of ${oomDeaths.length} death(s).`
    : "No OOM-killer evidence in dmesg at any death.");
  if (memTrendMb !== null) {
    parts.push(`Available memory trend across deaths: ${memTrendMb >= 0 ? "+" : ""}${memTrendMb} MB (first to last).`);
  }
  if (Number.isFinite(recentTickAgeMs)) {
    parts.push(`The most recent death's last completed tick was ${fmtDur(recentTickAgeMs)} before the death was detected.`);
  }

  let lead;
  if (wedgeConfirmed) {
    lead = `Leading hypothesis: the wedge is CONFIRMED — last completed tick was ${fmtDur(recentTickAgeMs)} before death — the supervised loop wedged. Recommend: instrument tick duration and add an internal self-abort when ticks stall.`;
  } else if (oomDeaths.length > 0) {
    lead = "Leading hypothesis: the OOM killer is terminating the subject under memory pressure. Recommend: raise host memory or cap worker concurrency, then watch whether deaths stop.";
  } else if (staleFrac >= 2 / 3) {
    lead = "Leading hypothesis: the subject's tick loop wedges (stale worker heartbeats precede death, no OOM evidence) — the process stops making progress without being killed. Recommend: instrument tick duration and add an internal self-abort when ticks stall.";
  } else if (clustered) {
    lead = "Leading hypothesis: an external scheduled actor (cron, host maintenance) kills the subject at a fixed hour. Recommend: correlate death times with host cron/at logs.";
  } else {
    lead = "No single dominant signal — deaths look irregular. Recommend: keep collecting; each new death sharpens the picture.";
  }
  return {
    verdict: "hypothesis",
    deaths: deaths.length,
    medianIntervalMs,
    todHistogram: tod,
    staleHeartbeatFraction: staleFrac,
    recurringStaleWorkers: recurring,
    memTrendMb,
    oomDeaths: oomDeaths.length,
    wedgeConfirmed,
    lastTickAgeMs: Number.isFinite(recentTickAgeMs) ? recentTickAgeMs : null,
    hypothesis: parts.join(" ") + " " + lead,
  };
}

export class Detective {
  constructor({ dir }) {
    this.dir = dir;
    this.lastVerdict = null;
  }

  async start() {}
  async stop() {}

  async diagnose() {
    const d = diagnose(this.dir);
    this.lastVerdict = d;
    return d;
  }

  status() {
    return { running: true, lastVerdict: this.lastVerdict };
  }
}
