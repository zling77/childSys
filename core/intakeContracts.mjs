import { COVERAGE_DOMAIN, intakeCoverageDomains } from './coverage.mjs';

// These contracts describe what a non-diagnostic initial intake should collect.
// They do not encode diagnoses, screening thresholds, or clinical dispositions.
export const INTAKE_CONTRACT_VERSION = '2.0.0';
export const INTAKE_CONTRACT_SCOPE = 'non_diagnostic_initial_intake';

const textFacet = (facetId, label, metadata = {}) => ({
  facetId,
  label,
  type: 'string',
  attemptBudget: 2,
  negationPolicy: {
    strategy: 'record_explicit_absence',
    terminalStatus: 'unavailable',
  },
  normalization: {
    strategy: 'trim_whitespace',
    emptyAs: 'missing',
  },
  ...metadata,
});

const booleanFacet = (facetId, label, metadata = {}) => ({
  facetId,
  label,
  type: 'boolean',
  attemptBudget: 2,
  negationPolicy: {
    strategy: 'map_explicit_denial_to_false',
    terminalStatus: 'filled',
  },
  normalization: {
    strategy: 'explicit_boolean',
    unknownAs: 'missing',
  },
  ...metadata,
});

const enumFacet = (facetId, label, enumValues, metadata = {}) => ({
  facetId,
  label,
  type: 'enum',
  enumValues,
  attemptBudget: 2,
  negationPolicy: {
    strategy: 'record_explicit_absence',
    terminalStatus: 'unavailable',
  },
  normalization: {
    strategy: 'closed_enum',
    preserveRaw: true,
  },
  ...metadata,
});

const multiEnumFacet = (facetId, label, enumValues, metadata = {}) => ({
  facetId,
  label,
  type: 'multi_enum',
  enumValues,
  attemptBudget: 2,
  negationPolicy: {
    strategy: 'record_explicit_absence',
    terminalStatus: 'unavailable',
  },
  normalization: {
    strategy: 'closed_enum_list',
    preserveRaw: true,
  },
  ...metadata,
});

const expressionFacet = (facetId, label, strategy, metadata = {}) => ({
  facetId,
  label,
  type: 'string',
  attemptBudget: 2,
  negationPolicy: {
    strategy: 'record_explicit_absence',
    terminalStatus: 'unavailable',
  },
  normalization: {
    strategy,
    preserveRaw: true,
  },
  ...metadata,
});

const DEFAULT_COMPLETION_POLICY = {
  strategy: 'all_required_facets_resolved',
  resolvedStatuses: ['filled', 'declined', 'unavailable', 'not_applicable'],
  evidenceSatisfiedStatuses: ['filled', 'not_applicable'],
  unresolvedStatuses: ['missing', 'partial', 'ambiguous', 'conflict'],
  preserveNonEvidenceResolution: true,
};

