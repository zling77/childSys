import assert from 'node:assert/strict';

import {
  COVERAGE_DOMAIN,
  intakeCoverageDomains,
} from '../core/coverage.mjs';
import { mapComplaints } from '../core/complaints.mjs';
import {
  createEvidenceUnits,
  isAnswerRelevantToQuestion,
  isLowInformationAnswer,
} from '../core/extractor.mjs';
import { handleTurn } from '../core/orchestrator.mjs';
import { getIntakeContract, intakeContracts } from '../core/intakeContracts.mjs';
import { validateDynamicSelection, validateQuestionForTarget } from '../core/llm/dynamicBoundary.mjs';
import { buildDynamicGoal, buildDynamicGoalSpace, dynamicGoalDefinitions, realizeGoalFallback } from '../core/llm/dynamicGoalSpace.mjs';
import { buildDynamicNextQuestionMessages } from '../core/llm/promptRegistry.mjs';
import { validateDynamicNextQuestionOutput } from '../core/llm/schemaValidator.mjs';
import { generatePrevisitPacket } from '../core/packet.mjs';
import { planNextQuestion } from '../core/planner.mjs';
import { rewriteQuestion } from '../core/question.mjs';
import { findRiskSignals } from '../core/risk.mjs';
import { computeProgress, findGaps, updateSlotStates } from '../core/state.mjs';

const tests = [
  ['denied self-harm and death wishes do not create risk signals', testDeniedRisk],
  ['affirmed risk still creates risk signals', testAffirmedRisk],
  ['an explicit short denial remains usable for a safety question', testShortDenial],
  ['short precise time and frequency answers are relevant', testShortPreciseAnswers],
  ['explicit zero frequency is relevant, normalized, and resolved', testExplicitZeroFrequency],
  ['explicit absence of functional impact is stored as false', testExplicitNoFunctionalImpact],
  ['a frequency answer does not incidentally fill onset', testFrequencyDoesNotPolluteOnset],
  ['a short precise targeted answer fills only its facet and advances without clarification', testShortPreciseTurnAdvances],
  ['frequency alone leaves the severity facet open', testFrequencyFacetGap],
  ['a worst-episode example does not masquerade as frequency', testSeverityExampleDoesNotFillFrequency],
  ['a sibling-facet answer cannot fill the currently targeted facet', testSiblingFacetDoesNotFillTarget],
  ['a substantive targeted episode is accepted without a keyword template', testSubstantiveEpisodeAnswer],
  ['an off-topic answer cannot fill the target domain', testOffTopicAnswer],
  ['a safety denial is stored with absent polarity', testDeniedEvidencePolarity],
  ['a stated death wish remains present evidence', testAffirmedEvidencePolarity],
  ['mixed denied and affirmed safety facts preserve the affirmed signal', testMixedSafetyPolarity],
  ['historical safety evidence remains while current denial is stored as absent', testHistoricalSafetyWithCurrentDenial],
  ['every complaint tag uses the same fourteen-domain intake coverage', testUniversalCoverage],
  ['internal complaint tags are not capped at three', testComplaintTagsAreNotAQuestionBoundary],
  ['the opening narrative records the presenting problem', testOpeningNarrative],
  ['keyword-only partial evidence remains a coverage gap', testPartialEvidenceRemainsGap],
  ['opposite evidence for one domain becomes a conflict', testConflictingEvidence],
  ['incompatible quantified answers become ambiguous', testAmbiguousQuantifiedEvidence],
  ['later low-confidence evidence does not downgrade a filled domain', testNoConfidenceDowngrade],
  ['legacy slot-level state remains resolved after the facet rollout', testLegacySlotStateMigration],
  ['legacy single-facet state does not fill sibling facets', testLegacySingleFacetMigration],
  ['legacy non-evidence resolution applies to every required facet', testLegacyNonEvidenceResolution],
  ['legacy progress and gaps use the same facet normalization', testLegacyProgressConsistency],
  ['closed enum values are normalized and invalid values stay partial', testClosedEnumNormalization],
  ['course enum options stay relevant and mixed directions stay ambiguous', testCourseEnumBoundaries],
  ['an open safety signal takes adaptive priority', testRiskAdaptivePriority],
  ['a new safety signal interrupts ordinary clarification', testRiskInterruptsRuleClarification],
  ['ordinary next-question order changes with the latest answer', testAdaptiveOrderUsesLatestAnswer],
  ['seven turns do not stop an incomplete intake', testNoNormalTurnCap],
  ['all attempted but unresolved domains allow completion', testAttemptExhaustionCompletion],
  ['legacy domain-level attempts do not exhaust every sibling facet', testLegacyAttemptScoping],
  ['a high safety cap still prevents an endless interview', testHardSafetyCap],
  ['complete coverage ends the intake', testCoverageCompletion],
  ['guardian and child questions each contain exactly one question mark', testSingleQuestionBoundary],
  ['guardian impact wording preserves the fixed impact target', testGuardianImpactQuestion],
  ['a child respondent receives child-oriented wording', testChildQuestionSelection],
  ['the explicit turn speaker role overrides a conflicting profile respondent', testSpeakerRoleIsAuthoritative],
  ['child clarification stays focused, child-oriented, and on the same target', testChildClarification],
  ['dynamic selection rejects completion, unknown targets, and exhausted gaps', testDynamicTargetBoundary],
  ['dynamic safety selection cannot be bypassed or turned into disposition advice', testDynamicSafetyBoundary],
  ['dynamic output keeps the first focused question when a small model emits two', testDynamicQuestionNormalization],
  ['dynamic goal space covers every required facet without storing fixed questions', testDynamicGoalSpace],
  ['dynamic prompt is bounded and contains only safe strategy candidates', testDynamicPromptContract],
  ['child dynamic wording cannot fall back to guardian language', testDynamicChildLanguageBoundary],
  ['every non-safety required fallback satisfies its own dynamic boundary', testRequiredFallbackBoundaryAlignment],
  ['course-pattern boundary accepts natural time-comparison questions', testNaturalCoursePatternBoundary],
  ['low-information answers cannot trigger endless clarification', testClarificationLimit],
  ['decision logs retain every structured coverage gap', testFullGapAudit],
  ['the clinician packet exposes the requested structured summary', testStructuredPacket],
  ['the clinician packet preserves values collected across separate facets', testPacketPreservesFacetValues],
  ['the clinician packet exposes optional-facet conflicts', testPacketIncludesOptionalFacetConflict],
  ['a child-authored packet is labelled as the child report', testChildPacketReporter],
  ['normal sleep and development are not labelled important abnormalities', testNormalHistoryNotAbnormal],
  ['reported sleep or developmental changes are labelled for attention', testReportedChangeIsImportant],
];

function testDynamicQuestionNormalization() {
  const output = validateDynamicNextQuestionOutput({
    next_action: 'ask',
    acknowledgement: '听起来您对此很担心',
    question: '送到学校开始哭之前，孩子刚刚遇到了什么？老师当时在场吗？',
    complaint_id: COVERAGE_DOMAIN,
    target_slot_or_issue: 'triggers_context',
    reason: '回答提到送到学校就哭，需要了解紧邻诱因。',
    confidence: 0.8,
  });
  assert.equal(output.question, '送到学校开始哭之前，孩子刚刚遇到了什么？');
  assert.equal(output.acknowledgement, '听起来您对此很担心。');
  assert.equal(output.reason, '回答提到送到学校就哭，需要了解紧邻诱因。');
}

