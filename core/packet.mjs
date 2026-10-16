import { COVERAGE_DOMAIN } from './coverage.mjs';
import { INTAKE_CONTRACT_VERSION } from './intakeContracts.mjs';
import { computeProgress, findGaps } from './state.mjs';
import { getTemplate } from './templates.mjs';

export function generatePrevisitPacket(snapshot) {
  const complaintIds = snapshot.session.mappedComplaints?.length
    ? snapshot.session.mappedComplaints
    : snapshot.session.selectedComplaints ?? [];
  const progress = computeProgress(snapshot.slotStates ?? [], complaintIds);
  const evidenceUnits = snapshot.evidenceUnits ?? [];
  const riskSignals = snapshot.riskSignals ?? [];
  const coverageStates = (snapshot.slotStates ?? []).filter(
    (state) => state.complaintId === COVERAGE_DOMAIN,
  );
  const filledStates = coverageStates.filter(
    (state) => ['filled', 'partial', 'ambiguous', 'conflict'].includes(state.status) && state.value != null,
  );
  const gaps = findGaps(snapshot.slotStates ?? [], complaintIds);
  const evidenceBySlot = groupEvidenceBySlot(evidenceUnits);

  const chiefRaw = snapshot.session.chiefComplaint || snapshot.turns?.[0]?.answerText || '';
  const internalLabels = complaintIds.map((id) => getTemplate(id)?.name ?? id);
  const conflictsOrUncertainties = (snapshot.slotStates ?? [])
    .filter((state) => ['ambiguous', 'conflict'].includes(state.status)
      || Object.values(state.value?.facets ?? {})
        .some((facet) => ['ambiguous', 'conflict'].includes(facet.status)))
    .map(toConflictRow);
  const mainSymptoms = sectionFromSlots(filledStates, ['presenting_problem', 'current_manifestations']);
  const course = sectionFromSlots(filledStates, ['onset_course', 'frequency_severity']);
  const functionalImpact = sectionFromSlots(filledStates, ['functional_impact']);
  const backgroundContext = sectionFromSlots(filledStates, ['triggers_context', 'settings_and_sources', 'family_context_history']);
  const physicalDevelopment = sectionFromSlots(filledStates, ['sleep_appetite_physical', 'development_medical_history']);
  const priorHelp = sectionFromSlots(filledStates, ['prior_help_treatment']);
  const goalsAndStrengths = sectionFromSlots(filledStates, ['goals_expectations', 'strengths_protective']);
  const multiSourceDifferences = buildMultiSourceDifferences(coverageStates, evidenceBySlot);
  const riskNotes = riskSignals.map((signal) => ({
    signal_type: signal.signalType,
    trigger_text: signal.triggerText,
    source: signal.source,
    status: signal.status,
    evidence_turn: signal.turnNo ?? null,
    note: '需医生优先核实事实背景和当前安全情况；系统不做风险分层。',
  }));
  const missingInformation = gaps.map((gap) => ({
    complaint_id: gap.complaintId,
    slot_id: gap.slotId,
    facet_id: gap.facetId,
    label: gap.label,
    facet_label: gap.facetLabel,
    status: gap.status,
    note: gap.status === 'missing'
      ? '预问诊未获得可用信息。'
      : gap.status === 'conflict'
        ? '现有来源描述相互冲突。'
        : '现有描述仍不明确。',
  }));
  const sourceEvidence = buildSourceEvidence(evidenceUnits);
  const reporterLabel = isChildReporter(snapshot, evidenceUnits) ? '患儿本人' : '家长/监护人';
  const importantAbnormalities = buildImportantAbnormalities({
    functionalImpact,
    physicalDevelopment,
    conflictsOrUncertainties,
    riskNotes,
  });
  const summary = buildSummary({
    chiefRaw,
    reporterLabel,
    mainSymptoms,
    course,
    functionalImpact,
    backgroundContext,
    riskNotes,
  });

  const content = {
    intake_contract_version: INTAKE_CONTRACT_VERSION,
    basic_info: {
      age: snapshot.session.profile?.age ?? null,
      sex: snapshot.session.profile?.sex ?? null,
      grade: snapshot.session.profile?.grade ?? null,
      respondents: [snapshot.session.profile?.respondent ?? 'guardian'],
    },
    chief_complaint: {
      raw_text: chiefRaw,
      // These are internal scan tags, not a list of front-end complaint choices
      // and not a boundary on the interview.
      mapped_complaints: complaintIds,
      labels: internalLabels,
      tag_usage: 'internal_scan_only',
    },
    completion: progress,
    needs_priority_review: riskSignals.some((signal) => signal.status === 'open'),
    summary,

    // Clinician-facing structure requested for rapid review.
    main_symptoms: mainSymptoms,
    course,
    functional_impact: functionalImpact,
    background_context: backgroundContext,
    multi_source_differences: multiSourceDifferences,
    risk_notes: riskNotes,
    important_abnormalities: importantAbnormalities,
    missing_information: missingInformation,
    evidence_sources: sourceEvidence,

    // Compatibility keys used by the current clinician UI while it migrates
    // to the richer sections above.
    timeline: course,
    core_symptoms: mainSymptoms,
    family_school_context: backgroundContext,
    physical_and_developmental_history: physicalDevelopment,
    prior_help_and_treatment: priorHelp,
    goals_and_strengths: goalsAndStrengths,
    multi_source_evidence: evidenceUnits.map(toEvidenceRow),
    conflicts_or_uncertainties: conflictsOrUncertainties,
    open_issues: missingInformation.map((item) => `${item.label} / ${item.facet_label}：${item.note}`),
    source_evidence_map: Object.fromEntries(
      [...evidenceBySlot.entries()].map(([key, units]) => [key, units.map((unit) => unit.evidenceId)]),
    ),
  };

  return {
    packetId: `PKT-${snapshot.session.sessionId}-${Date.now()}`,
    sessionId: snapshot.session.sessionId,
    version: (snapshot.packets?.length ?? 0) + 1,
    status: 'machine_draft',
    content,
    createdAt: Date.now(),
  };
}

