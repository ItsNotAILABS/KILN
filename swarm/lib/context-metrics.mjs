/**
 * Privacy-bounded aggregate Context Fabric economics.
 *
 * Stores no query text and no source excerpts. The aggregate is operational
 * telemetry, not a security receipt; signed provenance remains in
 * context-receipts.mjs.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function root(dir){const p=join(dir,"context-metrics");mkdirSync(p,{recursive:true,mode:0o700});return p;}
function pathOf(dir){return join(root(dir),"summary.json");}
function empty(){
  return {
    schema:"kiln.context-metrics.v1",
    queries:0,
    sits:0,
    indexes:0,
    emittedBytes:0,
    selectedBytesBeforeDelta:0,
    deltaAvoidedBytes:0,
    budgetOmittedBytes:0,
    estimatedTokensEmitted:0,
    estimatedTokensAvoidedByDelta:0,
    indexBytesObserved:0,
    cacheReusedFiles:0,
    cacheRebuiltFiles:0,
    totalLatencyMs:0,
    lastUpdatedAt:null,
    lastPackDigest:null,
  };
}
export function loadContextMetrics(dir){
  const p=pathOf(dir);
  if(!existsSync(p))return empty();
  try{
    const v=JSON.parse(readFileSync(p,"utf8"));
    return v?.schema==="kiln.context-metrics.v1"?{...empty(),...v}:empty();
  }catch{return empty();}
}
function save(dir,value){
  const p=pathOf(dir),tmp=p+".tmp-"+process.pid+"-"+Date.now()+"-"+Math.random().toString(16).slice(2);
  writeFileSync(tmp,JSON.stringify(value,null,2)+"\n",{mode:0o600});
  renameSync(tmp,p);
}
function sleep(ms){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);}
function withLock(dir,fn){
  const p=join(root(dir),".metrics.lock");
  const deadline=Date.now()+3000;
  let fd=null;
  while(fd===null){
    try{fd=openSync(p,"wx",0o600);}
    catch(e){
      if(e.code!=="EEXIST")throw e;
      if(Date.now()>=deadline)throw new Error("context metrics: lock timeout");
      sleep(5);
    }
  }
  try{return fn();}finally{try{closeSync(fd);}catch{} try{unlinkSync(p);}catch{}}
}
export function recordContextMetric(dir,event={}){
  return withLock(dir,()=>{
    const m=loadContextMetrics(dir);
    const kind=String(event.kind||"query");
    if(kind==="query")m.queries++;
    else if(kind==="sit")m.sits++;
    else if(kind==="index")m.indexes++;
    const s=event.stats||{};
    m.emittedBytes+=Number(s.emittedBytes||0);
    m.selectedBytesBeforeDelta+=Number(s.selectedBytesBeforeDelta||0);
    m.deltaAvoidedBytes+=Number(s.deltaAvoidedBytes||0);
    m.budgetOmittedBytes+=Number(s.budgetOmittedBytes||0);
    m.estimatedTokensEmitted+=Number(s.tokenEstimate||0);
    m.estimatedTokensAvoidedByDelta+=Number(s.estimatedTokensAvoidedByDelta||0);
    m.indexBytesObserved=Math.max(m.indexBytesObserved,Number(s.indexedBytes||event.indexedBytes||0));
    m.cacheReusedFiles+=Number(event.reusedFiles||0);
    m.cacheRebuiltFiles+=Number(event.rebuiltFiles||0);
    m.totalLatencyMs+=Number(event.latencyMs||0);
    m.lastUpdatedAt=new Date().toISOString();
    if(event.packDigest)m.lastPackDigest=String(event.packDigest);
    save(dir,m);
    return contextMetricsSummary(m);
  });
}
export function contextMetricsSummary(input){
  const m=typeof input==="string"?loadContextMetrics(input):{...empty(),...(input||{})};
  const retrievals=m.queries+m.sits;
  return {
    ...m,
    retrievals,
    averageLatencyMs:retrievals?m.totalLatencyMs/retrievals:0,
    deltaAvoidanceRatio:m.selectedBytesBeforeDelta?m.deltaAvoidedBytes/m.selectedBytesBeforeDelta:0,
    cacheReuseRatio:(m.cacheReusedFiles+m.cacheRebuiltFiles)
      ?m.cacheReusedFiles/(m.cacheReusedFiles+m.cacheRebuiltFiles)
      :0,
  };
}
