import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.mjs';
import { handleTurn } from '../core/orchestrator.mjs';
import { buildSemanticDialogueMessages, runSemanticDialogue, semanticDialogueSchema } from '../core/llm/semanticDialogue.mjs';

const root = mkdtempSync(join(tmpdir(), 'previsit-dialogue-unit-'));
const store = createStore(join(root, 'synthetic.db'));
const empty = { claims: [], assessments: [], responses: [], safety: [] };
let checks = 0;
const check = (name, test) => { test(); checks++; console.log('PASS ' + name); };
const fresh = () => store.getSnapshot(store.createSession({ profile: { age: 8, respondent: 'child' }, stateBuilderMode: 'semantic' }).sessionId);
const turn = snapshot => handleTurn(snapshot, { speakerRole: 'child', answerText: '我在学校有点难受。', semanticAssessment: empty });
const decision = extra => ({ next_action: 'ask', target_facet_id: 'protective_summary', action_type: 'explore',
  question: '难受的时候，谁能帮到你？', acknowledgement: '', selection_reason: '了解受访者能获得的支持。', ...extra });
const runtime = output => ({ enabled: true, mode: 'dynamic', provider: { provider: 'fixture', model: 'fixture',
  decideDialogue: async () => output,
  reviewCompletion: async () => ({ verdict: 'allow_complete', reason: '保留未知交医生核实。',
    findings: [{ facet_id: 'primary_concern', necessity: 'essential', status: 'supported', explanation: '已有本人困扰陈述。', refs: [{ turn: 1, quote: '我在学校有点难受' }] }],
    decision: output }) } });
