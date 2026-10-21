#!/usr/bin/env node
/**
 * Context Fabric production-gate validator.
 * Runs >=100 deterministic assertions over core invariants.
 */
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {buildRepoGraph,impactFromPaths} from "../lib/repo-graph.mjs";
import {putFact,evaluateFacts} from "../lib/knowledge-ledger.mjs";
import {packToTokenBudget} from "../lib/token-budget.mjs";
import {evaluatePromotion} from "../lib/porta.mjs";
import {scanSecretContent} from "../lib/secret-scan.mjs";

let assertions=0;
const check=(cond,msg)=>{assert.ok(cond,msg);assertions++;};

// Graph invariants.
const files=[];
for(let i=0;i<25;i++)files.push({path:`src/f${i}.js`,sha256:String(i),bytes:i+1,symbols:[`f${i}`],imports:i<24?[`./f${i+1}`]:[]});
const graph=buildRepoGraph({repoName:"gate",revision:"r",worktreeDigest:"w",digest:"d",files,chunks:[]});
check(graph.stats.files===25,"graph file count");
check(graph.stats.symbols===25,"graph symbol count");
check(graph.stats.imports===24,"graph import count");
for(let i=0;i<20;i++){
 const impact=impactFromPaths(graph,[`src/f${i}.js`],{depth:1});
 check(impact.affected.some(x=>x.path===`src/f${i}.js`),`impact includes changed ${i}`);
 check(impact.digest.length===64,`impact digest ${i}`);
}

// Token budget invariants.
for(let budget=1;budget<=30;budget++){
 const items=Array.from({length:10},(_,i)=>({excerpt:"x".repeat(i+1)}));
 const packed=await packToTokenBudget(items,budget,{tokenize:s=>s.split("")});
 check(packed.used<=budget,`token budget ${budget}`);
 check(packed.remaining===budget-packed.used,`token remaining ${budget}`);
}

// PORTA invariants.
const good={
 actor:{id:"muse"},source:{workspaceId:"muse/kiln"},
 target:{organization:"ItsNotAILABS",repository:"KILN"},
 diffDigest:"a".repeat(64),worktreeDirty:false,
 evidence:{testsPassed:true,secretScanPassed:true},
 policy:{allowOrganizationPush:true,requiresApproval:true},
 approval:{approved:true},
};
check(evaluatePromotion(good).decision==="allow","good promotion allowed");
const mutations=[
 x=>{delete x.actor;},x=>{delete x.source;},x=>{delete x.target;},x=>{delete x.diffDigest;},
 x=>{x.worktreeDirty=true;},x=>{x.evidence.testsPassed=false;},x=>{x.evidence.secretScanPassed=false;},
 x=>{x.policy.allowOrganizationPush=false;},x=>{x.approval.approved=false;}
];
for(let round=0;round<3;round++){
 for(const mutate of mutations){
  const x=structuredClone(good);mutate(x);
  check(evaluatePromotion(x).decision==="deny","mutated promotion denied");
 }
}

// Secret scanner invariants.
const unsafe=[
 "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
 'const api_key="abcdefghijklmnopqrstuvwxyz123456";',
 "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
];
for(let i=0;i<10;i++)for(const text of unsafe)check(scanSecretContent(text+String(i)).safe===false,"unsafe secret detected");
for(let i=0;i<20;i++)check(scanSecretContent(`export const value${i}=${i};`).safe===true,"safe source accepted");

// Knowledge freshness invariants.
const dir=mkdtempSync(join(tmpdir(),"kiln-prod-gate-"));
try{
 for(let i=0;i<20;i++)putFact(dir,{subject:`f${i}`,predicate:"role",value:`v${i}`,evidence:[{path:`f${i}.js`,sha256:`h${i}`}]});
 const current=evaluateFacts(dir,{files:Array.from({length:20},(_,i)=>({path:`f${i}.js`,sha256:`h${i}`}))});
 for(const fact of current)check(fact.status==="current","fact current");
 const stale=evaluateFacts(dir,{files:Array.from({length:20},(_,i)=>({path:`f${i}.js`,sha256:`changed${i}`}))});
 for(const fact of stale)check(fact.status==="stale","fact stale");
}finally{rmSync(dir,{recursive:true,force:true});}

if(assertions<100)throw new Error(`production validator too small: ${assertions}`);
console.log(JSON.stringify({ok:true,assertions,suite:"kiln-context-production-gates-v1"},null,2));
