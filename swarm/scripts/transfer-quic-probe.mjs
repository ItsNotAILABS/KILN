#!/usr/bin/env node
/**
 * transfer-quic-probe.mjs — reproduces the QUIC measurement behind the
 * transport decision in docs/KILN_AGENT_TRANSFER.md.
 *
 * Node 24 ships no `node:quic`, so this probes the best-maintained userland
 * option, @matrixai/quic (quiche via N-API). It is NOT a KILN dependency:
 *
 *   mkdir /tmp/qp && cd /tmp/qp && npm i @matrixai/quic
 *   KILN_QUIC_DIR=/tmp/qp node swarm/scripts/transfer-quic-probe.mjs [MiB]
 *
 * Same shape as the TCP bench: 64 B round trips on one connection, then MiB
 * over 8 parallel streams with 1 MiB writes, both on 127.0.0.1.
 */
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { webcrypto, randomBytes } from "node:crypto";

let quic;
try {
  quic = await import(pathToFileURL(join(process.env.KILN_QUIC_DIR || process.cwd(), "node_modules/@matrixai/quic/dist/index.js")).href);
} catch {
  console.error("@matrixai/quic is not installed — see the header of this script"); process.exit(2);
}
const { QUICServer, QUICClient, events } = quic;
const d = mkdtempSync(join(tmpdir(), "kiln-quic-"));
execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1",
  "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", join(d, "key.pem"), "-out", join(d, "cert.pem")], { stdio: "ignore" });
const hmac = await webcrypto.subtle.exportKey("raw", await webcrypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, true, ["sign"]));
const imp = (k, u) => webcrypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, [u]);
const ops = {
  randomBytes: async (b) => { webcrypto.getRandomValues(new Uint8Array(b)); },
  sign: async (k, data) => webcrypto.subtle.sign("HMAC", await imp(k, "sign"), data),
  verify: async (k, data, sig) => webcrypto.subtle.verify("HMAC", await imp(k, "verify"), sig, data),
};
const big = { initialMaxData: 64 << 20, initialMaxStreamDataBidiLocal: 16 << 20, initialMaxStreamDataBidiRemote: 16 << 20,
  initialMaxStreamDataUni: 16 << 20, readableChunkSize: 64 * 1024 };
const server = new QUICServer({ crypto: { key: hmac, ops },
  config: { key: readFileSync(join(d, "key.pem"), "utf8"), cert: readFileSync(join(d, "cert.pem"), "utf8"), verifyPeer: false, ...big } });
let got = 0;
server.addEventListener(events.EventQUICServerConnection.name, (e) => {
  e.detail.addEventListener(events.EventQUICConnectionStream.name, async (se) => {
    const s = se.detail;
    for await (const c of s.readable) got += c.length;
    const w = s.writable.getWriter(); await w.write(new Uint8Array(2)); await w.close();
  });
});
await server.start({ host: "127.0.0.1", port: 0 });
const client = await QUICClient.createQUICClient({ host: "127.0.0.1", port: server.port, crypto: { ops: { randomBytes: ops.randomBytes } },
  config: { verifyPeer: false, ...big } });
const lat = [];
for (let i = 0; i < 50; i++) {
  const a = performance.now();
  const s = client.connection.newStream();
  const w = s.writable.getWriter(); await w.write(new Uint8Array(64)); await w.close();
  for await (const _ of s.readable) { /* drain */ }
  lat.push(performance.now() - a);
}
lat.sort((a, b) => a - b);
console.log(`QUIC 64 B stream round trip: p50 ${lat[25].toFixed(2)} ms, p99 ${lat[49].toFixed(2)} ms (n=50)`);
const N = Number(process.argv[2] || 256) * 2 ** 20, P = 8, buf = randomBytes(1 << 20);
got = 0; const t0 = performance.now();
await Promise.all(Array.from({ length: P }, async () => {
  const s = client.connection.newStream(); const w = s.writable.getWriter();
  for (let sent = 0; sent < N / P; sent += buf.length) await w.write(buf);
  await w.close(); for await (const _ of s.readable) { /* drain */ }
}));
const dt = (performance.now() - t0) / 1000;
console.log(`QUIC ${N / 2 ** 20} MiB over ${P} streams: ${(N / 2 ** 20 / dt).toFixed(1)} MiB/s (${dt.toFixed(2)} s, received ${got} bytes)`);
await client.destroy({ force: true }); await server.stop({ force: true });
rmSync(d, { recursive: true, force: true });
