import { COVERAGE_DOMAIN, intakeCoverageDomains } from './coverage.mjs';
import { inferEvidenceFacetIds } from './extractor.mjs';
import { referencedTimeSpan, temporalRelation } from './evidenceGraph.mjs';
import {
  INTAKE_CONTRACT_VERSION,
  getFacetContract,
  getIntakeContract,
  intakeContracts,
} from './intakeContracts.mjs';

const UNRESOLVED_STATUSES = new Set(['missing', 'partial', 'ambiguous', 'conflict']);
const NON_EVIDENCE_RESOLVED_STATUSES = new Set(['declined', 'unavailable', 'not_applicable']);

// Closed-enum aliases are intentionally small and deterministic. Unknown
// wording stays unresolved instead of being guessed into the nearest bucket.
const FACET_ENUM_ALIASES = {
  time_window: [
    ['past_2_weeks', /最近两周|近两周|过去两周|这两周/],
    ['past_month', /最近(?:一|1)个?月|近(?:一|1)个?月|过去(?:一|1)个?月|这个月/],
    ['typical_week', /平时.{0,4}(?:一周|每周)|通常.{0,4}(?:一周|每周)|每周/],
    ['typical_month', /平时.{0,4}(?:一个月|每月)|通常.{0,4}(?:一个月|每月)|每月/],
    ['other', /其他|其它/],
    ['unclear', /不清楚|不知道|说不准|记不清/],
  ],
  course_pattern: [
    ['worsening', /加重|更严重|越来越(?:多|明显|严重)|变多|恶化/],
    ['improving', /好转|减轻|变少|改善/],
    ['fluctuating', /时好时坏|反复|有好有坏|波动/],
    ['episodic', /偶发|一阵一阵|间歇/],
    ['stable', /基本(?:没变|不变)|没有变化|没变化|稳定|差不多|一直如此/],
    ['unclear', /不清楚|不知道|说不准|看不出来/],
  ],
  affected_domains: [
    ['school', /上学|学校|到校|缺课|迟到|早退/],
    ['learning', /学习|课堂|作业|成绩/],
    ['family', /家庭|家里|家人/],
    ['peers', /同伴|朋友|同学|人际/],
    ['daily_living', /日常生活|生活起居/],
    ['self_care', /自理|洗漱|穿衣|吃饭/],
    ['activities', /活动|运动|兴趣班/],
    ['other', /其他|其它/],
  ],
  settings: [
    ['home', /在家|家里|家庭/],
    ['school', /学校|课堂|上学/],
    ['peers', /同伴|朋友|同学/],
    ['community', /社区|外面|公共场所/],
    ['other', /其他|其它/],
  ],
  cross_setting_pattern: [
    ['context_specific', /只在|仅在|主要在|学校更明显|家里更明显|某些场景/],
    ['mixed', /明显不同|不一样|有时不同|不完全一样|有些不同|混合/],
    ['consistent', /都这样|都一样|大致一样|基本一样|差不多|一致/],
    ['unclear', /不清楚|不知道|说不准/],
  ],
  informant_sources: [
    ['child', /孩子自己|孩子说|本人|患儿|我自己/],
    ['guardian', /家长|父母|爸爸|妈妈|监护人|照护者|我们发现/],
    ['teacher', /老师|教师/],
    ['other_caregiver', /祖父|祖母|爷爷|奶奶|外公|外婆|保姆|其他照护者/],
    ['clinician', /医生|医师|治疗师/],
    ['other', /其他|其它/],
  ],
  sleep_change: [
    ['no_change', /睡眠正常|睡觉正常|没有变化|没变化|和平时一样/],
    ['difficulty_falling_asleep', /入睡困难|难入睡|睡不着/],
    ['night_waking', /夜醒|半夜醒|睡到一半醒/],
    ['early_waking', /早醒|醒得早/],
    ['sleeping_more', /睡得多|嗜睡|睡眠增多/],
    ['irregular', /不规律|作息乱|昼夜颠倒/],
    ['other', /其他|其它/],
    ['unclear', /不清楚|不知道|说不准/],
  ],
  appetite_change: [
    ['no_change', /食欲正常|胃口正常|没有变化|没变化|和平时一样/],
    ['increased', /食欲增加|胃口变好|吃得更多|吃得多/],
    ['decreased', /食欲下降|胃口变差|吃得更少|吃得少/],
    ['selective', /挑食|偏食/],
    ['irregular', /不规律|有时多有时少/],
    ['other', /其他|其它/],
    ['unclear', /不清楚|不知道|说不准/],
  ],
  energy_change: [
    ['no_change', /精力正常|精神正常|没有变化|没变化|和平时一样/],
    ['increased', /精力增加|精神亢奋|精力旺盛|更有精神/],
    ['decreased', /精力下降|没精神|疲劳|没力气/],
    ['variable', /时好时坏|波动|忽高忽低/],
    ['other', /其他|其它/],
    ['unclear', /不清楚|不知道|说不准/],
  ],
  intervention_types: [
    ['medical_visit', /看过医生|就诊|医院|门诊/],
    ['assessment', /评估|测评|检查/],
    ['counseling', /咨询|心理治疗|谈话治疗/],
    ['training', /训练|康复|行为干预/],
    ['medication', /服药|吃药|用药|药物/],
    ['inpatient_care', /住院/],
    ['other', /其他|其它/],
  ],
};

