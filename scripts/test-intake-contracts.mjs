import assert from 'node:assert/strict';

import { intakeCoverageDomains } from '../core/coverage.mjs';
import { buildDynamicGoal } from '../core/llm/dynamicGoalSpace.mjs';
import { complaintTemplates, getComplaintFocusOptions } from '../core/templates.mjs';
import {
  INTAKE_CONTRACT_SCOPE,
  INTAKE_CONTRACT_VERSION,
  getFacetContract,
  getIntakeContract,
  intakeContracts,
  resolveFacet,
} from '../core/intakeContracts.mjs';

assert.equal(intakeCoverageDomains.length, 14, 'coverage model must still contain 14 domains');
assert.equal(intakeContracts.length, 14, 'every coverage domain must have one contract');
assert.match(INTAKE_CONTRACT_VERSION, /^\d+\.\d+\.\d+$/, 'contract version must be semantic');

assert.deepEqual(
  intakeContracts.map((contract) => contract.slotId),
  intakeCoverageDomains.map((domain) => domain.slotId),
  'contracts must preserve coverage IDs and order',
);

const slotIds = new Set();
let requiredFacetCount = 0;

for (const [index, contract] of intakeContracts.entries()) {
  const coverage = intakeCoverageDomains[index];

  assert(!slotIds.has(contract.slotId), `duplicate contract slotId: ${contract.slotId}`);
  slotIds.add(contract.slotId);

  assert.equal(contract.contractVersion, INTAKE_CONTRACT_VERSION);
  assert.equal(contract.scope, INTAKE_CONTRACT_SCOPE);
  assert.equal(contract.diagnosticUse, false);
  assert.equal(contract.label, coverage.label, `${contract.slotId} label changed`);
  assert.deepEqual(contract.hints, coverage.hints, `${contract.slotId} hints changed`);
  assert.equal(getIntakeContract(contract.slotId), contract);

  assert(Number.isInteger(contract.attemptBudget) && contract.attemptBudget > 0);
  assert(contract.requiredFacets.length > 0, `${contract.slotId} needs required facets`);
  assert.equal(
    new Set(contract.requiredFacets).size,
    contract.requiredFacets.length,
    `${contract.slotId} has duplicate required facets`,
  );
  requiredFacetCount += contract.requiredFacets.length;

  const facetIds = contract.facets.map((facet) => facet.facetId);
  assert.equal(new Set(facetIds).size, facetIds.length, `${contract.slotId} has duplicate facets`);
  assert.equal(
    new Set(contract.optionalFacets).size,
    contract.optionalFacets.length,
    `${contract.slotId} has duplicate optional facets`,
  );
  assert.deepEqual(
    new Set([...contract.requiredFacets, ...contract.optionalFacets]),
    new Set(facetIds),
    `${contract.slotId} required/optional facets must partition all facets`,
  );

  for (const facet of contract.facets) {
    assert(facet.facetId && facet.label && facet.type, `${contract.slotId} has an invalid facet`);
    assert(facet.normalization?.strategy, `${contract.slotId}.${facet.facetId} lacks normalization`);
    assert.equal(getFacetContract(contract.slotId, facet.facetId), facet);
    const resolvedFacet = resolveFacet(contract.slotId, facet.facetId);
    assert.equal(resolvedFacet?.contract, contract);
    assert.equal(resolvedFacet?.facet, facet);
    assert.equal(resolvedFacet?.required, contract.requiredFacets.includes(facet.facetId));
    if (contract.requiredFacets.includes(facet.facetId)) {
      const target = buildDynamicGoal({
        complaintId: contract.coverageDomain,
        targetSlotOrIssue: contract.slotId,
        targetFacetId: facet.facetId,
        facetLabel: facet.label,
      });
      assert(target?.informationGoal, `${contract.slotId}.${facet.facetId} lacks an information goal`);
      assert(target?.minimumEvidence, `${contract.slotId}.${facet.facetId} lacks minimum evidence`);
    }

    if (facet.type === 'enum' || facet.type === 'multi_enum') {
      assert(facet.enumValues?.length > 0, `${contract.slotId}.${facet.facetId} lacks enum values`);
      assert.equal(
        new Set(facet.enumValues).size,
        facet.enumValues.length,
        `${contract.slotId}.${facet.facetId} has duplicate enum values`,
      );
    }

    if (facet.applicableWhen) {
      assert(
        facetIds.includes(facet.applicableWhen.facetId),
        `${contract.slotId}.${facet.facetId} has an unknown applicability dependency`,
      );
    }
  }

  for (const facetId of contract.requiredFacets) {
    assert(facetIds.includes(facetId), `${contract.slotId}.${facetId} has no facet definition`);
    assert(!contract.optionalFacets.includes(facetId), `${contract.slotId}.${facetId} is both required and optional`);
    const facet = contract.facets.find((candidate) => candidate.facetId === facetId);
    assert(Number.isInteger(facet.attemptBudget) && facet.attemptBudget > 0);
    assert(facet.negationPolicy?.strategy, `${contract.slotId}.${facetId} lacks a negation strategy`);
    assert(facet.negationPolicy?.terminalStatus, `${contract.slotId}.${facetId} lacks a negation outcome`);
  }

  assert.equal(contract.completionPolicy.strategy, 'all_required_facets_resolved');
  assert(contract.completionPolicy.resolvedStatuses.includes('declined'));
  assert(!contract.completionPolicy.evidenceSatisfiedStatuses.includes('declined'));
}