function buildSummary({ chiefRaw, reporterLabel, mainSymptoms, course, functionalImpact, backgroundContext, riskNotes }) {
  const pieces = [];
  if (chiefRaw) pieces.push(`${reporterLabel}本次主要反映：“${chiefRaw}”。`);
  const manifestation = mainSymptoms.find((row) => row.slot_id === 'current_manifestations');
  if (manifestation?.value && manifestation.value !== chiefRaw) pieces.push(`主要表现：${manifestation.value}。`);
  if (course.length) pieces.push(`病程：${course.map(compactFact).join('；')}。`);
  if (functionalImpact.length) pieces.push(`影响：${functionalImpact.map(compactFact).join('；')}。`);
  if (backgroundContext.length) pieces.push(`相关背景：${backgroundContext.slice(0, 2).map(compactFact).join('；')}。`);
  if (riskNotes.length) pieces.push(`记录到${riskNotes.length}条安全相关原话，需医生优先核实。`);
  return pieces.join('');
}

function isChildReporter(snapshot, evidenceUnits) {
  const respondent = snapshot.session.profile?.respondent;
  if (['child', 'patient', 'self', '患儿', '患儿本人', '儿童本人'].includes(respondent)) return true;
  const firstEvidence = evidenceUnits.find((item) => item.turnNo === 1) ?? evidenceUnits[0];
  return firstEvidence?.speakerRole === 'child' || firstEvidence?.source === 'child_self_report';
}

function compactFact(row) {
  return `${row.label}为“${row.value}”`;
}

