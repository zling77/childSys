// A complaint label may help the clinician scan a case, but it must never
// decide which history domains are available to the family. Every initial
// intake uses this shared, non-diagnostic coverage model.
export const COVERAGE_DOMAIN = 'initial_intake_coverage';

export const intakeCoverageDomains = [
  {
    slotId: 'presenting_problem',
    label: '本次主要困扰',
    priority: 1,
    hints: ['最担心', '困扰', '问题', '变化', '最近一次', '主要是', '表现为'],
  },
  {
    slotId: 'current_manifestations',
    label: '具体表现',
    priority: 0.96,
    hints: ['哭', '闹', '发脾气', '摔', '打', '走神', '多动', '坐不住', '不说话', '不理人', '害怕', '担心', '情绪', '拒绝', '不愿', '不想上学', '发呆', '重复', '刻板', '自伤'],
  },
  {
    slotId: 'onset_course',
    label: '起始与变化过程',
    priority: 0.9,
    hints: ['开始', '从小', '以前', '后来', '最近', '至今', '持续', '加重', '好转', '反复', '时好时坏', '越来越'],
  },
  {
    slotId: 'frequency_severity',
    label: '频率、持续与程度',
    priority: 0.88,
    hints: ['每天', '每周', '每月', '经常', '偶尔', '有时', '几乎', '次', '回', '分钟', '小时', '严重', '轻微', '程度'],
  },
  {
    slotId: 'functional_impact',
    label: '学习生活与关系影响',
    priority: 0.94,
    hints: ['影响', '上学', '缺课', '迟到', '早退', '作业', '成绩', '学习', '生活', '自理', '朋友', '同伴', '关系', '冲突'],
  },
  {
    slotId: 'triggers_context',
    label: '诱因与近期背景',
    priority: 0.84,
    hints: ['因为', '每当', '只要', '之后', '之前', '一到', '一去', '送到', '刚到', '门口', '被批评', '压力', '考试', '欺负', '冲突', '搬家', '转学', '换老师', '变故', '诱因'],
  },
  {
    slotId: 'settings_and_sources',
    label: '不同场景与信息来源',
    priority: 0.86,
    hints: ['在家', '家里', '学校', '课堂', '同伴', '老师说', '老师反馈', '孩子说', '本人说', '家长觉得', '我们发现', '分别'],
  },
  {
    slotId: 'sleep_appetite_physical',
    label: '睡眠、食欲与躯体情况',
    priority: 0.82,
    hints: ['睡', '入睡', '早醒', '噩梦', '食欲', '胃口', '吃饭', '精力', '疲劳', '头痛', '头晕', '肚子疼', '腹痛', '呕吐', '胸闷', '心慌', '身体不舒服'],
  },
  {
    slotId: 'development_medical_history',
    label: '发育与躯体健康史',
    priority: 0.72,
    hints: ['出生', '早产', '发育', '说话', '走路', '退步', '疾病', '住院', '手术', '过敏', '癫痫', '脑外伤', '慢性病', '身体健康'],
  },
  {
    slotId: 'prior_help_treatment',
    label: '既往求助与干预',
    priority: 0.76,
    hints: ['看过医生', '就诊', '医院', '评估', '检查', '咨询', '心理', '训练', '干预', '治疗', '服药', '用药', '药物', '效果'],
  },
  {
    slotId: 'family_context_history',
    label: '家庭背景与家族情况',
    priority: 0.7,
    hints: ['父母', '爸爸', '妈妈', '祖父', '祖母', '爷爷', '奶奶', '外公', '外婆', '离异', '分居', '照护', '家庭关系', '家族', '亲属', '遗传'],
  },
  {
    slotId: 'safety_clues',
    label: '当前安全线索',
    priority: 0.92,
    hints: ['不想活', '想死', '想消失', '自伤', '伤害自己', '划伤', '割手', '撞墙', '打自己', '伤害别人', '杀人', '离家', '失踪', '危险'],
  },
  {
    slotId: 'goals_expectations',
    label: '本次求助诉求',
    priority: 0.68,
    hints: ['希望', '想让', '想知道', '帮助', '改善', '改变', '解决', '目标', '诉求', '期待'],
  },
  {
    slotId: 'strengths_protective',
    label: '优势与支持资源',
    priority: 0.66,
    hints: ['喜欢', '擅长', '优点', '兴趣', '朋友', '支持', '陪伴', '信任', '愿意', '能让他好', '有效', '缓解'],
  },
];

export const intakeCoverageMap = new Map(intakeCoverageDomains.map((domain) => [domain.slotId, domain]));

