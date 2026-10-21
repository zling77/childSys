import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Audit records only: these files never feed evidence extraction, scoring or
// multi-source analysis. Submitted answers remain in the existing dialogue DB.
export function installOriginalTranscriptRoutes(app, store, mediaRoot) {
  function paths(id) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw Object.assign(new Error('Invalid session identifier'), { statusCode: 400 });
    const folder = join(mediaRoot, id);
    return { folder, json: join(folder, 'original-transcript.json'), text: join(folder, 'original-transcript.txt') };
  }
  function readArchive(id) {
    const snapshot = store.getSnapshot(id);
    const files = paths(id);
    const saved = existsSync(files.json) ? JSON.parse(readFileSync(files.json, 'utf8')) : { segments: [], drafts: [] };
    return {
      version: 'original-transcript-v1', sessionId: id,
      note: '自动转写未经人工校对；unconfirmed 为未确认的临时识别。文字输入与语音原始转写分别保留。',
      segments: saved.segments, drafts: saved.drafts,
      turns: snapshot.turns.map(t => ({ turnNo: t.turnNo, qaId: t.qaId, speakerRole: t.speakerRole, questionText: t.questionText, answerText: t.answerText })),
      mediaRecords: snapshot.mediaRecords.map(m => ({ mediaId: m.mediaId, sessionId: id, modality: m.modality, turnNo: m.turnNo, fileName: m.fileName, filePath: m.filePath, mimeType: m.mimeType, recordingStartedAt: m.recordingStartedAt, durationMs: m.durationMs, timeline: m.timeline, url: `/api/previsit/media/blob/${m.mediaId}` })),
      updatedAt: saved.updatedAt ?? null,
    };
  }
  function renderText(archive) {
    return [`会话：${archive.sessionId}`, archive.note,
      ...archive.turns.flatMap(t => [`\n第 ${t.turnNo} 轮 ${t.qaId}`, `系统：${t.questionText || '主诉'}`, `提交回答：${t.answerText}`]),
      '\n原始语音转写（独立于提交回答保存）',
      ...archive.segments.map(s => `[第${s.turnNo}轮][${s.kind}][${new Date(s.recordedAt).toISOString()}] ${s.text}`),
      '\n文字输入留存', ...archive.drafts.filter(d => d.text).map(d => `[第${d.turnNo}轮][${archive.turns.some(t => t.turnNo === d.turnNo) ? '已提交轮次' : '未提交'}] ${d.text}`),
      '\n音视频文件', ...archive.mediaRecords.map(m => `${m.filePath}  ${m.durationMs}ms`), '',
    ].join('\n');
  }
  function persist(archive) {
    const files = paths(archive.sessionId);
    mkdirSync(files.folder, { recursive: true });
    // Synchronous atomic replacement prevents readers seeing partial JSON.
    writeFileSync(`${files.json}.tmp`, JSON.stringify(archive, null, 2), 'utf8');
    renameSync(`${files.json}.tmp`, files.json);
    writeFileSync(`${files.text}.tmp`, renderText(archive), 'utf8');
    renameSync(`${files.text}.tmp`, files.text);
  }
  app.post('/api/previsit/transcripts/:sessionId', (req, res, next) => {
    try {
      const archive = readArchive(req.params.sessionId);
      const segments = req.body?.segments ?? [];
      const draft = req.body?.draft;
      const validText = value => typeof value === 'string' && value.length <= 20000;
      const validTurn = value => Number.isInteger(value) && value > 0 && value <= archive.turns.length + 1;
      if (!Array.isArray(segments) || segments.length > 20000 || segments.some(s => !s || typeof s.id !== 'string' || s.id.length > 150 || !validTurn(s.turnNo) || !validText(s.text) || !['final', 'unconfirmed'].includes(s.kind) || !Number.isFinite(s.recordedAt) || s.recordedAt <= 0)
        || (draft && (!validTurn(draft.turnNo) || !validText(draft.text)))) {
        return res.status(400).json({ error: 'Invalid original transcript segments' });
      }
      const merged = new Map(archive.segments.map(s => [s.id, s]));
      for (const s of segments) {
        const row = { id: s.id, turnNo: s.turnNo, text: s.text, kind: s.kind, recordedAt: s.recordedAt };
        // A captured final utterance is immutable, including on network retry.
        if (merged.has(s.id) && JSON.stringify(merged.get(s.id)) !== JSON.stringify(row)) return res.status(409).json({ error: 'Original transcript segment cannot be overwritten' });
        merged.set(s.id, row);
      }
      archive.segments = [...merged.values()].sort((a, b) => a.recordedAt - b.recordedAt);
      if (draft) archive.drafts = [...archive.drafts.filter(d => d.turnNo !== draft.turnNo), { turnNo: draft.turnNo, text: draft.text, kind: 'manual_draft' }];
      archive.updatedAt = Date.now();
      persist(archive);
      res.json({ saved: true, segmentCount: archive.segments.length });
    } catch (error) { next(error); }
  });
  app.get('/api/previsit/transcripts/:sessionId', (req, res, next) => {
    try {
      const archive = readArchive(req.params.sessionId);
      if (req.query.format === 'txt') {
        res.attachment(`${archive.sessionId}-original-transcript.txt`).type('text/plain').send(renderText(archive));
      } else res.json(archive);
    } catch (error) { next(error); }
  });
  return { refresh: id => { const archive = readArchive(id); archive.updatedAt = Date.now(); persist(archive); } };
}
