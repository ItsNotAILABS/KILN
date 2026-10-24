/**
 * Privacy-bounded, signed Context Fabric audit receipts.
 *
 * Raw query/source are deliberately excluded. A dedicated Ed25519 key signs
 * each hash-chained receipt. Node-originated context.query calls are also
 * cross-anchored by the node's ordinary signed tool receipt.
 */
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  createHash, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify,
} from "node:crypto";

function sha256(v){return createHash("sha256").update(v).digest("hex");}
function canonical(value){
  if(Array.isArray(value)) return value.map(canonical);
  if(value && typeof value==="object"){
    const out={}; for(const k of Object.keys(value).sort()) out[k]=canonical(value[k]);
    return out;
  }
  return value;
}
function stable(value){return JSON.stringify(canonical(value));}
function rootDir(dir){const p=join(dir,"context-receipts");mkdirSync(p,{recursive:true,mode:0o700});return p;}
function receiptPath(dir){return join(rootDir(dir),"receipts.jsonl");}
function keyPaths(dir){const root=rootDir(dir);return{priv:join(root,"ed25519-private.pem"),pub:join(root,"ed25519-public.pem")};}
function ensureKeys(dir){
  const p=keyPaths(dir);
  if(!existsSync(p.priv)||!existsSync(p.pub)){
    const {privateKey,publicKey}=generateKeyPairSync("ed25519");
    writeFileSync(p.priv,privateKey.export({type:"pkcs8",format:"pem"}),{mode:0o600});
    writeFileSync(p.pub,publicKey.export({type:"spki",format:"pem"}),{mode:0o644});
  }
  return{privateKey:readFileSync(p.priv),publicKey:readFileSync(p.pub)};
}
function sleep(ms){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);}
function withLock(dir,fn){
  const p=join(rootDir(dir),".append.lock");
  const deadline=Date.now()+3000;
  let fd=null;
  while(fd===null){
    try{fd=openSync(p,"wx",0o600);}
    catch(e){
      if(e.code!=="EEXIST")throw e;
      if(Date.now()>=deadline)throw new Error("context receipts: append lock timeout");
      sleep(10);
    }
  }
  try{return fn();}finally{try{closeSync(fd);}catch{} try{unlinkSync(p);}catch{}}
}
function lastHash(path){
  if(!existsSync(path))return null;
  const lines=readFileSync(path,"utf8").trim().split("\n").filter(Boolean);
  if(!lines.length)return null;
  try{return JSON.parse(lines[lines.length-1]).hash||null;}catch{return null;}
}
export function appendContextReceipt(dir,event){
  return withLock(dir,()=>{
    const path=receiptPath(dir);
    const keys=ensureKeys(dir);
    const body={
      schema:"kiln.context-receipt.v2",
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
    const signature=cryptoSign(null,Buffer.from(hash,"utf8"),keys.privateKey).toString("base64");
    const receipt={...body,hash,signature};
    appendFileSync(path,JSON.stringify(receipt)+"\n",{mode:0o600});
    return receipt;
  });
}
export function verifyContextReceipts(dir){
  const path=receiptPath(dir);
  if(!existsSync(path))return{ok:true,count:0,lastHash:null,signed:true};
  let publicKey;
  try{publicKey=ensureKeys(dir).publicKey;}catch(e){return{ok:false,count:0,error:"key error: "+e.message};}
  const lines=readFileSync(path,"utf8").split("\n").filter(Boolean);
  let previous=null;
  for(let i=0;i<lines.length;i++){
    let row;
    try{row=JSON.parse(lines[i]);}catch{return{ok:false,count:i,error:`invalid JSON at line ${i+1}`};}
    if(row.schema!=="kiln.context-receipt.v2")return{ok:false,count:i,error:`unsupported receipt schema at line ${i+1}`};
    if(row.previousHash!==previous)return{ok:false,count:i,error:`chain mismatch at line ${i+1}`};
    const {hash,signature,...body}=row;
    const expected=sha256(stable(body));
    if(hash!==expected)return{ok:false,count:i,error:`hash mismatch at line ${i+1}`};
    let signatureOk=false;
    try{signatureOk=cryptoVerify(null,Buffer.from(hash,"utf8"),publicKey,Buffer.from(String(signature||""),"base64"));}catch{}
    if(!signatureOk)return{ok:false,count:i,error:`signature mismatch at line ${i+1}`};
    previous=hash;
  }
  return{ok:true,count:lines.length,lastHash:previous,signed:true};
}
