import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.mjs';
import { seedLlmComparisonCases } from '../server/llm-comparison-cases.mjs';
import { clinicianRuntime, clinicianDocuments, clinicianInputHash, validateClinicianExtraction, validateClinicianRelations, validateDoctorExpression, analyzeClinicianCase } from '../core/llm/clinician.mjs';

let count = 0;
async function check(name, fn) { await fn(); count++; console.log(`ok - ${name}`); }
const root = mkdtempSync(join(tmpdir(), 'childpsych-llm-regression-'));
const store = createStore(join(root, 'test.db'));
try {
  const keep = store.createClinicalCase({ title: 'Existing fictional material', profile: { dataset: 'fully_synthetic_development' } });
  store.addClinicalMaterial(keep.caseId, { sourceRole: 'caregiver', text: '近两周影响上学。', slotId: 'functional_impact', facetId: 'impact_presence' });
  const fixtures = seedLlmComparisonCases(store);
  await check('adding comparison fixtures preserves existing records and is idempotent', () => {
    assert.equal(store.listClinicalCases().length, 5); assert.equal(seedLlmComparisonCases(store).length, 4);
    assert.equal(store.listClinicalCases().length, 5); assert.equal(store.getClinicalCase(keep.caseId).title, 'Existing fictional material');
  });
  const bundle = store.getClinicalBundle(fixtures[0].caseId), documents = clinicianDocuments(bundle);
  const atoms = documents.map(d => ({ source_id: d.id, slot_id: 'functional_impact', facet_id: 'impact_example', quote: d.text, occurrence: 1, concept: 'school_attendance', polarity: 'affirmed', context: 'school', time_quote: '2026-10-01至2026-10-07', explicit_correction: false }));
  const extracted = validateClinicianExtraction({ evidence: atoms }, documents, bundle.clinicalCase.caseId);
  await check('every accepted quote has exact offsets and immutable source provenance', () => {
    assert.equal(extracted.units.length, 2);
    for (const unit of extracted.units) { assert.equal(unit.originalText.slice(unit.traceRef.start, unit.traceRef.end), unit.traceText); assert.equal(unit.sourceRole, documents.find(d => d.id === unit.sourceDocumentId).sourceRole); }
  });
  await check('fabricated quotes are rejected even alongside valid output', () => {
    const result = validateClinicianExtraction({ evidence: [...atoms, { ...atoms[0], quote: '缺课七天' }] }, documents, bundle.clinicalCase.caseId);
    assert.equal(result.units.length, 2); assert.equal(result.rejected.length, 1);
  });
  await check('whitespace-only quote differences map back to original characters', () => {
    const result = validateClinicianExtraction({ evidence: [{ ...atoms[0], quote: atoms[0].quote.replace('至', ' 至 '), time_quote: atoms[0].time_quote.replace('至', ' 至 ') }] }, documents, bundle.clinicalCase.caseId);
    const unit = result.units[0]; assert.equal(unit.quoteNormalization, 'whitespace_only'); assert.equal(unit.traceText, atoms[0].quote); assert.equal(unit.originalText.slice(unit.traceRef.start, unit.traceRef.end), unit.traceText);
  });
  await check('unknown sources, fields and invented time phrases are rejected', () => {
    for (const changes of [{ source_id: 'fake' }, { facet_id: 'fake' }, { time_quote: '去年' }]) assert.throws(() => validateClinicianExtraction({ evidence: [{ ...atoms[0], ...changes }] }, documents, bundle.clinicalCase.caseId), /没有通过/);
  });
  await check('missing material formation time stays unknown', () => {
    const docs = [{ ...documents[0], observedTime: null, text: '近两周影响上学。' }];
    const result = validateClinicianExtraction({ evidence: [{ ...atoms[0], quote: docs[0].text, time_quote: '近两周' }] }, docs, bundle.clinicalCase.caseId);
    assert.equal(result.units[0].referenced_time_span.start, null);
  });
  const pair = { pairId: 'P1', prior: extracted.units[0], next: extracted.units[1], temporal: 'same_window' };
  const relation = semantic => ({ relations: [{ pair_id: 'P1', relation: semantic, rationale: '完全模拟的规则边界测试。' }] });
  await check('same-polarity numerical differences may be retained as candidate discrepancies', () => assert.equal(validateClinicianRelations(relation('contradicts'), [pair]).relations[0].semanticRelation, 'contradicts'));
  await check('disjoint time windows override model conflict suggestions', () => {
    const result = validateClinicianRelations(relation('contradicts'), [{ ...pair, temporal: 'before' }]).relations[0];
    assert.equal(result.semanticRelation, 'unknown'); assert.equal(result.reasonCode, 'different_time'); assert.ok(result.guarded);
  });
  await check('different contexts override model conflict suggestions', () => {
    const result = validateClinicianRelations(relation('contradicts'), [{ ...pair, prior: { ...pair.prior, observationContext: 'home' } }]).relations[0];
    assert.equal(result.semanticRelation, 'not_comparable');
  });
  await check('unknown time does not establish a verified overlapping conflict', () => assert.equal(validateClinicianRelations(relation('contradicts'), [{ ...pair, temporal: 'unknown' }]).relations[0].reasonCode, 'possible_discrepancy'));
  await check('non-observation is not automatically treated as negating a self-report', () => {
    const result = validateClinicianRelations(relation('contradicts'), [{ ...pair, next: { ...pair.next, claim: '没有观察到孩子自伤' } }]).relations[0];
    assert.equal(result.reasonCode, 'observation_vs_experience');
  });
  await check('a different source cannot silently correct existing evidence', () => assert.equal(validateClinicianRelations(relation('corrects'), [pair]).relations[0].reasonCode, 'unqualified_correction'));
  await check('missing model relations remain visibly unresolved', () => assert.equal(validateClinicianRelations({ relations: [] }, [pair]).relations[0].reasonCode, 'llm_missing_relation'));
  const state = { evidenceUnits: extracted.units, evidenceRelations: validateClinicianRelations(relation('contradicts'), [pair]).relations };
  const prose = { statements: [{ section: 'functional_impact', text: '监护人与学校记录的缺课天数存在分歧，需核实。', evidence_ids: extracted.units.map(u => u.evidenceId) }] };
  await check('doctor expression requires valid current evidence references', () => {
    assert.equal(validateDoctorExpression(prose, state).statements.length, 1);
    assert.throws(() => validateDoctorExpression({ statements: [{ ...prose.statements[0], evidence_ids: ['fake'] }] }, state), /没有通过/);
    assert.throws(() => validateDoctorExpression(prose, { ...state, evidenceUnits: extracted.units.map(u => ({ ...u, superseded: true })) }), /没有通过/);
  });
  await check('unsupported numbers, diagnostic outputs and treatment advice are rejected', () => {
    for (const value of ['孩子缺课99天。', '诊断为抑郁症。', '建议用药。']) assert.throws(() => validateDoctorExpression({ statements: [{ ...prose.statements[0], text: value }] }, state), /没有通过/);
  });
  await check('a discrepancy omitted in prose gets an explicit cited fallback', () => {
    const result = validateDoctorExpression({ statements: [{ section: 'functional_impact', text: '监护人记录缺课两天。', evidence_ids: [extracted.units[0].evidenceId] }] }, state);
    assert.equal(result.statements.at(-1).origin, 'validation-fallback'); assert.equal(result.statements.at(-1).evidenceIds.length, 2);
  });
  await check('risk qualifiers cannot be silently narrowed in doctor expression', () => {
    const unit = { ...extracted.units[0], claim: '有时想消失，但没有采取行动，也没有准备东西。', originalText: '有时想消失，但没有采取行动，也没有准备东西。', riskFlag: true };
    const result = validateDoctorExpression({ statements: [{ section: 'main_symptoms', text: '自述想消失，但未采取行动或准备工具。', evidence_ids: [unit.evidenceId] }] }, { evidenceUnits: [unit], evidenceRelations: [] });
    assert.equal(result.rejected.length, 1); assert.equal(result.statements[0].origin, 'validation-fallback'); assert.match(result.statements[0].text, /没有准备东西/);
  });
  await check('input fingerprints change with source scope and review records', () => {
    assert.notEqual(clinicianInputHash(bundle), clinicianInputHash({ ...bundle, reviews: [{ note: 'Synthetic review' }] }));
    assert.notEqual(clinicianInputHash(bundle), clinicianInputHash({ ...bundle, materials: bundle.materials.slice(1) }));
  });
  const runtime = clinicianRuntime({ PREVISIT_CLINICIAN_LLM_MODE: 'on' });
  await check('independent clinician LLM remains disabled by default', () => assert.equal(clinicianRuntime({}).enabled, false));
  await check('three-stage pipeline uses validated evidence and records hashes', async () => {
    const calls = [];
    const mockFetch = async (_url, options) => {
      const request = JSON.parse(options.body); calls.push(request);
      const output = calls.length === 1 ? { evidence: atoms } : calls.length === 2 ? relation('contradicts') : prose;
      return { ok: true, json: async () => ({ model: runtime.model, message: { content: JSON.stringify(output) }, done_reason: 'stop', eval_count: 10 }) };
    };
    const result = await analyzeClinicianCase(bundle, runtime, { fetchImpl: mockFetch });
    assert.equal(calls.length, 3); assert.ok(calls.every(c => c.think === false && c.format && JSON.parse(c.messages[1].content).output_schema));
    assert.equal(result.audits.length, 3); assert.ok(result.audits.every(a => a.requestHash && a.responseHash));
    assert.equal(result.statistics.llmDisputedTopics, 1); assert.equal(result.statistics.traceableEvidence, 2);
  });
  await check('model HTTP errors and truncated output fail visibly', async () => {
    await assert.rejects(analyzeClinicianCase(bundle, runtime, { fetchImpl: async () => ({ ok: false, status: 503 }) }), /HTTP 503/);
    await assert.rejects(analyzeClinicianCase(bundle, runtime, { fetchImpl: async () => ({ ok: true, json: async () => ({ done_reason: 'length' }) }) }), /不完整/);
  });
  await check('oversized source input is rejected rather than silently truncated', async () => {
    await assert.rejects(analyzeClinicianCase({ ...bundle, materials: [{ ...bundle.materials[0], text: '模拟'.repeat(17000) }] }, runtime), /未截断/);
  });
  console.log(`clinician llm regression ok: ${count} checks`);
} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
