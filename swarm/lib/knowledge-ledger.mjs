/**
 * Verified repository fact ledger.
 * Facts are content-hash bound and become stale automatically when evidence hashes change.
 */
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync} from "node:fs";
import {join} from "node:path";
import {createHash} from "node:crypto";
const sha=v=>createHash("sha256").update(v).digest("hex");
const pathOf=dir=>join(dir,"knowledge-ledger.json");
function atomic(path,obj){const t=path+".tmp-"+process.pid;writeFileSync(t,JSON.stringify(obj,null,2),{mode:0o600});renameSync(t,path);}
export function loadKnowledge(dir){
 mkdirSync(dir,{recursive:true,mode:0o700});const p=pathOf(dir);
 if(!existsSync(p))return{schema:"kiln.knowledge-ledger.v1",facts:[]};
 const x=JSON.parse(readFileSync(p,"utf8"));if(x.schema!=="kiln.knowledge-ledger.v1")throw new Error("incompatible knowledge ledger");return x;
}
export function putFact(dir,{subject,predicate,value,evidence=[],confidence="verified",actor="system"}){
 if(!subject||!predicate)throw new Error("fact subject and predicate required");
 const ledger=loadKnowledge(dir);
 const body={subject:String(subject),predicate:String(predicate),value,evidence:[...evidence],confidence,actor,createdAt:new Date().toISOString()};
 const id=sha(JSON.stringify(body));
 const fact={id,...body};
 ledger.facts=ledger.facts.filter(f=>f.id!==id);ledger.facts.push(fact);atomic(pathOf(dir),ledger);return fact;
}
export function evaluateFacts(dir,index){
 const ledger=loadKnowledge(dir);const hashes=new Map((index.files||[]).map(f=>[f.path,f.sha256]));
 return ledger.facts.map(f=>{
  const stale=(f.evidence||[]).some(e=>e.path&&e.sha256&&hashes.get(e.path)!==e.sha256);
  return {...f,status:stale?"stale":"current"};
 });
}
export function queryFacts(dir,index,query){
 const terms=String(query).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
 return evaluateFacts(dir,index).filter(f=>{
  const hay=(f.subject+" "+f.predicate+" "+JSON.stringify(f.value)).toLowerCase();
  return terms.some(t=>hay.includes(t));
 });
}
