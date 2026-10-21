import { intakeContracts } from '../intakeContracts.mjs';

const text = { type: 'string' };
const nullableText = { anyOf: [text, { type: 'null' }] };
const choices = values => ({ type: 'string', enum: values });
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const array = (items, maxItems = 12) => ({ type: 'array', items, maxItems });
const facets = intakeContracts.flatMap(c => c.facets.map(f => [c, f]));
const target = { slot_id: choices(intakeContracts.map(c => c.slotId)), facet_id: choices(facets.map(([,f]) => f.facetId)) };

// Keep the decoding grammar small. Cross-field/contract consistency is checked
// again by validateSemanticEvidence; JSON grammar alone is not semantic proof.
export const SEMANTIC_OUTPUT_SCHEMA = object({
  claims: array(object({
    id: text, ...target, quote: text,
    value: { anyOf: [text, {type:'boolean'}, {type:'null'}, array(text)] },
    polarity: choices(['present','absent','uncertain']), subject: choices(['patient','other','unknown']),
    source_mode: choices(['direct','reported','inference']),
    reported_source: { anyOf: [choices(['child','teacher_school','caregiver','other']), { type: 'null' }] },
    time_scope: nullableText, concern: nullableText, certainty: choices(['stated','approximate','uncertain']), corrects: nullableText,
  }, ['id','slot_id','facet_id','quote','value','polarity','subject','source_mode','certainty'])),
  assessments: array(object({ ...target,
    requirements: array(object({ id: choices([...new Set(facets.flatMap(([,f]) => f.evidenceContract.requirements.map(r => r.id)))]),
      status: choices(['met','unmet','unknown']), claim_ids: array(text, 24), context_refs: array(text, 8),
    }), 4),
  })),
  responses: array(object({ ...target,
    kind: choices(['declined','unavailable','misunderstood','uncertain']), quote: text,
  })),
  safety: array(object({ signal_type: choices(['suicide','self_harm','harm_other','abuse','bullying','psychotic_like']),
    quote: text, subject: { const: 'patient' }, polarity: choices(['present','uncertain']),
  }), 6),
  dialogue_guidance: object({ respondent_distress: { type: 'boolean' }, emotion_quote: nullableText,
    emotion_subject: { anyOf: [{ const: 'respondent' }, { type: 'null' }] },
    temporal_scope: { anyOf: [{ const: 'current' }, { type: 'null' }] },
    response_signal: choices(['substantive','uncertain','misunderstood','declined']),
    interaction_request: { anyOf: [choices(['pause','stop']), { type: 'null' }] },
  }),
});

// Compact wire format for constrained local decoding. The adapter restores the
// same claims/assessments contract used by every other provider and the store.
export const COMPACT_EVIDENCE_SCHEMA = object({
  updates: array(object({
    facet_id: target.facet_id, quote: text,
    value: { anyOf: [text,{type:'boolean'},{type:'null'},array(text)] },
    subject: choices(['patient','other','unknown']), polarity: choices(['present','absent','uncertain']),
    source_mode: choices(['direct','reported','inference']), certainty: choices(['stated','approximate','uncertain']),
    requirements: array(object({ id: SEMANTIC_OUTPUT_SCHEMA.properties.assessments.items.properties.requirements.items.properties.id,
      status: choices(['met','unmet','unknown']), refs: array(text,24), context_refs: array(text,8) },['id','status','refs']),4),
    corrects: nullableText, time_scope: nullableText, concern: nullableText,
    reported_source: { anyOf: [choices(['child','teacher_school','caregiver','other']),{type:'null'}] },
  },['facet_id','quote','value','subject','polarity','source_mode','certainty','requirements'])),
  responses: array(object({ facet_id: target.facet_id, kind: choices(['declined','unavailable','misunderstood','uncertain']), quote:text })),
  safety: SEMANTIC_OUTPUT_SCHEMA.properties.safety,
  dialogue_guidance: SEMANTIC_OUTPUT_SCHEMA.properties.dialogue_guidance,
});

// Constrain references structurally, without deciding whether their contents
// semantically satisfy a requirement. New evidence references itself; older
// evidence must use an existing ID, never a quote pasted into the ID field.
export function compactEvidenceSchema(activeClaims = []) {
  const schema = structuredClone(COMPACT_EVIDENCE_SCHEMA);
  schema.properties.updates.items.properties.requirements.items.properties.refs.items = choices(
    ['$self', ...activeClaims.map((_, i) => `$p${i + 1}`), ...new Set(activeClaims.map(c => c.evidenceId))],
  );
  return schema;
}

export function expandCompactEvidence(output, activeClaims = []) {
  if (!Array.isArray(output?.updates)) throw new Error('invalid_compact_evidence_schema');
  const previousRef = ref => /^\$p\d+$/.test(ref)
    ? activeClaims[Number(ref.slice(2))-1]?.evidenceId ?? ref : ref;
  const claims=[],assessments=[];
  for (const [i,u] of output.updates.entries()) {
    const pair=facets.find(([,f])=>f.facetId===u.facet_id);
    // Preserve valid sibling updates. Unknown labels are passed through with no
    // slot so the existing per-claim validator rejects and audits them; they
    // must not discard every correctly quoted fact in the same response.
    const id=`c${i+1}`,slot_id=pair?.[0]?.slotId ?? null;
    const {requirements,...claim}=u;
    claims.push({...claim,...(claim.corrects ? {corrects:previousRef(claim.corrects)} : {}),id,slot_id});
    assessments.push({slot_id,facet_id:u.facet_id,requirements:(requirements??[]).map(r=>({
      id:r.id,status:r.status,claim_ids:(r.refs??[]).map(ref=>ref==='$self'?id:previousRef(ref)),context_refs:r.context_refs??[],
    }))});
  }
  return {claims,assessments,responses:(output.responses??[]).map(r=>({...r,
    slot_id:facets.find(([,f])=>f.facetId===r.facet_id)?.[0].slotId})),
    safety:output.safety??[],dialogue_guidance:output.dialogue_guidance,_providerUsage:output._providerUsage};
}