export function updateSlotStates(snapshot, complaintIds, evidenceUnits) {
  const byKey = new Map((snapshot.slotStates ?? []).map((state) => [
    `${state.complaintId}:${state.slotId}`,
    normalizeStoredState(state),
  ]));
  const evidenceById = new Map(
    [...(snapshot.evidenceUnits ?? []), ...evidenceUnits].map((evidence) => [evidence.evidenceId, evidence]),
  );
  const now = Date.now();

  // Coverage is session-wide. Complaint tags are deliberately ignored here so
  // an initial interview remains comprehensive even when no tag is recognized.
  for (const contract of intakeContracts) {
    const key = `${COVERAGE_DOMAIN}:${contract.slotId}`;
    if (!byKey.has(key)) {
      byKey.set(key, createMissingSlotState(snapshot.session.sessionId, contract, now));
    }
  }

  for (const evidence of evidenceUnits) {
    if (!evidence.slotId || evidence.slotId === 'open_narrative') continue;
    const contract = getIntakeContract(evidence.slotId);
    if (!contract) continue;
    const key = `${evidence.domain}:${evidence.slotId}`;
    const previous = byKey.get(key)
      ?? createMissingSlotState(snapshot.session.sessionId, contract, now, evidence.domain);
    const observations = mergeObservations(previous, evidence, evidenceById);
    const facets = mergeFacetStates(previous, contract, evidence, evidenceById, now);
    byKey.set(key, {
      ...previous,
      status: deriveSlotStatus(contract, facets),
      value: mergeStateValue(previous.value, evidence.value, evidence, observations, facets),
      evidenceIds: [...new Set([...(previous.evidenceIds ?? []), evidence.evidenceId])],
      updatedAt: now,
    });
  }

  return [...byKey.values()];
}

export function computeProgress(slotStates, complaintIds) {
  const byKey = new Map((slotStates ?? []).map((state) => {
    const normalized = normalizeStoredState(state);
    return [`${normalized.complaintId}:${normalized.slotId}`, normalized];
  }));
  const required = requiredSlotRows();
  const total = required.length;
  const filled = required.filter(({ complaintId, slotId }) => {
    const state = byKey.get(`${complaintId}:${slotId}`);
    return state?.status === 'filled';
  }).length;
  return {
    requiredFilled: filled,
    requiredTotal: total,
    percent: total ? Math.round((filled / total) * 100) : 0,
  };
}

export function findGaps(slotStates, complaintIds) {
  const byKey = new Map((slotStates ?? []).map((state) => {
    const normalized = normalizeStoredState(state);
    return [`${normalized.complaintId}:${normalized.slotId}`, normalized];
  }));
  return intakeContracts.flatMap((contract) => {
    const state = byKey.get(`${COVERAGE_DOMAIN}:${contract.slotId}`);
    return contract.requiredFacets.flatMap((facetId) => {
      const facet = getStoredFacetState(state, contract, facetId);
      if (!UNRESOLVED_STATUSES.has(facet.status)) return [];
      const facetContract = getFacetContract(contract.slotId, facetId);
      return [{
        complaintId: COVERAGE_DOMAIN,
        slotId: contract.slotId,
        facetId,
        targetFacetId: facetId,
        label: contract.label,
        facetLabel: facetContract?.label ?? facetId,
        status: facet.status,
        stateStatus: facet.status,
        priority: contract.priority ?? 0.5,
        attemptBudget: facetContract?.attemptBudget ?? contract.attemptBudget ?? 2,
        evidenceIds: facet.evidenceIds ?? [],
      }];
    });
  });
}

