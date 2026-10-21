/**
 * Conservative source secret detector.
 * Returns classifications only; never returns matched secret material.
 */
const RULES=[
  ["private-key",/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ["github-token",/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/],
  ["github-fine-grained-token",/\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ["aws-access-key",/\bAKIA[0-9A-Z]{16}\b/],
  ["google-api-key",/\bAIza[0-9A-Za-z_-]{30,}\b/],
  ["authorization-bearer",/\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+\/-]{16,}/i],
  ["generic-secret-assignment",/\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|private[_-]?key|password)\s*[:=]\s*["'][^"'\n]{12,}["']/i],
];

function shannon(text){
  if(!text)return 0;
  const counts=new Map();for(const c of text)counts.set(c,(counts.get(c)||0)+1);
  let h=0;for(const n of counts.values()){const p=n/text.length;h-=p*Math.log2(p);}return h;
}

export function scanSecretContent(text){
  const body=String(text||"");
  const findings=[];
  for(const [type,re] of RULES) if(re.test(body)) findings.push({type,severity:"high"});
  const candidates=body.match(/[A-Za-z0-9+\/_=-]{40,}/g)||[];
  for(const c of candidates.slice(0,200)){
    if(c.length>=48&&shannon(c)>4.2){findings.push({type:"high-entropy-token",severity:"medium"});break;}
  }
  return {safe:findings.length===0,findings};
}
