import test from "node:test";
import assert from "node:assert/strict";
import {scanSecretContent} from "../lib/secret-scan.mjs";

test("detects private keys and token-like assignments without returning values",()=>{
 const a=scanSecretContent("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----");
 assert.equal(a.safe,false);
 assert.equal(a.findings[0].type,"private-key");
 assert.equal(JSON.stringify(a).includes("abc"),false);
 const b=scanSecretContent('const api_key="abcdefghijklmnopqrstuvwxyz123456";');
 assert.equal(b.safe,false);
});
test("normal source remains safe",()=>assert.equal(scanSecretContent("export const add=(a,b)=>a+b;").safe,true));
