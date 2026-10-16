import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPublicGateway } from '../server/public-gateway.mjs';

const temp = mkdtempSync(join(tmpdir(), 'childpsych-public-access-'));
const access = { username: 'test-clinician', password: 'synthetic-only-test-credential' };
const staff = { authorization: `Basic ${Buffer.from(`${access.username}:${access.password}`).toString('base64')}` };
const privateMarker = '合成旧病例保密标记ZX94';
let checks = 0;
let output = '';
const holder = createServer(); await new Promise(r => holder.listen(0, '127.0.0.1', r));
const apiPort = holder.address().port; await new Promise(r => holder.close(r));
const apiBase = `http://127.0.0.1:${apiPort}`;
const api = spawn(process.execPath, ['server/index.mjs'], { cwd: process.cwd(),
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(apiPort), PREVISIT_DB_PATH: join(temp, 'cases.db'), PREVISIT_MEDIA_ROOT: join(temp, 'media'), PREVISIT_LLM_MODE: 'off', PREVISIT_CLINICIAN_LLM_MODE: 'off', PREVISIT_OLLAMA_SSH_HOST: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
api.stdout.on('data', c => { output += c; }); api.stderr.on('data', c => { output += c; });
let gateway;
let base;
const settings = { apiBase, access, accessDbPath: join(temp, 'access.db'), distRoot: resolve('web/dist') };
async function openGateway() {
  gateway = createPublicGateway(settings);
  await new Promise(r => gateway.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${gateway.address().port}`;
}
async function request(path, body, headers = {}) {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = null; }
  return { response, status: response.status, text, data };
}
function check(name, fn) { fn(); checks++; console.log(`PASS ${name}`); }
const opening = (chief = '孩子最近写作业比较慢。') => ({ profile: { age: 10, respondent: 'guardian' }, speakerRole: 'guardian', chiefComplaint: chief });
try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(apiBase + '/health')).ok) break; } catch {}
    if (i === 59) throw new Error(output);
    await new Promise(r => setTimeout(r, 50));
  }
  await openGateway();
  for (const path of ['/', '/child', '/guardian']) {
    const r = await request(path); check(`password-free page ${path}`, () => { assert.equal(r.status, 200); assert.match(r.text, /id="root"/); });
  }
  const health = await request('/health'); check('health is public and reaches real backend', () => assert.equal(health.data.ok, true));
  const secret = await request('/api/previsit/sessions', opening(`${privateMarker}，最近晚上睡不着。`), staff);
  assert.equal(secret.status, 200);
  const oldId = secret.data.session.sessionId;
  const caseId = secret.data.session.caseId;
  for (const path of ['/clinician', '/doctor', '/api/previsit/doctor/queue', '/api/previsit/clinician/cases', '/api/previsit/clinician/sessions', `/api/previsit/admin/decision-logs/${oldId}`, '/api/previsit/demo/reset']) {
    const r = await request(path); check(`existing staff surface stays protected: ${path}`, () => { assert.equal(r.status, 401); assert.doesNotMatch(r.text, new RegExp(privateMarker)); });
  }
  const privileged = await request('/api/previsit/clinician/cases/' + caseId, undefined, staff);
  check('staff still accesses actual existing case evidence', () => { assert.equal(privileged.status, 200); assert.match(privileged.text, new RegExp(privateMarker)); });
  const visitor = await request('/api/previsit/sessions', opening());
  const cookie = visitor.response.headers.get('set-cookie').split(';')[0];
  const own = { cookie };
  const ownId = visitor.data.session.sessionId;
  check('visitor gets an opaque secure cookie and only own new session', () => {
    assert.equal(visitor.status, 200); assert.match(visitor.response.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/); assert.doesNotMatch(visitor.text, new RegExp(privateMarker));
  });
  for (const section of ['sessions', 'packet', 'evidence', 'media']) {
    const r = await request(`/api/previsit/${section}/${ownId}`, undefined, own);
    const denied = await request(`/api/previsit/${section}/${oldId}`, undefined, own);
    check(`own ${section} accessible but old case unavailable`, () => { assert.equal(r.status, 200); assert.equal(denied.status, 403); assert.doesNotMatch(r.text + denied.text, new RegExp(privateMarker)); });
  }
  const other = await request('/api/previsit/sessions', opening('合成第二位访客主诉。'));
  const otherCookie = other.response.headers.get('set-cookie').split(';')[0];
  for (const headers of [{}, { cookie: otherCookie }, { cookie: '__Host-previsit-access=' + '0'.repeat(64) }, { cookie: `${cookie}; ${cookie}` }]) {
    const r = await request(`/api/previsit/sessions/${ownId}`, undefined, headers);
    check('session ID alone, another visitor, forged or ambiguous cookie gives no access', () => assert.equal(r.status, 403));
  }
  const forbiddenWrite = await request('/api/previsit/turns', { sessionId: oldId, answerText: '未授权写入' }, own);
  check('visitor cannot append to an existing patient session', () => assert.equal(forbiddenWrite.status, 403));
  const answered = await request('/api/previsit/turns', { sessionId: ownId, speakerRole: 'guardian', answerText: '昨天晚上写数学作业，一个多小时只写了两道题。', currentQuestion: visitor.data.nextQuestion, expectedTurnNo: visitor.data.turns.length + 1 }, own);
  check('password-free visitor completes a real interview turn', () => { assert.equal(answered.status, 200); assert.equal(answered.data.turns.length, visitor.data.turns.length + 1); });
  const dataUrl = 'data:audio/wav;base64,' + Buffer.from('RIFF synthetic audio fixture only').toString('base64');
  const upload = await request('/api/previsit/media', { sessionId: ownId, turnNo: 0, modality: 'audio', durationMs: 1000, dataUrl }, own);
  assert.equal(upload.status, 200);
  const mediaId = upload.data.mediaRecord.mediaId;
  const ownMedia = await request(`/api/previsit/media/blob/${mediaId}`, undefined, own);
  const otherMedia = await request(`/api/previsit/media/blob/${mediaId}`, undefined, { cookie: otherCookie });
  check('uploaded recordings remain restricted to their owner', () => { assert.equal(ownMedia.status, 200); assert.equal(otherMedia.status, 403); });
  const noInvite = await request('/api/previsit/sessions', { ...opening(), caseId }, own);
  check('case ID alone cannot grant public association access', () => assert.equal(noInvite.status, 403));
  const invite = await request('/api/previsit/access/invitations', { caseId, role: 'guardian' }, staff);
  assert.equal(invite.status, 200);
  for (const body of [
    { ...opening(), caseId, caseInvitation: invite.data.token + 'X' },
    { ...opening(), speakerRole: 'child', caseId, caseInvitation: invite.data.token },
    { ...opening(), caseId: 'CASE-OTHER', caseInvitation: invite.data.token },
  ]) {
    const r = await request('/api/previsit/sessions', body, own);
    check('tampered, wrong-role or wrong-case invitation is rejected', () => assert.equal(r.status, 403));
  }
  const associated = await request('/api/previsit/sessions', { ...opening(), caseId, caseInvitation: invite.data.token }, own);
  check('signed doctor invitation associates sources without disclosing original evidence', () => { assert.equal(associated.status, 200); assert.equal(associated.data.session.caseId, caseId); assert.doesNotMatch(associated.text, new RegExp(privateMarker)); });
  const csrf = await request('/api/previsit/demo/reset', {}, { ...staff, origin: 'https://untrusted.invalid' });
  check('cross-site staff writes are blocked', () => assert.equal(csrf.status, 403));
  const invalid = await request('/api/previsit/sessions', null, own);
  check('malformed JSON value fails without crashing gateway', () => assert.equal(invalid.status, 400));
  for (const path of ['/.env', '/src/main.jsx', '/@fs/home/a001/zhangling/ChildPsych/server/data/previsit.db', '/server/data/previsit.db', '/assets/../../server/data/previsit.db']) {
    const r = await request(path); check(`no development file or database exposure: ${path}`, () => assert.equal(r.status, 404));
  }
  const stopped = await request(`/api/previsit/sessions/${ownId}/stop`, {}, own);
  check('visitor can stop and generate own report without a password', () => assert.equal(stopped.status, 200));
  await new Promise(r => gateway.close(r));
  await openGateway();
  const reopened = await request(`/api/previsit/sessions/${ownId}`, undefined, own);
  const stillPrivate = await request(`/api/previsit/sessions/${oldId}`, undefined, own);
  check('ownership restriction survives gateway restart', () => { assert.equal(reopened.status, 200); assert.equal(stillPrivate.status, 403); });
  console.log(`public gateway regression: ${checks} checks passed`);
} finally {
  if (gateway?.listening) await new Promise(r => gateway.close(r));
  api.kill('SIGINT');
  await Promise.race([once(api, 'exit'), new Promise(r => setTimeout(r, 1500))]);
  rmSync(temp, { recursive: true, force: true });
}
