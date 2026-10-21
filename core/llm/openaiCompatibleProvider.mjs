import { buildClarifyingQuestionMessages, buildDynamicPolicyCriticMessages, buildDynamicRealizerMessages, buildExtractMessages } from './promptRegistry.mjs';
import { allowedActionsForTarget } from './followupStrategy.mjs';
import { expandCompactEvidence } from './evidenceSchema.mjs';
import { extractJsonObject, validateClarifyingQuestionOutput, validateDynamicRealizerOutput, validateDynamicStrategyOutput, validateExtractOutput } from './schemaValidator.mjs';

export function createOpenAiCompatibleProvider(config) {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const requestConfig = {
    ...config,
    thinkingMode: normalizeThinkingMode(config.thinkingMode),
  };
  return {
    provider: 'openai_compatible',
    model: config.model,
    evidenceModel: config.stateModel ?? config.model,
    evidenceProtocol: config.stateOutputFormat === 'json_schema' ? 'compact' : 'canonical',
    dynamicModel: config.clarifyModel ?? config.model,
    async auditDialogue(input) {
      const data = await chatJson({ baseUrl, config: { ...requestConfig, retryAttempts: 0 },
        messages: input.messages, model: config.stateModel ?? config.model,
        maxTokens: 600, timeoutMs: input.timeoutMs, signal: input.signal });
      return extractJsonObject(data.choices?.[0]?.message?.content ?? '');
    },
    async assessEvidence(input) {
      const data = await chatJson({ baseUrl, config: { ...requestConfig, retryAttempts: 0, temperature: 0 },
        messages: input.messages, model: config.stateModel ?? config.model,
        maxTokens: 2400, timeoutMs: input.timeoutMs, signal: input.signal,
        responseFormat: config.stateOutputFormat === 'json_schema' && input.schema
          ? { type: 'json_schema', json_schema: { name: 'previsit_evidence', strict: true, schema: input.schema } } : undefined });
      const parsed={ ...extractJsonObject(data.choices?.[0]?.message?.content ?? ''), _providerUsage: data.usage };
      return config.stateOutputFormat === 'json_schema' ? expandCompactEvidence(parsed, input.activeClaims) : parsed;
    },
    async decideDialogue(input) {
      const data = await chatJson({ baseUrl, config: { ...requestConfig, retryAttempts: 0 },
        messages: input.messages, model: config.clarifyModel ?? config.model,
        maxTokens: 420, timeoutMs: Math.min(config.clarifyTimeoutMs ?? 8000, input.timeoutMs ?? 8000, 8000), signal: input.signal,
        responseFormat: config.stateOutputFormat === 'json_schema'
          ? { type: 'json_schema', json_schema: { name: 'previsit_dialogue_decision', strict: true, schema: input.schema } } : undefined });
      return { ...extractJsonObject(data.choices?.[0]?.message?.content ?? ''),
        _providerUsage: { ...data.usage, stages: 1 } };
    },
    async reviewCompletion(input) {
      const data = await chatJson({ baseUrl, config: { ...requestConfig, retryAttempts: 0, temperature: 0 },
        messages: input.messages, model: config.clarifyModel ?? config.model,
        maxTokens: 850, timeoutMs: input.timeoutMs, signal: input.signal,
        responseFormat: config.stateOutputFormat === 'json_schema'
          ? { type: 'json_schema', json_schema: { name: 'previsit_completion_review', strict: true, schema: input.schema } } : undefined });
      return { ...extractJsonObject(data.choices?.[0]?.message?.content ?? ''), _providerUsage: data.usage };
    },
    async extract(input) {
      const { messages } = buildExtractMessages(input);
      const data = await chatJson({ baseUrl, config: requestConfig, messages, maxTokens: config.maxTokens ?? 700 });
      const content = data.choices?.[0]?.message?.content ?? '';
      return validateExtractOutput(extractJsonObject(content));
    },
    async generateClarifyingQuestion(input) {
      const { messages } = buildClarifyingQuestionMessages(input);
      const data = await chatJson({
        baseUrl,
        config: requestConfig,
        messages,
        model: config.clarifyModel ?? config.model,
        maxTokens: Math.min(config.maxTokens ?? 450, 450),
        timeoutMs: config.clarifyTimeoutMs ?? Math.min(config.timeoutMs ?? 20_000, 15_000),
      });
      const content = data.choices?.[0]?.message?.content ?? '';
      return validateClarifyingQuestionOutput(extractJsonObject(content));
    },
    async generateDynamicNextQuestion(input) {
      const policyBuilt = buildDynamicPolicyCriticMessages(input);
      if (policyBuilt.contextOk === false) {
        throw new Error(`dynamic context compiler requested fallback: ${policyBuilt.contextFallback?.reason ?? 'unknown'}`);
      }
      const policyData = await chatJson({
        baseUrl,
        config: requestConfig,
        messages: policyBuilt.messages,
        model: config.clarifyModel ?? config.model,
        maxTokens: Math.min(config.maxTokens ?? 320, 320),
        timeoutMs: config.clarifyTimeoutMs ?? Math.min(config.timeoutMs ?? 20_000, 15_000),
        validateContent: (value) => validateDynamicStrategyContract(value, input),
      });
      const strategy = validateDynamicStrategyOutput(extractJsonObject(
        policyData.choices?.[0]?.message?.content ?? '',
      ));
      const realizerBuilt = buildDynamicRealizerMessages(input, strategy, policyBuilt.compiledContext);
      const realizerData = await chatJson({
        baseUrl,
        config: requestConfig,
        messages: realizerBuilt.messages,
        model: config.clarifyModel ?? config.model,
        maxTokens: Math.min(config.maxTokens ?? 160, 160),
        timeoutMs: config.clarifyTimeoutMs ?? Math.min(config.timeoutMs ?? 20_000, 15_000),
        validateContent: validateDynamicRealizerContract,
      });
      const realized = validateDynamicRealizerOutput(extractJsonObject(
        realizerData.choices?.[0]?.message?.content ?? '',
      ));
      return {
        ...strategy,
        question: realized.question,
        ...(realized.acknowledgement != null ? { acknowledgement: realized.acknowledgement } : {}),
        _providerUsage: mergeStageUsage(policyData.usage, realizerData.usage),
      };
    },
  };
}