function testDynamicPromptContract() {
  const selectedTargetFacet = dynamicRule('triggers_context', 'trigger_pattern');
  const built = buildDynamicNextQuestionMessages({
    sessionId: 'S-PROMPT',
    speakerRole: 'guardian',
    profile: { age: 10, grade: '小学四年级' },
    answerText: '我很担心，孩子一到学校门口就哭。',
    currentQuestion: coverageQuestion('current_manifestations', 'recent_episode'),
    selectedTargetFacet,
    candidateTargets: [selectedTargetFacet, dynamicRule('onset_course', 'onset_time')],
    activeClaims: [{
      claimId: 'E-PROMPT-1',
      complaintId: COVERAGE_DOMAIN,
      slotId: 'triggers_context',
      facetId: 'trigger_pattern',
      evidenceText: '孩子一到学校门口就哭。',
    }],
    activeConflicts: [],
    openDeterministicRisks: [],
    relatedTurns: [{ turnId: 'T-1', question: '最近一次发生了什么？', answer: '一到学校门口就哭。' }],
    // Legacy broad inputs may still be supplied by callers during rollout,
    // but v5 must never serialize the unbounded state into the model prompt.
    gaps: [{ slotId: 'sleep_appetite_physical' }],
    slotStates: [{ slotId: 'sleep_appetite_physical', value: { text: '不应注入' } }],
    evidenceUnits: [{ slotId: 'sleep_appetite_physical', rawText: '不应注入' }],
  });
  assert.equal(built.promptVersion, 'previsit_dynamic_next_question_v7');
  assert.equal(built.contextOk, true);
  assert.ok(built.contextTelemetry.budget.finalChars <= 4000);
  const promptText = built.messages.map((message) => message.content).join('\n');
  assert.match(promptText, /selected_target_facet/);
  assert.match(promptText, /candidate_targets/);
  assert.match(promptText, /trigger_pattern/);
  assert.match(promptText, /6-11/);
  assert.doesNotMatch(promptText, /dialogue_guidance|acknowledgement/);
  assert.match(promptText, /target_facet_id/);
  assert.match(promptText, /information_goal/);
  assert.match(promptText, /minimum_evidence/);
  assert.doesNotMatch(promptText, /fallback_question|candidateQuestion|candidate_question/);
  assert.doesNotMatch(promptText, /已采集槽位|待补缺口|允许候选目标/);
  assert.doesNotMatch(promptText, /sleep_appetite_physical/);
}

const failures = [];
for (const [name, test] of tests) {
  try {
    test();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`not ok - ${name}`);
    console.error(error instanceof Error ? error.stack : error);
  }
}

if (failures.length > 0) {
  throw new AggregateError(
    failures.map(({ error }) => error),
    `${failures.length} of ${tests.length} core regression checks failed`,
  );
}

console.log(`core regression ok: ${tests.length} checks`);

function testDynamicGoalSpace() {
  const requiredTargets = intakeContracts.flatMap((contract) => contract.requiredFacets.map((facetId) => ({
    complaintId: COVERAGE_DOMAIN,
    targetSlotOrIssue: contract.slotId,
    targetFacetId: facetId,
    facetLabel: contract.facets.find((facet) => facet.facetId === facetId)?.label,
  })));
  const goals = buildDynamicGoalSpace(requiredTargets);
  assert.equal(requiredTargets.length, 18);
  assert.equal(goals.length, requiredTargets.length);
  assert.equal(dynamicGoalDefinitions().length, 18);
  for (const target of goals) {
    assert.ok(target.informationGoal);
    assert.ok(target.minimumEvidence);
    assert.ok(target.answerShape);
    assert.ok(target.allowedActions.length > 0);
    assert.doesNotMatch(JSON.stringify(target), /question|template|fallback/i);
  }
}

function testDeniedRisk() {
  assert.deepEqual(findRiskSignals('孩子明确说自己不想死，也没有自伤。', 'S-RISK-DENIED', 1, 'guardian'), []);
}

function testAffirmedRisk() {
  const signals = findRiskSignals('孩子说过不想活，也曾经用刀划伤自己。', 'S-RISK-PRESENT', 1, 'guardian');
  assert.deepEqual(signals.map((signal) => signal.signalType).sort(), ['self_harm', 'suicide']);
}

function testShortDenial() {
  assert.equal(isLowInformationAnswer('没有'), false);
  assert.equal(isAnswerRelevantToQuestion('没有', coverageQuestion('safety_clues')), true);
  assert.equal(isAnswerRelevantToQuestion('没有', coverageQuestion('onset_course')), false);
}

function testShortPreciseAnswers() {
  assert.equal(isAnswerRelevantToQuestion('半年', coverageQuestion('onset_course')), true);
  assert.equal(isAnswerRelevantToQuestion('每天', coverageQuestion('frequency_severity')), true);
  assert.equal(isAnswerRelevantToQuestion('三次', coverageQuestion('frequency_severity')), true);
}

function testExplicitZeroFrequency() {
  const question = coverageQuestion('frequency_severity', 'frequency');
  for (const [index, answer] of ['这周一次都没有。', '没有。'].entries()) {
    const base = emptySnapshot(`S-ZERO-FREQUENCY-${index}`);
    const units = createEvidenceUnits({
      sessionId: base.session.sessionId,
      turnNo: 1,
      text: answer,
      speakerRole: 'guardian',
      currentQuestion: question,
    });
    const unit = units.find((item) => item.slotId === 'frequency_severity');
    assert.ok(unit);
    assert.equal(unit.value.facetPolarities.frequency, 'absent');
    const state = coverageState(updateSlotStates(base, [], units), 'frequency_severity');
    assert.equal(state?.value.facets.frequency.status, 'filled');
    assert.equal(state?.value.facets.frequency.value, 0);
    assert.equal(state?.value.facets.frequency.rawValue, answer);
    assert.equal(state?.value.facets.severity_example.status, 'missing');
  }
}

function testExplicitNoFunctionalImpact() {
  const base = emptySnapshot('S-NO-FUNCTIONAL-IMPACT');
  const question = coverageQuestion('functional_impact', 'impact_presence');
  const units = createEvidenceUnits({
    sessionId: base.session.sessionId,
    turnNo: 1,
    text: '一点影响都没有。',
    speakerRole: 'guardian',
    currentQuestion: question,
  });
  const unit = units.find((item) => item.slotId === 'functional_impact');
  assert.ok(unit);
  assert.equal(unit.value.facetPolarities.impact_presence, 'absent');
  const state = coverageState(updateSlotStates(base, [], units), 'functional_impact');
  assert.equal(state?.value.facets.impact_presence.status, 'filled');
  assert.equal(state?.value.facets.impact_presence.value, false);
}

function testFrequencyDoesNotPolluteOnset() {
  const units = createEvidenceUnits({
    sessionId: 'S-NO-ONSET-POLLUTION',
    turnNo: 1,
    text: '最近一周每天一次。',
    speakerRole: 'guardian',
    currentQuestion: coverageQuestion('frequency_severity', 'frequency'),
  });
  assert.equal(units.some((item) => item.slotId === 'onset_course'), false);
}

function testShortPreciseTurnAdvances() {
  const base = emptySnapshot('S-SHORT-PRECISE-TURN');
  const question = coverageQuestion('onset_course', 'onset_time');
  base.decisionLogs = [decisionLogForQuestion(1, question)];
  const result = handleTurn(base, {
    speakerRole: 'guardian',
    answerText: '半年',
    currentQuestion: question,
  });
  const state = coverageState(result.slotStates, 'onset_course');
  assert.equal(state?.status, 'partial');
  assert.equal(state?.value.facets.onset_time.status, 'filled');
  assert.equal(state?.value.facets.course_pattern.status, 'missing');
  assert.notEqual(result.nextQuestion?.policyType, 'goal_space_clarify');
  assert.notEqual(
    `${result.nextQuestion?.targetSlotOrIssue}:${result.nextQuestion?.targetFacetId}`,
    'onset_course:onset_time',
  );
}

function testFrequencyFacetGap() {
  const base = emptySnapshot('S-FREQUENCY-FACET');
  const question = coverageQuestion('frequency_severity', 'frequency');
  const result = handleTurn(base, {
    speakerRole: 'guardian',
    answerText: '最近一周每天一次。',
    currentQuestion: question,
  });
  const state = coverageState(result.slotStates, 'frequency_severity');
  assert.equal(state?.value.facets.frequency.status, 'filled');
  assert.equal(state?.value.facets.severity_example.status, 'missing');
  assert.equal(state?.status, 'partial');
  assert.ok(result.decisionLog.stateSummary.gaps.some((gap) => (
    gap.slotId === 'frequency_severity' && gap.facetId === 'severity_example'
  )));
}

function testSeverityExampleDoesNotFillFrequency() {
  const base = emptySnapshot('S-SEVERITY-NOT-FREQUENCY');
  const question = coverageQuestion('frequency_severity', 'severity_example');
  const result = handleTurn(base, {
    speakerRole: 'guardian',
    answerText: '最严重的一次是把门踢坏了。',
    currentQuestion: question,
  });
  const state = coverageState(result.slotStates, 'frequency_severity');
  assert.equal(state?.value.facets.severity_example.status, 'filled');
  assert.equal(state?.value.facets.frequency.status, 'missing');
  const evidence = result.evidenceUnits.find((item) => item.slotId === 'frequency_severity');
  assert.deepEqual(evidence?.facetIds, ['severity_example']);
}

