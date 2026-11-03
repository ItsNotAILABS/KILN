import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundContextRequest, contextLimits } from "../lib/context-policy.mjs";
import { contextMetricsSummary, loadContextMetrics, recordContextMetric } from "../lib/context-metrics.mjs";
import { checkShellArgs } from "../lib/tools.mjs";

function withEnv(values, fn) {
  const old = {};
  for (const [k,v] of Object.entries(values)) { old[k]=process.env[k]; process.env[k]=String(v); }
  try { return fn(); }
  finally {
    for (const [k,v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k]; else process.env[k]=v;
    }
  }
}

test("context resource policy centralizes query and sit budgets",()=>{
  const q=boundContextRequest({query:"repository promotion"});
  assert.equal(q.maxBytes,24000);
  assert.equal(q.maxChunks,12);
  assert.equal(q.memoryTokens,1200);

  const sit=boundContextRequest({query:"repository memory",maxBytes:999999,maxChunks:999,memoryTokens:999999},"sit");
  const limits=contextLimits();
  assert.equal(sit.maxBytes,limits.maxBytes);
  assert.equal(sit.maxChunks,limits.maxChunks);
  assert.equal(sit.memoryTokens,limits.maxMemoryTokens);
});

test("environment policy cannot be bypassed by larger request values",()=>{
  withEnv({
    KILN_CONTEXT_MAX_BYTES:8192,
    KILN_CONTEXT_MAX_CHUNKS:4,
    KILN_CONTEXT_MAX_MEMORY_TOKENS:700,
    KILN_CONTEXT_MAX_QUERY_CHARS:128,
  },()=>{
    const b=boundContextRequest({query:"bounded request",maxBytes:500000,maxChunks:50,memoryTokens:8000},"sit");
    assert.equal(b.maxBytes,8192);
    assert.equal(b.maxChunks,4);
    assert.equal(b.memoryTokens,700);
    assert.throws(()=>boundContextRequest({query:"x".repeat(129)}),/exceeds 128 characters/);
  });
});

test("known hash deltas accept objects but not array-shaped input",()=>{
  const hashes={"src/a.js":"a".repeat(64)};
  assert.deepEqual(boundContextRequest({query:"a",knownHashes:hashes}).knownHashes,hashes);
  assert.deepEqual(boundContextRequest({query:"a",knownHashes:["bad"]}).knownHashes,{});
});

test("aggregate context metrics measure retrieval and delta economics without content",()=>{
  const dir=mkdtempSync(join(tmpdir(),"kiln-context-metrics-"));
  try{
    recordContextMetric(dir,{
      kind:"index",indexedBytes:10000,reusedFiles:0,rebuiltFiles:10,
    });
    recordContextMetric(dir,{
      kind:"query",packDigest:"a".repeat(64),latencyMs:20,
      stats:{emittedBytes:2000,selectedBytesBeforeDelta:2000,deltaAvoidedBytes:0,budgetOmittedBytes:0,tokenEstimate:500,estimatedTokensAvoidedByDelta:0,indexedBytes:10000},
      reusedFiles:10,rebuiltFiles:0,
    });
    const out=recordContextMetric(dir,{
      kind:"sit",packDigest:"b".repeat(64),latencyMs:10,
      stats:{emittedBytes:0,selectedBytesBeforeDelta:2000,deltaAvoidedBytes:2000,budgetOmittedBytes:0,tokenEstimate:0,estimatedTokensAvoidedByDelta:500,indexedBytes:10000},
      reusedFiles:10,rebuiltFiles:0,
    });
    assert.equal(out.queries,1);
    assert.equal(out.sits,1);
    assert.equal(out.indexes,1);
    assert.equal(out.emittedBytes,2000);
    assert.equal(out.deltaAvoidedBytes,2000);
    assert.equal(out.estimatedTokensAvoidedByDelta,500);
    assert.equal(out.averageLatencyMs,15);
    assert.equal(out.deltaAvoidanceRatio,0.5);
    assert.ok(out.cacheReuseRatio>0.6);
    const raw=JSON.stringify(loadContextMetrics(dir));
    assert.equal(raw.includes("repository promotion"),false);
    assert.equal(contextMetricsSummary(loadContextMetrics(dir)).lastPackDigest,"b".repeat(64));
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("shell jail rejects absolute argv paths outside node workdir",()=>{
  const workdir=mkdtempSync(join(tmpdir(),"kiln-jail-"));
  try{
    assert.throws(()=>checkShellArgs("cat",["/tmp/outside-file"],workdir),/absolute argument escapes work dir/);
    assert.throws(()=>checkShellArgs("node",["--input=/var/tmp/outside"],workdir),/absolute argument escapes work dir/);
    assert.equal(checkShellArgs("node",["relative.js"],workdir),"bin");
  }finally{rmSync(workdir,{recursive:true,force:true});}
});
