// Hand-authored, entirely fictional development fixtures. Adds cases without resetting existing records.
export const llmComparisonFixtures = [
  { id: 'quantity', label: '同一时间窗的缺课天数分歧', age: 12, slotId: 'functional_impact', facetId: 'impact_example', materials: [
    { sourceRole: 'caregiver', text: '2026-10-01至2026-10-07，孩子因上学困难缺课两天。' },
    { sourceRole: 'teacher_school', text: '2026-10-01至2026-10-07，学校出勤记录显示孩子缺课四天。' },
  ] },
  { id: 'paraphrase', label: '不同措辞表达相同的入睡困难', age: 11, slotId: 'sleep_appetite_physical', facetId: 'sleep_change', materials: [
    { sourceRole: 'child', text: '近两周晚上躺下总要很久才睡着。' },
    { sourceRole: 'caregiver', text: '近两周孩子有入睡困难。' },
  ] },
  { id: 'time', label: '上个月与本周的陈述分别保留', age: 14, slotId: 'functional_impact', facetId: 'impact_presence', materials: [
    { sourceRole: 'caregiver', text: '2026-09-01至2026-09-30经常缺课，影响上学。' },
    { sourceRole: 'teacher_school', text: '2026-10-05至2026-10-09每天到校，没有影响上学。' },
  ] },
  { id: 'limitation', label: '本人体验、未观察到与限定性表述', age: 15, slotId: 'safety_clues', facetId: 'self_harm_or_suicide', materials: [
    { sourceRole: 'child', text: '近两周有时想消失，但没有采取行动，也没有准备东西。' },
    { sourceRole: 'caregiver', text: '近两周我没有观察到孩子自伤；孩子心里是否有这种想法，我不清楚。' },
  ] },
];

export function seedLlmComparisonCases(store) {
  const created = [];
  for (const fixture of llmComparisonFixtures) {
    const old = store.listClinicalCases().find(c => c.profile?.llmComparisonFixture === fixture.id);
    if (old) { created.push({ id: fixture.id, caseId: old.caseId, label: fixture.label, reused: true }); continue; }
    const clinicalCase = store.createClinicalCase({ title: `LLM对照（完全模拟）｜${fixture.label}`, profile: { age: fixture.age, sex: 'U', grade: '模拟年级', dataset: 'fully_synthetic_development', llmComparisonFixture: fixture.id } });
    for (const material of fixture.materials) store.addClinicalMaterial(clinicalCase.caseId, { ...material, observedTime: '2026-10-09', slotId: fixture.slotId, facetId: fixture.facetId });
    store.generateClinicalPacket(clinicalCase.caseId);
    created.push({ id: fixture.id, caseId: clinicalCase.caseId, label: fixture.label, reused: false });
  }
  return created;
}
