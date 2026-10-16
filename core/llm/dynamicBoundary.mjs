import { allowedActionsForTarget, targetKey } from './followupStrategy.mjs';

export function validateDynamicSelection({
  output,
  gaps = [],
  candidates = [],
  rejectedCandidates = [],
  ruleNextQuestion = null,
  speakerRole = 'guardian',
}) {
  if (!output || output.next_action !== 'ask' || !output.question) {
    return {
      ok: false,
      reason: output?.next_action === 'complete'
        ? '规则系统仍有待核实字段，大模型不能提前结束问诊。'
        : '大模型没有返回可用的单句问题。',
    };
  }

  const question = String(output.question).trim();
  const questionMarkCount = (question.match(/[？?]/g) ?? []).length;
  if (question.length > 80 || questionMarkCount !== 1 || !/[？?]$/.test(question)) {
    return { ok: false, reason: '动态追问必须是只包含一个问号的单句问题。' };
  }
  if (containsDispositionDirective(question)) {
    return { ok: false, reason: '动态追问包含处置、急诊、报警或治疗指令。' };
  }
  const audienceBoundary = validateAudience(question, speakerRole);
  if (!audienceBoundary.ok) return audienceBoundary;

  if (!ruleNextQuestion?.complaintId || !ruleNextQuestion?.targetSlotOrIssue) {
    return { ok: false, reason: '规则规划器没有提供兜底目标，保留规则问题。' };
  }
  if (ruleNextQuestion.targetSlotOrIssue === 'safety_clues') {
    return { ok: false, reason: '安全字段只使用规则系统的固定核实问题，不接受模型改写。' };
  }

  const rejectedKeys = new Set(rejectedCandidates.map(targetKey));
  const rawAllowed = candidates.length > 0 ? candidates : [ruleNextQuestion];
  const allowed = rawAllowed
    .filter((candidate) => candidate?.targetSlotOrIssue !== 'safety_clues')
    .filter((candidate) => !rejectedKeys.has(targetKey(candidate)))
    .filter((candidate) => Number(candidate.askedCount ?? 0) < Number(candidate.attemptLimit ?? Infinity));
  if (!allowed.some((candidate) => targetKey(candidate) === targetKey(ruleNextQuestion))) {
    allowed.unshift(ruleNextQuestion);
  }
  const selected = allowed.find((candidate) => (
    (candidate.complaintId ?? candidate.complaint_id) === output.complaint_id
      && (candidate.targetSlotOrIssue ?? candidate.slot_id) === output.target_slot_or_issue
      && (candidate.targetFacetId ?? candidate.facet_id ?? '') === (output.target_facet_id ?? '')
  ));
  if (!selected) {
    return { ok: false, reason: '大模型选择了本轮合法候选集合之外的字段。' };
  }

  const allowedActions = allowedActionsForTarget(selected);
  const actionType = output.action_type || allowedActions[0];
  if (!allowedActions.includes(actionType)) {
    return { ok: false, reason: '大模型选择的追问动作不适用于该字段。' };
  }
  for (const considered of output.considered_candidates ?? []) {
    const consideredTarget = allowed.find((candidate) => (
      (candidate.complaintId ?? candidate.complaint_id) === considered.complaint_id
        && (candidate.targetSlotOrIssue ?? candidate.slot_id) === considered.target_slot_or_issue
        && (candidate.targetFacetId ?? candidate.facet_id ?? '') === (considered.target_facet_id ?? '')
    ));
    if (!consideredTarget) {
      return { ok: false, reason: '候选比较记录包含本轮允许集合之外的字段。' };
    }
    if (considered.action_type
      && !allowedActionsForTarget(consideredTarget).includes(considered.action_type)) {
      return { ok: false, reason: '候选比较记录包含不适用的追问动作。' };
    }
  }

  const semanticBoundary = validateQuestionForTarget({
    question,
    target: selected,
    speakerRole,
  });
  if (!semanticBoundary.ok) return semanticBoundary;

  return {
    ok: true,
    target: {
      complaintId: selected.complaintId ?? selected.complaint_id,
      targetSlotOrIssue: selected.targetSlotOrIssue ?? selected.slot_id,
      targetFacetId: selected.targetFacetId ?? selected.facet_id ?? null,
      label: selected.label,
      facetLabel: selected.facetLabel,
      isCriticalRisk: false,
    },
    actionType,
    selectionReason: output.selection_reason || output.reason || '模型根据本轮状态选择合法候选。',
    consideredCandidates: output.considered_candidates ?? [],
  };
}

