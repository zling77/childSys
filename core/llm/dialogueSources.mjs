// Mechanical source indexing only: no semantic classification or sufficiency
// decision. IDs always point to immutable text in this respondent's own session.
export function dialogueSources(snapshot, result) {
  return [...snapshot.turns, result.dialogueTurn].flatMap((t, index) => {
    const turn = t.turnNo ?? index + 1, answer = String(t.answerText ?? '');
    const parts = [...answer.matchAll(/[^。！？!?；;\n]+[。！？!?；;\n]*/gu)];
    return parts.flatMap((part, p) => {
      const chunks = [];
      for (let at = 0; at < part[0].length; at += 220) {
        const start = part.index + at, quote = part[0].slice(at, at + 220);
        chunks.push({ id: `A${turn}.${p + 1}.${chunks.length + 1}`, turn, start, end: start + quote.length, quote });
      }
      return chunks;
    });
  });
}

export function refusalScopes(snapshot, result) {
  const turns = [...snapshot.turns, result.dialogueTurn];
  return result.slotStates.flatMap(s => Object.values(s.value?.facets ?? {})
    .filter(f => f.collectionClosed && f.responseState?.kind === 'declined')
    .map(f => {
      const quote = f.responseState.quote;
      const t = quote ? [...turns].reverse().find(t => String(t.answerText ?? '').includes(quote)) : null;
      return { facet_id: f.facetId, quote: quote ?? null, turn: t?.turnNo ?? null,
        question: t?.questionText ?? null };
    }));
}

export function expandSourceReferences(output, sources) {
  const byId = new Map(sources.map(s => [s.id, s]));
  return { ...output, findings: output.findings?.map(f => ({ ...f, refs: f.refs?.map(ref => {
    // Accept canonical objects for existing test/providers; all references are
    // still independently validated against the original session afterwards.
    if (typeof ref !== 'string') return ref;
    const source = byId.get(ref);
    if (!source) throw new Error('completion_review_unknown_source');
    return { source_id: source.id, turn: source.turn, quote: source.quote, start: source.start, end: source.end };
  }) })) };
}
