import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { listTemplateRows } from '../core/templates.mjs';
import { generatePrevisitPacket } from '../core/packet.mjs';
import { createClinicianRepository } from './clinician-store.mjs';
import { normalizeMediaTimeline } from '../core/mediaTimeline.mjs';

const DEFAULT_DB_PATH = join(process.cwd(), 'server', 'data', 'previsit.db');

const STORE_MIGRATIONS = [
  {
    version: 2,
    name: 'v2_evidence_persistence_skeleton',
    statements: [
      `CREATE TABLE evidence_claim (
        claim_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_no INTEGER NOT NULL,
        source TEXT NOT NULL,
        speaker_role TEXT NOT NULL,
        domain TEXT NOT NULL,
        slot_id TEXT NOT NULL,
        facet_id TEXT NOT NULL,
        normalized_value_json TEXT,
        polarity TEXT,
        time_scope TEXT,
        quote_text TEXT NOT NULL,
        quote_start INTEGER NOT NULL CHECK (quote_start >= 0),
        quote_end INTEGER NOT NULL CHECK (quote_end >= quote_start),
        extractor TEXT NOT NULL,
        extractor_version TEXT NOT NULL,
        model TEXT,
        prompt_version TEXT,
        schema_version TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(session_id, claim_id),
        FOREIGN KEY(session_id, turn_no) REFERENCES dialogue_turn(session_id, turn_no) ON DELETE CASCADE
      )`,
      `CREATE TABLE evidence_claim_event (
        claim_event_id TEXT PRIMARY KEY,
        claim_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK (event_type IN ('accepted', 'rejected', 'uncertain', 'superseded')),
        reason_code TEXT,
        supersedes_claim_id TEXT,
        detail_json TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(session_id, claim_id) REFERENCES evidence_claim(session_id, claim_id) ON DELETE CASCADE,
        FOREIGN KEY(session_id, supersedes_claim_id) REFERENCES evidence_claim(session_id, claim_id)
      )`,
      `CREATE TABLE facet_state_v2 (
        session_id TEXT NOT NULL,
        complaint_id TEXT NOT NULL,
        slot_id TEXT NOT NULL,
        facet_id TEXT NOT NULL,
        label TEXT,
        status TEXT NOT NULL CHECK (
          status IN ('missing', 'partial', 'filled', 'ambiguous', 'conflict', 'declined', 'unavailable', 'not_applicable')
        ),
        value_json TEXT,
        evidence_claim_ids_json TEXT NOT NULL,
        conflict_reason TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(session_id, complaint_id, slot_id, facet_id),
        FOREIGN KEY(session_id) REFERENCES interview_session(session_id) ON DELETE CASCADE
      )`,
      `CREATE TABLE interview_state_event (
        event_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_no INTEGER NOT NULL,
        complaint_id TEXT,
        slot_id TEXT,
        facet_id TEXT,
        event_type TEXT NOT NULL,
        detail_json TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(session_id, turn_no) REFERENCES dialogue_turn(session_id, turn_no) ON DELETE CASCADE
      )`,
      `CREATE INDEX idx_evidence_claim_session
        ON evidence_claim(session_id, turn_no, slot_id, facet_id)`,
      `CREATE INDEX idx_evidence_claim_event_session
        ON evidence_claim_event(session_id, created_at)`,
      `CREATE INDEX idx_facet_state_v2_session
        ON facet_state_v2(session_id, complaint_id, slot_id)`,
      `CREATE INDEX idx_interview_state_event_session
        ON interview_state_event(session_id, turn_no)`,
    ],
  },
  {
    version: 3,
    name: 'v3_model_audit_telemetry',
    statements: [
      `ALTER TABLE model_audit_log ADD COLUMN telemetry_json TEXT`,
    ],
  },
  {
    version: 4,
    name: 'v4_dialogue_turn_target_facet',
    statements: [
      `ALTER TABLE dialogue_turn ADD COLUMN target_facet_id TEXT`,
    ],
  },
  {
    version: 5,
    name: 'v5_decision_log_target_facet',
    statements: [
      `ALTER TABLE next_question_decision_log ADD COLUMN target_facet_id TEXT`,
      `UPDATE next_question_decision_log
         SET target_facet_id = json_extract(selected_action_json, '$.nextQuestion.targetFacetId')
       WHERE target_facet_id IS NULL
         AND json_valid(selected_action_json)`,
    ],
  },
  {
    version: 6,
    name: 'v6_question_recording_timeline',
    statements: [
      `ALTER TABLE media_record ADD COLUMN timeline_json TEXT`,
      `ALTER TABLE media_record ADD COLUMN recording_started_at INTEGER`,
    ],
  },
];

