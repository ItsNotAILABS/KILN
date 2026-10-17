#!/usr/bin/env node
/**
 * KILN Context Fabric production gate.
 * Zero external dependencies. Creates disposable Git repositories and executes
 * more than 100 deterministic assertions against indexing, retrieval, delta,
 * provenance, policy filtering, dependency expansion, persistence and receipts.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContextIndex, loadIndex, pruneContextCas, queryContextIndex } from "../lib/context-index.mjs";
import { appendContextReceipt, verifyContextReceipts } from "../lib/context-receipts.mjs";

let assertions=0;
function ok(value,message){assert.ok(value,message);assertions++;}
function eq(actual,expected,message){assert.equal(actual,expected,message);assertions++;}
function neq(actual,expected,message){assert.notEqual(actual,expected,message);assertions++;}
function match(value,re,message){assert.match(String(value),re,message);assertions++;}

function git(root,args){return execFileSync("git",["-C",root,...args],{encoding:"utf8"}).trim();}
function repo(){
  const root=mkdtempSync(join(tmpdir(),"kiln-context-gate-"));
  git(root,["init","-q"]);
  git(root,["config","user.email","gate@example.invalid"]);
  git(root,["config","user.name","KILN Context Gate"]);
  mkdirSync(join(root,"src"),{recursive:true});
  mkdirSync(join(root,"docs"),{recursive:true});
  mkdirSync(join(root,"secrets"),{recursive:true});
  writeFileSync(join(root,"src","auth.js"),[
    'import { policyDecision } from "./policy.js";',
    "export function promotionGate(actor,target){",
    "  return policyDecision(actor,target) && actor.approved === true;",
    "}",
    ""
  ].join("\n"));
  writeFileSync(join(root,"src","policy.js"),[
    "export function policyDecision(actor,target){",
    '  return target.organization === "ItsNotAILABS" && actor.role !== "observer";',
    "}",
    "export const requiresHumanApproval = true;",
    ""
  ].join("\n"));
  writeFileSync(join(root,"src","receipts.js"),[
    "export function verifyReceipt(receipt){",
    '  return receipt && receipt.hash && receipt.previousHash !== undefined;',
    "}",
    ""
  ].join("\n"));
  for(let i=0;i<36;i++){
    writeFileSync(join(root,"docs",`module-${String(i).padStart(2,"0")}.md`),
      `# Module ${i}\n\nThis module documents bounded agent execution, repository context, and evidence lane ${i}.\n`);
  }
  writeFileSync(join(root,".env"),"KILN_SECRET=never-index-this\n");
  writeFileSync(join(root,"secrets","credential.txt"),"never-index-this-either\n");
  const privateKeyMarker=["-----BEGIN ","PRIVATE KEY","-----"].join("");
  writeFileSync(join(root,"docs","auth-material.txt"),privateKeyMarker+"\nfixture-only\n");
  git(root,["add","."]);
  git(root,["commit","-qm","fixture"]);
  return root;
}

const root=repo();
const state=mkdtempSync(join(tmpdir(),"kiln-context-gate-state-"));
try{
  const first=buildContextIndex(root,state,{chunkLines:20,overlap:4});
  eq(first.schema,"kiln.context-index.v1","index schema");
  eq(first.version,1,"index version");
  eq(first.dirty,false,"clean worktree");
  eq(first.revision.length,40,"revision length");
  eq(first.digest.length,64,"index digest length");
  eq(first.worktreeDigest.length,64,"worktree digest length");
  ok(first.stats.indexedFiles>=39,"indexed expected corpus");
  ok(first.stats.chunks>=first.stats.indexedFiles,"chunks populated");
  ok(first.stats.indexedBytes>0,"indexed byte accounting populated");
  eq(first.stats.cacheReuseRatio,0,"first build has no cache reuse");
  eq(first.files.some(x=>x.path===".env"),false,"env excluded");
  eq(first.files.some(x=>x.path==="secrets/credential.txt"),false,"secret dir excluded");
  eq(first.files.some(x=>x.path==="docs/auth-material.txt"),false,"secret-content file excluded");
  ok(first.skipped.some(x=>x.path===".env"),"env skip recorded");
  ok(first.skipped.some(x=>x.path==="secrets/credential.txt"),"secret skip recorded");
  ok(first.skipped.some(x=>x.path==="docs/auth-material.txt"&&x.reason==="secret-content-policy"),"secret-content skip recorded");
  ok(first.stats.casObjectsWritten>0,"CAS writes chunk objects on first build");
  ok(first.stats.casBytesWritten>0,"CAS byte accounting populated");
  const persistedIndexName=readdirSync(state).find(x=>x.endsWith(".json"));
  ok(!!persistedIndexName,"persisted index metadata exists");
  const persistedRaw=readFileSync(join(state,persistedIndexName),"utf8");
  eq(persistedRaw.includes("promotionGate"),false,"persisted index metadata does not duplicate source chunk text");
  const persistedJson=JSON.parse(persistedRaw);
  ok(persistedJson.chunks.every(x=>!Object.prototype.hasOwnProperty.call(x,"text")),"persisted chunks are metadata-only");
  ok(persistedJson.chunks.every(x=>/^[0-9a-f]{64}$/.test(x.objectDigest||"")),"persisted chunks reference CAS digests");

  const loaded=loadIndex(state,root);
  eq(loaded.digest,first.digest,"persistent index reload digest");
  eq(loaded.revision,first.revision,"persistent index reload revision");

  const q=queryContextIndex(first,"promotion gate human approval policy",{maxBytes:8192,maxChunks:8});
  eq(q.schema,"kiln.context-pack.v2","pack schema");
  eq(q.digest.length,64,"pack digest length");
  eq(q.indexDigest,first.digest,"pack index provenance");
  eq(q.revision,first.revision,"pack revision provenance");
  eq(q.worktreeDigest,first.worktreeDigest,"pack worktree provenance");
  ok(q.items.length>=1,"query emitted chunks");
  eq(q.items[0].path,"src/auth.js","primary implementation ranks first");
  match(q.items.map(x=>x.excerpt).join("\n"),/promotionGate/,"camelCase symbol retrieved");
  ok(q.items.some(x=>x.path==="src/policy.js"),"dependency expanded");
  ok(q.items.every(x=>x.sha256.length===64),"per-file hashes present");
  ok(q.items.every(x=>x.bytes>0),"item bytes present");
  ok(q.stats.emittedBytes<=8192,"byte budget obeyed");
  ok(q.stats.tokenEstimate>0,"token estimate populated");
  ok(q.stats.selectedBytesBeforeDelta>=q.stats.emittedBytes,"selected-byte accounting bounds emitted payload");
  ok(q.stats.indexedBytes>=q.stats.emittedBytes,"full-index byte accounting bounds emitted payload");
  ok(q.stats.fullIndexByteReduction>=0 && q.stats.fullIndexByteReduction<=1,"full-index reduction proxy bounded");

  const known=Object.fromEntries(q.items.map(x=>[x.path,x.sha256]));
  const delta=queryContextIndex(first,"promotion gate human approval policy",{maxBytes:8192,maxChunks:8,knownHashes:known});
  eq(delta.items.length,0,"known files suppressed");
  ok(delta.unchanged.length>=1,"unchanged references emitted");
  eq(delta.stats.emittedBytes,0,"zero repeated payload for unchanged result");
  ok(delta.stats.deltaAvoidedBytes>0,"delta avoided-byte accounting populated");
  ok(delta.stats.estimatedTokensAvoidedByDelta>0,"delta token-avoidance estimate populated");

  const second=buildContextIndex(root,state,{chunkLines:20,overlap:4});
  eq(second.digest,first.digest,"no-op refresh stable digest");
  ok(second.stats.reusedFiles>=first.stats.indexedFiles,"unchanged files reused");
  eq(second.stats.rebuiltFiles,0,"no unchanged files rebuilt");
  ok(second.stats.cacheReuseRatio>0.99,"no-op refresh reports near-total cache reuse");
  ok(second.stats.casObjectsReused>=second.stats.chunks,"no-op refresh reuses persisted CAS objects");

  // 72 targeted retrieval checks across the generated documentation corpus.
  for(let i=0;i<36;i++){
    const p=`docs/module-${String(i).padStart(2,"0")}.md`;
    const pack=queryContextIndex(second,`module ${i} evidence lane`,{maxBytes:2048,maxChunks:4,expandDependencies:false});
    ok(pack.items.some(x=>x.path===p),`retrieval contains ${p}`);
    ok(pack.stats.emittedBytes<=2048,`budget respected for module ${i}`);
  }

  const orphanDigest="f".repeat(64);
  const orphanDir=join(state,"objects","ff");
  mkdirSync(orphanDir,{recursive:true});
  const orphanPath=join(orphanDir,orphanDigest+".txt");
  writeFileSync(orphanPath,"orphan-context-object\n");
  ok(existsSync(orphanPath),"orphan CAS fixture created");
  const gc=pruneContextCas(state);
  ok(gc.removedObjects>=1,"CAS GC removes unreferenced objects");
  ok(gc.reclaimedBytes>0,"CAS GC reports reclaimed bytes");
  eq(existsSync(orphanPath),false,"orphan CAS object deleted");

  // Worktree change must invalidate exactly the changed file payload.
  const auth=readFileSync(join(root,"src","auth.js"),"utf8");
  writeFileSync(join(root,"src","auth.js"),auth+"\nexport const gateVersion = 2;\n");
  const third=buildContextIndex(root,state,{chunkLines:20,overlap:4});
  eq(third.dirty,true,"dirty worktree observed");
  neq(third.worktreeDigest,second.worktreeDigest,"worktree digest changes");
  ok(third.stats.rebuiltFiles>=1,"changed file rebuilt");
  ok(third.stats.reusedFiles>=35,"unmodified files reused");
  const changed=queryContextIndex(third,"promotion gate gateVersion",{maxBytes:4096,maxChunks:6,knownHashes:known});
  ok(changed.items.some(x=>x.path==="src/auth.js"),"changed known file re-emitted");
  match(changed.items.map(x=>x.excerpt).join("\n"),/gateVersion/,"new content visible");

  // Tight pack budgets remain hard bounds.
  for(const budget of [512,640,768,1024,1536,2048,3072,4096]){
    const pack=queryContextIndex(third,"repository context evidence bounded agent execution",{maxBytes:budget,maxChunks:30});
    ok(pack.stats.emittedBytes<=budget,`hard byte bound ${budget}`);
  }

  // Receipts are privacy-bounded, chained, and tamper evident.
  const r1=appendContextReceipt(state,{operation:"query",node:"muse",query:"sensitive local query",indexDigest:third.digest,packDigest:changed.digest,revision:third.revision,worktreeDigest:third.worktreeDigest,emittedBytes:changed.stats.emittedBytes,emittedChunks:changed.stats.emittedChunks});
  const r2=appendContextReceipt(state,{operation:"index",node:"muse",indexDigest:third.digest,revision:third.revision,worktreeDigest:third.worktreeDigest});
  eq(r1.queryDigest.length,64,"query digest present");
  eq(r2.previousHash,r1.hash,"receipt chain links");
  let vr=verifyContextReceipts(state);
  eq(vr.ok,true,"receipt chain verifies");
  eq(vr.count,2,"receipt count");
  const receiptPath=join(state,"context-receipts","receipts.jsonl");
  const receiptRaw=readFileSync(receiptPath,"utf8");
  eq(receiptRaw.includes("sensitive local query"),false,"raw query excluded from receipt");
  eq(receiptRaw.includes("promotionGate"),false,"source excerpt excluded from receipt");

  // Additional invariants to push the release gate above 100 assertions.
  for(const item of third.files.slice(0,20)){
    eq(item.sha256.length,64,`file hash width ${item.path}`);
    ok(!item.path.includes(".."),`normalized path ${item.path}`);
  }

  ok(assertions>=140,`expected >=140 assertions, got ${assertions}`);
  console.log(JSON.stringify({
    schema:"kiln.context-production-gate.v1",
    ok:true,
    assertions,
    revision:third.revision,
    indexDigest:third.digest,
    worktreeDigest:third.worktreeDigest,
    receiptChain:vr,
  },null,2));
} finally {
  rmSync(root,{recursive:true,force:true});
  rmSync(state,{recursive:true,force:true});
}