function requiredSlotRows() {
  return intakeCoverageDomains.map((domain) => ({
    complaintId: COVERAGE_DOMAIN,
    slotId: domain.slotId,
    label: domain.label,
  }));
}

function createMissingSlotState(sessionId, contract, now, complaintId = COVERAGE_DOMAIN) {
  return {
    sessionId,
    complaintId,
    slotId: contract.slotId,
    label: contract.label,
    status: 'missing',
    value: {
      schemaVersion: INTAKE_CONTRACT_VERSION,
      text: '',
      polarity: null,
      observations: [],
      facets: Object.fromEntries(contract.facets.map((facet) => [
        facet.facetId,
        createMissingFacetState(facet, contract.requiredFacets.includes(facet.facetId), now),
      ])),
    },
    evidenceIds: [],
    updatedAt: now,
  };
}

function createMissingFacetState(facet, required, now) {
  return {
    facetId: facet.facetId,
    label: facet.label,
    type: facet.type,
    required,
    status: 'missing',
    value: null,
    rawValue: null,
    normalizationValid: null,
    normalizationIssue: null,
    polarity: null,
    selectedEvidenceId: null,
    selectedConfidence: null,
    observations: [],
    evidenceIds: [],
    updatedAt: now,
  };
}

function normalizeStoredState(state) {
  const contract = getIntakeContract(state.slotId);
  if (!contract) return { ...state };
  const now = state.updatedAt ?? Date.now();
  const base = createMissingSlotState(state.sessionId, contract, now, state.complaintId);
  const hasStoredFacets = state.value?.facets && typeof state.value.facets === 'object';
  const storedFacets = hasStoredFacets
    ? state.value.facets
    : {};
  const legacyObservations = Array.isArray(state.value?.observations) ? state.value.observations : [];
  const legacyText = state.value?.text ?? (typeof state.value === 'string' ? state.value : '');
  const inferredLegacyFacetIds = hasStoredFacets || state.status === 'missing'
    ? []
    : inferEvidenceFacetIds(contract.slotId, legacyText);
  if (!hasStoredFacets && NON_EVIDENCE_RESOLVED_STATUSES.has(state.status)) {
    inferredLegacyFacetIds.splice(0, inferredLegacyFacetIds.length, ...contract.requiredFacets);
  } else if (!hasStoredFacets && state.status !== 'missing' && inferredLegacyFacetIds.length === 0) {
    inferredLegacyFacetIds.push(contract.requiredFacets[0]);
  }
  const facets = Object.fromEntries(contract.facets.map((facet) => {
    const stored = storedFacets[facet.facetId];
    const legacyFacet = !hasStoredFacets && inferredLegacyFacetIds.includes(facet.facetId)
      ? {
          ...base.value.facets[facet.facetId],
          status: state.status,
          value: legacyText || null,
          rawValue: legacyText || null,
          normalizationValid: null,
          polarity: state.value?.polarity ?? null,
          observations: legacyObservations.length > 0
            ? legacyObservations
            : (state.evidenceIds ?? []).slice(0, 1).map((evidenceId) => ({
                evidenceId,
                facetId: facet.facetId,
                text: legacyText,
                polarity: state.value?.polarity ?? 'present',
                confidence: state.status === 'partial' ? 0.5 : 0.75,
                source: 'legacy_slot_state',
                speakerRole: null,
                turnNo: null,
              })),
          evidenceIds: [...(state.evidenceIds ?? [])],
        }
      : null;
    return [facet.facetId, stored
      ? {
          ...base.value.facets[facet.facetId],
          ...stored,
          rawValue: stored.rawValue ?? (typeof stored.value === 'string' ? stored.value : null),
          observations: Array.isArray(stored.observations) ? stored.observations : [],
          evidenceIds: Array.isArray(stored.evidenceIds) ? stored.evidenceIds : [],
        }
      : legacyFacet ?? base.value.facets[facet.facetId]];
  }));
  const normalized = {
    ...base,
    ...state,
    value: {
      ...base.value,
      ...(state.value && typeof state.value === 'object' ? state.value : { text: state.value ?? '' }),
      facets,
      observations: Array.isArray(state.value?.observations) ? state.value.observations : [],
    },
  };
  normalized.status = deriveSlotStatus(contract, facets);
  return normalized;
}

