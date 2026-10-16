import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { referencedTimeSpan, temporalRelation, classifyEvidenceRelation, buildEvidenceState, normalizeEvidenceUnits } from '../core/evidenceGraph.mjs';
import { updateSlotStates } from '../core/state.mjs';
import { generatePrevisitPacket } from '../core/packet.mjs';
import { COVERAGE_DOMAIN } from '../core/coverage.mjs';
import { handleTurn } from '../core/orchestrator.mjs';
import { createStore } from '../server/store.mjs';
import { seedResearchDemoCases } from '../server/research-demo-cases.mjs';

let count = 0;
const check = (name, fn) => { fn(); count += 1; console.log(`ok - ${name}`); };
const anchor = '2026-10-07';
const claim = (id, text, polarity, options = {}) => ({ evidenceId: id, caseId: 'CASE-TEST', slotId: 'functional_impact', facetId: 'impact_presence', concept: 'school_function', sourceRole: 'caregiver', sourceIdentity: 'REPORTER-1', sourceLabel: '监护人', inputRound: 1, recordedAt: 1, claim: text, traceText: text, originalText: text, traceRef: { start: 0, end: text.length }, polarity, observationContext: 'school', referenced_time_span: referencedTimeSpan(text, anchor), ...options });

check('relative windows are anchored to Asia/Shanghai calendar dates', () => {
  assert.deepEqual([referencedTimeSpan('上个月影响上学', anchor).start, referencedTimeSpan('上个月影响上学', anchor).end], ['2026-09-01', '2026-09-30']);
  assert.equal(temporalRelation(referencedTimeSpan('上个月', anchor), referencedTimeSpan('本周', anchor)), 'before');
});
check('unknown material time is not fabricated from its upload time', () => {
  const scope = referencedTimeSpan('近两周', null);
  assert.equal(scope.start, null); assert.equal(scope.anchor, null);
});
check('impossible calendar dates remain unknown instead of rolling into another month', () => {
  const scope = referencedTimeSpan('2026-02-31影响上学', anchor);
  assert.equal(scope.start, null); assert.equal(scope.certainty, 'unknown');
});
check('different time windows do not create semantic conflict or improvement', () => {
  const relation = classifyEvidenceRelation(claim('A', '上个月影响上学', 'affirmed'), claim('B', '本周没有影响上学', 'negated', { inputRound: 2 }));
  assert.equal(relation.semanticRelation, 'unknown'); assert.equal(relation.temporalRelation, 'before'); assert.equal(relation.reasonCode, 'different_time');
});
check('overlapping opposite claims preserve both sides as a discrepancy', () => {
  const state = buildEvidenceState('CASE-TEST', [claim('A', '近两周影响上学', 'affirmed'), claim('B', '近两周没有影响上学', 'negated', { sourceIdentity: 'REPORTER-2', inputRound: 2, recordedAt: 2 })]);
  assert.equal(state.evidenceRelations[0].semanticRelation, 'contradicts');
  assert.equal(state.topicStates.find((t) => t.topicId === 'functional_impact').status, 'disputed');
  assert.deepEqual(state.topicStates.find((t) => t.topicId === 'functional_impact').effectiveEvidenceIds, ['A', 'B']);
});
check('unknown event time stays unresolved despite opposite polarity', () => {
  const relation = classifyEvidenceRelation(claim('A', '影响上学', 'affirmed'), claim('B', '没有影响上学', 'negated', { inputRound: 2 }));
  assert.equal(relation.semanticRelation, 'unknown'); assert.equal(relation.reasonCode, 'possible_discrepancy');
});
check('family and school contexts are not automatically contradictory', () => {
  const relation = classifyEvidenceRelation(claim('A', '近两周学校受到影响', 'affirmed'), claim('B', '近两周家庭没有受到影响', 'negated', { observationContext: 'home' }));
  assert.equal(relation.semanticRelation, 'not_comparable');
});
check('not observing a symptom does not automatically negate a self-report', () => {
  const relation = classifyEvidenceRelation(claim('A', '近两周影响上学', 'affirmed'), claim('B', '近两周家长没有发现影响上学', 'negated', { sourceIdentity: 'REPORTER-2' }));
  assert.equal(relation.semanticRelation, 'unknown'); assert.equal(relation.reasonCode, 'observation_vs_experience');
});
check('explicit correction retains its directional chain and original evidence', () => {
  const state = buildEvidenceState('CASE-TEST', [claim('A', '近两周没有影响上学', 'negated'), claim('B', '刚才说错了，近两周影响上学', 'affirmed', { explicitCorrection: true, inputRound: 2, recordedAt: 2 })]);
  assert.equal(state.revisionChains.length, 1); assert.equal(state.revisionChains[0].priorEvidenceId, 'A');
  assert.equal(state.evidenceUnits.find((u) => u.evidenceId === 'A').superseded, true); assert.equal(state.evidenceUnits.length, 2);
});
check('a later statement from another reporter is not an automatic correction', () => {
  const relation = classifyEvidenceRelation(claim('A', '近两周没有影响上学', 'negated'), claim('B', '刚才说错了，近两周影响上学', 'affirmed', { sourceIdentity: 'REPORTER-2', explicitCorrection: true, inputRound: 2 }));
  assert.equal(relation.semanticRelation, 'contradicts');
});
check('additional clauses in the same answer do not spuriously revise each other', () => {
  const relation = classifyEvidenceRelation(claim('A', '近两周影响上学', 'affirmed'), claim('B', '近两周缺课四天', 'affirmed', { explicitCorrection: true }));
  assert.notEqual(relation.semanticRelation, 'corrects');
});
check('compatible added detail gets a separate supplement relation', () => {
  const relation = classifyEvidenceRelation(claim('A', '近两周影响上学', 'affirmed'), claim('B', '近两周影响上学且缺课四天', 'affirmed', { inputRound: 2 }));
  assert.equal(relation.semanticRelation, 'supplements');
});

