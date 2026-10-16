import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createStore } from '../server/store.mjs';

const testRoot = mkdtempSync(join(tmpdir(), 'previsit-persistence-v2-'));
const dbPath = join(testRoot, 'previsit.db');
const sessionId = 'PV-V1-SNAPSHOT';
let store;

try {
  const legacyDb = new Database(dbPath);
  legacyDb.prepare(
    `CREATE TABLE interview_session (
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
  ).run();
  legacyDb.prepare(
    `INSERT INTO interview_session
      (session_id, status, profile_json, selected_complaints_json, mapped_complaints_json,
       chief_complaint, progress_json, started_at, completed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    'in_progress',
    JSON.stringify({ age: 10, respondent: 'guardian' }),
    JSON.stringify(['school_refusal']),
    JSON.stringify(['school_refusal']),
    '最近两周不愿意去学校',
    JSON.stringify({ requiredFilled: 2, requiredTotal: 14, percent: 14 }),
    1_700_000_000_000,
    null,
    1_700_000_000_100,
  );
  const legacySessionRow = legacyDb.prepare(`SELECT * FROM interview_session WHERE session_id = ?`).get(sessionId);
  legacyDb.close();

  store = createStore(dbPath);
  const requiredTables = [
    'schema_migration',
    'evidence_claim',
    'evidence_claim_event',
    'facet_state_v2',
    'interview_state_event',
  ];
  const tableNames = new Set(
    store.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((row) => row.name),
  );
  for (const table of requiredTables) assert.equal(tableNames.has(table), true, `${table} must exist`);

  const firstMigrationRows = store.db.prepare(`SELECT * FROM schema_migration ORDER BY version`).all();
  assert.equal(firstMigrationRows.length, 5);
  assert.equal(firstMigrationRows[0].version, 2);
  assert.equal(firstMigrationRows[0].name, 'v2_evidence_persistence_skeleton');
  assert.equal(firstMigrationRows[1].version, 3);
  assert.equal(firstMigrationRows[1].name, 'v3_model_audit_telemetry');
  assert.equal(firstMigrationRows[2].version, 4);
  assert.equal(firstMigrationRows[2].name, 'v4_dialogue_turn_target_facet');
  assert.equal(firstMigrationRows[3].version, 5);
  assert.equal(firstMigrationRows[3].name, 'v5_decision_log_target_facet');
  assert.equal(firstMigrationRows[4].version, 6);
  assert.equal(firstMigrationRows[4].name, 'v6_question_recording_timeline');
  assert.equal(
    store.db.prepare(`PRAGMA table_info(model_audit_log)`).all().some((column) => column.name === 'telemetry_json'),
    true,
    'v3 migration must add model audit telemetry storage',
  );
  assert.equal(
    store.db.prepare(`PRAGMA table_info(dialogue_turn)`).all().some((column) => column.name === 'target_facet_id'),
    true,
    'v4 migration must persist the exact dialogue target facet',
  );
  assert.equal(
    store.db.prepare(`PRAGMA table_info(next_question_decision_log)`).all()
      .some((column) => column.name === 'target_facet_id'),
    true,
    'v5 migration must persist the exact decision target facet',
  );
  assert.equal(
    store.db.prepare(`PRAGMA foreign_key_list(evidence_claim)`).all()
      .some((foreignKey) => foreignKey.table === 'dialogue_turn'),
    true,
    'evidence claims must remain tied to a persisted dialogue turn',
  );
  assert.equal(
    store.db.prepare(`PRAGMA foreign_key_list(evidence_claim_event)`).all()
      .some((foreignKey) => foreignKey.table === 'evidence_claim'),
    true,
    'claim events must remain tied to a persisted claim',
  );
  assert.deepEqual(
    store.db.prepare(`SELECT * FROM interview_session WHERE session_id = ?`).get(sessionId),
    legacySessionRow,
    'migration must preserve the complete v1 interview_session row',
  );

  let snapshotBeforeV2Rows = store.getSnapshot(sessionId);
  assert.deepEqual(snapshotBeforeV2Rows.session, {
    sessionId,
    status: 'in_progress',
    profile: { age: 10, respondent: 'guardian' },
    selectedComplaints: ['school_refusal'],
    mappedComplaints: ['school_refusal'],
    chiefComplaint: '最近两周不愿意去学校',
    progress: { requiredFilled: 2, requiredTotal: 14, percent: 14 },
    startedAt: 1_700_000_000_000,
    completedAt: null,
    updatedAt: 1_700_000_000_100,
  });

  store.db.prepare(
    `INSERT INTO dialogue_turn
      (session_id, turn_no, speaker_role, question_text, answer_text,
       question_policy_type, target_slot_or_issue, target_facet_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId, 1, 'guardian', '最近一周大约出现几次？', '每天都会发生',
    'adaptive_coverage', 'frequency_severity', 'frequency', 1_700_000_000_150,
  );
  snapshotBeforeV2Rows = store.getSnapshot(sessionId);

  const insertV2Rows = store.db.transaction(() => {
    store.db.prepare(
      `INSERT INTO evidence_claim
        (claim_id, session_id, turn_no, source, speaker_role, domain, slot_id, facet_id,
         normalized_value_json, polarity, time_scope, quote_text, quote_start, quote_end,
         extractor, extractor_version, model, prompt_version, schema_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'CLM-1', sessionId, 1, 'guardian_report', 'guardian', 'intake_coverage',
      'frequency_severity', 'frequency', JSON.stringify({ canonical: 'daily' }), 'positive',
      'current', '每天都会发生', 0, 6, 'rule', 'rule-v1', null, null, 'facet-v2',
      1_700_000_000_200,
    );
    store.db.prepare(
      `INSERT INTO evidence_claim_event
        (claim_event_id, claim_id, session_id, event_type, reason_code,
         supersedes_claim_id, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'CLME-1', 'CLM-1', sessionId, 'accepted', 'exact_quote_and_rule_normalization',
      null, JSON.stringify({ validatorVersion: 'validator-v1' }), 1_700_000_000_201,
    );
    store.db.prepare(
      `INSERT INTO facet_state_v2
        (session_id, complaint_id, slot_id, facet_id, label, status, value_json,
         evidence_claim_ids_json, conflict_reason, attempts, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sessionId, 'intake_coverage', 'frequency_severity', 'frequency', '出现频率', 'filled',
      JSON.stringify({ canonical: 'daily' }), JSON.stringify(['CLM-1']), null, 1,
      1_700_000_000_202,
    );
    store.db.prepare(
      `INSERT INTO interview_state_event
        (event_id, session_id, turn_no, complaint_id, slot_id, facet_id,
         event_type, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'ISE-1', sessionId, 1, 'intake_coverage', 'frequency_severity', 'frequency',
      'evidence_progress', JSON.stringify({ missingBefore: ['frequency'], missingAfter: [] }),
      1_700_000_000_203,
    );
  });
  insertV2Rows();

  const claim = store.db.prepare(`SELECT * FROM evidence_claim WHERE claim_id = ?`).get('CLM-1');
  assert.equal(claim.quote_text, '每天都会发生');
  assert.deepEqual(JSON.parse(claim.normalized_value_json), { canonical: 'daily' });
  const claimEvent = store.db.prepare(`SELECT * FROM evidence_claim_event WHERE claim_event_id = ?`).get('CLME-1');
  assert.equal(claimEvent.event_type, 'accepted');
  const facetState = store.db.prepare(
    `SELECT * FROM facet_state_v2 WHERE session_id = ? AND complaint_id = ? AND slot_id = ? AND facet_id = ?`,
  ).get(sessionId, 'intake_coverage', 'frequency_severity', 'frequency');
  assert.equal(facetState.status, 'filled');
  assert.deepEqual(JSON.parse(facetState.evidence_claim_ids_json), ['CLM-1']);
  const interviewEvent = store.db.prepare(`SELECT * FROM interview_state_event WHERE event_id = ?`).get('ISE-1');
  assert.deepEqual(JSON.parse(interviewEvent.detail_json), { missingBefore: ['frequency'], missingAfter: [] });
  assert.throws(
    () => store.db.prepare(
      `INSERT INTO evidence_claim
        (claim_id, session_id, turn_no, source, speaker_role, domain, slot_id, facet_id,
         quote_text, quote_start, quote_end, extractor, extractor_version, schema_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'CLM-BAD-TURN', sessionId, 999, 'guardian_report', 'guardian', 'intake_coverage',
      'frequency_severity', 'frequency', '不存在的轮次', 0, 6, 'rule', 'rule-v1', 'facet-v2',
      1_700_000_000_204,
    ),
    /FOREIGN KEY constraint failed/,
    'claim must reference an existing dialogue turn',
  );
  assert.throws(
    () => store.db.prepare(
      `INSERT INTO evidence_claim_event
        (claim_event_id, claim_id, session_id, event_type, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('CLME-BAD-SESSION', 'CLM-1', 'OTHER-SESSION', 'accepted', 1_700_000_000_205),
    /FOREIGN KEY constraint failed/,
    'claim events cannot point to a claim in another session',
  );
  assert.deepEqual(
    store.getSnapshot(sessionId),
    snapshotBeforeV2Rows,
    'v2 skeleton rows must not change existing snapshot reads',
  );

  store.applyTurnResult({
    sessionId,
    status: 'in_progress',
    mappedComplaints: ['school_refusal'],
    progress: { requiredFilled: 2, requiredTotal: 14, percent: 14 },
    nextAction: 'ask',
    dialogueTurn: {
      sessionId,
      turnNo: 1,
      speakerRole: 'guardian',
      questionText: '最近一周大约出现几次？',
      answerText: '每天都会发生',
      questionPolicyType: 'adaptive_coverage',
      targetSlotOrIssue: 'frequency_severity',
      targetFacetId: 'frequency',
      createdAt: 1_700_000_000_160,
    },
    evidenceUnits: [],
    riskSignals: [],
    slotStates: [],
    decisionLog: {
      decisionId: 'DEC-REPLAY',
      sessionId,
      turnNo: 1,
      policyType: 'adaptive_coverage',
      stateSummary: {},
      candidateQuestions: [],
      rejectedCandidates: [],
      selectedAction: { nextAction: 'ask' },
      selectedQuestion: '最近一周大概出现几次？',
      selectionReason: 'same-turn replay smoke',
      boundaryCheckResult: {},
      riskMarker: [],
      targetSlotOrIssue: 'frequency_severity',
      targetFacetId: 'frequency',
      createdAt: 1_700_000_000_161,
    },
  });
  assert.equal(
    store.db.prepare(`SELECT COUNT(*) AS count FROM evidence_claim WHERE claim_id = 'CLM-1'`).get().count,
    1,
    'an identical same-turn replay must be an idempotent no-op that preserves v2 claims',
  );
  assert.equal(store.db.prepare(`SELECT COUNT(*) AS count FROM evidence_claim_event`).get().count, 1);
  assert.equal(store.db.prepare(`SELECT COUNT(*) AS count FROM interview_state_event`).get().count, 1);
  assert.equal(
    store.db.prepare(`SELECT answer_text FROM dialogue_turn WHERE session_id = ? AND turn_no = 1`).get(sessionId).answer_text,
    '每天都会发生',
  );
  assert.equal(
    store.getSnapshot(sessionId).turns[0].targetFacetId,
    'frequency',
    'same-turn replay must persist and reload the fixed target facet',
  );
  assert.throws(
    () => store.applyTurnResult({
      sessionId,
      status: 'in_progress',
      mappedComplaints: ['school_refusal'],
      progress: { requiredFilled: 2, requiredTotal: 14, percent: 14 },
      nextAction: 'ask',
      dialogueTurn: {
        sessionId,
        turnNo: 1,
        speakerRole: 'guardian',
        questionText: '最近一周大约出现几次？',
        answerText: '改成了不同答案',
        questionPolicyType: 'adaptive_coverage',
        targetSlotOrIssue: 'frequency_severity',
        targetFacetId: 'frequency',
        createdAt: 1_700_000_000_170,
      },
      evidenceUnits: [],
      riskSignals: [],
      slotStates: [],
      decisionLog: {
        decisionId: 'DEC-CONFLICT',
        sessionId,
        turnNo: 1,
        policyType: 'adaptive_coverage',
        stateSummary: {},
        candidateQuestions: [],
        rejectedCandidates: [],
        selectedAction: { nextAction: 'ask' },
        selectedQuestion: '',
        selectionReason: '',
        boundaryCheckResult: {},
        riskMarker: [],
        targetSlotOrIssue: 'frequency_severity',
        targetFacetId: 'frequency',
        createdAt: 1_700_000_000_171,
      },
    }),
    (error) => error?.code === 'TURN_CONFLICT' && error?.statusCode === 409,
    'a divergent same-turn write must fail instead of mixing new answers with old evidence',
  );
  assert.equal(
    store.db.prepare(`SELECT answer_text FROM dialogue_turn WHERE session_id = ? AND turn_no = 1`)
      .get(sessionId).answer_text,
    '每天都会发生',
  );

  store.db.prepare(
    `INSERT INTO next_question_decision_log
      (decision_id, session_id, turn_no, policy_type, state_summary_json,
       candidate_questions_json, rejected_candidates_json, selected_action_json,
       selected_question, selection_reason, boundary_check_result_json,
       risk_marker_json, target_slot_or_issue, target_facet_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'DEC-1', sessionId, 1, 'llm_dynamic', JSON.stringify({}), JSON.stringify([]),
    JSON.stringify([]), JSON.stringify({ nextAction: 'ask' }), '最近一周大概出现几次？',
    'telemetry migration smoke', JSON.stringify({}), JSON.stringify([]),
    'frequency_severity', 'frequency', 1_700_000_000_206,
  );
  store.saveModelAudit({
    callId: 'MC-TELEMETRY-1',
    sessionId,
    turnNo: 1,
    task: 'llm_dynamic_next_question',
    mode: 'dynamic',
    provider: 'openai_compatible',
    model: 'test-model',
    promptVersion: 'previsit_dynamic_next_question_v4',
    inputHash: 'input-hash',
    outputHash: 'output-hash',
    latencyMs: 23,
    status: 'success',
    error: null,
    output: { next_action: 'ask', question: '最近一周大概出现几次？' },
    contextTelemetry: { includedClaims: 2, contextChars: 640 },
    usage: { prompt_tokens: 120, completion_tokens: 28, total_tokens: 148 },
    createdAt: 1_700_000_000_207,
  });
  const loadedAudit = store.getSnapshot(sessionId).decisionLogs[0].modelAudits[0];
  assert.equal(store.getSnapshot(sessionId).decisionLogs[0].targetFacetId, 'frequency');
  assert.deepEqual(loadedAudit.contextTelemetry, { includedClaims: 2, contextChars: 640 });
  assert.deepEqual(loadedAudit.usage, { prompt_tokens: 120, completion_tokens: 28, total_tokens: 148 });

  store.close();
  store = undefined;
  store = createStore(dbPath);
  assert.deepEqual(
    store.db.prepare(`SELECT * FROM schema_migration ORDER BY version`).all(),
    firstMigrationRows,
    'running migrations again must not add or rewrite migration rows',
  );
  assert.equal(store.db.prepare(`SELECT COUNT(*) AS count FROM evidence_claim`).get().count, 1);
  assert.equal(store.db.prepare(`SELECT COUNT(*) AS count FROM evidence_claim_event`).get().count, 1);
  assert.equal(store.db.prepare(`SELECT COUNT(*) AS count FROM facet_state_v2`).get().count, 1);
  assert.equal(store.db.prepare(`SELECT COUNT(*) AS count FROM interview_state_event`).get().count, 1);
  assert.equal(store.db.prepare(`SELECT COUNT(*) AS count FROM model_audit_log`).get().count, 1);
  assert.deepEqual(
    store.getSnapshot(sessionId).decisionLogs[0].modelAudits[0].usage,
    { prompt_tokens: 120, completion_tokens: 28, total_tokens: 148 },
    'persisted provider usage must load after reopening the database',
  );

  store.resetDemoData();
  for (const table of ['evidence_claim_event', 'evidence_claim', 'facet_state_v2', 'interview_state_event']) {
    assert.equal(
      store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
      0,
      `demo reset must clear ${table}`,
    );
  }

  console.log('persistence v2/v3/v4/v5/v6 smoke ok');
} finally {
  store?.close();
  rmSync(testRoot, { recursive: true, force: true });
}
