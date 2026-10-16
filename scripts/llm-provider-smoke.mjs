import assert from 'node:assert/strict';

import { createOpenAiCompatibleProvider } from '../core/llm/openaiCompatibleProvider.mjs';
import { createLlmRuntimeFromEnv } from '../core/llm/provider.mjs';

const originalFetch = globalThis.fetch;
const requests = [];
let responseNo = 0;

globalThis.fetch = async (url, options) => {
  requests.push({ url: String(url), options });
  responseNo += 1;
  const content = responseNo === 1
    ? '{}'
    : responseNo === 2
      ? JSON.stringify({
          next_action: 'ask',
          complaint_id: 'initial_intake_coverage',
          target_slot_or_issue: 'current_manifestations',
          target_facet_id: 'manifestation_description',
          confidence: 0.88,
          action_type: 'explore',
          selection_reason: '本轮回答出现新的具体表现，优先补充经过。',
          considered_candidates: [],
        })
      : JSON.stringify({
          question: '最近一次出现这个情况时，孩子当时具体做了什么？',
        });
  return new Response(JSON.stringify({
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 120, completion_tokens: 24, total_tokens: 144 },
  }), { status: 200 });
};

try {
  const provider = createOpenAiCompatibleProvider({
    baseUrl: 'https://api.deepseek.com/',
    apiKey: 'test-only-key',
    model: 'deepseek-v4-pro',
    clarifyModel: 'deepseek-v4-pro',
    timeoutMs: 2_000,
    clarifyTimeoutMs: 2_000,
    retryAttempts: 1,
    temperature: 0.2,
    maxTokens: 500,
    thinkingMode: 'disabled',
  });

  const output = await provider.generateDynamicNextQuestion({
    sessionId: 'PROVIDER-SMOKE',
    turnNo: 1,
    profile: { age: 10, grade: '小学四年级' },
    speakerRole: 'guardian',
    answerText: '老师说最近更明显。',
    currentQuestion: null,
    selectedTargetFacet: {
      complaintId: 'initial_intake_coverage',
      targetSlotOrIssue: 'current_manifestations',
      targetFacetId: 'manifestation_description',
      text: '最近一次出现这个情况时，孩子当时具体做了什么？',
    },
    activeClaims: [],
    activeConflicts: [],
    openDeterministicRisks: [],
    relatedTurns: [],
  });

  assert.equal(requests.length, 3, 'Policy/Critic should retry once, then Realizer should run separately');
  assert.equal(requests[0].url, 'https://api.deepseek.com/chat/completions');
  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.model, 'deepseek-v4-pro');
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.max_tokens, 320, 'Policy/Critic output budget must remain bounded');
  const realizerBody = JSON.parse(requests[2].options.body);
  assert.equal(realizerBody.max_tokens, 160, 'Realizer output budget must remain bounded');
  assert.doesNotMatch(realizerBody.messages[0].content, /选择一个.*目标/);
  assert.match(realizerBody.messages[0].content, /不得改变选定目标或动作/);
  assert.equal(output.target_slot_or_issue, 'current_manifestations');
  assert.equal(output.target_facet_id, 'manifestation_description');
  assert.match(output.question, /？$/);
  assert.equal(output.action_type, 'explore');
  assert.equal(output._providerUsage.prompt_tokens, 360);
  assert.equal(output._providerUsage.completion_tokens, 72);
  assert.equal(output._providerUsage.total_tokens, 432);
  assert.equal(output._providerUsage.request_attempts, 3);
  assert.equal(output._providerUsage.stages.policy_critic.request_attempts, 2);
  assert.equal(output._providerUsage.stages.realizer.request_attempts, 1);

  assert.throws(
    () => createOpenAiCompatibleProvider({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
      thinkingMode: 'sometimes',
    }),
    /PREVISIT_LLM_THINKING/,
  );

  assert.throws(
    () => createLlmRuntimeFromEnv({ PREVISIT_LLM_MODE: 'dnyamic' }),
    /PREVISIT_LLM_MODE/,
  );

  console.log('LLM provider smoke ok: separate Policy/Critic and Realizer calls, schema retry, and bounded budgets');
} finally {
  globalThis.fetch = originalFetch;
}
