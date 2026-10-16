import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.mjs';
import { seedClinicianWorkspaceFixture } from '../server/clinician-workspace-fixture.mjs';
import { normalizeMediaTimeline, questionRecording, recordingForEvidence } from '../core/mediaTimeline.mjs';
import { combineCurrentEvidence, groupClinicianEvidence, clinicianRiskLabels } from '../core/clinicianPresentation.mjs';
import { validateDoctorExpression } from '../core/llm/clinician.mjs';

let count = 0;
const check = (name, test) => { test(); count++; console.log(`ok - ${name}`); };
const root = mkdtempSync(join(tmpdir(), 'clinician-workspace-'));
let store = createStore(join(root, 'workspace.db'));
try {
  const keep = store.createClinicalCase({ title: 'Keep this fictional material' });
  store.addClinicalMaterial(keep.caseId, { sourceRole: 'caregiver', text: '近两周影响上学。' });
  const fixture = seedClinicianWorkspaceFixture(store), bundle = store.getClinicalBundle(fixture.caseId);
  check('workspace fixture is additive, idempotent, explicitly fictional and has eight questions', () => {
    assert.equal(seedClinicianWorkspaceFixture(store).caseId, fixture.caseId); assert.equal(store.listClinicalCases().length, 2);
    assert.equal(bundle.clinicalCase.profile.dataset, 'fully_synthetic_development'); assert.equal(bundle.sessions.flatMap(session => session.turns).length, 8);
    assert.ok(bundle.sessions.every(session => session.mediaRecords.length === 0)); assert.ok(store.getClinicalCase(keep.caseId));
  });
  const example = { evidenceId: 'EU-test', sourceIdentity: 'child-one', sessionId: 'S-one', inputRound: 1, slotId: 'safety_clues', claim: '近两周有时想消失，但没有采取行动，也没有准备东西。', originalText: '近两周有时想消失，但没有采取行动，也没有准备东西。', traceText: '近两周有时想消失，但没有采取行动，也没有准备东西。', polarity: 'affirmed', riskFlag: true, referenced_time_span: { raw_text: '近两周' } };
  check('display deduplication preserves a source distinction and excludes superseded units', () => {
    assert.equal(combineCurrentEvidence([example], [{ ...example, evidenceId: 'LE-test' }]).length, 1);
    assert.equal(combineCurrentEvidence([example, { ...example, evidenceId: 'EU-two', sourceIdentity: 'parent' }, { ...example, evidenceId: 'EU-old', superseded: true }]).length, 2);
  });
  check('all current evidence belongs to exactly one reading category', () => {
    const groups = groupClinicianEvidence(bundle.evidenceState.evidenceUnits);
    assert.equal(groups.length, 6); assert.equal(groups.flatMap(group => group.units).length, bundle.evidenceState.evidenceUnits.length);
  });
  check('reported safety clues retain their source evidence and do not assign severity', () => {
    const labels = clinicianRiskLabels([example]); assert.equal(labels[0].scope, 'reported'); assert.deepEqual(labels[0].evidenceIds, [example.evidenceId]);
    assert.ok(labels.every(label => !('severity' in label) && !('riskLevel' in label)));
  });
  check('denial never becomes a reported safety clue', () => assert.equal(clinicianRiskLabels([{ ...example, claim: '没有想消失的想法。', polarity: 'negated' }])[0].scope, 'denied'));
  check('non-observation remains a separate scope from denial and self-report', () => {
    const tags = clinicianRiskLabels([example, { ...example, evidenceId: 'parent', claim: '未观察到自伤，孩子心里是否有想法不清楚。' }]);
    assert.ok(tags.some(tag => tag.scope === 'reported')); assert.ok(tags.some(tag => tag.scope === 'not_observed')); assert.ok(!tags.some(tag => tag.scope === 'denied'));
  });
  check('uncertain safety wording stays pending', () => assert.equal(clinicianRiskLabels([{ ...example, claim: '可能想消失，自己也说不清。', polarity: 'uncertain' }])[0].scope, 'uncertain'));
  check('discrepancy tags reference both current sources and ignore historical units', () => {
    const other = { ...example, evidenceId: 'other' };
    const relations = [{ relationId: 'R-test', priorEvidenceId: example.evidenceId, newEvidenceId: other.evidenceId, semanticRelation: 'contradicts' }];
    assert.equal(clinicianRiskLabels([example, other], relations).find(tag => tag.scope === 'discrepancy').evidenceIds.length, 2);
    assert.ok(!clinicianRiskLabels([{ ...example, superseded: true }]).length);
  });
  check('negated functional impact does not create an impact tag', () => assert.equal(clinicianRiskLabels([{ ...example, slotId: 'functional_impact', claim: '没有影响上学。', polarity: 'negated' }]).length, 0));
  check('mentioning school-day frequency alone does not establish functional impact', () => assert.equal(clinicianRiskLabels([{ ...example, slotId: 'functional_impact', claim: '近两周每个上学日早上都会出现。' }]).length, 0));
  const session = bundle.sessions[0], turns = session.turns;
  const timeline = [{ turnNo: 1, startMs: 500, endMs: 1200 }, { turnNo: 2, startMs: 1400, endMs: 2500 }];
  check('capture windows resolve to actual questions, not submitted question labels', () => {
    const result = normalizeMediaTimeline(timeline, 3000, turns); assert.equal(result[0].qaId, turns[0].qaId); assert.equal(result[0].questionText, turns[0].questionText);
  });
  check('out-of-range, overlapping, duplicate and nonexistent question windows are rejected', () => {
    for (const rows of [[{ turnNo: 1, startMs: -1, endMs: 100 }], [{ turnNo: 1, startMs: 0, endMs: 4000 }], [{ turnNo: 1, startMs: 0, endMs: 0 }], [{ turnNo: 99, startMs: 0, endMs: 100 }], [timeline[0], timeline[0]], [timeline[0], { turnNo: 2, startMs: 1000, endMs: 2000 }]]) assert.throws(() => normalizeMediaTimeline(rows, 3000, turns));
  });
  const full = { mediaId: 'MR-full', sessionId: session.sessionId, turnNo: 0, modality: 'video', durationMs: 3000, timeline: normalizeMediaTimeline(timeline, 3000, turns) };
  check('question playback seeks to its explicit recording window', () => {
    const resolved = questionRecording(turns[1], { ...session, mediaRecords: [full] }); assert.equal(resolved.kind, 'window'); assert.equal(resolved.startMs, 1400); assert.equal(resolved.endMs, 2500);
  });
  check('turn-specific audio takes precedence over the session video', () => {
    const clip = { ...full, mediaId: 'MR-clip', turnNo: 2, modality: 'audio', durationMs: 800, timeline: [] };
    assert.equal(questionRecording(turns[1], { ...session, mediaRecords: [full, clip] }).record.mediaId, 'MR-clip');
  });
  check('legacy full-session playback is explicitly unlocated and missing audio stays missing', () => {
    assert.equal(questionRecording(turns[0], { ...session, mediaRecords: [{ ...full, timeline: [] }] }).kind, 'full');
    assert.equal(questionRecording(turns[0], session), null); assert.equal(questionRecording({ ...turns[0], sessionId: 'different' }, { ...session, mediaRecords: [full] }), null);
  });
  check('an evidence citation resolves through its own session and question', () => {
    const unit = bundle.evidenceState.evidenceUnits.find(unit => unit.sessionId === session.sessionId && unit.inputRound === 2);
    assert.equal(recordingForEvidence(unit, [{ ...session, mediaRecords: [full] }]).recording.startMs, 1400);
  });
  store.saveMediaRecord({ ...full, mimeType: 'video/webm', fileName: 'synthetic-test.webm', filePath: 'synthetic-test.webm', blobSize: 0, recordingStartedAt: 100000 });
  check('recording metadata persists without changing raw answers', () => {
    const loaded = store.getMediaRecord(full.mediaId); assert.equal(loaded.timeline[1].endMs, 2500); assert.equal(loaded.recordingStartedAt, 100000); assert.equal(store.getSnapshot(session.sessionId).turns[0].answerText, turns[0].answerText);
  });
  check('integrated model statements still require exact valid evidence references', () => {
    const state = { evidenceUnits: [example], evidenceRelations: [] };
    const row = { section: 'integrated_assessment', text: '患儿报告近两周有时想消失，但没有采取行动，也没有准备东西。', evidence_ids: [example.evidenceId] };
    assert.equal(validateDoctorExpression({ statements: [row] }, state).statements[0].origin, 'llm');
    const rejected = validateDoctorExpression({ statements: [{ ...row, evidence_ids: ['invented'] }] }, state);
    assert.equal(rejected.rejected.length, 1); assert.ok(rejected.statements.every(statement => statement.origin === 'validation-fallback' && statement.evidenceIds.every(id => id === example.evidenceId)));
  });
  check('an integrated conclusion cannot cite only sleep evidence for an attendance claim', () => {
    const unit = { ...example, slotId: 'sleep_appetite_physical', claim: '晚上很久才睡着。', originalText: '晚上很久才睡着。', riskFlag: false };
    assert.throws(() => validateDoctorExpression({ statements: [{ section: 'integrated_assessment', text: '患儿报告睡眠困难，功能影响包括缺课。', evidence_ids: [unit.evidenceId] }] }, { evidenceUnits: [unit], evidenceRelations: [] }));
  });
  store.db.exec('ALTER TABLE media_record DROP COLUMN timeline_json; ALTER TABLE media_record DROP COLUMN recording_started_at; DELETE FROM schema_migration WHERE version=6;');
  store.close(); store = createStore(join(root, 'workspace.db'));
  check('v5 recording migration preserves legacy records and supplies unknown timing', () => {
    assert.equal(store.getMediaRecord(full.mediaId).mediaId, full.mediaId); assert.deepEqual(store.getMediaRecord(full.mediaId).timeline, []);
    assert.equal(store.getMediaRecord(full.mediaId).recordingStartedAt, null); assert.equal(store.listClinicalCases().length, 2);
  });
  console.log(`clinician workspace regression ok: ${count} checks`);
} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
