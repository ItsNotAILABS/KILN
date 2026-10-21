/**
 * PORTA promotion policy engine.
 * Pure evaluation only: it NEVER pushes, merges, or writes GitHub.
 */
import {createHash} from "node:crypto";
const sha=v=>createHash("sha256").update(v).digest("hex");
export const PROMOTION_STATES=["draft","blocked","ready","approved","executed","rejected"];
export function evaluatePromotion(req){
 const reasons=[];
 if(!req?.actor?.id)reasons.push("missing-actor");
 if(!req?.source?.workspaceId)reasons.push("missing-source-workspace");
 if(!req?.target?.organization||!req?.target?.repository)reasons.push("missing-target");
 if(!req?.diffDigest)reasons.push("missing-diff-digest");
 if(req?.worktreeDirty)reasons.push("dirty-worktree");
 if(!req?.evidence?.testsPassed)reasons.push("tests-not-passed");
 if(!req?.evidence?.secretScanPassed)reasons.push("secret-scan-not-passed");
 if(!req?.policy?.allowOrganizationPush)reasons.push("organization-push-not-authorized");
 if(req?.policy?.requiresApproval&&!req?.approval?.approved)reasons.push("approval-required");
 const decision=reasons.length?"deny":"allow";
 const result={
  schema:"kiln.porta-decision.v1",
  decision,reasons,
  actor:req?.actor?.id||null,
  source:req?.source||null,target:req?.target||null,
  diffDigest:req?.diffDigest||null,
  observedAt:new Date().toISOString(),
 };
 result.digest=sha(JSON.stringify(result));
 return result;
}
export function buildPromotionRequest(input){
 const req={
  schema:"nexus.promotion-request.v1",
  promotion_id:input.promotion_id||"promo-"+sha(JSON.stringify(input)).slice(0,20),
  actor:input.actor,
  source:input.source,
  target:input.target,
  diff_digest:input.diffDigest,
  policy:input.policy||{},
  evidence:input.evidence||{},
  state:"draft",
  created_at:new Date().toISOString(),
 };
 return req;
}
