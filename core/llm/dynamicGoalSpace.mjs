import { allowedActionsForTarget } from './followupStrategy.mjs';
import { getComplaintFocusOptions } from '../templates.mjs';
import { intakeContracts } from '../intakeContracts.mjs';

const GOALS = Object.fromEntries(intakeContracts.flatMap(c => c.requiredFacets.map(id => [id, c.facets.find(f => f.facetId === id).evidenceContract])));
const CONDITIONAL_GOALS = Object.fromEntries(intakeContracts.flatMap(c => c.facets.filter(f => f.facetId === 'sleep_change' || f.semanticRequiredWhen).map(f => [f.facetId, f.evidenceContract])));

export const DYNAMIC_GOAL_SPACE_VERSION = '1.1.0';

// The former fixed questions are represented here only as information needs.
// Runtime candidates contain no ready-made question text.
export function buildDynamicGoal(target = {}, options = {}) {
  const facetId = String(target.targetFacetId ?? target.facetId ?? target.facet_id ?? '');
  const definition = GOALS[facetId] ?? CONDITIONAL_GOALS[facetId] ?? intakeContracts.flatMap(c => c.facets).find(f => f.facetId === facetId)?.evidenceContract;
  if (!definition) return null;
  return {
    complaintId: target.complaintId ?? target.complaint_id,
    targetSlotOrIssue: target.targetSlotOrIssue ?? target.slotId ?? target.slot_id,
    targetFacetId: facetId,
    facetLabel: target.facetLabel ?? target.label ?? definition.label,
    stateStatus: target.stateStatus ?? target.state_status,
    askedCount: Number(target.askedCount ?? 0),
    attemptLimit: Number(target.attemptLimit ?? 2),
    relevanceToLatestAnswer: Number(target.relevanceToLatestAnswer ?? 0),
    relatedToPreviousAnswer: target.relatedToPreviousAnswer === true,
    independentElicitation: target.independentElicitation === true,
    ...(target.score != null && Number.isFinite(Number(target.score))
      ? { score: Number(target.score) }
      : {}),
    selectionReason: target.selectionReason ?? target.selection_reason,
    informationGoal: definition.informationGoal,
    minimumEvidence: definition.minimumEvidence,
    answerShape: definition.answerShape,
    sourceScope: definition.sourceScope,
    missingRequirements: target.missingRequirements ?? [],
    responseState: target.responseState ?? null,
    allowedActions: allowedActionsForTarget(target),
    focusOptions: target.focusOptions?.length
      ? target.focusOptions.slice(0, 6)
      : options.complaintIds?.length
        ? getComplaintFocusOptions(
            options.complaintIds,
            target,
            options.latestAnswer,
          ).slice(0, 6)
        : [],
    goalSpaceVersion: DYNAMIC_GOAL_SPACE_VERSION,
  };
}

export function buildDynamicGoalSpace(targets = [], options = {}) {
  return targets.map((target) => buildDynamicGoal(target, options)).filter(Boolean);
}

export function dynamicGoalDefinitions({ includeConditional = false } = {}) {
  const definitions = includeConditional ? { ...GOALS, ...CONDITIONAL_GOALS } : GOALS;
  return Object.entries(definitions).map(([facetId, definition]) => ({ facetId, ...definition }));
}

// This is used only when a generative call is unavailable or rejected. It is
// composed from the selected goal type and respondent profile, never copied
// from a complaint or facet question bank.
export function realizeGoalFallback(target = {}, { speakerRole = 'guardian', clarification = false } = {}) {
  const goalTarget = target.informationGoal ? target : buildDynamicGoal(target);
  if (!goalTarget) return null;
  const child = speakerRole === 'child';
  if (goalTarget.targetFacetId === 'frequency' && goalTarget.missingRequirements?.length === 1
    && goalTarget.missingRequirements[0] === 'reference_window') {
    return child ? '你刚才说的次数，是多长一段时间里发生的？' : '您刚才说的次数，是多长一段时间内发生的？';
  }
  const subject = child ? '你' : '孩子';
  const guardianLead = child ? '' : '您能根据自己观察到的情况，';
  const prompts = {
    narrative: child ? '现在最让你烦恼、想请医生帮忙的一件事是什么？' : '目前最让您担心、想请医生先了解的一项困难是什么？',
    event: `${guardianLead}说一件最近发生、能说明“${goalTarget.facetLabel}”的具体事情吗？`,
    description: `${guardianLead}具体说说${subject}当时有什么表现吗？`,
    time: `${guardianLead}说说${subject}大概从什么时候开始出现这个情况吗？`,
    trend: child ? '和刚开始时比，这个情况最近有什么不一样吗？' : '和刚开始时相比，这种情况最近有什么变化吗？',
    frequency: `${guardianLead}说说这个情况在最近一段时间大约出现几次吗？`,
    severity: `${guardianLead}说一件这个情况最严重时发生的具体事情吗？`,
    impact: `${guardianLead}说说这个情况目前是否影响了${subject}的日常生活吗？`,
    context: `${guardianLead}说说这个情况通常在什么事情前后更明显吗？`,
    family_context: child ? '说说家里或照顾你的安排中，目前需要医生了解的一件事吗？' : '您能说说家庭、居住或照护安排中，目前需要医生了解的一件事吗？',
    comparison: `${guardianLead}比较一下这个情况在家里和学校是否有不同吗？`,
    health_change: `${guardianLead}说说${subject}近期睡眠、食欲、精力或身体感觉有无变化吗？`,
    sleep_observation: child ? '最近晚上，你睡得怎么样？' : '最近孩子晚上的睡眠，您能观察到哪些情况？',
    history: `${guardianLead}说说与“${goalTarget.facetLabel}”有关、目前能确认的情况吗？`,
    goal: child ? '你希望这次先请医生帮助你解决哪一件事？' : '您希望这次先请医生帮助孩子解决哪一件事？',
    protective: child ? '遇到困难时，谁或什么办法能让你好受一些？' : '孩子遇到困难时，谁或什么办法能帮助孩子好一些？',
  };
  const question = prompts[goalTarget.answerShape] ?? `${guardianLead}说说与“${goalTarget.facetLabel}”有关的具体情况吗？`;
  if (!clarification) return question;
  if (goalTarget.answerShape === 'sleep_observation') {
    const support = child ? '不记得或不想说也没关系，' : '没观察到也可以说不知道；';
    return `${support}${question}`;
  }
  const lead = child ? '如果一时想不准，可以先回想最近一次：' : '如果时间不容易确定，可以先按最近一次回想：';
  return `${lead}${question}`;
}
