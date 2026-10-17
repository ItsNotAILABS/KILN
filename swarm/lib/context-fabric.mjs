import {execFileSync} from "node:child_process";
import {readFileSync,realpathSync,statSync} from "node:fs";
import {resolve,relative,sep} from "node:path";
import {createHash} from "node:crypto";
const hash=x=>createHash("sha256").update(x).digest("hex");
export function contextPack(root,query,{maxBytes=24000,maxFiles=12}={}){
 const base=realpathSync(root);
 const files=execFileSync("git",["-C",base,"ls-files","-z"],{maxBuffer:16*1024*1024}).toString().split("\0").filter(Boolean);
 const terms=String(query).toLowerCase().split(/[^a-z0-9_]+/).filter(x=>x.length>2);
 const hits=[];
 for(const name of files){
  const p=resolve(base,name);if(!p.startsWith(base+sep))continue;
  let content;try{if(!statSync(p).isFile()||statSync(p).size>1048576||realpathSync(p)!==p)continue;content=readFileSync(p,"utf8");}catch{continue;}
  if(content.includes("\0"))continue;
  const lines=content.split("\n");let scored=[];
  for(let i=0;i<lines.length;i++){const s=lines[i].toLowerCase();const score=terms.reduce((n,t)=>n+(s.includes(t)?1:0),0);if(score)scored.push({i,score});}
  const pathScore=terms.reduce((n,t)=>n+(name.toLowerCase().includes(t)?3:0),0);
  if(!scored.length&&!pathScore)continue;
  scored.sort((a,b)=>b.score-a.score||a.i-b.i);
  const selected=new Set();for(const hit of scored.slice(0,5))for(let i=Math.max(0,hit.i-2);i<=Math.min(lines.length-1,hit.i+3);i++)selected.add(i);
  const excerpt=[...selected].sort((a,b)=>a-b).map(i=>String(i+1)+": "+lines[i]).join("\n");
  hits.push({path:name,sha256:hash(content),score:pathScore+scored.slice(0,5).reduce((n,x)=>n+x.score,0),excerpt});
 }
 hits.sort((a,b)=>b.score-a.score||a.path.localeCompare(b.path));
 let remaining=Math.min(Math.max(0,maxBytes),200000);const items=[];
 for(const h of hits.slice(0,Math.min(maxFiles,100))){const excerpt=h.excerpt.slice(0,remaining);if(!excerpt)break;items.push({...h,excerpt});remaining-=Buffer.byteLength(excerpt);}
 const revision=execFileSync("git",["-C",base,"rev-parse","HEAD"]).toString().trim();
 return {schema:"kiln.context-pack.v1",query,revision,items,bytes:items.reduce((n,x)=>n+Buffer.byteLength(x.excerpt),0),digest:hash(JSON.stringify(items))};
}
