import {
  COVERAGE_DOMAIN,
  coverageRelevanceScore,
  relatedCoverageSlots,
  resolveCoverageSlot,
} from './coverage.mjs';
import { getFacetContract, getIntakeContract } from './intakeContracts.mjs';
import { inferEvidenceFacetIds } from './extractor.mjs';
import { findGaps } from './state.mjs';
import { buildDynamicGoal } from './llm/dynamicGoalSpace.mjs';

const bannedQuestionFragments = ['是不是ADHD', '是不是ASD', '是不是抑郁症', '吃什么药', '停药', '换药', '高危', '低危'];
const SAFETY_ATTEMPT_LIMIT_WITH_SIGNAL = 3;
const HARD_TURN_SAFETY_CAP = 24;

export function planNextQuestion({
  snapshot,
  complaintIds,
  slotStates,
  progress,
  riskSignals,
  latestAnswer = '',
  currentQuestion = null,
  speakerRole = null,
  independentFocusTargets = [],
}) {
  const askedTargets = countAskedTargets(snapshot.decisionLogs ?? []);
  const userTurnCount = snapshot.turns.filter((turn) => turn.speakerRole !== 'system').length + (latestAnswer ? 1 : 0);
  const hasOpenRiskSignal = (riskSignals ?? []).some((signal) => signal.status !== 'closed');
  const isChildRespondent = speakerRole === 'child';
  const lastTarget = resolveCoverageSlot(
    currentQuestion?.targetSlotOrIssue,
    currentQuestion?.text,
  ) ?? lastAskedTarget(snapshot.decisionLogs ?? []);
  const relatedNext = new Set(relatedCoverageSlots(lastTarget));
  const candidates = [];

  const focusKeys = new Set(independentFocusTargets.map(({ slotId, facetId }) => targetKey(slotId, facetId)));
  const gaps = findGaps(slotStates, complaintIds);
  // An optional facet is a conditional target, not a new mandatory checklist.
  // Only trusted, topic-only focus IDs can open it, and only for this source.
  for (const target of independentFocusTargets) {
    const contract = getIntakeContract(target.slotId);
    const facet = getFacetContract(target.slotId, target.facetId);
    if (!contract || !facet || !buildDynamicGoal({ targetFacetId: target.facetId })) continue;
    const state = slotStates.find((row) => row.slotId === target.slotId);
    const status = state?.value?.facets?.[target.facetId]?.status ?? 'missing';
    if (['filled', 'declined', 'unavailable', 'not_applicable'].includes(status)) continue;
    if (!gaps.some((gap) => gap.slotId === target.slotId && gap.facetId === target.facetId)) {
      gaps.push({ complaintId: COVERAGE_DOMAIN, slotId: target.slotId, facetId: target.facetId, status });
    }
  }

  for (const gap of gaps) {
    const contract = getIntakeContract(gap.slotId);
    const facet = getFacetContract(gap.slotId, gap.facetId);
    if (!contract || !facet) continue;
    const isSafety = gap.slotId === 'safety_clues';
    const key = targetKey(gap.slotId, gap.facetId);
    const askedCount = askedTargets.get(key) ?? 0;
    const attemptLimit = isSafety && hasOpenRiskSignal
      ? SAFETY_ATTEMPT_LIMIT_WITH_SIGNAL
      : facet.attemptBudget ?? contract.attemptBudget ?? 2;
    const safetyQuestion = isSafety
      ? (hasOpenRiskSignal
          ? (isChildRespondent
              ? '你刚才提到可能伤害自己或别人，你现在还有这样的想法或打算吗？'
              : '您刚才提到让人担心安全的情况，孩子现在是否还有伤害自己或他人的想法、计划或行为？')
          : (isChildRespondent
              ? '你最近有没有不想活、伤害自己或别人、离家不回来的想法或行为？'
              : '孩子最近有没有不想活、伤害自己或他人、离家不回等安全相关情况？'))
      : null;
    const baseCandidate = {
      policyType: 'adaptive_coverage',
      complaintId: COVERAGE_DOMAIN,
      targetSlotOrIssue: gap.slotId,
      targetFacetId: gap.facetId,
      label: contract.label,
      facetLabel: facet.label,
      reason: candidateReason(contract.label, facet.label, gap.status, hasOpenRiskSignal && isSafety),
      expectedInformationGain: gap.status === 'missing' ? 0.9 : 0.72,
      interactionConsideration: '候选只定义信息目标；Policy选择目标与动作，Realizer根据本轮状态现场生成问题。',
      riskNotes: hasOpenRiskSignal ? '已有安全线索，优先补充事实并提示医生核实，不在家长端分层。' : null,
      previouslyAsked: askedCount > 0,
      askedCount,
      attemptLimit,
      stateStatus: gap.status,
      isCriticalRisk: isSafety,
      relevanceToLatestAnswer: coverageRelevanceScore(gap.slotId, latestAnswer),
      relatedToPreviousAnswer: gap.slotId === lastTarget || relatedNext.has(gap.slotId),
      domainPriority: contract.priority,
      independentElicitation: focusKeys.has(key),
      ...(gap.missingRequirements ? { missingRequirements: gap.missingRequirements, responseState: gap.responseState } : {}),
    };
    const candidate = {
      ...baseCandidate,
      ...buildDynamicGoal(baseCandidate),
      ...(safetyQuestion ? { candidateQuestion: safetyQuestion } : {}),
    };
    candidates.push(candidate);
  }

  if (candidates.length === 0) {
    return completePlan(candidates, [], '全面初诊覆盖域已完成。');
  }

  if (userTurnCount >= HARD_TURN_SAFETY_CAP) {
    return completePlan(candidates, [], `已达到${HARD_TURN_SAFETY_CAP}轮安全上限，保留未完成项供医生查看。`);
  }

  const rejected = [];
  const safe = [];
  for (const candidate of candidates) {
    const boundary = boundaryCheck(candidate);
    if (!boundary.ok) {
      rejected.push({ ...candidate, rejectedReason: boundary.reason });
      continue;
    }
    if (candidate.askedCount >= candidate.attemptLimit) {
      rejected.push({ ...candidate, rejectedReason: '该字段已尝试澄清但仍无法补齐' });
      continue;
    }
    safe.push({ ...candidate, score: scoreCandidate(candidate, { userTurnCount, hasOpenRiskSignal, progress, latestAnswer }) });
  }

  if (safe.length === 0) {
    return completePlan(candidates, rejected, '剩余字段均已尝试澄清但仍无法补齐，保留为医生端缺失项。');
  }

  const selected = safe.sort((left, right) => {
    if ((right.score ?? 0) !== (left.score ?? 0)) return (right.score ?? 0) - (left.score ?? 0);
    return targetKey(left.targetSlotOrIssue, left.targetFacetId)
      .localeCompare(targetKey(right.targetSlotOrIssue, right.targetFacetId));
  })[0];
  return {
    nextAction: 'ask',
    selected,
    candidates,
    rejected,
    reason: selected.reason,
  };
}

