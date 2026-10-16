import { handleTurn } from '../core/orchestrator.mjs';

/** Fully fictional development fixtures; they are neither clinical cases nor a gold standard. */
export function seedResearchDemoCases(store) {
  const created = [];
  function create(title, age, grade) {
    const clinicalCase = store.createClinicalCase({ title: `论文演示｜${title}`, profile: { age, grade, sex: 'U' } });
    created.push({ caseId: clinicalCase.caseId, label: title, dataset: 'fully_synthetic_development' });
    return clinicalCase.caseId;
  }
  function session(caseId, role, text) {
    const clinicalCase = store.getClinicalCase(caseId);
    const session = store.createSession({ caseId, profile: { ...clinicalCase.profile, respondent: role }, chiefComplaint: text });
    turn(session.sessionId, role, text);
    return session.sessionId;
  }
  function turn(sessionId, role, text, slotId = null, facetId = null) {
    const snapshot = store.getSnapshot(sessionId);
    const result = handleTurn(snapshot, { speakerRole: role, answerText: text, currentQuestion: slotId ? { text: '补充本次演示信息', targetSlotOrIssue: slotId, targetFacetId: facetId, policyType: 'rule_value' } : null });
    store.applyTurnResult(result);
  }
  function complete(caseId) {
    for (const session of store.getClinicalBundle(caseId).sessions) store.completeSession(session.sessionId);
    store.generateClinicalPacket(caseId);
  }

  const conflict = create('患儿与监护人的同时间窗分歧', 12, '初一');
  session(conflict, 'child', '近两周睡眠异常，晚上睡不着，影响上学。');
  session(conflict, 'guardian', '近两周睡眠正常，没有影响上学。');
  store.addClinicalMaterial(conflict, { sourceRole: 'scale', text: '近两周量表睡眠条目记载入睡困难。', observedTime: '2026-10-07', slotId: 'sleep_appetite_physical', facetId: 'sleep_change' });
  complete(conflict);

  const correction = create('同一来源明确纠错与版本比较', 10, '小学四年级');
  const correctionSession = session(correction, 'guardian', '近两周没有影响上学。');
  store.generateClinicalPacket(correction);
  turn(correctionSession, 'guardian', '刚才说错了，近两周影响上学，缺课四天。', 'functional_impact', 'impact_presence');
  complete(correction);

  const temporal = create('上个月与本周分别保留', 14, '初二');
  const temporalSession = session(temporal, 'guardian', '上个月影响上学，经常缺课。');
  store.generateClinicalPacket(temporal);
  turn(temporalSession, 'guardian', '本周没有影响上学。', 'functional_impact', 'impact_presence');
  store.addClinicalMaterial(temporal, { sourceRole: 'clinical_record', text: '2026-09-15既往记录：因上学困难接受心理咨询。', observedTime: '2026-09-15', slotId: 'prior_help_treatment', facetId: 'help_received' });
  complete(temporal);

  const context = create('学校与家庭观察场景不同', 9, '小学三年级');
  session(context, 'child', '近两周在学校经常哭闹，和同学有冲突。');
  session(context, 'guardian', '近两周在家没有哭闹。');
  store.addClinicalMaterial(context, { sourceRole: 'teacher_school', text: '近两周在学校经常哭闹，课间会独处。', observedTime: '2026-10-07', observationContext: 'school', slotId: 'current_manifestations', facetId: 'manifestation_description' });
  complete(context);

  const delayed = create('迟发风险披露与限定性原文', 15, '初三');
  const childSession = session(delayed, 'child', '近两周没有不想活。');
  store.generateClinicalPacket(delayed);
  turn(childSession, 'child', '近两周有时不想活，但没有采取行动。', 'safety_clues', 'current_safety_status');
  session(delayed, 'guardian', '最近孩子情绪低落，家长没有发现自伤行为。');
  complete(delayed);
  return created;
}
