import { createHash } from 'node:crypto';
import { COMMUNICATION_PROMPT } from './communication.mjs';
import { respondentStrategyProfile } from './followupStrategy.mjs';
import { getFacetContract } from '../intakeContracts.mjs';

export const DIALOGUE_AUDIT_PROMPT_VERSION = 'previsit-dialogue-audit-v1';
export function buildDialogueAuditMessages(snapshot, result) {
  const turnNo = result.dialogueTurn.turnNo;
  const claims = new Map([...(snapshot.evidenceUnits ?? []), ...result.evidenceUnits]
    .filter(e => e.value?.semanticClaim).map(e => [e.evidenceId, e.value.semanticClaim]));
  const history = snapshot.turns.filter(t => t.turnNo < turnNo).slice(-3)
    .map(t => ({ turn: t.turnNo, question: t.questionText, answer: t.answerText }));
  const context = { respondent: respondentStrategyProfile(result.dialogueTurn.speakerRole, snapshot.session.profile),
    history, current: result.dialogueTurn, claims: [...claims.values()],
    assessments: result.semanticAssessment.assessments, responses: result.semanticAssessment.responses,
    dialogue_guidance: result.dialogueGuidance,
    updated_facets: result.slotStates.flatMap(s => Object.values(s.value?.facets ?? {})
      .filter(f => f.evidenceIds?.length || f.responseState).map(f => ({ slot_id: s.slotId, facet_id: f.facetId,
        sufficiency: f.sufficiency, missing_requirements: f.missingRequirements, response_state: f.responseState }))),
    next_question: result.nextQuestion, next_action: result.nextAction,
  };
  if (JSON.stringify(context).length > 24000) throw new Error('dialogue_audit_context_budget_exceeded');
  return { context, messages: [{ role: 'system', content: [
    '你是儿童青少年预问诊的后台质量审计Agent，审计供人工复核，不改状态、不向受访者提问、不替代在线Critic。',
    COMMUNICATION_PROMPT,
    '核对原文引用、最低证据要求、跨轮合并、更正、状态丢失、重复追问和结束依据。材料不足返回insufficient_context，不推测未提供历史。',
    '检查家长成人称谓及观察范围、儿童三个年龄层的理解负担和自主性，不因儿童回答短而判无效。',
    '检查情绪有无本人当前原话依据、是否混淆他人/历史、是否机械或重复安抚、是否遗漏事实、归责、保证、忽略拒答/暂停/停止，以及是否用安抚替代安全流程。',
    '有依据才提出问题，区别clear与suspected。每个issue必须引用输入turn_refs，claim_refs只能引用输入claim的evidenceId。不要因偏好另一种问法认定错误。',
    '只输出JSON：{"verdict":"pass|needs_review|insufficient_context","issues":[{"type":"问题类型","turn_refs":[1],"claim_refs":[],"slot_id":"...","facet_id":"...","finding":"不超过80字","certainty":"clear|suspected","suggested_review":"不超过80字"}]}；最多8项，不输出推理过程或覆盖指令。',
  ].join('\n') }, { role: 'user', content: JSON.stringify(context) }] };
}

export async function auditDialogueTurn(snapshot, result, provider, timeoutMs = 8000) {
  const started = Date.now(), controller = new AbortController();
  const audit = { callId: `DA-${result.sessionId}-${result.dialogueTurn.turnNo}`, sessionId: result.sessionId,
    turnNo: result.dialogueTurn.turnNo, task: 'dialogue_quality_audit', mode: 'shadow',
    provider: provider.provider, model: provider.evidenceModel ?? provider.model,
    promptVersion: DIALOGUE_AUDIT_PROMPT_VERSION, inputHash: '', outputHash: null, output: null,
    status: 'error', error: null, latencyMs: 0, createdAt: started };
  let timer;
  try {
    const { context, messages } = buildDialogueAuditMessages(snapshot, result);
    audit.inputHash = createHash('sha256').update(JSON.stringify(context)).digest('hex');
    const output = await Promise.race([provider.auditDialogue({ messages, timeoutMs, signal: controller.signal }),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('dialogue_audit_timeout')); }, timeoutMs); })]);
    if (!['pass','needs_review','insufficient_context'].includes(output.verdict) || !Array.isArray(output.issues)
      || output.issues.length > 8) throw new Error('invalid_dialogue_audit_schema');
    const turns = new Set([...context.history.map(t => t.turn), result.dialogueTurn.turnNo]);
    const ids = new Set(context.claims.map(c => c.evidenceId));
    const issues = output.issues.map(issue => {
      if (!Array.isArray(issue.turn_refs) || !issue.turn_refs.length || !issue.turn_refs.every(t => turns.has(t))
        || !Array.isArray(issue.claim_refs) || !issue.claim_refs.every(id => ids.has(id))
        || !['clear','suspected'].includes(issue.certainty)
        || !getFacetContract(issue.slot_id, issue.facet_id)) throw new Error('invalid_dialogue_audit_reference');
      return { type: String(issue.type).slice(0, 50), turn_refs: issue.turn_refs, claim_refs: issue.claim_refs,
        slot_id: issue.slot_id, facet_id: issue.facet_id, certainty: issue.certainty,
        finding: String(issue.finding ?? '').slice(0, 80), suggested_review: String(issue.suggested_review ?? '').slice(0, 80) };
    });
    if (output.verdict === 'pass' && issues.length) throw new Error('inconsistent_dialogue_audit_verdict');
    audit.output = { verdict: output.verdict, issues }; audit.status = 'success';
    audit.outputHash = createHash('sha256').update(JSON.stringify(audit.output)).digest('hex');
  } catch (error) { audit.error = error instanceof Error ? error.message : String(error); }
  finally { clearTimeout(timer); controller.abort(); audit.latencyMs = Date.now() - started; }
  return audit;
}
