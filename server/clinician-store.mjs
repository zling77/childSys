import { createHash, randomUUID } from 'node:crypto';
import { buildEvidenceState, normalizeEvidenceUnits, materialEvidenceUnits, packetFromEvidenceState, comparePacketVersions, SOURCE_ROLES, EVIDENCE_MODEL_VERSION, isValidIsoDay } from '../core/evidenceGraph.mjs';
import { getFacetContract } from '../core/intakeContracts.mjs';

const encode = (value) => JSON.stringify(value);
const decode = (value, fallback = null) => value ? JSON.parse(value) : fallback;
const digest = (value) => createHash('sha256').update(encode(value)).digest('hex');
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const string = (value, max = 200) => String(value ?? '').trim().slice(0, max);

function installSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS clinical_case (
      case_id TEXT PRIMARY KEY, title TEXT NOT NULL, profile_json TEXT NOT NULL,
      evidence_revision INTEGER NOT NULL DEFAULT 0, fingerprint TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS case_session (
      session_id TEXT PRIMARY KEY REFERENCES interview_session(session_id) ON DELETE CASCADE,
      case_id TEXT NOT NULL REFERENCES clinical_case(case_id) ON DELETE CASCADE,
      linked_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS case_material (
      material_id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES clinical_case(case_id) ON DELETE CASCADE,
      material_json TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS case_evidence (
      case_id TEXT NOT NULL REFERENCES clinical_case(case_id) ON DELETE CASCADE,
      evidence_id TEXT NOT NULL, evidence_json TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(case_id, evidence_id)
    );
    CREATE TABLE IF NOT EXISTS case_relation (
      case_id TEXT NOT NULL REFERENCES clinical_case(case_id) ON DELETE CASCADE,
      relation_id TEXT NOT NULL, prior_evidence_id TEXT NOT NULL, new_evidence_id TEXT NOT NULL,
      relation_json TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(case_id, relation_id),
      FOREIGN KEY(case_id, prior_evidence_id) REFERENCES case_evidence(case_id, evidence_id),
      FOREIGN KEY(case_id, new_evidence_id) REFERENCES case_evidence(case_id, evidence_id)
    );
    CREATE TABLE IF NOT EXISTS case_state_event (
      event_id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES clinical_case(case_id) ON DELETE CASCADE,
      evidence_revision INTEGER NOT NULL, event_type TEXT NOT NULL, detail_json TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS clinician_review (
      review_id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES clinical_case(case_id) ON DELETE CASCADE,
      target_kind TEXT NOT NULL, target_id TEXT NOT NULL, status TEXT NOT NULL,
      note TEXT NOT NULL, author TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS case_packet (
      packet_id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES clinical_case(case_id) ON DELETE CASCADE,
      version INTEGER NOT NULL, evidence_revision INTEGER NOT NULL, content_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE(case_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_case_session_case ON case_session(case_id);
    CREATE INDEX IF NOT EXISTS idx_case_event_case ON case_state_event(case_id, evidence_revision);
  `);
}

export function createClinicianRepository(db, store) {
  installSchema(db);
  const rowForCase = (caseId) => {
    const row = db.prepare('SELECT * FROM clinical_case WHERE case_id = ?').get(caseId);
    if (!row) throw fail('病例不存在。', 404);
    return row;
  };
  const publicCase = (row) => ({ caseId: row.case_id, title: row.title, profile: decode(row.profile_json, {}), evidenceRevision: row.evidence_revision, createdAt: row.created_at, updatedAt: row.updated_at });
  const caseForSession = (sessionId) => db.prepare('SELECT case_id FROM case_session WHERE session_id = ?').get(sessionId)?.case_id ?? null;
  const sessionRows = (caseId) => db.prepare('SELECT session_id FROM case_session WHERE case_id = ? ORDER BY linked_at, session_id').all(caseId).map(({ session_id }) => ({ sessionId: session_id, snapshot: store.getSnapshot(session_id) }));
  const materials = (caseId) => db.prepare('SELECT material_json FROM case_material WHERE case_id = ? ORDER BY created_at, material_id').all(caseId).map((row) => decode(row.material_json));
  const reviews = (caseId) => db.prepare('SELECT * FROM clinician_review WHERE case_id = ? ORDER BY created_at, review_id').all(caseId).map((row) => ({ reviewId: row.review_id, caseId: row.case_id, targetKind: row.target_kind, targetId: row.target_id, status: row.status, note: row.note, author: row.author, createdAt: row.created_at }));
  const packet = (row) => row ? { packetId: row.packet_id, caseId: row.case_id, version: row.version, evidenceRevision: row.evidence_revision, content: decode(row.content_json), status: 'machine_draft', createdAt: row.created_at } : null;
  function event(caseId, revision, type, detail) {
    db.prepare('INSERT INTO case_state_event VALUES (?, ?, ?, ?, ?, ?)').run(`CSE-${randomUUID()}`, caseId, revision, type, encode(detail), Date.now());
  }

  const repository = {
    clinicalCaseForSession: caseForSession,
    getClinicalCase(caseId) { return publicCase(rowForCase(caseId)); },
    createClinicalCase({ title = '新建就诊病例', profile = {} } = {}) {
      const caseId = `CASE-${randomUUID().slice(0, 8).toUpperCase()}`;
      const now = Date.now();
      db.prepare('INSERT INTO clinical_case (case_id,title,profile_json,created_at,updated_at) VALUES (?,?,?,?,?)').run(caseId, string(title) || '新建就诊病例', encode(profile), now, now);
      return this.getClinicalCase(caseId);
    },
    registerClinicalSession(sessionId, requestedCaseId = null) {
      const snapshot = store.getSnapshot(sessionId);
      const target = requestedCaseId ? this.getClinicalCase(requestedCaseId) : this.createClinicalCase({ title: snapshot.session.chiefComplaint?.slice(0, 42) || '预问诊病例', profile: snapshot.session.profile });
      return this.attachClinicalSession(target.caseId, sessionId);
    },
    attachClinicalSession(caseId, sessionId) {
      const target = this.getClinicalCase(caseId);
      if (!db.prepare('SELECT session_id FROM interview_session WHERE session_id=?').get(sessionId ?? '')) throw fail('会话不存在。', 404);
      const snapshot = store.getSnapshot(sessionId);
      const priorCaseId = caseForSession(sessionId);
      if (priorCaseId === caseId) return { caseId, sessionId, unchanged: true };
      const tx = db.transaction(() => {
        db.prepare('INSERT INTO case_session VALUES (?,?,?) ON CONFLICT(session_id) DO UPDATE SET case_id=excluded.case_id,linked_at=excluded.linked_at').run(sessionId, caseId, Date.now());
        if (!Object.keys(target.profile ?? {}).length) db.prepare('UPDATE clinical_case SET profile_json = ? WHERE case_id = ?').run(encode(snapshot.session.profile), caseId);
        event(caseId, target.evidenceRevision + 1, 'session_linked', { sessionId, priorCaseId, note: '医生或提交者明确指定关联；未进行人口学自动匹配。' });
        if (priorCaseId) event(priorCaseId, rowForCase(priorCaseId).evidence_revision + 1, 'session_relinked', { sessionId, newCaseId: caseId });
      });
      tx();
      this.refreshClinicalCase(caseId);
      if (priorCaseId) this.refreshClinicalCase(priorCaseId);
      return { caseId, sessionId, priorCaseId, unchanged: false };
    },
    detachClinicalSession(caseId, sessionId) {
      if (caseForSession(sessionId) !== caseId) throw fail('此会话不属于当前病例。');
      const snapshot = store.getSnapshot(sessionId);
      const target = this.createClinicalCase({ title: snapshot.session.chiefComplaint?.slice(0, 42) || '独立会话病例', profile: snapshot.session.profile });
      return this.attachClinicalSession(target.caseId, sessionId);
    },
    refreshClinicalCase(caseId) {
      const oldCase = rowForCase(caseId);
      const sessions = sessionRows(caseId);
      const materialRows = materials(caseId);
      const units = sessions.flatMap(({ snapshot }) => normalizeEvidenceUnits(snapshot, caseId));
      for (const material of materialRows) units.push(...normalizeEvidenceUnits({ evidenceUnits: materialEvidenceUnits(material) }, caseId));
      const state = buildEvidenceState(caseId, units);
      const reviewRows = reviews(caseId);
      const fingerprint = digest({ state, members: sessions.map((s) => s.sessionId), materials: materialRows, reviews: reviewRows });
      if (fingerprint !== oldCase.fingerprint) {
        const revision = oldCase.evidence_revision + 1;
        const tx = db.transaction(() => {
          const previousUnits = new Set(db.prepare('SELECT evidence_id FROM case_evidence WHERE case_id = ? AND active = 1').all(caseId).map((r) => r.evidence_id));
          const previousRelations = new Set(db.prepare('SELECT relation_id FROM case_relation WHERE case_id = ? AND active = 1').all(caseId).map((r) => r.relation_id));
          db.prepare('UPDATE case_evidence SET active = 0 WHERE case_id = ?').run(caseId);
          db.prepare('UPDATE case_relation SET active = 0 WHERE case_id = ?').run(caseId);
          for (const unit of state.evidenceUnits) {
            db.prepare('INSERT INTO case_evidence VALUES (?,?,?,1) ON CONFLICT(case_id,evidence_id) DO UPDATE SET evidence_json=excluded.evidence_json,active=1').run(caseId, unit.evidenceId, encode(unit));
            if (!previousUnits.has(unit.evidenceId)) event(caseId, revision, 'evidence_added', { evidenceId: unit.evidenceId, sourceRole: unit.sourceRole, traceRef: unit.traceRef });
          }
          for (const relation of state.evidenceRelations) {
            db.prepare('INSERT INTO case_relation VALUES (?,?,?,?,?,1) ON CONFLICT(case_id,relation_id) DO UPDATE SET relation_json=excluded.relation_json,active=1').run(caseId, relation.relationId, relation.priorEvidenceId, relation.newEvidenceId, encode(relation));
            if (!previousRelations.has(relation.relationId)) event(caseId, revision, relation.semanticRelation === 'corrects' ? 'correction_registered' : relation.semanticRelation === 'contradicts' ? 'conflict_detected' : 'relation_added', relation);
          }
          const currentIds = new Set(state.evidenceUnits.map((e) => e.evidenceId));
          for (const oldId of previousUnits) if (!currentIds.has(oldId)) event(caseId, revision, 'membership_evidence_archived', { evidenceId: oldId, note: '会话关联发生变化；原始证据及历史版本保留。' });
          db.prepare('UPDATE clinical_case SET evidence_revision=?,fingerprint=?,updated_at=? WHERE case_id=?').run(revision, fingerprint, Date.now(), caseId);
          event(caseId, revision, 'state_updated', { schemaVersion: EVIDENCE_MODEL_VERSION, evidenceCount: state.evidenceUnits.length, relationCount: state.evidenceRelations.length });
        });
        tx();
      }
      return { clinicalCase: this.getClinicalCase(caseId), sessions, materials: materialRows, evidenceState: state, reviews: reviewRows };
    },
    listClinicalCases({ status = 'all' } = {}) {
      const ids = db.prepare('SELECT case_id FROM clinical_case ORDER BY updated_at DESC').all().map((r) => r.case_id);
      const rows = ids.map((caseId) => {
        const bundle = this.refreshClinicalCase(caseId);
        const latest = this.getClinicalPacket(caseId);
        return { ...bundle.clinicalCase, sessionCount: bundle.sessions.length, materialCount: bundle.materials.length, evidenceCount: bundle.evidenceState.evidenceUnits.length,
          riskCount: new Set(bundle.evidenceState.evidenceUnits.filter((e) => e.riskFlag).map((e) => `${e.sessionId ?? e.materialId}:${e.inputRound}:${e.traceText}`)).size,
          conflictCount: bundle.evidenceState.topicStates.filter((t) => t.status === 'disputed').length,
          reviewCount: bundle.reviews.length, packetVersion: latest?.version ?? null, packetRevision: latest?.evidenceRevision ?? null,
          status: bundle.evidenceState.evidenceUnits.some((e) => e.riskFlag) ? 'needs_clinician_review' : bundle.sessions.some((s) => ['draft', 'in_progress'].includes(s.snapshot.session.status)) ? 'in_progress' : 'completed',
        };
      }).filter((row) => row.sessionCount || row.materialCount).sort((a, b) => b.updatedAt - a.updatedAt);
      return status === 'all' ? rows : rows.filter((row) => row.status === status);
    },
    listClinicalSessions() {
      return db.prepare('SELECT session_id FROM interview_session ORDER BY updated_at DESC').all().map(({ session_id }) => {
        const session = store.getSnapshot(session_id).session;
        return { sessionId: session_id, caseId: caseForSession(session_id), profile: session.profile, chiefComplaint: session.chiefComplaint, status: session.status };
      });
    },
    getClinicalBundle(caseId) {
      const bundle = this.refreshClinicalCase(caseId);
      const sessionSummaries = bundle.sessions.map(({ sessionId, snapshot }) => ({ sessionId, profile: snapshot.session.profile, chiefComplaint: snapshot.session.chiefComplaint, status: snapshot.session.status, progress: snapshot.session.progress, turns: snapshot.turns, slotStates: snapshot.slotStates, mediaRecords: snapshot.mediaRecords }));
      const currentContent = packetFromEvidenceState(bundle.evidenceState, { clinicalCase: bundle.clinicalCase, sessions: bundle.sessions, reviews: bundle.reviews, version: bundle.clinicalCase.evidenceRevision });
      return { ...bundle, currentContent, sessions: sessionSummaries, packet: this.getClinicalPacket(caseId), packetHistory: this.listClinicalPackets(caseId), events: this.listClinicalEvents(caseId) };
    },
    getClinicalPacket(caseId, version = null) {
      rowForCase(caseId);
      return packet(version == null ? db.prepare('SELECT * FROM case_packet WHERE case_id = ? ORDER BY version DESC LIMIT 1').get(caseId) : db.prepare('SELECT * FROM case_packet WHERE case_id=? AND version=?').get(caseId, version));
    },
    listClinicalPackets(caseId) {
      return db.prepare('SELECT packet_id,version,evidence_revision,created_at FROM case_packet WHERE case_id=? ORDER BY version DESC').all(caseId).map((r) => ({ packetId: r.packet_id, version: r.version, evidenceRevision: r.evidence_revision, createdAt: r.created_at }));
    },
    generateClinicalPacket(caseId) {
      const bundle = this.refreshClinicalCase(caseId);
      const content = packetFromEvidenceState(bundle.evidenceState, { clinicalCase: bundle.clinicalCase, sessions: bundle.sessions, reviews: bundle.reviews, version: bundle.clinicalCase.evidenceRevision });
      const latest = this.getClinicalPacket(caseId);
      if (latest && digest(latest.content) === digest(content)) return { packet: latest, changed: false };
      const version = (latest?.version ?? 0) + 1;
      db.prepare('INSERT INTO case_packet VALUES (?,?,?,?,?,?)').run(`CPKT-${randomUUID()}`, caseId, version, bundle.clinicalCase.evidenceRevision, encode(content), Date.now());
      event(caseId, bundle.clinicalCase.evidenceRevision, 'packet_generated', { version, previousVersion: latest?.version ?? null });
      return { packet: this.getClinicalPacket(caseId), changed: true };
    },
    compareClinicalPackets(caseId, from, to) {
      const previous = this.getClinicalPacket(caseId, from);
      const next = this.getClinicalPacket(caseId, to);
      if (!previous || !next) throw fail('比较版本不存在。', 404);
      return { from, to, changes: comparePacketVersions(previous.content, next.content), previous, next };
    },
    addClinicalMaterial(caseId, input) {
      const bundle = this.refreshClinicalCase(caseId);
      const sourceRole = string(input.sourceRole);
      const text = string(input.text, 10000);
      if (!SOURCE_ROLES.includes(sourceRole) || !text) throw fail('请选择有效来源并填写原文。');
      if (String(input.text ?? '').length > 10000) throw fail('单份材料原文不能超过10000字。');
      if (input.slotId || input.facetId) if (!getFacetContract(input.slotId, input.facetId)) throw fail('采集主题或字段不合法。');
      if (input.sourceMode && !['direct', 'reported'].includes(input.sourceMode)) throw fail('来源方式不合法。');
      if (input.reportedSourceRole && !SOURCE_ROLES.includes(input.reportedSourceRole)) throw fail('转述来源不合法。');
      if (input.observedTime && (!Number.isFinite(Date.parse(input.observedTime)) || (/^\d{4}-\d{2}-\d{2}$/.test(input.observedTime) && !isValidIsoDay(input.observedTime)))) throw fail('材料形成时间不合法。');
      if (input.observationContext && !['home', 'school', 'clinic', 'online', 'unknown'].includes(input.observationContext)) throw fail('观察场景不合法。');
      const explicit = input.referencedTimeSpan;
      if (explicit && (!isValidIsoDay(explicit.start) || !isValidIsoDay(explicit.end) || explicit.start > explicit.end)) throw fail('指向时间范围须为有效且有序的起止日期。');
      if (input.correctsEvidenceId) {
        if (sourceRole !== 'clinician') throw fail('指定证据纠正仅供医生补充记录使用。');
        const target = bundle.evidenceState.evidenceUnits.find((e) => e.evidenceId === input.correctsEvidenceId);
        if (!target) throw fail('纠正目标不属于当前病例。');
        if (target.slotId !== input.slotId || target.facetId !== input.facetId) throw fail('纠正记录须指定与目标相同的主题和字段。');
      }
      const material = { materialId: `MAT-${randomUUID()}`, caseId, sourceRole, sourceLabel: string(input.sourceLabel), sourceMode: input.sourceMode ?? 'direct', reportedSourceRole: input.reportedSourceRole ?? null,
        sourceIdentity: `material:${randomUUID()}`, text, observedTime: input.observedTime || null, referencedTimeSpan: explicit ?? null, observationContext: input.observationContext ?? 'unknown',
        slotId: input.slotId ?? null, facetId: input.facetId ?? null, correctsEvidenceId: input.correctsEvidenceId ?? null, createdAt: Date.now() };
      const extracted = normalizeEvidenceUnits({ evidenceUnits: materialEvidenceUnits(material) }, caseId);
      if (!extracted.length) throw fail('规则暂未识别出可追溯字段。请指定材料涉及的主题与字段后重试；系统不会凭空补全。', 422);
      if (material.correctsEvidenceId) {
        const target = bundle.evidenceState.evidenceUnits.find((e) => e.evidenceId === material.correctsEvidenceId);
        const relationState = buildEvidenceState(caseId, [...bundle.evidenceState.evidenceUnits, ...extracted]);
        if (!relationState.revisionChains.some((r) => r.priorEvidenceId === target.evidenceId && extracted.some((e) => e.evidenceId === r.newEvidenceId))) throw fail('此记录的时间、场景或命题与目标不一致，未作为纠正保存；请改为普通补充或核实范围。', 422);
      }
      db.prepare('INSERT INTO case_material VALUES (?,?,?,?)').run(material.materialId, caseId, encode(material), material.createdAt);
      event(caseId, bundle.clinicalCase.evidenceRevision + 1, 'material_added', { materialId: material.materialId, sourceRole });
      this.refreshClinicalCase(caseId);
      return material;
    },
    recordClinicalReview(caseId, input) {
      const bundle = this.refreshClinicalCase(caseId);
      const kind = input.targetKind;
      const targetId = string(input.targetId);
      if (!['evidence', 'risk', 'issue', 'relation'].includes(kind) || !['seen', 'needs_followup', 'reviewed'].includes(input.status)) throw fail('核实对象或状态不合法。');
      const valid = kind === 'relation' ? bundle.evidenceState.evidenceRelations.some((r) => r.relationId === targetId)
        : kind === 'issue' ? bundle.evidenceState.topicStates.some((t) => t.facets.some((f) => `${t.topicId}:${f.facetId}` === targetId))
        : bundle.evidenceState.evidenceUnits.some((e) => e.evidenceId === targetId && (kind !== 'risk' || e.riskFlag));
      if (!valid) throw fail('核实对象不属于当前病例。');
      const note = string(input.note, 3000);
      if (input.status === 'reviewed' && !note) throw fail('记录核实结果时请填写依据或备注。');
      const review = { reviewId: `REV-${randomUUID()}`, caseId, targetKind: kind, targetId, status: input.status, note, author: string(input.author, 80) || '本地演示医生', createdAt: Date.now() };
      db.prepare('INSERT INTO clinician_review VALUES (?,?,?,?,?,?,?,?)').run(review.reviewId, caseId, kind, targetId, review.status, note, review.author, review.createdAt);
      event(caseId, bundle.clinicalCase.evidenceRevision + 1, 'review_recorded', review);
      this.refreshClinicalCase(caseId);
      return review;
    },
    listClinicalEvents(caseId) {
      return db.prepare('SELECT * FROM case_state_event WHERE case_id=? ORDER BY created_at,event_id').all(caseId).map((r) => ({ eventId: r.event_id, evidenceRevision: r.evidence_revision, eventType: r.event_type, detail: decode(r.detail_json), createdAt: r.created_at }));
    },
    backfillClinicalCases() {
      for (const { session_id } of db.prepare('SELECT session_id FROM interview_session WHERE session_id NOT IN (SELECT session_id FROM case_session)').all()) this.registerClinicalSession(session_id);
    },
  };
  return repository;
}
