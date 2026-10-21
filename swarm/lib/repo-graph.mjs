/**
 * KILN repository cognition graph.
 *
 * Zero-dependency structural graph derived from context-index metadata and
 * tracked source. This is intentionally parser-lite today; a Tree-sitter
 * adapter can replace/augment extraction without changing the graph schema.
 */
import { createHash } from "node:crypto";

const SCHEMA="kiln.repo-graph.v1";
const sha=v=>createHash("sha256").update(v).digest("hex");
const uniq=xs=>[...new Set(xs.filter(Boolean))];

function symbolId(path,name){return "sym:"+sha(path+"\0"+name).slice(0,24);}
function fileId(path){return "file:"+sha(path).slice(0,24);}

export function buildRepoGraph(index){
  if(!index?.files||!index?.chunks) throw new Error("repo graph requires context index");
  const nodes=[], edges=[];
  const byPath=new Map();
  for(const f of index.files){
    const fid=fileId(f.path);
    const fileNode={id:fid,type:"file",path:f.path,sha256:f.sha256,bytes:f.bytes};
    nodes.push(fileNode); byPath.set(f.path,fileNode);
    for(const s of uniq(f.symbols||[])){
      const sid=symbolId(f.path,s);
      nodes.push({id:sid,type:"symbol",name:s,path:f.path,file:fid});
      edges.push({from:fid,to:sid,type:"defines"});
    }
  }
  const paths=new Set(index.files.map(f=>f.path));
  const resolveDep=(from,spec)=>{
    if(!spec?.startsWith("."))return null;
    const parts=from.split("/");parts.pop();
    for(const seg of spec.split("/")){
      if(!seg||seg===".")continue;
      if(seg==="..")parts.pop(); else parts.push(seg);
    }
    const raw=parts.join("/");
    const c=[raw,raw+".js",raw+".ts",raw+".tsx",raw+".jsx",raw+".mjs",raw+".py",raw+"/index.js",raw+"/index.ts",raw+"/index.tsx"];
    return c.find(x=>paths.has(x))||null;
  };
  for(const f of index.files){
    const from=byPath.get(f.path)?.id;
    for(const spec of f.imports||[]){
      const dep=resolveDep(f.path,spec); if(!dep)continue;
      edges.push({from,to:byPath.get(dep).id,type:"imports",spec});
    }
  }
  const reverse=new Map();
  for(const e of edges){
    if(e.type!=="imports")continue;
    const a=reverse.get(e.to)||[];a.push(e.from);reverse.set(e.to,a);
  }
  const graph={
    schema:SCHEMA,
    repo:index.repoName,
    revision:index.revision,
    worktreeDigest:index.worktreeDigest,
    indexDigest:index.digest,
    generatedAt:new Date().toISOString(),
    nodes,edges,
    stats:{
      files:nodes.filter(n=>n.type==="file").length,
      symbols:nodes.filter(n=>n.type==="symbol").length,
      imports:edges.filter(e=>e.type==="imports").length,
    },
  };
  graph.digest=sha(JSON.stringify({nodes,edges,indexDigest:index.digest}));
  return graph;
}

export function impactFromPaths(graph,paths,{depth=2}={}){
  const wanted=new Set(paths);
  const files=graph.nodes.filter(n=>n.type==="file");
  const byId=new Map(files.map(f=>[f.id,f]));
  const frontier=files.filter(f=>wanted.has(f.path)).map(f=>f.id);
  const seen=new Set(frontier);
  const affected=[];
  for(let d=0;d<=Math.max(0,Math.min(8,depth));d++){
    const next=[];
    for(const id of frontier.splice(0,frontier.length)){
      const node=byId.get(id);if(node)affected.push({path:node.path,distance:d});
      for(const e of graph.edges){
        if(e.type!=="imports")continue;
        if(e.to===id&&!seen.has(e.from)){seen.add(e.from);next.push(e.from);}
        if(e.from===id&&!seen.has(e.to)){seen.add(e.to);next.push(e.to);}
      }
    }
    frontier.push(...next);
  }
  return {schema:"kiln.impact-set.v1",changed:[...wanted],affected,digest:sha(JSON.stringify(affected))};
}
