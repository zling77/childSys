import { resolveCoverageSlot } from './coverage.mjs';
import { inferEvidenceFacetIds } from './extractor.mjs';
import { sourceRoleOf } from './evidenceGraph.mjs';
import { getFacetContract, getIntakeContract, intakeContracts } from './intakeContracts.mjs';

export const SOURCE_INDEPENDENT_FOCUS_VERSION = 'source-independent-focus-1.0.0';

const RESOLVED = new Set(['filled', 'declined', 'unavailable', 'not_applicable']);
const NON_EVIDENCE_RESOLVED = new Set(['declined', 'unavailable', 'not_applicable']);
const UNKNOWN = /不知道|不清楚|不了解|不记得|记不清|无法观察|观察不到|说不准/;
const SLEEP = /睡眠|睡觉|睡不好|睡不着|睡得|睡的|睡着|入睡|失眠|夜醒|早醒|半夜醒|噩梦|作息|昼夜颠倒/;
const MAX_TARGETS = 3;
const targetKey = ({ slotId, facetId }) => `${slotId}:${facetId}`;

/**
 * Produce topic-only attention hints from the CURRENT case evidence graph.
 * `targets` is the only model-safe result: closed contract identifiers, with no
 * other reporter's answer, frequency, polarity, provenance or relation labels.
 * `privateAudit` MUST stay server-side. Cross-source-triggered collection is not
 * independent corroboration, even when the question does not reveal the source.
 * This pure helper neither updates current-source evidence nor forces a question.
 */
