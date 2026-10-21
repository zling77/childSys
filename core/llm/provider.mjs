import { createHash } from 'node:crypto';
import { buildClarifyingQuestionMessages, buildDynamicPolicyCriticMessages, buildExtractMessages } from './promptRegistry.mjs';
import { createMockProvider } from './mockProvider.mjs';
import { createOpenAiCompatibleProvider } from './openaiCompatibleProvider.mjs';

export const DYNAMIC_LOGICAL_CALL_LIMIT = 18;

export function createLlmRuntimeFromEnv(env = process.env) {
  const mode = String(env.PREVISIT_LLM_MODE ?? 'dynamic').trim().toLowerCase();
  if (!['off', 'shadow', 'dynamic'].includes(mode)) {
    throw new Error('PREVISIT_LLM_MODE must be off, shadow, or dynamic');
  }
  if (mode === 'off') return { enabled: false, mode, provider: createMockProvider() };

  const providerName = env.PREVISIT_LLM_PROVIDER ?? 'openai_compatible';
  const model = env.PREVISIT_LLM_MODEL ?? 'qwen3.8:27b';
  const provider = providerName === 'openai_compatible'
    ? createOpenAiCompatibleProvider({
        baseUrl: env.PREVISIT_LLM_BASE_URL ?? 'http://127.0.0.1:1234/v1',
        apiKey: env.PREVISIT_LLM_API_KEY ?? 'lm-studio',
        model,
        stateModel: env.PREVISIT_STATE_MODEL ?? model,
        stateOutputFormat: env.PREVISIT_STATE_OUTPUT_FORMAT ?? 'json_object',
        clarifyModel: env.PREVISIT_LLM_CLARIFY_MODEL ?? model,
        timeoutMs: Number(env.PREVISIT_LLM_TIMEOUT_MS ?? 15_000),
        clarifyTimeoutMs: Number(env.PREVISIT_LLM_CLARIFY_TIMEOUT_MS ?? 8_000),
        retryAttempts: Number(env.PREVISIT_LLM_RETRY_ATTEMPTS ?? 1),
        temperature: Number(env.PREVISIT_LLM_TEMPERATURE ?? 0.2),
        maxTokens: Number(env.PREVISIT_LLM_MAX_TOKENS ?? 700),
        thinkingMode: env.PREVISIT_LLM_THINKING,
        reasoningEffort: env.PREVISIT_LLM_REASONING_EFFORT,
      })
    : createMockProvider();

  const clarifySetting = String(env.PREVISIT_LLM_CLARIFY ?? 'on').toLowerCase();
  return { enabled: true, mode, provider, clarifyEnabled: !['off', 'false', '0'].includes(clarifySetting) };
}