function testSiblingFacetDoesNotFillTarget() {
  const base = emptySnapshot('S-SIBLING-FACET');
  const question = coverageQuestion('frequency_severity', 'severity_example');
  const result = handleTurn(base, {
    speakerRole: 'guardian',
    answerText: '最近一周每天一次。',
    currentQuestion: question,
  });
  const state = coverageState(result.slotStates, 'frequency_severity');
  assert.equal(state?.value.facets.frequency.status, 'partial');
  assert.equal(state?.value.facets.severity_example.status, 'missing');
  assert.equal(result.nextQuestion?.policyType, 'goal_space_clarify');
  assert.equal(result.nextQuestion?.targetFacetId, 'severity_example');
}

function testSubstantiveEpisodeAnswer() {
  const base = emptySnapshot('S-SUBSTANTIVE-EPISODE');
  const question = coverageQuestion('current_manifestations', 'recent_episode');
  const answer = '他把作业本撕了，老师把他带出教室。';
  assert.equal(isAnswerRelevantToQuestion(answer, question), true);
  const result = handleTurn(base, { speakerRole: 'guardian', answerText: answer, currentQuestion: question });
  assert.equal(
    coverageState(result.slotStates, 'current_manifestations')?.value.facets.recent_episode.status,
    'filled',
  );
  assert.notEqual(result.nextQuestion?.policyType, 'goal_space_clarify');
}

function testOffTopicAnswer() {
  const units = createEvidenceUnits({
    sessionId: 'S-OFF-TOPIC',
    turnNo: 2,
    text: '今天天气挺好的。',
    speakerRole: 'guardian',
    complaintIds: ['generic_behavioral_health'],
    currentQuestion: coverageQuestion('onset_course'),
  });
  assert.equal(units.some((unit) => unit.slotId === 'onset_course'), false);
}

function testDeniedEvidencePolarity() {
  const units = createEvidenceUnits({
    sessionId: 'S-EVIDENCE-DENIED',
    turnNo: 2,
    text: '没有',
    speakerRole: 'guardian',
    complaintIds: ['mood_anxiety_selfharm'],
    currentQuestion: {
      complaintId: 'mood_anxiety_selfharm',
      targetSlotOrIssue: 'self_harm_ideation',
      text: '最近有没有伤害自己的想法？',
    },
  });
  const target = units.find((unit) => unit.slotId === 'safety_clues');
  assert.ok(target);
  assert.equal(target.domain, COVERAGE_DOMAIN);
  assert.equal(target.polarity, 'absent');
}

function testAffirmedEvidencePolarity() {
  const units = createEvidenceUnits({
    sessionId: 'S-EVIDENCE-PRESENT',
    turnNo: 2,
    text: '孩子最近说不想活。',
    speakerRole: 'guardian',
    complaintIds: ['mood_anxiety_selfharm'],
    currentQuestion: coverageQuestion('safety_clues'),
  });
  const target = units.find((unit) => unit.slotId === 'safety_clues');
  assert.ok(target);
  assert.equal(target.polarity, 'present');
}

function testMixedSafetyPolarity() {
  const base = emptySnapshot('S-MIXED-SAFETY');
  const answer = '没有不想活，但是会打自己。';
  const units = createEvidenceUnits({
    sessionId: base.session.sessionId,
    turnNo: 1,
    text: answer,
    speakerRole: 'guardian',
    currentQuestion: coverageQuestion('safety_clues', 'current_safety_status'),
  });
  const safetyEvidence = units.find((unit) => unit.slotId === 'safety_clues');
  assert.equal(safetyEvidence?.polarity, 'present');
  assert.equal(safetyEvidence?.value.facetPolarities.current_safety_status, 'present');
  assert.equal(safetyEvidence?.value.facetPolarities.self_harm_or_suicide, 'present');
  const state = coverageState(updateSlotStates(base, [], units), 'safety_clues');
  assert.equal(state?.value.facets.current_safety_status.polarity, 'present');
  assert.equal(findRiskSignals(answer, base.session.sessionId, 1, 'guardian').some(
    (signal) => signal.signalType === 'self_harm',
  ), true);
}

function testHistoricalSafetyWithCurrentDenial() {
  const base = emptySnapshot('S-HISTORICAL-SAFETY-CURRENT-DENIAL');
  const answer = '半年前说过不想活，但现在没有了。';
  const units = createEvidenceUnits({
    sessionId: base.session.sessionId,
    turnNo: 1,
    text: answer,
    speakerRole: 'guardian',
    currentQuestion: coverageQuestion('safety_clues', 'current_safety_status'),
  });
  const evidence = units.find((item) => item.slotId === 'safety_clues');
  assert.equal(evidence?.value.facetPolarities.current_safety_status, 'absent');
  assert.equal(evidence?.value.facetPolarities.self_harm_or_suicide, 'present');
  assert.equal(evidence?.polarity, 'present', 'historical safety evidence must remain available for review');
  const state = coverageState(updateSlotStates(base, [], units), 'safety_clues');
  assert.equal(state?.value.facets.current_safety_status.value, false);
  assert.equal(state?.value.facets.self_harm_or_suicide.value, true);
  assert.equal(findRiskSignals(answer, base.session.sessionId, 1, 'guardian').length > 0, true);
}

function testUniversalCoverage() {
  for (const complaintId of ['mood_anxiety_selfharm', 'school_refusal', 'generic_behavioral_health']) {
    const snapshot = emptySnapshot(`S-COVERAGE-${complaintId}`);
    const slotStates = updateSlotStates(snapshot, [complaintId], []);
    const progress = computeProgress(slotStates, [complaintId]);
    assert.equal(progress.requiredTotal, intakeCoverageDomains.length);
    assert.equal(progress.requiredTotal, 14);
    assert.equal(progress.requiredFilled, 0);
    assert.equal(findGaps(slotStates, [complaintId]).length, 18);
    assert.ok(findGaps(slotStates, [complaintId]).every((gap) => gap.facetId && gap.facetLabel));
    assert.ok(slotStates.every((state) => state.complaintId === COVERAGE_DOMAIN));
  }
}

function testComplaintTagsAreNotAQuestionBoundary() {
  const tags = mapComplaints('孩子多动、刻板，情绪低又常发脾气，最近还不想上学。');
  assert.ok(tags.length >= 5, `expected at least five internal tags, got ${tags.join(', ')}`);
  assert.equal(tags.includes('generic_behavioral_health'), false);
}

function testOpeningNarrative() {
  const units = createEvidenceUnits({
    sessionId: 'S-OPENING',
    turnNo: 1,
    text: '孩子最近一到学校就哭，不愿意进教室。',
    speakerRole: 'guardian',
    complaintIds: ['school_refusal'],
    currentQuestion: null,
  });
  assert.ok(units.some((unit) => unit.domain === COVERAGE_DOMAIN && unit.slotId === 'presenting_problem'));
}

function testPartialEvidenceRemainsGap() {
  const base = emptySnapshot('S-PARTIAL-GAP');
  const slotStates = updateSlotStates(base, [], [evidence({
    evidenceId: 'E-PARTIAL-GAP',
    sessionId: base.session.sessionId,
    slotId: 'functional_impact',
    text: '提到学习可能有影响。',
    confidence: 0.74,
  })]);
  assert.equal(coverageState(slotStates, 'functional_impact')?.status, 'partial');
  assert.ok(findGaps(slotStates, []).some((gap) => gap.slotId === 'functional_impact' && gap.status === 'partial'));
  assert.equal(computeProgress(slotStates, []).requiredFilled, 0);
}

