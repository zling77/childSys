import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installOriginalTranscriptRoutes } from '../server/original-transcripts.mjs';

const root = mkdtempSync(join(tmpdir(), 'original-transcript-check-'));
const snapshot = { turns: [{ turnNo: 1, qaId: 'QA-TEST-1', questionText: '最近怎么样？', answerText: '文字输入内容', speakerRole: 'guardian' }], mediaRecords: [] };
const app = express(); app.use(express.json());
const archive = installOriginalTranscriptRoutes(app, { getSnapshot: () => snapshot }, root);
app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ error: error.message }));
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const url = `http://127.0.0.1:${server.address().port}/api/previsit/transcripts/TEST-1`;
async function save(body) { return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
try {
  const segment = { id: 'ASR-1', turnNo: 1, text: '原始语音和文字不同', kind: 'final', recordedAt: Date.now() };
  assert.equal((await save({ segments: [segment] })).status, 200);
  assert.equal((await save({ segments: [segment] })).status, 200);
  let saved = JSON.parse(readFileSync(join(root, 'TEST-1', 'original-transcript.json'), 'utf8'));
  assert.equal(saved.segments.length, 1); assert.equal(saved.turns[0].answerText, snapshot.turns[0].answerText);
  assert.equal((await save({ segments: [{ ...segment, text: '企图覆盖原文' }] })).status, 409);
  assert.equal((await save({ segments: [{ ...segment, id: 'bad', turnNo: 99 }] })).status, 400);
  assert.equal((await save({ segments: [{ id: 'ASR-2', turnNo: 2, text: '未提交片段', kind: 'unconfirmed', recordedAt: Date.now() }] })).status, 200);
  snapshot.mediaRecords.push({ mediaId: 'M-1', filePath: 'TEST-1/record.webm', durationMs: 5000, mimeType: 'video/webm', timeline: [] });
  archive.refresh('TEST-1');
  saved = JSON.parse(readFileSync(join(root, 'TEST-1', 'original-transcript.json'), 'utf8'));
  assert.equal(saved.mediaRecords[0].filePath, 'TEST-1/record.webm');
  const text = readFileSync(join(root, 'TEST-1', 'original-transcript.txt'), 'utf8');
  for (const marker of ['原始语音和文字不同', '文字输入内容', '未提交片段', 'TEST-1/record.webm']) assert.ok(text.includes(marker));
  assert.equal(await (await fetch(url + '?format=txt')).text(), text);
  assert.equal(snapshot.turns.length, 1); // unsubmitted text never becomes a clinical turn
  console.log('Original transcript checks passed: immutable originals, idempotent retry, unsubmitted text, JSON/TXT disk files, recording references.');
} finally {
  await new Promise(resolve => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
