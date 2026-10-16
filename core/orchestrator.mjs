import { mapComplaints } from './complaints.mjs';
import { COVERAGE_DOMAIN, resolveCoverageSlot } from './coverage.mjs';
import { createEvidenceUnits, inferEvidenceFacetIds, isAnswerRelevantToQuestion } from './extractor.mjs';
import { getFacetContract, getIntakeContract } from './intakeContracts.mjs';
import { findRiskSignals } from './risk.mjs';
import { computeProgress, findGaps, updateSlotStates } from './state.mjs';
import { planNextQuestion } from './planner.mjs';
import { buildRuleClarificationQuestion, rewriteQuestion } from './question.mjs';
import { buildEvidenceState, normalizeEvidenceUnits } from './evidenceGraph.mjs';
import { buildSourceIndependentFocus } from './sourceIndependentFocus.mjs';

export function handleTurn(snapshot, input) {
  const sessionId = snapshot.session.sessionId;
  const turnNo = snapshot.turns.length + 1;
  const speakerRole = resolveSpeakerRole(input.speakerRole, snapshot.session.profile?.respondent);
  const answerText = String(input.answerText ?? '').trim();
  const currentQuestion = input.currentQuestion ?? null;
  const normalizedCurrentQuestion = normalizeCurrentQuestion(currentQuestion);
  const existing = snapshot.session.mappedComplaints ?? [];
  const complaintIds = mapComplaints(
    answerText,
    snapshot.session.selectedComplaints ?? [],
    existing,
  );
  const evidenceUnits = createEvidenceUnits({
    sessionId,
    turnNo,
    text: answerText,
    speakerRole,
    complaintIds,
    currentQuestion: normalizedCurrentQuestion,
  });
  const riskSignals = findRiskSignals(answerText, sessionId, turnNo, speakerRole);
  const slotStates = updateSlotStates(snapshot, complaintIds, evidenceUnits);
  const progress = computeProgress(slotStates, complaintIds);
  const gaps = findGaps(slotStates, complaintIds);
  // The full case graph is server-only. Refresh its current-source branch with
  // this unsaved answer BEFORE choosing a strategy; never merge other sources
  // into the session's own evidence, slot states, risks, or model claims.
  const caseId = input.caseId;
  const caseGraph = input.caseEvidenceState;
  const pendingCaseState = caseId && caseGraph?.caseId === caseId
    ? buildEvidenceState(caseId, [
        ...caseGraph.evidenceUnits.filter((unit) => unit.sessionId !== sessionId),
        ...normalizeEvidenceUnits({ ...snapshot, evidenceUnits: [...snapshot.evidenceUnits, ...evidenceUnits] }, caseId),
      ])
    : null;
  const independentFocus = buildSourceIndependentFocus({
    caseId, sessionId, speakerRole,
    evidenceState: pendingCaseState,
    slotStates,
    decisionLogs: snapshot.decisionLogs,
    ownTurns: [...snapshot.turns, {
      sessionId, speakerRole, answerText,
      targetSlotOrIssue: normalizedCurrentQuestion?.targetSlotOrIssue,
      targetFacetId: normalizedCurrentQuestion?.targetFacetId,
    }],
  });
  const currentSleepUnavailable = normalizedCurrentQuestion?.targetFacetId === 'sleep_change'
    && /不想说|不想回答|不愿(?:意)?说|拒绝回答|不知道|不清楚|不了解|不记得|记不清|无法观察|观察不到|(?:没|没有|未)观察(?:到)?/.test(answerText);
  const independentFocusTargets = independentFocus.targets;
  const askedCurrentTargetCount = countAskedTarget(snapshot.decisionLogs ?? [], normalizedCurrentQuestion);
  const currentAnswerIsRelevant = normalizedCurrentQuestion
    ? isAnswerRelevantToQuestion(answerText, normalizedCurrentQuestion)
    : true;
  const hasOpenRiskSignal = [...(snapshot.riskSignals ?? []), ...riskSignals]
    .some((signal) => signal.status !== 'closed');
  const atHardTurnCap = snapshot.turns.filter((turn) => turn.speakerRole !== 'system').length + 1 >= 24;
  const needsRuleClarification = normalizedCurrentQuestion?.targetSlotOrIssue
    && !currentAnswerIsRelevant
    && askedCurrentTargetCount < 2
    && !hasOpenRiskSignal
    && !atHardTurnCap
    && !currentSleepUnavailable;
  const plan = needsRuleClarification
    ? {
        nextAction: 'ask',
        selected: {
          policyType: 'rule_clarify',
          complaintId: COVERAGE_DOMAIN,
          targetSlotOrIssue: normalizedCurrentQuestion.targetSlotOrIssue,
          targetFacetId: normalizedCurrentQuestion.targetFacetId,
          label: normalizedCurrentQuestion.label,
          facetLabel: normalizedCurrentQuestion.facetLabel,
          candidateQuestion: normalizedCurrentQuestion.text,
          reason: currentAnswerIsRelevant
            ? '上一轮回答仍较宽泛，先围绕同一信息域做一句澄清。'
            : '上一轮回答没有回应当前信息域，换一种更具体的问法澄清一次。',
        },
        candidates: [],
        rejected: [],
        reason: currentAnswerIsRelevant
          ? '上一轮回答仍较宽泛，先围绕同一信息域做一句澄清。'
          : '上一轮回答没有回应当前信息域，换一种更具体的问法澄清一次。',
      }
    : planNextQuestion({
        snapshot,
        complaintIds,
        slotStates,
        progress,
        riskSignals: [...snapshot.riskSignals, ...riskSignals],
        latestAnswer: answerText,
        currentQuestion: normalizedCurrentQuestion,
        speakerRole,
        independentFocusTargets,
      });
  const nextQuestion = needsRuleClarification
    ? buildRuleClarificationQuestion(normalizedCurrentQuestion, answerText, snapshot, speakerRole)
    : rewriteQuestion(plan.selected, snapshot.session.profile, snapshot, speakerRole);
  const openRiskCount = snapshot.riskSignals.length + riskSignals.length;
  const status = plan.nextAction === 'complete'
    ? (openRiskCount > 0 ? 'needs_clinician_review' : 'completed')
    : (openRiskCount > 0 ? 'needs_clinician_review' : 'in_progress');

  const dialogueTurn = {
    sessionId,
    turnNo,
    speakerRole,
    questionText: currentQuestion?.text ?? null,
    answerText,
    questionPolicyType: currentQuestion?.policyType ?? null,
    targetSlotOrIssue: normalizedCurrentQuestion?.targetSlotOrIssue ?? null,
    targetFacetId: normalizedCurrentQuestion?.targetFacetId ?? null,
    createdAt: Date.now(),
  };

  const decisionLog = {
    decisionId: `D-${sessionId}-${turnNo}`,
    sessionId,
    turnNo,
    policyType: nextQuestion?.policyType ?? plan.selected?.policyType ?? 'rule_value',
    stateSummary: {
      mappedComplaints: complaintIds,
      progress,
      gaps,
      riskSignalCount: snapshot.riskSignals.length + riskSignals.length,
    },
    candidateQuestions: plan.candidates,
    rejectedCandidates: plan.rejected,
    selectedAction: {
      nextAction: plan.nextAction,
      nextQuestion,
    },
    selectedQuestion: nextQuestion?.text ?? '',
    selectionReason: plan.reason,
    boundaryCheckResult: { ok: true, mode: 'adaptive_initial_intake_coverage' },
    riskMarker: riskSignals.map((signal) => ({
      signalType: signal.signalType,
      keyword: signal.keyword,
      note: '医生端优先核实，不做风险分层。',
    })),
    targetSlotOrIssue: nextQuestion?.targetSlotOrIssue ?? null,
    targetFacetId: nextQuestion?.targetFacetId ?? null,
    createdAt: Date.now(),
  };

  return {
    sessionId,
    status,
    nextAction: plan.nextAction,
    mappedComplaints: complaintIds,
    dialogueTurn,
    evidenceUnits,
    riskSignals,
    slotStates,
    decisionLog,
    nextQuestion,
    progress,
    // This is deliberately outside decisionLog/public state. The server saves
    // it in a private audit and removes it from every patient-facing response.
    privateSourceFocusAudit: pendingCaseState ? {
      ...independentFocus.privateAudit,
      caseEvidenceRevision: input.caseEvidenceRevision ?? null,
      currentAnswerIncluded: true,
    } : null,
  };
}

