export const FOLLOWUP_ACTIONS = Object.freeze([
  'explore',
  'clarify',
  'temporalize',
  'quantify',
  'impact',
  'verify_source',
]);

export function allowedActionsForTarget(target = {}) {
  const status = String(target.stateStatus ?? target.state_status ?? '');
  if (status === 'conflict' || status === 'ambiguous') return ['clarify'];

  const facetId = String(target.targetFacetId ?? target.facetId ?? target.facet_id ?? '');
  if (facetId === 'sleep_change') return ['explore', 'clarify', 'verify_source'];
  const primary = {
    onset_time: 'temporalize',
    course_pattern: 'temporalize',
    frequency: 'quantify',
    severity_example: 'quantify',
    impact_presence: 'impact',
    cross_setting_pattern: 'verify_source',
    help_received: 'explore',
    priority_goal: 'clarify',
  }[facetId] ?? 'explore';
  return primary === 'clarify' ? ['clarify', 'explore'] : [primary, 'clarify'];
}

export function respondentStrategyProfile(speakerRole, profile = {}) {
  const role = speakerRole === 'child' ? 'child' : 'guardian';
  const age = Number(profile.age);
  const ageBand = Number.isFinite(age) && age >= 6 && age <= 18
    ? age <= 11 ? '6-11' : age <= 14 ? '12-14' : '15-18'
    : 'unknown';

  if (role === 'guardian') {
    return {
      speaker_role: role,
      age_band: ageBand,
      content_scope: '优先询问家长可观察到的行为、变化、场景和时间；主观体验无法确认时保留为未知。',
      expression_style: '使用“您”和“孩子”，区分亲眼观察、他人转述和家长推测。',
    };
  }
  if (ageBand === '6-11') {
    return {
      speaker_role: role,
      age_band: ageBand,
      content_scope: '优先具体事件、日常活动和身体感受。',
      expression_style: '短句、儿童常用词、一次只问一件事，允许回答不知道。',
    };
  }
  if (ageBand === '12-14') {
    return {
      speaker_role: role,
      age_band: ageBand,
      content_scope: '优先事件、感受、同伴和学校情境。',
      expression_style: '先问具体经历再解释，核实儿童本人的用词。',
    };
  }
  return {
    speaker_role: role,
    age_band: ageBand,
    content_scope: '优先本人困扰、主观体验和功能影响。',
    expression_style: '协商重点，允许较完整叙述，必要时再量化。',
  };
}

export function classifyResponseSignal(answerText) {
  const text = String(answerText ?? '').trim();
  if (/不想说|不想回答|不愿(?:意)?说|拒绝回答/.test(text)) return 'declined';
  if (/没听懂|什么意思|不明白|听不懂/.test(text)) return 'misunderstood';
  if (/不知道|不清楚|说不清|记不清|忘了|不确定/.test(text)) return 'uncertain';
  return text ? 'substantive' : 'empty';
}

export function targetKey(target = {}) {
  const complaint = target.complaintId ?? target.complaint_id ?? '';
  const slot = target.targetSlotOrIssue ?? target.slotId ?? target.slot_id ?? '';
  const facet = target.targetFacetId ?? target.facetId ?? target.facet_id ?? '';
  return `${complaint}:${slot}:${facet}`;
}
