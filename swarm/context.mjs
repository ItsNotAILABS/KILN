#!/usr/bin/env node
/**
 * KILN Context Fabric CLI.
 *
 * Local direct mode:
 *   node context.mjs local-index --repo /path/to/repo [--state ~/.kiln-context]
 *   node context.mjs local-query --repo /path/to/repo --query "..." [--max-bytes 24000]
 *
 * Daemon/node mode:
 *   node context.mjs index --node muse
 *   node context.mjs query --node muse --query "promotion authorization"
 *   node context.mjs status --node muse
 */
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { SwarmClient } from "./lib/client.mjs";
import { buildContextIndex, queryContextIndex } from "./lib/context-index.mjs";
import { boundContextRequest, contextLimits } from "./lib/context-policy.mjs";

function parse(argv) {
  const out={_:[]};
  for(let i=0;i<argv.length;i++){
    const x=argv[i];
    if(x.startsWith("--")){
      const k=x.slice(2);
      out[k]=argv[i+1]&&!argv[i+1].startsWith("--")?argv[++i]:true;
    } else out._.push(x);
  }
  return out;
}
function need(a,k){if(a[k]===undefined)throw new Error("missing --"+k);return a[k];}
function num(a,k,d){return a[k]===undefined?d:Number(a[k]);}
function directState(a){
  const p=resolve(String(a.state||process.env.KILN_CONTEXT_DIR||join(homedir(),".kiln-context")));
  mkdirSync(p,{recursive:true,mode:0o700});
  return p;
}
function print(obj){process.stdout.write(JSON.stringify(obj,null,2)+"\n");}

const a=parse(process.argv.slice(2));
const cmd=a._[0];
try {
  if(cmd==="local-index"){
    const repo=resolve(String(need(a,"repo")));
    const index=buildContextIndex(repo,directState(a),{chunkLines:num(a,"chunk-lines",undefined),overlap:num(a,"overlap",undefined)});
    print({schema:index.schema,digest:index.digest,revision:index.revision,dirty:index.dirty,worktreeDigest:index.worktreeDigest,stats:index.stats,skipped:index.skipped});
  } else if(cmd==="local-query"){
    const repo=resolve(String(need(a,"repo")));
    const index=buildContextIndex(repo,directState(a),{chunkLines:num(a,"chunk-lines",undefined),overlap:num(a,"overlap",undefined)});
    const request=boundContextRequest({
      query:String(need(a,"query")),
      maxBytes:num(a,"max-bytes",24000),
      maxChunks:num(a,"max-chunks",12),
      mmrLambda:num(a,"mmr-lambda",0.78),
    },"query");
    print(queryContextIndex(index,request.query,request));
  } else if(cmd==="index"){
    const client=await SwarmClient.connect({dir:a.dir?resolve(String(a.dir)):undefined});
    print(await client.contextIndex(String(need(a,"node")),{chunkLines:num(a,"chunk-lines",undefined),overlap:num(a,"overlap",undefined)}));
  } else if(cmd==="query"){
    const client=await SwarmClient.connect({dir:a.dir?resolve(String(a.dir)):undefined});
    print(await client.contextQuery(String(need(a,"node")),String(need(a,"query")),{maxBytes:num(a,"max-bytes",24000),maxChunks:num(a,"max-chunks",12),mmrLambda:num(a,"mmr-lambda",0.78)}));
  } else if(cmd==="delta"){
    const client=await SwarmClient.connect({dir:a.dir?resolve(String(a.dir)):undefined});
    const fs=await import("node:fs");
    const prior=JSON.parse(fs.readFileSync(resolve(String(need(a,"prior"))),"utf8"));
    print(await client.contextDelta(String(need(a,"node")),String(need(a,"query")),prior,{
      maxBytes:num(a,"max-bytes",24000),maxChunks:num(a,"max-chunks",12),mmrLambda:num(a,"mmr-lambda",0.78)
    }));
  } else if(cmd==="status"){
    const client=await SwarmClient.connect({dir:a.dir?resolve(String(a.dir)):undefined});
    print(await client.contextStatus(String(need(a,"node"))));
  } else if(cmd==="metrics"){
    const client=await SwarmClient.connect({dir:a.dir?resolve(String(a.dir)):undefined});
    print(await client.contextMetrics());
  } else if(cmd==="limits"){
    print(contextLimits());
  } else if(cmd==="verify"){
    const client=await SwarmClient.connect({dir:a.dir?resolve(String(a.dir)):undefined});
    print(await client.contextReceiptsVerify());
  } else {
    console.error("usage: context.mjs local-index|local-query|index|query|delta|status|metrics|limits|verify [options]");
    process.exit(2);
  }
} catch(e) {
  console.error("context error: "+e.message);
  process.exit(1);
}
