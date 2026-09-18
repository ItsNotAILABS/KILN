/**
 * Receipts: every tool call appends one canonical-JSON receipt, signed with
 * the node's ed25519 key. Verifiable offline with the node's public key.
 *
 * File: nodes/<id>/receipts.jsonl — one JSON object per line:
 *   {"r": {v,seq,prev,node,ts,tool,args,out,ok,error}, "s": "<hex sig>"}
 * canon(r) is what gets signed. `prev` hash-chains receipts.
 */
import { openSync, writeSync, fsyncSync, closeSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { canon, sha256hex } from "./canon.mjs";

const MAX_ARG_BLOB = 512;   // max chars of a single arg value kept inline
const MAX_OUT_BLOB = 4096;  // max chars of tool output kept inline

function summarize(value, max) {
  if (value === undefined) return undefined;
  let s;
  try {
    s = typeof value === "string" ? value : canon(value);
  } catch {
    s = String(value);
  }
  if (s.length <= max) return s;
  return { truncated: true, digest: sha256hex(s), preview: s.slice(0, max) };
}

export function receiptsPath(dir, id) {
  return join(dir, "nodes", id, "receipts.jsonl");
}

function lastReceipt(dir, id) {
  const p = receiptsPath(dir, id);
  if (!existsSync(p)) return null;
  const lines = readFileSync(p, "utf8").split("\n").filter((l) => l.trim());
  if (!lines.length) return null;
  return JSON.parse(lines[lines.length - 1]);
}

/**
 * Append a signed receipt. args/result are summarized (bounded) but
 * digests of the full values are kept, so tampering is detectable.
 */
export function appendReceipt(dir, id, keypair, tool, args, result) {
  const last = lastReceipt(dir, id);
  const seq = last ? last.r.seq + 1 : 0;
  const prev = last ? sha256hex(canon(last.r)) : "GENESIS";
  const r = {
    v: 1,
    seq,
    prev,
    node: id,
    ts: Math.floor(Date.now() / 1000),
    tool,
    args: summarize(args, MAX_ARG_BLOB * 8),
    ok: !!result.ok,
    out: summarize(result.out, MAX_OUT_BLOB),
    error: result.ok ? null : summarize(result.error, MAX_OUT_BLOB),
  };
  const s = keypair.signText(canon(r));
  const line = JSON.stringify({ r, s }) + "\n";
  const fd = openSync(receiptsPath(dir, id), "a");
  try {
    writeSync(fd, line);
    fsyncSync(fd); // durable before we report success
  } finally {
    closeSync(fd);
  }
  return { r, s };
}

/** Verify the full chain offline. Returns {ok, count, error?}. */
export function verifyReceipts(dir, id, keypairOrPub) {
  const p = receiptsPath(dir, id);
  if (!existsSync(p)) return { ok: true, count: 0 };
  const lines = readFileSync(p, "utf8").split("\n").filter((l) => l.trim());
  let prev = "GENESIS";
  for (let i = 0; i < lines.length; i++) {
    let rec;
    try {
      rec = JSON.parse(lines[i]);
    } catch (e) {
      return { ok: false, count: i, error: `line ${i}: not valid JSON` };
    }
    const { r, s } = rec;
    if (!r || typeof s !== "string") return { ok: false, count: i, error: `line ${i}: bad shape` };
    if (r.seq !== i) return { ok: false, count: i, error: `line ${i}: seq ${r.seq} != ${i}` };
    if (r.prev !== prev) return { ok: false, count: i, error: `line ${i}: hash chain broken` };
    if (r.node !== id) return { ok: false, count: i, error: `line ${i}: node mismatch` };
    if (!keypairOrPub.verifyText(canon(r), s)) {
      return { ok: false, count: i, error: `line ${i}: bad signature` };
    }
    prev = sha256hex(canon(r));
  }
  return { ok: true, count: lines.length };
}
