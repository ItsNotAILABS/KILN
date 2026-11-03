#!/usr/bin/env node
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { buildContextIndex, queryContextIndex } from "../lib/context-index.mjs";

function parse(argv){const a={};for(let i=0;i<argv.length;i++){if(argv[i].startsWith("--")){const k=argv[i].slice(2);a[k]=argv[i+1]&&!argv[i+1].startsWith("--")?argv[++i]:true;}}return a;}
function pct(xs,p){if(!xs.length)return 0;const s=[...xs].sort((a,b)=>a-b);return s[Math.min(s.length-1,Math.ceil(p*s.length)-1)];}
function med(xs){return pct(xs,.5);}
function gitFiles(repo){return execFileSync("git",["-C",repo,"ls-files","-z"]).toString("utf8").split("\0").filter(Boolean);}
function baselineBytes(repo){let n=0;for(const p of gitFiles(repo)){try{const b=readFileSync(join(repo,p));if(!b.includes(0))n+=b.length;}catch{}}return n;}

const a=parse(process.argv.slice(2));
if(!a.repo||!a.cases){console.error("usage: context-benchmark.mjs --repo PATH --cases cases.json [--max-bytes 24000] [--max-chunks 12]");process.exit(2);}
const repo=resolve(String(a.repo));
const cases=JSON.parse(readFileSync(resolve(String(a.cases)),"utf8"));
if(!Array.isArray(cases)||!cases.length)throw new Error("cases must be a non-empty array");
const state=mkdtempSync(join(tmpdir(),"kiln-context-bench-"));
try{
  const start=performance.now();
  const index=buildContextIndex(repo,state);
  const indexMs=performance.now()-start;
  const fullBytes=baselineBytes(repo);
  const rows=[];
  for(const c of cases){
    const t0=performance.now();
    const pack=queryContextIndex(index,String(c.query||""),{maxBytes:Number(a["max-bytes"]||24000),maxChunks:Number(a["max-chunks"]||12)});
    const latencyMs=performance.now()-t0;
    const expected=Array.isArray(c.expectedPaths)?c.expectedPaths:[];
    const got=new Set(pack.items.map(x=>x.path));
    const hits=expected.filter(x=>got.has(x)).length;
    rows.push({
      query:c.query,
      latencyMs,
      baselineBytes:fullBytes,
      fabricBytes:pack.stats.emittedBytes,
      byteReduction:fullBytes?1-pack.stats.emittedBytes/fullBytes:null,
      tokenEstimate:pack.stats.tokenEstimate,
      expectedPaths:expected,
      pathRecall:expected.length?hits/expected.length:null,
      emittedPaths:[...got],
      packDigest:pack.digest,
    });
  }
  const deltaRows=[];
  for(const c of cases){
    const first=queryContextIndex(index,String(c.query||""),{maxBytes:Number(a["max-bytes"]||24000),maxChunks:Number(a["max-chunks"]||12)});
    const known=Object.fromEntries(first.items.map(x=>[x.path,x.sha256]));
    const t0=performance.now();
    const delta=queryContextIndex(index,String(c.query||""),{maxBytes:Number(a["max-bytes"]||24000),maxChunks:Number(a["max-chunks"]||12),knownHashes:known});
    deltaRows.push({query:c.query,latencyMs:performance.now()-t0,emittedBytes:delta.stats.emittedBytes,unchangedChunks:delta.stats.unchangedChunks});
  }
  const recalls=rows.map(r=>r.pathRecall).filter(x=>x!==null);
  const reductions=rows.map(r=>r.byteReduction).filter(x=>x!==null);
  process.stdout.write(JSON.stringify({
    schema:"kiln.context-benchmark.v2",
    repo,revision:index.revision,worktreeDigest:index.worktreeDigest,generatedAt:new Date().toISOString(),
    baseline:{trackedTextBytes:fullBytes,roughFourByteTokenEstimate:Math.ceil(fullBytes/4)},
    index:{latencyMs:indexMs,stats:index.stats},
    summary:{
      cases:rows.length,
      medianQueryMs:med(rows.map(r=>r.latencyMs)),
      p95QueryMs:pct(rows.map(r=>r.latencyMs),.95),
      medianByteReduction:med(reductions),
      meanPathRecall:recalls.length?recalls.reduce((x,y)=>x+y,0)/recalls.length:null,
      deltaBytesAfterKnownHashes:deltaRows.reduce((n,x)=>n+x.emittedBytes,0)
    },
    cases:rows,deltaCases:deltaRows,
    caveats:[
      "byteReduction is transport/context reduction, not a claim about provider billing",
      "roughFourByteTokenEstimate is not a tokenizer measurement",
      "model answer quality and patch success require paired model evaluation"
    ]
  },null,2)+"\n");
}finally{rmSync(state,{recursive:true,force:true});}
