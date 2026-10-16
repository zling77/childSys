import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { COVERAGE_DOMAIN } from '../core/coverage.mjs';
import { INTAKE_CONTRACT_VERSION, getIntakeContract } from '../core/intakeContracts.mjs';
import { handleTurn } from '../core/orchestrator.mjs';
import { buildDynamicGoal, realizeGoalFallback } from '../core/llm/dynamicGoalSpace.mjs';
import { createStore } from '../server/store.mjs';

const testRoot = mkdtempSync(join(tmpdir(), 'previsit-facet-persistence-'));
const store = createStore(join(testRoot, 'facet.db'));

try {
  const session = store.createSession({ profile: { respondent: 'guardian', age: 10 } });
  const contract = getIntakeContract('frequency_severity');
  const currentQuestion = {
    policyType: 'adaptive_coverage',
    complaintId: COVERAGE_DOMAIN,
    targetSlotOrIssue: contract.slotId,
    targetFacetId: 'frequency',
    label: contract.label,
    facetLabel: contract.facets.find((facet) => facet.facetId === 'frequency').label,
    text: realizeGoalFallback(buildDynamicGoal({ complaintId: COVERAGE_DOMAIN, targetSlotOrIssue: contract.slotId, targetFacetId: 'frequency', facetLabel: contract.facets.find((facet) => facet.facetId === 'frequency').label }), { speakerRole: 'guardian' }),
  };
  const result = handleTurn(store.getSnapshot(session.sessionId), {
    speakerRole: 'guardian',
    answerText: '最近一周每天一次。',
    currentQuestion,
  });
  store.applyTurnResult(result);

  const reloaded = store.getSnapshot(session.sessionId);
  assert.equal(reloaded.turns[0].targetFacetId, 'frequency');
  const state = reloaded.slotStates.find((item) => (
    item.complaintId === COVERAGE_DOMAIN && item.slotId === 'frequency_severity'
  ));
  assert.equal(state.value.schemaVersion, INTAKE_CONTRACT_VERSION);
  assert.equal(state.value.facets.frequency.status, 'filled');
  assert.equal(state.value.facets.severity_example.status, 'missing');
  assert.ok(state.value.facets.frequency.evidenceIds.length > 0);

  const evidence = reloaded.evidenceUnits.find((item) => item.slotId === 'frequency_severity');
  assert.ok(evidence.value.facetIds.includes('frequency'));
  assert.equal(evidence.value.facetIds.includes('severity_example'), false);
  const gaps = reloaded.decisionLogs.at(-1).stateSummary.gaps;
  assert.ok(gaps.some((gap) => gap.slotId === 'frequency_severity' && gap.facetId === 'severity_example'));

  console.log('facet persistence smoke ok');
} finally {
  store.db.close();
  rmSync(testRoot, { recursive: true, force: true });
}