function testConflictingEvidence() {
  const snapshot = emptySnapshot('S-CONFLICT');
  const firstEvidence = evidence({
    evidenceId: 'E-CONFLICT-PRESENT',
    sessionId: snapshot.session.sessionId,
    slotId: 'safety_clues',
    polarity: 'present',
    text: '患儿本人说出现过伤害自己的想法。',
    source: 'child_self_report',
    speakerRole: 'child',
  });
  const first = updateSlotStates(snapshot, [], [firstEvidence]);
  const second = updateSlotStates(
    { ...snapshot, slotStates: first, evidenceUnits: [firstEvidence] },
    [],
    [evidence({
      evidenceId: 'E-CONFLICT-ABSENT',
      sessionId: snapshot.session.sessionId,
      slotId: 'safety_clues',
      polarity: 'absent',
      text: '家长否认出现过伤害自己的想法。',
    })],
  );
  const state = coverageState(second, 'safety_clues');
  assert.equal(state?.status, 'conflict');
  assert.equal(state?.value.observations.length, 2);
  assert.deepEqual(new Set(state?.value.observations.map((item) => item.source)), new Set(['child_self_report', 'parent_report']));
}

function testAmbiguousQuantifiedEvidence() {
  const snapshot = emptySnapshot('S-AMBIGUOUS');
  const first = updateSlotStates(snapshot, [], [evidence({
    evidenceId: 'E-FREQUENCY-ONE', sessionId: snapshot.session.sessionId, slotId: 'frequency_severity', text: '一周一次。',
  })]);
  const second = updateSlotStates({ ...snapshot, slotStates: first }, [], [evidence({
    evidenceId: 'E-FREQUENCY-THREE', sessionId: snapshot.session.sessionId, slotId: 'frequency_severity', text: '一周三次。',
  })]);
  assert.equal(coverageState(second, 'frequency_severity')?.status, 'ambiguous');
}

function testNoConfidenceDowngrade() {
  const snapshot = emptySnapshot('S-NO-DOWNGRADE');
  const first = updateSlotStates(snapshot, [], [evidence({
    evidenceId: 'E-HIGH', sessionId: snapshot.session.sessionId, slotId: 'triggers_context', text: '被批评时最明显。', confidence: 0.9,
  })]);
  const second = updateSlotStates({ ...snapshot, slotStates: first }, [], [evidence({
    evidenceId: 'E-LOW', sessionId: snapshot.session.sessionId, slotId: 'triggers_context', text: '有时可能和游戏有关。', confidence: 0.55,
  })]);
  const state = coverageState(second, 'triggers_context');
  assert.equal(state?.status, 'filled');
  assert.equal(state?.value.facets.trigger_pattern.rawValue, '被批评时最明显。');
  assert.equal(state?.value.facets.trigger_pattern.selectedEvidenceId, 'E-HIGH');
}

function testLegacySlotStateMigration() {
  const snapshot = emptySnapshot('S-LEGACY-SLOT');
  snapshot.slotStates = [{
    sessionId: snapshot.session.sessionId,
    complaintId: COVERAGE_DOMAIN,
    slotId: 'onset_course',
    label: '起始与变化过程',
    status: 'filled',
    value: { text: '半年前开始，最近加重。', polarity: 'present' },
    evidenceIds: ['E-LEGACY'],
    updatedAt: 1,
  }];
  assert.equal(findGaps(snapshot.slotStates, []).some((gap) => gap.slotId === 'onset_course'), false);
  const migrated = updateSlotStates(snapshot, [], []);
  const state = coverageState(migrated, 'onset_course');
  assert.equal(state?.value.facets.onset_time.status, 'filled');
  assert.equal(state?.value.facets.course_pattern.status, 'filled');
}

function testLegacySingleFacetMigration() {
  const snapshot = emptySnapshot('S-LEGACY-SINGLE-FACET');
  snapshot.slotStates = [{
    sessionId: snapshot.session.sessionId,
    complaintId: COVERAGE_DOMAIN,
    slotId: 'frequency_severity',
    label: '频率、持续与程度',
    status: 'filled',
    value: { text: '每天一次。', polarity: 'present' },
    evidenceIds: ['E-LEGACY-FREQUENCY'],
    updatedAt: 1,
  }];
  const migrated = updateSlotStates(snapshot, [], []);
  const state = coverageState(migrated, 'frequency_severity');
  assert.equal(state?.status, 'partial');
  assert.equal(state?.value.facets.frequency.status, 'filled');
  assert.equal(state?.value.facets.severity_example.status, 'missing');
  assert.ok(findGaps(migrated, []).some((gap) => (
    gap.slotId === 'frequency_severity' && gap.facetId === 'severity_example'
  )));
}

function testLegacyNonEvidenceResolution() {
  const snapshot = emptySnapshot('S-LEGACY-DECLINED');
  snapshot.slotStates = [{
    sessionId: snapshot.session.sessionId,
    complaintId: COVERAGE_DOMAIN,
    slotId: 'onset_course',
    label: '起始与变化过程',
    status: 'declined',
    value: null,
    evidenceIds: [],
    updatedAt: 1,
  }];
  const migrated = updateSlotStates(snapshot, [], []);
  const state = coverageState(migrated, 'onset_course');
  assert.equal(state?.status, 'filled');
  assert.equal(state?.value.facets.onset_time.status, 'declined');
  assert.equal(state?.value.facets.course_pattern.status, 'declined');
  assert.equal(findGaps(migrated, []).some((gap) => gap.slotId === 'onset_course'), false);
}

function testLegacyProgressConsistency() {
  const snapshot = emptySnapshot('S-LEGACY-PROGRESS');
  snapshot.slotStates = [{
    sessionId: snapshot.session.sessionId,
    complaintId: COVERAGE_DOMAIN,
    slotId: 'frequency_severity',
    label: '频率、持续与程度',
    status: 'filled',
    value: { text: '每天一次。', polarity: 'present' },
    evidenceIds: ['E-LEGACY-FREQUENCY-PROGRESS'],
    updatedAt: 1,
  }];
  assert.equal(computeProgress(snapshot.slotStates, []).requiredFilled, 0);
  assert.ok(findGaps(snapshot.slotStates, []).some((gap) => (
    gap.slotId === 'frequency_severity' && gap.facetId === 'severity_example'
  )));
}

function testClosedEnumNormalization() {
  const base = emptySnapshot('S-ENUM-NORMALIZATION');
  const worsening = {
    ...evidence({
      evidenceId: 'E-COURSE-WORSENING',
      sessionId: base.session.sessionId,
      slotId: 'onset_course',
      text: '最近越来越严重。',
    }),
    facetIds: ['course_pattern'],
    value: { text: '最近越来越严重。', facetIds: ['course_pattern'] },
  };
  const normalized = updateSlotStates(base, [], [worsening]);
  const normalizedFacet = coverageState(normalized, 'onset_course')?.value.facets.course_pattern;
  assert.equal(normalizedFacet?.status, 'filled');
  assert.equal(normalizedFacet?.value, 'worsening');
  assert.match(normalizedFacet?.rawValue, /越来越严重/);

  const invalidBase = emptySnapshot('S-ENUM-INVALID');
  const invalid = {
    ...evidence({
      evidenceId: 'E-COURSE-INVALID',
      sessionId: invalidBase.session.sessionId,
      slotId: 'onset_course',
      text: '像一条线。',
    }),
    facetIds: ['course_pattern'],
    value: { text: '像一条线。', facetIds: ['course_pattern'] },
  };
  const invalidFacet = coverageState(
    updateSlotStates(invalidBase, [], [invalid]),
    'onset_course',
  )?.value.facets.course_pattern;
  assert.equal(invalidFacet?.status, 'partial');
  assert.equal(invalidFacet?.value, null);
  assert.match(invalidFacet?.rawValue, /像一条线/);
}

function testCourseEnumBoundaries() {
  const question = coverageQuestion('onset_course', 'course_pattern');
  for (const answer of ['差不多。', '变多了。', '不清楚。']) {
    assert.equal(isAnswerRelevantToQuestion(answer, question), true, answer);
  }

  const stableBase = emptySnapshot('S-COURSE-STABLE');
  const stable = handleTurn(stableBase, {
    speakerRole: 'guardian',
    answerText: '基本没变。',
    currentQuestion: question,
  });
  const stableFacet = coverageState(stable.slotStates, 'onset_course')?.value.facets.course_pattern;
  assert.equal(stableFacet?.status, 'filled');
  assert.equal(stableFacet?.value, 'stable');
  assert.equal(stableFacet?.polarity, 'present');

  const mixedBase = emptySnapshot('S-COURSE-MIXED');
  const mixed = handleTurn(mixedBase, {
    speakerRole: 'guardian',
    answerText: '开始加重，后来好转。',
    currentQuestion: question,
  });
  const mixedFacet = coverageState(mixed.slotStates, 'onset_course')?.value.facets.course_pattern;
  assert.equal(mixedFacet?.status, 'ambiguous');
  assert.equal(mixedFacet?.value, null);
  assert.equal(mixedFacet?.normalizationIssue, 'multiple_enum_values');

  const settingsBase = emptySnapshot('S-CROSS-SETTING-MIXED');
  const settings = handleTurn(settingsBase, {
    speakerRole: 'guardian',
    answerText: '在家和学校明显不同。',
    currentQuestion: coverageQuestion('settings_and_sources', 'cross_setting_pattern'),
  });
  assert.equal(
    coverageState(settings.slotStates, 'settings_and_sources')?.value.facets.cross_setting_pattern.value,
    'mixed',
  );
}

