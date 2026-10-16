// Question windows come from the capture clock, never from ASR text or server response times.
export function normalizeMediaTimeline(timeline, durationMs, turns = []) {
  if (timeline == null) return [];
  if (!Array.isArray(timeline) || timeline.length > 500) throw new Error('问答录音时间标记格式不合法。');
  if (!timeline.length) return [];
  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('有时间标记的录音必须提供有效时长。');
  const byTurn = new Map(turns.map(turn => [turn.turnNo, turn]));
  const seen = new Set();
  const rows = timeline.map(span => {
    if (!span || !Number.isInteger(span.turnNo) || span.turnNo < 1 || seen.has(span.turnNo)) throw new Error('录音问题轮次缺失或重复。');
    if (![span.startMs, span.endMs].every(Number.isSafeInteger) || span.startMs < 0 || span.endMs <= span.startMs || span.endMs > durationMs) throw new Error('问答录音时间窗超出原始文件范围。');
    const turn = byTurn.get(span.turnNo);
    if (!turn) throw new Error('录音时间标记不能关联不存在的问题。');
    seen.add(span.turnNo);
    return { turnNo: turn.turnNo, qaId: turn.qaId, questionText: turn.questionText || '开放式主诉入口', startMs: Math.round(span.startMs), endMs: Math.round(span.endMs) };
  }).sort((a, b) => a.startMs - b.startMs);
  if (rows.some((row, index) => index && row.startMs < rows[index - 1].endMs)) throw new Error('问答录音时间窗不能重叠。');
  return rows;
}

export function questionRecording(turn, session) {
  if (!turn || !session || turn.sessionId && turn.sessionId !== session.sessionId) return null;
  const records = (session.mediaRecords ?? []).filter(record => ['audio', 'video'].includes(record.modality ?? record.mediaType));
  const direct = records.filter(record => record.turnNo === turn.turnNo && record.turnNo > 0).sort((a, b) => (a.modality === 'audio' ? -1 : 1) - (b.modality === 'audio' ? -1 : 1))[0];
  if (direct) return { record: direct, kind: 'question', startMs: 0, endMs: direct.durationMs > 0 ? direct.durationMs : null };
  for (const record of records.filter(record => record.turnNo === 0)) {
    const span = record.timeline?.find(row => row.turnNo === turn.turnNo && (!row.qaId || row.qaId === turn.qaId));
    if (span && Number.isFinite(span.startMs) && span.startMs >= 0 && Number.isFinite(span.endMs) && span.endMs > span.startMs && span.endMs <= record.durationMs) return { record, kind: 'window', startMs: span.startMs, endMs: span.endMs };
  }
  const full = records.find(record => record.turnNo === 0);
  return full ? { record: full, kind: 'full', startMs: 0, endMs: null } : null;
}

export function recordingForEvidence(unit, sessions) {
  const session = sessions?.find(row => row.sessionId === unit?.sessionId);
  const turn = session?.turns.find(row => row.qaId === unit?.traceRef?.qaId || row.turnNo === unit?.inputRound);
  return { session, turn, recording: questionRecording(turn, session) };
}
