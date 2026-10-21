import 'dotenv/config';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createStore } from '../server/store.mjs';
import { handleTurn } from '../core/orchestrator.mjs';
import { createLlmRuntimeFromEnv } from '../core/llm/provider.mjs';
import { runSemanticDialogue } from '../core/llm/semanticDialogue.mjs';

// Synthetic, explicitly seeded opt-out state isolates the real dialogue model
// from the evidence extractor. These are engineering checks, not clinical gold.
const store = createStore(':memory:'), runtime = createLlmRuntimeFromEnv();
const report = { synthetic: true, endpoint: process.env.PREVISIT_LLM_BASE_URL, seededRefusal: true, model: runtime.provider.dynamicModel, cases: [], failures: [] };
try {
  for (const c of [{ role: 'guardian', age: 10 }, { role: 'child', age: 8 }, { role: 'child', age: 13 }, { role: 'child', age: 16 }]) {
    const row = { ...c };
    try {
      const snapshot = store.getSnapshot(store.createSession({ profile: { respondent: c.role, age: c.age }, stateBuilderMode: 'semantic' }).sessionId);
      snapshot.turns = [{ turnNo: 1, speakerRole: c.role, questionText: '最近怎么了？',
        answerText: c.role === 'guardian' ? '孩子这两周上学前哭过三次，上周一抱着书包哭，迟到半小时。' : '我这两周上学前哭过三次，上周一抱着书包哭，迟到半小时。' }];
      const refusal = '那件事的细节我不想再说了。';
      const result = handleTurn(snapshot, { speakerRole: c.role,
        answerText: refusal + (c.role === 'guardian' ? '孩子最近总睡不好，我更想先说睡觉的事。' : '我最近总睡不着，我更想先说睡觉的事。'),
        currentQuestion: { text: c.role === 'guardian' ? '您能再说说那天的事情吗？' : '能再说说那天的事情吗？', targetFacetId: 'recent_episode', targetSlotOrIssue: 'current_manifestations' },
        semanticAssessment: { claims: [], assessments: [], responses: [], safety: [] } });
      const facet = result.slotStates.find(s => s.slotId === 'current_manifestations').value.facets.recent_episode;
      facet.collectionClosed = true; facet.responseState = { kind: 'declined', quote: refusal }; facet.status = 'declined';
      row.audit = await runSemanticDialogue(runtime, snapshot, result); row.question = result.nextQuestion?.question;
      assert.equal(row.audit.status, 'success', row.audit.error ?? 'decision error'); assert.equal(result.nextAction, 'ask');
      assert.equal(result.completionReviewAudit, undefined, 'ordinary ask must not run an end review');
      assert.match(row.question, /睡|夜|晚上/); assert.doesNotMatch(row.question, /那天|那件事|上学|书包|同学/);
      assert.notEqual(result.nextQuestion.targetFacetId, 'recent_episode'); assert.notEqual(result.nextQuestion.targetFacetId, 'recent_example');
      assert.equal((row.question.match(/[？?]/g) ?? []).length, 1);
      row.passed = true; console.log(`PASS ${c.role} age ${c.age}: ${row.question}`);
    } catch (error) {
      row.passed = false; row.error = error.message; report.failures.push({ role: c.role, age: c.age, error: error.message });
      console.log(`FAIL ${c.role} age ${c.age}: ${error.message}`);
    }
    report.cases.push(row);
  }
} finally {
  store.close(); mkdirSync('output', { recursive: true });
  const path = `output/dialogue-boundary-live-${Date.now()}.json`;
  writeFileSync(path, JSON.stringify(report, null, 2)); console.log(`Report: ${path}`);
}
console.log(`Boundary live: ${report.cases.filter(c => c.passed).length} passed, ${report.failures.length} failed`);
if (report.failures.length) process.exitCode = 1;