function testRiskAdaptivePriority() {
  const base = emptySnapshot('S-RISK-PRIORITY');
  const slotStates = updateSlotStates(base, [], []);
  const plan = planNextQuestion({
    snapshot: base,
    complaintIds: ['generic_behavioral_health'],
    slotStates,
    progress: computeProgress(slotStates, []),
    riskSignals: [{ status: 'open', signalType: 'suicide' }],
    latestAnswer: '孩子说过不想活。',
    speakerRole: 'guardian',
  });
  assert.equal(plan.nextAction, 'ask');
  assert.equal(plan.selected?.targetSlotOrIssue, 'safety_clues');
  assert.equal(plan.selected?.isCriticalRisk, true);
  assert.equal((plan.selected?.candidateQuestion.match(/[？?]/g) ?? []).length, 1);
}

function testRiskInterruptsRuleClarification() {
  const base = emptySnapshot('S-RISK-INTERRUPT');
  const result = handleTurn(base, {
    speakerRole: 'child',
    answerText: '我现在想死。',
    currentQuestion: coverageQuestion('onset_course', 'onset_time'),
  });

  assert.equal(result.status, 'needs_clinician_review');
  assert.equal(result.nextQuestion?.targetSlotOrIssue, 'safety_clues');
  assert.notEqual(result.nextQuestion?.policyType, 'goal_space_clarify');
  assert.equal(result.nextQuestion?.isCriticalRisk, true);
}

function testAdaptiveOrderUsesLatestAnswer() {
  const base = emptySnapshot('S-ADAPTIVE-ORDER');
  const slotStates = updateSlotStates(base, [], []);
  const selectFor = (latestAnswer) => planNextQuestion({
    snapshot: base,
    complaintIds: [],
    slotStates,
    progress: computeProgress(slotStates, []),
    riskSignals: [],
    latestAnswer,
  }).selected?.targetSlotOrIssue;
  assert.equal(selectFor('老师说只在学校明显。'), 'settings_and_sources');
  assert.equal(selectFor('搬家换老师以后更明显。'), 'triggers_context');
  assert.equal(selectFor('以前去医院做过评估。'), 'prior_help_treatment');
}

function testNoNormalTurnCap() {
  const base = emptySnapshot('S-NO-NORMAL-CAP');
  const slotStates = updateSlotStates(base, [], []);
  const snapshot = {
    ...base,
    turns: Array.from({ length: 7 }, (_, index) => ({ turnNo: index + 1, speakerRole: 'guardian' })),
  };
  const plan = planNextQuestion({
    snapshot,
    complaintIds: [],
    slotStates,
    progress: computeProgress(slotStates, []),
    riskSignals: [],
  });
  assert.equal(plan.nextAction, 'ask');
}

function testAttemptExhaustionCompletion() {
  const base = emptySnapshot('S-ATTEMPT-EXHAUSTION');
  const slotStates = updateSlotStates(base, [], []);
  let turnNo = 0;
  const decisionLogs = intakeContracts.flatMap((contract) => contract.requiredFacets.flatMap((facetId) => {
    const question = coverageQuestion(contract.slotId, facetId);
    return [
      decisionLogForQuestion(turnNo += 1, question),
      decisionLogForQuestion(turnNo += 1, question),
    ];
  }));
  const plan = planNextQuestion({
    snapshot: { ...base, decisionLogs },
    complaintIds: [],
    slotStates,
    progress: computeProgress(slotStates, []),
    riskSignals: [],
  });
  assert.equal(plan.nextAction, 'complete');
  assert.match(plan.reason, /已尝试/);
}

function testLegacyAttemptScoping() {
  const base = emptySnapshot('S-LEGACY-ATTEMPT-SCOPE');
  const slotStates = updateSlotStates(base, [], []);
  const legacyQuestion = {
    complaintId: COVERAGE_DOMAIN,
    targetSlotOrIssue: 'onset_course',
    text: intakeCoverageDomains.find((item) => item.slotId === 'onset_course').question,
  };
  const plan = planNextQuestion({
    snapshot: {
      ...base,
      decisionLogs: [
        decisionLogForQuestion(1, legacyQuestion),
        decisionLogForQuestion(2, legacyQuestion),
      ],
    },
    complaintIds: [],
    slotStates,
    progress: computeProgress(slotStates, []),
    riskSignals: [],
  });
  const onset = plan.candidates.filter((candidate) => candidate.targetSlotOrIssue === 'onset_course');
  assert.equal(onset.find((candidate) => candidate.targetFacetId === 'onset_time')?.askedCount, 2);
  assert.equal(onset.find((candidate) => candidate.targetFacetId === 'course_pattern')?.askedCount, 0);
  assert.equal(plan.rejected.some((candidate) => (
    candidate.targetSlotOrIssue === 'onset_course'
      && candidate.targetFacetId === 'course_pattern'
      && /已尝试/.test(candidate.rejectedReason ?? '')
  )), false);
}

function testHardSafetyCap() {
  const base = emptySnapshot('S-HARD-CAP');
  const slotStates = updateSlotStates(base, [], []);
  const snapshot = {
    ...base,
    turns: Array.from({ length: 24 }, (_, index) => ({ turnNo: index + 1, speakerRole: 'guardian' })),
  };
  const plan = planNextQuestion({
    snapshot,
    complaintIds: [],
    slotStates,
    progress: computeProgress(slotStates, []),
    riskSignals: [],
  });
  assert.equal(plan.nextAction, 'complete');
  assert.match(plan.reason, /24轮安全上限/);
}

function testCoverageCompletion() {
  const base = emptySnapshot('S-COMPLETE');
  let index = 0;
  const normalizedExamples = {
    course_pattern: '最近越来越严重。',
    cross_setting_pattern: '在家和学校都一样。',
    impact_presence: '确实有影响。',
    help_received: '以前看过医生。',
    current_safety_status: '目前有需要医生核实的安全情况。',
  };
  const allEvidence = intakeContracts.flatMap((contract) => contract.requiredFacets.map((facetId) => {
    const text = normalizedExamples[facetId] ?? `${facetId}已有具体信息。`;
    return {
      ...evidence({
        evidenceId: `E-COMPLETE-${index += 1}`,
        sessionId: base.session.sessionId,
        slotId: contract.slotId,
        text,
      }),
      facetIds: [facetId],
      value: { text, facetIds: [facetId] },
    };
  }));
  const slotStates = updateSlotStates(base, [], allEvidence);
  const plan = planNextQuestion({
    snapshot: base,
    complaintIds: [],
    slotStates,
    progress: computeProgress(slotStates, []),
    riskSignals: [],
  });
  assert.equal(computeProgress(slotStates, []).percent, 100);
  assert.equal(plan.nextAction, 'complete');
  assert.match(plan.reason, /覆盖域已完成/);
}

function testSingleQuestionBoundary() {
  for (const contract of intakeContracts) {
    for (const facetId of contract.requiredFacets) {
      if (contract.slotId === 'safety_clues') continue;
      const target = buildDynamicGoal(dynamicRule(contract.slotId, facetId));
      for (const speakerRole of ['guardian', 'child']) {
        const question = realizeGoalFallback(target, { speakerRole });
        assert.equal((question.match(/[？?]/g) ?? []).length, 1, `${contract.slotId}:${facetId}:${speakerRole}`);
      }
    }
  }
}

