import { randomUUID } from 'node:crypto';
import { analyzeClinicianCase, clinicianRuntime, clinicianInputHash } from '../core/llm/clinician.mjs';
import { seedLlmComparisonCases } from './llm-comparison-cases.mjs';
import { seedClinicianWorkspaceFixture } from './clinician-workspace-fixture.mjs';

export function installClinicianLlmRoutes(app, store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS case_llm_analysis (
    run_id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES clinical_case(case_id) ON DELETE CASCADE,
    input_hash TEXT NOT NULL, runtime_hash TEXT NOT NULL, evidence_revision INTEGER NOT NULL,
    analysis_json TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_case_llm_analysis ON case_llm_analysis(case_id, created_at);`);
  const running = new Map();
  const latest = caseId => {
    const row = store.db.prepare('SELECT run_id, analysis_json FROM case_llm_analysis WHERE case_id=? ORDER BY created_at DESC, run_id DESC LIMIT 1').get(caseId);
    return row ? { ...JSON.parse(row.analysis_json), runId: row.run_id } : null;
  };
  const status = caseId => {
    const bundle = store.getClinicalBundle(caseId), runtime = clinicianRuntime(), analysis = latest(caseId);
    return { enabled: runtime.enabled, model: runtime.model, models: { extract: runtime.extractModel, relations: runtime.relationModel, expression: runtime.expressionModel },
      promptVersion: runtime.promptVersion, stage: running.get(caseId)?.stage ?? null, analysis,
      stale: !!analysis && (analysis.inputHash !== clinicianInputHash(bundle) || analysis.runtimeFingerprint !== runtime.fingerprint),
      history: store.db.prepare('SELECT run_id AS runId, evidence_revision AS evidenceRevision, created_at AS createdAt FROM case_llm_analysis WHERE case_id=? ORDER BY created_at DESC').all(caseId) };
  };
  app.get('/api/previsit/clinician/cases/:caseId/llm', (req, res, next) => {
    try { res.json(status(req.params.caseId)); } catch (error) { next(error); }
  });
  app.post('/api/previsit/clinician/cases/:caseId/llm', async (req, res, next) => {
    const caseId = req.params.caseId;
    let ownsJob = false;
    try {
      const bundle = store.getClinicalBundle(caseId), runtime = clinicianRuntime();
      if (!runtime.enabled) throw Object.assign(new Error('医生端 LLM 未启用；规则版仍可使用。'), { statusCode: 503 });
      const inputHash = clinicianInputHash(bundle), old = latest(caseId);
      if (!req.body?.force && old?.inputHash === inputHash && old.runtimeFingerprint === runtime.fingerprint) { res.json({ ...status(caseId), reused: true }); return; }
      if (running.size) throw Object.assign(new Error('已有病例正在进行模型分析，请稍后重试。'), { statusCode: 409 });
      running.set(caseId, { stage: 'extract' });
      ownsJob = true;
      const analysis = await analyzeClinicianCase(bundle, runtime, { onStage: stage => running.set(caseId, { stage }) });
      const current = store.getClinicalBundle(caseId);
      if (clinicianInputHash(current) !== inputHash) throw Object.assign(new Error('分析期间材料或核实记录发生变化，请基于最新材料重新生成。此次结果未保存。'), { statusCode: 409 });
      const runId = `CLA-${randomUUID()}`;
      store.db.prepare('INSERT INTO case_llm_analysis VALUES (?,?,?,?,?,?,?)').run(runId, caseId, inputHash, runtime.fingerprint, analysis.evidenceRevision, JSON.stringify(analysis), analysis.createdAt);
      res.json({ ...status(caseId), reused: false });
    } catch (error) {
      next(Object.assign(error, { statusCode: error.statusCode ?? 502 }));
    } finally { if (ownsJob) running.delete(caseId); }
  });
  app.get('/api/previsit/clinician/cases/:caseId/llm/:runId', (req, res, next) => {
    try {
      store.getClinicalCase(req.params.caseId);
      const row = store.db.prepare('SELECT analysis_json FROM case_llm_analysis WHERE case_id=? AND run_id=?').get(req.params.caseId, req.params.runId);
      if (!row) throw Object.assign(new Error('LLM 报告版本不存在。'), { statusCode: 404 });
      res.json({ analysis: { ...JSON.parse(row.analysis_json), runId: req.params.runId } });
    } catch (error) { next(error); }
  });
  app.post('/api/previsit/clinician/llm/comparison-fixtures', (_req, res, next) => {
    try { res.json({ cases: seedLlmComparisonCases(store), dataset: 'fully_synthetic_development' }); } catch (error) { next(error); }
  });
  app.post('/api/previsit/clinician/workspace-fixture', (_req, res, next) => {
    try { res.json(seedClinicianWorkspaceFixture(store)); } catch (error) { next(error); }
  });
}
