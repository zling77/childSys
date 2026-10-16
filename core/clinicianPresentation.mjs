import { classifyMentionPolarity, riskRules } from './risk.mjs';

export const evidenceCategories = [
  { id: 'presenting', label: '主诉与具体表现', description: '本次困扰、行为与本人感受', slots: ['presenting_problem', 'current_manifestations'] },
  { id: 'course', label: '时间与变化过程', description: '开始时间、频率、持续与变化', slots: ['onset_course', 'frequency_severity'] },
  { id: 'impact', label: '学习生活与场景', description: '出勤、学习、人际及场景差异', slots: ['functional_impact', 'settings_and_sources'] },
  { id: 'physical', label: '睡眠、食欲与躯体', description: '睡眠、食欲、精力与身体不适', slots: ['sleep_appetite_physical'] },
  { id: 'background', label: '背景与既往情况', description: '近期背景、家庭、发育及求助史', slots: ['triggers_context', 'family_context_history', 'development_medical_history', 'prior_help_treatment'] },
  { id: 'safety', label: '安全线索与支持', description: '安全原话、求助目标与支持资源', slots: ['safety_clues', 'goals_expectations', 'strengths_protective'] },
];
export const riskScopeLabels = { reported: '已报告线索', uncertain: '待核实', denied: '否认陈述', not_observed: '未观察到', discrepancy: '候选分歧' };
const riskLabels = { suicide: '死亡／消失想法', self_harm: '自伤相关原话', harm_other: '他伤相关原话', abuse: '受虐相关原话', bullying: '欺凌相关原话', psychotic_like: '异常感知相关原话' };
const keyOf = unit => [unit.sourceIdentity ?? unit.sessionId ?? unit.materialId, unit.inputRound, unit.slotId, unit.traceText ?? unit.claim, unit.referenced_time_span?.raw_text].join('|');

// Keep the original rule evidence and model evidence accessible. Deduplicate only exact display repetitions.
export function combineCurrentEvidence(ruleUnits = [], modelUnits = []) {
  return [...new Map([...ruleUnits, ...modelUnits].filter(unit => !unit.superseded).map(unit => [keyOf(unit), unit])).values()];
}
export function groupClinicianEvidence(units) {
  return evidenceCategories.map(category => {
    const members = units.filter(unit => category.slots.includes(unit.slotId));
    return { ...category, units: members, topics: [...new Set(members.map(unit => unit.slotId))].map(slotId => ({ slotId, label: members.find(unit => unit.slotId === slotId).topicLabel, units: members.filter(unit => unit.slotId === slotId) })) };
  });
}

export function clinicianRiskLabels(units, relations = []) {
  const tags = new Map();
  const add = (kind, scope, label, unit, note = '', relationId = null) => {
    const id = `${kind}:${scope}`;
    const row = tags.get(id) ?? { id, kind, scope, label, statusLabel: riskScopeLabels[scope], note, evidenceIds: [], relationIds: [] };
    if (!row.evidenceIds.includes(unit.evidenceId)) row.evidenceIds.push(unit.evidenceId);
    if (relationId && !row.relationIds.includes(relationId)) row.relationIds.push(relationId);
    tags.set(id, row);
  };
  for (const unit of units.filter(unit => !unit.superseded)) {
    for (const [kind, keywords] of riskRules) {
      const matches = keywords.filter(keyword => unit.claim?.includes(keyword));
      if (!matches.length) continue;
      const polarities = matches.map(keyword => classifyMentionPolarity(unit.claim, keyword));
      const nonObservation = /(?:没(?:有)?|未)(?:观察|发现|看到|见到)/.test(unit.claim);
      const scope = nonObservation ? 'not_observed' : polarities.includes('present') ? 'reported' : polarities.includes('uncertain') ? 'uncertain' : 'denied';
      add(kind, scope, riskLabels[kind], unit, nonObservation ? '观察范围有限，不能据此排除本人体验。' : '依据原话中的线索；请核对时间、语境及限定语。');
    }
    if (unit.slotId === 'functional_impact' && unit.polarity === 'affirmed' && /影响|缺课|缺勤|缺席|不能到校|无法到校|作业(?:未完成|完不成)|成绩(?:下降|下滑)/.test(unit.claim)) add('impact', 'reported', '功能影响相关原话', unit, '来源报告的功能影响，程度需结合原文核实。');
    if (unit.slotId === 'safety_clues' && unit.polarity === 'uncertain') add('safety_unknown', 'uncertain', '安全信息未明', unit, '保留不确定陈述，不自动解释为有或无风险。');
  }
  const byId = new Map(units.map(unit => [unit.evidenceId, unit]));
  for (const relation of relations.filter(row => row.semanticRelation === 'contradicts')) {
    for (const id of [relation.priorEvidenceId, relation.newEvidenceId]) {
      const unit = byId.get(id);
      if (unit && !unit.superseded) add('difference', 'discrepancy', '来源描述待核实', unit, '双方来源均保留，系统不裁定哪一方正确。', relation.relationId);
    }
  }
  const rank = { reported: 0, uncertain: 1, discrepancy: 2, not_observed: 3, denied: 4 };
  return [...tags.values()].sort((a, b) => rank[a.scope] - rank[b.scope]);
}
