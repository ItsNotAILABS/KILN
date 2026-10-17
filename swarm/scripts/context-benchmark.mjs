#!/usr/bin/env node
/**
 * Benchmark Context Fabric against a naive full-text baseline.
 *
 * This is deliberately model-neutral. It measures transport/input volume,
 * retrieval latency, cache reuse and answer-evidence recall for labeled queries.
 * It does NOT claim billed-token savings until an actual tokenizer/provider
 * measurement is supplied.
 *
 * Usage:
 *   node scripts/context-benchmark.mjs --repo /path/to/repo --cases cases.json
 *
 * cases.json:
 * [
 *   {"query":"github approval promotion","expectedPaths":["src/policy.js"]},
 *   {"query":"receipt verification","expectedPaths":["lib/receipts.mjs"]}
 * ]
 */
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { buildContextIndex, queryContextIndex } from "../lib/context-index.mjs";

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const k = argv[i].slice(2);
    const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    out[k] = v;
  }
  return out;
}

function trackedTextBytes(repo) {
  const names = execFileSync("git", ["-C", repo, "ls-files", "-z"]).toString("utf8").split("\0").filter(Boolean);
  let bytes = 0;
  for (const p of names) {
    try {
      const b = readFileSync(join(repo, p));
      if (!b.includes(0)) bytes += b.length;
    } catch {}
  }
  return bytes;
}

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a,b)=>a-b);
  const m = Math.floor(s.length/2);
  return s.length % 2 ? s[m] : (s[m-1]+s[m])/2;
}

function percentile(xs, p) {
  if (!xs.length) return 0;
  const s=[...xs].sort((a,b)=>a-b);
  return s[Math.min(s.length-1, Math.max(0, Math.ceil(p*s.length)-1))];
}

const a=args(process.argv.slice(2));
if (!a.repo || !a.cases) {
  console.error("usage: context-benchmark.mjs --repo PATH --cases FILE [--max-bytes N] [--max-chunks N]");
  process.exit(2);
}
const repo=resolve(String(a.repo));
const cases=JSON.parse(readFileSync(resolve(String(a.cases)),"utf8"));
if (!Array.isArray(cases) || !cases.length) throw new Error("cases must be a non-empty JSON array");
const state=mkdtempSync(join(tmpdir(),"kiln-context-bench-"));
try {
  const t0=performance.now();
  const index=buildContextIndex(repo,state);
  const indexMs=performance.now()-t0;
  const baselineBytes=trackedTextBytes(repo);
  const rows=[];
  let knownHashes={};
  for (const c of cases) {
    const q0=performance.now();
    const pack=queryContextIndex(index,c.query,{
      maxBytes:Number(a["max-bytes"]||24000),
      maxChunks:Number(a["max-chunks"]||12),
    });
    const queryMs=performance.now()-q0;
    const emittedPaths=new Set(pack.items.map(x=>x.path));
    const expected=Array.isArray(c.expectedPaths)?c.expectedPaths:[];
    const hits=expected.filter(p=>emittedPaths.has(p)).length;
    const recall=expected.length?hits/expected.length:null;
    const bytes=pack.stats.emittedBytes;
    rows.push({
      query:c.query,
      baselineBytes,
      fabricBytes:bytes,
      byteReduction:baselineBytes?1-bytes/baselineBytes:null,
      tokenEstimate:pack.stats.tokenEstimate,
      latencyMs:queryMs,
      expectedPaths:expected,
      pathRecall:recall,
      emittedPaths:[...emittedPaths],
    });
  }

  // second pass: delta behavior using hashes learned from first-pass packs
  const deltaRows=[];
  for (const c of cases) {
    const first=queryContextIndex(index,c.query,{maxBytes:Number(a["max-bytes"]||24000),maxChunks:Number(a["max-chunks"]||12)});
    knownHashes={...knownHashes,...Object.fromEntries(first.items.map(x=>[x.path,x.sha256]))};
    const q0=performance.now();
    const delta=queryContextIndex(index,c.query,{maxBytes:Number(a["max-bytes"]||24000),maxChunks:Number(a["max-chunks"]||12),knownHashes});
    deltaRows.push({
      query:c.query,
      latencyMs:performance.now()-q0,
      emittedBytes:delta.stats.emittedBytes,
      unchangedChunks:delta.stats.unchangedChunks,
    });
  }

  const report={
    schema:"kiln.context-benchmark.v1",
    repo,
    revision:index.revision,
    worktreeDigest:index.worktreeDigest,
    generatedAt:new Date().toISOString(),
    baseline:{trackedTextBytes:baselineBytes,approxTokensAt4BytesPerToken:Math.ceil(baselineBytes/4)},
    index:{latencyMs:indexMs,stats:index.stats},
    summary:{
      cases:rows.length,
      medianQueryMs:median(rows.map(r=>r.latencyMs)),
      p95QueryMs:percentile(rows.map(r=>r.latencyMs),.95),
      medianByteReduction:median(rows.map(r=>r.byteReduction).filter(x=>x!==null)),
      meanPathRecall:(()=>{const x=rows.map(r=>r.pathRecall).filter(v=>v!==null);return x.length?x.reduce((a,b)=>a+b,0)/x.length:null;})(),
      deltaEmittedBytes:deltaRows.reduce((n,r)=>n+r.emittedBytes,0),
    },
    cases:rows,
    deltaCases:deltaRows,
    caveats:[
      "byteReduction is not billed-token reduction",
      "approxTokensAt4BytesPerToken is a rough transport estimate only",
      "pathRecall depends on user-provided expectedPaths labels",
      "model answer quality requires a separate paired model evaluation",
    ],
  };
  process.stdout.write(JSON.stringify(report,null,2)+"\n");
} finally {
  rmSync(state,{recursive:true,force:true});
}
