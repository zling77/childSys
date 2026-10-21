import 'dotenv/config';
import express from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { createStore, TurnConflictError } from './store.mjs';
import { handleTurn } from '../core/orchestrator.mjs';
import { demoCases, seedDemoCases } from './demo-cases.mjs';
import { createLlmRuntimeFromEnv, runClarifyingQuestion, runDynamicNextQuestion, runShadowExtract } from '../core/llm/provider.mjs';
import { validateDynamicSelection, validateQuestionForTarget } from '../core/llm/dynamicBoundary.mjs';
import { buildDynamicGoal, buildDynamicGoalSpace, realizeGoalFallback } from '../core/llm/dynamicGoalSpace.mjs';
import { intakeContracts } from '../core/intakeContracts.mjs';
import { seedResearchDemoCases } from './research-demo-cases.mjs';
import { publicDecisionLogs } from '../core/publicDecisionLogs.mjs';
import { validateIndependentElicitation } from '../core/llm/independentElicitationBoundary.mjs';
import { installClinicianLlmRoutes } from './clinician-llm.mjs';
import { normalizeMediaTimeline } from '../core/mediaTimeline.mjs';
import { stateBuilderSettings, assessTurnEvidence } from '../core/llm/semanticStateBuilder.mjs';
import { findRiskSignals } from '../core/risk.mjs';
import { explicitNonEvidenceResponse, SEMANTIC_STATE_VERSION } from '../core/semanticEvidence.mjs';
import { composeCommunication, explicitInteractionRequest, fallbackDialogueGuidance } from '../core/llm/communication.mjs';
import { auditDialogueTurn } from '../core/llm/dialogueAudit.mjs';
import { runSemanticDialogue } from '../core/llm/semanticDialogue.mjs';
import { installOriginalTranscriptRoutes } from './original-transcripts.mjs';

const PORT = Number(process.env.PORT ?? 4176);
const HOST = process.env.HOST ?? '127.0.0.1';
const MEDIA_ROOT = process.env.PREVISIT_MEDIA_ROOT ?? join(process.cwd(), 'server', 'data', 'media');

const app = express();
const store = createStore();
const execFileAsync = promisify(execFile);
const TTS_PYTHON = process.env.PREVISIT_TTS_PYTHON ?? 'python';
const TTS_VOICE = process.env.PREVISIT_TTS_VOICE ?? 'zh-CN-XiaoxiaoNeural';
const ttsCache = new Map();

app.use(express.json({ limit: '250mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'child-psych-previsit-demo' });
});

installClinicianLlmRoutes(app, store);
const originalTranscripts = installOriginalTranscriptRoutes(app, store, MEDIA_ROOT);

app.post('/api/previsit/tts', async (req, res, next) => {
  try {
    const text = String(req.body?.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 240) {
      res.status(400).json({ error: 'text must contain 1-240 characters' });
      return;
    }
    const cacheKey = createHash('sha256').update(`${TTS_VOICE}\n${text}`).digest('hex');
    let audio = ttsCache.get(cacheKey);
    if (!audio) {
      audio = await synthesizeNeuralSpeech(text);
      if (ttsCache.size >= 120) ttsCache.delete(ttsCache.keys().next().value);
      ttsCache.set(cacheKey, audio);
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('X-Previsit-TTS-Engine', 'edge-neural');
    res.send(audio);
  } catch (err) {
    next(Object.assign(new Error(`neural TTS unavailable: ${err instanceof Error ? err.message : String(err)}`), { statusCode: 503 }));
  }
});

async function synthesizeNeuralSpeech(text) {
  const work = mkdtempSync(join(tmpdir(), 'childpsych-tts-'));
  const output = join(work, 'speech.mp3');
  try {
    await execFileAsync(TTS_PYTHON, [
      '-m', 'edge_tts',
      '--voice', TTS_VOICE,
      '--rate=-6%',
      '--pitch=+0Hz',
      '--volume=+0%',
      '--text', text,
      '--write-media', output,
    ], { timeout: 20_000, maxBuffer: 1024 * 1024 });
    return readFileSync(output);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

app.post('/api/previsit/sessions', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const session = store.createSession({
      caseId: body.caseId ?? null,
      profile: body.profile ?? {},
      selectedComplaints: body.selectedComplaints ?? [],
      chiefComplaint: body.chiefComplaint ?? '',
      stateBuilderMode: stateBuilderSettings().mode,
    });
    const openingQuestion = body.openingQuestion
      ? {
          id: `Q-${session.sessionId}-1`,
          text: String(body.openingQuestion),
          policyType: 'open_narrative',
          targetSlotOrIssue: null,
        }
      : null;
    const first = await buildTurn(store.getSnapshot(session.sessionId), {
      speakerRole: body.speakerRole,
      answerText: session.chiefComplaint,
      currentQuestion: openingQuestion,
      ...linkedCaseContext(session.sessionId),
    });
    first.modelAudits = [...(first.modelAudits ?? []), ...await runModelAssistance(first, openingQuestion, store.getSnapshot(session.sessionId))];
    const snapshot = store.applyTurnResult(first);
    scheduleShadowAudit(first);
    scheduleSemanticShadow(first);
    scheduleDialogueAudit(first, snapshot);
    if (first.nextAction === 'complete') {
      store.generatePacket(first.sessionId);
      store.generateClinicalPacket(store.clinicalCaseForSession(first.sessionId));
      res.json(toPublicSession(store.getSnapshot(first.sessionId)));
    } else res.json(toPublicSession(snapshot));
  } catch (err) {
    next(err);
  }
});

app.get('/api/previsit/sessions/:sessionId', (req, res, next) => {
  try {
    res.json(toPublicSession(store.getSnapshot(req.params.sessionId)));
  } catch (err) {
    next(err);
  }
});

app.post('/api/previsit/turns', async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const snapshot = store.getSnapshot(body.sessionId);
    if (snapshot.session.completedAt != null || snapshot.session.status === 'completed') {
      throw Object.assign(new Error('interview already completed'), { statusCode: 409 });
    }
    const expectedTurnNo = body.expectedTurnNo == null ? null : Number(body.expectedTurnNo);
    const nextTurnNo = snapshot.turns.length + 1;
    if (expectedTurnNo != null
      && (!Number.isInteger(expectedTurnNo) || expectedTurnNo !== nextTurnNo)) {
      throw new TurnConflictError(body.sessionId, expectedTurnNo);
    }
    const result = await buildTurn(snapshot, {
      speakerRole: body.speakerRole,
      answerText: body.answerText,
      currentQuestion: body.currentQuestion ?? latestQuestion(snapshot),
      ...linkedCaseContext(body.sessionId),
    });
    result.modelAudits = [...(result.modelAudits ?? []), ...await runModelAssistance(result, body.currentQuestion ?? latestQuestion(snapshot), snapshot)];
    const updated = store.applyTurnResult(result);
    scheduleShadowAudit(result);
    scheduleSemanticShadow(result);
    scheduleDialogueAudit(result, updated);
    if (result.nextAction === 'complete') {
      store.generatePacket(result.sessionId);
      store.generateClinicalPacket(store.clinicalCaseForSession(result.sessionId));
      res.json(toPublicSession(store.getSnapshot(result.sessionId)));
      return;
    }
    res.json(toPublicSession(updated));
  } catch (err) {
    next(err);
  }
});