export function validateQuestionForTarget({ question, target, speakerRole = 'guardian' }) {
  const text = String(question ?? '').trim();
  const questionMarkCount = (text.match(/[？?]/g) ?? []).length;
  if (!text || text.length > 80 || questionMarkCount !== 1 || !/[？?]$/.test(text)) {
    return { ok: false, reason: '动态追问必须是只包含一个问号的单句问题。' };
  }
  if (containsDispositionDirective(text)) {
    return { ok: false, reason: '动态追问包含处置、急诊、报警或治疗指令。' };
  }
  const audienceBoundary = validateAudience(text, speakerRole);
  if (!audienceBoundary.ok) return audienceBoundary;
  if (target?.targetSlotOrIssue === 'safety_clues') {
    return { ok: false, reason: '安全字段只使用规则系统的固定核实问题，不接受模型改写。' };
  }
  if (target?.targetFacetId === 'course_pattern'
    && Number(target.askedCount ?? target.asked_count ?? 0) === 0
    && /是.{1,28}还是/.test(text)) {
    return { ok: false, reason: '变化过程首次询问应采用开放式时间比较，不使用二选一或多选一表达。' };
  }
  if (target?.targetFacetId && !questionMatchesFacet(text, target.targetFacetId)) {
    return { ok: false, reason: `动态追问语义与字段 ${target.targetFacetId} 不一致。` };
  }
  return { ok: true };
}

function validateAudience(question, speakerRole) {
  if (speakerRole === 'child') {
    const adultAddress = /您|家长|监护人|照护者|宝宝|小朋友|(?:妈妈|爸爸|父母).{0,8}(?:能|可以|请|说说|觉得|观察|介绍)/;
    const thirdPersonChildSubject = /(?:^|[，。；;\s])(?:他|她|患儿|儿子|女儿)(?:这|的|目前|现在|最近|大概|通常|出现|有|会|是)/;
    return adultAddress.test(question) || thirdPersonChildSubject.test(question)
      ? { ok: false, reason: '儿童端动态追问使用了面向成人或第三人称儿童的称谓。' }
      : { ok: true };
  }
  return /你/.test(question)
    ? { ok: false, reason: '监护人端动态追问使用了面向儿童的称谓。' }
    : { ok: true };
}

