// Complaint groupings are scan tags plus optional focus goals. They contain
// no ready-made interview questions and never define a fixed questionnaire.
const focus = (focusId, label, targetSlotOrIssue, targetFacetId, informationNeed, cues = []) => ({
  focusId,
  label,
  targetSlotOrIssue,
  targetFacetId,
  informationNeed,
  cues,
});

export const complaintTemplates = [
  {
    complaintId: 'attention_hyperactivity_impulsivity',
    name: '注意力、多动冲动与学习执行功能问题',
    triggerKeywords: ['多动', '坐不住', '注意力', '走神', '小动作', '冲动', '插嘴', '作业拖拉', '粗心', '丢三落四', '成绩', '听讲', '不认真听讲', '上课不认真', '课堂', '发呆'],
    focusAreas: [
      focus('onset_time', '问题开始时间', 'onset_course', 'onset_time', '获得注意力、多动或冲动表现开始明显的时间锚点', ['开始', '从小', '最近']),
      focus('scene_distribution', '场景分布', 'settings_and_sources', 'cross_setting_pattern', '比较相关表现是否跨学校、家庭及同伴场景出现', ['学校', '家里', '同伴']),
      focus('teacher_feedback', '老师观察', 'settings_and_sources', 'cross_setting_pattern', '记录老师观察到的课堂表现及具体任务情境', ['老师', '课堂', '上课']),
      focus('inattention_symptoms', '注意力表现', 'current_manifestations', 'manifestation_description', '获得粗心、漏题、听指令或容易分心等具体表现', ['粗心', '漏题', '走神', '分心']),
      focus('hyperactivity_symptoms', '活动水平表现', 'current_manifestations', 'manifestation_description', '获得坐不住、离座、小动作或持续活动等具体表现', ['坐不住', '离座', '小动作', '多动']),
      focus('impulsivity_symptoms', '冲动表现', 'current_manifestations', 'manifestation_description', '获得插话、等待困难、冲撞或鲁莽行为的具体表现', ['插嘴', '抢话', '排队', '冲动']),
      focus('executive_function', '任务执行情况', 'functional_impact', 'impact_presence', '了解计划步骤、持续完成任务及所需提醒方面的实际影响', ['作业', '拖拉', '步骤', '提醒']),
      focus('academic_impact', '学习影响', 'functional_impact', 'impact_presence', '了解相关表现对作业、课堂或成绩造成的实际影响', ['学习', '作业', '成绩']),
      focus('family_social_impact', '关系影响', 'functional_impact', 'impact_presence', '了解相关表现对亲子、师生或同伴关系造成的实际影响', ['家长', '老师', '同伴', '关系']),
    ],
    optionalFocusIds: ['sleep_status', 'screen_use', 'exercise', 'tic_symptoms', 'past_medication'],
    outputSections: ['timeline', 'core_symptoms', 'cross_setting_consistency', 'functional_impairment', 'comorbid_clues', 'open_issues'],
  },
  {
    complaintId: 'social_communication_repetitive_behavior',
    name: '社交沟通困难、刻板行为与发育相关问题',
    triggerKeywords: ['孤僻', '不理人', '不和小朋友玩', '叫名不应', '眼神少', '自顾玩', '重复语言', '刻板', '转圈', '踮脚', '固定路线', '语言发育'],
    focusAreas: [
      focus('onset_age', '出现年龄', 'onset_course', 'onset_time', '获得社交或沟通表现开始明显的大致年龄', ['几岁', '小时候', '开始']),
      focus('name_response', '叫名回应', 'current_manifestations', 'manifestation_description', '了解被叫名字时是否及如何回应', ['叫名', '名字', '回应']),
      focus('eye_contact', '目光交流', 'current_manifestations', 'manifestation_description', '了解交流时目光接触的具体表现', ['眼神', '目光', '对视']),
      focus('communication_mode', '需求表达', 'current_manifestations', 'manifestation_description', '了解表达需求时使用语言、手势、拉人或哭闹等方式', ['表达', '说话', '手指', '拉人']),
      focus('joint_attention', '共同注意', 'current_manifestations', 'manifestation_description', '了解是否会主动分享物品或邀请他人共同关注', ['分享', '一起看', '拿给']),
      focus('peer_play', '同伴互动', 'settings_and_sources', 'cross_setting_pattern', '了解与同伴共同游戏和协商玩法的具体情况', ['同伴', '小朋友', '一起玩']),
      focus('repetitive_behavior', '重复与刻板行为', 'current_manifestations', 'manifestation_description', '了解重复兴趣、固定路线、固定食物或重复动作', ['重复', '刻板', '固定', '转圈', '踮脚']),
      focus('language_development', '语言发育', 'development_medical_history', 'development_medical_summary', '了解语言发展节奏及是否出现能力倒退', ['语言', '说话', '退步']),
    ],
    optionalFocusIds: ['sensory_features', 'change_tolerance', 'self_care', 'screen_exposure', 'hearing_language_eval'],
    outputSections: ['social_reciprocity', 'nonverbal_communication', 'language_timeline', 'repetitive_behavior', 'open_issues'],
  },
  {
    complaintId: 'mood_anxiety_selfharm',
    name: '情绪低落、焦虑担心与自伤风险相关问题',
    triggerKeywords: ['情绪低', '低落', '焦虑', '担心', '脑子乱', '哭', '没希望', '没用', '兴趣下降', '睡眠差', '心慌', '自伤', '划伤', '不想活', '想消失'],
    focusAreas: [
      focus('mood_onset', '情绪起始', 'onset_course', 'onset_time', '获得低落、焦虑或明显波动开始的时间锚点', ['开始', '最近', '多久']),
      focus('mood_duration', '情绪持续与规律', 'onset_course', 'course_pattern', '了解情绪状态的持续、反复及与事件的关系', ['每天', '持续', '遇到事情']),
      focus('low_mood', '低落表现', 'current_manifestations', 'manifestation_description', '了解难过、哭泣、自我否定或悲观的具体表现', ['难过', '哭', '没用', '悲观']),
      focus('anxiety_worry', '担心内容', 'current_manifestations', 'manifestation_description', '了解反复担心的内容、情境和本人表述', ['担心', '焦虑', '学习', '人际']),
      focus('interest_energy', '兴趣与精力', 'sleep_appetite_physical', 'health_change_summary', '了解兴趣、精力和疲劳相对平时的变化', ['兴趣', '精力', '疲劳']),
      focus('sleep_appetite', '睡眠食欲与躯体反应', 'sleep_appetite_physical', 'health_change_summary', '了解睡眠、食欲和伴随身体不适的变化', ['睡眠', '食欲', '头晕', '心慌']),
      focus('academic_social_impact', '学习与人际影响', 'functional_impact', 'impact_presence', '了解情绪困扰对上学、作业、朋友及家庭关系的实际影响', ['上学', '作业', '朋友', '家里']),
      focus('self_harm_ideation', '自伤自杀线索', 'safety_clues', 'current_safety_status', '核实当前死亡愿望、自伤想法与行为事实', ['不想活', '想消失', '自伤']),
      focus('manic_screen', '异常兴奋线索', 'current_manifestations', 'manifestation_description', '了解是否出现明显兴奋、话多、精力异常增高及睡眠需求减少的成组变化', ['兴奋', '话多', '精力旺盛', '睡很少']),
    ],
    optionalFocusIds: ['somatic_symptoms', 'family_school_events', 'rumination'],
    outputSections: ['mood_timeline', 'core_symptoms', 'functional_impairment', 'risk_notes', 'open_issues'],
  },
  {
    complaintId: 'emotion_regulation_impulsivity',
    name: '情绪调节困难与冲动行为问题',
    triggerKeywords: ['情绪脆弱', '情绪不稳', '哭闹', '发脾气', '摔东西', '打人', '打自己', '冲动', '敏感', '委屈', '愤怒', '咬嘴唇', '抠手'],
    focusAreas: [
      focus('onset', '出现时间', 'onset_course', 'onset_time', '获得情绪爆发或冲动行为开始明显的时间锚点', ['从小', '最近', '开始']),
      focus('trigger', '常见诱因', 'triggers_context', 'trigger_pattern', '了解情绪爆发前常见事件或情境', ['因为', '之前', '诱因']),
      focus('frequency', '出现频率', 'frequency_severity', 'frequency', '获得带时间范围的情绪爆发次数', ['每周', '几次', '频率']),
      focus('duration', '单次持续时间', 'frequency_severity', 'frequency', '了解每次情绪爆发持续及恢复所需时间', ['持续', '多久', '平复']),
      focus('behavior', '爆发行为', 'current_manifestations', 'manifestation_description', '了解爆发时哭闹、破坏、攻击、伤害自己或离开等具体行为', ['哭闹', '摔', '打人', '伤害自己']),
      focus('recovery', '恢复后反应', 'current_manifestations', 'recent_episode', '了解平静后的认识、后悔或恢复表现', ['平静', '后悔', '恢复']),
      focus('scene', '发生场景', 'settings_and_sources', 'cross_setting_pattern', '比较情绪问题在家庭、学校和同伴场景中的差异', ['家里', '学校', '同伴']),
      focus('family_response', '家庭应对', 'family_context_history', 'family_context_summary', '了解家人在事件中的实际应对方式及一致性', ['家人', '劝说', '争吵', '让步']),
      focus('self_harm_related', '安全相关行为', 'safety_clues', 'current_safety_status', '核实当前自伤、伤人、死亡愿望或严重破坏行为', ['自伤', '伤人', '不想活', '破坏']),
    ],
    optionalFocusIds: ['management_consistency', 'depressive_features', 'sleep_fatigue'],
    outputSections: ['emotion_pattern', 'trigger_frequency_duration', 'family_response', 'risk_notes', 'open_issues'],
  },
  {
    complaintId: 'school_refusal',
    name: '上学困难 / 拒学与学校适应问题',
    triggerKeywords: ['不愿上学', '不想上学', '回避学校', '去学校哭', '校门口', '呕吐', '腹痛', '胸口痛', '头晕', '缺课', '迟到', '早退', '请假'],
    focusAreas: [
      focus('onset', '拒学起始', 'onset_course', 'onset_time', '获得上学困难开始的时间锚点', ['开始', '什么时候', '最近']),
      focus('attendance_2w', '近期出勤', 'frequency_severity', 'frequency', '获得近期缺课、迟到或早退的实际次数及时间范围', ['缺课', '迟到', '早退', '请假']),
      focus('refusal_stage', '困难阶段', 'current_manifestations', 'manifestation_description', '了解困难主要发生在起床、出门、校门口或进入教室等阶段', ['起床', '出门', '校门口', '教室']),
      focus('emotional_reaction', '上学相关情绪反应', 'current_manifestations', 'manifestation_description', '了解提到或接近上学时出现的情绪与行为反应', ['哭', '害怕', '烦躁', '生气']),
      focus('somatic_symptoms', '上学相关身体不适', 'sleep_appetite_physical', 'health_change_summary', '了解与上学情境相关的疼痛、呕吐、头晕或胸闷等身体表现', ['腹痛', '呕吐', '头晕', '胸闷']),
      focus('relief_pattern', '离校后变化', 'triggers_context', 'trigger_pattern', '了解离开学校或留在家后相关情绪和身体表现是否变化', ['回家', '离校', '缓解', '好转']),
      focus('school_triggers', '学校相关事件', 'triggers_context', 'trigger_pattern', '了解考试、师生关系、同伴冲突、嘲笑或欺负等可能相关事件', ['考试', '老师', '同学', '欺负']),
      focus('parent_response', '家长应对', 'family_context_history', 'family_context_summary', '了解家长面对上学困难时的实际处理方式', ['劝说', '送学', '请假', '陪伴', '争吵']),
      focus('mood_risk', '伴随情绪与安全线索', 'safety_clues', 'current_safety_status', '核实当前明显低落、自伤或死亡愿望相关事实', ['低落', '自伤', '不想活', '想消失']),
    ],
    optionalFocusIds: ['peer_teacher_relation', 'learning_difficulty', 'home_activities', 'medical_workup'],
    outputSections: ['timeline', 'attendance_impairment', 'somatic_symptoms', 'school_context', 'family_response', 'risk_notes', 'open_issues'],
  },
  {
    complaintId: 'generic_behavioral_health',
    name: '通用心理行为问题入口',
    triggerKeywords: ['其他', '不知道', '说不清', '问题', '行为', '心理', '变化'],
    focusAreas: [
      focus('chief_problem', '主要困扰', 'presenting_problem', 'primary_concern', '明确当前最希望医生了解或帮助的一项问题', ['困扰', '问题', '帮助']),
      focus('onset', '开始时间', 'onset_course', 'onset_time', '获得当前情况开始的时间锚点', ['开始', '多久']),
      focus('frequency', '出现频率', 'frequency_severity', 'frequency', '获得带时间范围的出现次数或频率', ['每周', '每月', '几次']),
      focus('scene_distribution', '发生场景', 'settings_and_sources', 'cross_setting_pattern', '比较家庭、学校和同伴场景中的表现', ['家里', '学校', '同伴']),
      focus('functional_impact', '主要影响', 'functional_impact', 'impact_presence', '了解当前问题对上学或日常生活造成的实际影响', ['影响', '上学', '生活']),
      focus('family_school_context', '近期背景', 'triggers_context', 'trigger_pattern', '了解近期家庭或学校中可能使问题更明显的事件', ['家里', '学校', '变化']),
    ],
    optionalFocusIds: ['past_history', 'development_history', 'daily_life'],
    outputSections: ['chief_complaint_summary', 'timeline', 'functional_impairment', 'open_issues'],
  },
];

