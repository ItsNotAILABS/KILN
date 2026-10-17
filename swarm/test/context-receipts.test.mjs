import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendContextReceipt, verifyContextReceipts } from "../lib/context-receipts.mjs";

test("context receipts are hash chained and omit raw query",()=>{
  const dir=mkdtempSync(join(tmpdir(),"kiln-context-receipts-"));
  try{
    const a=appendContextReceipt(dir,{operation:"query",node:"muse",query:"private search words",packDigest:"a".repeat(64),emittedBytes:42});
    const b=appendContextReceipt(dir,{operation:"query",node:"muse",query:"second query",packDigest:"b".repeat(64),emittedBytes:21});
    assert.equal(b.previousHash,a.hash);
    const v=verifyContextReceipts(dir);
    assert.deepEqual({ok:v.ok,count:v.count},{ok:true,count:2});
    const raw=readFileSync(join(dir,"context-receipts","receipts.jsonl"),"utf8");
    assert.equal(raw.includes("private search words"),false);
    assert.equal(raw.includes("second query"),false);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("receipt verification detects tampering",()=>{
  const dir=mkdtempSync(join(tmpdir(),"kiln-context-receipts-"));
  try{
    appendContextReceipt(dir,{operation:"index",node:"muse",indexDigest:"c".repeat(64)});
    const p=join(dir,"context-receipts","receipts.jsonl");
    const row=JSON.parse(readFileSync(p,"utf8").trim());
    row.emittedBytes=999;
    writeFileSync(p,JSON.stringify(row)+"\n");
    const v=verifyContextReceipts(dir);
    assert.equal(v.ok,false);
    assert.match(v.error,/hash mismatch/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
