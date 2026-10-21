import { FOLLOWUP_ACTIONS } from './followupStrategy.mjs';

export function validateExtractOutput(value) {
  const data = typeof value === 'object' && value !== null ? value : {};
  const complaints = Array.isArray(data.complaints)
    ? data.complaints.filter((item) => typeof item === 'string').slice(0, 5)
    : [];
  const slots = Array.isArray(data.slots)
    ? data.slots
        .filter((item) => item && typeof item === 'object')
        .map((item) => ({
          complaint_id: asString(item.complaint_id),
          slot_id: asString(item.slot_id),
          value: asString(item.value),
          evidence_text: asString(item.evidence_text),
          confidence: clampConfidence(item.confidence),
        }))
        .filter((item) => item.slot_id && item.evidence_text)
        .slice(0, 20)
    : [];
  const risk_signals = Array.isArray(data.risk_signals)
    ? data.risk_signals
        .filter((item) => item && typeof item === 'object')
        .map((item) => ({
          signal_type: asString(item.signal_type),
          trigger_text: asString(item.trigger_text),
          confidence: clampConfidence(item.confidence),
        }))
        .filter((item) => item.signal_type && item.trigger_text)
        .slice(0, 10)
    : [];
  const open_issues = Array.isArray(data.open_issues)
    ? data.open_issues.filter((item) => typeof item === 'string' && item.trim()).slice(0, 10)
    : [];

  return { complaints, slots, risk_signals, open_issues };
}

export function extractJsonObject(text) {
  const raw = String(text ?? '').trim();
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    throw new Error('LLM output is not valid JSON');
  }
}

export function validateClarifyingQuestionOutput(value) {
  const data = typeof value === 'object' && value !== null ? value : {};
  const needClarification = data.need_clarification === true;
  const question = needClarification ? sanitizeQuestion(asString(data.question)) : '';
  return {
    need_clarification: Boolean(needClarification && question),
    target_slot_or_issue: asString(data.target_slot_or_issue),
    question,
    reason: asString(data.reason),
    confidence: clampConfidence(data.confidence),
  };
}

export function validateDynamicStrategyOutput(value) {
  const data = typeof value === 'object' && value !== null ? value : {};
  const selectionReason = sanitizeStrategyText(data.selection_reason ?? data.reason, 60);
  return {
    next_action: 'ask',
    complaint_id: asString(data.complaint_id),
    target_slot_or_issue: asString(data.target_slot_or_issue),
    target_facet_id: asString(data.target_facet_id),
    action_type: normalizeAction(data.action_type),
    selection_reason: selectionReason,
    considered_candidates: sanitizeConsideredCandidates(data.considered_candidates),
    reason: selectionReason,
    confidence: clampConfidence(data.confidence),
  };
}

export function validateDynamicRealizerOutput(value) {
  const data = typeof value === 'object' && value !== null ? value : {};
  const focusedQuestion = normalizeSingleQuestion(sanitizeQuestion(asString(data.question)));
  return {
    question: focusedQuestion && /[？?]$/.test(focusedQuestion) ? focusedQuestion : '',
    ...(data.acknowledgement != null ? { acknowledgement: typeof data.acknowledgement === 'string' ? data.acknowledgement.trim() : '' } : {}),
  };
}

export function validateDynamicNextQuestionOutput(value) {
  const data = typeof value === 'object' && value !== null ? value : {};
  const nextAction = data.next_action === 'complete' ? 'complete' : 'ask';
  const focusedQuestion = nextAction === 'ask' ? normalizeSingleQuestion(sanitizeQuestion(asString(data.question))) : '';
  const validFocusedQuestion = focusedQuestion && /[？?]$/.test(focusedQuestion) ? focusedQuestion : '';
  const acknowledgement = sanitizeAcknowledgement(asString(data.acknowledgement));
  const validQuestion = validFocusedQuestion;
  const selectionReason = sanitizeStrategyText(data.selection_reason ?? data.reason, 60);
  return {
    next_action: nextAction === 'complete' || validQuestion ? nextAction : 'ask',
    question: validQuestion,
    acknowledgement,
    complaint_id: asString(data.complaint_id),
    target_slot_or_issue: asString(data.target_slot_or_issue),
    target_facet_id: asString(data.target_facet_id),
    action_type: normalizeAction(data.action_type),
    selection_reason: selectionReason,
    considered_candidates: sanitizeConsideredCandidates(data.considered_candidates),
    reason: selectionReason,
    confidence: clampConfidence(data.confidence),
  };
}

function sanitizeConsideredCandidates(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item === 'object').slice(0, 3).map((item) => ({
    complaint_id: asString(item.complaint_id),
    target_slot_or_issue: asString(item.target_slot_or_issue),
    target_facet_id: asString(item.target_facet_id),
    action_type: normalizeAction(item.action_type),
    reason: sanitizeStrategyText(item.reason, 60),
  }));
}

function normalizeAction(value) {
  const action = asString(value);
  return FOLLOWUP_ACTIONS.includes(action) ? action : '';
}

function sanitizeStrategyText(value, maxLength) {
  return asString(value).replace(/[\r\n\t？?]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function sanitizeAcknowledgement(value) {
  const text = asString(value).replace(/[？?]/g, '').trim();
  if (!text || text.length > 24) return '';
  const forbidden = ['没事', '别担心', '一定会好', '保证', '诊断', '高危', '低危', '应该治疗', '建议用药'];
  if (forbidden.some((word) => text.includes(word))) return '';
  return /[。！!]$/.test(text) ? text : `${text}。`;
}

function normalizeSingleQuestion(value) {
  const text = String(value ?? '').trim();
  const marks = [...text.matchAll(/[？?]/g)];
  if (marks.length <= 1) return text;
  const firstEnd = marks[0].index + 1;
  return `${text.slice(0, firstEnd - 1).trim()}？`;
}

function sanitizeQuestion(value) {
  const text = asString(value);
  const forbidden = ['诊断为', 'ADHD', 'ASD', '抑郁症', '焦虑症', '建议用药', '剂量', '停药', '换药', '高危', '低危', '治疗方案'];
  if (forbidden.some((word) => text.includes(word))) return '';
  if (text.length > 80) return '';
  return text;
}

function asString(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  return JSON.stringify(value);
}

function clampConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}