export const complaintTemplateMap = new Map(complaintTemplates.map((template) => [template.complaintId, template]));

export function getTemplate(complaintId) {
  return complaintTemplateMap.get(complaintId);
}

export function getComplaintFocusOptions(complaintIds = [], target = {}, latestAnswer = '') {
  const ids = [...new Set((complaintIds ?? []).filter(Boolean))];
  if (ids.length === 0) ids.push('generic_behavioral_health');
  const slotId = target.targetSlotOrIssue ?? target.slotId ?? target.slot_id;
  const facetId = target.targetFacetId ?? target.facetId ?? target.facet_id;
  const answer = String(latestAnswer ?? '');
  return ids.flatMap((complaintId) => {
    const template = complaintTemplateMap.get(complaintId);
    return (template?.focusAreas ?? [])
      .filter((item) => item.targetSlotOrIssue === slotId && item.targetFacetId === facetId)
      .map((item) => ({
        complaintId,
        focusId: item.focusId,
        label: item.label,
        informationNeed: item.informationNeed,
        relevance: item.cues.reduce((score, cue) => score + (answer.includes(cue) ? 1 : 0), 0),
      }));
  }).sort((left, right) => right.relevance - left.relevance || left.focusId.localeCompare(right.focusId));
}

export function listTemplateRows() {
  return complaintTemplates.map((template) => ({
    complaint_id: template.complaintId,
    version: 'v2.0-goal-space',
    name: template.name,
    config_json: JSON.stringify(template),
  }));
}
