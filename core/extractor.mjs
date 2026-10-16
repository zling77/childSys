import {
  COVERAGE_DOMAIN,
  intakeCoverageMap,
  matchedCoverageSlots,
  resolveCoverageSlot,
} from './coverage.mjs';
import { getFacetContract, getIntakeContract } from './intakeContracts.mjs';
import { classifyMentionPolarity } from './risk.mjs';

const explicitDenial = /^(?:没有|没|无|从来没有|从未|从没|未曾|未出现|否认)(?:了|过|这种情况|相关情况|相关问题|异常)?[。.!！]?$|(?:没有|否认|未出现).{0,8}(?:问题|异常|情况)/;

const answerPatterns = {
  presenting_problem: /困扰|担心|问题|变化|最近|主要|希望|孩子|他|她|学习|上学|情绪|行为|睡|吃|关系/,
  current_manifestations: /哭|闹|烦|怕|担心|发脾气|摔|打人|打自己|走神|多动|坐不住|发呆|不说话|不理人|拒绝|不愿|重复|刻板|自伤|说|做|表现|例如|比如|那次/,
  onset_course: /(?:从|在)?(?:\d+|[一二两三四五六七八九十半]+)(?:天|周|星期|个月|月|年)|什么时候|开始|从小|以前|后来|至今|持续|最近|加重|好转|反复|时好时坏|越来越|一直/,
  frequency_severity: /(?:每天|每周|每月|一周|一个月|经常|偶尔|有时|几乎|总是|很少)|(?:\d+|[一二两三四五六七八九十半]+)(?:次|回|分钟|小时|天)|严重|轻微|程度|频繁|多久一次/,
  functional_impact: /影响|耽误|不能|没法|缺课|迟到|早退|上学|作业|成绩|学习|生活|自理|朋友|同伴|关系|冲突|课堂/,
  triggers_context: /因为|每当|只要|一旦|之后|之前|时候|情况下|被批评|压力|考试|欺负|嘲笑|冲突|搬家|转学|换老师|变故|诱因|发生了/,
  settings_and_sources: /在家|家里|学校|课堂|同伴|朋友|老师|孩子自己|孩子说|本人|家长|我们发现|都这样|只在|分别/,
  sleep_appetite_physical: /睡|入睡|早醒|梦|食欲|胃口|吃饭|精力|疲劳|头痛|头晕|肚子疼|腹痛|呕吐|胸闷|心慌|身体|不舒服|体重/,
  development_medical_history: /出生|早产|足月|发育|说话|走路|退步|疾病|住院|手术|过敏|癫痫|脑外伤|慢性病|身体健康|病史|正常/,
  prior_help_treatment: /看过医生|就诊|医院|评估|检查|咨询|心理|训练|干预|治疗|服药|吃药|用药|药物|效果|求助/,
  family_context_history: /父母|爸爸|妈妈|祖父|祖母|爷爷|奶奶|外公|外婆|离异|分居|照护|家庭|家族|亲属|一起生活|带大|关系/,
  safety_clues: /不想活|想死|想消失|自伤|伤害自己|划伤|割手|撞墙|打自己|伤害别人|杀人|离家|失踪|危险|安全/,
  goals_expectations: /希望|想让|想知道|帮助|改善|改变|解决|目标|诉求|期待|弄清楚/,
  strengths_protective: /喜欢|擅长|优点|兴趣|朋友|支持|陪伴|信任|愿意|能让.{0,3}好|有效|缓解|安慰|关系好/,
};

const denialCompatibleSlots = new Set([
  'functional_impact',
  'sleep_appetite_physical',
  'development_medical_history',
  'prior_help_treatment',
  'family_context_history',
  'safety_clues',
]);

