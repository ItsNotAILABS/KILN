/**
 * Token budget adapters.
 * Exact counting is supported only when a caller supplies an explicit tokenizer function.
 * Built-in profiles are conservative estimates and are labeled as estimates.
 */
export const TOKEN_PROFILES={
  generic:{id:"generic",charsPerToken:3.6},
  code:{id:"code",charsPerToken:3.2},
  prose:{id:"prose",charsPerToken:4.0},
};
export function estimateTokens(text,profile="generic"){
 const p=TOKEN_PROFILES[profile]||TOKEN_PROFILES.generic;
 return Math.ceil(String(text).length/p.charsPerToken);
}
export async function countTokens(text,{tokenize,profile="generic"}={}){
 if(typeof tokenize==="function"){
  const out=await tokenize(String(text));
  const count=Array.isArray(out)?out.length:Number(out);
  if(!Number.isFinite(count)||count<0)throw new Error("tokenizer returned invalid count");
  return {count,exact:true,profile:"custom"};
 }
 return {count:estimateTokens(text,profile),exact:false,profile};
}
export async function packToTokenBudget(items,budget,{tokenize,profile="code"}={}){
 if(!(budget>0))throw new Error("positive token budget required");
 const out=[];let used=0;
 for(const item of items){
  const c=await countTokens(item.excerpt||item.text||"",{tokenize,profile});
  if(used+c.count>budget)continue;
  out.push({...item,tokenCount:c.count,tokenExact:c.exact});used+=c.count;
 }
 return {items:out,used,remaining:Math.max(0,budget-used),budget,exact:out.every(x=>x.tokenExact)};
}
