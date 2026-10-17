/**
 * Privacy-bounded audit receipts for Context Fabric operations.
 *
 * Receipts intentionally do not contain repository excerpts or raw queries.
 * They record query SHA-256, pack/index digests, node identity, counts, bytes,
 * timestamps, and a hash-chain link.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

function sha256(v){return createHash("sha256").update(v).digest("hex");}
function canonical(value){
  if(Array.isArray(value)) return value.map(canonical);
  if(value && typeof value==="object"){
    const out={};
    for(const k of Object.keys(value).sort()) out[k]=canonical(value[k]);
    return out;
  }
  return value;
}
function stable(value){return JSON.stringify(canonical(value));}
function receiptPath(dir){
  const root=join(dir,"context-receipts");
  mkdirSync(root,{recursive:true,mode:0o700});
  return join(root,"receipts.jsonl");
}
function lastHash(path){
  if(!existsSync(path))return null;
  const lines=readFileSync(path,"utf8").trim().split("\n").filter(Boolean);
  if(!lines.length)return null;
  try{return JSON.parse(lines[lines.length-1]).hash||null;}catch{return null;}
}
export function appendContextReceipt(dir,event){
  const path=receiptPath(dir);
  const body={
    schema:"kiln.context-receipt.v1",
    at:new Date().toISOString(),
    operation:String(event.operation||"unknown"),
    node:String(event.node||""),
    queryDigest:event.query===undefined?null:sha256(String(event.query)),
    indexDigest:event.indexDigest||null,
    packDigest:event.packDigest||null,
    revision:event.revision||null,
    worktreeDigest:event.worktreeDigest||null,
    emittedBytes:Number(event.emittedBytes||0),
    emittedChunks:Number(event.emittedChunks||0),
    unchangedChunks:Number(event.unchangedChunks||0),
    previousHash:lastHash(path),
  };
  const hash=sha256(stable(body));
  const receipt={...body,hash};
  appendFileSync(path,JSON.stringify(receipt)+"\n",{mode:0o600});
  return receipt;
}
export function verifyContextReceipts(dir){
  const path=receiptPath(dir);
  if(!existsSync(path))return{ok:true,count:0,lastHash:null};
  const lines=readFileSync(path,"utf8").split("\n").filter(Boolean);
  let previous=null;
  for(let i=0;i<lines.length;i++){
    let row;
    try{row=JSON.parse(lines[i]);}catch{return{ok:false,count:i,error:`invalid JSON at line ${i+1}`};}
    if(row.previousHash!==previous)return{ok:false,count:i,error:`chain mismatch at line ${i+1}`};
    const {hash,...body}=row;
    const expected=sha256(stable(body));
    if(hash!==expected)return{ok:false,count:i,error:`hash mismatch at line ${i+1}`};
    previous=hash;
  }
  return{ok:true,count:lines.length,lastHash:previous};
}