function rawEvidence(id, text, polarity, turnNo) { return { evidenceId: id, sessionId: 'SESSION-TEST', turnNo, source: 'parent_report', speakerRole: 'guardian', domain: COVERAGE_DOMAIN, slotId: 'functional_impact', facetIds: ['impact_presence'], timeScope: null, polarity, value: { text, facetIds: ['impact_presence'], facetPolarities: { impact_presence: polarity } }, rawText: text, confidence: .9, createdAt: Date.parse('2026-10-07T08:00:00+08:00') + turnNo }; }
const snapshot = () => ({ session: { sessionId: 'SESSION-TEST', profile: {}, mappedComplaints: [], selectedComplaints: [] }, evidenceUnits: [], slotStates: [], riskSignals: [], turns: [], packets: [] });
check('legacy coverage updater separates disjoint historical and current windows', () => {
  const s = snapshot(); const a = rawEvidence('A', '上个月影响上学', 'present', 1); const b = rawEvidence('B', '本周没有影响上学', 'absent', 2);
  s.slotStates = updateSlotStates(s, [], [a]); s.evidenceUnits.push(a); s.slotStates = updateSlotStates(s, [], [b]);
  assert.notEqual(s.slotStates.find((t) => t.slotId === 'functional_impact').status, 'conflict');
});
check('legacy coverage updater preserves explicitly corrected history', () => {
  const s = snapshot(); const a = rawEvidence('A', '近两周没有影响上学', 'absent', 1); const b = rawEvidence('B', '刚才说错了，近两周影响上学', 'present', 2);
  s.slotStates = updateSlotStates(s, [], [a]); s.evidenceUnits.push(a); s.slotStates = updateSlotStates(s, [], [b]);
  const topic = s.slotStates.find((t) => t.slotId === 'functional_impact'); assert.equal(topic.status, 'filled'); assert.equal(topic.evidenceIds.length, 2);
});
check('a conflicted topic remains in the legacy main summary', () => {
  const s = snapshot(); const a = rawEvidence('A', '近两周影响上学', 'present', 1); const b = rawEvidence('B', '近两周没有影响上学', 'absent', 2); b.source = 'child_self_report';
  s.slotStates = updateSlotStates(s, [], [a]); s.evidenceUnits.push(a); s.slotStates = updateSlotStates(s, [], [b]); s.evidenceUnits.push(b);
  const content = generatePrevisitPacket(s).content; assert.equal(content.functional_impact[0].status, 'conflict'); assert.match(content.functional_impact[0].value, /没有影响上学/); assert.equal(content.functional_impact[0].evidence_ids.length, 2);
});
check('quote offsets are exact and stable across reads', () => {
  const s = { evidenceUnits: [rawEvidence('A', '近两周影响上学，缺课四天。', 'present', 1)] };
  const units = normalizeEvidenceUnits(s, 'CASE-TEST'); assert.ok(units.length > 0);
  for (const u of units) assert.equal(u.originalText.slice(u.traceRef.start, u.traceRef.end), u.traceText);
  assert.deepEqual(units, normalizeEvidenceUnits(s, 'CASE-TEST'));
});

