import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { respondentStrategyProfile } from '../core/llm/followupStrategy.mjs';
import { fallbackDialogueGuidance, validateDialogueGuidance, explicitInteractionRequest,
  composeCommunication } from '../core/llm/communication.mjs';
import { compileEvidenceContext, evidenceMessages } from '../core/semanticEvidence.mjs';
import { buildDynamicRealizerMessages, buildDynamicPolicyCriticMessages } from '../core/llm/promptRegistry.mjs';
import { buildDynamicGoal } from '../core/llm/dynamicGoalSpace.mjs';
import { handleTurn } from '../core/orchestrator.mjs';
import { auditDialogueTurn } from '../core/llm/dialogueAudit.mjs';
import { expandCompactEvidence } from '../core/llm/evidenceSchema.mjs';
import { validateSemanticEvidence } from '../core/semanticEvidence.mjs';
import { validateQuestionForTarget } from '../core/llm/dynamicBoundary.mjs';

let checks = 0;
const check = (name, test) => { test(); checks++; console.log(`PASS ${name}`); };
const self = quote => ({ respondent_distress: true, emotion_quote: quote, emotion_subject: 'respondent', temporal_scope: 'current' });
for (const [age, band] of [[6,'6-11'],[11,'6-11'],[12,'12-14'],[14,'12-14'],[15,'15-18'],[18,'15-18'],[3,'unknown'],[undefined,'unknown']]) {
  check(`age ${age} keeps the original age bands`, () => assert.equal(respondentStrategyProfile('child',{age}).age_band,band));
}
check('guardian profile remains adult-oriented even when patient is six', () => assert.match(respondentStrategyProfile('guardian',{age:6}).expression_style,/您/));
check('unknown age is not silently put in the adolescent band', () => assert.doesNotMatch(respondentStrategyProfile('child',{}).expression_style,/协商重点/));
for (const [answer, quote] of [['孩子说：“我现在很难受。”','我现在很难受'],['孩子说：“我现在很难受。”','孩子说：“我现在很难受。”'],
  ['我去年很难受。','我去年很难受'],['妈妈说我很难受。','我很难受'],['我不担心。','我不担心']]) {
  check(`reported, historical or denied distress stays unconfirmed: ${answer}`, () => assert.equal(validateDialogueGuidance(self(quote),answer,'child').respondent_distress,false));
}
check('current direct distress survives age and role validation', () => {
  assert.ok(validateDialogueGuidance(self('我现在很着急'),'我现在很着急。','guardian').respondent_distress);
  assert.ok(fallbackDialogueGuidance('害怕。','child').respondent_distress);
  assert.equal(fallbackDialogueGuidance('孩子昨晚一直哭。','guardian').respondent_distress,false);
});
check('scoped refusal, third-party stop and past stop do not terminate the whole visit', () => {
  for (const s of ['这部分我不想说。','这个问题我不想继续回答了。','我不是不想继续了。','孩子说我不想继续了。','我昨天不想继续回答了。']) assert.equal(explicitInteractionRequest(s),null);
  assert.equal(explicitInteractionRequest('我现在不想继续回答了。').kind,'stop');
  assert.equal(explicitInteractionRequest('我想先休息一下。').kind,'pause');
});
const guidance = fallbackDialogueGuidance('我现在很着急。','guardian');
check('model and old server acknowledgements are assembled only once', () => {
  const first = composeCommunication('听起来您现在有些担心，我们慢慢说。 这几次发生在多长时间里？','您说自己很着急，我们可以慢慢说。',guidance,'guardian');
  const twice = composeCommunication(first.text,first.acknowledgement,guidance,'guardian');
  assert.equal(twice.text,first.text); assert.equal((first.text.match(/着急/g)??[]).length,1);
});
check('wrong audience, empty reassurance and unlicensed acknowledgement are rejected', () => {
  assert.equal(composeCommunication('发生了什么？','你别担心，一定会好。',guidance,'guardian').acknowledgement,'我们可以慢慢说。');
  assert.equal(composeCommunication('发生了什么？','听起来您很难过。',{},'guardian').acknowledgement,'');
  assert.equal(composeCommunication('发生了什么？','您可以慢慢说。',{acknowledgement_allowed:true},'child').acknowledgement,'你可以慢慢说。');
});
const target = buildDynamicGoal({complaintId:'initial_intake_coverage',targetSlotOrIssue:'frequency_severity',targetFacetId:'frequency',missingRequirements:['reference_window']});
const input = {speakerRole:'child',profile:{age:8},answerText:'我现在很害怕。',ruleNextQuestion:target,selectedTargetFacet:target,
  candidateTargets:[target],communicationProfile:true,dialogueGuidance:fallbackDialogueGuidance('我现在很害怕。','child')};