assert(
  requiredFacetCount >= 18 && requiredFacetCount <= 22,
  `required facet count must stay minimal (received ${requiredFacetCount})`,
);
assert.equal(requiredFacetCount, 18, 'v1 contracts should require exactly 18 minimal facets');
assert.equal(getFacetContract('unknown', 'frequency'), null);
assert.equal(resolveFacet('frequency_severity', 'unknown'), null);

const frequencyContract = getIntakeContract('frequency_severity');
assert(frequencyContract, 'frequency_severity contract is required');
assert.deepEqual(frequencyContract.requiredFacets, ['frequency', 'severity_example']);
assert.deepEqual(frequencyContract.optionalFacets, ['time_window', 'episode_duration']);
assert.equal(frequencyContract.facets.length, 4, 'frequency domain must retain four distinct facets');

const filledAfterFrequencyOnly = new Set(['frequency']);
const missingAfterFrequencyOnly = frequencyContract.requiredFacets.filter(
  (facetId) => !filledAfterFrequencyOnly.has(facetId),
);
assert.deepEqual(
  missingAfterFrequencyOnly,
  ['severity_example'],
  'a frequency-only answer must not complete the compound domain',
);
assert.equal(missingAfterFrequencyOnly.length, 1);

const complaintFocuses = complaintTemplates.flatMap((template) => template.focusAreas);
assert.equal(complaintFocuses.length, 50, 'all 50 former complaint questions must exist as information goals');
assert.equal(/[？?]/.test(JSON.stringify(complaintTemplates)), false, 'complaint goal material must not contain ready-made questions');
assert.ok(complaintFocuses.every((focus) => focus.informationNeed && focus.targetFacetId));
const schoolFocuses = getComplaintFocusOptions(
  ['school_refusal'],
  { targetSlotOrIssue: 'current_manifestations', targetFacetId: 'manifestation_description' },
  '到教室门口会害怕',
);
assert.ok(schoolFocuses.some((focus) => focus.focusId === 'refusal_stage'));
assert.ok(schoolFocuses.some((focus) => focus.focusId === 'emotional_reaction'));

console.log(
  `Validated ${intakeContracts.length} intake contracts (${INTAKE_CONTRACT_VERSION}); `
    + `${requiredFacetCount} required facets; frequency-only evidence leaves severity open.`,
);