export class TurnConflictError extends Error {
  constructor(sessionId, turnNo) {
    super(`turn conflict: ${sessionId} already has turn ${turnNo} with different content`);
    this.name = 'TurnConflictError';
    this.code = 'TURN_CONFLICT';
    this.statusCode = 409;
  }
}

export function createStore(dbPath = process.env.PREVISIT_DB_PATH ?? DEFAULT_DB_PATH) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  runSchemaMigrations(db);
  seedTemplates(db);

  const store = {
    db,
    createSession(input) {
      if (input.caseId) this.getClinicalCase(input.caseId);
      const sessionId = randomSessionId();
      const now = Date.now();
      db.prepare(
        `INSERT INTO interview_session
          (session_id, status, profile_json, selected_complaints_json, mapped_complaints_json, chief_complaint, progress_json, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        sessionId,
        'draft',
        json(input.profile ?? {}),
        json(input.selectedComplaints ?? []),
        json([]),
        input.chiefComplaint ?? '',
        json({ requiredFilled: 0, requiredTotal: 0, percent: 0 }),
        now,
        now,
      );
      const association = this.registerClinicalSession(sessionId, input.caseId ?? null);
      return {
        sessionId,
        caseId: association.caseId,
        profile: input.profile ?? {},
        selectedComplaints: input.selectedComplaints ?? [],
        chiefComplaint: input.chiefComplaint ?? '',
      };
    },
    getSnapshot(sessionId) {
      return loadSnapshot(db, sessionId);
    },
    applyTurnResult(result) {
      const tx = db.transaction(() => {
        const existingTurn = db.prepare(
          `SELECT * FROM dialogue_turn WHERE session_id = ? AND turn_no = ?`,
        ).get(result.dialogueTurn.sessionId, result.dialogueTurn.turnNo);
        if (existingTurn) {
          if (!sameDialogueTurn(existingTurn, result.dialogueTurn)) {
            throw new TurnConflictError(result.dialogueTurn.sessionId, result.dialogueTurn.turnNo);
          }
          return;
        }

        const now = Date.now();
        const completedAt = result.nextAction === 'complete' ? now : null;
        db.prepare(
          `UPDATE interview_session
             SET status = ?, mapped_complaints_json = ?, progress_json = ?,
                 completed_at = COALESCE(?, completed_at), updated_at = ?
           WHERE session_id = ?`,
        ).run(result.status, json(result.mappedComplaints), json(result.progress), completedAt, now, result.sessionId);

        db.prepare(
          `INSERT INTO dialogue_turn
            (session_id, turn_no, speaker_role, question_text, answer_text, question_policy_type,
             target_slot_or_issue, target_facet_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          result.dialogueTurn.sessionId,
          result.dialogueTurn.turnNo,
          result.dialogueTurn.speakerRole,
          result.dialogueTurn.questionText,
          result.dialogueTurn.answerText,
          result.dialogueTurn.questionPolicyType,
          result.dialogueTurn.targetSlotOrIssue,
          result.dialogueTurn.targetFacetId ?? null,
          result.dialogueTurn.createdAt,
        );

        for (const evidence of result.evidenceUnits) {
          db.prepare(
            `INSERT OR REPLACE INTO evidence_unit
              (evidence_id, session_id, turn_no, source, speaker_role, domain, slot_id, time_scope, polarity, value_json, raw_text, confidence, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            evidence.evidenceId,
            evidence.sessionId,
            evidence.turnNo,
            evidence.source,
            evidence.speakerRole,
            evidence.domain,
            evidence.slotId,
            evidence.timeScope,
            evidence.polarity,
            json(evidence.value),
            evidence.rawText,
            evidence.confidence,
            evidence.createdAt,
          );
        }

        for (const signal of result.riskSignals) {
          db.prepare(
            `INSERT OR REPLACE INTO risk_signal
              (signal_id, session_id, turn_no, signal_type, trigger_text, keyword, source, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            signal.signalId,
            signal.sessionId,
            signal.turnNo,
            signal.signalType,
            signal.triggerText,
            signal.keyword,
            signal.source,
            signal.status,
            signal.createdAt,
          );
        }

        for (const state of result.slotStates) {
          db.prepare(
            `INSERT INTO slot_state
              (session_id, complaint_id, slot_id, label, status, value_json, evidence_ids_json, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(session_id, complaint_id, slot_id) DO UPDATE SET
               label = excluded.label,
               status = excluded.status,
               value_json = excluded.value_json,
               evidence_ids_json = excluded.evidence_ids_json,
               updated_at = excluded.updated_at`,
          ).run(
            state.sessionId,
            state.complaintId,
            state.slotId,
            state.label,
            state.status,
            json(state.value),
            json(state.evidenceIds ?? []),
            state.updatedAt,
          );
        }

        db.prepare(
          `INSERT OR REPLACE INTO next_question_decision_log
            (decision_id, session_id, turn_no, policy_type, state_summary_json, candidate_questions_json,
             rejected_candidates_json, selected_action_json, selected_question, selection_reason,
             boundary_check_result_json, risk_marker_json, target_slot_or_issue, target_facet_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          result.decisionLog.decisionId,
          result.decisionLog.sessionId,
          result.decisionLog.turnNo,
          result.decisionLog.policyType,
          json(result.decisionLog.stateSummary),
          json(result.decisionLog.candidateQuestions),
          json(result.decisionLog.rejectedCandidates),
          json(result.decisionLog.selectedAction),
          result.decisionLog.selectedQuestion,
          result.decisionLog.selectionReason,
          json(result.decisionLog.boundaryCheckResult),
          json(result.decisionLog.riskMarker),
          result.decisionLog.targetSlotOrIssue,
          result.decisionLog.targetFacetId ?? null,
          result.decisionLog.createdAt,
        );

        for (const audit of result.modelAudits ?? []) insertModelAudit(db, audit);
      });
      tx();
      const clinicalCaseId = this.clinicalCaseForSession(result.sessionId);
      if (clinicalCaseId) this.refreshClinicalCase(clinicalCaseId);
      return this.getSnapshot(result.sessionId);
    },
    completeSession(sessionId) {
      this.getSnapshot(sessionId);
      const now = Date.now();
      db.prepare(
        `UPDATE interview_session
            SET status = 'completed', completed_at = COALESCE(completed_at, ?), updated_at = ?
          WHERE session_id = ?`,
      ).run(now, now, sessionId);
      return this.getSnapshot(sessionId);
    },
    saveModelAudit(audit) {
      insertModelAudit(db, audit);
      return audit;
    },
    saveMediaRecord(record) {
      const mediaRecord = {
        mediaId: record.mediaId ?? `MR-${randomUUID().slice(0, 10).toUpperCase()}`,
        sessionId: record.sessionId,
        turnNo: Number(record.turnNo ?? 0),
        modality: record.modality,
        mimeType: record.mimeType,
        fileName: record.fileName,
        filePath: record.filePath,
        blobSize: Number(record.blobSize ?? 0),
        durationMs: Number(record.durationMs ?? 0),
        questionText: record.questionText ?? null,
        targetSlotOrIssue: record.targetSlotOrIssue ?? null,
        timeline: normalizeMediaTimeline(record.timeline, Number(record.durationMs ?? 0), record.timeline?.length ? this.getSnapshot(record.sessionId).turns : []),
        recordingStartedAt: Number.isFinite(record.recordingStartedAt) ? record.recordingStartedAt : null,
        createdAt: record.createdAt ?? Date.now(),
      };
      db.prepare(
        `INSERT OR REPLACE INTO media_record
          (media_id, session_id, turn_no, modality, mime_type, file_name, file_path,
           blob_size, duration_ms, question_text, target_slot_or_issue, created_at, timeline_json, recording_started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        mediaRecord.mediaId,
        mediaRecord.sessionId,
        mediaRecord.turnNo,
        mediaRecord.modality,
        mediaRecord.mimeType,
        mediaRecord.fileName,
        mediaRecord.filePath,
        mediaRecord.blobSize,
        mediaRecord.durationMs,
        mediaRecord.questionText,
        mediaRecord.targetSlotOrIssue,
        mediaRecord.createdAt,
        json(mediaRecord.timeline),
        mediaRecord.recordingStartedAt,
      );
      return mediaRecord;
    },
    listMediaRecords(sessionId) {
      return loadMediaRecords(db, sessionId);
    },
    getMediaRecord(mediaId) {
      const row = db.prepare(`SELECT * FROM media_record WHERE media_id = ?`).get(mediaId);
      return row ? mapMediaRecord(row) : null;
    },
    listLlmConfigs() {
      return db
        .prepare(
          `SELECT id, name, provider_type, base_url, model, clarify_model, mode,
                  prompt_price_per_1k, completion_price_per_1k, enabled,
                  created_at, updated_at,
                  CASE WHEN api_key IS NOT NULL AND LENGTH(api_key) > 0 THEN 1 ELSE 0 END AS has_key
             FROM llm_provider_config
            ORDER BY enabled DESC, updated_at DESC, id DESC`,
        )
        .all()
        .map(mapLlmConfig);
    },
    getActiveLlmConfig() {
      const row = db
        .prepare(
          `SELECT id, name, provider_type, base_url, api_key, model, clarify_model, mode,
                  prompt_price_per_1k, completion_price_per_1k, enabled,
                  created_at, updated_at,
                  CASE WHEN api_key IS NOT NULL AND LENGTH(api_key) > 0 THEN 1 ELSE 0 END AS has_key
             FROM llm_provider_config
            WHERE enabled = 1
            ORDER BY updated_at DESC, id DESC
            LIMIT 1`,
        )
        .get();
      return row ? mapLlmConfig(row, { includeSecret: true }) : null;
    },
    getLlmConfig(id) {
      const row = db
        .prepare(
          `SELECT id, name, provider_type, base_url, api_key, model, clarify_model, mode,
                  prompt_price_per_1k, completion_price_per_1k, enabled,
                  created_at, updated_at,
                  CASE WHEN api_key IS NOT NULL AND LENGTH(api_key) > 0 THEN 1 ELSE 0 END AS has_key
             FROM llm_provider_config
            WHERE id = ?`,
        )
        .get(id);
      return row ? mapLlmConfig(row, { includeSecret: true }) : null;
    },
    saveLlmConfig(input) {
      const now = Date.now();
      const mode = normalizeLlmMode(input.mode);
      const providerType = String(input.providerType ?? 'openai_compatible').trim() || 'openai_compatible';
      const enabled = input.enabled === false ? 0 : 1;
      const baseUrl = String(input.baseUrl ?? '').trim();
      const model = String(input.model ?? '').trim();
      const clarifyModel = String(input.clarifyModel ?? model).trim() || model;
      if (!String(input.name ?? '').trim()) throw new Error('name_required');
      if (!baseUrl) throw new Error('base_url_required');
      if (!model) throw new Error('model_required');

      if (input.id) {
        const old = db.prepare(`SELECT api_key FROM llm_provider_config WHERE id = ?`).get(input.id);
        if (!old) throw new Error('llm_config_not_found');
        const apiKey = String(input.apiKey ?? '').trim() || old.api_key || null;
        db.prepare(
          `UPDATE llm_provider_config
              SET name = ?, provider_type = ?, base_url = ?, api_key = ?, model = ?, clarify_model = ?,
                  mode = ?, prompt_price_per_1k = ?, completion_price_per_1k = ?,
                  enabled = ?, updated_at = ?
            WHERE id = ?`,
        ).run(
          String(input.name).trim(),
          providerType,
          baseUrl,
          apiKey,
          model,
          clarifyModel,
          mode,
          finiteNumber(input.promptPricePer1k),
          finiteNumber(input.completionPricePer1k),
          enabled,
          now,
          input.id,
        );
        return this.listLlmConfigs().find((config) => config.id === Number(input.id));
      }

      const result = db.prepare(
        `INSERT INTO llm_provider_config
          (name, provider_type, base_url, api_key, model, clarify_model, mode,
           prompt_price_per_1k, completion_price_per_1k, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        String(input.name).trim(),
        providerType,
        baseUrl,
        String(input.apiKey ?? '').trim() || null,
        model,
        clarifyModel,
        mode,
        finiteNumber(input.promptPricePer1k),
        finiteNumber(input.completionPricePer1k),
        enabled,
        now,
        now,
      );
      return this.listLlmConfigs().find((config) => config.id === Number(result.lastInsertRowid));
    },
    getLlmUsage() {
      const row = db.prepare(
        `SELECT COUNT(*) AS calls,
                SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
                COALESCE(AVG(latency_ms), 0) AS avg_latency_ms
           FROM model_audit_log`,
      ).get();
      const latest = db.prepare(
        `SELECT provider, model, mode, task, status, error, created_at
           FROM model_audit_log
          ORDER BY created_at DESC
          LIMIT 1`,
      ).get();
      return {
        calls: Number(row?.calls ?? 0),
        successes: Number(row?.successes ?? 0),
        errors: Number(row?.errors ?? 0),
        avgLatencyMs: Math.round(Number(row?.avg_latency_ms ?? 0)),
        latestProvider: latest?.provider ?? null,
        latestModel: latest?.model ?? null,
        latestMode: latest?.mode ?? null,
        latestTask: latest?.task ?? null,
        latestStatus: latest?.status ?? null,
        latestError: latest?.error ?? null,
        latestAt: latest?.created_at ?? null,
      };
    },
    generatePacket(sessionId) {
      const snapshot = loadSnapshot(db, sessionId);
      const packet = generatePrevisitPacket(snapshot);
      const latest = snapshot.packets.at(-1) ?? null;
      if (latest && json(latest.content) === json(packet.content)) {
        return { ...latest, unchanged: true };
      }
      db.prepare(
        `INSERT INTO previsit_packet
          (packet_id, session_id, version, status, content_json, doctor_edit_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(packet.packetId, packet.sessionId, packet.version, packet.status, json(packet.content), null, packet.createdAt);
      return { ...packet, unchanged: false };
    },
    listQueue(filters = {}) {
      const status = typeof filters.status === 'string' ? filters.status : '';
      const allowed = new Set(['draft', 'in_progress', 'completed', 'needs_clinician_review']);
      const rows = status && allowed.has(status)
        ? db.prepare(`SELECT session_id FROM interview_session WHERE status = ? ORDER BY updated_at DESC LIMIT 50`).all(status)
        : db.prepare(`SELECT session_id FROM interview_session ORDER BY updated_at DESC LIMIT 50`).all();
      return rows.map((row) => summarizeForQueue(loadSnapshot(db, row.session_id)));
    },
    resetDemoData() {
      const tx = db.transaction(() => {
        const mediaPaths = db
          .prepare(`SELECT DISTINCT file_path FROM media_record WHERE file_path IS NOT NULL AND file_path != ''`)
          .all()
          .map((row) => String(row.file_path));
        const sessionTables = [
          'clinical_case',
          'evidence_claim_event',
          'evidence_claim',
          'facet_state_v2',
          'interview_state_event',
          'previsit_packet',
          'media_record',
          'next_question_decision_log',
          'model_audit_log',
          'risk_signal',
          'evidence_unit',
          'slot_state',
          'dialogue_turn',
          'interview_session',
        ];
        // Older databases may still contain the retired table. Clear it on a
        // demo reset without creating or dropping it for new installations.
        if (tableExists(db, 'formal_question_sets')) sessionTables.splice(1, 0, 'formal_question_sets');
        for (const table of sessionTables) {
          db.prepare(`DELETE FROM ${table}`).run();
        }
        return mediaPaths;
      });
      const mediaPaths = tx();
      return { ok: true, mediaPaths };
    },
    close() {
      db.close();
    },
  };
  Object.assign(store, createClinicianRepository(db, store));
  store.backfillClinicalCases();
  return store;
}

function initSchema(db) {
  const ddl = [
    `CREATE TABLE IF NOT EXISTS complaint_template (
      complaint_id TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      name TEXT NOT NULL,
      config_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS interview_session (
      session_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      profile_json TEXT NOT NULL,
      selected_complaints_json TEXT NOT NULL,
      mapped_complaints_json TEXT NOT NULL,
      chief_complaint TEXT,
      progress_json TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS dialogue_turn (
      session_id TEXT NOT NULL,
      turn_no INTEGER NOT NULL,
      speaker_role TEXT NOT NULL,
      question_text TEXT,
      answer_text TEXT NOT NULL,
      question_policy_type TEXT,
      target_slot_or_issue TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(session_id, turn_no)
    )`,
    `CREATE TABLE IF NOT EXISTS slot_state (
      session_id TEXT NOT NULL,
      complaint_id TEXT NOT NULL,
      slot_id TEXT NOT NULL,
      label TEXT,
      status TEXT NOT NULL,
      value_json TEXT,
      evidence_ids_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(session_id, complaint_id, slot_id)
    )`,
    `CREATE TABLE IF NOT EXISTS evidence_unit (
      evidence_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_no INTEGER NOT NULL,
      source TEXT NOT NULL,
      speaker_role TEXT NOT NULL,
      domain TEXT,
      slot_id TEXT,
      time_scope TEXT,
      polarity TEXT,
      value_json TEXT,
      raw_text TEXT NOT NULL,
      confidence REAL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS risk_signal (
      signal_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_no INTEGER NOT NULL,
      signal_type TEXT NOT NULL,
      trigger_text TEXT NOT NULL,
      keyword TEXT,
      source TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS previsit_packet (
      packet_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      status TEXT NOT NULL,
      content_json TEXT NOT NULL,
      doctor_edit_json TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(session_id, version)
    )`,
    `CREATE TABLE IF NOT EXISTS next_question_decision_log (
      decision_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_no INTEGER NOT NULL,
      policy_type TEXT NOT NULL,
      state_summary_json TEXT NOT NULL,
      candidate_questions_json TEXT NOT NULL,
      rejected_candidates_json TEXT NOT NULL,
      selected_action_json TEXT NOT NULL,
      selected_question TEXT,
      selection_reason TEXT,
      boundary_check_result_json TEXT,
      risk_marker_json TEXT,
      target_slot_or_issue TEXT,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS model_audit_log (
      call_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_no INTEGER NOT NULL,
      task TEXT NOT NULL,
      mode TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT,
      prompt_version TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      output_hash TEXT,
      latency_ms INTEGER,
      status TEXT NOT NULL,
      error TEXT,
      output_json TEXT,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS media_record (
      media_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_no INTEGER NOT NULL,
      modality TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      blob_size INTEGER NOT NULL,
      duration_ms INTEGER,
      question_text TEXT,
      target_slot_or_issue TEXT,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS llm_provider_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      provider_type TEXT NOT NULL DEFAULT 'openai_compatible',
      base_url TEXT NOT NULL,
      api_key TEXT,
      model TEXT NOT NULL,
      clarify_model TEXT,
      mode TEXT NOT NULL DEFAULT 'dynamic',
      prompt_price_per_1k REAL NOT NULL DEFAULT 0,
      completion_price_per_1k REAL NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  ];
  for (const sql of ddl) db.prepare(sql).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_session_status ON interview_session(status, updated_at)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_evidence_session ON evidence_unit(session_id, turn_no)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_risk_session ON risk_signal(session_id, status)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_decision_session ON next_question_decision_log(session_id, turn_no)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_model_audit_session ON model_audit_log(session_id, turn_no)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_media_record_session ON media_record(session_id, turn_no)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_llm_provider_enabled ON llm_provider_config(enabled, updated_at)`).run();
}

function runSchemaMigrations(db) {
  const migrate = db.transaction(() => {
    db.prepare(
      `CREATE TABLE IF NOT EXISTS schema_migration (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      )`,
    ).run();

    for (const migration of STORE_MIGRATIONS) {
      const applied = db.prepare(`SELECT name FROM schema_migration WHERE version = ?`).get(migration.version);
      if (applied) {
        if (applied.name !== migration.name) {
          throw new Error(`schema migration version ${migration.version} name mismatch`);
        }
        continue;
      }
      for (const sql of migration.statements) db.prepare(sql).run();
      db.prepare(`INSERT INTO schema_migration (version, name, applied_at) VALUES (?, ?, ?)`).run(
        migration.version,
        migration.name,
        Date.now(),
      );
    }
  });
  migrate();
  assertMigrationSchema(db);
}

function assertMigrationSchema(db) {
  const requiredColumns = {
    evidence_claim: [
      'claim_id', 'session_id', 'turn_no', 'slot_id', 'facet_id',
      'normalized_value_json', 'quote_text', 'extractor_version', 'schema_version',
    ],
    evidence_claim_event: [
      'claim_event_id', 'claim_id', 'session_id', 'event_type', 'supersedes_claim_id',
    ],
    facet_state_v2: [
      'session_id', 'complaint_id', 'slot_id', 'facet_id', 'status',
      'value_json', 'evidence_claim_ids_json',
    ],
    interview_state_event: [
      'event_id', 'session_id', 'turn_no', 'slot_id', 'facet_id', 'event_type',
    ],
    model_audit_log: ['telemetry_json'],
    dialogue_turn: ['target_facet_id'],
    next_question_decision_log: ['target_facet_id'],
  };

  for (const [table, columns] of Object.entries(requiredColumns)) {
    if (!tableExists(db, table)) throw new Error(`schema migration incomplete: missing table ${table}`);
    const actual = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
    for (const column of columns) {
      if (!actual.has(column)) {
        throw new Error(`schema migration incomplete: missing column ${table}.${column}`);
      }
    }
  }

  const expectedForeignKeys = [
    ['evidence_claim', 'dialogue_turn'],
    ['evidence_claim_event', 'evidence_claim'],
    ['facet_state_v2', 'interview_session'],
    ['interview_state_event', 'dialogue_turn'],
  ];
  for (const [table, parent] of expectedForeignKeys) {
    const parents = new Set(db.prepare(`PRAGMA foreign_key_list(${table})`).all().map((key) => key.table));
    if (!parents.has(parent)) {
      throw new Error(`schema migration incomplete: ${table} must reference ${parent}`);
    }
  }
}

function seedTemplates(db) {
  const now = Date.now();
  for (const row of listTemplateRows()) {
    db.prepare(
      `INSERT INTO complaint_template (complaint_id, version, name, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(complaint_id) DO UPDATE SET
         version = excluded.version,
         name = excluded.name,
         config_json = excluded.config_json,
         updated_at = excluded.updated_at`,
    ).run(row.complaint_id, row.version, row.name, row.config_json, now, now);
  }
}

function loadSnapshot(db, sessionId) {
  const row = db.prepare(`SELECT * FROM interview_session WHERE session_id = ?`).get(sessionId);
  if (!row) throw new Error(`session not found: ${sessionId}`);
  const session = {
    sessionId: row.session_id,
    status: row.status,
    profile: parse(row.profile_json, {}),
    selectedComplaints: parse(row.selected_complaints_json, []),
    mappedComplaints: parse(row.mapped_complaints_json, []),
    chiefComplaint: row.chief_complaint ?? '',
    progress: parse(row.progress_json, { requiredFilled: 0, requiredTotal: 0, percent: 0 }),
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
  return {
    session,
    turns: db
      .prepare(`SELECT * FROM dialogue_turn WHERE session_id = ? ORDER BY turn_no ASC`)
      .all(sessionId)
      .map((item) => ({
        qaId: `QA-${item.session_id}-${item.turn_no}`,
        sessionId: item.session_id,
        turnNo: item.turn_no,
        speakerRole: item.speaker_role,
        questionText: item.question_text,
        answerText: item.answer_text,
        questionPolicyType: item.question_policy_type,
        targetSlotOrIssue: item.target_slot_or_issue,
        targetFacetId: item.target_facet_id,
        createdAt: item.created_at,
      })),
    slotStates: db
      .prepare(`SELECT * FROM slot_state WHERE session_id = ? ORDER BY complaint_id, slot_id`)
      .all(sessionId)
      .map((item) => ({
        sessionId: item.session_id,
        complaintId: item.complaint_id,
        slotId: item.slot_id,
        label: item.label,
        status: item.status,
        value: parse(item.value_json, null),
        evidenceIds: parse(item.evidence_ids_json, []),
        updatedAt: item.updated_at,
      })),
    evidenceUnits: db
      .prepare(`SELECT * FROM evidence_unit WHERE session_id = ? ORDER BY turn_no, evidence_id`)
      .all(sessionId)
      .map((item) => ({
        evidenceId: item.evidence_id,
        sessionId: item.session_id,
        turnNo: item.turn_no,
        source: item.source,
        speakerRole: item.speaker_role,
        domain: item.domain,
        slotId: item.slot_id,
        timeScope: item.time_scope,
        polarity: item.polarity,
        value: parse(item.value_json, null),
        rawText: item.raw_text,
        confidence: item.confidence,
        createdAt: item.created_at,
      })),
    riskSignals: db
      .prepare(`SELECT * FROM risk_signal WHERE session_id = ? ORDER BY turn_no, signal_id`)
      .all(sessionId)
      .map((item) => ({
        signalId: item.signal_id,
        sessionId: item.session_id,
        turnNo: item.turn_no,
        signalType: item.signal_type,
        triggerText: item.trigger_text,
        keyword: item.keyword,
        source: item.source,
        status: item.status,
        createdAt: item.created_at,
      })),
    decisionLogs: attachModelAudits(
      db
      .prepare(`SELECT * FROM next_question_decision_log WHERE session_id = ? ORDER BY turn_no ASC`)
      .all(sessionId)
      .map((item) => ({
        decisionId: item.decision_id,
        sessionId: item.session_id,
        turnNo: item.turn_no,
        policyType: item.policy_type,
        stateSummary: parse(item.state_summary_json, {}),
        candidateQuestions: parse(item.candidate_questions_json, []),
        rejectedCandidates: parse(item.rejected_candidates_json, []),
        selectedAction: parse(item.selected_action_json, {}),
        selectedQuestion: item.selected_question,
        selectionReason: item.selection_reason,
        boundaryCheckResult: parse(item.boundary_check_result_json, null),
        riskMarker: parse(item.risk_marker_json, []),
        targetSlotOrIssue: item.target_slot_or_issue,
        targetFacetId: item.target_facet_id,
        createdAt: item.created_at,
      })),
      db
        .prepare(`SELECT * FROM model_audit_log WHERE session_id = ? ORDER BY turn_no ASC, created_at ASC`)
        .all(sessionId)
        .map((item) => ({
          callId: item.call_id,
          sessionId: item.session_id,
          turnNo: item.turn_no,
          task: item.task,
          mode: item.mode,
          provider: item.provider,
          model: item.model,
          promptVersion: item.prompt_version,
          inputHash: item.input_hash,
          outputHash: item.output_hash,
          latencyMs: item.latency_ms,
          status: item.status,
          error: item.error,
          output: parse(item.output_json, null),
          contextTelemetry: parse(item.telemetry_json, {}).contextTelemetry ?? null,
          usage: parse(item.telemetry_json, {}).providerUsage ?? null,
          createdAt: item.created_at,
        })),
    ),
    mediaRecords: loadMediaRecords(db, sessionId),
    packets: db
      .prepare(`SELECT * FROM previsit_packet WHERE session_id = ? ORDER BY version ASC`)
      .all(sessionId)
      .map((item) => ({
        packetId: item.packet_id,
        sessionId: item.session_id,
        version: item.version,
        status: item.status,
        content: parse(item.content_json, {}),
        doctorEdit: parse(item.doctor_edit_json, null),
        createdAt: item.created_at,
      })),
  };
}

function loadMediaRecords(db, sessionId) {
  return db
    .prepare(`SELECT * FROM media_record WHERE session_id = ? ORDER BY turn_no ASC, created_at ASC`)
    .all(sessionId)
    .map(mapMediaRecord);
}

function mapMediaRecord(row) {
  return {
    mediaId: row.media_id,
    sessionId: row.session_id,
    turnNo: row.turn_no,
    modality: row.modality,
    mimeType: row.mime_type,
    fileName: row.file_name,
    filePath: row.file_path,
    blobSize: row.blob_size,
    durationMs: row.duration_ms,
    questionText: row.question_text,
    targetSlotOrIssue: row.target_slot_or_issue,
    timeline: parse(row.timeline_json, []),
    recordingStartedAt: row.recording_started_at ?? null,
    createdAt: row.created_at,
  };
}

function mapLlmConfig(row, options = {}) {
  return {
    id: Number(row.id),
    name: row.name,
    providerType: row.provider_type,
    baseUrl: row.base_url,
    model: row.model,
    clarifyModel: row.clarify_model || row.model,
    mode: normalizeLlmMode(row.mode),
    promptPricePer1k: Number(row.prompt_price_per_1k ?? 0),
    completionPricePer1k: Number(row.completion_price_per_1k ?? 0),
    enabled: Number(row.enabled ?? 0) === 1,
    hasKey: Number(row.has_key ?? 0) === 1,
    apiKey: options.includeSecret ? row.api_key : undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function normalizeLlmMode(value) {
  const mode = String(value ?? 'dynamic').trim().toLowerCase();
  return ['off', 'shadow', 'dynamic'].includes(mode) ? mode : 'dynamic';
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function tableExists(db, table) {
  return Boolean(
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table),
  );
}

function sameDialogueTurn(stored, incoming) {
  const sameOptional = (left, right) => (left ?? null) === (right ?? null);
  return stored.session_id === incoming.sessionId
    && Number(stored.turn_no) === Number(incoming.turnNo)
    && stored.speaker_role === incoming.speakerRole
    && sameOptional(stored.question_text, incoming.questionText)
    && stored.answer_text === incoming.answerText
    && sameOptional(stored.question_policy_type, incoming.questionPolicyType)
    && sameOptional(stored.target_slot_or_issue, incoming.targetSlotOrIssue)
    && sameOptional(stored.target_facet_id, incoming.targetFacetId);
}

function insertModelAudit(db, audit) {
  db.prepare(
    `INSERT OR REPLACE INTO model_audit_log
      (call_id, session_id, turn_no, task, mode, provider, model, prompt_version,
       input_hash, output_hash, latency_ms, status, error, output_json, telemetry_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    audit.callId,
    audit.sessionId,
    audit.turnNo,
    audit.task,
    audit.mode,
    audit.provider,
    audit.model,
    audit.promptVersion,
    audit.inputHash,
    audit.outputHash,
    audit.latencyMs,
    audit.status,
    audit.error,
    json(audit.output),
    json({
      contextTelemetry: audit.contextTelemetry ?? null,
      providerUsage: audit.usage ?? null,
    }),
    audit.createdAt,
  );
}

function summarizeForQueue(snapshot) {
  return {
    sessionId: snapshot.session.sessionId,
    status: snapshot.session.status,
    profile: snapshot.session.profile,
    chiefComplaint: snapshot.session.chiefComplaint,
    mappedComplaints: snapshot.session.mappedComplaints,
    progress: snapshot.session.progress,
    riskCount: snapshot.riskSignals.filter((signal) => signal.status === 'open').length,
    turnCount: snapshot.turns.length,
    updatedAt: snapshot.session.updatedAt,
  };
}

function attachModelAudits(decisionLogs, audits) {
  const byTurn = new Map();
  for (const audit of audits) {
    const list = byTurn.get(audit.turnNo) ?? [];
    list.push(audit);
    byTurn.set(audit.turnNo, list);
  }
  return decisionLogs.map((log) => ({
    ...log,
    modelAudits: byTurn.get(log.turnNo) ?? [],
  }));
}

function randomSessionId() {
  return `PV-${randomUUID().slice(0, 8).toUpperCase()}`;
}

function json(value) {
  return JSON.stringify(value ?? null);
}

function parse(value, fallback) {
  if (value == null || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
