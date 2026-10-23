/**
 * KILN Knowledge Ledger v2.
 *
 * Durable knowledge classes:
 * fact, observation, decision, lesson, negative, hypothesis, procedure, capability.
 * All entries can be bound to source evidence hashes. Source-bound entries become
 * stale automatically when evidence changes. Supersession is explicit.
 */
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync} from "node:fs";
import {join} from "node:path";
import {createHash} from "node:crypto";

const SCHEMA="kiln.knowledge-ledger.v2";
const LEGACY="kiln.knowledge-ledger.v1";
const TYPES=new Set(["fact","observation","decision","lesson","negative","hypothesis","procedure","capability"]);
const sha=v=>createHash("sha256").update(v).digest("hex");
const pathOf=dir=>join(dir,"knowledge-ledger.json");
function atomic(path,obj){const t=path+".tmp-"+process.pid;writeFileSync(t,JSON.stringify(obj,null,2)+"\n",{mode:0o600});renameSync(t,path);}
function now(){return new Date().toISOString();}
function normalizeLegacy(x){
 if(x.schema!==LEGACY)return x;
 return {schema:SCHEMA,version:2,entries:(x.facts||[]).map(f=>({
  id:f.id,type:"fact",subject:f.subject,predicate:f.predicate,value:f.value,
  evidence:f.evidence||[],confidence:f.confidence||"verified",actor:f.actor||"system",
  tags:[],relations:[],supersedes:[],createdAt:f.createdAt||now(),updatedAt:f.createdAt||now(),
 }))};
}
export function loadKnowledge(dir){
 mkdirSync(dir,{recursive:true,mode:0o700});const p=pathOf(dir);
 if(!existsSync(p))return{schema:SCHEMA,version:2,entries:[]};
 let x=normalizeLegacy(JSON.parse(readFileSync(p,"utf8")));
 if(x.schema!==SCHEMA)throw new Error("incompatible knowledge ledger");
 if(!Array.isArray(x.entries))x.entries=[];
 return x;
}
function confidenceWeight(c){
 if(typeof c==="number")return Math.max(0,Math.min(1,c));
 return ({verified:1,high:.9,derived:.8,medium:.65,low:.4,hypothesis:.3})[String(c)]??.5;
}
export function putKnowledge(dir,{
 type="fact",subject,predicate,value,evidence=[],confidence="verified",actor="system",
 tags=[],relations=[],supersedes=[],expiresAt=null,metadata={}
}){
 if(!TYPES.has(type))throw new Error("unsupported knowledge type");
 if(!subject||!predicate)throw new Error("knowledge subject and predicate required");
 const ledger=loadKnowledge(dir);
 const base={
  type,subject:String(subject),predicate:String(predicate),value,
  evidence:[...evidence],confidence,actor:String(actor),
  tags:[...new Set(tags.map(String))],relations:[...relations],supersedes:[...supersedes],
  expiresAt,metadata,createdAt:now(),updatedAt:now()
 };
 const id=sha(JSON.stringify(base));
 const entry={id,...base};
 for(const oldId of entry.supersedes){
  const old=ledger.entries.find(e=>e.id===oldId);
  if(old){old.supersededBy=id;old.updatedAt=entry.createdAt;}
 }
 ledger.entries=ledger.entries.filter(e=>e.id!==id);ledger.entries.push(entry);
 atomic(pathOf(dir),ledger);return entry;
}
export function putFact(dir,args){return putKnowledge(dir,{...args,type:"fact"});}
export function recordNegative(dir,args){return putKnowledge(dir,{...args,type:"negative",confidence:args.confidence||"verified"});}
export function recordDecision(dir,args){return putKnowledge(dir,{...args,type:"decision",confidence:args.confidence||"verified"});}

export function evaluateKnowledge(dir,index){
 const ledger=loadKnowledge(dir);
 const hashes=new Map((index?.files||[]).map(f=>[f.path,f.sha256]));
 const at=Date.now();
 return ledger.entries.map(e=>{
  const stale=(e.evidence||[]).some(ev=>ev.path&&ev.sha256&&hashes.get(ev.path)!==ev.sha256);
  const expired=e.expiresAt&&Date.parse(e.expiresAt)<=at;
  const superseded=Boolean(e.supersededBy);
  const status=superseded?"superseded":expired?"expired":stale?"stale":"current";
  return {...e,status,confidenceWeight:confidenceWeight(e.confidence)};
 });
}
export function evaluateFacts(dir,index){return evaluateKnowledge(dir,index).filter(e=>e.type==="fact");}

function queryTerms(q){return String(q).toLowerCase().split(/[^a-z0-9]+/).filter(t=>t.length>1);}
export function queryKnowledge(dir,index,query,{types,statuses=["current"],limit=64}={}){
 const q=queryTerms(query);const typeSet=types?new Set(types):null;const statusSet=new Set(statuses);
 return evaluateKnowledge(dir,index)
  .filter(e=>(!typeSet||typeSet.has(e.type))&&statusSet.has(e.status))
  .map(e=>{
   const hay=(e.type+" "+e.subject+" "+e.predicate+" "+JSON.stringify(e.value)+" "+(e.tags||[]).join(" ")).toLowerCase();
   const hits=q.reduce((n,t)=>n+(hay.includes(t)?1:0),0);
   const score=(q.length?hits/q.length:1)*.7+e.confidenceWeight*.3;
   return {...e,queryScore:score};
  })
  .filter(e=>!q.length||e.queryScore>.3)
  .sort((a,b)=>b.queryScore-a.queryScore||String(b.updatedAt).localeCompare(String(a.updatedAt)))
  .slice(0,Math.max(1,Math.min(500,limit)));
}
export function queryFacts(dir,index,query){return queryKnowledge(dir,index,query,{types:["fact"]});}
export const knowledgeTypes=[...TYPES];
