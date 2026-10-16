import { allowedActionsForTarget, classifyResponseSignal, targetKey } from './followupStrategy.mjs';
import { realizeGoalFallback } from './dynamicGoalSpace.mjs';
import { validateClarifyingQuestionOutput, validateDynamicNextQuestionOutput, validateExtractOutput } from './schemaValidator.mjs';

export function createMockProvider() {
  return {
    provider: 'mock',
    model: 'mock-previsit-shadow',
    dynamicModel: 'mock-previsit-shadow',
    async extract(input) {
      const raw = String(input.answerText ?? '');
      const slots = [];
      if (/肚子疼|腹痛|呕吐|头晕|胸闷/.test(raw)) {
        slots.push({ complaint_id: input.complaintIds?.[0] ?? '', slot_id: 'somatic_symptoms', value: raw, evidence_text: raw, confidence: 0.72 });
      }
      if (/校门口|起床|出门|进教室/.test(raw)) {
        slots.push({ complaint_id: input.complaintIds?.[0] ?? '', slot_id: 'refusal_stage', value: raw, evidence_text: raw, confidence: 0.72 });
      }
      if (/回家|好转|缓解/.test(raw)) {
        slots.push({ complaint_id: input.complaintIds?.[0] ?? '', slot_id: 'relief_pattern', value: raw, evidence_text: raw, confidence: 0.72 });
      }
      const risk_signals = /不想活|想消失|划伤|打自己/.test(raw)
        ? [{ signal_type: 'self_harm_or_suicide', trigger_text: raw, confidence: 0.8 }]
        : [];
      return validateExtractOutput({
        complaints: input.complaintIds ?? [],
        slots,
        risk_signals,
        open_issues: [],
      });
    },
    async generateClarifyingQuestion(input) {
      const raw = String(input.answerText ?? '');
      const target = input.currentQuestion?.targetSlotOrIssue ?? input.ruleNextQuestion?.targetSlotOrIssue ?? 'open_narrative';
      const unclear = /不知道|不清楚|说不清|记不清|忘了|差不多|还行|一般|不确定/.test(raw) || raw.trim().length <= 5;
      return validateClarifyingQuestionOutput({
        need_clarification: unclear,
        target_slot_or_issue: target,
        question: unclear ? mockClarifyingQuestion(target) : '',
        reason: unclear ? 'mock 检测到回答含糊，需要围绕当前槽位补问一句。' : '回答可进入下一题。',
        confidence: unclear ? 0.82 : 0.68,
      });
    },
    async generateDynamicNextQuestion(input) {
      const raw = String(input.answerText ?? '');
      const rule = input.selectedTargetFacet ?? input.ruleNextQuestion ?? {};
      const candidates = input.candidateTargets?.length ? input.candidateTargets : [rule];
      const selected = chooseMockCandidate(candidates, rule, raw);
      const target = selected.targetSlotOrIssue ?? input.currentQuestion?.targetSlotOrIssue ?? '';
      const action = allowedActionsForTarget(selected)[0];
      const question = classifyResponseSignal(raw) === 'misunderstood'
        ? mockClarifyingQuestion(target)
        : mockContextualQuestion(raw, selected, input.speakerRole)
          ?? realizeGoalFallback(selected, { speakerRole: input.speakerRole })
          ?? '能不能再说一件你记得的具体事情？';

      return validateDynamicNextQuestionOutput({
        next_action: target ? 'ask' : 'complete',
        question,
        complaint_id: selected.complaintId ?? input.currentQuestion?.complaintId ?? '',
        target_slot_or_issue: target,
        target_facet_id: selected.targetFacetId ?? '',
        action_type: action,
        selection_reason: '本地策略按回答相关性、状态和回答负担选择候选。',
        considered_candidates: candidates.slice(0, 3).map((candidate) => ({
          complaint_id: candidate.complaintId,
          target_slot_or_issue: candidate.targetSlotOrIssue,
          target_facet_id: candidate.targetFacetId,
          action_type: allowedActionsForTarget(candidate)[0],
          reason: targetKey(candidate) === targetKey(selected) ? '本轮优先' : '保留候选',
        })),
        confidence: 0.7,
      });
    },
  };
}

function mockContextualQuestion(answerText, selected, speakerRole) {
  const raw = String(answerText ?? '');
  const guardian = speakerRole !== 'child';
  if (/(?:学校|校门|门口)/.test(raw) && /哭/.test(raw)) {
    return guardian
      ? '孩子最近一次到学校门口哭时，前后具体发生了什么？'
      : '你最近一次到学校门口哭时，前后发生了什么？';
  }
  if (/写作业/.test(raw) && /慢|拖/.test(raw)) {
    return guardian
      ? '最近一次孩子写作业比较慢时，具体是怎么表现的？'
      : '你最近一次写作业比较慢时，当时是怎么回事？';
  }
  return null;
}

function chooseMockCandidate(candidates, rule, answerText) {
  const signal = classifyResponseSignal(answerText);
  if (signal === 'misunderstood') return rule;
  if (signal === 'declined') {
    return candidates.find((candidate) => targetKey(candidate) !== targetKey(rule)) ?? rule;
  }
  return [...candidates].sort((left, right) => mockCandidateScore(right) - mockCandidateScore(left))[0] ?? rule;
}

function mockCandidateScore(candidate) {
  const stateBoost = candidate.stateStatus === 'conflict' ? 2
    : candidate.stateStatus === 'ambiguous' ? 1.5 : 0;
  return stateBoost
    + Number(candidate.relevanceToLatestAnswer ?? 0)
    + (candidate.relatedToPreviousAnswer ? 0.7 : 0)
    - Number(candidate.askedCount ?? 0) * 0.4;
}

function mockClarifyingQuestion(target) {
  if (/attendance/.test(target)) return '最近两周大概缺课几天，迟到或早退几次？';
  if (/onset|time|duration/.test(target)) return '这个情况大概从什么时候开始，持续多久了？';
  if (/school|trigger/.test(target)) return '学校里最近有没有具体事件让孩子更不想去？';
  return '能不能再具体说一个例子，帮助医生理解这个情况？';
}