const facetAnswerPatterns = {
  presenting_problem: {
    primary_concern: answerPatterns.presenting_problem,
    recent_example: /最近一次|上一次|那次|有一次|例如|比如|当时|昨天|今天|前天|上周|一到|每次/,
  },
  current_manifestations: {
    manifestation_description: answerPatterns.current_manifestations,
    recent_episode: /最近一次|上一次|那次|有一次|当时|昨天|今天|前天|上周|一到|每次/,
  },
  onset_course: {
    // Incidental extraction is deliberately stricter than a targeted answer:
    // a generic phrase such as “最近一周” describes a measurement window, not
    // necessarily when the problem began.
    onset_time: /什么时候开始|何时开始|开始于|从小|起初|最早|以前|去年|今年|(?:从|在)?(?:\d+|[一二两三四五六七八九十半]+)(?:天|周|星期|个月|月|年)(?:前|以来|开始)/,
    course_pattern: /加重|好转|反复|时好时坏|越来越|变多|变少|一直|没变|不变|差不多|稳定|偶发|一阵一阵|不清楚|不知道/,
  },
  frequency_severity: {
    time_window: /最近(?:一|两|二|三|四|五|六|七|八|九|十|\d+)(?:天|周|个月|月)|近两周|这周|这个月|平时|通常/,
    frequency: /每天|每周|每月|经常|偶尔|有时|几乎|总是|很少|多久一次|(?:\d+|[二两三四五六七八九十半]+)(?:次|回)|(?:一周|每周|一天|每天|一个月|每月|大约|约|出现).{0,4}一次/,
    episode_duration: /持续|每次.{0,5}(?:\d+|[一二两三四五六七八九十半]+)(?:分钟|小时|天)|(?:\d+|[一二两三四五六七八九十半]+)(?:分钟|小时)/,
    severity_example: /最严重|严重|最难受|失控|哭|闹|摔|打人|打自己|自伤|离家|不能|没法|完全|特别厉害/,
  },
  functional_impact: {
    impact_presence: answerPatterns.functional_impact,
    affected_domains: /上学|学校|学习|课堂|作业|家庭|家里|朋友|同伴|生活|自理|活动/,
    impact_example: /最近一次|例如|比如|那次|缺课|迟到|早退|没交|冲突|不能|没法/,
  },
  triggers_context: {
    trigger_pattern: answerPatterns.triggers_context,
    recent_context_change: /最近.{0,12}(?:变化|搬家|转学|换老师|分居|离异|变故)|搬家|转学|换老师|家庭变故/,
  },
  settings_and_sources: {
    settings: /在家|家里|学校|课堂|同伴|朋友|社区|外面/,
    cross_setting_pattern: /都这样|只在|不一样|不同|一样|更明显|家里.{0,12}学校|学校.{0,12}家里/,
    informant_sources: /老师|孩子自己|孩子说|本人|家长|父母|照护者|我们发现/,
  },
  sleep_appetite_physical: {
    health_change_summary: answerPatterns.sleep_appetite_physical,
    sleep_change: /睡|入睡|早醒|夜醒|噩梦/,
    appetite_change: /食欲|胃口|吃饭|进食|体重/,
    energy_change: /精力|精神|疲劳|没力气/,
    physical_symptoms: /头痛|头晕|肚子疼|腹痛|呕吐|胸闷|心慌|身体|不舒服/,
  },
  development_medical_history: {
    development_medical_summary: answerPatterns.development_medical_history,
    development_history: /出生|早产|足月|发育|说话|走路|退步/,
    medical_history: /疾病|住院|手术|过敏|癫痫|脑外伤|慢性病|病史/,
    current_physical_health: /目前|现在|正在.{0,4}(?:看医生|治疗|用药)|身体健康/,
  },
  prior_help_treatment: {
    help_received: answerPatterns.prior_help_treatment,
    intervention_types: /医生|就诊|医院|评估|检查|咨询|心理|训练|干预|治疗|服药|吃药|用药/,
    treatment_response: /效果|好转|改善|没用|无效|副作用|不舒服/,
  },
  family_context_history: {
    family_context_summary: answerPatterns.family_context_history,
    living_arrangement: /和.{0,8}(?:住|生活)|一起生活|照顾|照护|带大/,
    recent_family_change: /最近.{0,12}(?:变化|搬家|分居|离异|照护)|搬家|分居|离异|换人照顾/,
    family_history: /家族|亲属|遗传|类似困难|也有|同样/,
  },
  safety_clues: {
    current_safety_status: answerPatterns.safety_clues,
    self_harm_or_suicide: /不想活|想死|想消失|自伤|伤害自己|划伤|割手|撞墙|打自己/,
    harm_to_others: /伤害别人|伤害他人|杀人|打死|严重伤人/,
    leaving_or_missing: /离家|失踪|失联|不回来|不回家/,
  },
  goals_expectations: {
    priority_goal: answerPatterns.goals_expectations,
    help_expectation: /医生|就诊|帮助|评估|建议|弄清楚|想知道/,
  },
  strengths_protective: {
    protective_summary: answerPatterns.strengths_protective,
    strengths_interests: /喜欢|擅长|优点|兴趣/,
    support_people: /朋友|家人|父母|老师|支持|陪伴|信任|求助/,
    helpful_strategies: /有效|缓解|安慰|好一些|有帮助|办法/,
  },
};