function testGuardianImpactQuestion() {
  const contract = getIntakeContract('functional_impact');
  const question = rewriteQuestion({
    policyType: 'adaptive_coverage',
    complaintId: COVERAGE_DOMAIN,
    targetSlotOrIssue: 'functional_impact',
    targetFacetId: 'impact_presence',
    label: contract.label,
    facetLabel: contract.facets.find((facet) => facet.facetId === 'impact_presence').label,
  }, { respondent: 'guardian' }, {
    session: { chiefComplaint: '孩子最近睡不好。' },
    turns: [],
  });
  assert.match(question.text, /影响/);
  assert.doesNotMatch(question.text, /还有没有明显变化/);
}

function testChildQuestionSelection() {
  const base = emptySnapshot('S-CHILD');
  base.session.profile = { respondent: 'child', age: 11 };
  const slotStates = updateSlotStates(base, [], []);
  const plan = planNextQuestion({
    snapshot: base,
    complaintIds: [],
    slotStates,
    progress: computeProgress(slotStates, []),
    riskSignals: [],
    latestAnswer: '我最近总是不想去学校。',
    speakerRole: 'child',
  });
  assert.equal(plan.nextAction, 'ask');
  assert.ok(plan.selected?.informationGoal);
  assert.ok(plan.selected?.minimumEvidence);
  assert.equal(Object.hasOwn(plan.selected, 'candidateQuestion'), false);
  const question = rewriteQuestion(plan.selected, base.session.profile, base, 'child');
  assert.ok(question?.text);
  assert.equal(question.text.includes('您'), false);
}

function testSpeakerRoleIsAuthoritative() {
  const base = emptySnapshot('S-SPEAKER-ROLE-AUTHORITY');
  base.session.profile = { respondent: 'child', age: 11 };
  const result = handleTurn(base, {
    speakerRole: 'guardian',
    answerText: '孩子刚才说他不想活了。',
    currentQuestion: null,
  });
  assert.equal(result.dialogueTurn.speakerRole, 'guardian');
  assert.equal(result.nextQuestion?.audience, 'guardian');
  assert.doesNotMatch(result.nextQuestion?.text ?? '', /^你|你刚才|你现在/);
  assert.match(result.nextQuestion?.text ?? '', /孩子|您/);
}

function testChildClarification() {
  const base = emptySnapshot('S-CHILD-CLARIFY');
  base.session.profile = { respondent: 'child', age: 11 };
  const domain = intakeCoverageDomains.find((item) => item.slotId === 'onset_course');
  const currentQuestion = {
    policyType: 'adaptive_coverage',
    complaintId: COVERAGE_DOMAIN,
    targetSlotOrIssue: domain.slotId,
    label: domain.label,
    targetFacetId: 'onset_time',
    facetLabel: '大致开始时间',
    text: realizeGoalFallback(dynamicRule('onset_course', 'onset_time'), { speakerRole: 'child' }),
    audience: 'child',
  };
  const result = handleTurn(base, {
    speakerRole: 'child',
    answerText: '我昨天吃了面条',
    currentQuestion,
  });

  assert.equal(result.nextQuestion?.policyType, 'goal_space_clarify');
  assert.equal(result.nextQuestion?.targetSlotOrIssue, 'onset_course');
  assert.notEqual(result.nextQuestion?.text, currentQuestion.text);
  assert.equal(/您|孩子|家长/.test(result.nextQuestion?.text ?? ''), false);
  assert.equal(result.dialogueTurn.speakerRole, 'child');
  assert.ok(result.evidenceUnits.every((unit) => unit.source === 'child_self_report'));
}

function testDynamicTargetBoundary() {
  const ruleNextQuestion = dynamicRule('onset_course');
  const sleepGap = dynamicRule('sleep_appetite_physical');
  const askSleep = dynamicOutput('sleep_appetite_physical', '最近睡眠有什么变化？');

  assert.equal(validateDynamicSelection({
    output: { next_action: 'complete' },
    gaps: [sleepGap],
    ruleNextQuestion,
  }).ok, false);
  assert.equal(validateDynamicSelection({
    output: { ...askSleep, complaint_id: 'invented_domain', target_slot_or_issue: 'invented_slot' },
    gaps: [sleepGap],
    ruleNextQuestion,
  }).ok, false);
  assert.equal(validateDynamicSelection({
    output: askSleep,
    gaps: [sleepGap],
    candidates: [sleepGap],
    ruleNextQuestion,
  }).ok, true, 'model may switch to another allowed safe candidate');
  assert.equal(validateDynamicSelection({
    output: dynamicOutput('onset_course', '孩子最近每晚几点睡着？', 'onset_time'),
    ruleNextQuestion,
  }).ok, false, 'matching IDs cannot hide a question about the wrong facet');
  assert.equal(validateDynamicSelection({
    output: dynamicOutput('onset_course', '赶紧带孩子去急诊好吗？', 'onset_time'),
    ruleNextQuestion,
  }).ok, false, 'disposition language is rejected for every facet');
  assert.equal(validateDynamicSelection({
    output: dynamicOutput('onset_course', '你大概从什么时候开始有这个烦恼？', 'onset_time'),
    ruleNextQuestion,
    speakerRole: 'guardian',
  }).ok, false, 'guardian questions cannot use child-directed pronouns');
  assert.equal(validateDynamicSelection({
    output: dynamicOutput('onset_course', `${'这个情况大概从什么时候开始'.padEnd(81, '呢')}？`, 'onset_time'),
    ruleNextQuestion,
  }).ok, false, 'dynamic questions cannot exceed the 80-character contract');
  assert.equal(validateDynamicSelection({
    output: askSleep,
    gaps: [sleepGap],
    candidates: [sleepGap],
    rejectedCandidates: [{ ...sleepGap, rejectedReason: '该信息域已尝试澄清但仍无法补齐' }],
    ruleNextQuestion,
  }).ok, false);
  assert.equal(validateDynamicSelection({
    output: dynamicOutput('functional_impact', '孩子最近上学是几点到校？'),
    ruleNextQuestion: dynamicRule('functional_impact'),
  }).ok, false, 'a setting word alone cannot satisfy the impact facet');
  assert.equal(validateDynamicSelection({
    output: dynamicOutput('prior_help_treatment', '现在谁能帮助孩子？'),
    ruleNextQuestion: dynamicRule('prior_help_treatment'),
  }).ok, false, 'current support cannot masquerade as prior help');
  assert.equal(validateDynamicSelection({
    output: dynamicOutput('goals_expectations', '以前接受过哪些帮助？'),
    ruleNextQuestion: dynamicRule('goals_expectations'),
  }).ok, false, 'prior help cannot masquerade as a current goal');
}

function testDynamicSafetyBoundary() {
  const safetyRule = { ...dynamicRule('safety_clues'), isCriticalRisk: true };
  const sleepGap = dynamicRule('sleep_appetite_physical');
  assert.equal(validateDynamicSelection({
    output: dynamicOutput('sleep_appetite_physical', '最近睡眠有什么变化？'),
    gaps: [sleepGap],
    ruleNextQuestion: safetyRule,
  }).ok, false);
  assert.equal(validateDynamicSelection({
    output: dynamicOutput('safety_clues', '最近睡眠有什么变化？'),
    ruleNextQuestion: safetyRule,
  }).ok, false);
  assert.equal(validateDynamicSelection({
    output: dynamicOutput('safety_clues', '孩子最近的行为有什么变化？'),
    ruleNextQuestion: safetyRule,
  }).ok, false);
  assert.equal(validateDynamicSelection({
    output: dynamicOutput('safety_clues', '是否需要立即报警或送急诊？'),
    ruleNextQuestion: safetyRule,
  }).ok, false);
  assert.equal(validateDynamicSelection({
    output: dynamicOutput('safety_clues', '孩子自伤后请立刻陪他就医好吗？'),
    ruleNextQuestion: safetyRule,
  }).ok, false);
  assert.equal(validateDynamicSelection({
    output: dynamicOutput('safety_clues', '孩子五年前有没有伤害自己？'),
    ruleNextQuestion: safetyRule,
  }).ok, false, 'current safety requires a current or recent time frame');
  assert.equal(validateDynamicSelection({
    output: dynamicOutput('safety_clues', '孩子现在还有伤害自己的想法或行为吗？'),
    ruleNextQuestion: safetyRule,
  }).ok, false, 'safety questions remain deterministic even when model wording looks acceptable');
  assert.equal(validateDynamicSelection({
    output: dynamicOutput('safety_clues', '孩子现在可以通过自伤来缓解情绪吗？'),
    ruleNextQuestion: safetyRule,
  }).ok, false, 'dangerous normalization of self-harm cannot be phrased as a question');
}