function mergeFacetStates(previous, contract, evidence, evidenceById, now) {
  const facets = { ...(previous.value?.facets ?? {}) };
  for (const facet of contract.facets) {
    if (!facets[facet.facetId]) {
      facets[facet.facetId] = createMissingFacetState(
        facet,
        contract.requiredFacets.includes(facet.facetId),
        now,
      );
    }
  }

  for (const facetId of evidenceFacetIds(evidence, contract)) {
    const facetContract = getFacetContract(contract.slotId, facetId);
    if (!facetContract) continue;
    const previousFacet = facets[facetId];
    const facetPolarity = evidence.value?.facetPolarities?.[facetId]
      ?? normalizePolarity(evidence.polarity);
    const normalized = normalizeFacetValue(evidence, facetId, facetContract, facetPolarity);
    const observations = mergeFacetObservations(
      previousFacet,
      evidence,
      evidenceById,
      facetId,
      facetPolarity,
    );
    const incomingConfidence = Number(evidence.confidence) || 0;
    const previousConfidence = Math.max(
      0,
      ...(previousFacet.observations ?? []).map((item) => Number(item.confidence) || 0),
    );
    const shouldReplaceMaterializedValue = (previousFacet.evidenceIds ?? []).length === 0
      || observations.slice(0, -1).some((item) => isExplicitCorrection(observations.at(-1), item))
      || (normalized.valid && previousFacet.normalizationValid === false)
      || (normalized.valid && incomingConfidence >= previousConfidence);
    const status = deriveFacetStatus(
      observations,
      facetContract,
      shouldReplaceMaterializedValue ? normalized.valid : previousFacet.normalizationValid !== false,
      normalized.ambiguous === true && incomingConfidence >= previousConfidence,
    );
    facets[facetId] = {
      ...previousFacet,
      status,
      value: shouldReplaceMaterializedValue ? normalized.value : previousFacet.value,
      rawValue: shouldReplaceMaterializedValue ? normalized.rawValue : previousFacet.rawValue,
      normalizationValid: shouldReplaceMaterializedValue
        ? normalized.valid
        : previousFacet.normalizationValid,
      normalizationIssue: normalized.ambiguous === true && incomingConfidence >= previousConfidence
        ? 'multiple_enum_values'
        : previousFacet.normalizationIssue ?? null,
      polarity: shouldReplaceMaterializedValue ? facetPolarity : previousFacet.polarity,
      selectedEvidenceId: shouldReplaceMaterializedValue
        ? evidence.evidenceId
        : previousFacet.selectedEvidenceId,
      selectedConfidence: shouldReplaceMaterializedValue
        ? incomingConfidence
        : previousFacet.selectedConfidence,
      observations,
      evidenceIds: [...new Set([...(previousFacet.evidenceIds ?? []), evidence.evidenceId])],
      updatedAt: now,
    };
  }
  return facets;
}

function evidenceFacetIds(evidence, contract) {
  const hasFacetMetadata = Array.isArray(evidence.facetIds)
    || Array.isArray(evidence.value?.facetIds)
    || Object.prototype.hasOwnProperty.call(evidence, 'facetId')
    || Object.prototype.hasOwnProperty.call(evidence.value ?? {}, 'facetId');
  const explicit = [
    ...(Array.isArray(evidence.facetIds) ? evidence.facetIds : []),
    ...(Array.isArray(evidence.value?.facetIds) ? evidence.value.facetIds : []),
    evidence.facetId,
    evidence.value?.facetId,
  ].filter(Boolean);
  if (hasFacetMetadata) return [...new Set(explicit)];

  // Historical v1 evidence was slot-level. Re-infer conservatively from its
  // raw text; never duplicate one old claim across every required facet.
  const inferred = inferEvidenceFacetIds(
    contract.slotId,
    evidence.value?.text ?? evidence.rawText ?? '',
  );
  return inferred.length > 0 ? inferred : [contract.requiredFacets[0]];
}

