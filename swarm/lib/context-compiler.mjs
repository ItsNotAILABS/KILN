/**
 * KILN Context Compiler.
 *
 * Combines source retrieval, repository graph hints, verified facts and token
 * budgets into one bounded mission pack. No model call occurs here.
 */
import { buildRepoGraph } from "./repo-graph.mjs";
import { queryFacts } from "./knowledge-ledger.mjs";
import { packToTokenBudget, estimateTokens } from "./token-budget.mjs";
import { createHash } from "node:crypto";

const sha=v=>createHash("sha256").update(v).digest("hex");

export async function compileContext({
  index,
  sourcePack,
  knowledgeDir,
  query,
  tokenBudget=12000,
  tokenize,
  includeFacts=true,
  includeGraph=true,
}){
  if(!index||!sourcePack)throw new Error("compileContext requires index and sourcePack");
  if(!(tokenBudget>0))throw new Error("compileContext requires positive tokenBudget");

  const sections=[];
  const repoMap={
    repo:index.repoName,
    revision:index.revision,
    dirty:index.dirty,
    worktreeDigest:index.worktreeDigest,
    indexedFiles:index.stats?.indexedFiles||0,
    chunks:index.stats?.chunks||0,
  };
  sections.push({kind:"repository-map",priority:100,excerpt:JSON.stringify(repoMap)});

  if(includeFacts&&knowledgeDir){
    const facts=queryFacts(knowledgeDir,index,query)
      .filter(f=>f.status==="current")
      .slice(0,32);
    for(const f of facts){
      sections.push({
        kind:"verified-fact",
        priority:90,
        factId:f.id,
        excerpt:JSON.stringify({
          subject:f.subject,predicate:f.predicate,value:f.value,
          confidence:f.confidence,evidence:f.evidence,status:f.status,
        }),
      });
    }
  }

  if(includeGraph){
    const graph=buildRepoGraph(index);
    const relevantPaths=new Set((sourcePack.items||[]).map(x=>x.path));
    const relevantFileIds=new Set(graph.nodes.filter(n=>n.type==="file"&&relevantPaths.has(n.path)).map(n=>n.id));
    const edges=graph.edges.filter(e=>relevantFileIds.has(e.from)||relevantFileIds.has(e.to)).slice(0,128);
    const nodes=graph.nodes.filter(n=>relevantFileIds.has(n.id)||(n.file&&relevantFileIds.has(n.file))).slice(0,256);
    if(nodes.length||edges.length){
      sections.push({kind:"repo-graph",priority:80,excerpt:JSON.stringify({nodes,edges,graphDigest:graph.digest})});
    }
  }

  for(const item of sourcePack.items||[]){
    sections.push({
      kind:"source",
      priority:70 + Math.min(20,Number(item.score||0)),
      path:item.path,
      sha256:item.sha256,
      startLine:item.startLine,
      endLine:item.endLine,
      excerpt:item.excerpt,
    });
  }

  sections.sort((a,b)=>b.priority-a.priority);
  const packed=await packToTokenBudget(sections,tokenBudget,{tokenize,profile:"code"});
  const mission={
    schema:"kiln.context-compiled.v1",
    query:String(query),
    repo:index.repoName,
    revision:index.revision,
    worktreeDigest:index.worktreeDigest,
    sourcePackDigest:sourcePack.digest,
    tokenBudget,
    tokenUsed:packed.used,
    tokenRemaining:packed.remaining,
    tokenExact:packed.exact,
    generatedAt:new Date().toISOString(),
    sections:packed.items,
    omissions:sourcePack.omissions||[],
  };
  mission.digest=sha(JSON.stringify({
    query:mission.query,revision:mission.revision,worktreeDigest:mission.worktreeDigest,
    sourcePackDigest:mission.sourcePackDigest,sections:mission.sections.map(s=>[s.kind,s.path||s.factId||null,s.sha256||null,s.tokenCount]),
  }));
  return mission;
}

export function estimateCompiledContext(sections,profile="code"){
  return sections.reduce((n,s)=>n+estimateTokens(s.excerpt||"",profile),0);
}
