import { buildDynamicGoal, realizeGoalFallback } from './llm/dynamicGoalSpace.mjs';

export function rewriteQuestion(selected, profile, snapshot = {}, speakerRole = null) {
  if (!selected) return null;
  const isChild = speakerRole == null
    ? isChildAudience(profile?.respondent)
    : speakerRole === 'child';
  const target = buildDynamicGoal(selected) ?? selected;
  const text = selected.targetSlotOrIssue === 'safety_clues'
    ? selected.candidateQuestion
    : realizeGoalFallback(target, { speakerRole: isChild ? 'child' : 'guardian' });
  if (!text) return null;
  return {
    policyType: selected.targetSlotOrIssue === 'safety_clues'
      ? selected.policyType
      : 'goal_space_provisional',
    complaintId: selected.complaintId,
    targetSlotOrIssue: selected.targetSlotOrIssue,
    targetFacetId: selected.targetFacetId,
    label: selected.label,
    facetLabel: selected.facetLabel,
    isCriticalRisk: selected.isCriticalRisk === true,
    audience: isChild ? 'child' : 'guardian',
    text,
  };
}

export function buildRuleClarificationQuestion(currentQuestion, answerText, snapshot = {}, speakerRole = null) {
  if (!currentQuestion?.targetSlotOrIssue) return null;
  if (currentQuestion.targetSlotOrIssue === 'safety_clues') return { ...currentQuestion };
  const isChild = speakerRole == null
    ? currentQuestion.audience === 'child' || isChildAudience(snapshot.session?.profile?.respondent)
    : speakerRole === 'child';
  const target = buildDynamicGoal(currentQuestion);
  const text = target && realizeGoalFallback(target, {
    speakerRole: isChild ? 'child' : 'guardian',
    clarification: true,
  });
  if (!text) return null;
  return {
    policyType: 'goal_space_clarify',
    complaintId: currentQuestion.complaintId,
    targetSlotOrIssue: currentQuestion.targetSlotOrIssue,
    targetFacetId: currentQuestion.targetFacetId,
    label: currentQuestion.label,
    facetLabel: currentQuestion.facetLabel,
    isCriticalRisk: false,
    audience: isChild ? 'child' : 'guardian',
    text,
  };
}

function isChildAudience(respondent) {
  return ['child', 'patient', 'self', '患儿', '患儿本人', '儿童本人'].includes(respondent);
}
