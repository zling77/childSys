import assert from 'node:assert/strict';
import {
  DYNAMIC_QUESTION_CONTEXT_CAPS,
  compileDynamicQuestionContext,
} from '../core/llm/contextCompiler.mjs';

const baseInput = {
  currentQuestion: { id: 'q-7', text: '孩子最近一次到校门口时发生了什么？' },
  currentAnswer: '昨天到校门口就哭了，说肚子疼，最后由爸爸接回家。',
  selectedTargetFacet: {
    complaintId: 'school_refusal',
    slotId: 'current_manifestations',
    facetId: 'recent_episode',
    label: '最近一次具体经过',
    selectionReason: '当前回答给出了新近事件，但触发经过仍不完整',
  },
  activeConflicts: [{
    conflictId: 'conflict-1',
    facetId: 'attendance_2w',
    summary: '家长先说没有缺课，随后说昨天被接回家。',
    claimIds: ['claim-old', 'claim-new'],
  }],
  openDeterministicRisks: [{
    riskId: 'risk-1',
    signalType: 'self_harm',
    summary: '规则命中，等待直接核实。',
    triggerText: '不想活了',
    status: 'open',
  }, {
    riskId: 'risk-2',
    signalType: 'self_harm',
    triggerText: '同一段很长的原始回答不应在每个风险对象中重复进入提示词。'.repeat(20),
    status: 'open',
  }],
};

{
  const result = compileDynamicQuestionContext({
    ...baseInput,
    activeClaims: Array.from({ length: 5 }, (_, index) => ({
      claimId: `claim-${index + 1}`,
      facetId: `facet-${index + 1}`,
      value: `value-${index + 1}`,
      evidenceText: `证据-${index + 1}`,
    })),
    relatedTurns: [
      { turnId: 'turn-1', speakerRole: 'guardian', question: '第一问', answer: '第一答' },
      { turnId: 'turn-2', speakerRole: 'guardian', question: '第二问', answer: '第二答' },
      { turnId: 'turn-3', speakerRole: 'guardian', question: '第三问', answer: '第三答' },
    ],
  });

  assert.equal(result.ok, true);
  assert.equal(result.context.current_exchange.answer, baseInput.currentAnswer);
  assert.deepEqual(result.telemetry.includedIds.claimIds, ['claim-1', 'claim-2', 'claim-3', 'claim-4']);
  assert.deepEqual(result.telemetry.includedIds.relatedTurnIds, ['turn-1', 'turn-2']);
  assert.deepEqual(result.telemetry.includedIds.mandatoryConflictIds, ['conflict-1']);
  assert.deepEqual(result.telemetry.includedIds.mandatoryRiskIds, ['risk-1', 'risk-2']);
  assert.deepEqual(result.context.open_deterministic_risks, [{
    signal_type: 'self_harm',
    status: 'open',
    count: 2,
    latest_id: 'risk-2',
  }]);
  assert.doesNotMatch(JSON.stringify(result.context), /不想活了|同一段很长的原始回答/);
  assert.ok(result.telemetry.excluded.some((item) =>
    item.id === 'claim-5' && item.reason === 'max_optional_claims'));
  assert.ok(result.telemetry.excluded.some((item) =>
    item.id === 'turn-3' && item.reason === 'max_related_turns'));
  assert.ok(result.telemetry.budget.finalChars <= result.telemetry.caps.maxContextChars);
}

{
  const result = compileDynamicQuestionContext({
    ...baseInput,
    relatedTurns: [
      { turnId: 'turn-long', question: '问', answer: '答'.repeat(1000) },
      { turnId: 'turn-over-cap', question: '问', answer: '答'.repeat(300) },
    ],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.telemetry.includedIds.relatedTurnIds, ['turn-long']);
  assert.ok(result.telemetry.excluded.some((item) =>
    item.id === 'turn-over-cap' && item.reason === 'related_turn_char_budget'));
  assert.ok(result.telemetry.budget.relatedTurnChars <= DYNAMIC_QUESTION_CONTEXT_CAPS.maxRelatedTurnChars);
}

{
  const mandatoryOnly = compileDynamicQuestionContext(baseInput);
  assert.equal(mandatoryOnly.ok, true);
  const result = compileDynamicQuestionContext({
    ...baseInput,
    activeClaims: [{ claimId: 'claim-too-large', evidenceText: '证'.repeat(200) }],
  }, {
    maxContextChars: mandatoryOnly.telemetry.budget.mandatoryChars + 10,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.telemetry.includedIds.claimIds, []);
  assert.ok(result.telemetry.excluded.some((item) =>
    item.id === 'claim-too-large' && item.reason === 'context_char_budget'));
}

{
  const result = compileDynamicQuestionContext({
    ...baseInput,
    currentAnswer: '这段原文不应被静默截断。'.repeat(40),
  }, { maxContextChars: 200 });

  assert.equal(result.ok, false);
  assert.equal(result.context, null);
  assert.deepEqual(result.fallback, { required: true, reason: 'mandatory_context_overflow' });
  assert.ok(result.telemetry.budget.mandatoryChars > result.telemetry.caps.maxContextChars);
}

{
  const result = compileDynamicQuestionContext({ ...baseInput, gaps: [] });
  assert.equal(result.ok, false);
  assert.equal(result.fallback.reason, 'prohibited_input_fields');
  assert.deepEqual(result.telemetry.prohibitedFields, ['gaps']);
}

{
  const result = compileDynamicQuestionContext({ ...baseInput, selectedTargetFacet: {} });
  assert.equal(result.ok, false);
  assert.equal(result.fallback.reason, 'invalid_selected_target_facet');
}

{
  const result = compileDynamicQuestionContext({
    ...baseInput,
    speakerRole: 'child',
    profile: { age: 13, grade: '初一' },
    candidateTargets: [{
      complaintId: 'initial_intake_coverage',
      targetSlotOrIssue: 'sleep_appetite_physical',
      targetFacetId: 'health_change_summary',
      facetLabel: '睡眠、食欲和身体变化',
    }],
  });

  assert.equal(result.ok, true);
  assert.equal(result.context.respondent_context.age_band, '12-14');
  assert.equal(result.context.respondent_context.speaker_role, 'child');
  assert.equal(result.context.candidate_targets.length, 2);
  assert.ok(result.context.candidate_targets.every((target) => target.allowed_actions.length > 0));
  const serialized = JSON.stringify(result.context);
  assert.match(serialized, /information_goal/);
  assert.match(serialized, /minimum_evidence/);
  assert.doesNotMatch(serialized, /fallback_question|candidateQuestion|candidate_question/);
}

console.log('context compiler smoke ok (7 cases)');
