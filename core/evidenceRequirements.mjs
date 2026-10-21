// Single source for intake goals, minimum evidence and semantic requirements.
export const EVIDENCE_REQUIREMENTS_VERSION = '1.0.0';

// Both wire formats give the same semantic criteria to the model. These are
// predefined collection goals; whether the respondent's words meet them is an
// LLM judgment, not a keyword/date-pattern match in the state validator.
export const SEMANTIC_SUFFICIENCY_PROMPT = [
  '【最低证据的语义判断】由你结合原话和明确承接的上下文，逐项判断以下要求；不要求匹配固定词语、日期格式或精确数字。标准由goals给出，不自行增加必答项目。',
  '出现频率frequency：frequency_value是次数或频率，reference_window是这一次数对应的时间范围，两项分别判断。估计、区间和“几乎每个上学日”可以使用；只有“三次”而上下文没有范围时，reference_window不能met。',
  '时间范围可以用生活事件界定，例如“从运动会到期中考这段时间哭过三次”；不要求换算成天数。问题或历史明确提供且回答承接的范围，可以使用context_refs引用Q:轮次或A:轮次，但不能把问题假设当作已经发生的事实。',
  '具体事例recent_example/recent_episode：event_context是可辨认的一次相关事件情境，event_detail是该事件的关键行为、感受或经过，两项都满足才充分。“那次在家里”只有情境；“经常哭”不是一次具体事例；不强求具体日期、完整叙事或更长回答。',
  '开始时间onset_time：onset_anchor须明确指向困扰何时开始。大致时间、年龄阶段或事件锚点均可，例如“上幼儿园那会儿开始”“搬家以后才开始”。仅有最近一次发生时间、每次持续多久或频率范围，不能据此判定开始时间充分。',
  '有依据时返回met并引用支持证据；缺少必要内容返回unmet，无法判断返回unknown。只追缺失项，可合并本来源同一对象、同一困扰且时间兼容的跨轮证据；儿童简短表达不自动判为不足，情绪表达不替代事实。',
].join('\n');

const GOALS = Object.freeze({
  primary_concern: goal('主要困扰', '明确回答者当前最希望医生了解的一项困扰', '至少一项用回答者原话表达的主要困扰', 'narrative', 'both'),
  recent_example: goal('近期事例', '还原一个近期、具有代表性的具体事件', '事件发生的情境及经过；时间不确定可以保留', 'event', 'both'),
  manifestation_description: goal('具体表现', '了解困扰出现时可观察的言语、行为或本人感受', '至少一种具体表现，并区分观察、转述与本人体验', 'description', 'both'),
  recent_episode: goal('最近一次经过', '还原最近一次相关事件的发生经过', '最近一次事件中的情境、关键行为或感受', 'event', 'both'),
  onset_time: goal('开始时间', '获得困扰大致开始的时间锚点', '可核对的大致时间、年龄阶段或相关事件锚点', 'time', 'both'),
  course_pattern: goal('变化过程', '了解困扰随时间的变化方向或模式', '能够判断与此前相比的变化方向或模式；不确定时保留未知，具体类别在回答侧归一化', 'trend', 'both'),
  frequency: goal('出现频率', '获得带时间范围的出现频率', '次数或频率表达，并说明对应的时间范围', 'frequency', 'both'),
  severity_example: goal('严重程度', '通过最明显或影响最大的一次事件了解严重程度', '一个可观察的严重表现或造成的后果', 'severity', 'both'),
  impact_presence: goal('功能影响', '确认困扰是否已影响学习、学校、家庭、同伴或日常生活', '明确有无影响；阳性时由条件性影响事例目标继续采集', 'impact', 'both'),
  trigger_pattern: goal('诱发情境', '了解困扰出现前后的常见情境、事件或变化', '至少一个可能相关的前因或情境；不能确认时保留未知', 'context', 'both'),
  cross_setting_pattern: goal('跨场景差异', '比较困扰在不同场景中的表现是否一致', '至少两个场景的比较，并记录信息来源', 'comparison', 'both'),
  health_change_summary: goal('身心状态变化', '了解近期睡眠、食欲、精力或身体不适的变化', '明确有无变化；有变化时保留具体项目和表现', 'health_change', 'both'),
  development_medical_summary: goal('发育与躯体史', '了解与本次困扰相关的发育、既往疾病和当前健康信息', '相关病史或有依据地明确无相关情况；不知道另记未知', 'history', 'guardian_preferred'),
  help_received: goal('既往求助', '确认是否曾因当前困扰接受评估、咨询、训练、用药或其他帮助', '明确有无求助；如有，记录类型和已知效果', 'history', 'both'),
  family_context_summary: goal('家庭与照护背景', '了解与本次困扰相关的家庭、居住、照护变化或家族情况', '至少一项相关背景或有依据地明确无变化；不知道另记未知', 'family_context', 'guardian_preferred'),
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


const REQUIREMENTS = {
  primary_concern: [['concern', '一项可理解的主要困扰或求助重点']],
  manifestation_description: [['manifestation', '具体言语、行为或本人体验']],
  recent_example: [['event_context', '可辨认的相关事件情境'], ['event_detail', '事件中的关键行为、感受或经过']],
  recent_episode: [['event_context', '可辨认的最近相关事件'], ['event_detail', '该事件中的关键行为、感受或经过']],
  onset_time: [['onset_anchor', '明确指向开始的大致时间、年龄或事件锚点']],
  frequency: [['frequency_value', '所询问表现的次数或频率，允许估计或区间'], ['reference_window', '对应时间范围，可以由被明确承接的问答提供']],
  impact_presence: [['presence', '明确有无功能影响，保留观察范围']],
  impact_example: [['impact_detail', '至少一个实际功能影响或后果']],
  cross_setting_pattern: [['comparison', '至少两个场景的比较'], ['source_scope', '比较中各场景的信息来源或观察范围']],
};

export function evidenceContractFor(facet) {
  const definition = GOALS[facet.facetId] ?? CONDITIONAL_GOALS[facet.facetId] ?? goal(
    facet.label, '了解' + facet.label, '回答者有依据地提供' + facet.label + '，未知和拒答单独记录',
    facet.facetId === 'impact_example' ? 'impact' : 'description', 'both');
  return { ...definition, version: EVIDENCE_REQUIREMENTS_VERSION,
    requirements: (REQUIREMENTS[facet.facetId] ?? [['content', definition.minimumEvidence]])
      .map(([id, description]) => ({ id, description })),
    precision: '允许原文中的大致时间、估计值和区间；不得强行精确化',
    inheritance: '只可引用本来源已提供且对象、议题和时间兼容的证据；问题前提不是事实',
  };
}

function goal(label, informationGoal, minimumEvidence, answerShape, sourceScope) {
  return Object.freeze({ label, informationGoal, minimumEvidence, answerShape, sourceScope });
}
