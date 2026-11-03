import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promoteRepo } from "../lib/promote.mjs";

test("promotion receipt retains only validated digest-level context evidence",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"kiln-promote-context-"));
  try{
    const evidence={
      node:"muse",
      packDigest:"a".repeat(64),
      indexDigest:"b".repeat(64),
      worktreeDigest:"c".repeat(64),
      contextReceiptHash:"d".repeat(64),
      revision:"1".repeat(40),
      ci:"context-gate:pending"
    };
    const r=await promoteRepo(dir,"missing","repo",{contextEvidence:evidence});
    assert.equal(r.ok,false);
    assert.equal(r.error.stage,"repo_not_found");
    assert.deepEqual(r.contextEvidence,evidence);
    const serialized=JSON.stringify(r);
    assert.equal(serialized.includes("query"),false);
    assert.equal(serialized.includes("excerpt"),false);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("promotion rejects malformed context evidence before any publishing work",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"kiln-promote-context-"));
  try{
    const r=await promoteRepo(dir,"missing","repo",{contextEvidence:{packDigest:"not-a-digest"}});
    assert.equal(r.ok,false);
    assert.equal(r.error.stage,"bad_evidence");
    assert.equal(r.contextEvidence,null);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
