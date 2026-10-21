import test from "node:test";
import assert from "node:assert/strict";
import { buildRepoGraph, impactFromPaths } from "../lib/repo-graph.mjs";

const index={
  repoName:"demo",revision:"abc",worktreeDigest:"w",digest:"i",
  files:[
    {path:"src/a.js",sha256:"a",bytes:1,symbols:["alpha"],imports:["./b"]},
    {path:"src/b.js",sha256:"b",bytes:1,symbols:["beta"],imports:[]},
    {path:"src/c.js",sha256:"c",bytes:1,symbols:["gamma"],imports:["./a"]},
  ],
  chunks:[]
};
test("repo graph builds symbol/import edges and impact propagates",()=>{
  const g=buildRepoGraph(index);
  assert.equal(g.stats.files,3);
  assert.equal(g.stats.symbols,3);
  assert.equal(g.stats.imports,2);
  const impact=impactFromPaths(g,["src/b.js"],{depth:2});
  assert.ok(impact.affected.some(x=>x.path==="src/a.js"));
  assert.ok(impact.affected.some(x=>x.path==="src/c.js"));
});
