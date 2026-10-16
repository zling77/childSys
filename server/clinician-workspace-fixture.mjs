import { handleTurn } from '../core/orchestrator.mjs';

// An additive fixture with synthetic text only. No invented recording is presented as patient audio.
export function seedClinicianWorkspaceFixture(store) {
  const old = store.listClinicalCases().find(row => row.profile?.workspaceFixture === 'organized-evidence-v1');
  if (old) return { caseId: old.caseId, reused: true, dataset: 'fully_synthetic_development' };
  const clinicalCase = store.createClinicalCase({ title: '医生工作台演示（完全模拟）｜上学、睡眠与安全线索', profile: { age: 15, sex: 'U', grade: '初三（模拟）', dataset: 'fully_synthetic_development', workspaceFixture: 'organized-evidence-v1' } });
  const groups = [
    { role: 'guardian', turns: [
      ['这次最希望医生了解孩子的什么情况？', '近两周孩子不愿意上学，晚上很晚才睡，早上起床困难。', 'presenting_problem', 'primary_concern'],
      ['这些困难大致什么时候开始？', '从2026-09月底开始，近两周每个上学日早上都会出现。', 'onset_course', 'onset_time'],
      ['最近上学和生活受到哪些影响？', '2026-10-01至2026-10-07，因为上学困难缺课两天。', 'functional_impact', 'impact_example'],
      ['孩子遇到困难时可以向谁求助？', '孩子愿意找姐姐聊天，我们也在和班主任沟通。', 'strengths_protective', 'support_people'],
    ] },
    { role: 'child', turns: [
      ['最近在学校有什么让你难受的事情？', '近两周在学校被嘲笑后不想进教室，到校门口会紧张。', 'current_manifestations', 'manifestation_description'],
      ['这段时间晚上睡觉怎么样？', '近两周晚上躺下总要很久才睡着，早上觉得很累。', 'sleep_appetite_physical', 'sleep_change'],
      ['难受时有没有想消失或伤害自己的想法？', '近两周有时想消失，但没有采取行动，也没有准备东西。', 'safety_clues', 'self_harm_or_suicide'],
      ['什么人或事情能让你稍微好受一点？', '找姐姐聊天和画画会让我好受一点，我愿意和医生聊聊。', 'strengths_protective', 'helpful_strategies'],
    ] },
  ];
  for (const group of groups) {
    const session = store.createSession({ caseId: clinicalCase.caseId, profile: { ...clinicalCase.profile, respondent: group.role }, chiefComplaint: group.turns[0][1] });
    for (const [question, answer, slotId, facetId] of group.turns) {
      const result = handleTurn(store.getSnapshot(session.sessionId), { speakerRole: group.role, answerText: answer, currentQuestion: { text: question, targetSlotOrIssue: slotId, targetFacetId: facetId, policyType: 'rule_value' } });
      store.applyTurnResult(result);
    }
    store.completeSession(session.sessionId);
  }
  store.addClinicalMaterial(clinicalCase.caseId, { sourceRole: 'teacher_school', observedTime: '2026-10-09', observationContext: 'school', text: '2026-10-01至2026-10-07，学校出勤记录显示缺课四天。', slotId: 'functional_impact', facetId: 'impact_example' });
  store.generateClinicalPacket(clinicalCase.caseId);
  return { caseId: clinicalCase.caseId, reused: false, dataset: 'fully_synthetic_development' };
}