app.post('/api/previsit/sessions/:sessionId/stop', (req, res, next) => {
  try {
    const sessionId = req.params.sessionId;
    store.completeSession(sessionId);
    store.generatePacket(sessionId);
    store.generateClinicalPacket(store.clinicalCaseForSession(sessionId));
    res.json(toPublicSession(store.getSnapshot(sessionId)));
  } catch (err) {
    next(err);
  }
});

app.get('/api/previsit/doctor/queue', (_req, res, next) => {
  try {
    res.json({ sessions: store.listQueue({ status: _req.query.status }) });
  } catch (err) {
    next(err);
  }
});

// Case-level clinician APIs. The session APIs remain available to intake clients.
app.get('/api/previsit/clinician/cases', (req, res, next) => {
  try { res.json({ cases: store.listClinicalCases({ status: req.query.status ?? 'all' }) }); } catch (error) { next(error); }
});
app.get('/api/previsit/clinician/sessions', (_req, res, next) => {
  try { res.json({ sessions: store.listClinicalSessions() }); } catch (error) { next(error); }
});
app.get('/api/previsit/clinician/contracts', (_req, res) => {
  res.json({ contracts: intakeContracts.map((contract) => ({ slotId: contract.slotId, label: contract.label, facets: contract.facets.map(({ facetId, label }) => ({ facetId, label })) })) });
});
app.get('/api/previsit/clinician/cases/:caseId', (req, res, next) => {
  try {
    const bundle = store.getClinicalBundle(req.params.caseId);
    // Clinician-only research trace. No hidden-source provenance is returned
    // by the patient session/evidence/decision endpoints.
    const interviewFocusAudits = bundle.sessions.flatMap(({ sessionId }) =>
      store.getSnapshot(sessionId).decisionLogs.flatMap((log) =>
        (log.modelAudits ?? []).filter((audit) => audit.task === 'source_independent_focus')));
    res.json({ ...bundle, interviewFocusAudits });
  } catch (error) { next(error); }
});
app.post('/api/previsit/clinician/cases/:caseId/sessions', (req, res, next) => {
  try { res.json(store.attachClinicalSession(req.params.caseId, req.body?.sessionId)); } catch (error) { next(error); }
});
app.post('/api/previsit/clinician/cases/:caseId/sessions/:sessionId/detach', (req, res, next) => {
  try { res.json(store.detachClinicalSession(req.params.caseId, req.params.sessionId)); } catch (error) { next(error); }
});
app.post('/api/previsit/clinician/cases/:caseId/materials', (req, res, next) => {
  try { res.status(201).json({ material: store.addClinicalMaterial(req.params.caseId, req.body ?? {}) }); } catch (error) { next(error); }
});
app.post('/api/previsit/clinician/cases/:caseId/reviews', (req, res, next) => {
  try { res.status(201).json({ review: store.recordClinicalReview(req.params.caseId, req.body ?? {}) }); } catch (error) { next(error); }
});
app.post('/api/previsit/clinician/cases/:caseId/packet', (req, res, next) => {
  try { res.json(store.generateClinicalPacket(req.params.caseId)); } catch (error) { next(error); }
});
app.get('/api/previsit/clinician/cases/:caseId/packets/:version', (req, res, next) => {
  try {
    const version = Number(req.params.version);
    if (!Number.isInteger(version) || version < 1) throw Object.assign(new Error('版本号不合法。'), { statusCode: 400 });
    const packet = store.getClinicalPacket(req.params.caseId, version);
    if (!packet) throw Object.assign(new Error('版本不存在。'), { statusCode: 404 });
    res.json({ packet });
  } catch (error) { next(error); }
});
app.get('/api/previsit/clinician/cases/:caseId/compare', (req, res, next) => {
  try {
    const from = Number(req.query.from); const to = Number(req.query.to);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < 1) throw Object.assign(new Error('比较版本不合法。'), { statusCode: 400 });
    res.json(store.compareClinicalPackets(req.params.caseId, from, to));
  } catch (error) { next(error); }
});

app.get('/api/previsit/demo/cases', (_req, res) => {
  res.json({ cases: demoCases.map(({ id, label, profile, selectedComplaints, chiefComplaint }) => ({ id, label, profile, selectedComplaints, chiefComplaint })) });
});

app.post('/api/previsit/demo/reset', (_req, res, next) => {
  try {
    const result = resetDemoDataAndMedia();
    res.status(result.ok ? 200 : 500).json(result);
  } catch (err) {
    next(err);
  }
});

app.post('/api/previsit/demo/seed', (_req, res, next) => {
  try {
    const reset = resetDemoDataAndMedia();
    if (!reset.ok) {
      res.status(500).json({ ...reset, created: [] });
      return;
    }
    const created = seedDemoCases(store);
    for (const row of created) store.generateClinicalPacket(store.clinicalCaseForSession(row.sessionId));
    const researchCases = seedResearchDemoCases(store);
    res.json({ created, researchCases });
  } catch (err) {
    next(err);
  }
});

app.get('/api/previsit/packet/:sessionId', (req, res, next) => {
  try {
    const snapshot = store.getSnapshot(req.params.sessionId);
    res.json({ packet: snapshot.packets.at(-1) ?? null });
  } catch (err) {
    next(err);
  }
});

app.post('/api/previsit/packet/:sessionId/generate', (req, res, next) => {
  try {
    const generated = store.generatePacket(req.params.sessionId);
    const { unchanged, ...packet } = generated;
    res.json({ packet, changed: !unchanged });
  } catch (err) {
    next(err);
  }
});

