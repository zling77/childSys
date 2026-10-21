import { createHash } from 'node:crypto';
import { createEvidenceUnits, inferEvidenceFacetIds } from './extractor.mjs';
import { COVERAGE_DOMAIN } from './coverage.mjs';
import { getFacetContract, getIntakeContract, intakeContracts } from './intakeContracts.mjs';
import { findRiskSignals } from './risk.mjs';

export const EVIDENCE_MODEL_VERSION = 'clinician-evidence-1.0-working';
export const SOURCE_ROLES = ['child', 'caregiver', 'teacher_school', 'scale', 'clinical_record', 'clinician', 'other'];
export const SOURCE_LABELS = { child: '患儿', caregiver: '监护人', teacher_school: '教师／学校', scale: '量表', clinical_record: '既往记录', clinician: '医生补充', other: '其他来源' };
const corrections = /(?:刚才|之前|前面|先前|上次).{0,12}(?:说错|记错|不准确|不对|更正)|(?:更正|纠正)(?:一下|前面|之前|先前)|准确地说|其实是/;
const knownContexts = ['home', 'school', 'clinic', 'online'];
const id = (prefix, value) => `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
const normalizePolarity = (value) => ({ present: 'affirmed', absent: 'negated', uncertain: 'uncertain', affirmed: 'affirmed', negated: 'negated' })[value] ?? 'uncertain';
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
export function isValidIsoDay(value) {
  if (!datePattern.test(String(value ?? ''))) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function sourceRoleOf(value) {
  return ({ child_self_report: 'child', child: 'child', patient: 'child', self: 'child', 患儿: 'child', 患儿本人: 'child', parent_report: 'caregiver', guardian: 'caregiver', mother: 'caregiver', father: 'caregiver', caregiver: 'caregiver', teacher: 'teacher_school', teacher_school: 'teacher_school', scale: 'scale', record: 'clinical_record', clinical_record: 'clinical_record', clinician: 'clinician', other: 'other' })[value] ?? 'other';
}

function dayString(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'string' && datePattern.test(value)) return value;
  const time = new Date(value);
  if (!Number.isFinite(time.getTime())) return null;
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(time);
}
function addDays(day, delta) {
  const time = new Date(`${day}T00:00:00Z`);
  time.setUTCDate(time.getUTCDate() + delta);
  return time.toISOString().slice(0, 10);
}
export function referencedTimeSpan(text, observedTime, explicit = null) {
  const raw = String(text ?? '');
  const anchor = dayString(observedTime);
  if (explicit?.start && explicit?.end && isValidIsoDay(explicit.start) && isValidIsoDay(explicit.end) && explicit.start <= explicit.end) return { raw_text: explicit.raw_text || `${explicit.start}至${explicit.end}`, start: explicit.start, end: explicit.end, certainty: 'exact', anchor };
  const dates = raw.match(/\d{4}-\d{2}-\d{2}/g);
  if (dates?.length) return dates.some((date) => !isValidIsoDay(date)) || (dates[1] && dates[0] > dates[1])
    ? { raw_text: dates.slice(0, 2).join('至'), start: null, end: null, certainty: 'unknown', anchor }
    : { raw_text: dates.slice(0, 2).join('至'), start: dates[0], end: dates[1] ?? dates[0], certainty: 'exact', anchor };
  const match = raw.match(/近两周|最近两周|过去两周|本周|这周|上周|上个月|本月|这个月|今天|昨天|前天|目前|现在|最近|过去|以前|曾经|去年|半年前|[一二两三四五六七八九十\d]+(?:天|周|个月|月|年)前/);
  if (!match) return { raw_text: null, start: null, end: null, certainty: 'unknown', anchor };
  const label = match[0];
  let start = null;
  let end = null;
  if (anchor) {
    const weekday = new Date(`${anchor}T00:00:00Z`).getUTCDay();
    const monday = addDays(anchor, -((weekday + 6) % 7));
    if (/两周/.test(label)) { start = addDays(anchor, -13); end = anchor; }
    if (/本周|这周/.test(label)) { start = monday; end = addDays(monday, 6); }
    if (label === '上周') { start = addDays(monday, -7); end = addDays(monday, -1); }
    if (label === '今天') start = end = anchor;
    if (label === '昨天') start = end = addDays(anchor, -1);
    if (label === '前天') start = end = addDays(anchor, -2);
    if (/本月|这个月|上个月/.test(label)) {
      const date = new Date(`${anchor}T00:00:00Z`);
      date.setUTCDate(1);
      if (label === '上个月') date.setUTCMonth(date.getUTCMonth() - 1);
      start = date.toISOString().slice(0, 10);
      date.setUTCMonth(date.getUTCMonth() + 1);
      date.setUTCDate(0);
      end = date.toISOString().slice(0, 10);
    }
  }
  return { raw_text: label, start, end, certainty: start ? 'relative' : 'unknown', anchor };
}

export function temporalRelation(prior, next) {
  const a = prior?.referenced_time_span ?? prior;
  const b = next?.referenced_time_span ?? next;
  if (!a?.start || !a?.end || !b?.start || !b?.end) return 'unknown';
  if (a.end < b.start) return 'before';
  if (a.start > b.end) return 'after';
  if (a.start === b.start && a.end === b.end) return 'same_window';
  if (a.start <= b.start && a.end >= b.end) return 'contains';
  if (b.start <= a.start && b.end >= a.end) return 'contained_by';
  return 'overlaps';
}

function contextOf(text, provided) {
  if (knownContexts.includes(provided)) return provided;
  const contexts = [];
  if (/在家|家里|家庭中/.test(text)) contexts.push('home');
  if (/学校|课堂|上学|到校/.test(text)) contexts.push('school');
  if (/门诊|面诊|诊室/.test(text)) contexts.push('clinic');
  if (/网上|网络|线上/.test(text)) contexts.push('online');
  return contexts.length === 1 ? contexts[0] : 'unknown';
}
function conceptOf(text, slotId, facetId) {
  const patterns = [
    ['suicide_ideation', /不想活|想死|死亡|想消失|不想醒来/], ['self_harm', /自伤|打自己|伤害自己|割手|划伤|抓.{0,5}(?:手臂|自己)/],
    ['sleep', /睡眠|睡觉|入睡|失眠|早醒|睡不着|夜醒/], ['appetite', /食欲|胃口|吃饭|进食/], ['energy', /精力|疲劳|没精神/],
    ['school_function', /上学|缺课|到校|迟到|早退|课堂/], ['learning', /作业|学习|成绩/], ['peer', /朋友|同伴|同学/],
    ['mood', /情绪|哭|低落|开心|难过/], ['attention', /走神|注意力|小动作|多动/],
  ];
  const matched = patterns.filter(([, pattern]) => pattern.test(text)).map(([key]) => key);
  return matched.length === 1 ? matched[0] : `${slotId}:${facetId}`;
}

function quoteSpans(raw) {
  const spans = [];
  const pattern = /[^，,。；;！？!?\n]+/g;
  for (const match of raw.matchAll(pattern)) {
    const trimmed = match[0].trim();
    if (!trimmed) continue;
    const start = match.index + match[0].indexOf(trimmed);
    spans.push({ text: trimmed, start, end: start + trimmed.length });
  }
  return spans;
}

/** Normalize legacy slot evidence into facet claims, retaining exact quote offsets. */
export function normalizeEvidenceUnits(snapshot, caseId) {
  const output = [];
  const seen = new Set();
  for (const unit of snapshot.evidenceUnits ?? []) {
    const semantic = unit.value?.semanticClaim;
    if (semantic) {
      if (semantic.subject !== 'patient') continue;
      const role = sourceRoleOf(unit.source ?? unit.speakerRole);
      const original = snapshot.turns?.find(t => t.turnNo === unit.turnNo)?.answerText ?? semantic.quote;
      const start = original.indexOf(semantic.quote);
      output.push({
        evidenceId: semantic.evidenceId, originEvidenceId: unit.evidenceId, caseId,
        sessionId: unit.sessionId, materialId: null, sourceRole: role, sourceLabel: SOURCE_LABELS[role],
        sourceIdentity: `session:${unit.sessionId}:${role}`, sourceMode: semantic.sourceMode,
        reportedSourceRole: semantic.reportedSource, inputRound: unit.turnNo,
        recordedAt: unit.createdAt, observedTime: unit.createdAt,
        referenced_time_span: referencedTimeSpan(semantic.timeScope ?? semantic.quote, unit.createdAt),
        observationContext: contextOf(semantic.quote), slotId: semantic.slotId, facetId: semantic.facetId,
        topicLabel: getIntakeContract(semantic.slotId)?.label, facetLabel: getFacetContract(semantic.slotId, semantic.facetId)?.label,
        claim: semantic.quote, polarity: semantic.sourceMode === 'inference' ? 'uncertain' : normalizePolarity(semantic.polarity),
        riskFlag: findRiskSignals(semantic.quote, unit.sessionId, unit.turnNo, unit.speakerRole).length > 0,
        concept: semantic.concern ?? `${semantic.slotId}:${semantic.facetId}`,
        explicitCorrection: Boolean(semantic.correctsEvidenceId), correctsEvidenceId: semantic.correctsEvidenceId,
        traceText: semantic.quote, traceRef: { sessionId: unit.sessionId, qaId: `QA-${unit.sessionId}-${unit.turnNo}`,
          materialId: null, start: Math.max(0, start), end: Math.max(0, start) + semantic.quote.length },
        originalText: original, atomization: 'semantic_claim', extractor: 'llm-semantic', schemaVersion: unit.value.semanticVersion,
      });
      continue;
    }
    if (unit.slotId === 'open_narrative' || !getIntakeContract(unit.slotId)) continue;
    const raw = String(unit.rawText ?? '');
    const metadata = unit.value?.provenance ?? {};
    const facets = unit.facetIds ?? unit.value?.facetIds ?? inferEvidenceFacetIds(unit.slotId, raw);
    for (const facetId of facets) {
      if (!getFacetContract(unit.slotId, facetId)) continue;
      const candidates = quoteSpans(raw).filter((span) => inferEvidenceFacetIds(unit.slotId, span.text).includes(facetId));
      const spans = candidates.length ? candidates : [{ text: raw, start: 0, end: raw.length }];
      for (const [spanIndex, span] of spans.entries()) {
        if (!span.text) continue;
        const sourceRole = sourceRoleOf(metadata.sourceRole ?? unit.source ?? unit.speakerRole);
        const traceKey = `${metadata.materialId ?? unit.sessionId}:${unit.turnNo}:${unit.slotId}:${facetId}:${span.start}:${span.end}`;
        if (seen.has(traceKey)) continue;
        seen.add(traceKey);
        const single = createEvidenceUnits({ sessionId: unit.sessionId, turnNo: unit.turnNo, text: span.text, speakerRole: unit.speakerRole, complaintIds: [], currentQuestion: { targetSlotOrIssue: unit.slotId, targetFacetId: facetId, text: '核对已有字段' } }).find((item) => item.slotId === unit.slotId);
        const polarity = normalizePolarity(single?.value?.facetPolarities?.[facetId] ?? unit.value?.facetPolarities?.[facetId] ?? unit.polarity);
        const observedTime = metadata.materialId ? metadata.observedTime ?? null : unit.createdAt;
        const localScope = referencedTimeSpan(span.text, observedTime, metadata.referencedTimeSpan);
        const scope = localScope.raw_text ? localScope : referencedTimeSpan(raw, observedTime, metadata.referencedTimeSpan);
        const reportedRole = metadata.reportedSourceRole ?? (/老师(?:说|反馈)|教师(?:说|反馈)/.test(span.text) ? 'teacher_school' : /孩子说|患儿说/.test(span.text) ? 'child' : null);
        const sourceMode = metadata.sourceMode ?? (reportedRole && sourceRole !== reportedRole ? 'reported' : 'direct');
        const risk = findRiskSignals(span.text, unit.sessionId, unit.turnNo, unit.speakerRole).length > 0;
        output.push({
          evidenceId: id('EU', traceKey), originEvidenceId: unit.evidenceId, caseId, sessionId: metadata.materialId ? null : unit.sessionId, materialId: metadata.materialId ?? null,
          sourceRole, sourceLabel: metadata.sourceLabel || SOURCE_LABELS[sourceRole], sourceIdentity: metadata.sourceIdentity ?? `${metadata.materialId ? 'material' : 'session'}:${metadata.materialId ?? unit.sessionId}:${sourceRole}`,
          sourceMode, reportedSourceRole: reportedRole, inputRound: unit.turnNo, recordedAt: unit.createdAt, observedTime,
          referenced_time_span: scope, observationContext: contextOf(span.text, metadata.observationContext), slotId: unit.slotId, facetId,
          topicLabel: getIntakeContract(unit.slotId).label, facetLabel: getFacetContract(unit.slotId, facetId).label,
          claim: span.text, polarity, riskFlag: risk, concept: conceptOf(span.text, unit.slotId, facetId), explicitCorrection: spanIndex === 0 && corrections.test(raw), correctsEvidenceId: spanIndex === 0 ? metadata.correctsEvidenceId ?? null : null,
          traceText: span.text, traceRef: { sessionId: metadata.materialId ? null : unit.sessionId, qaId: metadata.materialId ? null : `QA-${unit.sessionId}-${unit.turnNo}`, materialId: metadata.materialId ?? null, start: span.start, end: span.end },
          originalText: raw, atomization: candidates.length ? 'clause' : 'facet_quote', extractor: 'deterministic-rule', schemaVersion: EVIDENCE_MODEL_VERSION,
        });
      }
    }
  }
  return output;
}

export function materialEvidenceUnits(material) {
  const fakeSession = `MAT-${material.materialId}`;
  const units = createEvidenceUnits({ sessionId: fakeSession, turnNo: 1, text: material.text, speakerRole: material.sourceRole === 'child' ? 'child' : 'guardian', complaintIds: [], currentQuestion: null });
  if (material.slotId && material.facetId) {
    const facet = getFacetContract(material.slotId, material.facetId);
    if (facet) {
      const target = createEvidenceUnits({ sessionId: fakeSession, turnNo: 1, text: material.text, speakerRole: material.sourceRole === 'child' ? 'child' : 'guardian', complaintIds: [], currentQuestion: { targetSlotOrIssue: material.slotId, targetFacetId: material.facetId, text: '医生补充记录' } }).find((unit) => unit.slotId === material.slotId);
      if (target) { target.facetIds = [material.facetId]; target.value.facetIds = [material.facetId]; units.splice(0, units.length, target); }
    }
  }
  return units.map((unit) => ({ ...unit, source: material.sourceRole, createdAt: material.createdAt, value: { ...unit.value, provenance: { ...material, materialId: material.materialId } } }));
}

function comparable(prior, next) {
  return prior.slotId === next.slotId && prior.facetId === next.facetId && prior.concept === next.concept;
}
function normalizedClaim(claim) {
  return claim.replace(/刚才说错了|之前说错了|我说错了|更正一下|准确地说|其实是/g, '').replace(/\s|[，。；：！？,.;:!?]/g, '');
}

export function classifyEvidenceRelation(prior, next) {
  const temporal = temporalRelation(prior, next);
  let semantic = 'unknown';
  let rationale = '时间、命题限定或量化条件不足，保留待核实。';
  let reasonCode = 'insufficient_scope';
  if (!comparable(prior, next)) return null;
  const separateContext = knownContexts.includes(prior.observationContext) && knownContexts.includes(next.observationContext) && prior.observationContext !== next.observationContext;
  if (separateContext) { semantic = 'not_comparable'; rationale = '两条陈述来自明确不同的观察场景，不自动判为冲突。'; reasonCode = 'different_context'; }
  else if (['before', 'after'].includes(temporal)) { rationale = '证据指向的时间窗不重叠；分别保留，不能据此推断改善、恶化或冲突。'; reasonCode = 'different_time'; }
  else if (next.correctsEvidenceId === prior.evidenceId || (next.explicitCorrection && next.sourceIdentity === prior.sourceIdentity && next.inputRound !== prior.inputRound)) {
    semantic = 'corrects'; rationale = next.correctsEvidenceId ? '医生明确指定纠正此条证据，原始记录保留。' : '同一来源明确纠正先前陈述，保留有方向的修正链。'; reasonCode = 'explicit_correction';
  } else if (prior.polarity !== next.polarity && ![prior.polarity, next.polarity].includes('uncertain')) {
    const observationalDenial = /没(?:有)?(?:看到|观察到|发现)|未(?:观察到|发现|见)/.test(prior.claim + next.claim);
    if (observationalDenial) { rationale = '未观察到与本人体验不同，不能自动当作同一命题的否定。'; reasonCode = 'observation_vs_experience'; }
    else if (temporal !== 'unknown') { semantic = 'contradicts'; rationale = '同一字段、命题及重叠时间窗中出现相反极性，双方证据均保留。'; reasonCode = 'opposite_polarity'; }
    else { rationale = '存在相反描述，但时间范围不明，需核实是否指向同一时段。'; reasonCode = 'possible_discrepancy'; }
  } else if (prior.polarity === next.polarity && normalizedClaim(prior.claim) === normalizedClaim(next.claim)) {
    semantic = 'supports'; rationale = '两条陈述的命题及极性一致；时间关系单独记录，仍不等于临床确认。'; reasonCode = 'same_statement';
  } else if (temporal !== 'unknown' && prior.polarity === next.polarity && next.claim.replace(next.referenced_time_span.raw_text ?? '', '').includes(prior.claim.replace(prior.referenced_time_span.raw_text ?? '', '')) && next.claim.length > prior.claim.length) {
    semantic = 'supplements'; rationale = '新陈述保留原有命题并增加细节，时间与场景未显示互斥。'; reasonCode = 'adds_explicit_detail';
  } else if (prior.polarity === 'uncertain' || next.polarity === 'uncertain') {
    rationale = '至少一条陈述本身不确定，保留原文与未决原因。'; reasonCode = 'uncertain_statement';
  } else {
    rationale = '措辞或数值不同，尚不足以确认支持、补充或冲突。'; reasonCode = 'different_description';
  }
  return { relationId: id('REL', `${prior.evidenceId}:${next.evidenceId}`), caseId: prior.caseId, priorEvidenceId: prior.evidenceId, newEvidenceId: next.evidenceId, slotId: prior.slotId, facetId: prior.facetId, semanticRelation: semantic, temporalRelation: temporal, rationale, reasonCode, reviewStatus: 'machine_candidate', schemaVersion: EVIDENCE_MODEL_VERSION };
}

export function buildEvidenceState(caseId, evidenceUnits) {
  const units = [...evidenceUnits].sort((a, b) => a.recordedAt - b.recordedAt || a.inputRound - b.inputRound || a.evidenceId.localeCompare(b.evidenceId));
  const relations = [];
  const byFacet = new Map();
  for (const next of units) {
    const key = `${next.slotId}:${next.facetId}:${next.concept}`;
    const priorUnits = byFacet.get(key) ?? [];
    const previousSameSource = [...priorUnits].reverse().find((prior) => prior.sourceIdentity === next.sourceIdentity);
    for (const prior of priorUnits) {
      // An unqualified correction applies to the immediately preceding comparable statement from that reporter.
      const candidate = next.explicitCorrection && !next.correctsEvidenceId && prior !== previousSameSource ? { ...next, explicitCorrection: false } : next;
      const relation = classifyEvidenceRelation(prior, candidate);
      if (relation) relations.push(relation);
    }
    priorUnits.push(next);
    byFacet.set(key, priorUnits);
  }
  const supersededIds = new Set(relations.filter((r) => r.semanticRelation === 'corrects').map((r) => r.priorEvidenceId));
  const topicStates = intakeContracts.map((contract) => {
    const topicUnits = units.filter((unit) => unit.slotId === contract.slotId);
    const effective = topicUnits.filter((unit) => !supersededIds.has(unit.evidenceId));
    const activeRelations = relations.filter((r) => r.slotId === contract.slotId && !supersededIds.has(r.priorEvidenceId) && !supersededIds.has(r.newEvidenceId));
    const status = activeRelations.some((r) => r.semanticRelation === 'contradicts') ? 'disputed'
      : effective.some((e) => e.polarity === 'uncertain') || activeRelations.some((r) => ['possible_discrepancy', 'observation_vs_experience', 'uncertain_statement'].includes(r.reasonCode)) ? 'pending_review'
      : effective.length ? 'reported' : 'missing';
    return { topicId: contract.slotId, label: contract.label, status, evidenceIds: topicUnits.map((e) => e.evidenceId), effectiveEvidenceIds: effective.map((e) => e.evidenceId), sources: [...new Set(topicUnits.map((e) => e.sourceRole))], facets: contract.facets.map((facet) => ({ facetId: facet.facetId, label: facet.label, required: contract.requiredFacets.includes(facet.facetId), evidenceIds: topicUnits.filter((e) => e.facetId === facet.facetId).map((e) => e.evidenceId) })) };
  });
  return { caseId, schemaVersion: EVIDENCE_MODEL_VERSION, evidenceUnits: units.map((e) => ({ ...e, superseded: supersededIds.has(e.evidenceId) })), evidenceRelations: relations, topicStates, revisionChains: relations.filter((r) => r.semanticRelation === 'corrects'), openIssues: topicStates.filter((s) => ['disputed', 'pending_review', 'missing'].includes(s.status)) };
}

export function packetFromEvidenceState(state, { clinicalCase, sessions, reviews, version }) {
  const sections = {
    main_symptoms: ['presenting_problem', 'current_manifestations'], course: ['onset_course', 'frequency_severity'], functional_impact: ['functional_impact'],
    background_context: ['triggers_context', 'settings_and_sources', 'family_context_history'], physical_and_developmental_history: ['sleep_appetite_physical', 'development_medical_history'],
    prior_help_and_treatment: ['prior_help_treatment'], goals_and_strengths: ['goals_expectations', 'strengths_protective'],
  };
  const content = {};
  for (const [name, slotIds] of Object.entries(sections)) {
    content[name] = state.topicStates.filter((topic) => slotIds.includes(topic.topicId) && topic.evidenceIds.length).map((topic) => {
      const units = state.evidenceUnits.filter((unit) => topic.effectiveEvidenceIds.includes(unit.evidenceId));
      return { slot_id: topic.topicId, label: topic.label, status: topic.status, evidence_ids: units.map((e) => e.evidenceId), statements: units.map((e) => ({ evidence_id: e.evidenceId, text: e.claim, source_role: e.sourceRole, source_mode: e.sourceMode, reported_source_role: e.reportedSourceRole, time_scope: e.referenced_time_span.raw_text, context: e.observationContext, polarity: e.polarity })) };
    });
  }
  const availableRoles = new Set(state.evidenceUnits.map((e) => e.sourceRole));
  const sourceOverview = SOURCE_ROLES.map((role) => ({ sourceRole: role, label: SOURCE_LABELS[role], available: availableRoles.has(role), evidenceCount: state.evidenceUnits.filter((e) => e.sourceRole === role).length }));
  const riskGroups = new Map();
  for (const unit of state.evidenceUnits.filter((e) => e.riskFlag)) {
    const key = `${unit.sessionId ?? unit.materialId}:${unit.inputRound}:${unit.traceText}`;
    if (!riskGroups.has(key) || unit.slotId === 'safety_clues') riskGroups.set(key, unit);
  }
  const riskUnits = [...riskGroups.values()];
  const missing = state.topicStates.flatMap((topic) => topic.facets.filter((facet) => facet.required && !facet.evidenceIds.length).map((facet) => ({ issue_id: `${topic.topicId}:${facet.facetId}`, slot_id: topic.topicId, facet_id: facet.facetId, label: `${topic.label}／${facet.label}`, status: 'missing', note: '未取得此字段的可追溯证据；请结合会话覆盖记录区分未问、拒答或材料不可获得。' })));
  const coverageIssues = sessions.flatMap((session) => (session.snapshot.slotStates ?? []).flatMap((topic) => Object.values(topic.value?.facets ?? {}).filter((facet) => ['declined', 'unavailable', 'not_applicable'].includes(facet.status)).map((facet) => ({ issue_id: `${topic.slotId}:${facet.facetId}`, slot_id: topic.slotId, facet_id: facet.facetId, status: facet.status, session_id: session.sessionId }))));
  for (const item of missing) {
    const reasons = coverageIssues.filter((issue) => issue.issue_id === item.issue_id);
    if (reasons.length) { item.source_statuses = reasons; item.note = `相关会话记录：${reasons.map((r) => ({ declined: '拒答', unavailable: '不可获得', not_applicable: '不适用' })[r.status]).join('、')}；仍保留来源与字段范围。`; }
    else {
      const asked = sessions.flatMap((session) => session.snapshot.turns ?? []).filter((turn) => turn.targetSlotOrIssue === item.slot_id && turn.targetFacetId === item.facet_id);
      item.collection_reason = asked.length ? 'asked_unresolved' : 'not_asked';
      item.note = asked.length ? `已记录${asked.length}次定向询问，仍未取得此字段的可追溯证据。` : '未记录对此字段的定向询问，且暂无其他来源的可追溯证据。';
    }
  }
  for (const topic of state.topicStates) for (const facet of topic.facets) {
    const active = state.evidenceUnits.filter((unit) => facet.evidenceIds.includes(unit.evidenceId) && !unit.superseded);
    const related = state.evidenceRelations.filter((r) => r.slotId === topic.topicId && r.facetId === facet.facetId && active.some((e) => e.evidenceId === r.priorEvidenceId) && active.some((e) => e.evidenceId === r.newEvidenceId));
    const disputed = related.some((r) => r.semanticRelation === 'contradicts');
    const uncertain = active.some((e) => e.polarity === 'uncertain') || related.some((r) => ['possible_discrepancy', 'observation_vs_experience', 'uncertain_statement'].includes(r.reasonCode));
    if (disputed || uncertain) missing.push({ issue_id: `${topic.topicId}:${facet.facetId}`, slot_id: topic.topicId, facet_id: facet.facetId, label: `${topic.label}／${facet.label}`, status: disputed ? 'disputed' : 'pending_review', evidence_ids: active.map((e) => e.evidenceId), note: disputed ? '已取得相互分歧的陈述，需结合双方原文核实范围。' : '已有陈述，但极性、时间或观察范围仍需核实。' });
  }
  return {
    schema_version: state.schemaVersion, case_id: state.caseId, basic_info: clinicalCase.profile, source_overview: sourceOverview,
    chief_complaints: sessions.map((session) => ({ session_id: session.sessionId, source_role: sourceRoleOf(session.snapshot.session.profile?.respondent), text: session.snapshot.session.chiefComplaint })),
    summary: `${sessions.length}个关联会话，${state.evidenceUnits.length}条字段证据；${state.topicStates.filter((s) => s.status === 'disputed').length}个主题存在分歧，${state.revisionChains.length}条明确修正关系。所有条目为来源陈述，需结合原文核实。`,
    ...content, risk_notes: riskUnits.map((e) => ({ evidence_id: e.evidenceId, trigger_text: e.traceText, source_role: e.sourceRole, time_scope: e.referenced_time_span.raw_text, superseded: e.superseded })),
    needs_priority_review: riskUnits.length > 0, missing_information: missing,
    differences: state.evidenceRelations.filter((r) => ['contradicts', 'corrects'].includes(r.semanticRelation) || ['possible_discrepancy', 'different_time', 'different_context', 'observation_vs_experience'].includes(r.reasonCode)),
    evidence_state: state, reviews, evidence_revision: version, packet_status: 'machine_draft',
  };
}

export function comparePacketVersions(previous, next) {
  if (!previous) return { added: next.evidence_state?.evidenceUnits ?? [], removed: [], revised: [], relationsAdded: next.evidence_state?.evidenceRelations ?? [], reviewsAdded: next.reviews ?? [] };
  const oldUnits = previous.evidence_state?.evidenceUnits ?? [];
  const newUnits = next.evidence_state?.evidenceUnits ?? [];
  const oldIds = new Set(oldUnits.map((e) => e.evidenceId));
  const newIds = new Set(newUnits.map((e) => e.evidenceId));
  const oldRelations = new Set((previous.evidence_state?.evidenceRelations ?? []).map((r) => r.relationId));
  const oldReviews = new Set((previous.reviews ?? []).map((r) => r.reviewId));
  return {
    added: newUnits.filter((e) => !oldIds.has(e.evidenceId)), removed: oldUnits.filter((e) => !newIds.has(e.evidenceId)),
    revised: newUnits.filter((e) => oldIds.has(e.evidenceId) && oldUnits.find((o) => o.evidenceId === e.evidenceId)?.superseded !== e.superseded),
    relationsAdded: (next.evidence_state?.evidenceRelations ?? []).filter((r) => !oldRelations.has(r.relationId)), reviewsAdded: (next.reviews ?? []).filter((r) => !oldReviews.has(r.reviewId)),
  };
}