const targetFacetAnswerPatterns = {
  onset_course: {
    // When onset_time is the fixed target, concise answers such as “半年” are
    // valid even without repeating the word “开始”。
    onset_time: /(?:从|在)?(?:\d+|[一二两三四五六七八九十半]+)(?:天|周|星期|个月|月|年)(?:前|以来)?|什么时候|何时|开始|从小|以前|去年|今年|近期|最近/,
  },
  frequency_severity: {
    frequency: /每天|每周|每月|经常|偶尔|有时|几乎|总是|很少|多久一次|(?:\d+|[一二两三四五六七八九十半]+)(?:次|回)/,
  },
};

const explicitAbsencePatterns = {
  frequency_severity: {
    frequency: /^(?:没有|没|无|零)[。.!！]?$|一次都没有|一回都没有|没有出现|没出现|未出现|从未发生|没有发生|没发生|最近没有|这(?:周|个月)没有|为零|零次/,
  },
  functional_impact: {
    impact_presence: /(?:一点|任何|明显)?(?:的)?影响(?:都|也)?没有|没有(?:任何|明显)?影响|未受影响|不影响|没影响/,
  },
  sleep_appetite_physical: {
    health_change_summary: /(?:睡眠|睡觉|食欲|胃口|精力|身体).{0,8}(?:没有|没|无)(?:明显)?(?:变化|异常|问题|不适)|(?:睡眠|食欲|精力|身体)(?:都|也)?正常/,
    sleep_change: /(?:睡眠|睡觉|入睡|夜醒|早醒).{0,6}(?:没有|没|无)(?:明显)?变化|睡眠正常/,
    appetite_change: /(?:食欲|胃口|吃饭|进食).{0,6}(?:没有|没|无)(?:明显)?变化|(?:食欲|胃口)正常/,
    energy_change: /(?:精力|精神|力气).{0,6}(?:没有|没|无)(?:明显)?变化|精力正常/,
    physical_symptoms: /没有.{0,6}(?:身体不适|不舒服|疼痛)|身体(?:没有|没|无)(?:明显)?(?:不适|异常|问题)/,
  },
  development_medical_history: {
    development_medical_summary: /没有.{0,12}(?:需要医生知道|发育问题|重要病史|健康问题)|发育正常(?:，|,|、|和|且)?(?:没有|无)重要病史/,
    development_history: /发育正常|发育.{0,6}(?:没有|没|无)(?:异常|问题)/,
    medical_history: /没有.{0,8}(?:重要)?(?:疾病|住院|手术|过敏|病史)|无(?:重要)?病史/,
    current_physical_health: /目前.{0,6}(?:没有|没|无)(?:身体|健康)问题|身体健康|目前健康/,
  },
  prior_help_treatment: {
    help_received: /没有.{0,10}(?:看过医生|就诊|做过评估|接受过帮助|接受过干预|求助|治疗|用药)|从未.{0,8}(?:求助|就诊|评估|治疗|用药)|(?:求助|就诊|接受帮助)(?:的经历)?(?:都|也)?没有/,
  },
  family_context_history: {
    family_context_summary: /家庭.{0,8}(?:没有|没|无)(?:明显)?(?:变化|问题|异常)|没有.{0,10}(?:家庭|照护|家族).{0,4}(?:变化|问题|情况)/,
    recent_family_change: /(?:家庭|家里|居住|照护).{0,8}(?:没有|没|无)(?:明显)?变化|近期没有变化/,
    family_history: /家族中?(?:没有|无)|没有.{0,8}(?:家族史|类似困难|相关情况)/,
  },
};