function testDynamicChildLanguageBoundary() {
  const ruleNextQuestion = dynamicRule('current_manifestations');
  assert.equal(validateDynamicSelection({
    output: dynamicOutput('current_manifestations', '您能说说孩子最近一次的表现吗？'),
    ruleNextQuestion,
    speakerRole: 'child',
  }).ok, false);
  assert.equal(validateDynamicSelection({
    output: dynamicOutput('current_manifestations', '你能说说最近一次发生了什么吗？'),
    ruleNextQuestion,
    speakerRole: 'child',
  }).ok, true);
  assert.equal(validateDynamicSelection({
    output: dynamicOutput('current_manifestations', '妈妈能说说宝宝具体做了什么吗？'),
    ruleNextQuestion,
    speakerRole: 'child',
  }).ok, false);
  assert.equal(validateDynamicSelection({
    output: dynamicOutput('onset_course', '他这种情况大概什么时候开始？', 'onset_time'),
    ruleNextQuestion: dynamicRule('onset_course', 'onset_time'),
    speakerRole: 'child',
  }).ok, false, 'child questions cannot address the respondent in the third person');
}

function testRequiredFallbackBoundaryAlignment() {
  for (const contract of intakeContracts) {
    if (contract.slotId === 'safety_clues') continue;
    for (const facetId of contract.requiredFacets) {
      for (const speakerRole of ['guardian', 'child']) {
        const target = buildDynamicGoal(dynamicRule(contract.slotId, facetId));
        const question = realizeGoalFallback(target, { speakerRole });
        assert.ok(question, `${contract.slotId}:${facetId}:${speakerRole} goal realization missing`);
        assert.equal(validateQuestionForTarget({ question, target, speakerRole }).ok, true,
          `${contract.slotId}:${facetId}:${speakerRole} goal realization rejected`);
      }
    }
  }

  assert.equal(validateQuestionForTarget({
    question: '和刚开始时相比，这种情况最近有什么变化吗？',
    target: dynamicRule('onset_course', 'course_pattern'),
    speakerRole: 'guardian',
  }).ok, true, 'a natural time-comparison question should satisfy course pattern');
  assert.equal(validateQuestionForTarget({
    question: '孩子和以前有什么不同？',
    target: dynamicRule('settings_and_sources', 'cross_setting_pattern'),
    speakerRole: 'guardian',
  }).ok, false, 'cross-setting goals require an explicit setting comparison');
}

function testNaturalCoursePatternBoundary() {
  const target = dynamicRule('onset_course', 'course_pattern');
  const accepted = [
    '您觉得这种情况最近有什么变化吗？',
    '和刚开始时相比，这种情况有什么不一样吗？',
    '孩子最近这个情况怎么样了？',
  ];
  for (const question of accepted) {
    assert.equal(validateQuestionForTarget({
      question,
      target,
      speakerRole: 'guardian',
    }).ok, true, 'natural course question rejected');
  }
  assert.equal(validateQuestionForTarget({
    question: '这种情况大概是什么时候开始的？',
    target,
    speakerRole: 'guardian',
  }).ok, false, 'an onset-time question must not satisfy course pattern');
  assert.equal(validateQuestionForTarget({
    question: '最近是越来越严重，还是差不多？',
    target,
    speakerRole: 'guardian',
  }).ok, false, 'the first course question must not be a forced-choice question');
  assert.equal(validateQuestionForTarget({
    question: '最近是更明显了，还是和以前差不多？',
    target: { ...target, askedCount: 1 },
    speakerRole: 'guardian',
  }).ok, true, 'a second clarification may offer no more than two simple anchors');
}

function testClarificationLimit() {
  const currentQuestion = coverageQuestion('presenting_problem');
  const base = emptySnapshot('S-CLARIFICATION-LIMIT');
  const snapshot = {
    ...base,
    turns: [
      { turnNo: 1, speakerRole: 'guardian', answerText: '说不清楚' },
      { turnNo: 2, speakerRole: 'guardian', answerText: '不知道' },
    ],
    decisionLogs: [
      decisionLogForQuestion(1, currentQuestion),
      decisionLogForQuestion(2, currentQuestion),
    ],
  };
  const result = handleTurn(snapshot, {
    speakerRole: 'guardian',
    answerText: '还是不知道',
    currentQuestion,
  });
  assert.notEqual(result.nextQuestion?.policyType, 'goal_space_clarify');
  assert.notEqual(result.nextQuestion?.targetFacetId, currentQuestion.targetFacetId);
}

function testFullGapAudit() {
  const base = emptySnapshot('S-FULL-GAPS');
  const result = handleTurn(base, {
    speakerRole: 'guardian',
    answerText: '孩子最近不太对劲。',
    currentQuestion: null,
  });
  const gaps = result.decisionLog.stateSummary.gaps;
  assert.deepEqual(gaps, findGaps(result.slotStates, result.mappedComplaints));
  assert.ok(gaps.every((gap) => gap.complaintId && gap.slotId && gap.facetId && gap.label && gap.facetLabel));
}

function testStructuredPacket() {
  const base = emptySnapshot('S-STRUCTURED-PACKET');
  const evidenceUnits = [
    evidence({ evidenceId: 'E-MAIN-PARENT', sessionId: base.session.sessionId, slotId: 'current_manifestations', text: '家长看到孩子每天早晨哭着拒绝上学。' }),
    evidence({ evidenceId: 'E-MAIN-CHILD', sessionId: base.session.sessionId, slotId: 'current_manifestations', text: '孩子说到校门口会害怕。', source: 'child_self_report', speakerRole: 'child' }),
    evidence({ evidenceId: 'E-COURSE', sessionId: base.session.sessionId, slotId: 'onset_course', text: '一个月前开始，最近加重。' }),
    evidence({ evidenceId: 'E-IMPACT', sessionId: base.session.sessionId, slotId: 'functional_impact', text: '最近两周缺课四天，学习受影响。' }),
    evidence({ evidenceId: 'E-CONTEXT', sessionId: base.session.sessionId, slotId: 'triggers_context', text: '换班主任后变得更明显。' }),
  ];
  const slotStates = updateSlotStates(base, ['school_refusal'], evidenceUnits);
  const riskSignals = findRiskSignals('孩子说过不想活。', base.session.sessionId, 3, 'guardian');
  const packet = generatePrevisitPacket({
    ...base,
    session: { ...base.session, chiefComplaint: '孩子最近哭着不愿上学', mappedComplaints: ['school_refusal'] },
    evidenceUnits,
    slotStates,
    riskSignals,
    packets: [],
  });
  const content = packet.content;
  for (const key of [
    'main_symptoms', 'course', 'functional_impact', 'background_context',
    'multi_source_differences', 'risk_notes', 'important_abnormalities',
    'missing_information', 'evidence_sources',
  ]) {
    assert.ok(Array.isArray(content[key]), `missing structured packet array: ${key}`);
  }
  assert.ok(content.summary.includes('缺课四天'));
  assert.ok(content.multi_source_differences.some((row) => row.slot_id === 'current_manifestations'));
  assert.ok(content.risk_notes.length > 0);
  assert.ok(content.important_abnormalities.some((row) => row.type === 'safety_signal'));
  assert.ok(content.missing_information.length > 0);
  assert.ok(content.evidence_sources.some((row) => row.source === 'child_self_report'));
  assert.equal(content.chief_complaint.tag_usage, 'internal_scan_only');
}

function testPacketPreservesFacetValues() {
  const base = emptySnapshot('S-PACKET-FACETS');
  const onsetEvidence = {
    ...evidence({
      evidenceId: 'E-PACKET-ONSET',
      sessionId: base.session.sessionId,
      slotId: 'onset_course',
      text: '半年前开始。',
    }),
    facetIds: ['onset_time'],
    value: { text: '半年前开始。', facetIds: ['onset_time'] },
  };
  const courseEvidence = {
    ...evidence({
      evidenceId: 'E-PACKET-COURSE',
      sessionId: base.session.sessionId,
      slotId: 'onset_course',
      text: '最近逐渐加重。',
    }),
    facetIds: ['course_pattern'],
    value: { text: '最近逐渐加重。', facetIds: ['course_pattern'] },
  };
  const firstStates = updateSlotStates(base, [], [onsetEvidence]);
  const slotStates = updateSlotStates(
    { ...base, slotStates: firstStates, evidenceUnits: [onsetEvidence] },
    [],
    [courseEvidence],
  );
  const packet = generatePrevisitPacket({
    ...base,
    slotStates,
    evidenceUnits: [onsetEvidence, courseEvidence],
  });
  const row = packet.content.course.find((item) => item.slot_id === 'onset_course');
  assert.equal(row.facet_values.length, 2);
  assert.match(row.value, /半年前开始/);
  assert.match(row.value, /最近逐渐加重/);
}

