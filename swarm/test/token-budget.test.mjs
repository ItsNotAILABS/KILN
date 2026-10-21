import test from "node:test";
import assert from "node:assert/strict";
import {countTokens,packToTokenBudget} from "../lib/token-budget.mjs";

test("custom tokenizer is treated as exact",async()=>{
 const c=await countTokens("abc",{tokenize:s=>s.split("")});
 assert.deepEqual(c,{count:3,exact:true,profile:"custom"});
});
test("packer respects exact budget",async()=>{
 const r=await packToTokenBudget([{excerpt:"aa"},{excerpt:"bbb"},{excerpt:"c"}],4,{tokenize:s=>s.split("")});
 assert.equal(r.used,3);
 assert.equal(r.items.length,2);
 assert.equal(r.exact,true);
});
