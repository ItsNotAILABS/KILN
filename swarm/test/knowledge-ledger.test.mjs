import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {putFact,evaluateFacts,queryFacts} from "../lib/knowledge-ledger.mjs";

test("fact stales when evidence hash changes",()=>{
 const dir=mkdtempSync(join(tmpdir(),"kiln-facts-"));
 try{
  putFact(dir,{subject:"httpapi",predicate:"role",value:"local boundary",evidence:[{path:"a.js",sha256:"1"}]});
  const fresh=evaluateFacts(dir,{files:[{path:"a.js",sha256:"1"}]});
  assert.equal(fresh[0].status,"current");
  const stale=evaluateFacts(dir,{files:[{path:"a.js",sha256:"2"}]});
  assert.equal(stale[0].status,"stale");
  assert.equal(queryFacts(dir,{files:[{path:"a.js",sha256:"1"}]},"local").length,1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
