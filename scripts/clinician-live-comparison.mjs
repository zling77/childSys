import { mkdirSync, writeFileSync } from 'node:fs';

const base = 'http://127.0.0.1:4176/api/previsit/clinician';
async function request(path, body) {
  const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(600000) });
  const data = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${data.error}`);
  return data;
}
const before = await request('/cases');
const fixtures = await request('/llm/comparison-fixtures', {});
const results = [];
mkdirSync('output/clinician-llm', { recursive: true });
for (const fixture of fixtures.cases) {
  console.log(`Analyzing synthetic fixture: ${fixture.id} (${fixture.caseId})`);
  const bundle = await request(`/cases/${fixture.caseId}`);
  try {
    const result = await request(`/cases/${fixture.caseId}/llm`, {});
    const entry = { ...fixture, sourceMaterials: bundle.materials, rule: { state: bundle.evidenceState, packet: bundle.currentContent }, analysis: result.analysis, error: null };
    results.push(entry);
    console.log(JSON.stringify({ id: fixture.id, models: entry.analysis.models, totalMs: entry.analysis.totalMs, reused: result.reused, statistics: entry.analysis.statistics,
      relations: entry.analysis.state.evidenceRelations.map(r => ({ label: r.semanticRelation, reason: r.reasonCode, rationale: r.rationale })), warnings: entry.analysis.warnings,
      doctor: entry.analysis.doctorStatements.map(s => s.text) }));
  } catch (error) { results.push({ ...fixture, error: error.message }); console.log(JSON.stringify({ id: fixture.id, error: error.message })); }
  writeFileSync('output/clinician-llm/live-comparison.json', JSON.stringify({ dataset: 'fully_synthetic_development', date: '2026-10-09', caveat: 'Four fictional development fixtures; automated quote/structure checks do not establish clinical validity.', existingCasesBefore: before.cases.length, results }, null, 2));
}
const after = await request('/cases');
console.log(JSON.stringify({ casesBefore: before.cases.length, casesAfter: after.cases.length, success: results.filter(r => !r.error).length, failed: results.filter(r => r.error).length }));
if (results.some(r => r.error)) process.exitCode = 1;