export function buildSourceIndependentFocus({
  caseId,
  sessionId,
  speakerRole,
  evidenceState,
  slotStates = [],
  decisionLogs = [],
  ownTurns = [],
} = {}) {
  const currentRole = sourceRoleOf(speakerRole);
  const privateAudit = {
    schemaVersion: SOURCE_INDEPENDENT_FOCUS_VERSION,
    evidenceSchemaVersion: evidenceState?.schemaVersion ?? null,
    caseId: caseId ?? null,
    sessionId: sessionId ?? null,
    currentSourceRole: currentRole,
    cross_source_triggered: false,
    independentCorroboration: false,
    evidenceUse: 'attention_only',
    targets: [],
    evidenceIds: [],
    relations: [],
    excludedTargets: [],
  };
  const empty = () => ({ targets: [], privateAudit });
  if (!caseId || !sessionId || !['child', 'caregiver'].includes(currentRole)) return empty();
  // A cached graph from a previous case must never affect this interview.
  if (evidenceState?.caseId !== caseId) return empty();

  const correctedIds = new Set((evidenceState.evidenceRelations ?? [])
    .filter((relation) => relation.caseId === caseId && relation.semanticRelation === 'corrects')
    .map((relation) => relation.priorEvidenceId));
  const otherEvidence = (evidenceState.evidenceUnits ?? []).filter((unit) => (
    unit.caseId === caseId
    && typeof unit.sessionId === 'string' && unit.sessionId.length > 0
    && unit.sessionId !== sessionId
    && sourceRoleOf(unit.sourceRole) !== currentRole
    && sourceRoleOf(unit.sourceRole) !== 'other'
    && unit.sourceMode === 'direct'
    && !unit.reportedSourceRole
    && !unit.superseded && !correctedIds.has(unit.evidenceId)
    && !unit.deleted && !unit.deletedAt
    && unit.slotId !== 'safety_clues'
  ));

  const byTarget = new Map();
  for (const unit of otherEvidence) {
    const contract = getIntakeContract(unit.slotId);
    if (!contract || !getFacetContract(unit.slotId, unit.facetId)) continue;
    // The claim is inspected privately to identify the TOPIC, never the expected
    // answer. A sleep statement normalized only as a health summary still opens
    // the optional sleep goal. Affirmation/denial/frequency do not change it.
    const facets = unit.slotId === 'sleep_appetite_physical'
      && (unit.facetId === 'sleep_change' || SLEEP.test(String(unit.claim ?? '')))
      ? ['sleep_change']
      : contract.requiredFacets;
    for (const facetId of facets) {
      const target = { slotId: contract.slotId, facetId };
      const key = targetKey(target);
      const existing = byTarget.get(key) ?? { target, evidenceIds: new Set() };
      existing.evidenceIds.add(unit.evidenceId);
      byTarget.set(key, existing);
    }
  }

  const attempts = countActualQuestions(decisionLogs);
  const historicalSuppression = suppressedOwnTargets(ownTurns, sessionId, currentRole);
  const eligible = [];
  for (const candidate of byTarget.values()) {
    const reason = exclusionReason(candidate.target, sessionId, slotStates, attempts, historicalSuppression);
    if (reason) {
      privateAudit.excludedTargets.push({ ...candidate.target, reason });
    } else eligible.push(candidate);
  }
  const contractOrder = new Map(intakeContracts.map((contract, index) => [contract.slotId, index]));
  const rank = (target) => target.facetId === 'sleep_change' ? -1 : contractOrder.get(target.slotId);
  eligible.sort((left, right) => rank(left.target) - rank(right.target)
    || targetKey(left.target).localeCompare(targetKey(right.target)));
  const chosen = eligible.slice(0, MAX_TARGETS);
  const targets = chosen.map(({ target }) => ({ slotId: target.slotId, facetId: target.facetId }));
  privateAudit.targets = chosen.map(({ target, evidenceIds }) => ({
    ...target,
    evidenceIds: [...evidenceIds].sort(),
    collectionMode: 'cross_source_triggered',
  }));
  privateAudit.evidenceIds = [...new Set(chosen.flatMap(({ evidenceIds }) => [...evidenceIds]))].sort();
  const selectedIds = new Set(privateAudit.evidenceIds);
  privateAudit.relations = (evidenceState.evidenceRelations ?? [])
    .filter((relation) => relation.caseId === caseId
      && (selectedIds.has(relation.priorEvidenceId) || selectedIds.has(relation.newEvidenceId)))
    .map((relation) => ({
      relationId: relation.relationId,
      priorEvidenceId: relation.priorEvidenceId,
      newEvidenceId: relation.newEvidenceId,
      semanticRelation: relation.semanticRelation,
      temporalRelation: relation.temporalRelation,
      reviewStatus: relation.reviewStatus,
    }));
  privateAudit.cross_source_triggered = targets.length > 0;
  return { targets, privateAudit };
}

function exclusionReason(target, sessionId, slotStates, attempts, historicalSuppression) {
  const state = slotStates.find((row) => row.slotId === target.slotId
    && (!row.sessionId || row.sessionId === sessionId));
  const facet = state?.value?.facets?.[target.facetId];
  if (facet && RESOLVED.has(facet.status)) return `current_source_${facet.status}`;
  if (state && NON_EVIDENCE_RESOLVED.has(state.status)) return `current_source_${state.status}`;
  // Legacy filled domains lack per-facet states; do not re-open them as hints.
  if (!state?.value?.facets && state?.status === 'filled') return 'current_source_filled';
  const rawValue = facet?.rawValue ?? facet?.value;
  const values = Array.isArray(rawValue) ? rawValue : [rawValue];
  if (values.some((value) => value === 'unclear' || (typeof value === 'string' && UNKNOWN.test(value)))) {
    return 'current_source_unknown';
  }
  const historicalReason = historicalSuppression.get(targetKey(target));
  if (historicalReason) return historicalReason;
  const facetContract = getFacetContract(target.slotId, target.facetId);
  const attemptBudget = Math.min(2, facetContract?.attemptBudget ?? 2);
  if ((attempts.get(targetKey(target)) ?? 0) >= attemptBudget) return 'attempt_budget_exhausted';
  return null;
}