const root = mkdtempSync(join(tmpdir(), 'childpsych-clinician-regression-'));
const dbPath = join(root, 'test.db');
let store = createStore(dbPath);
try {
  const seeded = seedResearchDemoCases(store);
  check('all five research development scenarios are synthetic and cover the operational ages', () => {
    assert.equal(seeded.length, 5);
    for (const fixture of seeded) { const age = store.getClinicalCase(fixture.caseId).profile.age; assert.ok(age >= 6 && age <= 17); assert.equal(fixture.dataset, 'fully_synthetic_development'); }
  });
  const conflictId = seeded[0].caseId;
  const revisionId = seeded[1].caseId;
  const temporalId = seeded[2].caseId;
  const delayedId = seeded[4].caseId;
  check('independent child and caregiver sessions are associated in one case', () => {
    const b = store.getClinicalBundle(conflictId); assert.equal(b.sessions.length, 2); assert.ok(b.evidenceState.evidenceUnits.some((e) => e.sourceRole === 'child')); assert.ok(b.evidenceState.evidenceUnits.some((e) => e.sourceRole === 'caregiver'));
  });
  check('relations and traceable claims are persisted independently', () => {
    assert.ok(store.db.prepare('SELECT COUNT(*) AS n FROM case_relation WHERE case_id=?').get(conflictId).n > 0);
    assert.ok(store.db.prepare('SELECT COUNT(*) AS n FROM case_evidence WHERE case_id=?').get(conflictId).n > 0);
  });
  check('repeat report generation is idempotent', () => {
    const old = store.getClinicalPacket(conflictId); const result = store.generateClinicalPacket(conflictId); assert.equal(result.changed, false); assert.equal(result.packet.version, old.version);
  });
  check('history comparison exposes newly added claims and correction flags', () => {
    const diff = store.compareClinicalPackets(revisionId, 1, 2).changes; assert.ok(diff.added.length > 0); assert.ok(diff.revised.length > 0); assert.ok(diff.relationsAdded.some((r) => r.semanticRelation === 'corrects'));
    assert.equal(store.getClinicalPacket(revisionId, 1).content.evidence_state.revisionChains.length, 0);
  });
  check('temporal development fixture has no false disputed topic', () => { assert.equal(store.getClinicalBundle(temporalId).evidenceState.topicStates.filter((t) => t.status === 'disputed').length, 0); });
  check('risk disclosure preserves denial history and limiting original text', () => {
    const b = store.getClinicalBundle(delayedId); assert.ok(b.currentContent.risk_notes.length > 0); assert.ok(b.evidenceState.evidenceUnits.some((e) => e.polarity === 'negated'));
    assert.ok(b.evidenceState.evidenceUnits.filter((e) => e.riskFlag).some((e) => e.originalText.includes('没有采取行动')));
  });
  const riskId = store.getClinicalBundle(delayedId).currentContent.risk_notes[0].evidence_id;
  check('reviewing risk records a separate human action and never silently closes evidence', () => {
    store.recordClinicalReview(delayedId, { targetKind: 'risk', targetId: riskId, status: 'reviewed', note: '模拟核实记录，仅验证持久化。', author: '测试医生' });
    const b = store.getClinicalBundle(delayedId); assert.equal(b.reviews.at(-1).status, 'reviewed'); assert.ok(b.currentContent.risk_notes.length > 0); assert.ok(b.currentContent.needs_priority_review);
    const changed = store.generateClinicalPacket(delayedId); assert.equal(changed.changed, true); assert.ok(store.compareClinicalPackets(delayedId, 2, changed.packet.version).changes.reviewsAdded.length);
  });
  check('review results require a note, and cross-case target IDs are rejected', () => {
    assert.throws(() => store.recordClinicalReview(conflictId, { targetKind: 'risk', targetId: riskId, status: 'seen' }), /不属于/);
    assert.throws(() => store.recordClinicalReview(delayedId, { targetKind: 'risk', targetId: riskId, status: 'reviewed' }), /依据或备注/);
  });
  check('caregiver relay remains a caregiver source instead of a direct teacher report', () => {
    store.addClinicalMaterial(conflictId, { sourceRole: 'caregiver', sourceMode: 'reported', reportedSourceRole: 'teacher_school', text: '老师说近两周影响上学。', observedTime: anchor, slotId: 'functional_impact', facetId: 'impact_presence' });
    const unit = store.getClinicalBundle(conflictId).evidenceState.evidenceUnits.find((e) => e.materialId && e.sourceRole === 'caregiver'); assert.equal(unit.sourceMode, 'reported'); assert.equal(unit.reportedSourceRole, 'teacher_school');
  });
  check('unavailable document time remains unknown in stored field claims', () => {
    const material = store.addClinicalMaterial(conflictId, { sourceRole: 'clinical_record', text: '近两周影响上学。', slotId: 'functional_impact', facetId: 'impact_presence' });
    const unit = store.getClinicalBundle(conflictId).evidenceState.evidenceUnits.find((e) => e.materialId === material.materialId); assert.equal(unit.observedTime, null); assert.equal(unit.referenced_time_span.start, null);
  });
  check('doctor corrections require a case-local, comparable explicit target', () => {
    const target = store.getClinicalBundle(conflictId).evidenceState.evidenceUnits.find((e) => e.slotId === 'functional_impact' && e.facetId === 'impact_presence' && e.polarity === 'negated');
    store.addClinicalMaterial(conflictId, { sourceRole: 'clinician', text: '近两周影响上学。', observedTime: anchor, slotId: target.slotId, facetId: target.facetId, correctsEvidenceId: target.evidenceId, referencedTimeSpan: target.referenced_time_span.start ? { start: target.referenced_time_span.start, end: target.referenced_time_span.end } : null });
    assert.ok(store.getClinicalBundle(conflictId).evidenceState.revisionChains.some((r) => r.priorEvidenceId === target.evidenceId));
    assert.throws(() => store.addClinicalMaterial(conflictId, { sourceRole: 'caregiver', text: '近两周影响上学', slotId: target.slotId, facetId: target.facetId, correctsEvidenceId: target.evidenceId }), /仅供医生/);
  });
  check('invalid sources and reversed date intervals are rejected', () => {
    assert.throws(() => store.addClinicalMaterial(conflictId, { sourceRole: 'fake', text: '影响上学' }), /有效来源/);
    assert.throws(() => store.addClinicalMaterial(conflictId, { sourceRole: 'teacher_school', text: '影响上学', referencedTimeSpan: { start: '2026-10-07', end: '2026-10-01' } }), /起止日期/);
  });
  check('an associated session can be separated without losing old report citations', () => {
    const b = store.getClinicalBundle(conflictId); const oldPacket = store.generateClinicalPacket(conflictId).packet;
    const sessionId = b.sessions[1].sessionId; const result = store.detachClinicalSession(conflictId, sessionId);
    assert.notEqual(result.caseId, conflictId); assert.equal(store.clinicalCaseForSession(sessionId), result.caseId);
    assert.ok(store.getClinicalPacket(conflictId, oldPacket.version).content.evidence_state.evidenceUnits.some((e) => e.sessionId === sessionId));
    assert.ok(!store.getClinicalBundle(conflictId).evidenceState.evidenceUnits.some((e) => e.sessionId === sessionId));
  });
  check('case revisions, packet history, reviews and quotes survive database reopening', () => {
    const before = store.getClinicalBundle(delayedId); store.close(); store = createStore(dbPath); const after = store.getClinicalBundle(delayedId);
    assert.equal(after.clinicalCase.evidenceRevision, before.clinicalCase.evidenceRevision); assert.deepEqual(after.evidenceState, before.evidenceState); assert.deepEqual(after.reviews, before.reviews); assert.deepEqual(after.packetHistory, before.packetHistory);
  });
  check('demo reset clears both raw sessions and new case-level state', () => {
    store.resetDemoData(); assert.equal(store.listClinicalCases().length, 0); assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM case_relation').get().n, 0); assert.equal(store.listQueue().length, 0);
  });
} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
console.log(`clinician regression ok: ${count} checks`);
