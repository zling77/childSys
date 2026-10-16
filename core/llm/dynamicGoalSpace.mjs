import { allowedActionsForTarget } from './followupStrategy.mjs';
import { getComplaintFocusOptions } from '../templates.mjs';

export const DYNAMIC_GOAL_SPACE_VERSION = '1.1.0';

// The former fixed questions are represented here only as information needs.
// Runtime candidates contain no ready-made question text.
const GOALS = Object.freeze({
  primary_concern: goal('主要困扰', '明确回答者当前最希望医生了解的一项困扰', '至少一项用回答者原话表达的主要困扰', 'narrative', 'both'),
  recent_example: goal('近期事例', '还原一个近期、具有代表性的具体事件', '事件发生的情境及经过；时间不确定可以保留', 'event', 'both'),
  manifestation_description: goal('具体表现', '了解困扰出现时可观察的言语、行为或本人感受', '至少一种具体表现，并区分观察、转述与本人体验', 'description', 'both'),
  recent_episode: goal('最近一次经过', '还原最近一次相关事件的发生经过', '最近一次事件中的情境、关键行为或感受', 'event', 'both'),
  onset_time: goal('开始时间', '获得困扰大致开始的时间锚点', '可核对的大致时间、年龄阶段或相关事件锚点', 'time', 'both'),
  course_pattern: goal('变化过程', '了解困扰随时间的变化方向或模式', '能够判断与此前相比的变化方向或模式；不确定时保留未知，具体类别在回答侧归一化', 'trend', 'both'),
  frequency: goal('出现频率', '获得带时间范围的出现频率', '次数或频率表达，并说明对应的时间范围', 'frequency', 'both'),
  severity_example: goal('严重程度', '通过最明显或影响最大的一次事件了解严重程度', '一个可观察的严重表现或造成的后果', 'severity', 'both'),
  impact_presence: goal('功能影响', '确认困扰是否已影响学习、学校、家庭、同伴或日常生活', '明确有无影响；如有，至少一个实际影响', 'impact', 'both'),
  trigger_pattern: goal('诱发情境', '了解困扰出现前后的常见情境、事件或变化', '至少一个可能相关的前因或情境；不能确认时保留未知', 'context', 'both'),
  cross_setting_pattern: goal('跨场景差异', '比较困扰在不同场景中的表现是否一致', '至少两个场景的比较，并记录信息来源', 'comparison', 'both'),
  health_change_summary: goal('身心状态变化', '了解近期睡眠、食欲、精力或身体不适的变化', '明确有无变化；有变化时保留具体项目和表现', 'health_change', 'both'),
  development_medical_summary: goal('发育与躯体史', '了解与本次困扰相关的发育、既往疾病和当前健康信息', '相关病史、明确无相关情况或回答者不知道', 'history', 'guardian_preferred'),
  help_received: goal('既往求助', '确认是否曾因当前困扰接受评估、咨询、训练、用药或其他帮助', '明确有无求助；如有，记录类型和已知效果', 'history', 'both'),
  family_context_summary: goal('家庭与照护背景', '了解与本次困扰相关的家庭、居住、照护变化或家族情况', '至少一项相关背景、明确无变化或回答者不知道', 'family_context', 'guardian_preferred'),
  current_safety_status: goal('当前安全状态', '核实当前自伤、自杀、伤人或离家失联相关事实', '当前想法、计划、行为与时间状态；进入专用安全流程', 'safety', 'both'),
  priority_goal: goal('本次优先目标', '明确回答者希望本次就诊优先帮助的一件事', '一项具体、可理解的就诊目标', 'goal', 'both'),
  protective_summary: goal('优势与支持', '了解优势、可信任的支持者及已有有效办法', '至少一项优势、支持者或有效应对办法', 'protective', 'both'),
});

// Optional evidence is never added to the required coverage contract. A caller
// may supply this target after a server-side, case-linked attention cue or the
// current respondent's own answer makes independent sleep evidence useful.
// The definition carries no other respondent's words, polarity or frequency.
const CONDITIONAL_GOALS = Object.freeze({
  sleep_change: goal(
    '睡眠情况',
    '独立了解当前回答者能够观察到的近期睡眠情况，儿童自诉时了解本人睡眠体验；不预设存在睡眠问题',
    '当前回答者自己提供的睡眠观察或本人体验；没有观察机会、不知道或不愿回答时保留未知，不要求猜测',
    'sleep_observation',
    'both',
  ),
});

export function buildDynamicGoal(target = {}, options = {}) {
  const facetId = String(target.targetFacetId ?? target.facetId ?? target.facet_id ?? '');
  const definition = GOALS[facetId] ?? CONDITIONAL_GOALS[facetId];
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

function goal(label, informationGoal, minimumEvidence, answerShape, sourceScope) {
  return Object.freeze({ label, informationGoal, minimumEvidence, answerShape, sourceScope });
}