const facetPolarityCues = {
  sleep_appetite_physical: {
    sleep_change: ['睡眠', '睡觉', '入睡', '早醒', '夜醒', '噩梦'],
    appetite_change: ['食欲', '胃口', '吃饭', '进食', '体重'],
    energy_change: ['精力', '精神', '疲劳', '力气'],
    physical_symptoms: ['头痛', '头晕', '肚子疼', '腹痛', '呕吐', '胸闷', '心慌', '身体不舒服'],
  },
  development_medical_history: {
    development_history: ['出生', '早产', '发育', '说话', '走路', '退步'],
    medical_history: ['疾病', '住院', '手术', '过敏', '癫痫', '脑外伤', '慢性病'],
    current_physical_health: ['目前', '现在', '身体健康'],
  },
  safety_clues: {
    self_harm_or_suicide: ['不想活', '想死', '想消失', '自伤', '伤害自己', '划伤', '割手', '撞墙', '打自己'],
    harm_to_others: ['伤害别人', '伤害他人', '杀人', '打死', '严重伤人'],
    leaving_or_missing: ['离家', '失踪', '失联', '不回来', '不回家'],
  },
};

export function createEvidenceUnits({ sessionId, turnNo, text, speakerRole, complaintIds, currentQuestion }) {
  const raw = String(text ?? '').trim();
  if (!raw) return [];
  const units = [];
  const seen = new Set();
  const source = speakerRole === 'child' ? 'child_self_report' : 'parent_report';

  const add = (
    slotId,
    confidence,
    reason = 'keyword',
    matchedHint = '',
    domain = COVERAGE_DOMAIN,
    targetFacetId = null,
  ) => {
    const key = `${domain}:${slotId}`;
    if (seen.has(key)) return;
    const defaultPolarity = classifyMentionPolarity(raw, matchedHint);
    const facetIds = inferEvidenceFacetIds(slotId, raw, {
      targetFacetId,
      reason,
      explicitAbsence: defaultPolarity === 'absent',
    });
    // matchedCoverageSlots intentionally uses broad recall-oriented hints. A
    // new extractor record, however, must identify at least one actual facet;
    // otherwise words such as “最近” would create false onset evidence.
    if (reason === 'coverage_keyword' && getIntakeContract(slotId) && facetIds.length === 0) return;
    seen.add(key);
    const facetPolarities = Object.fromEntries(facetIds.map((facetId) => [
      facetId,
      inferFacetPolarity(slotId, facetId, raw, defaultPolarity),
    ]));
    const polarity = aggregatePolarities(Object.values(facetPolarities), defaultPolarity);
    units.push({
      evidenceId: `E-${sessionId}-${turnNo}-${units.length + 1}`,
      sessionId,
      turnNo,
      source,
      speakerRole,
      domain,
      slotId,
      facetIds,
      timeScope: inferTimeScope(raw),
      polarity,
      value: { text: raw, reason, polarity, facetIds, facetPolarities },
      rawText: raw,
      confidence,
      createdAt: Date.now(),
    });
  };

  const targetSlot = resolveCoverageSlot(
    currentQuestion?.targetSlotOrIssue,
    currentQuestion?.text,
  );
  if (targetSlot && isAnswerRelevantToQuestion(raw, { ...currentQuestion, targetSlotOrIssue: targetSlot })) {
    const hints = intakeCoverageMap.get(targetSlot)?.hints ?? [];
    const matchedHint = hints.find((hint) => raw.includes(hint)) ?? '';
    add(targetSlot, 0.86, 'targeted_answer', matchedHint, COVERAGE_DOMAIN, currentQuestion?.targetFacetId);
  }

  // The opening narrative is itself evidence of the presenting problem. It may
  // also cover other domains when it contains concrete, domain-specific facts.
  if ((!currentQuestion || currentQuestion.policyType === 'open_narrative') && !isLowInformationAnswer(raw)) {
    add('presenting_problem', 0.9, 'opening_narrative');
  }

  for (const slotId of matchedCoverageSlots(raw)) {
    const hints = intakeCoverageMap.get(slotId)?.hints ?? [];
    const matchedHint = hints.find((hint) => raw.includes(hint)) ?? '';
    add(slotId, 0.74, 'coverage_keyword', matchedHint);
  }

  if (units.length === 0) {
    add('open_narrative', 0.5, 'unclassified_narrative', '', 'intake_narrative');
  }

  return units;
}