function sectionFromSlots(states, slotIds) {
  return states
    .filter((state) => slotIds.includes(state.slotId))
    .map((state) => {
      const facetValues = packetFacetValues(state);
      const distinctValues = [...new Set(facetValues.map((facet) => String(facet.value ?? '')).filter(Boolean))];
      const value = ['conflict', 'ambiguous'].includes(state.status)
        ? [...new Set((state.value?.observations ?? []).map((observation) => observation.text).filter(Boolean))].join('；') || state.value?.text
        : distinctValues.length > 1
        ? facetValues.map((facet) => `${facet.label}：${facet.value}`).join('；')
        : distinctValues[0] ?? state.value?.text ?? state.value;
      return {
        slot_id: state.slotId,
        label: state.label,
        value,
        facet_values: facetValues,
        polarity: state.value?.polarity ?? null,
        status: state.status,
        evidence_ids: state.evidenceIds ?? [],
      };
    });
}

function packetFacetValues(state) {
  return Object.values(state.value?.facets ?? {})
    .filter((facet) => facet.value != null && facet.status !== 'missing')
    .map((facet) => ({
      facet_id: facet.facetId,
      label: facet.label,
      status: facet.status,
      value: facet.rawValue ?? facet.value,
      normalized_value: facet.value,
      polarity: facet.polarity,
      evidence_ids: facet.evidenceIds ?? [],
    }));
}

