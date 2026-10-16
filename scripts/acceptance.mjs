import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.mjs';
import { demoCases, seedDemoCases } from '../server/demo-cases.mjs';

const dir = mkdtempSync(join(tmpdir(), 'previsit-acceptance-'));
process.env.PREVISIT_DB_PATH = join(dir, 'acceptance.db');

const store = createStore(process.env.PREVISIT_DB_PATH);
const created = seedDemoCases(store);

if (created.length !== demoCases.length) {
  throw new Error(`Expected ${demoCases.length} seeded cases, got ${created.length}`);
}

const queue = store.listQueue();
if (queue.length !== demoCases.length) {
  throw new Error(`Expected ${demoCases.length} queue rows, got ${queue.length}`);
}

const riskRows = queue.filter((row) => row.status === 'needs_clinician_review');
if (riskRows.length < 2) {
  throw new Error('Expected at least two risk-review demo sessions');
}

for (const row of queue) {
  const snapshot = store.getSnapshot(row.sessionId);
  if (snapshot.packets.length === 0) {
    throw new Error(`Expected packet for ${row.sessionId}`);
  }
  if (snapshot.evidenceUnits.length < 3) {
    throw new Error(`Expected evidence units for ${row.sessionId}`);
  }
  if (snapshot.decisionLogs.length < 3) {
    throw new Error(`Expected decision logs for ${row.sessionId}`);
  }
}

store.close();
rmSync(dir, { recursive: true, force: true });
console.log(`acceptance ok: ${created.length} demo cases`);

