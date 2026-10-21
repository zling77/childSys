import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.mjs';
import { handleTurn } from '../core/orchestrator.mjs';
import { buildSemanticDialogueMessages, runSemanticDialogue, semanticDialogueSchema, validateSemanticDialogueDecision } from '../core/llm/semanticDialogue.mjs';
import { buildCompletionReviewMessages, completionReviewSchema, reviewCompletion } from '../core/llm/completionReview.mjs';

const root = mkdtempSync(join(tmpdir(), 'completion-review-unit-'));
const store = createStore(join(root, 'test.db'));
const empty = { claims: [], assessments: [], responses: [], safety: [] };
const complete = { next_action: 'complete', target_facet_id: null, action_type: null, question: '', acknowledgement: '', selection_reason: '拟结束并保留未知。' };
const ask = { next_action: 'ask', target_facet_id: 'onset_time', action_type: 'temporalize', question: '大概是从什么时候开始的？', acknowledgement: '', selection_reason: '了解尚未披露的开始时间。' };
const finding = (status = 'missing', extra = {}) => ({ facet_id: 'onset_time', necessity: 'essential', status, explanation: '当前尚未说明开始时间。', refs: [], ...extra });
const continued = () => ({ verdict: 'continue', reason: '仍缺必要且能提供的信息。', findings: [finding()], decision: ask });
const allowed = () => ({ verdict: 'allow_complete', reason: '已有概况，未知可保留。', findings: [finding('supported', {
  facet_id: 'primary_concern', explanation: '有本人困扰原话。', refs: [{ turn: 1, quote: '我在学校有点难受' }],
})], decision: complete });
const fresh = () => {
  const snapshot = store.getSnapshot(store.createSession({ profile: { age: 13, respondent: 'child' }, stateBuilderMode: 'semantic' }).sessionId);
  const result = handleTurn(snapshot, { answerText: '我在学校有点难受。', speakerRole: 'child', semanticAssessment: empty });
  return { snapshot, result };
};
let checks = 0;
const check = (name, test) => { test(); checks++; console.log('PASS ' + name); };
try {
  let { snapshot, result } = fresh(); let reviewCalls = 0;
  const runtime = (proposal, review) => ({ enabled: true, mode: 'dynamic', provider: {
    provider: 'fixture', model: 'fixture', decideDialogue: async () => proposal,
    reviewCompletion: async () => { reviewCalls++; return review; },
  } });
  await runSemanticDialogue(runtime(ask, allowed()), snapshot, result);
  check('ordinary ask performs no completion review', () => { assert.equal(reviewCalls, 0); assert.equal(result.nextAction, 'ask'); });
  ({ snapshot, result } = fresh()); const before = JSON.stringify(result.slotStates);
  await runSemanticDialogue(runtime(complete, continued()), snapshot, result);
  check('an early completion is replaced by the review LLM follow-up before completion is committed', () => {
    assert.equal(reviewCalls, 1); assert.equal(result.nextAction, 'ask'); assert.equal(result.status, 'in_progress');
    assert.equal(result.nextQuestion.targetFacetId, 'onset_time'); assert.equal(result.completionReviewAudit.output.verdict, 'continue');
    assert.equal(JSON.stringify(result.slotStates), before);
  });
  ({ snapshot, result } = fresh()); await runSemanticDialogue(runtime(complete, allowed()), snapshot, result);
  check('approval allows completion with gaps without changing evidence sufficiency', () => {
    assert.equal(result.nextAction, 'complete'); assert.equal(result.progress.requiredFilled, 0);
    assert.equal(result.completionReviewAudit.status, 'success'); assert.equal(result.nextQuestion, null);
  });
  for (const [name, output] of [
    ['missing citations', { ...allowed(), findings: [finding('supported')] }],
    ['fabricated citation', { ...allowed(), findings: [finding('supported', { refs: [{ turn: 1, quote: '从来没有任何困难' }] })] }],
    ['wrong turn', { ...allowed(), findings: [finding('supported', { refs: [{ turn: 99, quote: '我在学校有点难受' }] })] }],
    ['approval despite essential gap', { ...allowed(), findings: [finding()] }],
    ['approval without original evidence', { ...allowed(), findings: [finding('not_needed', { necessity: 'optional' })] }],
    ['follow-up to an already supported finding', { ...continued(), findings: [finding('supported', { refs: [{ turn: 1, quote: '我在学校有点难受' }] })] }],
    ['continuation premised on an essential declined fact', { ...continued(), findings: [finding(),
      finding('declined', { facet_id: 'recent_episode', refs: [{ turn: 1, quote: '我在学校有点难受' }] })] }],
  ]) {
    ({ snapshot, result } = fresh()); await runSemanticDialogue(runtime(complete, output), snapshot, result);
    check(name + ' fails visibly without auto-completion', () => {
      assert.equal(result.nextAction, 'pause'); assert.equal(result.status, 'in_progress');
      assert.equal(result.completionReviewAudit.status, 'error'); assert.equal(result.nextQuestion.policyType, 'llm_retry');
    });
  }
  ({ snapshot, result } = fresh());
  await runSemanticDialogue(runtime(complete, { verdict: 'insufficient_context', reason: '无法判断本次信息是否足够。', findings: [finding()], decision: null }), snapshot, result);
  check('insufficient context waits for continuation instead of defaulting to complete', () => {
    assert.equal(result.nextAction, 'pause'); assert.equal(result.completionReviewAudit.output.verdict, 'insufficient_context');
  });
  ({ snapshot, result } = fresh());
  const f = result.slotStates.find(s => s.slotId === 'onset_course').value.facets.onset_time;
  f.collectionClosed = true; f.responseState = { kind: 'declined' };
  await runSemanticDialogue(runtime(complete, continued()), snapshot, result);
  check('completion reviewer cannot reopen the respondent declined target', () => {
    assert.equal(result.nextAction, 'pause'); assert.match(result.completionReviewAudit.error, /declined/);
  });
  ({ snapshot, result } = fresh());
  const episode = result.slotStates.find(s => s.slotId === 'current_manifestations').value.facets.recent_episode;
  episode.collectionClosed = true; episode.responseState = { kind: 'declined' };
  await runSemanticDialogue(runtime(complete, { ...continued(),
    findings: [finding('missing', { facet_id: 'recent_example' })],
    decision: { ...ask, target_facet_id: 'recent_example', action_type: 'example', question: '最近能举一个例子吗？' },
  }), snapshot, result);
  check('a declined event cannot be reopened under the equivalent example label', () => {
    assert.equal(result.nextAction, 'pause'); assert.match(result.completionReviewAudit.error, /declined/);
  });
  ({ snapshot, result } = fresh()); result.dialogueTurn.questionText = ask.question;
  await runSemanticDialogue(runtime(complete, continued()), snapshot, result);
  check('completion follow-up cannot repeat the previous exact question', () => {
    assert.equal(result.nextAction, 'pause'); assert.match(result.completionReviewAudit.error, /duplicate/);
  });
  ({ snapshot, result } = fresh()); snapshot.caseEvidenceState = { secret: 'OTHER-SOURCE-SECRET' };
  snapshot.turns = [{ turnNo: 1, speakerRole: 'child', answerText: '较早的同来源信息。', questionText: '之前呢？' }];
  result.dialogueTurn.turnNo = 2;
  const built = buildCompletionReviewMessages(snapshot, result, complete, buildSemanticDialogueMessages(snapshot, result).context);
  check('review includes all own-session turns without importing multi-source analysis', () => {
    assert.equal(built.context.documents.length, 2); assert.ok(!JSON.stringify(built).includes('OTHER-SOURCE-SECRET'));
  });
  check('constrained review citations select an original source ID and cannot omit refs', () => {
    const refs = completionReviewSchema(semanticDialogueSchema(result), built.context.recording_labels, built.context.sources).properties.findings.items.properties.refs;
    assert.equal(refs.minItems, 1); assert.deepEqual(refs.items.enum, built.context.sources.map(s => s.id));
    for (const source of built.context.sources) {
      const original = built.context.documents.find(d => d.turn === source.turn).answer;
      assert.equal(original.slice(source.start, source.end), source.quote);
    }
  });
  ({ snapshot, result } = fresh());
  const indexed = buildCompletionReviewMessages(snapshot, result, complete, buildSemanticDialogueMessages(snapshot, result).context);
  const indexedOutput = allowed(); indexedOutput.findings[0].refs = [indexed.context.sources[0].id];
  await runSemanticDialogue(runtime(complete, indexedOutput), snapshot, result);
  check('selected source IDs expand to exact original quotes without a second model call', () => {
    assert.equal(result.nextAction, 'complete');
    const ref = result.completionReviewAudit.output.findings[0].refs[0];
    assert.equal(ref.quote, '我在学校有点难受。'); assert.equal(ref.turn, 1); assert.equal(ref.start, 0);
  });
  ({ snapshot, result } = fresh());
  const unknownSource = allowed(); unknownSource.findings[0].refs = ['OTHER-SESSION'];
  await runSemanticDialogue(runtime(complete, unknownSource), snapshot, result);
  check('unknown source IDs cannot be repaired with fabricated quotations', () => {
    assert.equal(result.nextAction, 'pause'); assert.match(result.completionReviewAudit.error, /unknown_source/);
  });
  ({ snapshot, result } = fresh());
  const timed = await reviewCompletion({ provider: { provider: 'fixture', model: 'fixture', reviewCompletion: () => new Promise(() => {}) },
    snapshot, result, proposal: complete, dialogueContext: buildSemanticDialogueMessages(snapshot, result).context,
    decisionSchema: semanticDialogueSchema(result), validateDecision: o => validateSemanticDialogueDecision(o, snapshot, result), timeoutMs: 100 });
  check('review has an independent hard deadline and does not retry', () => {
    assert.equal(timed.decision, null); assert.match(timed.audit.error, /timeout/); assert.ok(timed.audit.latencyMs < 1000);
  });
  ({ snapshot, result } = fresh());
  const ordinaryContext = buildSemanticDialogueMessages(snapshot, result).context;
  snapshot.turns = [{ turnNo: 1, speakerRole: 'child', answerText: '合成超长原话'.repeat(3000), questionText: null }];
  result.dialogueTurn.turnNo = 2;
  const oversized = await reviewCompletion({ provider: runtime(complete, allowed()).provider, snapshot, result, proposal: complete,
    dialogueContext: ordinaryContext,
    decisionSchema: semanticDialogueSchema(result), validateDecision: o => validateSemanticDialogueDecision(o, snapshot, result) });
  check('over-budget full history is not silently truncated or certified complete', () => {
    assert.equal(oversized.decision, null); assert.match(oversized.audit.error, /context_budget/);
  });
  console.log(`completion review regression: ${checks} checks passed`);
} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
