import 'dotenv/config';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.mjs';
import { createLlmRuntimeFromEnv } from '../core/llm/provider.mjs';
import { assessTurnEvidence, stateBuilderSettings } from '../core/llm/semanticStateBuilder.mjs';
import { handleTurn } from '../core/orchestrator.mjs';
import { SEMANTIC_PROMPT_VERSION } from '../core/semanticEvidence.mjs';

// Explicit live model check; uses synthetic utterances and a temporary database.
// This command is intentionally excluded from the offline regression suite.
const runtime = createLlmRuntimeFromEnv();
assert.equal(runtime.enabled, true);
assert.equal(runtime.provider.provider, 'openai_compatible');
const settings = { ...stateBuilderSettings(), mode: 'semantic' };
const root = mkdtempSync(join(tmpdir(), 'previsit-criteria-live-'));
const store = createStore(join(root, 'synthetic.db'));
const report = { synthetic: true, promptVersion: SEMANTIC_PROMPT_VERSION,
  model: runtime.provider.evidenceModel, cases: [], failures: [] };
const facet = (snapshot, id) => snapshot.slotStates.flatMap(s => Object.values(s.value?.facets ?? {})).find(f => f.facetId === id);
let countSnapshot;
try {
  for (const c of [
    { name: 'count-without-window', slot: 'frequency_severity', target: 'frequency',
      question: '孩子哭过多少次？', answer: '孩子哭过三次。', sufficient: false },
    { name: 'event-defined-frequency-window', slot: 'frequency_severity', target: 'frequency',
      question: '孩子上学前哭过多少次，是在哪段时间里？', answer: '从运动会到期中考这段时间，孩子上学前哭过三次。', sufficient: true },
    { name: 'child-natural-recurring-frequency', slot: 'frequency_severity', target: 'frequency', role: 'child', age: 8,
      question: '上学前哭的情况，通常多久有一次？', answer: '几乎每个上学日，我进教室前都会哭。', sufficient: true },
    { name: 'event-context-without-detail', slot: 'current_manifestations', target: 'recent_episode',
      question: '最近一次发生了什么？', answer: '那次是在家里。', sufficient: false },
    { name: 'child-brief-concrete-event', slot: 'current_manifestations', target: 'recent_episode', role: 'child', age: 8,
      question: '最近一次发生了什么？', answer: '昨晚在家里，我把作业本扔到地上。', sufficient: true },
    { name: 'event-anchored-onset', slot: 'onset_course', target: 'onset_time',
      question: '不想上学大概从什么时候开始？', answer: '搬家以后才开始不想上学。', sufficient: true },
    { name: 'age-stage-onset', slot: 'onset_course', target: 'onset_time',
      question: '这种情况大概从什么时候开始？', answer: '上幼儿园那会儿就开始了。', sufficient: true },
    { name: 'latest-episode-is-not-known-onset', slot: 'onset_course', target: 'onset_time',
      question: '这种情况大概从什么时候开始？', answer: '昨天又哭了一次，但最早什么时候开始的我记不清了。', sufficient: false },
    { name: 'cross-turn-event-defined-window', slot: 'frequency_severity', target: 'frequency',
      question: '刚才说的这几次，是在哪段时间里发生的？', answer: '是从运动会到期中考这段时间。', sufficient: true, previousCount: true },
  ]) {
    if (process.argv[2] && c.name !== process.argv[2]) continue;
    const row = { name: c.name, target: c.target, expectedSufficient: c.sufficient };
    try {
      const snapshot = c.previousCount ? countSnapshot : store.getSnapshot(store.createSession({
        profile: { age: c.age ?? 10, respondent: c.role ?? 'guardian' }, stateBuilderMode: 'semantic',
      }).sessionId);
      assert.ok(snapshot, 'count case must exist for cross-turn verification');
      const input = { speakerRole: c.role ?? 'guardian', answerText: c.answer,
        currentQuestion: { text: c.question, targetSlotOrIssue: c.slot, targetFacetId: c.target } };
      const inspectedProvider = { ...runtime.provider, async assessEvidence(input) {
        const output = await runtime.provider.assessEvidence(input);
        row.modelOutput = output;
        return output;
      } };
      const assessed = await assessTurnEvidence(snapshot, input, inspectedProvider, settings);
      row.model = assessed.audit.model; row.latencyMs = assessed.audit.latencyMs;
      row.modelStatus = assessed.audit.status; row.error = assessed.audit.error;
      assert.ok(assessed.validated, assessed.audit.error ?? 'model returned no validated evidence');
      const result = handleTurn(snapshot, { ...input, semanticAssessment: assessed.validated });
      const saved = store.applyTurnResult(result);
      if (c.name === 'count-without-window') countSnapshot = saved;
      const state = facet(saved, c.target);
      row.sufficiency = state?.sufficiency; row.status = state?.status;
      row.requirements = state?.requirements; row.rejected = assessed.validated.rejected;
      assert.equal(state?.sufficiency === 'sufficient', c.sufficient);
      if (['count-without-window', 'event-context-without-detail'].includes(c.name)) assert.equal(state?.sufficiency, 'partial');
      if (c.sufficient) assert.ok(!result.decisionLog.candidateQuestions.some(q => q.targetFacetId === c.target), 'completed target must not be requested again');
      row.passed = true;
      console.log(`PASS ${c.name} (${row.latencyMs} ms)`);
    } catch (error) {
      row.passed = false; row.failure = error.message;
      report.failures.push({ name: c.name, error: error.message });
      console.log(`FAIL ${c.name}: ${error.message}`);
      console.log(JSON.stringify({ sufficiency: row.sufficiency, requirements: row.requirements, rejected: row.rejected, modelOutput: row.modelOutput }));
    }
    report.cases.push(row);
  }
} finally {
  mkdirSync('output', { recursive: true });
  const path = `output/semantic-criteria-live-${Date.now()}.json`;
  writeFileSync(path, JSON.stringify(report, null, 2));
  store.close(); rmSync(root, { recursive: true, force: true });
  console.log(`Report: ${path}`);
}
console.log(`Semantic criteria live: ${report.cases.filter(c => c.passed).length} passed, ${report.failures.length} failed`);
if (report.failures.length) process.exitCode = 1;
