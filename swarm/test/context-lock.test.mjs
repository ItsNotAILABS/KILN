import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { loadIndex } from "../lib/context-index.mjs";

const HERE=dirname(fileURLToPath(import.meta.url));
const INDEX=join(HERE,"..","lib","context-index.mjs");

function git(root,args){return execFileSync("git",["-C",root,...args],{encoding:"utf8"}).trim();}
function runIndexer(repo,state){
  const code=`
    import { buildContextIndex } from ${JSON.stringify(pathToFileURL(INDEX).href)};
    const index=buildContextIndex(${JSON.stringify(repo)},${JSON.stringify(state)},{chunkLines:20,overlap:4});
    process.stdout.write(index.digest+"\\n");
  `;
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,["--input-type=module","-e",code],{stdio:["ignore","pipe","pipe"]});
    let out="",err="";
    child.stdout.on("data",d=>out+=d);
    child.stderr.on("data",d=>err+=d);
    child.on("error",reject);
    child.on("exit",code=>code===0?resolve(out.trim()):reject(new Error(err||`indexer exited ${code}`)));
  });
}

test("two processes can build the same persistent context index without corruption",async()=>{
  const repo=mkdtempSync(join(tmpdir(),"kiln-context-lock-repo-"));
  const state=mkdtempSync(join(tmpdir(),"kiln-context-lock-state-"));
  try{
    git(repo,["init","-q"]);
    git(repo,["config","user.email","lock@kiln.local"]);
    git(repo,["config","user.name","lock-test"]);
    mkdirSync(join(repo,"src"),{recursive:true});
    for(let i=0;i<40;i++)writeFileSync(join(repo,"src",`module-${i}.js`),`export const module${i} = ${i};\\n`);
    git(repo,["add","."]);
    git(repo,["commit","-qm","fixture"]);

    const [a,b]=await Promise.all([runIndexer(repo,state),runIndexer(repo,state)]);
    assert.equal(a,b);
    const loaded=loadIndex(state,repo);
    assert.ok(loaded);
    assert.equal(loaded.digest,a);
    const locksDir=join(state,"locks");
    const locks=readdirSync(locksDir).filter(x=>x.endsWith(".lock"));
    assert.deepEqual(locks,[]);
  }finally{
    rmSync(repo,{recursive:true,force:true});
    rmSync(state,{recursive:true,force:true});
  }
});