function completePlan(candidates, rejected, reason) {
  return {
    nextAction: 'complete',
    selected: null,
    candidates,
    rejected,
    reason,
  };
}

function candidateReason(label, facetLabel, stateStatus, urgentSafety) {
  if (urgentSafety) return '本轮出现安全线索，先核实近期事实和当前状态。';
  if (stateStatus === 'conflict') return `${label}中的“${facetLabel}”存在矛盾，做一次聚焦澄清。`;
  if (stateStatus === 'ambiguous') return `${label}中的“${facetLabel}”仍不明确，补充一个可核实事实。`;
  return `补充${label}中的“${facetLabel}”。`;
}

function boundaryCheck(candidate) {
  if (!candidate.targetSlotOrIssue || !candidate.targetFacetId) {
    return { ok: false, reason: '无法对应初诊覆盖字段' };
  }
  if (!candidate.informationGoal || !candidate.minimumEvidence) {
    return { ok: false, reason: '候选缺少结构化信息目标' };
  }
  if (!candidate.candidateQuestion) return { ok: true };
  for (const fragment of bannedQuestionFragments) {
    if (candidate.candidateQuestion.includes(fragment)) {
      return { ok: false, reason: `命中禁止表达：${fragment}` };
    }
  }
  if (candidate.candidateQuestion.length > 90) return { ok: false, reason: '问题过长' };
  const questionMarkCount = (candidate.candidateQuestion.match(/[？?]/g) ?? []).length;
  return questionMarkCount === 1
    ? { ok: true }
    : { ok: false, reason: '安全问题必须且只能包含一个问号' };
}

