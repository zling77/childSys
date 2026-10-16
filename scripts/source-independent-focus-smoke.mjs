import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicDecisionLogs } from '../core/publicDecisionLogs.mjs';
import { validateIndependentElicitation } from '../core/llm/independentElicitationBoundary.mjs';

// Actual HTTP/session/storage/context path; only the model response is a
// controlled fixture. No production database, media, or patient data is used.
const work = mkdtempSync(join(tmpdir(), 'source-independent-focus-'));
const captures = [];
let fault = null;
let checks = 0;
let serverOutput = '';
const model = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  captures.push(body);
  if (fault === 'unavailable') { res.writeHead(503); res.end('synthetic model unavailable'); return; }
  const user = body.messages.find((message) => message.role === 'user').content;
  const context = JSON.parse(user.split('\n').find((line) => line.startsWith('{')));
  let output;
  if (body.messages[0].content.includes('只执行 Policy 和 Critic')) {
    const goal = context.candidate_targets.find((target) => target.facet_id === 'sleep_change') ?? context.candidate_targets[0];
    output = {
      next_action: 'ask', complaint_id: goal.complaint_id,
      target_slot_or_issue: goal.slot_id, target_facet_id: goal.facet_id,
      action_type: goal.allowed_actions[0], selection_reason: '独立了解当前回答者能够提供的情况',
      considered_candidates: [], confidence: .8,
    };
  } else {
    const sleep = context.selected_strategy.target_facet_id === 'sleep_change';
    output = { question: sleep
      ? fault === 'disclosure' ? '孩子说最近天天睡不好，夜间秘密标记Z93，您观察到什么？'
        : context.respondent_context.speaker_role === 'child' ? '最近晚上，你睡得怎么样？'
          : '最近孩子晚上的睡眠，您能观察到哪些情况？'
      : context.respondent_context.speaker_role === 'child' ? '最近一次，具体发生了什么？' : '最近一次，具体发生了什么？' };
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }], usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 } }));
});
await listen(model);
const portHolder = createServer(); await listen(portHolder);
const port = portHolder.address().port; await new Promise((resolve) => portHolder.close(resolve));
const api = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: process.cwd(),
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(port),
    PREVISIT_DB_PATH: join(work, 'test.db'), PREVISIT_MEDIA_ROOT: join(work, 'media'),
    PREVISIT_LLM_MODE: 'dynamic', PREVISIT_LLM_PROVIDER: 'openai_compatible',
    PREVISIT_LLM_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`,
    PREVISIT_LLM_MODEL: 'focus-test-fixture', PREVISIT_LLM_CLARIFY_MODEL: 'focus-test-fixture',
    PREVISIT_LLM_TIMEOUT_MS: '2000', PREVISIT_LLM_CLARIFY_TIMEOUT_MS: '2000', PREVISIT_LLM_RETRY_ATTEMPTS: '0',
    PREVISIT_CLINICIAN_LLM_MODE: 'off', PREVISIT_OLLAMA_SSH_HOST: '',
  }, stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (chunk) => { serverOutput += chunk; });
child.stderr.on('data', (chunk) => { serverOutput += chunk; });
function check(name, fn) { fn(); checks += 1; console.log(`PASS ${name}`); }
const secret = '夜间秘密标记Z93';
const forbidden = /夜间秘密标记Z93|最近天天睡不好|source_independent_focus|cross_source_triggered|CF-PV/;
function assertPublic(data) { assert.doesNotMatch(JSON.stringify(data), forbidden); }
async function create(role, chief, caseId) {
  return request('/api/previsit/sessions', { speakerRole: role, profile: { age: 10, respondent: role }, chiefComplaint: chief, caseId });
}
async function turn(state, answer) {
  return request('/api/previsit/turns', { sessionId: state.session.sessionId, speakerRole: state.session.profile.respondent,
    currentQuestion: state.nextQuestion, expectedTurnNo: state.turns.length + 1, answerText: answer });
}
try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(api + '/health')).ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (i === 59) throw new Error(serverOutput);
  }
  const childState = await create('child', `${secret}，最近天天睡不好。`);
  const caseId = childState.session.caseId;
  const startCapture = captures.length;
  let parent = await create('guardian', '孩子最近写作业有些慢。', caseId);
  check('explicitly linked child sleep evidence opens a neutral sleep goal', () => {
    assert.equal(parent.nextQuestion.targetFacetId, 'sleep_change');
    assert.equal(parent.nextQuestion.policyType, 'llm_dynamic');
    assert.equal(parent.nextQuestion.text, '最近孩子晚上的睡眠，您能观察到哪些情况？');
  });
  check('current-source evidence and completion remain independent', () => {
    assert.ok(parent.evidenceUnits.every((unit) => unit.sessionId === parent.session.sessionId));
    assert.equal(parent.slotStates.find((state) => state.slotId === 'sleep_appetite_physical').value.facets.sleep_change.status, 'missing');
    assertPublic(parent);
  });
  check('both real PC and Realizer HTTP inputs contain only own-source context', () => {
    const calls = captures.slice(startCapture);
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.doesNotMatch(JSON.stringify(call), new RegExp(`${secret}|最近天天睡不好|${childState.session.sessionId}`));
    }
    assert.match(JSON.stringify(calls[0]), /elicitation_mode/);
  });
  const clinical = await request(`/api/previsit/clinician/cases/${caseId}`);
  check('clinician retains private routing provenance and current answer relationships', () => {
    const audit = clinical.interviewFocusAudits.find((a) => a.sessionId === parent.session.sessionId);
    assert.equal(audit.output.currentAnswerIncluded, true);
    assert.equal(audit.output.selectedCrossSourceTarget, true);
    assert.equal(audit.output.independentCorroboration, false);
    assert.ok(audit.output.evidenceIds.length);
    assert.match(JSON.stringify(clinical.evidenceState), new RegExp(secret));
  });
  check('private traces are excluded from every public log in the session', () => {
    assert.equal(parent.decisionLogs.at(-1).selectionReason, '根据本次回答选择下一步了解内容。');
    assert.ok(!('output' in parent.decisionLogs.at(-1).modelAudits[0]));
    const mocked = [{ selectionReason: secret, modelAudits: [{ task: 'source_independent_focus', output: { secret } }] }];
    assert.doesNotMatch(JSON.stringify(publicDecisionLogs(mocked)), new RegExp(secret));
  });
  for (const path of [`/api/previsit/sessions/${parent.session.sessionId}`, `/api/previsit/evidence/${parent.session.sessionId}`, `/api/previsit/admin/decision-logs/${parent.session.sessionId}`]) {
    const data = await request(path); check(`public endpoint ${path.split('/')[3]} contains no hidden-source trace`, () => assertPublic(data));
  }
  const answered = await turn(parent, '最近睡眠正常。');
  check('parent supplies own sleep evidence and is not asked the same focus again', () => {
    assert.ok(['filled', 'unavailable'].includes(answered.slotStates.find((state) => state.slotId === 'sleep_appetite_physical').value.facets.sleep_change.status));
    assert.notEqual(answered.nextQuestion?.targetFacetId, 'sleep_change'); assertPublic(answered);
  });
  const otherCaseParent = await create('guardian', '孩子最近写作业有些慢。');
  check('a separate case gets no sleep goal from this child', () => {
    assert.notEqual(otherCaseParent.session.caseId, caseId); assert.notEqual(otherCaseParent.nextQuestion?.targetFacetId, 'sleep_change');
  });
  const childVariant = await create('child', '最近偶尔睡不好。');
  const variantParent = await create('guardian', '孩子最近写作业有些慢。', childVariant.session.caseId);
  check('changing hidden frequency cannot shape the neutral first question', () => {
    assert.equal(variantParent.nextQuestion.text, parent.nextQuestion.text);
  });
  const refusal = await turn(variantParent, '这部分我暂时不想说。');
  check('declining the conditional sleep topic does not rephrase it into another question', () => {
    assert.notEqual(refusal.nextQuestion?.targetFacetId, 'sleep_change'); assertPublic(refusal);
  });
  const afterRefusal = await turn(refusal, '最近一次写作业花了两个小时。');
  check('a refused sleep topic stays suppressed on later turns', () => {
    assert.notEqual(afterRefusal.nextQuestion?.targetFacetId, 'sleep_change'); assertPublic(afterRefusal);
  });
  const unknownParent = await create('guardian', '孩子最近写作业有些慢。', caseId);
  const unknown = await turn(unknownParent, '我不知道，晚上没有观察到。');
  const afterUnknown = await turn(unknown, '最近一次写作业花了两个小时。');
  check('unknown or unobserved sleep remains unknown and is not repeatedly requested', () => {
    assert.notEqual(unknown.nextQuestion?.targetFacetId, 'sleep_change');
    assert.notEqual(afterUnknown.nextQuestion?.targetFacetId, 'sleep_change');
    assertPublic(unknown); assertPublic(afterUnknown);
  });
  fault = 'disclosure';
  const rejected = await create('guardian', '孩子最近写作业有些慢。', caseId);
  check('a model source-disclosure output is rejected and never returned in public audit', () => {
    assert.equal(rejected.nextQuestion.policyType, 'goal_space_fallback');
    assert.equal(rejected.nextQuestion.text, parent.nextQuestion.text); assertPublic(rejected);
  });
  fault = 'unavailable';
  const unavailable = await create('guardian', '孩子最近写作业有些慢。', caseId);
  check('model failure retains neutral fallback and private routing', () => {
    assert.equal(unavailable.nextQuestion.targetFacetId, 'sleep_change'); assertPublic(unavailable);
  });
  fault = null;
  await request(`/api/previsit/clinician/cases/${caseId}/sessions/${childState.session.sessionId}/detach`, {});
  const detachedParent = await create('guardian', '孩子最近写作业有些慢。', caseId);
  check('detached child evidence stops contributing to new interviews', () => {
    assert.notEqual(detachedParent.nextQuestion?.targetFacetId, 'sleep_change');
  });
  const liveChild = await create('child', '我最近做作业慢。');
  const lateParent = await create('guardian', '孩子最近写作业有些慢。');
  await request(`/api/previsit/clinician/cases/${lateParent.session.caseId}/sessions`, { sessionId: liveChild.session.sessionId });
  await turn(liveChild, '最近睡不着，晚上入睡困难。');
  const refreshedParent = await turn(lateParent, '昨天晚上写数学作业时，孩子坐在桌前一个多小时，写了两道题，中间一直停下来玩橡皮。');
  check('a just-saved child answer affects the next linked parent turn immediately', () => {
    assert.equal(refreshedParent.nextQuestion.targetFacetId, 'sleep_change'); assertPublic(refreshedParent);
  });
  check('neutral boundaries reject disclosure and abnormality assumptions, accept own-source quotation', () => {
    const target = { targetFacetId: 'sleep_change', independentElicitation: true };
    assert.equal(validateIndependentElicitation('孩子说睡不着，您观察到什么？', { target }).ok, false);
    assert.equal(validateIndependentElicitation('孩子睡不着是从什么时候开始的？', { target }).ok, false);
    assert.equal(validateIndependentElicitation('孩子说睡不着，您观察到什么？', { target, ownText: '孩子说他睡不着' }).ok, true);
  });
  check('neutral first questions cannot append hidden frequency, severity, attribution, or negate uncertainty', () => {
    const target = { targetFacetId: 'sleep_change', independentElicitation: true };
    const ownText = '孩子最近写作业慢。';
    for (const question of ['他最近每天睡得很少，您能说说睡眠情况吗？', '孩子最近表示睡觉不舒服，您观察到什么了吗？', '最近孩子睡觉有问题是从什么时候开始的？']) {
      assert.equal(validateIndependentElicitation(question, { target, ownText }).ok, false);
    }
    assert.equal(validateIndependentElicitation('孩子睡不着是从什么时候开始的？', { target, ownText: '我不知道孩子有没有睡不着。' }).ok, false);
    assert.equal(validateIndependentElicitation('最近晚上，你睡得怎么样？', { target }).ok, true);
    assert.equal(validateIndependentElicitation('您能说说最近孩子晚上的睡眠情况吗？', { target }).ok, true);
  });
  console.log(`source-independent focus HTTP smoke: ${checks} checks passed`);
} finally {
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 1500))]);
  await new Promise((resolve) => model.close(resolve));
  rmSync(work, { recursive: true, force: true });
}
function listen(server) { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); }
async function request(path, body) {
  const response = await fetch(api + path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json(); assert.equal(response.ok, true, JSON.stringify(data)); return data;
}
