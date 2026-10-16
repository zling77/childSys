import assert from 'node:assert/strict';
import { buildEvidenceState, normalizeEvidenceUnits } from '../core/evidenceGraph.mjs';
import { createEvidenceUnits } from '../core/extractor.mjs';
import { updateSlotStates } from '../core/state.mjs';
import { getFacetContract } from '../core/intakeContracts.mjs';
import { buildSourceIndependentFocus, SOURCE_INDEPENDENT_FOCUS_VERSION } from '../core/sourceIndependentFocus.mjs';

const caseId = 'CASE-INDEPENDENT-UNIT';
const sessionId = 'GUARDIAN-INDEPENDENT-UNIT';
const sleepTarget = { slotId: 'sleep_appetite_physical', facetId: 'sleep_change' };
let passed = 0;
function test(name, run) {
  run(); passed += 1; console.log(`PASS ${name}`);
}
function claim(overrides = {}) {
  return {
    evidenceId: 'EU-SECRET-CHILD', caseId, sessionId: 'CHILD-INDEPENDENT-UNIT',
    sourceRole: 'child', sourceMode: 'direct', reportedSourceRole: null,
    sourceIdentity: 'session:CHILD-INDEPENDENT-UNIT:child', inputRound: 1,
    recordedAt: 1, slotId: 'sleep_appetite_physical', facetId: 'health_change_summary',
    claim: '最近天天睡不好，秘密标记只有儿童知道。', polarity: 'affirmed',
    concept: 'sleep', observationContext: 'home',
    referenced_time_span: { raw_text: '最近', start: null, end: null },
    ...overrides,
  };
}
function focus(units = [claim()], overrides = {}) {
  return buildSourceIndependentFocus({
    caseId, sessionId, speakerRole: 'guardian',
    evidenceState: buildEvidenceState(caseId, units), slotStates: [], decisionLogs: [],
    ...overrides,
  });
}
function ownState(status, value = null, rawValue = null) {
  return [{ sessionId, slotId: sleepTarget.slotId, status: 'missing',
    value: { facets: { sleep_change: { status, value, rawValue } } } }];
}
function sleepLog() {
  return { selectedAction: { nextAction: 'ask', nextQuestion: {
    targetSlotOrIssue: sleepTarget.slotId, targetFacetId: sleepTarget.facetId,
    text: '最近孩子晚上的睡眠，您能观察到哪些情况？',
  } } };
}
function ownTurn(answerText, overrides = {}) {
  return { sessionId, speakerRole: 'guardian', questionText: '最近孩子晚上的睡眠，您能观察到哪些情况？',
    targetSlotOrIssue: sleepTarget.slotId, targetFacetId: sleepTarget.facetId, answerText, ...overrides };
}