function scoreCandidate(candidate, context) {
  const statusValue = candidate.stateStatus === 'conflict'
    ? 0.82
    : candidate.stateStatus === 'ambiguous'
      ? 0.68
      : 0.34;
  const riskPriority = candidate.targetSlotOrIssue === 'safety_clues'
    ? (context.hasOpenRiskSignal ? 4 : context.userTurnCount >= 3 ? 0.38 : 0.12)
    : 0;
  const recentRelevance = candidate.relevanceToLatestAnswer;
  const conversationalContinuity = candidate.relatedToPreviousAnswer ? 0.52 : 0;
  const coverageValue = candidate.domainPriority * 0.48;
  const firstAttemptValue = candidate.askedCount === 0 ? 0.28 : -0.34 * candidate.askedCount;
  const lateCoverageBoost = (context.progress?.percent ?? 0) >= 65 ? 0.12 : 0;
  // A concrete conditional facet is more informative than a broad, already
  // routine coverage topic. Safety still has an overriding priority of 4.
  const independentFocusValue = candidate.independentElicitation
    ? (candidate.targetFacetId === 'sleep_change' ? 1.4 : 0.5) : 0;
  const contextualTieBreak = stableFraction(
    `${context.latestAnswer}:${candidate.targetSlotOrIssue}:${candidate.targetFacetId}`,
  ) * 0.04;
  return riskPriority
    + statusValue
    + recentRelevance
    + conversationalContinuity
    + coverageValue
    + firstAttemptValue
    + lateCoverageBoost
    + independentFocusValue
    + contextualTieBreak;
}

function stableFraction(value) {
  let hash = 2166136261;
  for (const char of String(value ?? '')) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

function lastAskedTarget(decisionLogs) {
  for (let index = decisionLogs.length - 1; index >= 0; index -= 1) {
    const nextQuestion = decisionLogs[index]?.selectedAction?.nextQuestion;
    const resolved = resolveCoverageSlot(
      nextQuestion?.targetSlotOrIssue ?? decisionLogs[index]?.targetSlotOrIssue,
      nextQuestion?.text ?? decisionLogs[index]?.selectedQuestion,
    );
    if (resolved) return resolved;
  }
  return null;
}

function countAskedTargets(decisionLogs) {
  const counts = new Map();
  for (const log of decisionLogs) {
    if (log.policyType === 'interaction_resume') continue;
    const nextQuestion = log.selectedAction?.nextQuestion;
    const questionText = nextQuestion?.text ?? log.selectedQuestion ?? '';
    const slotId = resolveCoverageSlot(
      nextQuestion?.targetSlotOrIssue ?? log.targetSlotOrIssue,
      questionText,
    );
    if (!slotId) continue;
    const explicitFacetId = String(nextQuestion?.targetFacetId ?? log.targetFacetId ?? '').trim() || null;
    const contract = getIntakeContract(slotId);
    const facetId = explicitFacetId
      ?? inferEvidenceFacetIds(slotId, questionText)[0]
      ?? contract?.requiredFacets[0];
    if (!facetId) continue;
    const key = targetKey(slotId, facetId);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function targetKey(slotId, facetId) {
  return `${slotId ?? ''}:${facetId ?? '*'}`;
}
