import 'dotenv/config';
import assert from 'node:assert/strict';
import { createLlmRuntimeFromEnv, runDynamicNextQuestion } from '../core/llm/provider.mjs';

const runtime = createLlmRuntimeFromEnv(process.env);
assert.equal(runtime.enabled, true, 'PREVISIT_LLM_MODE must enable the live model');
assert.equal(runtime.mode, 'dynamic', 'live smoke expects PREVISIT_LLM_MODE=dynamic');

const audit = await runDynamicNextQuestion(runtime, {
  sessionId: 'LIVE-SMOKE',
  turnNo: 1,
  profile: { age: 10, grade: '小学四年级' },
  speakerRole: 'guardian',
  answerText: '不太清楚，老师只说最近上课总走神。',
  currentQuestion: {
    complaintId: 'initial_intake_coverage',
    targetSlotOrIssue: 'presenting_problem',
    targetFacetId: 'primary_concern',
    text: '这次您最希望医生先了解孩子的哪一个变化或困难？',
  },
  selectedTargetFacet: {
    policyType: 'adaptive_coverage',
    complaintId: 'initial_intake_coverage',
    targetSlotOrIssue: 'current_manifestations',
    targetFacetId: 'manifestation_description',
    text: '最近一次出现这个情况时，孩子当时具体说了什么、做了什么？',
  },
  activeClaims: [],
  activeConflicts: [],
  openDeterministicRisks: [],
  relatedTurns: [],
});

assert.equal(audit.status, 'success', audit.error ?? 'live LLM call failed');
assert.equal(audit.output?.next_action, 'ask');
assert.match(audit.output?.question ?? '', /[？?]$/);
assert.ok((audit.output?.question ?? '').length <= 90);
assert.equal(((audit.output?.question ?? '').match(/[？?]/g) ?? []).length, 1);
assert.equal(audit.output?.complaint_id, 'initial_intake_coverage');
assert.equal(audit.output?.target_slot_or_issue, 'current_manifestations');
assert.equal(audit.output?.target_facet_id, 'manifestation_description');

console.log(JSON.stringify({
  status: audit.status,
  provider: audit.provider,
  model: audit.model,
  latencyMs: audit.latencyMs,
  question: audit.output.question,
}, null, 2));