export function isAnswerRelevantToQuestion(raw, currentQuestion) {
  const text = String(raw ?? '').trim();
  if (!text) return false;
  const slotId = resolveCoverageSlot(
    currentQuestion?.targetSlotOrIssue,
    currentQuestion?.text,
  );
  if (!slotId) return false;
  if (isFacetExplicitAbsence(slotId, currentQuestion?.targetFacetId, text)) return true;
  const facetPattern = targetFacetAnswerPatterns[slotId]?.[currentQuestion?.targetFacetId]
    ?? facetAnswerPatterns[slotId]?.[currentQuestion?.targetFacetId];
  if (currentQuestion?.targetFacetId && facetPattern?.test(text) === true) return true;
  if (currentQuestion?.targetFacetId && isSubstantiveTargetedNarrative(currentQuestion.targetFacetId, text)) {
    return true;
  }
  if (explicitDenial.test(text)) {
    const facet = getFacetContract(slotId, currentQuestion?.targetFacetId);
    return facet?.type === 'boolean' || denialCompatibleSlots.has(slotId);
  }
  // Short answers such as “半年”“每天”“三次” are precise for a targeted
  // time/frequency question even though a generic length heuristic calls them
  // low-information. Check target semantics before that generic heuristic.
  if (currentQuestion?.targetFacetId) return false;
  if (answerPatterns[slotId]?.test(text)) return true;
  if (isLowInformationAnswer(text)) return false;
  return false;
}

export function inferEvidenceFacetIds(slotId, raw, options = {}) {
  const contract = getIntakeContract(slotId);
  if (!contract) return [];
  const text = String(raw ?? '').trim();
  const matched = [];
  const add = (facetId) => {
    if (getFacetContract(slotId, facetId) && !matched.includes(facetId)) matched.push(facetId);
  };

  if (options.targetFacetId) add(options.targetFacetId);
  for (const facet of contract.facets) {
    if (facetAnswerPatterns[slotId]?.[facet.facetId]?.test(text)) add(facet.facetId);
  }

  if (options.explicitAbsence && options.targetFacetId) add(options.targetFacetId);
  if (matched.length === 0 && options.reason === 'opening_narrative') add(contract.requiredFacets[0]);
  if (matched.length === 0 && options.reason === 'targeted_answer') add(contract.requiredFacets[0]);
  return matched;
}

function inferFacetPolarity(slotId, facetId, raw, defaultPolarity) {
  const text = String(raw ?? '');
  if (slotId === 'onset_course' && facetId === 'course_pattern') {
    if (/不清楚|不知道|说不准|看不出来/.test(text)) return 'uncertain';
    if (facetAnswerPatterns.onset_course.course_pattern.test(text)) return 'present';
  }
  if (slotId === 'safety_clues' && facetId === 'current_safety_status'
    && /(?:但|不过|可是).{0,12}(?:现在|目前|最近).{0,8}(?:没有了?|没了|不再|已经没有)/.test(text)) {
    return 'absent';
  }
  const direct = facetPolarityCues[slotId]?.[facetId];
  const isSummaryFacet = ['health_change_summary', 'development_medical_summary', 'current_safety_status']
    .includes(facetId);
  const cues = isSummaryFacet
    ? Object.values(facetPolarityCues[slotId] ?? {}).flat()
    : direct ?? (intakeCoverageMap.get(slotId)?.hints ?? []);
  const matchedPolarities = [...new Set(cues
    .filter((cue) => String(raw ?? '').includes(cue))
    .map((cue) => classifyFacetCuePolarity(slotId, facetId, raw, cue)))];
  if (matchedPolarities.length === 0 && isFacetExplicitAbsence(slotId, facetId, raw)) {
    return 'absent';
  }
  return aggregatePolarities(matchedPolarities, defaultPolarity);
}