const legacyAliases = new Map(Object.entries({
  chief_problem: 'presenting_problem',
  open_narrative: 'presenting_problem',
  attention_priority: 'current_manifestations',
  inattention_detail: 'current_manifestations',
  school_refusal_priority: 'current_manifestations',
  emotion_priority: 'current_manifestations',
  inattention_symptoms: 'current_manifestations',
  hyperactivity_symptoms: 'current_manifestations',
  impulsivity_symptoms: 'current_manifestations',
  low_mood: 'current_manifestations',
  anxiety_worry: 'current_manifestations',
  interest_energy: 'current_manifestations',
  behavior: 'current_manifestations',
  emotional_reaction: 'current_manifestations',
  refusal_stage: 'current_manifestations',
  repetitive_behavior: 'current_manifestations',
  name_response: 'current_manifestations',
  eye_contact: 'current_manifestations',
  communication_mode: 'current_manifestations',
  joint_attention: 'current_manifestations',
  peer_play: 'current_manifestations',
  onset: 'onset_course',
  onset_time: 'onset_course',
  onset_age: 'onset_course',
  mood_onset: 'onset_course',
  mood_duration: 'onset_course',
  duration: 'frequency_severity',
  frequency: 'frequency_severity',
  attendance_2w: 'frequency_severity',
  academic_impact: 'functional_impact',
  family_social_impact: 'functional_impact',
  academic_social_impact: 'functional_impact',
  executive_function: 'functional_impact',
  family_school_context: 'triggers_context',
  school_triggers: 'triggers_context',
  school_refusal_trigger: 'triggers_context',
  emotion_trigger: 'triggers_context',
  trigger: 'triggers_context',
  relief_pattern: 'triggers_context',
  scene: 'settings_and_sources',
  scene_distribution: 'settings_and_sources',
  teacher_feedback: 'settings_and_sources',
  sleep_appetite: 'sleep_appetite_physical',
  somatic_symptoms: 'sleep_appetite_physical',
  language_development: 'development_medical_history',
  past_history: 'development_medical_history',
  medical_workup: 'development_medical_history',
  hearing_language_eval: 'development_medical_history',
  past_medication: 'prior_help_treatment',
  parent_response: 'family_context_history',
  family_response: 'family_context_history',
  self_harm_ideation: 'safety_clues',
  self_harm_related: 'safety_clues',
  mood_risk: 'safety_clues',
}));

export function resolveCoverageSlot(slotId, questionText = '') {
  const normalized = String(slotId ?? '').trim();
  if (intakeCoverageMap.has(normalized)) return normalized;
  if (legacyAliases.has(normalized)) return legacyAliases.get(normalized);
  return inferCoverageSlotFromText(questionText);
}

export function inferCoverageSlotFromText(text) {
  const raw = String(text ?? '');
  if (!raw) return null;
  const patterns = [
    ['safety_clues', /不想活|想死|想消失|自伤|伤害自己|伤害他人|离家|安全/],
    ['onset_course', /什么时候开始|从什么时候|多久了|变化过程|加重|好转|时好时坏/],
    ['frequency_severity', /多久一次|几次|频率|每次持续|最严重|程度/],
    ['functional_impact', /有什么影响|影响最明显|上学.*生活|学习.*关系/],
    ['triggers_context', /诱因|什么事情前后|什么情况下|最近.*变化|变得更明显/],
    ['settings_and_sources', /在家.*学校|学校.*在家|老师.*描述|分别怎么|场景/],
    ['sleep_appetite_physical', /睡眠|食欲|胃口|精力|身体不舒服|躯体/],
    ['development_medical_history', /早期发育|既往疾病|身体健康|出生|发育史/],
    ['prior_help_treatment', /看过医生|做过评估|咨询|训练|用药|干预|治疗/],
    ['family_context_history', /和谁生活|家庭关系|照护安排|家族中|家族史/],
    ['goals_expectations', /希望.*帮助|希望.*改变|就诊.*获得|诉求|目标/],
    ['strengths_protective', /喜欢或擅长|优点|优势|哪些人|哪些办法|支持/],
    ['current_manifestations', /具体说了什么|具体做了什么|具体表现|最近一次.*发生/],
    ['presenting_problem', /最希望医生|最想反映|主要困扰|最担心/],
  ];
  return patterns.find(([, pattern]) => pattern.test(raw))?.[0] ?? null;
}

export function matchedCoverageSlots(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return [];
  return intakeCoverageDomains
    .filter((domain) => domain.hints.some((hint) => raw.includes(hint)))
    .map((domain) => domain.slotId);
}

export function coverageRelevanceScore(slotId, text) {
  const domain = intakeCoverageMap.get(slotId);
  const raw = String(text ?? '');
  if (!domain || !raw) return 0;
  const hits = domain.hints.filter((hint) => raw.includes(hint)).length;
  return Math.min(1.15, hits * 0.32);
}

export function relatedCoverageSlots(slotId) {
  const relations = {
    presenting_problem: ['current_manifestations', 'onset_course'],
    current_manifestations: ['frequency_severity', 'functional_impact', 'triggers_context'],
    onset_course: ['frequency_severity', 'triggers_context'],
    frequency_severity: ['functional_impact', 'settings_and_sources'],
    functional_impact: ['settings_and_sources', 'goals_expectations'],
    triggers_context: ['settings_and_sources', 'family_context_history'],
    settings_and_sources: ['triggers_context', 'functional_impact'],
    sleep_appetite_physical: ['development_medical_history', 'current_manifestations'],
    development_medical_history: ['prior_help_treatment', 'family_context_history'],
    prior_help_treatment: ['goals_expectations', 'strengths_protective'],
    family_context_history: ['strengths_protective', 'triggers_context'],
    safety_clues: ['strengths_protective', 'prior_help_treatment'],
    goals_expectations: ['strengths_protective', 'functional_impact'],
    strengths_protective: ['goals_expectations', 'family_context_history'],
  };
  return relations[resolveCoverageSlot(slotId) ?? ''] ?? [];
}