async function chatJson({
  baseUrl,
  config,
  messages,
  maxTokens,
  timeoutMs = config.timeoutMs,
  model = config.model,
  validateContent = null,
  signal = null,
  responseFormat = undefined,
}) {
  const retryAttempts = Math.max(0, Number(config.retryAttempts ?? 1));
  let lastError = null;
  let accumulatedUsage = null;
  let requestAttempts = 0;

  for (let attempt = 0; attempt <= retryAttempts; attempt += 1) {
    requestAttempts = attempt + 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: config.temperature,
          max_tokens: maxTokens,
          response_format: responseFormat ?? { type: 'json_object' },
          ...(config.thinkingMode ? { thinking: { type: config.thinkingMode } } : {}),
          ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
        }),
        signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`LLM HTTP ${response.status}: ${text.slice(0, 500)}`);
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error('LLM response envelope is not valid JSON');
      }
      accumulatedUsage = mergeUsage(accumulatedUsage, data.usage);
      const content = data.choices?.[0]?.message?.content;
      if (!String(content ?? '').trim()) {
        throw new Error('LLM returned empty JSON content');
      }
      try {
        const parsedContent = extractJsonObject(content);
        validateContent?.(parsedContent);
      } catch {
        throw new Error(validateContent
          ? 'LLM returned schema-invalid JSON content'
          : 'LLM returned invalid JSON content');
      }
      return {
        ...data,
        usage: usageWithAttempts(accumulatedUsage, requestAttempts),
      };
    } catch (err) {
      lastError = controller.signal.aborted
        ? new Error(`LLM request timed out after ${timeoutMs}ms`)
        : err;
      if (attempt < retryAttempts && isRetryableLlmError(lastError)) {
        await delay(350 * (attempt + 1));
        continue;
      }
      if (lastError && typeof lastError === 'object') {
        lastError.providerUsage = usageWithAttempts(accumulatedUsage, requestAttempts);
      }
      throw lastError;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError ?? new Error('LLM request failed');
}

function mergeUsage(total, usage) {
  const next = usage && typeof usage === 'object' ? usage : null;
  if (!next) return total;
  const merged = { ...(total ?? {}) };
  for (const [key, value] of Object.entries(next)) {
    if (Number.isFinite(Number(value))) merged[key] = Number(merged[key] ?? 0) + Number(value);
  }
  return merged;
}

function usageWithAttempts(usage, requestAttempts) {
  return {
    ...(usage ?? {}),
    request_attempts: requestAttempts,
  };
}

function validateDynamicStrategyContract(value, input) {
  const strategy = validateDynamicStrategyOutput(value);
  const fallback = input.selectedTargetFacet ?? input.ruleNextQuestion ?? {};
  const allowed = input.candidateTargets?.length ? input.candidateTargets : [fallback];
  const selected = allowed.find((target) => (
    (target.complaintId ?? target.complaint_id) === strategy.complaint_id
      && (target.targetSlotOrIssue ?? target.slotId ?? target.slot_id) === strategy.target_slot_or_issue
      && (target.targetFacetId ?? target.facetId ?? target.facet_id ?? '') === strategy.target_facet_id
  ));
  if (value?.question != null
    || value?.next_action !== 'ask'
    || !strategy.complaint_id
    || !strategy.target_slot_or_issue
    || !strategy.target_facet_id
    || !strategy.action_type
    || !selected
    || !allowedActionsForTarget(selected).includes(strategy.action_type)) {
    throw new Error('dynamic strategy does not match an allowed target-action candidate');
  }
}

function validateDynamicRealizerContract(value) {
  const realized = validateDynamicRealizerOutput(value);
  if (!realized.question) {
    throw new Error('dynamic realizer did not return one valid question');
  }
}

function mergeStageUsage(policyUsage, realizerUsage) {
  const numericKeys = new Set([
    ...Object.keys(policyUsage ?? {}),
    ...Object.keys(realizerUsage ?? {}),
  ]);
  const total = {};
  for (const key of numericKeys) {
    if (key === 'stages') continue;
    const left = Number(policyUsage?.[key]);
    const right = Number(realizerUsage?.[key]);
    if (Number.isFinite(left) || Number.isFinite(right)) {
      total[key] = (Number.isFinite(left) ? left : 0) + (Number.isFinite(right) ? right : 0);
    }
  }
  return {
    ...total,
    stages: {
      policy_critic: policyUsage ?? null,
      realizer: realizerUsage ?? null,
    },
  };
}

function isRetryableLlmError(err) {
  const message = err instanceof Error ? err.message : String(err);
  return /fetch failed|terminated|ECONN|UND_ERR|timed out|LLM HTTP (408|409|425|429|5\d\d)|LLM (response envelope is not valid JSON|returned (empty|invalid|schema-invalid) JSON content)/i.test(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBaseUrl(value) {
  const raw = String(value ?? '').replace(/\/+$/, '');
  if (!raw) throw new Error('PREVISIT_LLM_BASE_URL is required');
  return raw;
}

function normalizeThinkingMode(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return null;
  if (!['enabled', 'disabled'].includes(normalized)) {
    throw new Error('PREVISIT_LLM_THINKING must be enabled, disabled, or empty');
  }
  return normalized;
}
