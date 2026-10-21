import { createHash } from 'node:crypto';
import { compileEvidenceContext, evidenceMessages, compactEvidenceMessages, SEMANTIC_PROMPT_VERSION,
  validateSemanticEvidence } from '../semanticEvidence.mjs';
import { compactEvidenceSchema } from './evidenceSchema.mjs';

export function stateBuilderSettings(env = process.env) {
  const mode = String(env.PREVISIT_STATE_BUILDER_MODE ?? 'rule').toLowerCase();
  if (!['rule', 'shadow', 'semantic'].includes(mode)) throw new Error('PREVISIT_STATE_BUILDER_MODE must be rule, shadow, or semantic');
  const timeoutMs = Number(env.PREVISIT_STATE_TIMEOUT_MS ?? 8000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new Error('PREVISIT_STATE_TIMEOUT_MS must be between 100 and 30000');
  return { mode, timeoutMs };
}

export async function assessTurnEvidence(snapshot, input, provider, settings) {
  const started = Date.now();
  const audit = {
    callId: `SE-${snapshot.session.sessionId}-${snapshot.turns.length + 1}`,
    sessionId: snapshot.session.sessionId, turnNo: snapshot.turns.length + 1,
    task: 'semantic_evidence_assessment', mode: settings.mode,
    provider: provider.provider ?? 'unknown', model: provider.evidenceModel ?? provider.model ?? 'unknown',
    promptVersion: SEMANTIC_PROMPT_VERSION, inputHash: '', outputHash: null,
    latencyMs: 0, status: 'error', error: null, output: null, createdAt: started,
  };
  const controller = new AbortController();
  let timer;
  try {
    const compiled = compileEvidenceContext(snapshot, input);
    audit.inputHash = compiled.inputHash;
    if (typeof provider.assessEvidence !== 'function') throw new Error('semantic_provider_not_supported');
    const result = await Promise.race([
      provider.assessEvidence({ messages: provider.evidenceProtocol === 'compact' ? compactEvidenceMessages(compiled) : evidenceMessages(compiled), schema: compactEvidenceSchema(compiled.activeClaims), activeClaims: compiled.activeClaims,
        signal: controller.signal, timeoutMs: settings.timeoutMs }),
      new Promise((_, reject) => { timer = setTimeout(() => {
        controller.abort(); reject(new Error('semantic_assessment_timeout'));
      }, settings.timeoutMs); }),
    ]);
    audit.usage = result?._providerUsage ?? null;
    const validated = validateSemanticEvidence(result, snapshot, input, compiled);
    audit.status = 'success'; audit.output = validated;
    audit.outputHash = createHash('sha256').update(JSON.stringify(validated)).digest('hex');
    return { validated, audit };
  } catch (error) {
    audit.error = error instanceof Error ? error.message : String(error);
    return { validated: null, audit };
  } finally {
    clearTimeout(timer); controller.abort(); audit.latencyMs = Date.now() - started;
  }
}
