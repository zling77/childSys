import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { handleTurn } from '../core/orchestrator.mjs';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const testRoot = mkdtempSync(join(tmpdir(), 'previsit-server-data-safety-'));
const dbPath = join(testRoot, 'test.db');
const mediaRoot = join(testRoot, 'media');
const outsidePath = join(testRoot, 'outside.txt');
const port = await getFreePort();
const baseUrl = `http://127.0.0.1:${port}`;
let serverOutput = '';

const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: projectRoot,
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    PREVISIT_DB_PATH: dbPath,
    PREVISIT_MEDIA_ROOT: mediaRoot,
    PREVISIT_LLM_MODE: 'shadow',
    PREVISIT_LLM_PROVIDER: 'mock',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (chunk) => { serverOutput += chunk; });
child.stderr.on('data', (chunk) => { serverOutput += chunk; });

try {
  await waitForServer();

  const created = await requestJson('/api/previsit/sessions', {
    method: 'POST',
    body: {
      profile: { age: 10, respondent: 'guardian' },
      chiefComplaint: '最近两周总是不愿意去学校',
      speakerRole: 'guardian',
    },
  });
  const sessionId = created.session.sessionId;
  const retiredFormalEndpoint = await fetch(`${baseUrl}/api/previsit/formal-questions/${sessionId}`);
  assert.equal(retiredFormalEndpoint.status, 404, 'retired formal-question endpoint must not exist');

  const childCreated = await requestJson('/api/previsit/sessions', {
    method: 'POST',
    body: {
      profile: { age: 11, respondent: 'child' },
      chiefComplaint: '我最近一到学校就很害怕，不想进教室',
      speakerRole: 'child',
      openingQuestion: '最近有什么事让你不舒服、烦恼，或者想让医生知道？',
    },
  });
  assert.match(childCreated.turns[0]?.qaId ?? '', /^QA-PV-[A-Z0-9]+-1$/);
  assert.equal(childCreated.turns[0]?.questionText, '最近有什么事让你不舒服、烦恼，或者想让医生知道？');
  assert.equal(childCreated.turns[0]?.speakerRole, 'child');
  assert.ok(childCreated.evidenceUnits.length > 0);
  assert.ok(childCreated.evidenceUnits.every((unit) => unit.source === 'child_self_report'));
  assert.equal(/您|孩子|家长/.test(childCreated.nextQuestion?.text ?? ''), false);
  const childEvidence = await requestJson(`/api/previsit/evidence/${childCreated.session.sessionId}`);
  assert.equal(childEvidence.dialogueTurns[0]?.qaId, childCreated.turns[0]?.qaId);
  assert.equal(childEvidence.dialogueTurns[0]?.answerText, '我最近一到学校就很害怕，不想进教室');

  const earlyStopCreated = await requestJson('/api/previsit/sessions', {
    method: 'POST',
    body: {
      profile: { age: 9, respondent: 'guardian' },
      chiefComplaint: '孩子最近不愿意写作业',
      speakerRole: 'guardian',
    },
  });
  const earlyStopped = await requestJson(`/api/previsit/sessions/${earlyStopCreated.session.sessionId}/stop`, {
    method: 'POST',
    body: {},
  });
  assert.equal(earlyStopped.session.status, 'completed');
  assert.ok(earlyStopped.session.completedAt);
  assert.equal(earlyStopped.nextQuestion, null);
  assert.equal(earlyStopped.packets.length, 1, 'stopping early must generate a clinician packet from existing evidence');
  const earlyStoppedAgain = await requestJson(`/api/previsit/sessions/${earlyStopCreated.session.sessionId}/stop`, {
    method: 'POST',
    body: {},
  });
  assert.equal(earlyStoppedAgain.packets.length, 1, 'repeated stop must not duplicate an unchanged packet');

  const beforeRead = await requestJson(`/api/previsit/sessions/${sessionId}`);
  assert.equal(beforeRead.packets.length, 0);

  const packetRead = await requestJson(`/api/previsit/packet/${sessionId}`);
  assert.equal(packetRead.packet, null);
  const afterRead = await requestJson(`/api/previsit/sessions/${sessionId}`);
  assert.equal(afterRead.packets.length, 0);
  assert.equal(afterRead.session.status, beforeRead.session.status);
  assert.equal(afterRead.session.updatedAt, beforeRead.session.updatedAt);

  const shadowTurn = await requestJson('/api/previsit/turns', {
    method: 'POST',
    body: {
      sessionId,
      expectedTurnNo: created.turns.length + 1,
      speakerRole: 'guardian',
      answerText: '不知道',
      currentQuestion: created.nextQuestion,
    },
  });
  const deterministicQuestion = handleTurn(beforeRead, { speakerRole: 'guardian', answerText: '不知道', currentQuestion: created.nextQuestion }).nextQuestion;
  for (const field of ['policyType', 'targetSlotOrIssue', 'targetFacetId', 'text']) {
    assert.equal(shadowTurn.nextQuestion?.[field], deterministicQuestion?.[field], `shadow audit must not replace deterministic question ${field}`);
  }
  assert.equal(
    shadowTurn.decisionLogs.at(-1)?.modelAudits?.some(
      (audit) => audit.task === 'llm_clarify_followup' && audit.status === 'success',
    ),
    true,
  );
  const staleTurnResponse = await fetch(`${baseUrl}/api/previsit/turns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      expectedTurnNo: created.turns.length + 1,
      speakerRole: 'guardian',
      answerText: '这是迟到的重复提交',
      currentQuestion: created.nextQuestion,
    }),
  });
  const staleTurnPayload = await staleTurnResponse.json();
  assert.equal(staleTurnResponse.status, 409);
  assert.equal(staleTurnPayload.code, 'TURN_CONFLICT');
  assert.equal((await requestJson(`/api/previsit/sessions/${sessionId}`)).turns.length, shadowTurn.turns.length);

  const generated = await requestJson(`/api/previsit/packet/${sessionId}/generate`, {
    method: 'POST',
    body: {},
  });
  assert.equal(generated.packet.sessionId, sessionId);
  const afterGenerate = await requestJson(`/api/previsit/sessions/${sessionId}`);
  assert.equal(afterGenerate.packets.length, 1);
  assert.equal(
    afterGenerate.session.status,
    shadowTurn.session.status,
    'generating a clinician packet must not complete or otherwise change the interview status',
  );
  assert.equal(
    afterGenerate.session.completedAt,
    shadowTurn.session.completedAt,
    'generating a clinician packet must not set completedAt',
  );
  const unchangedGenerate = await requestJson(`/api/previsit/packet/${sessionId}/generate`, {
    method: 'POST',
    body: {},
  });
  assert.equal(unchangedGenerate.changed, false, 'unchanged evidence must not create another packet version');
  assert.equal(unchangedGenerate.packet.version, generated.packet.version);
  const afterUnchangedGenerate = await requestJson(`/api/previsit/sessions/${sessionId}`);
  assert.equal(afterUnchangedGenerate.packets.length, 1, 'unchanged packet generation must be idempotent');

  const uploaded = await requestJson('/api/previsit/media', {
    method: 'POST',
    body: {
      sessionId,
      turnNo: 1,
      modality: 'audio',
      dataUrl: `data:audio/webm;base64,${Buffer.from('safe-media').toString('base64')}`,
    },
  });
  const safeMediaPath = join(mediaRoot, uploaded.mediaRecord.filePath);
  assert.equal(existsSync(safeMediaPath), true);

  const uploadedVideo = await requestJson('/api/previsit/media', {
    method: 'POST',
    body: {
      sessionId,
      turnNo: 0,
      modality: 'video',
      dataUrl: `data:video/webm;codecs=vp8,opus;base64,${Buffer.from('safe-video-media').toString('base64')}`,
    },
  });
  assert.equal(uploadedVideo.mediaRecord.mimeType, 'video/webm;codecs=vp8,opus');
  assert.equal(existsSync(join(mediaRoot, uploadedVideo.mediaRecord.filePath)), true);

  writeFileSync(outsidePath, 'must-not-be-deleted');
  const db = new Database(dbPath);
  db.prepare(
    `INSERT INTO media_record
      (media_id, session_id, turn_no, modality, mime_type, file_name, file_path,
       blob_size, duration_ms, question_text, target_slot_or_issue, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'MR-TRAVERSAL-TEST',
    sessionId,
    1,
    'audio',
    'audio/webm',
    'outside.txt',
    '../outside.txt',
    1,
    0,
    '',
    '',
    Date.now(),
  );
  db.close();

  const unsafeResetResponse = await fetch(`${baseUrl}/api/previsit/demo/reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const unsafeReset = await unsafeResetResponse.json();
  assert.equal(unsafeResetResponse.status, 500);
  assert.equal(unsafeReset.ok, false);
  assert.equal(unsafeReset.databaseReset, true);
  assert.equal(unsafeReset.mediaCleanup.deleted, 2);
  assert.equal(unsafeReset.mediaCleanup.rejected, 1);
  assert.equal(existsSync(safeMediaPath), false);
  assert.equal(existsSync(outsidePath), true);

  const verificationDb = new Database(dbPath, { readonly: true });
  assert.equal(verificationDb.prepare('SELECT COUNT(*) AS count FROM interview_session').get().count, 0);
  assert.equal(verificationDb.prepare('SELECT COUNT(*) AS count FROM media_record').get().count, 0);
  verificationDb.close();

  const cleanCreated = await requestJson('/api/previsit/sessions', {
    method: 'POST',
    body: { chiefComplaint: '最近容易发脾气', speakerRole: 'guardian' },
  });
  const cleanUpload = await requestJson('/api/previsit/media', {
    method: 'POST',
    body: {
      sessionId: cleanCreated.session.sessionId,
      turnNo: 1,
      modality: 'audio',
      dataUrl: `data:audio/webm;base64,${Buffer.from('clean-reset-media').toString('base64')}`,
    },
  });
  const cleanMediaPath = join(mediaRoot, cleanUpload.mediaRecord.filePath);
  const cleanReset = await requestJson('/api/previsit/demo/reset', { method: 'POST', body: {} });
  assert.equal(cleanReset.ok, true);
  assert.equal(cleanReset.mediaCleanup.deleted, 1);
  assert.equal(existsSync(cleanMediaPath), false);

  console.log('server data safety smoke ok');
} finally {
  await stopChild();
  rmSync(testRoot, { recursive: true, force: true });
}

async function requestJson(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`${options.method ?? 'GET'} ${path} failed (${response.status}): ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})\n${serverOutput}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The server may still be opening its socket.
    }
    await delay(50);
  }
  throw new Error(`server did not become ready\n${serverOutput}`);
}

async function stopChild() {
  if (child.exitCode !== null) return;
  child.kill('SIGINT');
  await Promise.race([once(child, 'exit'), delay(3000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function getFreePort() {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const address = socket.address();
  const freePort = typeof address === 'object' && address ? address.port : 0;
  socket.close();
  await once(socket, 'close');
  return freePort;
}