function testPacketIncludesOptionalFacetConflict() {
  const base = emptySnapshot('S-PACKET-OPTIONAL-CONFLICT');
  const unit = {
    ...evidence({
      evidenceId: 'E-PACKET-HEALTH-SUMMARY',
      sessionId: base.session.sessionId,
      slotId: 'sleep_appetite_physical',
      text: '睡眠和胃口最近有变化。',
    }),
    facetIds: ['health_change_summary'],
    value: { text: '睡眠和胃口最近有变化。', facetIds: ['health_change_summary'] },
  };
  const slotStates = updateSlotStates(base, [], [unit]);
  const healthState = coverageState(slotStates, 'sleep_appetite_physical');
  healthState.value.facets.appetite_change = {
    ...healthState.value.facets.appetite_change,
    status: 'conflict',
    value: 'decreased',
    evidenceIds: ['E-APPETITE-UP', 'E-APPETITE-DOWN'],
  };
  const packet = generatePrevisitPacket({
    ...base,
    slotStates,
    evidenceUnits: [unit],
  });
  const conflict = packet.content.conflicts_or_uncertainties.find((item) => (
    item.slot_id === 'sleep_appetite_physical'
  ));
  assert.ok(conflict);
  assert.equal(conflict.status, 'conflict');
  assert.ok(conflict.facet_conflicts.some((facet) => (
    facet.facet_id === 'appetite_change' && facet.status === 'conflict'
  )));
  assert.ok(packet.content.important_abnormalities.some((item) => (
    item.label === '睡眠、食欲与躯体情况' && item.type === 'conflict'
  )));
}

function testChildPacketReporter() {
  const base = emptySnapshot('S-CHILD-PACKET');
  base.session.profile = { respondent: 'child' };
  base.session.chiefComplaint = '我最近一到学校就害怕';
  const unit = evidence({
    evidenceId: 'E-CHILD-OPEN',
    sessionId: base.session.sessionId,
    slotId: 'presenting_problem',
    text: base.session.chiefComplaint,
    source: 'child_self_report',
    speakerRole: 'child',
  });
  const packet = generatePrevisitPacket({
    ...base,
    slotStates: updateSlotStates(base, [], [unit]),
    evidenceUnits: [unit],
    packets: [],
  });
  assert.match(packet.content.summary, /^患儿本人本次主要反映/);
}

function testNormalHistoryNotAbnormal() {
  const base = emptySnapshot('S-NORMAL-HISTORY');
  const units = [
    evidence({ evidenceId: 'E-NORMAL-SLEEP', sessionId: base.session.sessionId, slotId: 'sleep_appetite_physical', text: '睡眠食欲都正常，和平时一样。' }),
    evidence({ evidenceId: 'E-NORMAL-DEVELOPMENT', sessionId: base.session.sessionId, slotId: 'development_medical_history', text: '发育正常，没有重要病史。' }),
  ];
  const packet = generatePrevisitPacket({
    ...base,
    slotStates: updateSlotStates(base, [], units),
    evidenceUnits: units,
    packets: [],
  });
  assert.equal(packet.content.important_abnormalities.some((row) => /睡眠|发育/.test(row.label)), false);
}

function testReportedChangeIsImportant() {
  const base = emptySnapshot('S-ABNORMAL-HISTORY');
  const units = [
    evidence({ evidenceId: 'E-SLEEP-CHANGE', sessionId: base.session.sessionId, slotId: 'sleep_appetite_physical', text: '最近入睡困难，食欲下降。' }),
    evidence({ evidenceId: 'E-DEVELOPMENT-CHANGE', sessionId: base.session.sessionId, slotId: 'development_medical_history', text: '小时候语言发育迟缓。' }),
  ];
  const packet = generatePrevisitPacket({
    ...base,
    slotStates: updateSlotStates(base, [], units),
    evidenceUnits: units,
    packets: [],
  });
  assert.ok(packet.content.important_abnormalities.some((row) => row.label === '睡眠、食欲与躯体情况'));
  assert.ok(packet.content.important_abnormalities.some((row) => row.label === '发育与躯体健康史'));
}

function emptySnapshot(sessionId) {
  return {
    session: {
      sessionId,
      profile: {},
      selectedComplaints: [],
      mappedComplaints: [],
      chiefComplaint: '',
    },
    turns: [],
    slotStates: [],
    evidenceUnits: [],
    riskSignals: [],
    decisionLogs: [],
  };
}

function evidence({
  evidenceId,
  sessionId,
  slotId,
  polarity = 'present',
  text = '测试证据',
  confidence = 0.9,
  source = 'parent_report',
  speakerRole = 'guardian',
}) {
  return {
    evidenceId,
    sessionId,
    turnNo: 1,
    source,
    speakerRole,
    domain: COVERAGE_DOMAIN,
    slotId,
    timeScope: null,
    polarity,
    value: { text, reason: 'regression_test' },
    rawText: text,
    confidence,
    createdAt: 1,
  };
}

function coverageQuestion(slotId, requestedFacetId = null) {
  const domain = intakeCoverageDomains.find((item) => item.slotId === slotId);
  if (!domain) throw new Error(`unknown coverage slot: ${slotId}`);
  const contract = getIntakeContract(slotId);
  const targetFacetId = requestedFacetId ?? contract?.requiredFacets[0];
  return {
    policyType: 'adaptive_coverage',
    complaintId: COVERAGE_DOMAIN,
    targetSlotOrIssue: slotId,
    targetFacetId,
    label: domain.label,
    facetLabel: contract?.facets.find((facet) => facet.facetId === targetFacetId)?.label,
    text: realizeGoalFallback(buildDynamicGoal({
      complaintId: COVERAGE_DOMAIN,
      targetSlotOrIssue: slotId,
      targetFacetId,
      facetLabel: contract?.facets.find((facet) => facet.facetId === targetFacetId)?.label,
    }), { speakerRole: 'guardian' }),
  };
}

function dynamicRule(slotId, requestedFacetId = null) {
  const domain = intakeCoverageDomains.find((item) => item.slotId === slotId);
  const contract = getIntakeContract(slotId);
  const targetFacetId = requestedFacetId ?? contract?.requiredFacets[0];
  return {
    policyType: 'adaptive_coverage',
    complaintId: COVERAGE_DOMAIN,
    targetSlotOrIssue: slotId,
    targetFacetId,
    label: domain?.label ?? slotId,
    facetLabel: contract?.facets.find((facet) => facet.facetId === targetFacetId)?.label,
    text: realizeGoalFallback(buildDynamicGoal({
      complaintId: COVERAGE_DOMAIN,
      targetSlotOrIssue: slotId,
      targetFacetId,
      facetLabel: contract?.facets.find((facet) => facet.facetId === targetFacetId)?.label,
    }), { speakerRole: 'guardian' }) ?? '请继续说明？',
  };
}

function dynamicOutput(slotId, question, requestedFacetId = null) {
  const contract = getIntakeContract(slotId);
  return {
    next_action: 'ask',
    question,
    complaint_id: COVERAGE_DOMAIN,
    target_slot_or_issue: slotId,
    target_facet_id: requestedFacetId ?? contract?.requiredFacets[0] ?? '',
    reason: 'regression_test',
    confidence: 0.8,
  };
}

function coverageState(states, slotId) {
  return states.find((state) => state.complaintId === COVERAGE_DOMAIN && state.slotId === slotId);
}

function decisionLogForQuestion(turnNo, question) {
  return {
    turnNo,
    targetSlotOrIssue: question.targetSlotOrIssue,
    targetFacetId: question.targetFacetId,
    selectedAction: { nextAction: 'ask', nextQuestion: question },
  };
}