function getStoredFacetState(state, contract, facetId) {
  const stored = state?.value?.facets?.[facetId];
  if (stored) return stored;
  const facet = getFacetContract(contract.slotId, facetId);
  return createMissingFacetState(facet, true, state?.updatedAt ?? Date.now());
}

function mergeObservations(previous, evidence, evidenceById) {
  const prior = Array.isArray(previous.value?.observations)
    ? previous.value.observations
    : (previous.evidenceIds ?? [])
        .map((evidenceId) => evidenceById.get(evidenceId))
        .filter(Boolean)
        .map(toObservation);
  const observations = [...prior, toObservation(evidence)];
  return [...new Map(observations.map((item) => [item.evidenceId, item])).values()];
}

function mergeFacetObservations(previousFacet, evidence, evidenceById, facetId, facetPolarity) {
  const prior = Array.isArray(previousFacet?.observations)
    ? previousFacet.observations
    : (previousFacet?.evidenceIds ?? [])
        .map((evidenceId) => evidenceById.get(evidenceId))
        .filter(Boolean)
        .map((item) => toObservation(item, facetId, item.value?.facetPolarities?.[facetId]));
  const observations = [...prior, toObservation(evidence, facetId, facetPolarity)];
  return [...new Map(observations.map((item) => [item.evidenceId, item])).values()];
}

function toObservation(evidence, facetId = null, polarity = null) {
  return {
    evidenceId: evidence.evidenceId,
    facetId,
    text: evidence.value?.text ?? evidence.rawText ?? '',
    polarity: normalizePolarity(polarity ?? evidence.polarity),
    confidence: Number.isFinite(Number(evidence.confidence)) ? Number(evidence.confidence) : 0.5,
    source: evidence.source ?? null,
    speakerRole: evidence.speakerRole ?? null,
    turnNo: evidence.turnNo ?? null,
    sessionId: evidence.sessionId ?? null,
    referenced_time_span: referencedTimeSpan(evidence.rawText ?? evidence.value?.text, evidence.createdAt, evidence.value?.provenance?.referencedTimeSpan),
    correctsEvidenceId: evidence.value?.provenance?.correctsEvidenceId ?? null,
  };
}

function mergeStateValue(previousValue, value, evidence, observations, facets) {
  const latest = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : { text: value ?? evidence.rawText ?? '' };
  return {
    ...(previousValue && typeof previousValue === 'object' ? previousValue : {}),
    ...latest,
    schemaVersion: INTAKE_CONTRACT_VERSION,
    polarity: normalizePolarity(evidence.polarity),
    observations,
    facets,
  };
}

export function normalizeFacetValue(evidence, facetId, facetContract = null, polarity = null) {
  const contract = facetContract ?? getFacetContract(evidence?.slotId, facetId);
  const rawValue = String(evidence?.value?.text ?? evidence?.rawText ?? '').trim();
  const normalizedPolarity = normalizePolarity(polarity ?? evidence?.polarity);
  if (!contract) return { value: rawValue || null, rawValue, valid: false };

  if (contract.type === 'boolean') {
    return {
      value: normalizedPolarity === 'uncertain' ? null : normalizedPolarity === 'present',
      rawValue,
      valid: true,
    };
  }

  if (normalizedPolarity === 'absent') {
    if (contract.normalization?.strategy === 'frequency_expression'
      && contract.negationPolicy?.strategy === 'normalize_explicit_absence_to_zero') {
      return { value: 0, rawValue, valid: true };
    }
    if (contract.type === 'multi_enum') return { value: [], rawValue, valid: true };
    if (contract.type === 'enum') return { value: null, rawValue, valid: true };
    return { value: rawValue || null, rawValue, valid: true };
  }

  if (normalizedPolarity === 'uncertain') {
    if (contract.type === 'multi_enum') return { value: [], rawValue, valid: true };
    if (contract.type === 'enum') return { value: null, rawValue, valid: true };
    return { value: rawValue || null, rawValue, valid: true };
  }

  if (contract.type === 'enum' || contract.type === 'multi_enum') {
    const matches = normalizeClosedEnum(rawValue, contract);
    if (contract.type === 'enum' && matches.length > 1) {
      return { value: null, rawValue, valid: false, ambiguous: true };
    }
    return {
      value: contract.type === 'multi_enum' ? matches : matches[0] ?? null,
      rawValue,
      valid: matches.length > 0,
      ambiguous: false,
    };
  }

  return { value: rawValue || null, rawValue, valid: rawValue.length > 0 };
}

