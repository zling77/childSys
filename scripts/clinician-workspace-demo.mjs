import { mkdirSync, writeFileSync } from 'node:fs';
const base = 'http://127.0.0.1:4176/api/previsit/clinician';
async function call(path, body) {
  const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(240000) });
  const data = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${data.error}`);
  return data;
}
const fixture = await call('/workspace-fixture', {});
console.log(`Analyzing fictional workspace fixture ${fixture.caseId}`);
const bundle = await call(`/cases/${fixture.caseId}`);
const model = await call(`/cases/${fixture.caseId}/llm`, {});
mkdirSync('output/clinician-workspace', { recursive: true });
writeFileSync('output/clinician-workspace/live-demo.json', JSON.stringify({ date: '2026-10-09', dataset: 'fully_synthetic_development', fixture, rule: bundle.currentContent, sourceMaterials: bundle.materials, sourceQuestions: bundle.sessions.map(session => ({ sessionId: session.sessionId, turns: session.turns })), analysis: model.analysis }, null, 2));
console.log(JSON.stringify({ caseId: fixture.caseId, reused: model.reused, totalMs: model.analysis.totalMs, statistics: model.analysis.statistics, overview: model.analysis.doctorStatements.filter(row => row.section === 'integrated_assessment'), warnings: model.analysis.warnings }));
