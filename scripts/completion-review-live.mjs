import 'dotenv/config';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.mjs';
import { handleTurn } from '../core/orchestrator.mjs';
import { createLlmRuntimeFromEnv } from '../core/llm/provider.mjs';
import { buildSemanticDialogueMessages, semanticDialogueSchema, validateSemanticDialogueDecision, runSemanticDialogue } from '../core/llm/semanticDialogue.mjs';
import { reviewCompletion } from '../core/llm/completionReview.mjs';

// Live reviewer calls with deliberately injected completion proposals. Injection
// tests premature-end handling; it is not claimed to be a natural Policy error.
// State is deliberately sparse to check original-text reading independently of
// the evidence extractor. All utterances and databases are synthetic.
const root = mkdtempSync(join(tmpdir(), 'completion-review-live-'));
const store = createStore(join(root, 'synthetic.db'));
const runtime = createLlmRuntimeFromEnv();
assert.equal(runtime.provider.provider, 'openai_compatible');
const report = { synthetic: true, endpoint: process.env.PREVISIT_LLM_BASE_URL, proposalOrigin: 'injected completion proposal, except natural-policy case',
  evidenceStateFixture: 'empty/partial on purpose; reviewer receives all original own-session turns',
  model: runtime.provider.dynamicModel, cases: [], failures: [] };
const empty = { claims: [], assessments: [], responses: [], safety: [] };
const proposal = { next_action: 'complete', target_facet_id: null, action_type: null, acknowledgement: '', question: '', selection_reason: '认为目前可以整理给医生。' };
const overview = '孩子三周前开始上学前哭，最近两周三次。最近一次周一早上在家准备出门，他抱着书包哭，说不想去学校，因为在班上被同学嘲笑，最后迟到半小时，之后能正常上课。在家玩和周末没有这种情况。睡眠、食欲和精力没有变化。发育正常，没有相关疾病，以前没就此求助。家里照护没有变化。没有伤害自己、别人或离家的想法和行为。妈妈可以陪伴，画画能平静下来。这次希望医生帮助了解不愿上学的原因。';
try {
  for (const c of [
    { name: 'vague-complaint-must-not-end', answer: '孩子最近有点不对劲。', expected: 'continue' },
    { name: 'known-frequency-does-not-justify-ending-or-reasking-count', answer: '孩子最近两周在上学前哭过三次，其他情况还没说。', expected: 'continue', noFrequency: true },
    { name: 'cross-turn-time-supplement-is-not-information-exhaustion', history: ['孩子哭过三次。'], answer: '最近两周。', expected: 'continue', noFrequency: true },
    { name: 'usable-overview-can-retain-unfilled-state', answer: overview, expected: 'allow_complete' },
    { name: 'refused-event-does-not-force-more-details', history: [overview], answer: '那次经过我不想再说了。', declined: true, expected: 'allow_complete' },
    { name: 'earlier-own-source-overview-is-not-lost', history: [overview, '对，就是这样。', '目前没有其他变化。', '家里还是妈妈照顾。', '其他情况我不了解。'], answer: '目前能提供的就这些情况。', expected: 'allow_complete' },
    { name: 'child-vague-complaint-must-not-end', role: 'child', age: 13, answer: '我最近有点难受，还没说清楚。', expected: 'continue' },
  ]) {
    if (process.argv[2] && c.name !== process.argv[2]) continue;
    const row = { name: c.name, expected: c.expected };
    try {
      const snapshot = store.getSnapshot(store.createSession({ profile: { age: c.age ?? 10, respondent: c.role ?? 'guardian' }, stateBuilderMode: 'semantic' }).sessionId);
      snapshot.turns = (c.history ?? []).map((answerText, i) => ({ turnNo: i + 1, speakerRole: c.role ?? 'guardian', questionText: null, answerText }));
      const result = handleTurn(snapshot, { speakerRole: c.role ?? 'guardian', answerText: c.answer, semanticAssessment: empty });
      if (c.declined) {
        const f = result.slotStates.find(s => s.slotId === 'current_manifestations').value.facets.recent_episode;
        f.collectionClosed = true; f.responseState = { kind: 'declined', quote: c.answer }; f.status = 'declined';
      }
      const reviewed = await reviewCompletion({ provider: runtime.provider, snapshot, result, proposal,
        dialogueContext: buildSemanticDialogueMessages(snapshot, result).context, decisionSchema: semanticDialogueSchema(result, snapshot),
        validateDecision: output => validateSemanticDialogueDecision(output, snapshot, result) });
      row.audit = reviewed.audit; row.decision = reviewed.decision;
      assert.equal(reviewed.audit.status, 'success', reviewed.audit.error ?? 'review failed');
      assert.equal(reviewed.audit.output.verdict, c.expected);
      if (c.noFrequency) assert.notEqual(reviewed.decision.target_facet_id, 'frequency');
      if (c.declined) assert.notEqual(reviewed.decision.target_facet_id, 'recent_episode');
      if (c.history?.length > 4) assert.ok(reviewed.audit.output.findings.some(f => f.refs.some(r => r.turn === 1)), 'must use earlier original evidence');
      row.passed = true; console.log(`PASS ${c.name} (${reviewed.audit.latencyMs} ms)`);
    } catch (error) { row.passed = false; row.error = error.message; report.failures.push({ name: c.name, error: error.message }); console.log(`FAIL ${c.name}: ${error.message}`); if (row.audit) console.log(JSON.stringify(row.audit)); }
    report.cases.push(row);
  }
  if (!process.argv[2]) {
  const snapshot = store.getSnapshot(store.createSession({ profile: { age: 10, respondent: 'guardian' }, stateBuilderMode: 'semantic' }).sessionId);
  const result = handleTurn(snapshot, { speakerRole: 'guardian', answerText: overview + '目前能提供的就这些情况，其他情况我确实都不了解，无法再补充信息。', semanticAssessment: empty });
  const policyAudit = await runSemanticDialogue(runtime, snapshot, result);
  const natural = { name: 'natural-policy-conditional-review', proposalInjected: false, policyAudit,
    reviewAudit: result.completionReviewAudit ?? null, nextAction: result.nextAction };
  try {
    assert.equal(policyAudit.status, 'success', policyAudit.error ?? 'policy failed');
    assert.equal(Boolean(result.completionReviewAudit), policyAudit.output.next_action === 'complete');
    if (result.completionReviewAudit) assert.equal(result.completionReviewAudit.status, 'success');
    natural.passed = true; console.log('PASS natural policy invokes review exactly when it proposes complete');
  } catch (error) { natural.passed = false; natural.error = error.message; report.failures.push({ name: natural.name, error: error.message }); }
  report.cases.push(natural);
  }
} finally {
  mkdirSync('output', { recursive: true });
  const path = `output/completion-review-live-${Date.now()}.json`;
  writeFileSync(path, JSON.stringify(report, null, 2));
  store.close(); rmSync(root, { recursive: true, force: true });
  console.log(`Report: ${path}`);
}
console.log(`Completion review live: ${report.cases.filter(c => c.passed).length} passed, ${report.failures.length} failed`);
if (report.failures.length) process.exitCode = 1;