function normalizeClosedEnum(rawValue, facetContract) {
  const text = String(rawValue ?? '').trim();
  if (!text) return [];
  const allowed = new Set(facetContract.enumValues ?? []);
  const matches = [];
  const add = (canonical) => {
    if (allowed.has(canonical) && !matches.includes(canonical)) matches.push(canonical);
  };

  for (const canonical of allowed) {
    if (text === canonical || new RegExp(`(?:^|[,;\\s])${escapeRegExp(canonical)}(?:$|[,;\\s])`, 'i').test(text)) {
      add(canonical);
    }
  }
  for (const [canonical, pattern] of FACET_ENUM_ALIASES[facetContract.facetId] ?? []) {
    if (pattern.test(text)) add(canonical);
  }
  return matches;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function deriveSlotStatus(contract, facets) {
  const required = contract.requiredFacets.map((facetId) => facets[facetId]);
  if (required.some((facet) => facet?.status === 'conflict')) return 'conflict';
  if (required.some((facet) => facet?.status === 'ambiguous')) return 'ambiguous';
  if (required.every((facet) => contract.completionPolicy.resolvedStatuses.includes(facet?.status))) {
    return 'filled';
  }
  if (required.every((facet) => facet?.status === 'missing')) return 'missing';
  return 'partial';
}

function deriveFacetStatus(observations, facetContract, normalizationValid = true, normalizationAmbiguous = false) {
  const effective = observations.filter((prior, index) => !observations.slice(index + 1).some((next) => isExplicitCorrection(next, prior)));
  const polarities = new Set(effective.map((item) => normalizePolarity(item.polarity)));
  if (effective.some((left, index) => effective.slice(index + 1).some((right) =>
    normalizePolarity(left.polarity) !== normalizePolarity(right.polarity)
    && ![left.polarity, right.polarity].includes('uncertain')
    && !['before', 'after'].includes(temporalRelation(left, right))))) return 'conflict';
  if (normalizationAmbiguous) return 'ambiguous';
  if (polarities.has('uncertain') || hasQuantifiedDisagreement(effective)) return 'ambiguous';
  const strongestConfidence = Math.max(0, ...effective.map((item) => Number(item.confidence) || 0));
  if (strongestConfidence < 0.75) return 'partial';
  if (polarities.has('absent')) return facetContract.negationPolicy?.terminalStatus ?? 'filled';
  if (!normalizationValid) return 'partial';
  return 'filled';
}

function isExplicitCorrection(next, prior) {
  if (['before', 'after'].includes(temporalRelation(prior, next))) return false;
  if (next.correctsEvidenceId === prior.evidenceId) return true;
  return next.sessionId === prior.sessionId && next.source === prior.source
    && /(?:刚才|之前|前面|先前|上次).{0,12}(?:说错|记错|不准确|不对|更正)|更正一下|准确地说/.test(next.text ?? '');
}

function normalizePolarity(value) {
  return ['present', 'absent', 'uncertain'].includes(value) ? value : 'present';
}

function hasQuantifiedDisagreement(observations) {
  const presentObservations = observations.filter((item) => item.polarity === 'present');
  const claims = presentObservations.map((item) => quantifiedClaims(item.text));
  for (let i = 0; i < claims.length; i += 1) {
    for (let j = i + 1; j < claims.length; j += 1) {
      if (['before', 'after'].includes(temporalRelation(presentObservations[i], presentObservations[j]))) continue;
      for (const [unit, leftValues] of claims[i]) {
        const rightValues = claims[j].get(unit);
        if (!rightValues) continue;
        if (![...leftValues].some((value) => rightValues.has(value))) return true;
      }
    }
  }
  return false;
}

function quantifiedClaims(text) {
  const claims = new Map();
  const pattern = /([0-9零〇一二两三四五六七八九十百半]+)\s*(天|周|星期|个月|月|年|次|回|小时|分钟)/g;
  for (const match of String(text ?? '').matchAll(pattern)) {
    const unit = match[2] === '星期' ? '周' : match[2] === '回' ? '次' : match[2];
    const values = claims.get(unit) ?? new Set();
    values.add(match[1]);
    claims.set(unit, values);
  }
  return claims;
}