check('Realizer receives role, age, missing requirement and validated guidance', () => {
  const built=buildDynamicRealizerMessages(input,{complaint_id:target.complaintId,target_slot_or_issue:target.targetSlotOrIssue,target_facet_id:target.targetFacetId,action_type:'clarify'});
  const context=JSON.parse(built.messages[1].content.split('\n').find(s=>s.startsWith('{')));
  assert.equal(context.respondent_context.age_band,'6-11'); assert.ok(context.dialogue_guidance.respondent_distress);
  assert.deepEqual(context.selected_strategy.missing_requirements,['reference_window']);
  assert.match(built.messages[0].content,/12–14岁/); assert.match(built.messages[0].content,/acknowledgement/);
});
check('rule prompt chain is not replaced by the semantic communication prompt', () => {
  assert.doesNotMatch(buildDynamicPolicyCriticMessages({...input,communicationProfile:false}).messages[0].content,/共同任务与来源边界/);
  assert.match(buildDynamicPolicyCriticMessages(input).messages[0].content,/共同任务与来源边界/);
});
const snapshot={session:{sessionId:'COMM-TEST',profile:{age:8,respondent:'child'},selectedComplaints:[],mappedComplaints:[]},turns:[],evidenceUnits:[],slotStates:[],riskSignals:[],decisionLogs:[]};
check('compact wire format restores canonical references without deciding sufficiency itself',()=>{
  const output=expandCompactEvidence({updates:[{facet_id:'frequency',quote:'这周三次',value:'这周三次',subject:'patient',polarity:'present',source_mode:'direct',certainty:'stated',requirements:[{id:'frequency_value',status:'met',refs:['$self']},{id:'reference_window',status:'met',refs:['$self']}]}],responses:[],safety:[]});
  const validated=validateSemanticEvidence(output,snapshot,{answerText:'这周三次。',speakerRole:'child'});
  assert.equal(validated.claims[0].slotId,'frequency_severity');
  assert.ok(validated.assessments[0].requirements.every(r=>r.status==='met'&&r.evidenceIds[0]===validated.claims[0].evidenceId));
});
check('invented nonanswer and reported refusal cannot close a field',()=>{
  for(const [answer,quote] of [['这周三次。','这周三次'],['妈妈说我不想说。','我不想说'],['我不是不想说。','不想说']]){
    const v=validateSemanticEvidence({claims:[],assessments:[],responses:[{slot_id:'frequency_severity',facet_id:'frequency',kind:'declined',quote}]},snapshot,{answerText:answer,speakerRole:'child'});
    assert.equal(v.responses.length,0);
  }
});
check('an unknown compact label is rejected without discarding valid sibling evidence',()=>{
  const good={facet_id:'frequency',quote:'这周三次',value:'这周三次',subject:'patient',polarity:'present',source_mode:'direct',certainty:'stated',requirements:[{id:'frequency_value',status:'met',refs:['$self']},{id:'reference_window',status:'met',refs:['$self']}]};
  const output=expandCompactEvidence({updates:[good,{...good,facet_id:'invented_emotion'}],responses:[],safety:[]});
  const v=validateSemanticEvidence(output,snapshot,{answerText:'这周三次。',speakerRole:'child'});
  assert.equal(v.claims.length,1);assert.equal(v.claims[0].facetId,'frequency');
  assert.ok(v.assessments[0].requirements.every(r=>r.status==='met'));
  assert.ok(v.rejected.some(r=>r.reason==='invalid_target_quote_or_provenance'));
  assert.equal(v.assessments.some(a=>a.facetId==='invented_emotion'),false);
});
check('short historical references restore immutable evidence IDs including corrections',()=>{
  const output=expandCompactEvidence({updates:[{facet_id:'frequency',quote:'近两周',value:'近两周',subject:'patient',polarity:'present',source_mode:'direct',certainty:'stated',corrects:'$p1',requirements:[{id:'frequency_value',status:'met',refs:['$p1']},{id:'reference_window',status:'met',refs:['$self']}]}]},[{evidenceId:'SC-ORIGINAL'}]);
  assert.equal(output.claims[0].corrects,'SC-ORIGINAL');
  assert.deepEqual(output.assessments[0].requirements[0].claim_ids,['SC-ORIGINAL']);
  assert.deepEqual(output.assessments[0].requirements[1].claim_ids,['c1']);
});
check('null text transport values preserve the original quote after validation',()=>{
  const output=expandCompactEvidence({updates:[{facet_id:'recent_episode',quote:'昨晚在家摔了笔',value:null,subject:'patient',polarity:'present',source_mode:'direct',certainty:'stated',requirements:[{id:'event_context',status:'met',refs:['$self']},{id:'event_detail',status:'met',refs:['$self']}]}]});
  const v=validateSemanticEvidence(output,snapshot,{answerText:'昨晚在家摔了笔。',speakerRole:'child'});
  assert.equal(v.claims[0].value,'昨晚在家摔了笔'); assert.ok(v.assessments[0].requirements.every(r=>r.status==='met'));
});
check('ordinary distress cannot be promoted into an affirmed safety signal',()=>{
  const v=validateSemanticEvidence({claims:[],assessments:[],safety:[{signal_type:'suicide',quote:'我现在很着急',subject:'patient',polarity:'present'}]},snapshot,{answerText:'我现在很着急。',speakerRole:'child'});
  assert.equal(v.safety.length,0);assert.equal(v.safetyCandidates.length,1);
});
check('semantic wording is not forced through the old facet keyword template',()=>{
  const t={targetSlotOrIssue:'current_manifestations',targetFacetId:'manifestation_description'};
  const q='你哭的时候，会做些什么呢？';
  assert.equal(validateQuestionForTarget({question:q,target:t,speakerRole:'child'}).ok,false);
  assert.ok(validateQuestionForTarget({question:q,target:t,speakerRole:'child',semanticMode:true}).ok);
  assert.equal(validateQuestionForTarget({question:'您哭的时候，会做些什么呢？',target:t,speakerRole:'child',semanticMode:true}).ok,false);
});
check('state assessor receives the same age contract as question generation', () => {
  const compiled=compileEvidenceContext(snapshot,{speakerRole:'child',answerText:'我很难受。'});
  assert.equal(compiled.context.respondent.age_band,'6-11'); assert.equal(compiled.context.respondent.role,'child');
  assert.equal(compiled.context.respondent.content_scope,undefined,'question-style preferences must not bias evidence routing');
});
const empty={claims:[],assessments:[],responses:[],safety:[],rejected:[]};
const result=handleTurn(snapshot,{speakerRole:'child',answerText:'我很难受。',semanticAssessment:empty});
const before=JSON.stringify(result.slotStates);
const audit=await auditDialogueTurn(snapshot,result,{provider:'fixture',model:'fixture',auditDialogue:async()=>({verdict:'needs_review',issues:[{type:'age_mismatch',turn_refs:[1],claim_refs:[],slot_id:'frequency_severity',facet_id:'frequency',certainty:'suspected',finding:'test',suggested_review:'review'}]})},100);
check('background audit records a finding without mutating live state',()=>{assert.equal(audit.status,'success');assert.equal(JSON.stringify(result.slotStates),before);});
const invalid=await auditDialogueTurn(snapshot,result,{provider:'fixture',model:'fixture',auditDialogue:async()=>({verdict:'needs_review',issues:[{turn_refs:[999],claim_refs:[]}]})},100);
check('audit with fabricated references is rejected',()=>assert.equal(invalid.status,'error'));
const timed=await auditDialogueTurn(snapshot,result,{provider:'fixture',model:'fixture',auditDialogue:()=>new Promise(()=>{})},100);
check('background audit has its own hard deadline',()=>{assert.match(timed.error,/timeout/);assert.ok(timed.latencyMs<1500);});
check('the original value function is byte-for-byte unchanged apart from line endings',()=>{
  const old=execFileSync('git',['show','HEAD:core/planner.mjs'],{encoding:'utf8',windowsHide:true}).replace(/\r/g,'');
  const current=readFileSync('core/planner.mjs','utf8').replace(/\r/g,'');
  const score=s=>s.slice(s.indexOf('function scoreCandidate('),s.indexOf('function countAskedTargets('));
  assert.equal(score(current),score(old));
});
console.log(`communication regression: ${checks} checks passed`);