function suppressedOwnTargets(ownTurns, sessionId, currentRole) {
  const suppressed = new Map();
  for (const turn of ownTurns) {
    // Never interpret another reporter's refusal or quotation as this person's
    // knowledge/consent. The store's persisted turns carry both fields.
    if (turn.sessionId !== sessionId || sourceRoleOf(turn.speakerRole) !== currentRole) continue;
    const question = turn.question;
    const slotId = resolveCoverageSlot(turn.targetSlotOrIssue ?? turn.slotId
      ?? question?.targetSlotOrIssue ?? question?.slotId, turn.questionText ?? question?.text ?? '');
    const facetId = turn.targetFacetId ?? turn.facetId ?? question?.targetFacetId ?? question?.facetId;
    // Without an explicit asked facet, don't guess which goal the person refused.
    if (!getFacetContract(slotId, facetId)) continue;
    const reason = explicitOwnBarrier(turn.answerText);
    if (reason) suppressed.set(targetKey({ slotId, facetId }), reason);
  }
  return suppressed;
}

function explicitOwnBarrier(answerText) {
  if (typeof answerText !== 'string' || !answerText.trim()) return null;
  const unquoted = answerText.replace(/[“「『"][^”」』"]*[”」』"]/g, '');
  const clauses = unquoted.split(/[，,。；;！？!?\n]/).map((clause) => clause.trim()).filter(Boolean);
  for (const clause of clauses) {
    if (/^(?:我(?:们)?家(?:的)?|我(?:们)?的)?(?:孩子|他|她|老师|爸爸|妈妈|医生).{0,6}(?:说|表示|告诉|不知道|不清楚|不记得|不想|不愿|没(?:有)?(?:观察|注意|发现)|未观察)/.test(clause)) continue;
    if (hasUnnegatedBarrier(clause, /不想(?:说|回答|谈)|不愿(?:意)?(?:说|回答|谈)|拒绝回答|不方便(?:说|回答)|先不(?:说|谈)/)) {
      return 'current_source_declined_history';
    }
    if (hasUnnegatedBarrier(clause, /没(?:有)?(?:观察|注意|留意)(?:过|到)?|未(?:曾)?观察|没(?:有)?发现|未发现|观察不到|无法观察/)) {
      return 'current_source_unobserved_history';
    }
    // Not knowing WHY a reported symptom occurs is different from not knowing
    // whether it occurs. Likewise, "不知道怎么办" does not negate observation.
    if (/不知道(?:为什么|为何|原因|该|怎么(?:办|做|帮|说|表达))|不清楚(?:为什么|为何|原因)/.test(clause)) continue;
    if (hasUnnegatedBarrier(clause, /不知道|不清楚|不了解|不记得|记不清|想不起来|忘了|说不准/)) {
      return 'current_source_unknown_history';
    }
  }
  return null;
}

function hasUnnegatedBarrier(clause, pattern) {
  return [...clause.matchAll(new RegExp(pattern.source, 'g'))].some((match) => !(
    /(?:不是|并非|没有说|没说|不代表|不等于|没有表示|不表示)\s*$/.test(clause.slice(0, match.index))
  ));
}

function countActualQuestions(decisionLogs) {
  const counts = new Map();
  for (const log of decisionLogs) {
    if (log.selectedAction?.nextAction === 'complete' || log.nextAction === 'complete') continue;
    const question = log.selectedAction?.nextQuestion;
    const text = question?.text ?? log.selectedQuestion ?? '';
    const slotId = resolveCoverageSlot(question?.targetSlotOrIssue ?? log.targetSlotOrIssue, text);
    const contract = getIntakeContract(slotId);
    if (!contract) continue;
    const facetId = question?.targetFacetId ?? log.targetFacetId
      ?? inferEvidenceFacetIds(slotId, text)[0] ?? contract.requiredFacets[0];
    if (!getFacetContract(slotId, facetId)) continue;
    const key = targetKey({ slotId, facetId });
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