try {
  let snapshot = fresh(), result = turn(snapshot);
  check('ordinary semantic orchestration leaves the target and completion decision to the model', () => {
    assert.equal(result.nextAction, 'awaiting_model'); assert.equal(result.nextQuestion, null);
    assert.deepEqual(result.decisionLog.candidateQuestions, []);
  });
  check('LLM sees all goals without a ranked shortlist, original score, or preselected target', () => {
    const { context } = buildSemanticDialogueMessages(snapshot, result);
    assert.equal(Object.keys(context.information_goals).length, 44);
    assert.equal(context.respondent_context.age_band, '6-11');
    for (const key of ['selected_target_facet', 'candidate_targets', 'rule_next_question', 'score', 'attempt_limit']) assert.equal(key in context, false);
  });
  await runSemanticDialogue(runtime(decision()), snapshot, result);
  check('the model can choose a goal directly and its exact selected target is applied', () => {
    assert.equal(result.nextQuestion.targetFacetId, 'protective_summary');
    assert.equal(result.decisionLog.boundaryCheckResult.planner, 'llm');
  });
  result = turn(snapshot);
  await runSemanticDialogue(runtime(decision({ target_facet_id: 'onset_time', action_type: 'explore', question: '你还记得第一次出现这种感觉的事吗？' })), snapshot, result);
  check('goal labels do not impose a fixed action type or keyword requirement', () => {
    assert.equal(result.nextQuestion.targetFacetId, 'onset_time');
    assert.equal(result.decisionLog.boundaryCheckResult.selectedActionType, 'explore');
  });
  result = turn(snapshot);
  await runSemanticDialogue(runtime(decision({ next_action: 'complete', target_facet_id: null, action_type: null, question: '', selection_reason: '继续追问负担较大，保留未知交医生。' })), snapshot, result);
  check('LLM may complete with coverage gaps without relabelling them sufficient', () => {
    assert.equal(result.nextAction, 'complete'); assert.equal(result.nextQuestion, null);
    assert.equal(result.progress.requiredFilled, 0);
    assert.ok(result.slotStates.some(s => s.status === 'missing'));
  });
  snapshot.turns = Array.from({ length: 28 }, (_, i) => ({ turnNo: i + 1, speakerRole: 'child', answerText: '合成历史' }));
  snapshot.decisionLogs = Array.from({ length: 28 }, () => ({ modelAudits: [{ task: 'llm_dynamic_next_question', status: 'success' }] }));
  result = turn(snapshot);
  await runSemanticDialogue(runtime(decision()), snapshot, result);
  check('ordinary LLM dialogue is not stopped by the old 24-turn or 18-call rule', () => {
    assert.equal(result.nextAction, 'ask'); assert.equal(result.nextQuestion.policyType, 'llm_dynamic');
  });
  snapshot = fresh(); result = turn(snapshot);
  const stateBefore = JSON.stringify(result.slotStates);
  const failed = await runSemanticDialogue({ ...runtime(null), provider: { provider: 'fixture', model: 'fixture', decideDialogue: async () => { throw Error('unavailable'); } } }, snapshot, result);
  check('model failure preserves evidence and waits for retry without a rule-selected fallback', () => {
    assert.equal(failed.status, 'error'); assert.equal(result.nextAction, 'pause');
    assert.equal(result.nextQuestion.policyType, 'llm_retry'); assert.equal(result.status, 'in_progress');
    assert.equal(JSON.stringify(result.slotStates), stateBefore);
  });
  result = turn(snapshot); let correctionCalls=0; const budgets=[];
  const corrected = await runSemanticDialogue({enabled:true,mode:'dynamic',provider:{provider:'fixture',model:'fixture',
    decideDialogue:async input=>{correctionCalls++;budgets.push(input.timeoutMs);assert.ok(input.signal instanceof AbortSignal);
      return correctionCalls===1?decision({target_facet_id:'invented'}):decision();}}},snapshot,result);
  check('an invalid returned decision gets one LLM correction inside the original budget',()=>{
    assert.equal(corrected.status,'success');assert.equal(correctionCalls,2);assert.equal(result.nextAction,'ask');
    assert.ok(budgets[0]<=8000&&budgets[1]<=budgets[0]);
    assert.equal(corrected.output._protocol_correction.previous_output.target_facet_id,'invented');
  });
  result = turn(snapshot); let networkCalls=0;
  await runSemanticDialogue({enabled:true,mode:'dynamic',provider:{provider:'fixture',model:'fixture',decideDialogue:async()=>{networkCalls++;throw Error('network unavailable');}}},snapshot,result);
  check('network failures do not trigger automatic correction or retry',()=>{
    assert.equal(networkCalls,1);assert.equal(result.nextQuestion.policyType,'llm_retry');
  });
  result = turn(snapshot);
  const invalid = await runSemanticDialogue(runtime(decision({ target_facet_id: 'invented' })), snapshot, result);
  check('invalid storage labels are rejected without substituting a rule question', () => {
    assert.equal(invalid.status, 'error'); assert.equal(result.nextQuestion.policyType, 'llm_retry');
  });
  result = turn(snapshot);
  const typo=decision(); typo.target_facid=typo.target_facet_id; delete typo.target_facet_id;
  await runSemanticDialogue(runtime(typo), snapshot, result);
  check('an unambiguous target field typo is repaired without selecting a new target',()=>{
    assert.equal(result.nextQuestion.targetFacetId,'protective_summary');
    assert.deepEqual(result.decisionLog.boundaryCheckResult.protocolRepairs,['target_facid_spelling']);
  });
  result = turn(snapshot);
  await runSemanticDialogue(runtime(decision({target_facid:'onset_time'})), snapshot, result);
  check('contradictory target spellings remain rejected',()=>assert.equal(result.nextQuestion.policyType,'llm_retry'));
  result = turn(snapshot);
  await runSemanticDialogue(runtime(decision({question:'谁能帮助你？比如家里人还是朋友？'})),snapshot,result);
  check('a question followed by its example is joined without another model call',()=>{
    assert.equal(result.nextQuestion.question,'谁能帮助你，比如家里人还是朋友？');
  });
  result = turn(snapshot);
  await runSemanticDialogue(runtime(decision({question:'谁能帮助你？从什么时候开始难受？'})),snapshot,result);
  check('independent multiple questions are not silently merged',()=>assert.equal(result.nextQuestion.policyType,'llm_retry'));
  result = turn(snapshot); result.dialogueTurn.questionText = '难受的时候，谁能帮到你？';
  const repeated = await runSemanticDialogue(runtime(decision()), snapshot, result);
  check('an exact repeated question is rejected rather than shown to the respondent', () => {
    assert.equal(repeated.status, 'error'); assert.equal(result.nextQuestion.policyType, 'llm_retry');
  });
  result = turn(snapshot); snapshot.caseEvidenceState = { secret: 'other-source-private' };
  check('the dialogue context cannot include another source or the downstream case graph', () => {
    assert.ok(!JSON.stringify(buildSemanticDialogueMessages(snapshot, result)).includes('other-source-private'));
  });
  snapshot.turns = [{ questionText: '那次发生了什么？', answerText: '我在学校有点难受。', questionPolicyType: 'llm_dynamic' },
    { questionText: '请稍后继续。', answerText: '继续', questionPolicyType: 'llm_retry' },
    { questionText: '请稍后继续。', answerText: '继续', questionPolicyType: 'llm_retry' }];
  result.stateBuilderExecution = 'model_retry';
  check('repeated retries retain the original substantive exchange rather than the continue commands', () => {
    assert.equal(buildSemanticDialogueMessages(snapshot, result).context.current_exchange.answer, '我在学校有点难受。');
  });
  snapshot = fresh(); result = turn(snapshot);
  const sources = buildSemanticDialogueMessages(snapshot, result).context.original_sources;
  await runSemanticDialogue(runtime(decision({ context_check: [{ facet_id: 'protective_summary', status: 'known', source_ids: [sources[0].id] }] })), snapshot, result);
  check('a question conflicting with the LLM own cited known-content check is rejected', () => {
    assert.equal(result.nextQuestion.policyType, 'llm_retry');
  });
  result = turn(snapshot);
  await runSemanticDialogue(runtime(decision({ context_check: [{ facet_id: 'protective_summary', status: 'unavailable', source_ids: [sources[0].id] }] })), snapshot, result);
  check('a model unavailable label is not alone a program-imposed stop on a new question', () => {
    assert.equal(result.nextAction, 'ask');
  });
  result = turn(snapshot);
  await runSemanticDialogue(runtime(decision({ context_check: [{ facet_id: 'primary_concern', status: 'known', source_ids: ['OTHER-SESSION'] }] })), snapshot, result);
  check('context checks cannot cite another session or invented source IDs', () => {
    assert.equal(result.nextQuestion.policyType, 'llm_retry');
  });
  snapshot = fresh(); result = turn(snapshot);
  const refused = result.slotStates.find(s => s.slotId === 'current_manifestations').value.facets.recent_episode;
  refused.responseState = { kind: 'declined', quote: '我在学校有点难受。' }; refused.collectionClosed = true;
  check('the model receives the opt-out original text rather than only a field label', () => {
    const scope = buildSemanticDialogueMessages(snapshot, result).context.refusal_scopes[0];
    assert.equal(scope.quote, '我在学校有点难受。'); assert.equal(scope.turn, 1);
  });
  check('only a respondent opt-out removes its target from the model protocol', () => {
    const ids = semanticDialogueSchema(result).anyOf[0].properties.target_facet_id.enum;
    assert.equal(ids.length, 42); assert.equal(ids.includes('recent_episode'), false); assert.equal(ids.includes('recent_example'), false); assert.ok(ids.includes('protective_summary'));
  });
  await runSemanticDialogue(runtime(decision({ target_facet_id: 'recent_episode' })), snapshot, result);
  check('a model cannot override a respondent opt-out or turn it into a forced question', () => {
    assert.equal(result.nextQuestion.policyType, 'llm_retry');
  });
  console.log(`semantic dialogue regression: ${checks} checks passed`);
} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