function groupEvidenceBySlot(evidenceUnits) {
  const grouped = new Map();
  for (const evidence of evidenceUnits) {
    const key = `${evidence.domain}:${evidence.slotId}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(evidence);
  }
  return grouped;
}

function buildMultiSourceDifferences(states, evidenceBySlot) {
  const rows = [];
  for (const state of states) {
    const evidence = evidenceBySlot.get(`${state.complaintId}:${state.slotId}`) ?? [];
    const sources = [...new Set(evidence.map((item) => item.source ?? item.speakerRole).filter(Boolean))];
    if (sources.length < 2 && state.status !== 'conflict') continue;
    const polarities = [...new Set(evidence.map((item) => item.polarity).filter(Boolean))];
    const descriptions = [...new Set(evidence.map((item) => item.rawText).filter(Boolean))];
    rows.push({
      slot_id: state.slotId,
      label: state.label,
      status: state.status,
      sources,
      polarities,
      descriptions,
      evidence_ids: state.evidenceIds ?? [],
      note: state.status === 'conflict'
        ? '不同来源或不同轮次存在方向相反的描述。'
        : '已保留多个来源的不同表述，供医生结合场景核实。',
    });
  }
  return rows;
}

function buildImportantAbnormalities({ functionalImpact, physicalDevelopment, conflictsOrUncertainties, riskNotes }) {
  const rows = [];
  for (const risk of riskNotes) {
    rows.push({
      type: 'safety_signal',
      label: '安全相关原话',
      value: risk.trigger_text,
      source: risk.source,
      note: risk.note,
    });
  }
  for (const conflict of conflictsOrUncertainties) {
    rows.push({
      type: conflict.status,
      label: conflict.label,
      value: conflict.value,
      evidence_ids: conflict.evidence_ids,
      note: conflict.note,
    });
  }
  for (const row of [...functionalImpact, ...physicalDevelopment]) {
    if (!isReportedAbnormal(row)) continue;
    rows.push({
      type: row.slot_id === 'functional_impact' ? 'functional_change' : 'health_or_development_change',
      label: row.label,
      value: row.value,
      evidence_ids: row.evidence_ids,
      note: '该项为报告到的变化或影响，不代表诊断结论。',
    });
  }
  return rows;
}

function isReportedAbnormal(row) {
  if (row.polarity === 'absent') return false;
  const text = String(row.value ?? '');
  if (row.slot_id === 'functional_impact') {
    return hasUnnegatedCue(text, [/影响/, /下降/, /缺课/, /迟到/, /早退/, /不能/, /没法/, /冲突/, /困难/, /受损/, /退步/, /拖拉/, /耽误/]);
  }
  if (row.slot_id === 'sleep_appetite_physical') {
    return hasUnnegatedCue(text, [
      /失眠/, /入睡难/, /睡不着/, /早醒/, /睡得晚/, /噩梦/,
      /食欲.{0,4}(?:下降|差|增加)/, /胃口.{0,4}(?:下降|差)/,
      /不吃/, /暴食/, /疲劳/, /没精力/, /头痛/, /头晕/, /腹痛/,
      /肚子疼/, /呕吐/, /胸闷/, /心慌/, /体重.{0,4}(?:下降|增加)/, /不舒服/,
    ]);
  }
  if (row.slot_id === 'development_medical_history') {
    return hasUnnegatedCue(text, [
      /发育迟缓/, /发育落后/, /发育异常/, /发育较慢/, /发育慢/,
      /退步/, /早产/, /住院/, /手术/, /疾病/, /过敏/, /癫痫/, /脑外伤/, /慢性病/, /不正常/,
    ]);
  }
  return false;
}

function hasUnnegatedCue(text, patterns) {
  for (const pattern of patterns) {
    const matcher = new RegExp(pattern.source, 'g');
    for (const match of text.matchAll(matcher)) {
      const before = text.slice(Math.max(0, (match.index ?? 0) - 14), match.index ?? 0);
      const boundary = Math.max(
        before.lastIndexOf('，'), before.lastIndexOf(','), before.lastIndexOf('。'),
        before.lastIndexOf('；'), before.lastIndexOf(';'), before.lastIndexOf('但'),
      );
      const prefix = before.slice(boundary + 1).trim();
      if (/(?:没有|并没有|没|无|否认|未见|并未|不是|不)(?:任何|明显|重要|相关|太|很)?$/.test(prefix)) continue;
      return true;
    }
  }
  return false;
}

function buildSourceEvidence(evidenceUnits) {
  const grouped = new Map();
  for (const evidence of evidenceUnits) {
    const source = evidence.source ?? evidence.speakerRole ?? 'unknown';
    const row = grouped.get(source) ?? { source, evidence_count: 0, turn_numbers: new Set(), evidence_ids: [] };
    row.evidence_count += 1;
    if (evidence.turnNo != null) row.turn_numbers.add(evidence.turnNo);
    row.evidence_ids.push(evidence.evidenceId);
    grouped.set(source, row);
  }
  return [...grouped.values()].map((row) => ({
    ...row,
    turn_numbers: [...row.turn_numbers].sort((a, b) => a - b),
  }));
}

function toEvidenceRow(evidence) {
  return {
    evidence_id: evidence.evidenceId,
    source: evidence.source,
    speaker_role: evidence.speakerRole,
    domain: evidence.domain,
    slot_id: evidence.slotId,
    facet_ids: evidence.facetIds ?? evidence.value?.facetIds ?? [],
    raw_text: evidence.rawText,
    polarity: evidence.polarity,
    confidence: evidence.confidence,
    time_scope: evidence.timeScope,
    turn_no: evidence.turnNo,
  };
}

function toConflictRow(state) {
  const facetConflicts = Object.values(state.value?.facets ?? {})
    .filter((facet) => ['ambiguous', 'conflict'].includes(facet.status))
    .map((facet) => ({
      facet_id: facet.facetId,
      label: facet.label,
      status: facet.status,
      value: facet.value,
      evidence_ids: facet.evidenceIds ?? [],
    }));
  const effectiveStatus = ['conflict', 'ambiguous'].includes(state.status)
    ? state.status
    : facetConflicts.some((facet) => facet.status === 'conflict')
      ? 'conflict'
      : 'ambiguous';
  return {
    complaint_id: state.complaintId,
    slot_id: state.slotId,
    label: state.label || state.slotId,
    status: effectiveStatus,
    value: state.value,
    evidence_ids: state.evidenceIds ?? [],
    facet_conflicts: facetConflicts,
    note: effectiveStatus === 'conflict'
      ? '存在相互冲突的证据，需医生结合来源核实。'
      : '现有证据仍不明确，需医生面诊澄清。',
  };
}
