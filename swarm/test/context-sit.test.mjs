import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { makeStateDir, makeNode } from "./helpers.mjs";
import { createRepo } from "../lib/git.mjs";
import { remember } from "../lib/memory.mjs";
import { runTool } from "../lib/tools.mjs";

function git(cwd,args){return execFileSync("git",args,{cwd,encoding:"utf8"}).trim();}

test("context.sit fuses code with only the node own KILN repository memory",async()=>{
  const dir=makeStateDir();
  const native=createRepo(dir,"muse","project");
  const seed=mkdtempSync(join(tmpdir(),"kiln-sit-seed-"));
  try{
    git(seed,["init","-q"]);
    git(seed,["config","user.email","sit@kiln.local"]);
    git(seed,["config","user.name","sit-test"]);
    writeFileSync(join(seed,"ARCHITECTURE.md"),"# Promotion\n\nPORTA requires bounded evidence before organization promotion.\n");
    git(seed,["add","."]);
    git(seed,["commit","-qm","seed architecture"]);
    git(seed,["remote","add","origin",native.path]);
    git(seed,["push","-u","origin","HEAD:main"]);

    remember(dir,"muse","project",{
      actor:"test",
      title:"Promotion decision",
      content:"The project decided canonical organization promotion requires explicit human policy approval.",
      tags:["promotion","governance"],
      source:{type:"note",ref:"context-sit-test"}
    });

    const {ctx}=await makeNode(dir,{repo:native.path,name:"muse-sit"});
    const r=await runTool(ctx,"context.sit",{query:"promotion approval evidence",maxBytes:4096,maxChunks:5,memoryTokens:600});
    assert.equal(r.ok,true);
    const sit=JSON.parse(r.out);
    assert.equal(sit.schema,"kiln.context-sit.v1");
    assert.ok(sit.code.items.some(x=>x.path==="ARCHITECTURE.md"));
    assert.equal(sit.memory.available,true);
    assert.equal(sit.memory.owner,"muse");
    assert.equal(sit.memory.repo,"project");
    assert.match(JSON.stringify(sit.memory),/human policy approval/i);
  }finally{rmSync(seed,{recursive:true,force:true});}
});

test("context.sit does not read memory belonging to an unrelated KILN repository",async()=>{
  const dir=makeStateDir();
  createRepo(dir,"other","notes");
  remember(dir,"other","notes",{
    actor:"test",
    title:"Other repository decision",
    content:"OTHER_REPOSITORY_ONLY_MARKER",
    source:{type:"note",ref:"other-repository"}
  });
  const {ctx}=await makeNode(dir,{name:"external-node"});
  const r=await runTool(ctx,"context.sit",{query:"seed repository"});
  assert.equal(r.ok,true);
  const sit=JSON.parse(r.out);
  assert.equal(sit.memory.available,false);
  assert.equal(JSON.stringify(sit).includes("OTHER_REPOSITORY_ONLY_MARKER"),false);
});
