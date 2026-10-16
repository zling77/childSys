import {
  allowedActionsForTarget,
  classifyResponseSignal,
  respondentStrategyProfile,
  targetKey,
} from './followupStrategy.mjs';
import { buildDynamicGoal } from './dynamicGoalSpace.mjs';

export const DYNAMIC_QUESTION_CONTEXT_CAPS = Object.freeze({
  maxContextChars: 4000,
  maxOptionalClaims: 4,
  maxRelatedTurns: 2,
  maxRelatedTurnChars: 1200,
  maxCandidateTargets: 5,
});

export const PROHIBITED_DYNAMIC_CONTEXT_FIELDS = Object.freeze([
  'gaps',
  'allGaps',
  'all_gaps',
  'missingFields',
  'missing_fields',
  'slotStates',
  'slot_states',
  'slots',
  'allSlots',
  'all_slots',
  'allowedTargets',
  'allowed_targets',
]);

export function compileDynamicQuestionContext(input = {}, options = {}) {
  const maxContextChars = options.maxContextChars ?? DYNAMIC_QUESTION_CONTEXT_CAPS.maxContextChars;
  if (!Number.isInteger(maxContextChars) || maxContextChars <= 0) {
    throw new RangeError('maxContextChars must be a positive integer');
  }

  const prohibitedFields = PROHIBITED_DYNAMIC_CONTEXT_FIELDS.filter((field) =>
    Object.prototype.hasOwnProperty.call(input, field));
  const telemetry = createTelemetry(maxContextChars, prohibitedFields);

  if (prohibitedFields.length > 0) {
    return failure('prohibited_input_fields', telemetry);
  }
  if (!input.selectedTargetFacet || Array.isArray(input.selectedTargetFacet)
    || typeof input.selectedTargetFacet !== 'object') {
    return failure('missing_selected_target_facet', telemetry);
  }
  const selectedTargetFacet = compactTarget(input.selectedTargetFacet);
  if (!selectedTargetFacet.facet_id) {
    return failure('invalid_selected_target_facet', telemetry);
  }
  const candidateTargets = compactCandidates(
    input.candidateTargets,
    selectedTargetFacet,
    DYNAMIC_QUESTION_CONTEXT_CAPS.maxCandidateTargets,
  );
  telemetry.includedIds.candidateTargetIds = candidateTargets.map(targetKey);

  const activeConflicts = asArray(input.activeConflicts).map(compactConflict);
  const rawRisks = asArray(input.openDeterministicRisks).map(compactRisk);
  const openRisks = summarizeRisks(rawRisks);
  telemetry.includedIds.mandatoryConflictIds = activeConflicts.map((item) => item.id);
  telemetry.includedIds.mandatoryRiskIds = rawRisks.map((item) => item.id);

  let context = {
    respondent_context: compactRespondent(input.speakerRole, input.profile),
    response_signal: classifyResponseSignal(input.currentAnswer ?? input.answerText),
    selected_target_facet: selectedTargetFacet,
    candidate_targets: candidateTargets,
    current_exchange: {
      question: compactQuestion(input.currentQuestion),
      answer: String(input.currentAnswer ?? input.answerText ?? ''),
    },
    active_conflicts: activeConflicts,
    open_deterministic_risks: openRisks,
    relevant_claims: [],
    related_turns: [],
  };

  telemetry.budget.mandatoryChars = serializedChars(context);
  if (telemetry.budget.mandatoryChars > maxContextChars) {
    telemetry.budget.finalChars = telemetry.budget.mandatoryChars;
    return failure('mandatory_context_overflow', telemetry);
  }

  const claims = asArray(input.activeClaims).map(compactClaim);
  for (const [index, claim] of claims.entries()) {
    if (index >= DYNAMIC_QUESTION_CONTEXT_CAPS.maxOptionalClaims) {
      telemetry.excluded.push(exclusion('claim', claim.id, 'max_optional_claims'));
      continue;
    }
    const candidate = { ...context, relevant_claims: [...context.relevant_claims, claim] };
    if (serializedChars(candidate) > maxContextChars) {
      telemetry.excluded.push(exclusion('claim', claim.id, 'context_char_budget'));
      continue;
    }
    context = candidate;
    telemetry.includedIds.claimIds.push(claim.id);
  }

  let relatedTurnChars = 0;
  const turns = asArray(input.relatedTurns).map(compactTurn);
  for (const [index, turn] of turns.entries()) {
    if (index >= DYNAMIC_QUESTION_CONTEXT_CAPS.maxRelatedTurns) {
      telemetry.excluded.push(exclusion('related_turn', turn.id, 'max_related_turns'));
      continue;
    }
    const turnChars = turnTextChars(turn);
    if (relatedTurnChars + turnChars > DYNAMIC_QUESTION_CONTEXT_CAPS.maxRelatedTurnChars) {
      telemetry.excluded.push(exclusion('related_turn', turn.id, 'related_turn_char_budget'));
      continue;
    }
    const candidate = { ...context, related_turns: [...context.related_turns, turn] };
    if (serializedChars(candidate) > maxContextChars) {
      telemetry.excluded.push(exclusion('related_turn', turn.id, 'context_char_budget'));
      continue;
    }
    context = candidate;
    relatedTurnChars += turnChars;
    telemetry.includedIds.relatedTurnIds.push(turn.id);
  }

  telemetry.budget.relatedTurnChars = relatedTurnChars;
  telemetry.budget.finalChars = serializedChars(context);
  return {
    ok: true,
    context,
    fallback: { required: false, reason: null },
    telemetry,
  };
}

