import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.mjs';
import { handleTurn } from '../core/orchestrator.mjs';
import { compileEvidenceContext, validateSemanticEvidence, evidenceMessages, compactEvidenceMessages } from '../core/semanticEvidence.mjs';
import { intakeContracts } from '../core/intakeContracts.mjs';
import { findGaps, computeProgress } from '../core/state.mjs';
import { normalizeEvidenceUnits } from '../core/evidenceGraph.mjs';
import { generatePrevisitPacket } from '../core/packet.mjs';
import { publicDecisionLogs } from '../core/publicDecisionLogs.mjs';
import { assessTurnEvidence } from '../core/llm/semanticStateBuilder.mjs';
import { realizeGoalFallback, buildDynamicGoal } from '../core/llm/dynamicGoalSpace.mjs';
import { validateQuestionForTarget, validateDynamicSelection } from '../core/llm/dynamicBoundary.mjs';
import { compactEvidenceSchema } from '../core/llm/evidenceSchema.mjs';

let checks = 0;
const check = (name, test) => { test(); checks++; console.log(`PASS ${name}`); };
const root = mkdtempSync(join(tmpdir(), 'previsit-semantic-'));
const dbPath = join(root, 'state.db');
let store = createStore(dbPath);
const question = (slot, facet, text) => ({ targetSlotOrIssue: slot, targetFacetId: facet, text });
const frequencyQ = question('frequency_severity', 'frequency', '近两周哭过几次？');
const claim = (facet_id, quote, extra = {}) => ({ id: 'c1', slot_id: 'frequency_severity', facet_id,
  quote, value: quote, polarity: 'present', subject: 'patient', source_mode: 'direct', certainty: 'stated', ...extra });
const assessment = (slot_id, facet_id, requirements) => ({ slot_id, facet_id, requirements: Object.entries(requirements)
  .map(([id, ids]) => ({ id, status: ids ? 'met' : 'unmet', claim_ids: ids ?? [] })) });
const empty = () => ({ claims: [], assessments: [], responses: [], safety: [] });
const fresh = () => store.getSnapshot(store.createSession({ profile: { age: 10, respondent: 'guardian' }, stateBuilderMode: 'semantic' }).sessionId);
const facet = (s, slot, id) => s.slotStates.find(x => x.slotId === slot).value.facets[id];
function apply(snapshot, answerText, output, currentQuestion = frequencyQ) {
  const input = { answerText, currentQuestion, speakerRole: 'guardian' };
  const validated = validateSemanticEvidence(output, snapshot, input);
  const result = handleTurn(snapshot, { ...input, semanticAssessment: validated });
  return { result, snapshot: store.applyTurnResult(result), validated };
}

