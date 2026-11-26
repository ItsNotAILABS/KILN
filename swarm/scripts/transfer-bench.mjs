#!/usr/bin/env node
/**
 * transfer-bench.mjs — measured throughput + latency for KILN agent transfer.
 *
 *   node swarm/scripts/transfer-bench.mjs [--mb 1024] [--runs 3] [--json]
 *
 * The receiver is a separate `swarm.mjs recv` process; the sender runs in
 * this process (sendFile). Everything is on one host over 127.0.0.1, and the
 * source file sits in the page cache, so these are loopback/CPU numbers, not
 * a network-link measurement. Reports medians of --runs runs.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, openSync, writeSync, closeSync, rmSync, writeFileSync } from "node:fs";
import { randomFillSync } from "node:crypto";
import { tmpdir, cpus, totalmem } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sendFile, generateKeypair, pingLatency } from "../lib/transfer.mjs";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const MB = Number(opt("mb", 1024)), RUNS = Number(opt("runs", 3)), JSON_OUT = argv.includes("--json");
const SWARM = join(dirname(fileURLToPath(import.meta.url)), "..", "swarm.mjs");
const root = mkdtempSync(join(tmpdir(), "kiln-tx-bench-"));
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

function makeFile(path, mb) {
  const fd = openSync(path, "w"); const buf = Buffer.allocUnsafe(4 << 20);
  for (let i = 0; i < Math.ceil(mb / 4); i++) { randomFillSync(buf); writeSync(fd, buf); }
  closeSync(fd);
}

async function main() {
  const rx = spawn(process.execPath, [SWARM, "recv", "--dir", join(root, "rx"), "--out", join(root, "out"), "--overwrite"],
    { stdio: ["ignore", "pipe", "inherit"] });
  const address = await new Promise((res) => {
    let buf = "";
    const on = (d) => {
      buf += d; const i = buf.indexOf("\n");
      if (i >= 0) { rx.stdout.off("data", on); res(JSON.parse(buf.slice(0, i)).address); }
    };
    rx.stdout.on("data", on);
  });
  rx.stdout.resume();
  const host = address.slice(0, address.lastIndexOf(":")), port = Number(address.slice(address.lastIndexOf(":") + 1));
  const kp = generateKeypair();
  const results = { host: { cpus: cpus().length, model: cpus()[0]?.model, memGiB: +(totalmem() / 2 ** 30).toFixed(1), node: process.version },
    sizeMiB: MB, runs: RUNS, throughput: [], latency: {} };

  const big = join(root, "big.bin"); makeFile(big, MB);
  const configs = [
    { label: "8 streams, RS 16+2 (default)", streams: 8, parityShards: 2 },
    { label: "8 streams, no parity", streams: 8, parityShards: 0 },
    { label: "4 streams, RS 16+2", streams: 4, parityShards: 2 },
    { label: "1 stream, RS 16+2", streams: 1, parityShards: 2 },
  ];
  for (const c of configs) {
    const runs = [];
    for (let i = 0; i < RUNS; i++) runs.push(await sendFile(big, { host, port, keypair: kp, streams: c.streams, parityShards: c.parityShards }));
    results.throughput.push({
      config: c.label,
      wireMiBps: +median(runs.map((r) => r.throughputMBps)).toFixed(1),
      wireSeconds: +median(runs.map((r) => r.transferSeconds)).toFixed(3),
      hashSeconds: +median(runs.map((r) => r.hashSeconds)).toFixed(3),
      endToEndMiBps: +median(runs.map((r) => r.bytes / 2 ** 20 / r.totalSeconds)).toFixed(1),
      wireBytesPerFileByte: +(runs[0].wireBytes / runs[0].bytes).toFixed(3),
      senderPeakRssMB: Math.max(...runs.map((r) => r.peakRssMB)),
    });
  }

  results.latency.ping64B = await pingLatency({ host, port, count: 1000, size: 64, keypair: kp });
  const tiny = join(root, "tiny.txt");
  const tinyMs = [];
  for (let i = 0; i < 100; i++) {
    writeFileSync(tiny, `${i}`.padEnd(1024, "x")); // new content each time -> a fresh manifest, no resume shortcut
    const t0 = performance.now();
    await sendFile(tiny, { host, port, keypair: kp, streams: 1, workers: 1 });
    tinyMs.push(performance.now() - t0);
  }
  tinyMs.sort((a, b) => a - b);
  results.latency.file1KiB = { count: 100, p50: tinyMs[50], p90: tinyMs[90], p99: tinyMs[99], min: tinyMs[0] };

  rx.kill("SIGTERM");
  rmSync(root, { recursive: true, force: true });
  if (JSON_OUT) { console.log(JSON.stringify(results, null, 2)); return; }
  console.log(`KILN agent transfer bench — ${MB} MiB, median of ${RUNS}, ${results.host.cpus} CPU ${results.host.model}, Node ${results.host.node}`);
  console.log("| config | wire MiB/s | wire s | hash s | end-to-end MiB/s | wire/file bytes | sender peak RSS MB |");
  console.log("|---|---|---|---|---|---|---|");
  for (const t of results.throughput) console.log(`| ${t.config} | ${t.wireMiBps} | ${t.wireSeconds} | ${t.hashSeconds} | ${t.endToEndMiBps} | ${t.wireBytesPerFileByte} | ${t.senderPeakRssMB} |`);
  const L = results.latency;
  console.log(`ping 64 B on an open connection: p50 ${L.ping64B.p50.toFixed(3)} ms, p99 ${L.ping64B.p99.toFixed(3)} ms (n=1000)`);
  console.log(`1 KiB file, full send (connect + signed manifest + verify + write + confirm): p50 ${L.file1KiB.p50.toFixed(2)} ms, p99 ${L.file1KiB.p99.toFixed(2)} ms (n=100)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