function questionMatchesFacet(question, facetId) {
  const text = String(question ?? '');
  const recentMarker = /最近|近期|上次|上一次|昨天|今天|前天|这几天|哪天/;
  const eventPrompt = /举|例子|一件|一次|发生了什么|当时.{0,10}(?:发生|说|做|感觉)|具体.{0,10}(?:事情|经过|表现|发生)/;
  const intervention = /看过医生|就诊|做过评估|评估过|接受过.{0,8}(?:咨询|训练|干预|治疗|帮助)|咨询过|训练过|干预过|治疗过|用过药|服过药|求助过|找过.{0,6}帮助/;

  if (facetId === 'recent_example' || facetId === 'recent_episode') {
    return recentMarker.test(text) && eventPrompt.test(text);
  }
  if (facetId === 'impact_presence') {
    return /影响|受影响|耽误|妨碍|受限|因此.{0,8}(?:不能|没法|困难)/.test(text);
  }
  if (facetId === 'help_received') {
    return intervention.test(text)
      || (/(?:以前|之前|曾经|曾|过去|此前)/.test(text)
        && /就医|评估|咨询|训练|干预|治疗|用药|服药|求助|帮助/.test(text));
  }
  if (facetId === 'priority_goal') {
    return /希望|最想|期待|目标|想要|想让/.test(text)
      && /改变|改善|解决|获得|帮助|医生|先/.test(text);
  }
  if (facetId === 'current_safety_status') {
    return /现在|目前|当前|眼下|此刻|最近|近期|今天|这几天|还(?:有|会|想)/.test(text)
      && mentionsSafetyFact(text);
  }
  if (facetId === 'cross_setting_pattern') {
    const setting = /家里|在家|学校|课堂|同伴|朋友|场景|地方|环境/;
    const comparison = /一样|不同|更明显|只在|仅在|主要在|分别|相比|哪边/;
    return setting.test(text) && comparison.test(text);
  }

  const patterns = {
    primary_concern: /最.{0,4}(?:担心|困扰|烦恼)|主要.{0,4}(?:困难|问题|变化)|最想.{0,6}(?:了解|帮助)/,
    manifestation_description: /具体.{0,8}(?:说|做|表现|感觉|情况)|说(?:了)?什么|做(?:了)?什么|发生了什么|什么表现|什么感觉/,
    onset_time: /从什么时候|什么时候开始|何时开始|多久前|有多久|多久了|最早|开始出现/,
    course_pattern: /加重|好转|时好时坏|变多|变少|没变|不变|稳定|反复|波动|越来越|(?:最近|近期|这段时间|后来|目前|现在).{0,12}(?:变化|改变|不一样|怎么样|如何)|(?:变化|改变|不一样).{0,12}(?:最近|近期|这段时间|后来|开始|最初|以前|之前)|(?:和|跟|比|相比).{0,12}(?:刚开始|开始时|最初|以前|之前)|(?:刚开始|开始时|最初|以前|之前).{0,12}(?:和|跟|比|相比)/,
    frequency: /几次|多久.{0,4}一次|频率|每天几|每周几|每月几/,
    severity_example: /最严重|最难受|最厉害|最糟|严重到|程度/,
    trigger_pattern: /之前|以后|前后|刚刚发生|什么情况下|什么原因|诱因|更容易出现/,
    health_change_summary: /睡眠|睡觉|食欲|吃饭|精力|精神|身体|不舒服/,
    sleep_change: /睡眠|睡觉|睡得|入睡|醒来|夜醒|早醒|睡着|晚上.{0,8}睡/,
    development_medical_summary: /发育|出生|疾病|住院|手术|过敏|身体健康/,
    family_context_summary: /家庭|家里|照护|照顾|一起生活|家族|亲属/,
    protective_summary: /优势|优点|喜欢|擅长|支持|谁能帮助|什么办法|好受|缓解/,
  };
  return patterns[facetId]?.test(text) ?? false;
}

function mentionsSafetyFact(question) {
  return /不想活|想死|想消失|自伤|自杀|伤害自己|伤害他人|伤害别人|离家|失联|不回来/.test(question);
}

function containsDispositionDirective(question) {
  const text = String(question ?? '');
  const alwaysProhibited = /报警|急诊|送医|拨打\s*(?:110|120)|\b(?:110|120)\b|急救|用药|吃药|停药|换药|治疗方案/;
  const imperativeAction = /(?:请|立刻|立即|马上|赶紧|尽快|务必|应当|应该|建议|需要|必须|最好|不要).{0,18}(?:就医|去医院|联系医生|联系老师|联系警方|陪同|陪着|看住|守着|收起|移走|拿走|锁好|处理|处置|危险物)/;
  const proposedAction = /(?:就医|去医院|去急诊|陪同|陪着|看住|守着|收起|移走|拿走|锁好).{0,5}(?:好吗|吧|要不要|是否需要)/;
  return alwaysProhibited.test(text) || imperativeAction.test(text) || proposedAction.test(text);
}
