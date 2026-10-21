const PRIVATE_FOCUS_TASK = 'source_independent_focus';
const NEUTRAL_SELECTION_REASON = '根据本次回答选择下一步了解内容。';

const PUBLIC_LOG_FIELDS = [
  'decisionId', 'sessionId', 'turnNo', 'policyType', 'createdAt',
  'targetSlotOrIssue', 'targetFacetId', 'selectedQuestion',
];
const PUBLIC_QUESTION_FIELDS = [
  'id', 'policyType', 'complaintId', 'targetSlotOrIssue', 'targetFacetId',
  'label', 'facetLabel', 'isCriticalRisk', 'audience', 'text',
  'questionText', 'acknowledgement',
];
const PUBLIC_STATE_FIELDS = ['progress', 'mappedComplaints', 'gaps', 'riskSignalCount'];
const PUBLIC_BOUNDARY_FIELDS = ['ok', 'mode', 'modelSuggestionAccepted'];
const PUBLIC_AUDIT_FIELDS = [
  'callId', 'status', 'task', 'provider', 'model', 'promptVersion',
  'latencyMs', 'createdAt',
];

/**
 * Project patient-visible decision logs without exposing cross-source routing
 * evidence or model reasoning. A private focus audit anywhere in the session
 * protects the entire log history, including earlier decisions and later turns.
 * The unmodified internal logs remain available to the clinician repository.
 */
export function publicDecisionLogs(logs) {
  if (!Array.isArray(logs)) return [];
  const needsSourceProtection = logs.some((log) => auditsOf(log)
    .some((audit) => audit?.task === PRIVATE_FOCUS_TASK || audit?.task === 'semantic_evidence_assessment')
    || ['semantic', 'shadow'].includes(log?.boundaryCheckResult?.stateBuilderMode));
  if (!needsSourceProtection) return logs;

  return logs.map((log) => ({
    ...pick(log, PUBLIC_LOG_FIELDS),
    selectedAction: publicSelectedAction(log?.selectedAction),
    stateSummary: pick(log?.stateSummary, PUBLIC_STATE_FIELDS),
    selectionReason: NEUTRAL_SELECTION_REASON,
    boundaryCheckResult: pick(log?.boundaryCheckResult, PUBLIC_BOUNDARY_FIELDS),
    candidateQuestions: [],
    rejectedCandidates: [],
    modelAudits: auditsOf(log)
      .filter((audit) => audit?.task !== PRIVATE_FOCUS_TASK)
      .map((audit) => pick(audit, PUBLIC_AUDIT_FIELDS)),
  }));
}

function publicSelectedAction(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return null;
  const result = pick(action, ['nextAction']);
  if (Object.prototype.hasOwnProperty.call(action, 'nextQuestion')) {
    result.nextQuestion = action.nextQuestion == null
      ? null
      : pick(action.nextQuestion, PUBLIC_QUESTION_FIELDS);
  }
  return result;
}

function auditsOf(log) {
  return Array.isArray(log?.modelAudits) ? log.modelAudits : [];
}

function pick(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(value, field)) result[field] = value[field];
  }
  return result;
}
