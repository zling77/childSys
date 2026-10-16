import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.mjs';
import { handleTurn } from '../core/orchestrator.mjs';
import { createLlmRuntimeFromEnv, runShadowExtract } from '../core/llm/provider.mjs';

const dir = mkdtempSync(join(tmpdir(), 'previsit-llm-shadow-'));
const store = createStore(join(dir, 'shadow.db'));
const runtime = createLlmRuntimeFromEnv({
  PREVISIT_LLM_MODE: 'shadow',
  PREVISIT_LLM_PROVIDER: 'mock',
});

const session = store.createSession({
  profile: { age: 9, sex: 'M', grade: '小学三年级', respondent: 'mother' },
  selectedComplaints: [],
  chiefComplaint: '孩子最近不想上学，一到校门口就哭，说肚子疼，回家看电视就好一点',
});

const result = handleTurn(store.getSnapshot(session.sessionId), {
  speakerRole: 'guardian',
  answerText: session.chiefComplaint,
  currentQuestion: null,
});
result.modelAudits = [
  await runShadowExtract(runtime, {
    sessionId: result.sessionId,
    turnNo: result.dialogueTurn.turnNo,
    speakerRole: result.dialogueTurn.speakerRole,
    answerText: result.dialogueTurn.answerText,
    complaintIds: result.mappedComplaints,
    gaps: result.decisionLog.stateSummary.gaps,
  }),
];

const snapshot = store.applyTurnResult(result);
const audit = snapshot.decisionLogs[0]?.modelAudits?.[0];
if (!audit || audit.status !== 'success') {
  throw new Error(`Expected successful mock LLM audit, got ${audit?.status ?? 'missing'}`);
}
if (!audit.output?.slots?.some((slot) => slot.slot_id === 'somatic_symptoms')) {
  throw new Error('Expected LLM shadow slots in decision log');
}

store.close();
rmSync(dir, { recursive: true, force: true });
console.log('llm shadow smoke ok');