function isSubstantiveTargetedNarrative(facetId, text) {
  const raw = String(text ?? '').trim();
  if (!raw || isLowInformationAnswer(raw)) return false;
  if (['primary_concern', 'priority_goal', 'protective_summary'].includes(facetId)) {
    return raw.length >= 4;
  }
  if (['recent_example', 'recent_episode'].includes(facetId)) {
    return raw.length >= 6
      && /了|当时|后来|然后|接着|先|把|老师|同学|家长|教室|回家|离开/.test(raw);
  }
  if (facetId === 'manifestation_description') {
    return raw.length >= 4 && /哭|闹|打|踢|撕|摔|扔|说|喊|躲|跑|拒绝|不理|发呆|走神|害怕|难受|把/.test(raw);
  }
  if (facetId === 'severity_example') {
    return raw.length >= 5
      && /哭|闹|打|踢|撕|摔|扔|伤|坏|失控|离开|不能|没法|当时|把|了/.test(raw)
      && !/^(?:最近)?(?:一|两|二|三|四|五|六|七|八|九|十|\d+)(?:天|周|月)?(?:一|两|二|三|四|五|六|七|八|九|十|\d+)?次[。.!！]?$/.test(raw);
  }
  return false;
}

function classifyFacetCuePolarity(slotId, facetId, raw, cue) {
  const text = String(raw ?? '');
  // These facets commonly express denial after the noun (“一次都没有” or
  // “一点影响都没有”), which the shared prefix-based risk classifier cannot
  // see. Keep this correction local so mixed safety statements retain their
  // per-cue present/absent behavior.
  if (
    ['frequency_severity:frequency', 'functional_impact:impact_presence'].includes(`${slotId}:${facetId}`)
    && isFacetExplicitAbsence(slotId, facetId, text)
  ) {
    return 'absent';
  }
  if (cueHasPostfixAbsence(text, cue)) return 'absent';
  return classifyMentionPolarity(text, cue);
}

function cueHasPostfixAbsence(text, cue) {
  let from = 0;
  while (from <= text.length) {
    const mentionAt = text.indexOf(cue, from);
    if (mentionAt < 0) return false;
    const suffix = text.slice(mentionAt + cue.length, mentionAt + cue.length + 14);
    if (
      /^(?:.{0,6})?(?:都|也)?(?:没有|没|无)(?:明显)?(?:变化|异常|问题|不适|出现|发生)/.test(suffix)
      || /^(?:.{0,4})?(?:都|也)?正常/.test(suffix)
    ) {
      return true;
    }
    from = mentionAt + Math.max(cue.length, 1);
  }
  return false;
}

function isFacetExplicitAbsence(slotId, facetId, raw) {
  if (!facetId) return false;
  const pattern = explicitAbsencePatterns[slotId]?.[facetId];
  return pattern?.test(String(raw ?? '').trim()) === true;
}

function aggregatePolarities(polarities, fallback = 'present') {
  if (polarities.includes('present')) return 'present';
  if (polarities.includes('uncertain')) return 'uncertain';
  if (polarities.includes('absent')) return 'absent';
  return fallback;
}

export function isLowInformationAnswer(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return true;
  // A short explicit denial may answer a yes/no history or safety question;
  // relevance to the particular question is checked separately above.
  if (/^(?:没有|没|无|从来没有|从未|从没|未曾|未出现|否认)(?:了|过|这种情况|相关情况|相关问题|异常)?[。.!！]?$/.test(text)) {
    return false;
  }
  if (text.length <= 4) return true;
  return [
    /不知道|不清楚|说不清|忘了|没注意/,
    /太多了|很多|都影响|都有|差不多|还行|一般/,
    /没有吧|可能吧|应该吧|不知道怎么说/,
  ].some((pattern) => pattern.test(text));
}

function inferTimeScope(raw) {
  const matches = raw.match(/最近[一二两三四五六七八九十0-9]+[天周个月年]|[一二两三四五六七八九十0-9]+[天周个月年]/);
  return matches?.[0] ?? null;
}