export async function runShadowExtract(runtime, input) {
  const { promptVersion, messages } = buildExtractMessages(input);
  const auditBase = {
    callId: `MC-${input.sessionId}-${input.turnNo}-${Date.now()}`,
    sessionId: input.sessionId,
    turnNo: input.turnNo,
    task: 'llm_extract_shadow',
    mode: runtime.mode,
    provider: runtime.provider.provider,
    model: runtime.provider.model,
    promptVersion,
    inputHash: sha256(JSON.stringify({ messages })),
    outputHash: null,
    latencyMs: null,
    status: 'skipped',
    error: null,
    output: null,
    createdAt: Date.now(),
  };

  if (!runtime.enabled || runtime.mode !== 'shadow') {
    return auditBase;
  }

  const started = Date.now();
  try {
    const output = await runtime.provider.extract(input);
    return {
      ...auditBase,
      outputHash: sha256(JSON.stringify(output)),
      latencyMs: Date.now() - started,
      status: 'success',
      output,
    };
  } catch (err) {
    return {
      ...auditBase,
      latencyMs: Date.now() - started,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runClarifyingQuestion(runtime, input) {
  const { promptVersion, messages } = buildClarifyingQuestionMessages(input);
  const auditBase = {
    callId: `MC-${input.sessionId}-${input.turnNo}-clarify-${Date.now()}`,
    sessionId: input.sessionId,
    turnNo: input.turnNo,
    task: 'llm_clarify_followup',
    mode: runtime.mode,
    provider: runtime.provider.provider,
    model: runtime.provider.model,
    promptVersion,
    inputHash: sha256(JSON.stringify({ messages })),
    outputHash: null,
    latencyMs: null,
    status: 'skipped',
    error: null,
    output: null,
    createdAt: Date.now(),
  };

  if (!runtime.enabled || !runtime.clarifyEnabled) {
    return auditBase;
  }

  if (typeof runtime.provider.generateClarifyingQuestion !== 'function') {
    return {
      ...auditBase,
      status: 'error',
      error: 'LLM provider does not support clarifying follow-up generation',
    };
  }

  const started = Date.now();
  try {
    const output = await runtime.provider.generateClarifyingQuestion(input);
    return {
      ...auditBase,
      outputHash: sha256(JSON.stringify(output)),
      latencyMs: Date.now() - started,
      status: 'success',
      output,
    };
  } catch (err) {
    return {
      ...auditBase,
      latencyMs: Date.now() - started,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runDynamicNextQuestion(runtime, input) {
  const built = buildDynamicPolicyCriticMessages(input);
  const {
    promptVersion,
    messages,
    contextOk = true,
    contextFallback = { required: false, reason: null },
    contextTelemetry = null,
  } = built;
  const priorDynamicCallCount = Math.max(0, Number(input.priorDynamicCallCount ?? 0));
  const dynamicCallBudget = {
    limit: DYNAMIC_LOGICAL_CALL_LIMIT,
    priorCalls: priorDynamicCallCount,
    remaining: Math.max(0, DYNAMIC_LOGICAL_CALL_LIMIT - priorDynamicCallCount),
  };
  const auditBase = {
    callId: `MC-${input.sessionId}-${input.turnNo}-dynamic-${Date.now()}`,
    sessionId: input.sessionId,
    turnNo: input.turnNo,
    task: 'llm_dynamic_next_question',
    mode: runtime.mode,
    provider: runtime.provider.provider,
    model: runtime.provider.dynamicModel ?? runtime.provider.model,
    promptVersion,
    inputHash: sha256(JSON.stringify({ messages })),
    outputHash: null,
    latencyMs: null,
    status: 'skipped',
    error: null,
    output: null,
    contextTelemetry: {
      ...(contextTelemetry ?? {}),
      dynamicCallBudget,
    },
    usage: null,
    createdAt: Date.now(),
  };

  if (!runtime.enabled || runtime.mode !== 'dynamic') {
    return auditBase;
  }

  if (priorDynamicCallCount >= DYNAMIC_LOGICAL_CALL_LIMIT) {
    return {
      ...auditBase,
      status: 'skipped',
      error: `dynamic_call_budget_exhausted:${DYNAMIC_LOGICAL_CALL_LIMIT}`,
    };
  }

  if (!contextOk) {
    return {
      ...auditBase,
      status: 'skipped',
      error: `dynamic_context_fallback:${contextFallback.reason ?? 'unknown'}`,
    };
  }

  if (typeof runtime.provider.generateDynamicNextQuestion !== 'function') {
    return {
      ...auditBase,
      status: 'error',
      error: 'LLM provider does not support dynamic next-question generation',
    };
  }

  const started = Date.now();
  try {
    const providerResult = await runtime.provider.generateDynamicNextQuestion(input);
    const { output, usage } = stripProviderMetadata(providerResult);
    return {
      ...auditBase,
      outputHash: sha256(JSON.stringify(output)),
      latencyMs: Date.now() - started,
      status: 'success',
      output,
      usage,
    };
  } catch (err) {
    return {
      ...auditBase,
      latencyMs: Date.now() - started,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      usage: err?.providerUsage ?? null,
    };
  }
}

function stripProviderMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { output: value, usage: null };
  }
  const { _providerUsage = null, ...output } = value;
  return { output, usage: _providerUsage };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