app.get('/api/previsit/evidence/:sessionId', (req, res, next) => {
  try {
    const snapshot = store.getSnapshot(req.params.sessionId);
    res.json({
      dialogueTurns: snapshot.turns,
      evidenceUnits: snapshot.evidenceUnits,
      riskSignals: snapshot.riskSignals,
      slotStates: snapshot.slotStates,
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/previsit/media/:sessionId', (req, res, next) => {
  try {
    res.json({ mediaRecords: store.listMediaRecords(req.params.sessionId) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/previsit/media', (req, res, next) => {
  try {
    const body = req.body ?? {};
    const sessionId = String(body.sessionId ?? '').trim();
    const modality = String(body.modality ?? '').trim();
    if (!sessionId || !['audio', 'video'].includes(modality)) {
      return res.status(400).json({ error: 'sessionId and modality(audio/video) are required' });
    }
    const snapshot = store.getSnapshot(sessionId);
    const turnNo = Number(body.turnNo ?? 0), durationMs = Number(body.durationMs ?? 0);
    if (!Number.isInteger(turnNo) || turnNo < 0 || (turnNo > 0 && !snapshot.turns.some(turn => turn.turnNo === turnNo))) return res.status(400).json({ error: '录音必须关联本会话已存在的问题或全程记录。' });
    if (!Number.isFinite(durationMs) || durationMs < 0) return res.status(400).json({ error: '录音时长不合法。' });
    let timeline;
    try { timeline = normalizeMediaTimeline(body.timeline, durationMs, snapshot.turns); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    const parsed = parseDataUrl(body.dataUrl);
    if (!parsed) return res.status(400).json({ error: 'dataUrl must be a base64 data URL' });
    if (modality === 'audio' && !parsed.mimeType.startsWith('audio/')) {
      return res.status(400).json({ error: 'audio upload requires audio/* dataUrl' });
    }
    if (modality === 'video' && !parsed.mimeType.startsWith('video/')) {
      return res.status(400).json({ error: 'video upload requires video/* dataUrl' });
    }

    const mediaId = `MR-${randomUUID().slice(0, 10).toUpperCase()}`;
    const ext = mediaExtension(parsed.mimeType);
    const sessionPart = pathPart(sessionId);
    const fileName = `${mediaId}.${ext}`;
    const relPath = join(sessionPart, fileName);
    const absPath = join(MEDIA_ROOT, relPath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, parsed.buffer);

    const record = store.saveMediaRecord({
      mediaId,
      sessionId,
      turnNo: Number(body.turnNo ?? 0),
      modality,
      mimeType: parsed.mimeType,
      fileName,
      filePath: relPath,
      blobSize: parsed.buffer.length,
      durationMs: Number(body.durationMs ?? 0),
      questionText: String(body.questionText ?? ''),
      targetSlotOrIssue: String(body.targetSlotOrIssue ?? ''),
      timeline,
      recordingStartedAt: Number.isFinite(body.recordingStartedAt) && body.recordingStartedAt > 0 ? body.recordingStartedAt : null,
      createdAt: Date.now(),
    });
    originalTranscripts.refresh(sessionId);
    res.json({ mediaRecord: record });
  } catch (err) {
    next(err);
  }
});

app.get('/api/previsit/media/blob/:mediaId', (req, res, next) => {
  try {
    const record = store.getMediaRecord(req.params.mediaId);
    if (!record) return res.status(404).json({ error: 'media record not found' });
    res.type(record.mimeType);
    res.sendFile(join(MEDIA_ROOT, record.filePath));
  } catch (err) {
    next(err);
  }
});

app.get('/api/previsit/admin/decision-logs/:sessionId', (req, res, next) => {
  try {
    const snapshot = store.getSnapshot(req.params.sessionId);
    res.json({ decisionLogs: publicDecisionLogs(snapshot.decisionLogs) });
  } catch (err) {
    next(err);
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  const statusCode = Number(err?.statusCode);
  const status = Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599
    ? statusCode
    : 500;
  res.status(status).json({
    error: err instanceof Error ? err.message : String(err),
    ...(err?.code ? { code: err.code } : {}),
  });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`previsit server http://${HOST}:${PORT}`);
});

process.on('SIGINT', () => {
  server.close(() => {
    store.close();
    process.exit(130);
  });
});

function toPublicSession(snapshot) {
  return {
    session: { ...snapshot.session, caseId: store.clinicalCaseForSession(snapshot.session.sessionId) },
    nextQuestion: snapshot.session.status === 'completed' ? null : latestQuestion(snapshot),
    turns: snapshot.turns,
    slotStates: snapshot.slotStates,
    evidenceUnits: snapshot.evidenceUnits,
    riskSignals: snapshot.riskSignals,
    decisionLogs: publicDecisionLogs(snapshot.decisionLogs),
    mediaRecords: snapshot.mediaRecords,
    packets: snapshot.packets,
  };
}

function parseDataUrl(dataUrl) {
  const raw = String(dataUrl ?? '');
  if (!raw.startsWith('data:')) return null;
  const marker = ';base64,';
  const markerIndex = raw.indexOf(marker);
  if (markerIndex <= 5) return null;
  const mimeType = raw.slice(5, markerIndex).trim();
  const payload = raw.slice(markerIndex + marker.length).replace(/\s+/g, '');
  if (!/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+(?:;[^\r\n]*)?$/.test(mimeType)) return null;
  if (!payload || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return null;
  return {
    mimeType,
    buffer: Buffer.from(payload, 'base64'),
  };
}

function mediaExtension(mimeType) {
  if (/webm/i.test(mimeType)) return 'webm';
  if (/mp4/i.test(mimeType)) return 'mp4';
  if (/ogg/i.test(mimeType)) return 'ogg';
  if (/wav/i.test(mimeType)) return 'wav';
  return 'bin';
}

function pathPart(value) {
  return String(value ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
}

function resetDemoDataAndMedia() {
  const { mediaPaths = [] } = store.resetDemoData();
  const mediaCleanup = removeTrackedMediaFiles(MEDIA_ROOT, mediaPaths);
  return {
    ok: mediaCleanup.ok,
    databaseReset: true,
    mediaCleanup,
  };
}

export function removeTrackedMediaFiles(mediaRoot, mediaPaths) {
  const uniquePaths = [...new Set((mediaPaths ?? []).map((value) => String(value ?? '').trim()))];
  const result = {
    ok: true,
    requested: uniquePaths.length,
    deleted: 0,
    missing: 0,
    rejected: 0,
    failed: 0,
  };
  const rootPath = resolve(mediaRoot);
  let realRoot = null;

  try {
    realRoot = realpathSync(rootPath);
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      result.failed = uniquePaths.length;
      result.ok = uniquePaths.length === 0;
      return result;
    }
  }

  for (const mediaPath of uniquePaths) {
    const targetPath = resolveTrackedMediaPath(rootPath, mediaPath);
    if (!targetPath) {
      result.rejected += 1;
      continue;
    }

    let targetStat;
    try {
      targetStat = lstatSync(targetPath);
    } catch (err) {
      if (err?.code === 'ENOENT') {
        result.missing += 1;
      } else {
        result.failed += 1;
      }
      continue;
    }

    if (!realRoot || targetStat.isDirectory()) {
      result.rejected += 1;
      continue;
    }

    try {
      const realTarget = realpathSync(targetPath);
      if (!isDescendantPath(realRoot, realTarget)) {
        result.rejected += 1;
        continue;
      }
      unlinkSync(targetPath);
      result.deleted += 1;
      pruneEmptyMediaDirectories(dirname(targetPath), rootPath, realRoot);
    } catch (err) {
      if (err?.code === 'ENOENT') {
        result.missing += 1;
      } else {
        result.failed += 1;
      }
    }
  }

  result.ok = result.rejected === 0 && result.failed === 0;
  return result;
}

function resolveTrackedMediaPath(rootPath, mediaPath) {
  if (!mediaPath || isAbsolute(mediaPath)) return null;
  const targetPath = resolve(rootPath, mediaPath);
  return isDescendantPath(rootPath, targetPath) ? targetPath : null;
}

function isDescendantPath(rootPath, targetPath) {
  const relativePath = relative(rootPath, targetPath);
  return Boolean(relativePath)
    && relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath);
}

function pruneEmptyMediaDirectories(startPath, rootPath, realRoot) {
  let currentPath = startPath;
  while (isDescendantPath(rootPath, currentPath)) {
    try {
      const stat = lstatSync(currentPath);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      const realCurrent = realpathSync(currentPath);
      if (!isDescendantPath(realRoot, realCurrent)) return;
      rmdirSync(currentPath);
      currentPath = dirname(currentPath);
    } catch (err) {
      if (err?.code === 'ENOENT') {
        currentPath = dirname(currentPath);
        continue;
      }
      if (['ENOTEMPTY', 'EEXIST'].includes(err?.code)) return;
      return;
    }
  }
}

function latestQuestion(snapshot) {
  const action = snapshot.decisionLogs.at(-1)?.selectedAction;
  return action?.nextQuestion ?? null;
}

async function buildTurn(snapshot, input) {
  const settings = { ...stateBuilderSettings(), mode: snapshot.session.stateBuilderMode ?? 'rule' };
  const speakerRole = input.speakerRole === 'child' || input.speakerRole === 'guardian'
    ? input.speakerRole : ['child', 'patient', 'self', '患儿', '患儿本人', '儿童本人'].includes(snapshot.session.profile?.respondent) ? 'child' : 'guardian';
  input = { ...input, speakerRole };
  const unsafe = findRiskSignals(input.answerText, snapshot.session.sessionId, snapshot.turns.length + 1, speakerRole).length
    || snapshot.riskSignals.some(s => s.status !== 'closed');
  let result;
  if (settings.mode === 'semantic') {
    const empty = { claims: [], assessments: [], responses: [], safety: [], rejected: [], version: SEMANTIC_STATE_VERSION };
    const request = explicitInteractionRequest(input.answerText);
    const pausedQuestion = latestQuestion(snapshot);
    const resuming = pausedQuestion?.policyType === 'interaction_pause'
      && /^(?:我)?(?:准备好了|可以继续|继续|我准备好了，可以继续)[。！!，,\s]*$/.test(String(input.answerText).trim());
    const retrying = pausedQuestion?.policyType === 'llm_retry'
      && /^(?:我)?(?:准备好了|可以继续|继续|我准备好了，可以继续)[。！!，,\s]*$/.test(String(input.answerText).trim());
    if (request || resuming) {
      result = handleTurn(snapshot, { ...input, semanticAssessment: empty });
      result.interactionRequest = request?.kind ?? 'resume';
      result.stateBuilderExecution = 'interaction_control';
      if (request?.kind === 'stop') {
        result.nextAction = 'complete'; result.nextQuestion = null;
        result.status = unsafe ? 'needs_clinician_review' : 'completed';
      } else if (request?.kind === 'pause') {
        result.nextAction = 'pause'; result.status = unsafe ? 'needs_clinician_review' : 'in_progress';
        result.nextQuestion = { policyType: 'interaction_pause', targetSlotOrIssue: null, targetFacetId: null,
          text: speakerRole === 'child' ? '可以先不回答，准备好后再继续。' : '可以先暂停提问，准备好后再继续。',
          resumeQuestion: pausedQuestion?.resumeQuestion ?? input.currentQuestion ?? result.nextQuestion };
      } else {
        result.nextAction = 'ask'; result.nextQuestion = pausedQuestion.resumeQuestion ?? result.nextQuestion;
      }
      result.decisionLog.policyType = `interaction_${result.interactionRequest}`;
      result.decisionLog.selectedAction = { nextAction: result.nextAction, nextQuestion: result.nextQuestion };
      result.decisionLog.selectedQuestion = result.nextQuestion?.text ?? '';
      result.decisionLog.targetSlotOrIssue = result.nextQuestion?.targetSlotOrIssue ?? null;
      result.decisionLog.targetFacetId = result.nextQuestion?.targetFacetId ?? null;
    } else if (retrying) {
      result = handleTurn(snapshot, { ...input, semanticAssessment: empty });
      result.stateBuilderExecution = 'model_retry';
    } else if (unsafe) {
      result = handleTurn(snapshot, { ...input, semanticAssessment: empty });
      result.stateBuilderExecution = 'safety_bypass';
    } else if (explicitNonEvidenceResponse(input)) {
      result = handleTurn(snapshot, { ...input, semanticAssessment: { ...empty, responses: [explicitNonEvidenceResponse(input)] } });
      result.stateBuilderExecution = 'explicit_response_fast_path';
    } else {
      const runtime = createLlmRuntimeFromEnv({ ...process.env, PREVISIT_LLM_MODE: 'dynamic' });
      const assessed = await assessTurnEvidence(snapshot, input, runtime.provider, settings);
      // On failure keep the raw turn and previous evidence, never certify new
      // facts with the old keyword threshold. Scoped explicit refusals still hold.
      const assessment = assessed.validated ?? empty;
      result = handleTurn(snapshot, { ...input, semanticAssessment: assessment });
      result.modelAudits = [assessed.audit];
      result.stateBuilderExecution = assessed.validated ? 'success' : 'degraded';
    }
    result.dialogueGuidance = result.semanticAssessment.dialogueGuidance
      ?? fallbackDialogueGuidance(input.answerText, speakerRole);
  } else {
    result = handleTurn(snapshot, input);
    if (settings.mode === 'shadow' && !unsafe) result.pendingSemanticShadow = { snapshot, input, settings };
  }
  result.expectedSnapshot = { updatedAt: snapshot.session.updatedAt,
    completedAt: snapshot.session.completedAt, status: snapshot.session.status };
  if (settings.mode !== 'rule') result.decisionLog.boundaryCheckResult = {
    ...result.decisionLog.boundaryCheckResult, stateBuilderMode: settings.mode,
    stateBuilderExecution: result.stateBuilderExecution ?? 'shadow',
  };
  return result;
}

function scheduleSemanticShadow(result) {
  const pending = result.pendingSemanticShadow;
  if (!pending) return;
  setImmediate(async () => {
    try {
      const runtime = createLlmRuntimeFromEnv({ ...process.env, PREVISIT_LLM_MODE: 'dynamic' });
      const { audit } = await assessTurnEvidence(pending.snapshot, pending.input, runtime.provider, pending.settings);
      store.saveModelAudit(audit);
    } catch (error) { console.error('[semantic shadow unavailable]', error.name); }
  });
}

function scheduleDialogueAudit(result, snapshot) {
  if (process.env.PREVISIT_DIALOGUE_AUDIT_MODE !== 'shadow' || !result.semanticAssessment || result.interactionRequest) return;
  const every = Math.max(1, Number(process.env.PREVISIT_DIALOGUE_AUDIT_EVERY_TURNS ?? 5) || 5);
  if (result.dialogueTurn.turnNo % every !== 0 && result.nextAction !== 'complete') return;
  setImmediate(async () => {
    try {
      const runtime = createLlmRuntimeFromEnv({ ...process.env, PREVISIT_LLM_MODE: 'dynamic' });
      store.saveModelAudit(await auditDialogueTurn(snapshot, result, runtime.provider, stateBuilderSettings().timeoutMs));
    } catch (error) { console.error('[dialogue audit unavailable]', error.name); }
  });
}

async function runShadowForTurn(result) {
  return runShadowExtract(getLlmRuntime(), {
    sessionId: result.sessionId,
    turnNo: result.dialogueTurn.turnNo,
    speakerRole: result.dialogueTurn.speakerRole,
    answerText: result.dialogueTurn.answerText,
    complaintIds: result.mappedComplaints,
    gaps: result.decisionLog.stateSummary?.gaps ?? [],
  });
}

function activeClaimsForTarget(evidenceUnits, target) {
  const slotId = target?.targetSlotOrIssue;
  const facetId = target?.targetFacetId;
  const superseded = new Set((evidenceUnits ?? []).map(e => e.value?.semanticClaim?.correctsEvidenceId).filter(Boolean));
  return (evidenceUnits ?? [])
    .filter((evidence) => evidence.slotId === slotId)
    .filter(evidence => !superseded.has(evidence.evidenceId)
      && (!evidence.value?.semanticClaim || evidence.value.semanticClaim.subject === 'patient'))
    .map((evidence) => {
      const facetIds = evidence.facetIds ?? evidence.value?.facetIds ?? [];
      if (!facetId || !facetIds.includes(facetId)) return null;
      return {
        claimId: evidence.evidenceId,
        complaintId: evidence.domain,
        slotId: evidence.slotId,
        facetId,
        value: evidence.value?.text ?? evidence.rawText,
        evidenceText: evidence.rawText,
        sourceRole: evidence.speakerRole ?? evidence.source,
        polarity: evidence.value?.facetPolarities?.[facetId] ?? evidence.polarity,
        ...(evidence.value?.semanticClaim ? {
          sourceMode: evidence.value.semanticClaim.sourceMode,
          reportedSource: evidence.value.semanticClaim.reportedSource,
          certainty: evidence.value.semanticClaim.certainty,
        } : {}),
        turnId: evidence.turnNo,
      };
    })
    .filter(Boolean)
    .sort((left, right) => (
      Number(right.turnId ?? 0) - Number(left.turnId ?? 0)
    ));
}

function activeFacetConflicts(slotStates, target) {
  return (slotStates ?? []).flatMap((state) => Object.values(state.value?.facets ?? {})
    .filter((facet) => state.slotId === target?.targetSlotOrIssue
      && facet.facetId === target?.targetFacetId
      && ['ambiguous', 'conflict'].includes(facet.status))
    .map((facet) => ({
      conflictId: `${state.complaintId}:${state.slotId}:${facet.facetId}`,
      facetId: facet.facetId,
      summary: `${state.label} / ${facet.label}：${facet.status}`,
      claimIds: facet.evidenceIds ?? [],
      evidenceText: (facet.observations ?? []).map((item) => item.text).filter(Boolean).join('；'),
    })));
}

function relatedTurnsForTarget(turns, target) {
  const ordered = [...(turns ?? [])].sort((left, right) => (
    Number(right.turnNo ?? 0) - Number(left.turnNo ?? 0)
  ));
  return ordered.filter((turn) => turn.targetSlotOrIssue === target?.targetSlotOrIssue
    && turn.targetFacetId === target?.targetFacetId);
}

async function runModelAssistance(result, currentQuestion, snapshot) {
  const audits = [];
  if (result.interactionRequest) return audits;
  const runtime = getLlmRuntime();
  if (result.semanticAssessment && result.stateBuilderExecution !== 'safety_bypass'
    && result.status !== 'needs_clinician_review') {
    audits.push(await runSemanticDialogue(runtime, snapshot, result));
    if (result.completionReviewAudit) audits.push(result.completionReviewAudit);
  } else if (shouldConsiderDynamicQuestion(runtime, result)) {
    const allEvidence = [...(snapshot?.evidenceUnits ?? []), ...(result.evidenceUnits ?? [])];
    const allRisks = [...(snapshot?.riskSignals ?? []), ...(result.riskSignals ?? [])];
    const candidateTargets = dynamicCandidateTargets(result);
    const priorityGoal = candidateTargets.find((target) => (
      questionTargetKey(target) === questionTargetKey(result.nextQuestion)
    )) ?? buildDynamicGoal(result.nextQuestion, {
      complaintIds: result.mappedComplaints,
      latestAnswer: result.dialogueTurn?.answerText,
    });
    const runtimeTargets = candidateTargets;
    const dynamicAudit = await runDynamicNextQuestion(runtime, {
      sessionId: result.sessionId,
      turnNo: result.dialogueTurn.turnNo,
      profile: snapshot?.session?.profile ?? {},
      speakerRole: result.dialogueTurn.speakerRole,
      answerText: result.dialogueTurn.answerText,
      currentQuestion,
      ruleNextQuestion: priorityGoal,
      selectedTargetFacet: priorityGoal,
      selectionReason: result.decisionLog?.selectionReason,
      candidateTargets: runtimeTargets,
      activeClaims: activeClaimsForTargets(allEvidence, runtimeTargets),
      activeConflicts: activeFacetConflictsForTargets(result.slotStates, runtimeTargets),
      openDeterministicRisks: allRisks
        .filter((signal) => signal.status !== 'closed')
        .map((signal) => ({ ...signal, riskId: signal.signalId })),
      relatedTurns: relatedTurnsForTargets(snapshot?.turns, runtimeTargets),
      priorDynamicCallCount: countPriorDynamicCalls(snapshot),
      communicationProfile: Boolean(result.semanticAssessment),
      dialogueGuidance: result.dialogueGuidance,
    });
    audits.push(dynamicAudit);
    applyDynamicQuestionIfAllowed(result, dynamicAudit, currentQuestion, snapshot);
  } else if (shouldConsiderClarification(runtime, result, currentQuestion)) {
    const clarifyAudit = await runClarifyingQuestion(runtime, {
      sessionId: result.sessionId,
      turnNo: result.dialogueTurn.turnNo,
      profile: snapshot?.session?.profile ?? {},
      speakerRole: result.dialogueTurn.speakerRole,
      answerText: result.dialogueTurn.answerText,
      currentQuestion,
      ruleNextQuestion: result.nextQuestion,
      complaintIds: result.mappedComplaints,
      slotStates: result.slotStates,
      progress: result.progress,
    });
    audits.push(clarifyAudit);
    // Shadow mode may record the clarification audit, but it must never replace
    // the rule engine's user-visible next question.
    if (runtime.mode !== 'shadow') {
      applyClarifyingQuestionIfAllowed(result, clarifyAudit, currentQuestion);
    }
  }

  if (!result.semanticAssessment || result.stateBuilderExecution === 'safety_bypass') applyFinalEmotionAcknowledgement(result);

  const focus = result.privateSourceFocusAudit;
  if (focus && (focus.targets.length || focus.excludedTargets.length)) {
    const selected = result.nextQuestion;
    const selectedFocus = focus.targets.find((target) =>
      target.slotId === selected?.targetSlotOrIssue && target.facetId === selected?.targetFacetId);
    const output = {
      ...focus,
      selectedTarget: selected ? { slotId: selected.targetSlotOrIssue, facetId: selected.targetFacetId } : null,
      selectedCrossSourceTarget: Boolean(selectedFocus),
      collectionMode: selectedFocus ? 'cross_source_triggered' : 'current_source',
    };
    audits.push({
      callId: `CF-${result.sessionId}-${result.dialogueTurn.turnNo}`,
      sessionId: result.sessionId, turnNo: result.dialogueTurn.turnNo,
      task: 'source_independent_focus', mode: 'internal', provider: 'deterministic', model: 'none',
      promptVersion: focus.schemaVersion,
      inputHash: createHash('sha256').update(JSON.stringify(focus)).digest('hex'),
      outputHash: createHash('sha256').update(JSON.stringify(output)).digest('hex'),
      latencyMs: 0, status: 'success', error: null, output, createdAt: Date.now(),
    });
  }

  return audits;
}

function linkedCaseContext(sessionId) {
  const caseId = store.clinicalCaseForSession(sessionId);
  if (!caseId) return {};
  const bundle = store.refreshClinicalCase(caseId);
  return { caseId, caseEvidenceState: bundle.evidenceState, caseEvidenceRevision: bundle.clinicalCase.evidenceRevision };
}

function applyFinalEmotionAcknowledgement(result) {
  if (!result?.nextQuestion?.text) return;
  if (result.semanticAssessment) {
    const composed = composeCommunication(result.nextQuestion.questionText ?? result.nextQuestion.text,
      result.modelAcknowledgement, result.dialogueGuidance, result.dialogueTurn.speakerRole);
    result.nextQuestion = { ...result.nextQuestion, text: composed.text,
      questionText: composed.question, acknowledgement: composed.acknowledgement };
    result.decisionLog.selectedAction.nextQuestion = result.nextQuestion;
    result.decisionLog.selectedQuestion = composed.text;
    return;
  }
  const text = ensureRequiredEmotionAcknowledgement(
    result.nextQuestion.text,
    result.dialogueTurn?.answerText,
    result.dialogueTurn?.speakerRole,
  );
  if (text === result.nextQuestion.text) return;
  result.nextQuestion = { ...result.nextQuestion, text };
  if (result.decisionLog?.selectedAction?.nextQuestion) {
    result.decisionLog.selectedAction = {
      ...result.decisionLog.selectedAction,
      nextQuestion: { ...result.decisionLog.selectedAction.nextQuestion, text },
    };
    result.decisionLog.selectedQuestion = text;
  }
}

function shouldConsiderDynamicQuestion(runtime, result) {
  if (!runtime.enabled || runtime.mode !== 'dynamic') return false;
  if (result.nextAction !== 'ask' || !result.nextQuestion) return false;
  if (result.nextQuestion.targetSlotOrIssue === 'safety_clues') return false;
  if (result.status === 'needs_clinician_review' || result.riskSignals?.some((signal) => signal.status !== 'closed')) return false;
  const raw = String(result.dialogueTurn.answerText ?? '').trim();
  return Boolean(raw);
}

function countPriorDynamicCalls(snapshot) {
  return (snapshot?.decisionLogs ?? [])
    .flatMap((log) => log.modelAudits ?? [])
    .filter((audit) => audit.task === 'llm_dynamic_next_question'
      && ['success', 'error'].includes(audit.status))
    .length;
}

function shouldConsiderClarification(runtime, result, currentQuestion) {
  if (!runtime.enabled || !runtime.clarifyEnabled) return false;
  if (runtime.mode === 'dynamic') return false;
  if (!currentQuestion?.targetSlotOrIssue || !currentQuestion?.text) return false;
  if (currentQuestion.targetSlotOrIssue === 'safety_clues') return false;
  const raw = String(result.dialogueTurn.answerText ?? '').trim();
  return Boolean(raw);
}

function applyDynamicQuestionIfAllowed(result, audit, currentQuestion, snapshot) {
  const output = audit?.status === 'success' ? audit.output : null;
  if (!output) {
    recordDynamicFallback(result, audit, audit?.error ?? '动态生成未返回可用问题。');
    return;
  }

  const selection = validateDynamicSelection({
    output,
    candidates: dynamicCandidateTargets(result),
    rejectedCandidates: result.decisionLog?.rejectedCandidates ?? [],
    ruleNextQuestion: result.nextQuestion,
    speakerRole: result.dialogueTurn?.speakerRole ?? 'guardian',
    semanticMode: Boolean(result.semanticAssessment),
  });
  if (!selection.ok) {
    recordDynamicFallback(result, audit, selection.reason);
    return;
  }
  const fullTarget = dynamicCandidateTargets(result).find((target) =>
    questionTargetKey(target) === `${output.complaint_id}:${output.target_slot_or_issue}:${output.target_facet_id}`);
  const independentBoundary = validateIndependentElicitation(output.question, {
    target: fullTarget,
    ownText: [...(snapshot?.turns ?? []).map((turn) => turn.answerText), result.dialogueTurn.answerText].join('\n'),
  });
  if (!independentBoundary.ok) {
    recordDynamicFallback(result, audit, independentBoundary.reason);
    return;
  }
  const unsupportedAssumption = findUnsupportedAssertedBehavior(output.question, result, snapshot);
  if (unsupportedAssumption) {
    recordDynamicFallback(result, audit, `大模型把尚未确认的“${unsupportedAssumption}”写成了既定事实。`);
    return;
  }
  const selectedTarget = selection.target;
  const contextualQuestion = stripMechanicalAcknowledgement(output.question);
  const continuity = validateSalientAnswerContinuity(
    contextualQuestion,
    result.dialogueTurn?.answerText,
  );
  if (!continuity.ok) {
    recordDynamicFallback(result, audit, continuity.reason);
    return;
  }
  const postProcessBoundary = validateQuestionForTarget({
    question: contextualQuestion,
    target: selectedTarget,
    speakerRole: result.dialogueTurn?.speakerRole ?? 'guardian',
    semanticMode: Boolean(result.semanticAssessment),
  });
  if (!postProcessBoundary.ok) {
    recordDynamicFallback(result, audit, postProcessBoundary.reason);
    return;
  }
  if (isNearDuplicateQuestion(contextualQuestion, currentQuestion?.text)) {
    recordDynamicFallback(result, audit, '结合本轮回答后的问题仍与刚问过的问题近似重复。');
    return;
  }
  const visibleQuestion = result.semanticAssessment ? contextualQuestion : ensureRequiredEmotionAcknowledgement(
    contextualQuestion,
    result.dialogueTurn?.answerText,
    result.dialogueTurn?.speakerRole,
  );
  if (result.semanticAssessment) result.modelAcknowledgement = output.acknowledgement ?? '';

  const rulePriorityTargetKey = questionTargetKey(result.nextQuestion);
  const dynamicQuestion = {
    policyType: 'llm_dynamic',
    complaintId: selectedTarget.complaintId,
    targetSlotOrIssue: selectedTarget.targetSlotOrIssue,
    targetFacetId: selectedTarget.targetFacetId,
    label: selectedTarget.label || '动态追问',
    facetLabel: selectedTarget.facetLabel,
    isCriticalRisk: selectedTarget.isCriticalRisk === true,
    audience: result.dialogueTurn?.speakerRole === 'child' ? 'child' : 'guardian',
    text: visibleQuestion,
  };

  result.nextAction = 'ask';
  result.nextQuestion = dynamicQuestion;
  if (result.status !== 'needs_clinician_review') result.status = 'in_progress';
  result.decisionLog.policyType = 'llm_dynamic';
  result.decisionLog.selectedAction = {
    nextAction: 'ask',
    nextQuestion: dynamicQuestion,
  };
  result.decisionLog.selectedQuestion = dynamicQuestion.text;
  result.decisionLog.selectionReason = `Policy Agent：${selection.selectionReason}`;
  result.decisionLog.boundaryCheckResult = {
    ...result.decisionLog.boundaryCheckResult,
    mode: 'llm_dynamic',
    modelCallId: audit.callId,
    confidence: output.confidence,
    modelSuggestionAccepted: true,
    selectedActionType: selection.actionType,
    rulePriorityTarget: rulePriorityTargetKey,
    selectedTargetChanged: questionTargetKey(selectedTarget) !== rulePriorityTargetKey,
    goalSpaceVersion: selectedTarget.goalSpaceVersion ?? '1.0.0',
    consideredCandidates: selection.consideredCandidates,
    contextTelemetry: audit.contextTelemetry ?? null,
  };
  result.decisionLog.targetSlotOrIssue = dynamicQuestion.targetSlotOrIssue;
  result.decisionLog.targetFacetId = dynamicQuestion.targetFacetId;
}

function validateSalientAnswerContinuity(question, answerText) {
  const questionText = String(question ?? '').trim();
  const answer = String(answerText ?? '');
  const schoolGateCrying = /(?:送到|到|一到)(?:了)?(?:学校|校)?门口.{0,6}哭/.test(answer)
    || /哭.{0,8}(?:学校|校)门口/.test(answer);
  const salientTerms = schoolGateCrying
    ? ['学校', '校门', '门口', '哭']
    : ['哭', '害怕', '不敢', '拒绝', '不愿意', '不想去', '自伤', '想死', '不想活', '离家']
      .filter((term) => answer.includes(term));
  if (salientTerms.length === 0 || salientTerms.some((term) => questionText.includes(term))) {
    return { ok: true };
  }
  return { ok: false, reason: '生成的问题没有保留本轮回答中的显著新线索。' };
}

function stripMechanicalAcknowledgement(question) {
  return String(question ?? '').trim().replace(
    /^(?:(?:我理解|您提到|你提到|听起来|这让我|这确实).{0,45}[。！!]\s*)+/,
    '',
  );
}

function findUnsupportedAssertedBehavior(question, result, snapshot) {
  const text = String(question ?? '');
  const evidenceText = [
    snapshot?.session?.chiefComplaint,
    ...(snapshot?.turns ?? []).map((turn) => turn.answerText),
    result.dialogueTurn?.answerText,
    ...(result.evidenceUnits ?? []).map((unit) => unit.rawText),
  ].filter(Boolean).join('。');
  const behaviors = ['拖拉', '走神', '发脾气', '打人', '摔东西', '厌学', '害怕', '失眠', '不吃饭'];
  for (const behavior of behaviors) {
    if (!text.includes(behavior) || evidenceText.includes(behavior)) continue;
    const neutralCheck = new RegExp(`(?:会不会|有没有|是否|会|吗).{0,8}${behavior}|${behavior}.{0,4}(?:吗|没有|会不会|是否)`);
    if (!neutralCheck.test(text)) return behavior;
  }
  return null;
}

function ensureRequiredEmotionAcknowledgement(question, answerText, speakerRole = 'guardian') {
  const text = String(question ?? '').trim();
  const answer = String(answerText ?? '');
  if (!text) return text;
  if (/^(?:听起来你现在|听起来您现在|听起来您这段时间)/.test(text)) return text;

  const directFirstPerson = hasRespondentDistressStatement(answer, speakerRole);
  const childShortExpression = speakerRole === 'child'
    && /^(?:很|特别|真的|非常|有点)?(?:害怕|难受|伤心|紧张|不开心|受不了)[了。！!]?$/.test(answer.trim());
  if (!directFirstPerson && !childShortExpression) return text;

  const acknowledgement = speakerRole === 'child'
    ? /害怕|紧张/.test(answer)
      ? '听起来你现在有些害怕，我们可以慢慢说。'
      : '听起来你现在很难受，我们可以慢慢说。'
    : /崩溃|受不了|撑不住|坚持不住/.test(answer)
      ? '听起来您这段时间很不容易，我们慢慢说。'
      : '听起来您现在有些担心，我们慢慢把情况说清楚。';
  const combined = `${acknowledgement} ${text}`;
  return combined.length <= 90 ? combined : text;
}

function hasRespondentDistressStatement(answer, speakerRole) {
  const patterns = [
    /(?:我|我们|我自己).{0,8}(?:很|特别|真的|非常|有点|越来越|快)?(?:担心|着急|焦虑|害怕|难受|伤心|内疚|自责|崩溃|受不了|撑不住)/g,
    /(?:我|我们).{0,8}(?:不知道怎么办|不知道该怎么办|快坚持不住|快受不了了)/g,
  ];
  for (const pattern of patterns) {
    for (const match of String(answer ?? '').matchAll(pattern)) {
      if (speakerRole !== 'guardian') return true;
      const prefix = String(answer).slice(Math.max(0, (match.index ?? 0) - 36), match.index ?? 0);
      const attributedToChild = /(?:孩子|患儿|儿子|女儿|他|她).{0,12}(?:说|表示|告诉|讲|原话是|觉得)\s*[：:,，]?\s*[“"']?[^。！？!?，,；;”"']{0,12}$/.test(prefix);
      if (!attributedToChild) return true;
    }
  }
  return false;
}

function recordDynamicFallback(result, audit, reason) {
  const applied = applyGoalSpaceFallback(result);
  result.decisionLog.boundaryCheckResult = {
    ...result.decisionLog.boundaryCheckResult,
    mode: applied ? 'goal_space_fallback' : 'dynamic_unavailable',
    modelCallId: audit?.callId ?? null,
    confidence: audit?.output?.confidence,
    modelSuggestionAccepted: false,
    modelRejectionReason: reason,
    goalFallbackGenerated: applied,
    contextTelemetry: audit?.contextTelemetry ?? null,
  };
}

function applyGoalSpaceFallback(result) {
  const targets = dynamicCandidateTargets(result);
  const selected = targets.find((target) => questionTargetKey(target) === questionTargetKey(result.nextQuestion))
    ?? targets[0];
  if (!selected) return false;
  const text = realizeGoalFallback(selected, {
    speakerRole: result.dialogueTurn?.speakerRole ?? 'guardian',
  });
  if (!text) return false;
  const boundary = validateQuestionForTarget({
    question: text,
    target: selected,
    speakerRole: result.dialogueTurn?.speakerRole ?? 'guardian',
  });
  if (!boundary.ok) return false;
  const question = {
    policyType: 'goal_space_fallback',
    complaintId: selected.complaintId,
    targetSlotOrIssue: selected.targetSlotOrIssue,
    targetFacetId: selected.targetFacetId,
    label: selected.facetLabel || '动态追问目标',
    facetLabel: selected.facetLabel,
    audience: result.dialogueTurn?.speakerRole === 'child' ? 'child' : 'guardian',
    text,
  };
  result.nextQuestion = question;
  result.decisionLog.policyType = 'goal_space_fallback';
  result.decisionLog.selectedAction = { nextAction: 'ask', nextQuestion: question };
  result.decisionLog.selectedQuestion = text;
  result.decisionLog.targetSlotOrIssue = question.targetSlotOrIssue;
  result.decisionLog.targetFacetId = question.targetFacetId;
  return true;
}

function applyClarifyingQuestionIfAllowed(result, audit, currentQuestion) {
  const output = audit?.status === 'success' ? audit.output : null;
  if (!output?.need_clarification || !output.question || !currentQuestion?.targetSlotOrIssue) return;
  if (currentQuestion.targetSlotOrIssue === 'safety_clues') return;
  if (output.target_slot_or_issue
    && output.target_slot_or_issue !== currentQuestion.targetSlotOrIssue) return;
  const boundary = validateQuestionForTarget({
    question: output.question,
    target: currentQuestion,
    speakerRole: result.dialogueTurn?.speakerRole ?? 'guardian',
  });
  if (!boundary.ok) return;
  if (isNearDuplicateQuestion(output.question, currentQuestion.text) || isNearDuplicateQuestion(output.question, result.nextQuestion?.text)) {
    return;
  }
  const clarifiedQuestion = {
    policyType: 'llm_clarify',
    complaintId: currentQuestion.complaintId ?? result.nextQuestion?.complaintId ?? result.mappedComplaints?.[0] ?? 'generic_behavioral_health',
    targetSlotOrIssue: currentQuestion.targetSlotOrIssue,
    targetFacetId: currentQuestion.targetFacetId,
    facetLabel: currentQuestion.facetLabel,
    text: output.question,
  };

  result.nextAction = 'ask';
  result.nextQuestion = clarifiedQuestion;
  if (result.status !== 'needs_clinician_review') result.status = 'in_progress';
  result.decisionLog.policyType = 'llm_clarify';
  result.decisionLog.selectedAction = {
    nextAction: 'ask',
    nextQuestion: clarifiedQuestion,
  };
  result.decisionLog.selectedQuestion = clarifiedQuestion.text;
  result.decisionLog.selectionReason = `LLM 澄清追问：${output.reason || '上一轮回答仍需具体化。'}`;
  result.decisionLog.boundaryCheckResult = {
    ...result.decisionLog.boundaryCheckResult,
    mode: 'llm_clarify',
    modelCallId: audit.callId,
    confidence: output.confidence,
  };
  result.decisionLog.targetSlotOrIssue = clarifiedQuestion.targetSlotOrIssue;
  result.decisionLog.targetFacetId = clarifiedQuestion.targetFacetId;
}

function isNearDuplicateQuestion(a, b) {
  const left = normalizeQuestionText(a);
  const right = normalizeQuestionText(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const shorter = left.length < right.length ? left : right;
  const longer = left.length < right.length ? right : left;
  if (shorter.length >= 12 && longer.includes(shorter)) return true;
  const shared = [...new Set(shorter)].filter((char) => longer.includes(char)).length;
  return shorter.length >= 12 && shared / shorter.length > 0.86;
}

function normalizeQuestionText(value) {
  return String(value ?? '').replace(/[，。！？、,.!?;；:：\s]/g, '');
}

function scheduleShadowAudit(result) {
  const runtime = getLlmRuntime();
  if (!runtime.enabled || runtime.mode !== 'shadow') return;
  void runShadowForTurn(result)
    .then((audit) => store.saveModelAudit(audit))
    .catch((err) => {
      console.error('[llm shadow audit failed]', err);
    });
}

function getLlmRuntime() {
  return createLlmRuntimeFromEnv(process.env);
}

function withoutLargeHashes(audit) {
  return {
    callId: audit.callId,
    status: audit.status,
    provider: audit.provider,
    model: audit.model,
    promptVersion: audit.promptVersion,
    latencyMs: audit.latencyMs,
    error: audit.error,
  };
}

function dynamicCandidateTargets(result) {
  const fallback = result.nextQuestion;
  const rejected = new Set((result.decisionLog?.rejectedCandidates ?? []).map(questionTargetKey));
  const source = result.decisionLog?.candidateQuestions ?? [];
  const candidates = source
    .filter((candidate) => candidate.targetSlotOrIssue !== 'safety_clues')
    .filter((candidate) => !rejected.has(questionTargetKey(candidate)))
    .filter((candidate) => Number(candidate.askedCount ?? 0) < Number(candidate.attemptLimit ?? Infinity))
    .sort((left, right) => {
      const leftFallback = questionTargetKey(left) === questionTargetKey(fallback) ? 1 : 0;
      const rightFallback = questionTargetKey(right) === questionTargetKey(fallback) ? 1 : 0;
      if (rightFallback !== leftFallback) return rightFallback - leftFallback;
      const priorityDifference = Number(right.score ?? 0) - Number(left.score ?? 0);
      if (priorityDifference !== 0) return priorityDifference;
      return Number(right.relevanceToLatestAnswer ?? 0) - Number(left.relevanceToLatestAnswer ?? 0);
    });
  if (fallback && !candidates.some((candidate) => questionTargetKey(candidate) === questionTargetKey(fallback))) {
    candidates.unshift(fallback);
  }
  return buildDynamicGoalSpace(candidates.slice(0, 5), {
    complaintIds: result.mappedComplaints,
    latestAnswer: result.dialogueTurn?.answerText,
  });
}

function activeClaimsForTargets(evidenceUnits, targets) {
  const seen = new Set();
  return targets.flatMap((target) => activeClaimsForTarget(evidenceUnits, target))
    .filter((claim) => {
      if (seen.has(claim.claimId)) return false;
      seen.add(claim.claimId);
      return true;
    })
    .sort((left, right) => Number(right.turnId ?? 0) - Number(left.turnId ?? 0));
}

function activeFacetConflictsForTargets(slotStates, targets) {
  return targets.flatMap((target) => activeFacetConflicts(slotStates, target));
}

function relatedTurnsForTargets(turns, targets) {
  const keys = new Set(targets.map(questionTargetKey));
  return [...(turns ?? [])]
    .filter((turn) => keys.has(questionTargetKey(turn)))
    .sort((left, right) => Number(right.turnNo ?? 0) - Number(left.turnNo ?? 0));
}

function questionTargetKey(target = {}) {
  return `${target.complaintId ?? ''}:${target.targetSlotOrIssue ?? ''}:${target.targetFacetId ?? ''}`;
}