const contractDefinitions = {
  presenting_problem: {
    requiredFacets: ['primary_concern', 'recent_example'],
    facets: [
      textFacet('primary_concern', '当前最希望医生了解的主要困扰'),
      textFacet('recent_example', '近期具体事例'),
    ],
  },
  current_manifestations: {
    requiredFacets: ['manifestation_description', 'recent_episode'],
    facets: [
      textFacet('manifestation_description', '具体言语、行为或感受'),
      textFacet('recent_episode', '最近一次发生经过'),
    ],
  },
  onset_course: {
    requiredFacets: ['onset_time', 'course_pattern'],
    facets: [
      expressionFacet('onset_time', '大致开始时间', 'time_expression'),
      enumFacet('course_pattern', '到目前为止的变化过程', [
        'stable',
        'improving',
        'worsening',
        'fluctuating',
        'episodic',
        'unclear',
      ]),
    ],
  },
  frequency_severity: {
    requiredFacets: ['frequency', 'severity_example'],
    facets: [
      enumFacet('time_window', '频率所对应的时间范围', [
        'past_2_weeks',
        'past_month',
        'typical_week',
        'typical_month',
        'other',
        'unclear',
      ]),
      expressionFacet('frequency', '出现频率', 'frequency_expression', {
        negationPolicy: {
          strategy: 'normalize_explicit_absence_to_zero',
          terminalStatus: 'filled',
        },
      }),
      expressionFacet('episode_duration', '每次持续时间', 'duration_expression'),
      textFacet('severity_example', '最严重时的具体表现'),
    ],
  },
  functional_impact: {
    requiredFacets: ['impact_presence'],
    facets: [
      booleanFacet('impact_presence', '是否造成可观察的功能影响'),
      multiEnumFacet('affected_domains', '受到影响的生活领域', [
        'school',
        'learning',
        'family',
        'peers',
        'daily_living',
        'self_care',
        'activities',
        'other',
      ], { applicableWhen: { facetId: 'impact_presence', equals: true } }),
      textFacet('impact_example', '功能影响的具体事例', {
        applicableWhen: { facetId: 'impact_presence', equals: true },
      }),
    ],
  },
  triggers_context: {
    requiredFacets: ['trigger_pattern'],
    facets: [
      textFacet('trigger_pattern', '常见诱发情境或前后事件'),
      textFacet('recent_context_change', '近期家庭、学校或人际变化'),
    ],
  },
  settings_and_sources: {
    requiredFacets: ['cross_setting_pattern'],
    facets: [
      multiEnumFacet('settings', '已了解的发生场景', [
        'home',
        'school',
        'peers',
        'community',
        'other',
      ]),
      enumFacet('cross_setting_pattern', '不同场景中的表现差异', [
        'consistent',
        'context_specific',
        'mixed',
        'unclear',
      ]),
      multiEnumFacet('informant_sources', '信息来源', [
        'child',
        'guardian',
        'teacher',
        'other_caregiver',
        'clinician',
        'other',
      ]),
    ],
  },
  sleep_appetite_physical: {
    requiredFacets: ['health_change_summary'],
    facets: [
      textFacet('health_change_summary', '睡眠、食欲、精力与身体情况概述'),
      multiEnumFacet('sleep_change', '睡眠变化', [
        'no_change',
        'difficulty_falling_asleep',
        'night_waking',
        'early_waking',
        'sleeping_more',
        'irregular',
        'other',
        'unclear',
      ]),
      enumFacet('appetite_change', '食欲变化', [
        'no_change',
        'increased',
        'decreased',
        'selective',
        'irregular',
        'other',
        'unclear',
      ]),
      enumFacet('energy_change', '精力变化', [
        'no_change',
        'increased',
        'decreased',
        'variable',
        'other',
        'unclear',
      ]),
      textFacet('physical_symptoms', '近期身体不适'),
    ],
  },
  development_medical_history: {
    requiredFacets: ['development_medical_summary'],
    facets: [
      textFacet('development_medical_summary', '发育、既往疾病与当前健康概述'),
      textFacet('development_history', '早期发育情况'),
      textFacet('medical_history', '既往疾病、住院、手术或过敏史'),
      textFacet('current_physical_health', '当前身体健康情况'),
    ],
  },
  prior_help_treatment: {
    requiredFacets: ['help_received'],
    facets: [
      booleanFacet('help_received', '是否曾为当前困扰求助或接受干预'),
      multiEnumFacet('intervention_types', '既往求助或干预类型', [
        'medical_visit',
        'assessment',
        'counseling',
        'training',
        'medication',
        'inpatient_care',
        'other',
      ], { applicableWhen: { facetId: 'help_received', equals: true } }),
      textFacet('treatment_response', '既往帮助的效果与不良反应', {
        applicableWhen: { facetId: 'help_received', equals: true },
      }),
    ],
  },
  family_context_history: {
    requiredFacets: ['family_context_summary'],
    facets: [
      textFacet('family_context_summary', '家庭、照护安排与家族情况概述'),
      textFacet('living_arrangement', '主要照护者与居住安排'),
      textFacet('recent_family_change', '近期家庭关系或照护变化'),
      textFacet('family_history', '家族中类似困难或相关健康情况'),
    ],
  },
  safety_clues: {
    requiredFacets: ['current_safety_status'],
    facets: [
      booleanFacet('current_safety_status', '当前是否存在需要进一步核实的安全线索'),
      booleanFacet('self_harm_or_suicide', '不想活、想消失或伤害自己的线索'),
      booleanFacet('harm_to_others', '伤害他人的线索'),
      booleanFacet('leaving_or_missing', '离家、失联或不回来的线索'),
    ],
  },
  goals_expectations: {
    requiredFacets: ['priority_goal'],
    facets: [
      textFacet('priority_goal', '最希望优先发生的改变'),
      textFacet('help_expectation', '希望从本次就诊获得的帮助'),
    ],
  },
  strengths_protective: {
    requiredFacets: ['protective_summary'],
    facets: [
      textFacet('protective_summary', '优势、支持者与有效办法概述'),
      textFacet('strengths_interests', '兴趣、擅长与优势'),
      textFacet('support_people', '可信任或可求助的人'),
      textFacet('helpful_strategies', '已经有效的应对办法'),
    ],
  },
};

function buildContract(domain) {
  const definition = contractDefinitions[domain.slotId];
  if (!definition) {
    throw new Error(`Missing intake contract definition for ${domain.slotId}`);
  }

  return {
    contractVersion: INTAKE_CONTRACT_VERSION,
    scope: INTAKE_CONTRACT_SCOPE,
    coverageDomain: COVERAGE_DOMAIN,
    diagnosticUse: false,
    ...domain,
    hints: [...domain.hints],
    requiredFacets: [...definition.requiredFacets],
    optionalFacets: definition.facets
      .map((facet) => facet.facetId)
      .filter((facetId) => !definition.requiredFacets.includes(facetId)),
    facets: definition.facets.map((facet) => ({ ...facet })),
    completionPolicy: {
      ...DEFAULT_COMPLETION_POLICY,
      resolvedStatuses: [...DEFAULT_COMPLETION_POLICY.resolvedStatuses],
      evidenceSatisfiedStatuses: [...DEFAULT_COMPLETION_POLICY.evidenceSatisfiedStatuses],
      unresolvedStatuses: [...DEFAULT_COMPLETION_POLICY.unresolvedStatuses],
    },
    // Domain-level ceiling; each facet also carries its explicit attempt budget.
    attemptBudget: 2,
  };
}

export const intakeContracts = intakeCoverageDomains.map(buildContract);
export const intakeContractMap = new Map(
  intakeContracts.map((contract) => [contract.slotId, contract]),
);

export function getIntakeContract(slotId) {
  return intakeContractMap.get(String(slotId ?? '').trim()) ?? null;
}

export function getFacetContract(slotId, facetId) {
  const contract = getIntakeContract(slotId);
  const normalizedFacetId = String(facetId ?? '').trim();
  return contract?.facets.find((facet) => facet.facetId === normalizedFacetId) ?? null;
}

export function resolveFacet(slotId, facetId) {
  const contract = getIntakeContract(slotId);
  const facet = getFacetContract(slotId, facetId);
  if (!contract || !facet) return null;

  return {
    contract,
    facet,
    required: contract.requiredFacets.includes(facet.facetId),
  };
}
