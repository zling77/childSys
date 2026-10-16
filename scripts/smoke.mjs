import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.mjs';
import { handleTurn } from '../core/orchestrator.mjs';

const dir = mkdtempSync(join(tmpdir(), 'previsit-smoke-'));
process.env.PREVISIT_DB_PATH = join(dir, 'smoke.db');

const store = createStore(process.env.PREVISIT_DB_PATH);
const session = store.createSession({
  profile: { age: 9, sex: 'M', grade: '小学三年级', respondent: 'mother' },
  selectedComplaints: [],
  chiefComplaint: '孩子最近不想上学，一到校门口就哭，说肚子疼，回家看电视就好一点',
});

const first = handleTurn(store.getSnapshot(session.sessionId), {
  speakerRole: 'guardian',
  answerText: session.chiefComplaint,
  currentQuestion: null,
});
store.applyTurnResult(first);

const second = handleTurn(store.getSnapshot(session.sessionId), {
  speakerRole: 'guardian',
  answerText: '最近两周缺课四天，还有两次到校门口又回来了',
  currentQuestion: first.nextQuestion,
});
store.applyTurnResult(second);

const packet = store.generatePacket(session.sessionId);
if (!packet.content.summary.includes('上学')) {
  throw new Error('Expected school-refusal summary in packet');
}
if (store.getSnapshot(session.sessionId).evidenceUnits.length < 2) {
  throw new Error('Expected evidence units');
}

store.close();
rmSync(dir, { recursive: true, force: true });
console.log('smoke ok');