function resolveSpeakerRole(speakerRole, profileRespondent) {
  if (speakerRole === 'child' || speakerRole === 'guardian') return speakerRole;
  return ['child', 'patient', 'self', '患儿', '患儿本人', '儿童本人'].includes(profileRespondent)
    ? 'child'
    : 'guardian';
}

function countAskedTarget(decisionLogs, currentQuestion) {
  const currentSlotId = resolveCoverageSlot(currentQuestion?.targetSlotOrIssue, currentQuestion?.text);
  if (!currentSlotId) return 0;
  const currentFacetId = currentQuestion?.targetFacetId ?? null;
  return decisionLogs.filter((log) => {
    const loggedQuestion = log.selectedAction?.nextQuestion;
    const loggedText = loggedQuestion?.text ?? log.selectedQuestion ?? '';
    const slotId = resolveCoverageSlot(
      loggedQuestion?.targetSlotOrIssue ?? log.targetSlotOrIssue,
      loggedText,
    );
    if (slotId !== currentSlotId) return false;
    if (!currentFacetId) return true;
    const contract = getIntakeContract(slotId);
    const loggedFacetId = loggedQuestion?.targetFacetId
      ?? log.targetFacetId
      ?? inferEvidenceFacetIds(slotId, loggedText)[0]
      ?? contract?.requiredFacets[0]
      ?? null;
    return loggedFacetId === currentFacetId;
  }).length;
}

function normalizeCurrentQuestion(currentQuestion) {
  if (!currentQuestion) return null;
  const targetSlotOrIssue = resolveCoverageSlot(
    currentQuestion.targetSlotOrIssue,
    currentQuestion.text,
  );
  if (!targetSlotOrIssue) {
    return {
      ...currentQuestion,
      complaintId: COVERAGE_DOMAIN,
      targetSlotOrIssue: null,
      targetFacetId: null,
    };
  }
  const contract = getIntakeContract(targetSlotOrIssue);
  const explicitFacetId = currentQuestion.targetFacetId;
  const inferredFacetId = inferEvidenceFacetIds(targetSlotOrIssue, currentQuestion.text, {
    reason: 'targeted_answer',
  })[0];
  const targetFacetId = getFacetContract(targetSlotOrIssue, explicitFacetId)?.facetId
    ?? inferredFacetId
    ?? contract?.requiredFacets[0]
    ?? null;
  const facet = getFacetContract(targetSlotOrIssue, targetFacetId);
  return {
    ...currentQuestion,
    complaintId: COVERAGE_DOMAIN,
    targetSlotOrIssue,
    targetFacetId,
    facetLabel: currentQuestion.facetLabel ?? facet?.label,
  };
}
