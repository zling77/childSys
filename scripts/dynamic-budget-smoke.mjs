import assert from 'node:assert/strict';

import {
  DYNAMIC_LOGICAL_CALL_LIMIT,
  runDynamicNextQuestion,
} from '../core/llm/provider.mjs';
import { COVERAGE_DOMAIN } from '../core/coverage.mjs';

let providerCalls = 0;
const provider = {
  provider: 'budget_smoke',
  model: 'budget-smoke-model',
  async generateDynamicNextQuestion() {
    providerCalls += 1;
    return {
      next_action: 'ask',
      question: '这个情况大概从什么时候开始？',
      complaint_id: COVERAGE_DOMAIN,
      target_slot_or_issue: 'onset_course',
      target_facet_id: 'onset_time',
      reason: 'smoke',
      confidence: 0.8,
      _providerUsage: { prompt_tokens: 120, completion_tokens: 20, total_tokens: 140 },
    };
  },
};
const runtime = { enabled: true, mode: 'dynamic', provider };
const input = {
  sessionId: 'S-DYNAMIC-BUDGET',
  turnNo: 1,
  speakerRole: 'guardian',
  answerText: '大概有一阵子了。',
  currentQuestion: { text: '最近主要有什么困扰？' },
  selectedTargetFacet: {
    complaintId: COVERAGE_DOMAIN,
    targetSlotOrIssue: 'onset_course',
    targetFacetId: 'onset_time',
    facetLabel: '大致开始时间',
    text: '这个情况大概从什么时候开始？',
  },
};

const success = await runDynamicNextQuestion(runtime, { ...input, priorDynamicCallCount: 0 });
assert.equal(success.status, 'success');
assert.equal(providerCalls, 1);
assert.deepEqual(success.usage, { prompt_tokens: 120, completion_tokens: 20, total_tokens: 140 });
assert.equal(Object.hasOwn(success.output, '_providerUsage'), false);

const capped = await runDynamicNextQuestion(runtime, {
  ...input,
  turnNo: 19,
  priorDynamicCallCount: DYNAMIC_LOGICAL_CALL_LIMIT,
});
assert.equal(capped.status, 'skipped');
assert.match(capped.error, /^dynamic_call_budget_exhausted:/);
assert.equal(providerCalls, 1, 'call cap must stop before invoking the provider');
assert.deepEqual(capped.contextTelemetry.dynamicCallBudget, {
  limit: DYNAMIC_LOGICAL_CALL_LIMIT,
  priorCalls: DYNAMIC_LOGICAL_CALL_LIMIT,
  remaining: 0,
});

console.log('dynamic budget smoke PASS');
