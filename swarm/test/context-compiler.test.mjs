import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {putFact} from "../lib/knowledge-ledger.mjs";
import {compileContext} from "../lib/context-compiler.mjs";

test("compiler combines verified facts, graph and source under exact budget",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"kiln-compiler-"));
 try{
  const index={
   repoName:"demo",revision:"r1",dirty:false,worktreeDigest:"w",digest:"idx",
   stats:{indexedFiles:1,chunks:1},
   files:[{path:"a.js",sha256:"h",bytes:12,symbols:["approve"],imports:[]}],
   chunks:[{id:"c",path:"a.js",startLine:1,endLine:1,text:"const approve=true;",tokenTerms:3,tf:{approve:1,const:1,true:1}}],
   documentFrequency:{approve:1,const:1,true:1}
  };
  putFact(dir,{subject:"a.js",predicate:"role",value:"promotion gate",evidence:[{path:"a.js",sha256:"h"}]});
  const sourcePack={digest:"p",items:[{path:"a.js",sha256:"h",startLine:1,endLine:1,score:2,excerpt:"1: const approve=true;"}],omissions:[]};
  const out=await compileContext({index,sourcePack,knowledgeDir:dir,query:"promotion approve",tokenBudget:100,tokenize:s=>s.split(/\s+/)});
  assert.equal(out.schema,"kiln.context-compiled.v1");
  assert.equal(out.tokenExact,true);
  assert.ok(out.sections.some(s=>s.kind==="verified-fact"));
  assert.ok(out.sections.some(s=>s.kind==="source"));
  assert.ok(out.tokenUsed<=100);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