function compactRespondent(speakerRole, profile) {
  const role = speakerRole === 'child' ? 'child' : 'guardian';
  const age = Number(profile?.age);
  return {
    ...respondentStrategyProfile(role, profile),
    age: Number.isFinite(age) && age >= 0 && age <= 120 ? age : null,
    grade: String(profile?.grade ?? '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 24),
  };
}

function createTelemetry(maxContextChars, prohibitedFields) {
  return {
    caps: {
      maxContextChars,
      maxOptionalClaims: DYNAMIC_QUESTION_CONTEXT_CAPS.maxOptionalClaims,
      maxRelatedTurns: DYNAMIC_QUESTION_CONTEXT_CAPS.maxRelatedTurns,
      maxRelatedTurnChars: DYNAMIC_QUESTION_CONTEXT_CAPS.maxRelatedTurnChars,
      maxCandidateTargets: DYNAMIC_QUESTION_CONTEXT_CAPS.maxCandidateTargets,
    },
    budget: {
      mandatoryChars: 0,
      relatedTurnChars: 0,
      finalChars: 0,
    },
    includedIds: {
      claimIds: [],
      relatedTurnIds: [],
      mandatoryConflictIds: [],
      mandatoryRiskIds: [],
      candidateTargetIds: [],
    },
    excluded: [],
    prohibitedFields,
  };
}

function failure(reason, telemetry) {
  return {
    ok: false,
    context: null,
    fallback: { required: true, reason },
    telemetry,
  };
}

function compactTarget(target) {
  const dynamicGoal = buildDynamicGoal(target);
  if (!dynamicGoal) return {};
  return defined({
    complaint_id: dynamicGoal.complaintId,
    slot_id: dynamicGoal.targetSlotOrIssue,
    facet_id: dynamicGoal.targetFacetId,
    label: dynamicGoal.facetLabel,
    information_goal: dynamicGoal.informationGoal,
    minimum_evidence: dynamicGoal.minimumEvidence,
    answer_shape: dynamicGoal.answerShape,
    source_scope: dynamicGoal.sourceScope,
    elicitation_mode: dynamicGoal.independentElicitation ? 'independent' : undefined,
    focus_options: (dynamicGoal.focusOptions ?? []).map((focus) => defined({
      complaint_id: focus.complaintId,
      focus_id: focus.focusId,
      label: focus.label,
      information_need: focus.informationNeed,
      relevance: focus.relevance,
    })),
    selection_reason: dynamicGoal.selectionReason,
    state_status: dynamicGoal.stateStatus,
    allowed_actions: dynamicGoal.allowedActions ?? allowedActionsForTarget(target),
    goal_space_version: dynamicGoal.goalSpaceVersion,
  });
}

function compactCandidates(candidates, selectedTargetFacet, limit) {
  const ordered = [selectedTargetFacet, ...asArray(candidates).map(compactTarget)];
  const seen = new Set();
  return ordered.filter((candidate) => {
    const key = targetKey(candidate);
    if (!candidate.facet_id || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, limit);
}

function compactQuestion(question) {
  if (typeof question === 'string') return { text: question };
  const value = question && typeof question === 'object' ? question : {};
  return defined({
    id: firstDefined(value.id, value.questionId, value.question_id),
    text: firstDefined(value.text, value.questionText, value.question_text, ''),
  });
}

function compactClaim(claim, index) {
  const value = claim && typeof claim === 'object' ? claim : {};
  return defined({
    id: identifier(value, 'claim', index),
    complaint_id: firstDefined(value.complaintId, value.complaint_id),
    slot_id: firstDefined(value.slotId, value.slot_id),
    facet_id: firstDefined(value.facetId, value.facet_id),
    value: firstDefined(value.normalizedValue, value.normalized_value, value.value),
    evidence_text: firstDefined(value.evidenceText, value.evidence_text),
    source_role: firstDefined(value.sourceRole, value.source_role),
    polarity: value.polarity,
    turn_id: firstDefined(value.turnId, value.turn_id),
  });
}

function compactConflict(conflict, index) {
  const value = conflict && typeof conflict === 'object' ? conflict : {};
  return defined({
    id: identifier(value, 'conflict', index),
    facet_id: firstDefined(value.facetId, value.facet_id),
    summary: value.summary,
    claim_ids: firstDefined(value.claimIds, value.claim_ids),
    evidence_text: firstDefined(value.evidenceText, value.evidence_text),
  });
}

function compactRisk(risk, index) {
  const value = risk && typeof risk === 'object' ? risk : {};
  return defined({
    id: identifier(value, 'risk', index),
    signal_type: firstDefined(value.signalType, value.signal_type),
    status: value.status,
  });
}

function summarizeRisks(risks) {
  const grouped = new Map();
  for (const risk of risks) {
    const key = `${risk.signal_type ?? 'unknown'}:${risk.status ?? 'open'}`;
    const prior = grouped.get(key);
    grouped.set(key, {
      signal_type: risk.signal_type ?? 'unknown',
      status: risk.status ?? 'open',
      count: (prior?.count ?? 0) + 1,
      latest_id: risk.id,
    });
  }
  return [...grouped.values()];
}

function compactTurn(turn, index) {
  const value = turn && typeof turn === 'object' ? turn : {};
  return defined({
    id: identifier(value, 'turn', index),
    speaker_role: firstDefined(value.speakerRole, value.speaker_role, value.role),
    question: firstDefined(value.question, value.questionText, value.question_text, ''),
    answer: firstDefined(value.answer, value.answerText, value.answer_text, ''),
  });
}

function identifier(value, prefix, index) {
  return String(firstDefined(
    value.id,
    value[`${prefix}Id`],
    value[`${prefix}_id`],
    value.turnNo,
    value.turn_no,
    `${prefix}:${index + 1}`,
  ));
}

function defined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function exclusion(kind, id, reason) {
  return { kind, id, reason };
}

function serializedChars(value) {
  return JSON.stringify(value).length;
}

function turnTextChars(turn) {
  return String(turn.question ?? '').length + String(turn.answer ?? '').length;
}
