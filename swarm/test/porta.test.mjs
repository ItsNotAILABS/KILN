import test from "node:test";
import assert from "node:assert/strict";
import {evaluatePromotion,buildPromotionRequest} from "../lib/porta.mjs";

const good={
 actor:{id:"muse"},
 source:{workspaceId:"muse/kiln"},
 target:{organization:"ItsNotAILABS",repository:"KILN"},
 diffDigest:"a".repeat(64),
 worktreeDirty:false,
 evidence:{testsPassed:true,secretScanPassed:true},
 policy:{allowOrganizationPush:true,requiresApproval:true},
 approval:{approved:true},
};
test("PORTA denies missing evidence/authority",()=>{
 const d=evaluatePromotion({...good,evidence:{testsPassed:false,secretScanPassed:true}});
 assert.equal(d.decision,"deny");
 assert.ok(d.reasons.includes("tests-not-passed"));
});
test("PORTA allows fully evidenced approved promotion",()=>{
 const d=evaluatePromotion(good);
 assert.equal(d.decision,"allow");
 assert.deepEqual(d.reasons,[]);
});
test("promotion request is nexus-shaped",()=>{
 const r=buildPromotionRequest({...good,diffDigest:good.diffDigest});
 assert.equal(r.schema,"nexus.promotion-request.v1");
 assert.equal(r.state,"draft");
});
