import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SwarmClient } from "../lib/client.mjs";
import { makeStateDir, makeGitRepo } from "./helpers.mjs";
import { pidAlive } from "../lib/state.mjs";

const HERE=dirname(fileURLToPath(import.meta.url));
const DAEMON=join(HERE,"..","lib","daemon.mjs");
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));

async function waitApi(dir){
  const until=Date.now()+20000;
  while(Date.now()<until){
    const p=join(dir,"daemon.json");
    if(existsSync(p)){
      try{const d=JSON.parse(readFileSync(p,"utf8"));if(d.apiUrl)return d;}catch{}
    }
    await sleep(100);
  }
  throw new Error("context api daemon timeout");
}

test("Context Fabric API is authenticated, node-bound, delta-aware and signed",async()=>{
  const dir=makeStateDir();
  const repo=makeGitRepo();
  writeFileSync(join(repo,"CONTEXT_TARGET.md"),"# Promotion\n\nHuman approval is required before canonical GitHub promotion.\n");
  const {execFileSync}=await import("node:child_process");
  execFileSync("git",["-C",repo,"add","CONTEXT_TARGET.md"]);
  execFileSync("git",["-C",repo,"commit","-qm","context target"]);

  const daemon=spawn(process.execPath,[DAEMON],{
    env:{...process.env,KILN_SWARM_DIR:dir,KILN_SWARM_API_PORT:"0"},
    stdio:["ignore","pipe","pipe"],
  });
  try{
    const dj=await waitApi(dir);
    const unauth=await fetch(dj.apiUrl+"/v1/context/nodes/nope/status");
    assert.equal(unauth.status,401);

    const client=await SwarmClient.connect({dir});
    const {id}=await client.spawnNode({name:"context-api-node",caps:0,ttlSec:3600,repo});
    assert.ok(id);

    const built=await client.contextIndex(id);
    assert.equal(built.index.schema,"kiln.context-index.v1");
    assert.equal(built.receipt.schema,"kiln.context-receipt.v2");
    assert.equal(built.receipt.signature.length>20,true);

    const first=await client.contextQuery(id,"github promotion human approval",{maxBytes:4096,maxChunks:5});
    assert.equal(first.pack.schema,"kiln.context-pack.v2");
    assert.ok(first.pack.items.some(x=>x.path==="CONTEXT_TARGET.md"));
    assert.match(first.pack.items.map(x=>x.excerpt).join("\n"),/Human approval/);

    const delta=await client.contextDelta(id,"github promotion human approval",first.pack,{maxBytes:4096,maxChunks:5});
    assert.equal(delta.pack.stats.emittedBytes,0);
    assert.ok(delta.pack.unchanged.length>=1);

    const status=await client.contextStatus(id);
    assert.equal(status.index.digest,first.pack.indexDigest);

    const verified=await client.contextReceiptsVerify();
    assert.equal(verified.ok,true);
    assert.ok(verified.count>=3);

    const bad=await client.contextQuery(id,"",{maxBytes:4096}).then(()=>null,e=>e);
    assert.ok(bad);

    await client.stopNode(id);
  }finally{
    if(pidAlive(daemon.pid)){
      daemon.kill("SIGTERM");
      await new Promise(r=>{daemon.once("exit",r);setTimeout(r,5000);});
    }
  }
});
