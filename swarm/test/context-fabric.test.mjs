import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFileSync} from "node:child_process";
import {contextPack} from "../lib/context-fabric.mjs";
test("bounded relevant local retrieval with stable provenance",()=>{
 const root=mkdtempSync(join(tmpdir(),"kiln-context-"));
 try{
  execFileSync("git",["init","-q",root]);
  mkdirSync(join(root,"src"));
  writeFileSync(join(root,"src","policy.js"),"export const approval = 'human approval required for github push';\n");
  writeFileSync(join(root,"src","unrelated.js"),"export const x=3;\n");
  execFileSync("git",["-C",root,"add","."]);
  execFileSync("git",["-C",root,"-c","user.name=Test","-c","user.email=test@example.invalid","commit","-qm","fixture"]);
  const p=contextPack(root,"github approval",{maxBytes:1024,maxFiles:2});
  assert.equal(p.schema,"kiln.context-pack.v1");
  assert.equal(p.items[0].path,"src/policy.js");
  assert.match(p.items[0].excerpt,/human approval/);
  assert.equal(p.items[0].sha256.length,64);
  assert.equal(p.digest.length,64);
  assert.ok(p.bytes<=1024);
  assert.deepEqual(contextPack(root,"no-such-term").items,[]);
 }finally{rmSync(root,{recursive:true,force:true});}
});
