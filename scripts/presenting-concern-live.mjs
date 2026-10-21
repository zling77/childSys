import 'dotenv/config';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

// Full HTTP pipeline with real Qwen calls and a synthetic, isolated database.
const root = mkdtempSync(join(tmpdir(), 'presenting-concern-live-'));
const holder = createServer(); await new Promise(resolve => holder.listen(0, '127.0.0.1', resolve));
const port = holder.address().port; await new Promise(resolve => holder.close(resolve));
const base = `http://127.0.0.1:${port}`;
let logs = '', db;
const server = spawn(process.execPath, ['server/index.mjs'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
  ...process.env, HOST: '127.0.0.1', PORT: String(port), PREVISIT_DB_PATH: join(root, 'synthetic.db'), PREVISIT_MEDIA_ROOT: join(root, 'media'),
  PREVISIT_LLM_MODE: 'dynamic', PREVISIT_STATE_BUILDER_MODE: 'semantic', PREVISIT_CLINICIAN_LLM_MODE: 'off', PREVISIT_OLLAMA_SSH_HOST: '',
} });
server.stdout.on('data', chunk => { logs += chunk; }); server.stderr.on('data', chunk => { logs += chunk; });
const report = { synthetic: true, testedAt: new Date().toISOString(), endpoint: process.env.PREVISIT_LLM_BASE_URL, cases: [], failures: [] };
async function request(path, body) {
  const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(45000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 250)}`);
  return response.json();
}
function record(name, input, data) {
  const audits = db.prepare('SELECT task,model,status,error,latency_ms,output_json FROM model_audit_log WHERE session_id=? AND turn_no=? ORDER BY created_at').all(data.session.sessionId, data.turns.length);
  const row = { name, input, status: data.session.status, question: data.nextQuestion?.text ?? null, target: data.nextQuestion?.targetFacetId ?? null,
    reason: data.decisionLogs.at(-1)?.selectionReason, audits: audits.map(({ output_json, ...a }) => ({ ...a, output: JSON.parse(output_json ?? 'null') })) };
  report.cases.push(row); console.log(JSON.stringify({ name, question: row.question, target: row.target, audits: row.audits.map(({ output, ...a }) => a) }));
}
try {
  let ready = false;
  for (let i = 0; i < 100; i += 1) { try { if ((await fetch(base + '/health')).ok) { ready = true; break; } } catch {} await new Promise(resolve => setTimeout(resolve, 60)); }
  if (!ready) throw new Error(logs.slice(-500));
  db = new Database(join(root, 'synthetic.db'), { readonly: true });
  let first;
  for (const fixture of [
    { name: 'guardian-homework-secondary-sleep', role: 'guardian', age: 10, text: '这次主要想解决孩子写作业拖拉的问题。他总是边写边玩，拖到很晚才上床，已经影响了睡眠。' },
    { name: 'child-8-homework-secondary-sleep', role: 'child', age: 8, text: '我想请医生帮我写作业不要总拖。写一会儿我就玩东西，写得很慢，所以很晚才去睡觉。' },
    { name: 'child-13-homework-secondary-sleep', role: 'child', age: 13, text: '我主要想解决写作业拖拉。总忍不住看手机，作业拖到很晚，睡觉时间也被挤掉了。' },
    { name: 'child-16-homework-known-school-impact', role: 'child', age: 16, text: '我主要想改善作业拖延，写的时候经常刷手机，结果睡得晚，第二天上课已经会困。' },
    { name: 'guardian-independent-sleep-concern', role: 'guardian', age: 10, text: '这次主要想解决孩子睡不着的问题。最近两周即使八点写完作业，九点上床后仍要躺一个多小时才能睡着，第二天上课会困。' },
    { name: 'guardian-homework-repeat', role: 'guardian', age: 10, text: '这次主要想解决孩子写作业拖拉的问题。他总是边写边玩，拖到很晚才上床，已经影响了睡眠。' },
  ]) {
    const data = await request('/api/previsit/sessions', { profile: { age: fixture.age, respondent: fixture.role }, speakerRole: fixture.role, chiefComplaint: fixture.text });
    record(fixture.name, fixture, data);
    if (!first) first = data;
  }
  if (first?.nextQuestion && first.session.status !== 'completed') {
    const text = '作业拖拉已经好转了，这次我更希望先说孩子半夜老醒的问题。';
    const data = await request('/api/previsit/turns', { sessionId: first.session.sessionId, expectedTurnNo: first.turns.length + 1, speakerRole: 'guardian', answerText: text, currentQuestion: first.nextQuestion });
    record('guardian-voluntary-topic-change', { text }, data);
  }
} catch (error) { report.failures.push(error.message); console.error(error.message); }
finally {
  db?.close(); if (server.exitCode === null) { const ended = once(server, 'exit'); server.kill(); await ended; }
  mkdirSync('output', { recursive: true }); writeFileSync('output/presenting-concern-live.json', JSON.stringify(report, null, 2));
  rmSync(root, { recursive: true, force: true });
  console.log('Report: output/presenting-concern-live.json');
}
if (report.failures.length) process.exitCode = 1;