try {
  check('all 44 facets share one versioned evidence contract without expanding the rule checklist', () => {
    assert.equal(intakeContracts.reduce((n, c) => n + c.facets.length, 0), 44);
    assert.equal(intakeContracts.reduce((n, c) => n + c.requiredFacets.length, 0), 18);
    for (const c of intakeContracts) for (const f of c.facets) {
      assert.ok(f.evidenceContract.requirements.length); assert.ok(f.evidenceContract.minimumEvidence);
    }
  });
  let s = fresh();
  let r = apply(s, '三次。', { ...empty(), claims: [claim('frequency', '三次')],
    assessments: [assessment('frequency_severity', 'frequency', { frequency_value: ['c1'], reference_window: null })] },
    question('frequency_severity', 'frequency', '发生过多少次？'));
  check('model-assessed missing window leaves the count as partial evidence', () => {
    assert.equal(facet(r.snapshot, 'frequency_severity', 'frequency').status, 'partial');
    assert.deepEqual(facet(r.snapshot, 'frequency_severity', 'frequency').missingRequirements, ['reference_window']);
  });
  const priorId = r.validated.claims[0].evidenceId;
  s = r.snapshot;
  r = apply(s, '最近两周。', { ...empty(), claims: [claim('frequency', '最近两周')],
    assessments: [assessment('frequency_severity', 'frequency', { frequency_value: [priorId], reference_window: ['c1'] })] },
    question('frequency_severity', 'frequency', '这几次是多长时间里发生的？'));
  check('later time window completes existing count with cross-turn evidence references', () => {
    assert.equal(facet(r.snapshot, 'frequency_severity', 'frequency').status, 'filled');
    assert.ok(!findGaps(r.snapshot.slotStates).some(g => g.facetId === 'frequency'));
  });
  check('both prompt protocols ask the model to assess frequency, event and onset requirements', () => {
    const compiled = compileEvidenceContext(fresh(), { answerText: '三次。', speakerRole: 'guardian' });
    for (const build of [evidenceMessages, compactEvidenceMessages]) {
      const prompt = build(compiled)[0].content;
      assert.match(prompt, /出现频率frequency/); assert.match(prompt, /具体事例recent_example\/recent_episode/);
      assert.match(prompt, /开始时间onset_time/); assert.match(prompt, /只有“三次”/);
    }
    const wireContext = JSON.parse(compactEvidenceMessages(compiled)[1].content);
    assert.equal(Object.keys(wireContext.goals).length, 44);
    assert.deepEqual(Object.keys(wireContext.goals.frequency.requirements), ['frequency_value', 'reference_window']);
    assert.deepEqual(wireContext.current, compiled.context.current);
  });
  check('constrained reference schema allows only self or existing evidence IDs without changing the shared schema', () => {
    const field = compactEvidenceSchema([{ evidenceId: 'SC-existing' }]).properties.updates.items.properties.requirements.items.properties.refs.items;
    assert.deepEqual(field.enum, ['$self', '$p1', 'SC-existing']);
    assert.deepEqual(compactEvidenceSchema().properties.updates.items.properties.requirements.items.properties.refs.items.enum, ['$self']);
  });
  check('event-defined frequency window follows the model assessment without a date regex', () => {
    const quote = '从运动会到期中考这段时间哭过三次';
    const result = apply(fresh(), quote, { ...empty(), claims: [claim('frequency', quote)],
      assessments: [assessment('frequency_severity', 'frequency', { frequency_value: ['c1'], reference_window: ['c1'] })] });
    assert.equal(facet(result.snapshot, 'frequency_severity', 'frequency').status, 'filled');
    assert.ok(!result.result.decisionLog.candidateQuestions.some(q => q.targetFacetId === 'frequency'));
    const partial = apply(fresh(), quote, { ...empty(), claims: [claim('frequency', quote)],
      assessments: [assessment('frequency_severity', 'frequency', { frequency_value: ['c1'], reference_window: null })] });
    assert.equal(facet(partial.snapshot, 'frequency_severity', 'frequency').status, 'partial');
  });
  check('event-based onset and a brief concrete episode can be sufficient when assessed by the model', () => {
    const result = apply(fresh(), '搬家以后才开始。昨晚在家里，我把作业本扔到地上。', { ...empty(), claims: [
      claim('onset_time', '搬家以后才开始', { slot_id: 'onset_course' }),
      claim('recent_episode', '昨晚在家里，我把作业本扔到地上', { id: 'c2', slot_id: 'current_manifestations' }),
    ], assessments: [assessment('onset_course', 'onset_time', { onset_anchor: ['c1'] }),
      assessment('current_manifestations', 'recent_episode', { event_context: ['c2'], event_detail: ['c2'] })] });
    assert.equal(facet(result.snapshot, 'onset_course', 'onset_time').status, 'filled');
    assert.equal(facet(result.snapshot, 'current_manifestations', 'recent_episode').status, 'filled');
  });
  check('semantic claims, assessments and state events are written through the normal turn transaction', () => {
    assert.equal(store.db.prepare('SELECT count(*) n FROM evidence_claim WHERE session_id=?').get(s.session.sessionId).n, 2);
    assert.equal(store.db.prepare('SELECT count(*) n FROM evidence_requirement_assessment WHERE session_id=?').get(s.session.sessionId).n, 2);
    assert.equal(store.db.prepare('SELECT count(*) n FROM interview_state_event WHERE session_id=?').get(s.session.sessionId).n, 2);
    store.applyTurnResult(r.result);
    assert.equal(store.db.prepare('SELECT count(*) n FROM evidence_claim WHERE session_id=?').get(s.session.sessionId).n, 2);
  });
  const stableId = s.session.sessionId;
  store.close(); store = createStore(dbPath); s = store.getSnapshot(stableId);
  check('semantic mode, partial criteria and completed evidence survive reopening', () => {
    assert.equal(s.session.stateBuilderMode, 'semantic');
    assert.equal(facet(s, 'frequency_severity', 'frequency').status, 'filled');
  });
  check('v2 facet state is authoritative over the compatibility projection', () => {
    const state = s.slotStates.find(x => x.slotId === 'frequency_severity');
    const projection = structuredClone(state.value);
    projection.facets.frequency.status = 'missing'; projection.facets.frequency.sufficiency = 'none';
    store.db.prepare('UPDATE slot_state SET value_json=? WHERE session_id=? AND slot_id=?')
      .run(JSON.stringify(projection), stableId, 'frequency_severity');
    assert.equal(facet(store.getSnapshot(stableId), 'frequency_severity', 'frequency').status, 'filled');
    assert.match(facet(s, 'frequency_severity', 'frequency').value, /三次.*两周/);
  });
  r = apply(s, '我不知道。', { ...empty(), responses: [{ slot_id: 'frequency_severity', facet_id: 'frequency', kind: 'unavailable', quote: '不知道' }] });
  check('unknown does not erase supported information and is not a denial', () => {
    assert.equal(facet(r.snapshot, 'frequency_severity', 'frequency').sufficiency, 'sufficient');
    assert.equal(facet(r.snapshot, 'frequency_severity', 'frequency').polarity, 'present');
  });
  s = fresh();
  const impact = claim('impact_presence', '有影响', { slot_id: 'functional_impact', value: true });
  r = apply(s, '有影响。', { ...empty(), claims: [impact], assessments: [assessment('functional_impact', 'impact_presence', { presence: ['c1'] })] },
    question('functional_impact', 'impact_presence', '有没有影响日常生活？'));
  check('positive impact preserves boolean true and opens only the conditional example', () => {
    assert.equal(facet(r.snapshot, 'functional_impact', 'impact_presence').value, true);
    assert.equal(facet(r.snapshot, 'functional_impact', 'impact_presence').status, 'filled');
    assert.equal(r.snapshot.slotStates.find(s => s.slotId === 'functional_impact').status, 'partial');
    assert.ok(findGaps(r.snapshot.slotStates).some(g => g.facetId === 'impact_example'));
  });
  r = apply(r.snapshot, '我说不准。', { ...empty(), claims: [claim('impact_presence', '说不准', {
    slot_id: 'functional_impact', polarity: 'uncertain', value: null })] });
  check('new uncertainty without an assessment does not erase a supported boolean', () => {
    const f = facet(r.snapshot, 'functional_impact', 'impact_presence');
    assert.equal(f.value, true); assert.equal(f.sufficiency, 'sufficient');
  });
  r = apply(r.snapshot, '已经因此缺课两天。', { ...empty(), claims: [claim('impact_example', '缺课两天', { slot_id: 'functional_impact' })],
    assessments: [assessment('functional_impact', 'impact_example', { impact_detail: ['c1'] })] });
  check('conditional impact example can complete the domain without re-asking impact presence', () => {
    assert.equal(r.snapshot.slotStates.find(x => x.slotId === 'functional_impact').status, 'filled');
  });
  r = apply(r.snapshot, '完全没有影响。', { ...empty(), claims: [claim('impact_presence', '没有影响', {
    slot_id: 'functional_impact', polarity: 'absent', value: false })] });
  check('an unassessed contradictory claim cannot leave the target certified as sufficient', () => {
    assert.equal(facet(r.snapshot, 'functional_impact', 'impact_presence').sufficiency, 'indeterminate');
  });
  s = fresh();
  r = apply(s, '这个我不想说。', { ...empty(), responses: [{ slot_id: 'current_manifestations', facet_id: 'recent_episode', kind: 'declined', quote: '我不想说' }] },
    question('current_manifestations', 'recent_episode', '最近一次发生了什么？'));
  check('refusal is persisted, removed from candidates and never counted as evidence coverage', () => {
    assert.equal(facet(r.snapshot, 'current_manifestations', 'recent_episode').status, 'declined');
    assert.ok(!r.result.decisionLog.candidateQuestions.some(c => c.targetFacetId === 'recent_episode'));
    assert.equal(computeProgress(r.snapshot.slotStates).requiredFilled, 0);
    assert.ok(generatePrevisitPacket(r.snapshot).content.missing_information.some(x => x.status === 'declined'));
  });
  r = apply(r.snapshot, '那次是在家里。', { ...empty(), claims: [claim('recent_episode', '在家里', { slot_id: 'current_manifestations' })],
    assessments: [assessment('current_manifestations', 'recent_episode', { event_context: ['c1'], event_detail: null })] });
  check('partial voluntary disclosure after refusal preserves the stop boundary', () => {
    assert.equal(facet(r.snapshot, 'current_manifestations', 'recent_episode').status, 'declined');
    assert.ok(!findGaps(r.snapshot.slotStates).some(g => g.facetId === 'recent_episode'));
  });
  s = fresh();
  r = apply(s, '孩子每周三次，每次十分钟。', { ...empty(), claims: [claim('frequency', '每周三次'),
    claim('episode_duration', '每次十分钟', { id: 'c2' })], assessments: [
    assessment('frequency_severity', 'frequency', { frequency_value: ['c1'], reference_window: ['c1'] }),
    assessment('frequency_severity', 'episode_duration', { content: ['c2'] })] },
    question('presenting_problem', 'primary_concern', '您最担心什么？'));
  check('incidental exact facts update multiple facets without the old 0.74 threshold', () => {
    assert.equal(facet(r.snapshot, 'frequency_severity', 'frequency').status, 'filled');
    assert.equal(facet(r.snapshot, 'frequency_severity', 'episode_duration').status, 'filled');
  });
  s = r.snapshot;
  const countId = r.validated.claims[0].evidenceId;
  r = apply(s, '刚才记错了，是每周两次。', { ...empty(), claims: [claim('frequency', '每周两次', { corrects: countId })],
    assessments: [assessment('frequency_severity', 'frequency', { frequency_value: ['c1'], reference_window: ['c1'] })] });
  check('explicit correction keeps original quotes and records a directional event', () => {
    assert.equal(facet(r.snapshot, 'frequency_severity', 'frequency').value, '每周两次');
    assert.equal(store.db.prepare("SELECT count(*) n FROM evidence_claim_event WHERE session_id=? AND event_type='superseded'").get(s.session.sessionId).n, 1);
    assert.ok(r.snapshot.evidenceUnits.some(e => e.evidenceId === countId));
  });
  check('clinician graph consumes semantic provenance without re-extracting it', () => {
    const units = normalizeEvidenceUnits(r.snapshot, 'CASE-test');
    assert.equal(units.find(e => e.evidenceId === r.validated.claims[0].evidenceId).extractor, 'llm-semantic');
    assert.equal(units.find(e => e.evidenceId === r.validated.claims[0].evidenceId).correctsEvidenceId, countId);
  });
  r = apply(r.snapshot, '刚才又记错了，是每周一次。', { ...empty(), claims: [claim('frequency', '每周一次', { corrects: r.validated.claims[0].evidenceId })] });
  check('a correction without a new assessment invalidates superseded completion', () => {
    assert.notEqual(facet(r.snapshot, 'frequency_severity', 'frequency').sufficiency, 'sufficient');
  });
  s = fresh();
  r = apply(s, '老师说我同桌每天都这样。', { ...empty(), claims: [claim('frequency', '每天', { subject: 'other', source_mode: 'reported', reported_source: 'teacher_school' })],
    assessments: [assessment('frequency_severity', 'frequency', { frequency_value: ['c1'], reference_window: ['c1'] })] });
  check('other-subject facts cannot fill patient evidence', () => assert.notEqual(facet(r.snapshot, 'frequency_severity', 'frequency').status, 'filled'));
  r = apply(fresh(), '每周三次。', { ...empty(), claims: [claim('frequency', '每天十次')],
    assessments: [assessment('frequency_severity', 'frequency', { frequency_value: ['c1'], reference_window: ['c1'] })] });
  check('fabricated quotation and its dependent completion are rejected', () => {
    assert.equal(r.validated.claims.length, 0); assert.ok(r.validated.rejected.length);
    assert.notEqual(facet(r.snapshot, 'frequency_severity', 'frequency').status, 'filled');
  });
  r = apply(fresh(), '我觉得他可能有影响。', { ...empty(), claims: [claim('impact_presence', '可能有影响', { slot_id: 'functional_impact', value: true, source_mode: 'inference' })],
    assessments: [assessment('functional_impact', 'impact_presence', { presence: ['c1'] })] });
  check('parental inference is preserved but cannot satisfy objective impact evidence', () => assert.notEqual(facet(r.snapshot, 'functional_impact', 'impact_presence').status, 'filled'));
  r = apply(fresh(), '变化我还说不清。', { ...empty(), claims: [claim('course_pattern', '说不清', { slot_id: 'onset_course', value: 'unclear' })],
    assessments: [assessment('onset_course', 'course_pattern', { content: ['c1'] })] });
  check('unclear enum values cannot be promoted to evidence sufficiency', () => {
    assert.notEqual(facet(r.snapshot, 'onset_course', 'course_pattern').sufficiency, 'sufficient');
  });
  check('missing-window fallback and its boundary ask only for the missing requirement', () => {
    const t = buildDynamicGoal({ targetSlotOrIssue: 'frequency_severity', targetFacetId: 'frequency', missingRequirements: ['reference_window'] });
    const text = realizeGoalFallback(t);
    assert.ok(/多长/.test(text)); assert.ok(validateQuestionForTarget({ question: text, target: t }).ok);
    t.complaintId = 'initial_intake_coverage';
    const selected = validateDynamicSelection({ output: { next_action: 'ask', question: text,
      complaint_id: t.complaintId, target_slot_or_issue: t.targetSlotOrIssue, target_facet_id: t.targetFacetId },
      candidates: [t], ruleNextQuestion: t });
    assert.ok(selected.ok); assert.ok(validateQuestionForTarget({ question: text, target: selected.target }).ok);
  });
  check('semantic audit is private even without a cross-source focus audit', () => {
    const logs = publicDecisionLogs([{ boundaryCheckResult: { stateBuilderMode: 'semantic' },
      modelAudits: [{ task: 'semantic_evidence_assessment', output: { private: 'secret' }, inputHash: 'secret' }] }]);
    assert.ok(!JSON.stringify(logs).includes('secret'));
  });
  check('state compiler cannot import unrelated case materials', () => {
    const compiled = compileEvidenceContext(fresh(), { answerText: '每周三次', speakerRole: 'guardian', caseEvidenceState: { secret: 'other-source' } });
    assert.ok(!JSON.stringify(compiled).includes('other-source'));
  });
  const timed = await assessTurnEvidence(fresh(), { answerText: '三次', speakerRole: 'guardian' },
    { provider: 'fixture', model: 'fixture', assessEvidence: () => new Promise(() => {}) }, { mode: 'semantic', timeoutMs: 100 });
  check('deadline returns a visible error without inventing evidence or waiting for retries', () => {
    assert.equal(timed.validated, null); assert.match(timed.audit.error, /timeout/); assert.ok(timed.audit.latencyMs < 1500);
  });
  console.log(`semantic state regression: ${checks} checks passed`);
} finally { store?.close(); rmSync(root, { recursive: true, force: true }); }