test('different-source same-case direct sleep opens only a neutral sleep target', () => {
  const result = focus();
  assert.deepEqual(result.targets, [sleepTarget]);
  assert.equal(result.privateAudit.schemaVersion, SOURCE_INDEPENDENT_FOCUS_VERSION);
  assert.equal(result.privateAudit.cross_source_triggered, true);
  assert.equal(result.privateAudit.independentCorroboration, false);
  assert.deepEqual(result.privateAudit.evidenceIds, ['EU-SECRET-CHILD']);
});
test('actual deterministic extraction/normalization can trigger the sleep goal', () => {
  const units = createEvidenceUnits({ sessionId: 'CHILD-INDEPENDENT-UNIT', turnNo: 1,
    text: '最近天天睡不好。', speakerRole: 'child', complaintIds: [], currentQuestion: null });
  const normalized = normalizeEvidenceUnits({ evidenceUnits: units }, caseId);
  assert.ok(normalized.some((unit) => unit.slotId === 'sleep_appetite_physical'));
  assert.ok(focus(normalized).targets.some((target) => target.facetId === 'sleep_change'));
});
test('topic-only targets contain no secret, source, evidence ID, polarity or frequency', () => {
  const json = JSON.stringify(focus().targets);
  for (const secret of ['秘密', '天天', '最近', 'child', 'affirmed', 'EU-SECRET', 'CHILD-INDEPENDENT']) {
    assert.equal(json.includes(secret), false, secret);
  }
  for (const target of focus().targets) {
    assert.deepEqual(Object.keys(target).sort(), ['facetId', 'slotId']);
    assert.ok(getFacetContract(target.slotId, target.facetId));
  }
});
test('frequency, polarity, quote detail and identity cannot encode an expected answer', () => {
  const variants = [
    claim({ claim: '最近每天睡不好', polarity: 'affirmed' }),
    claim({ claim: '最近每周一次睡不好', polarity: 'affirmed', sourceIdentity: 'DIFFERENT' }),
    claim({ claim: '最近睡眠没有问题', polarity: 'negated' }),
    claim({ claim: '最近睡觉怎么样我不清楚', polarity: 'uncertain' }),
  ];
  variants.forEach((unit) => assert.deepEqual(focus([unit]).targets, [sleepTarget]));
});
test('unlinked or different-case graph cannot influence the current interview', () => {
  assert.deepEqual(focus(undefined, { caseId: null }).targets, []);
  assert.deepEqual(focus(undefined, { evidenceState: buildEvidenceState('OTHER-CASE', [claim()]) }).targets, []);
  assert.deepEqual(focus([claim({ caseId: 'OTHER-CASE' })]).targets, []);
});
test('same session, same role and reported/quoted material are excluded', () => {
  for (const unit of [claim({ sessionId }), claim({ sourceRole: 'caregiver' }),
    claim({ sourceMode: 'reported', reportedSourceRole: 'child' }),
    claim({ sourceMode: 'direct', reportedSourceRole: 'child' }),
    claim({ sessionId: null, materialId: 'MAT' }), claim({ sourceRole: 'other' })]) {
    assert.deepEqual(focus([unit]).targets, []);
  }
});
test('missing/unknown respondent does not enable cross-source focus', () => {
  assert.deepEqual(focus(undefined, { speakerRole: null }).targets, []);
  assert.deepEqual(focus(undefined, { speakerRole: 'unknown' }).targets, []);
});
test('guardian evidence can neutrally trigger the child mode', () => {
  assert.deepEqual(focus([claim({ sourceRole: 'caregiver' })], { speakerRole: 'child' }).targets, [sleepTarget]);
  assert.deepEqual(focus(undefined, { speakerRole: 'father' }).targets, [sleepTarget]);
});
test('removed/deleted/reassigned evidence no longer triggers focus', () => {
  assert.deepEqual(focus([]).targets, []);
  assert.deepEqual(focus([claim({ deleted: true })]).targets, []);
  assert.deepEqual(focus([claim({ caseId: 'MOVED-CASE' })]).targets, []);
});
test('superseded old sleep claim cannot survive its correction to another topic', () => {
  const old = claim();
  const corrected = claim({ evidenceId: 'EU-CORRECTION', recordedAt: 2, inputRound: 2,
    claim: '刚才说错了，其实最近胃口好', explicitCorrection: true });
  const state = buildEvidenceState(caseId, [old, corrected]);
  assert.equal(state.evidenceUnits.find((unit) => unit.evidenceId === old.evidenceId).superseded, true);
  const targets = focus(undefined, { evidenceState: state }).targets;
  assert.equal(targets.some((target) => target.facetId === 'sleep_change'), false);
});
for (const status of ['filled', 'declined', 'unavailable', 'not_applicable']) {
  test(`current source ${status} is preserved instead of reopening sleep`, () => {
    assert.deepEqual(focus(undefined, { slotStates: ownState(status) }).targets, []);
  });
}
test('actual filled current-source facet state prevents duplicate cross-source collection', () => {
  const snapshot = { session: { sessionId }, evidenceUnits: [], slotStates: [] };
  const units = createEvidenceUnits({ sessionId, turnNo: 1, text: '入睡困难，半夜醒。', speakerRole: 'guardian',
    complaintIds: [], currentQuestion: { targetSlotOrIssue: sleepTarget.slotId, targetFacetId: 'sleep_change', text: '最近睡眠如何？' } });
  const slotStates = updateSlotStates(snapshot, [], units);
  assert.equal(slotStates.find((state) => state.slotId === sleepTarget.slotId).value.facets.sleep_change.status, 'filled');
  assert.deepEqual(focus(undefined, { slotStates }).targets, []);
});
test('an optional sleep goal can open after required health summary is filled', () => {
  const slotStates = [{ sessionId, slotId: sleepTarget.slotId, status: 'filled', value: { facets: {
    health_change_summary: { status: 'filled' }, sleep_change: { status: 'missing' },
  } } }];
  assert.deepEqual(focus(undefined, { slotStates }).targets, [sleepTarget]);
});
test('explicit current unknown/unclear is respected and cannot force a sleep re-question', () => {
  for (const slotStates of [ownState('partial', null, '我不知道，晚上我观察不到'), ownState('ambiguous', ['unclear'])]) {
    assert.deepEqual(focus(undefined, { slotStates }).targets, []);
  }
});
test('two actual attempts exclude the target; rejected candidates do not count', () => {
  assert.deepEqual(focus(undefined, { decisionLogs: [sleepLog()] }).targets, [sleepTarget]);
  assert.deepEqual(focus(undefined, { decisionLogs: [sleepLog(), sleepLog()] }).targets, []);
  assert.deepEqual(focus(undefined, { decisionLogs: [{ nextAction: 'complete', ...sleepLog() }, { candidates: [sleepTarget] }] }).targets, [sleepTarget]);
});
test('deduplication caps attention to three targets and prioritizes sleep', () => {
  const units = [claim(), claim({ evidenceId: 'EU-SLEEP-DUP' }),
    claim({ evidenceId: 'EU-IMPACT', slotId: 'functional_impact', facetId: 'impact_presence', claim: '影响学习' }),
    claim({ evidenceId: 'EU-MANIFEST', slotId: 'current_manifestations', facetId: 'manifestation_description', claim: '课堂走神' }),
    claim({ evidenceId: 'EU-ONSET', slotId: 'onset_course', facetId: 'onset_time', claim: '上周开始' })];
  const result = focus(units);
  assert.equal(result.targets.length, 3);
  assert.deepEqual(result.targets[0], sleepTarget);
  assert.equal(new Set(result.targets.map((target) => `${target.slotId}:${target.facetId}`)).size, 3);
});
test('ordinary domains map to required goals, not original answers or supplemental facets', () => {
  const result = focus([claim({ slotId: 'functional_impact', facetId: 'impact_example', claim: '作业影响休息' })]);
  assert.deepEqual(result.targets, [{ slotId: 'functional_impact', facetId: 'impact_presence' }]);
});
test('safety clues remain outside routine cross-source attention', () => {
  const result = focus([claim({ slotId: 'safety_clues', facetId: 'safety_presence', claim: '想伤害自己' })]);
  assert.deepEqual(result.targets, []);
  assert.equal(result.privateAudit.cross_source_triggered, false);
});
test('relation IDs remain private and do not imply independent corroboration', () => {
  const a = claim();
  const b = claim({ evidenceId: 'EU-OWN', sessionId, sourceRole: 'caregiver', sourceIdentity: 'OWN', recordedAt: 2 });
  const result = focus([a, b]);
  assert.ok(result.privateAudit.relations.length > 0);
  assert.equal(result.privateAudit.targets[0].collectionMode, 'cross_source_triggered');
  assert.equal(JSON.stringify(result.targets).includes('supports'), false);
  assert.equal(result.privateAudit.independentCorroboration, false);
});
test('building attention hints does not mutate current state or case evidence', () => {
  const args = { caseId, sessionId, speakerRole: 'guardian', evidenceState: buildEvidenceState(caseId, [claim()]),
    slotStates: ownState('missing'), decisionLogs: [sleepLog()] };
  const before = JSON.stringify(args);
  buildSourceIndependentFocus(args);
  assert.equal(JSON.stringify(args), before);
});
test('stored own-turn refusal permanently suppresses the same cross-source goal', () => {
  const ownTurns = [ownTurn('这部分我暂时不想说。')];
  const result = focus(undefined, { ownTurns });
  assert.deepEqual(result.targets, []);
  assert.equal(result.privateAudit.excludedTargets[0].reason, 'current_source_declined_history');
  // After an unrelated answer the old refusal remains explicit history, even
  // when the rule slot extractor has not persisted a declined facet status.
  assert.deepEqual(focus(undefined, { ownTurns: [...ownTurns, ownTurn('家里有爸爸妈妈照顾他', {
    targetSlotOrIssue: 'family_context_history', targetFacetId: 'family_context_summary',
  })] }).targets, []);
});
test('not knowing, forgetting and not observing suppress without inferring normal sleep', () => {
  for (const answer of ['我不知道。', '这个我不记得了。', '我没有观察到。', '我晚上没注意。', '这方面我不了解', '我没有发现异常']) {
    const result = focus(undefined, { ownTurns: [ownTurn(answer)] });
    assert.deepEqual(result.targets, [], answer);
    assert.equal(result.privateAudit.evidenceIds.length, 0);
    assert.equal(result.privateAudit.independentCorroboration, false);
  }
});
test('short answers, silence and uncertain help requests never imply refusal', () => {
  for (const answer of ['', '嗯', '好', '……', '我不知道怎么办', '我不知道怎么帮他', '他睡不好，我不知道为什么']) {
    assert.deepEqual(focus(undefined, { ownTurns: [ownTurn(answer)] }).targets, [sleepTarget], answer);
  }
});
test('quoted or reported child refusal is not the guardian refusing', () => {
  for (const answer of ['孩子说“我不知道”。', '孩子说他不想回答。', '他说他不记得', '孩子说不清楚为什么睡不好', '我家孩子说不想回答', '孩子没有观察到']) {
    assert.deepEqual(focus(undefined, { ownTurns: [ownTurn(answer)] }).targets, [sleepTarget], answer);
  }
});
test('other-session/source refusal and another facet cannot suppress own sleep', () => {
  for (const turn of [ownTurn('我不知道', { sessionId: 'OTHER-SESSION' }),
    ownTurn('我不知道', { speakerRole: 'child' }),
    ownTurn('我不知道', { targetFacetId: 'appetite_change' }),
    ownTurn('我不知道', { targetFacetId: null })]) {
    assert.deepEqual(focus(undefined, { ownTurns: [turn] }).targets, [sleepTarget]);
  }
});
test('pending/nested question shape supports the same explicit refusal boundary', () => {
  const turn = { sessionId, speakerRole: 'guardian', question: { slotId: sleepTarget.slotId,
    targetFacetId: sleepTarget.facetId, text: '最近孩子的睡眠如何？' }, answerText: '我不想回答这个问题' };
  assert.deepEqual(focus(undefined, { ownTurns: [turn] }).targets, []);
});
test('negated refusal/unknown wording is not an explicit personal barrier', () => {
  for (const answer of ['我不是不想说', '我并非不知道', '我没有说不想回答', '我不是没有观察到']) {
    assert.deepEqual(focus(undefined, { ownTurns: [ownTurn(answer)] }).targets, [sleepTarget], answer);
  }
});
console.log(`Source-independent focus unit regression passed: ${passed} checks.`);
