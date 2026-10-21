import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realizeGoalFallback } from '../core/llm/dynamicGoalSpace.mjs';

const root = mkdtempSync(join(tmpdir(), 'semantic-http-'));
let child, api, output = '', checks = 0, delayAll = 0, failedDialogueOnce = false;
const captures = [];
const check = (name, test) => { test(); checks++; console.log(`PASS ${name}`); };
const listen = server => new Promise(r => server.listen(0, '127.0.0.1', r));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const empty = () => ({ claims: [], assessments: [], responses: [], safety: [] });
const claim = (id, facet, quote, slot = 'frequency_severity', value = quote) => ({
  id, slot_id: slot, facet_id: facet, quote, value, polarity: 'present', subject: 'patient', source_mode: 'direct', certainty: 'stated',
});
const assessment = (slot_id, facet_id, ids) => ({ slot_id, facet_id, requirements: Object.entries(ids)
  .map(([id, claim_ids]) => ({ id, status: claim_ids ? 'met' : 'unmet', claim_ids: claim_ids ?? [] })) });
const model = createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  const body = JSON.parse(raw); captures.push(body);
  let result;
  const isState = body.messages[0].content.includes('实时语义证据评估器');
  if (body.messages[0].content.includes('后台质量审计Agent')) {
    result = { verdict: 'pass', issues: [] };
  } else if (body.messages[0].content.includes('独立结束充分性审查器')) {
    const context = JSON.parse(body.messages[1].content);
    const answers = context.documents.map(d => d.sources.map(s => s.text).join(''));
    if (answers.includes('policy-review-failure')) { res.writeHead(503); res.end('synthetic review unavailable'); return; }
    if (answers.includes('policy-review-race')) await sleep(500);
    const premature = answers.includes('policy-premature-fixture');
    result = { verdict: premature ? 'continue' : 'allow_complete', reason: premature ? '仍缺具体表现。' : '保留未知交医生核实。',
      findings: [{ facet_id: premature ? 'manifestation_description' : 'priority_goal', necessity: premature ? 'essential' : 'optional',
        status: premature ? 'missing' : 'not_needed', explanation: premature ? '需要了解实际表现。' : '控制样例允许保留未知。',
        refs: [context.documents[0].sources[0].id] }],
      decision: premature ? { next_action: 'ask', target_facet_id: 'manifestation_description', action_type: 'explore', question: '孩子具体出现了哪些表现？', acknowledgement: '', selection_reason: '补充本次困扰的实际表现。' }
        : { next_action: 'complete', target_facet_id: null, action_type: null, question: '', acknowledgement: '', selection_reason: '审查允许结束。' } };
  } else if (isState) {
    const context = JSON.parse(body.messages[1].content);
    const answer = context.current.answer;
    if (answer === 'timeout-fixture') await sleep(1200);
    if (answer === 'stop-race') await sleep(500);
    if (delayAll) await sleep(delayAll);
    result = empty();
    if (['孩子上学前哭，我现在很着急。','我现在很害怕。'].includes(answer)) result.dialogue_guidance = {
      respondent_distress: true, emotion_quote: answer.includes('着急')?'我现在很着急':answer.slice(0,-1), emotion_subject: 'respondent',
      temporal_scope: 'current', response_signal: 'substantive' };
    if(answer==='孩子上学前哭，我现在很着急。') {
      result.claims=[claim('c1','manifestation_description','上学前哭','current_manifestations')];
      result.assessments=[assessment('current_manifestations','manifestation_description',{manifestation:['c1']})];
    }
    if (answer === '孩子每周三次，每次十分钟。') {
      result.claims = [claim('c1', 'frequency', '每周三次'), claim('c2', 'episode_duration', '每次十分钟')];
      result.assessments = [assessment('frequency_severity', 'frequency', { frequency_value: ['c1'], reference_window: ['c1'] }),
        assessment('frequency_severity', 'episode_duration', { content: ['c2'] })];
    } else if (answer === '三次。') {
      result.claims = [claim('c1', 'frequency', '三次')];
      result.assessments = [assessment('frequency_severity', 'frequency', { frequency_value: ['c1'], reference_window: null })];
    } else if (answer === '最近两周。') {
      const previous = context.active_claims.find(c => c.facet_id === 'frequency');
      result.claims = [claim('c1', 'frequency', '最近两周')];
      result.assessments = [assessment('frequency_severity', 'frequency', { frequency_value: [previous.id], reference_window: ['c1'] })];
    } else if (answer === '有影响。') {
      result.claims = [claim('c1', 'impact_presence', '有影响', 'functional_impact', true)];
      result.assessments = [assessment('functional_impact', 'impact_presence', { presence: ['c1'] })];
    } else if (answer === 'schema-failure') result = { claims: 'invalid' };
  } else if (body.messages[0].content.includes('LLM 动态追问系统')) {
    const context = JSON.parse(body.messages[1].content);
    if (context.current_exchange.answer === 'model-failure-fixture' && !failedDialogueOnce) {
      failedDialogueOnce = true; res.writeHead(503); res.end('synthetic model failure'); return;
    }
    const child = context.respondent_context.speaker_role === 'child';
    result = { next_action: 'ask', target_facet_id: 'recent_episode', action_type: 'explore',
      selection_reason: '根据本轮回答进一步了解具体事件。',
      acknowledgement: context.dialogue_guidance?.acknowledgement_allowed
        ? child ? '你可以慢慢说。' : '您可以慢慢说。' : '听起来您很焦虑。',
      question: child ? '上次具体发生了什么？' : '孩子上次具体发生了什么？' };
    if (context.current_exchange.answer === 'llm-optional-goal') result = { ...result,
      target_facet_id: 'episode_duration', action_type: 'explore', question: '这种情况每次一般持续多久？' };
    if (['policy-complete-fixture', 'policy-premature-fixture', 'policy-review-failure', 'policy-review-race'].includes(context.current_exchange.answer)) result = { ...result,
      next_action: 'complete', target_facet_id: null, action_type: null, question: '', acknowledgement: '',
      selection_reason: '不强求补齐清单，缺失内容交医生核实。' };
  } else {
    const context = JSON.parse(body.messages[1].content.split('\n').find(line => line.startsWith('{')));
    const selected = context.selected_strategy;
    assert.ok(selected, 'fast mode must not call a separate Policy/Critic');
    result = { acknowledgement: context.dialogue_guidance?.acknowledgement_allowed
      ? context.respondent_context.speaker_role === 'child' ? '你可以慢慢说。' : '您可以慢慢说。'
      : '听起来您很焦虑。',
      question: realizeGoalFallback({ targetSlotOrIssue: selected.target_slot_or_issue,
        targetFacetId: selected.target_facet_id, missingRequirements: selected.missing_requirements }) };
  }
  if (res.destroyed) return;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }],
    usage: { prompt_tokens: 30, completion_tokens: 30, total_tokens: 60 } }));
});
await listen(model);
async function stop() {
  if (!child) return;
  if (child.exitCode == null) { const ended = once(child, 'exit'); child.kill(); await ended; }
  child = null;
}
async function start(mode, llm = 'off', audit = 'off') {
  await stop(); output = '';
  const holder = createServer(); await listen(holder);
  const port = holder.address().port; await new Promise(r => holder.close(r));
  api = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server/index.mjs'], { cwd: process.cwd(), windowsHide: true,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port),
      PREVISIT_DB_PATH: join(root, `${mode}-${llm}.db`), PREVISIT_MEDIA_ROOT: join(root, 'media'),
      PREVISIT_STATE_BUILDER_MODE: mode, PREVISIT_STATE_TIMEOUT_MS: '350',
      PREVISIT_STATE_OUTPUT_FORMAT: 'json_object',
      PREVISIT_DIALOGUE_AUDIT_MODE: audit, PREVISIT_DIALOGUE_AUDIT_EVERY_TURNS: '1',
      PREVISIT_LLM_MODE: llm, PREVISIT_LLM_PROVIDER: 'openai_compatible',
      PREVISIT_LLM_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`, PREVISIT_LLM_API_KEY: 'synthetic-test-key',
      PREVISIT_LLM_MODEL: 'synthetic-fixture', PREVISIT_LLM_CLARIFY_MODEL: 'synthetic-fixture',
      PREVISIT_LLM_TIMEOUT_MS: '1500', PREVISIT_LLM_CLARIFY_TIMEOUT_MS: '1500', PREVISIT_LLM_RETRY_ATTEMPTS: '0',
      PREVISIT_CLINICIAN_LLM_MODE: 'off', PREVISIT_OLLAMA_SSH_HOST: '',
    }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', c => { output += c; }); child.stderr.on('data', c => { output += c; });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(api + '/health')).ok) return; } catch {}
    await sleep(50);
  }
  throw new Error(output);
}
async function request(path, body) {
  const r = await fetch(api + path, { method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(6000) });
  return { status: r.status, data: await r.json() };
}
const create = chiefComplaint => request('/api/previsit/sessions', { profile: { age: 10, respondent: 'guardian' }, chiefComplaint });
const q = { text: '发生过多少次？', targetSlotOrIssue: 'frequency_severity', targetFacetId: 'frequency' };
const turn = (s, answerText, currentQuestion = q) => request('/api/previsit/turns', {
  sessionId: s.session.sessionId, expectedTurnNo: s.turns.length + 1, answerText, currentQuestion,
});
const facet = (s, slot, id) => s.slotStates.find(x => x.slotId === slot).value.facets[id];
try {
  await start('semantic');
  let r = await create('孩子每周三次，每次十分钟。'); let s = r.data;
  check('real HTTP provider updates incidental evidence on the opening turn', () => {
    assert.equal(r.status, 200); assert.equal(s.session.stateBuilderMode, 'semantic');
    assert.equal(facet(s, 'frequency_severity', 'frequency').status, 'filled');
    assert.notEqual(s.nextQuestion.targetFacetId, 'frequency');
  });
  check('state model input is own-source context with all contract facets and no case graph', () => {
    const context = JSON.parse(captures[0].messages[1].content);
    assert.equal(context.goals.length, 44); assert.ok(!('caseEvidenceState' in context));
  });
  r = await create('三次。'); s = r.data;
  check('HTTP state preserves the model-assessed missing reference window', () => assert.equal(facet(s, 'frequency_severity', 'frequency').status, 'partial'));
  r = await turn(s, '最近两周。'); s = r.data;
  check('HTTP next turn consumes persisted prior evidence and completes only the missing requirement', () => {
    assert.equal(r.status, 200); assert.equal(facet(s, 'frequency_severity', 'frequency').status, 'filled');
  });
  let before = captures.length;
  r = await turn(s, '这个我不想说。', { text: '最近一次发生了什么？', targetSlotOrIssue: 'current_manifestations', targetFacetId: 'recent_episode' });
  s = r.data;
  check('exact scoped refusal avoids the model wait and is not asked again', () => {
    assert.equal(captures.length, before);
    assert.equal(facet(s, 'current_manifestations', 'recent_episode').status, 'declined');
    assert.notEqual(s.nextQuestion.targetFacetId, 'recent_episode');
  });
  r = await turn(s, 'schema-failure'); s = r.data;
  check('invalid model schema saves raw answer and retains known evidence without inflating progress', () => {
    assert.equal(r.status, 200); assert.equal(s.turns.at(-1).answerText, 'schema-failure');
    assert.equal(facet(s, 'frequency_severity', 'frequency').sufficiency, 'sufficient');
    assert.ok(s.decisionLogs.at(-1).modelAudits.some(a => a.task === 'semantic_evidence_assessment' && a.status === 'error'));
  });
  before = captures.length; const began = Date.now();
  r = await turn(s, 'timeout-fixture'); s = r.data;
  check('HTTP semantic deadline falls back once without retries', () => {
    assert.equal(r.status, 200); assert.equal(captures.length - before, 1);
    assert.ok(Date.now() - began < 1100);
  });
  before = captures.length;
  r = await create('我有时想消失。');
  check('explicit safety cue bypasses the ordinary semantic model entirely', () => {
    assert.equal(captures.length, before); assert.equal(r.data.session.status, 'needs_clinician_review');
  });
  r = await create('孩子最近有些走神。'); s = r.data;
  const count = s.turns.length;
  before = captures.length;
  const pending = turn(s, 'stop-race');
  for (let i = 0; i < 50 && captures.length === before; i++) await sleep(10);
  await request(`/api/previsit/sessions/${s.session.sessionId}/stop`, {});
  r = await pending;
  const stopped = await request(`/api/previsit/sessions/${s.session.sessionId}`);
  check('late semantic result cannot reopen a stopped session or commit stale state', () => {
    assert.equal(r.status, 409); assert.equal(stopped.data.session.status, 'completed'); assert.equal(stopped.data.turns.length, count);
  });
  await start('semantic', 'dynamic');
  before = captures.length;
  r = await create('孩子最近有些走神。');
  check('semantic mode makes one state call and one autonomous LLM decision without a rule-selected target', () => {
    assert.equal(r.status, 200); assert.equal(captures.length - before, 2);
    assert.ok(captures.at(-1).messages[0].content.includes('LLM 动态追问系统'));
    const context = JSON.parse(captures.at(-1).messages[1].content);
    assert.equal(Object.keys(context.information_goals).length, 44);
    assert.equal('selected_target_facet' in context, false); assert.equal('candidate_targets' in context, false);
    assert.equal(r.data.nextQuestion.targetFacetId, 'recent_episode');
    assert.ok(r.data.decisionLogs.at(-1).modelAudits.some(a => a.task === 'llm_dynamic_next_question' && a.status === 'success'));
    assert.equal(r.data.decisionLogs.at(-1).modelAudits.some(a => a.task === 'completion_adequacy_review'), false);
  });
  r = await create('llm-optional-goal');
  check('HTTP applies an LLM-selected optional goal outside the original mandatory checklist', () => {
    assert.equal(r.status, 200); assert.equal(r.data.nextQuestion.targetFacetId, 'episode_duration');
    assert.equal(r.data.nextQuestion.policyType, 'llm_dynamic');
  });
  before = captures.length; r = await create('policy-complete-fixture');
  check('LLM completion with missing evidence generates the existing reports without inflating coverage', () => {
    assert.equal(r.status, 200); assert.equal(r.data.session.status, 'completed'); assert.equal(r.data.nextQuestion, null);
    assert.equal(r.data.session.progress.requiredFilled, 0); assert.ok(r.data.packets.length);
    assert.ok(r.data.slotStates.some(s => s.status === 'missing'));
    assert.equal(captures.length - before, 3);
    assert.equal(r.data.decisionLogs.at(-1).modelAudits.filter(a => a.task === 'completion_adequacy_review' && a.status === 'success').length, 1);
    assert.equal('output' in r.data.decisionLogs.at(-1).modelAudits.find(a => a.task === 'completion_adequacy_review'), false);
  });
  before = captures.length; r = await create('policy-premature-fixture');
  check('completion review blocks premature completion and supplies one LLM-selected follow-up', () => {
    assert.equal(captures.length - before, 3); assert.equal(r.data.session.status, 'in_progress');
    assert.equal(r.data.session.completedAt, null); assert.equal(r.data.packets.length, 0);
    assert.equal(r.data.nextQuestion.targetFacetId, 'manifestation_description'); assert.equal(r.data.session.progress.requiredFilled, 0);
  });
  r = await create('policy-review-failure');
  check('review HTTP failure preserves the raw answer without completing or generating reports', () => {
    assert.equal(r.data.session.completedAt, null); assert.equal(r.data.packets.length, 0);
    assert.equal(r.data.nextQuestion.policyType, 'llm_retry'); assert.equal(r.data.turns.at(-1).answerText, 'policy-review-failure');
  });
  r = await create('孩子最近有些走神。'); s = r.data;
  before = captures.length; const pendingReview = turn(s, 'policy-review-race', s.nextQuestion);
  for (let i = 0; i < 100 && !captures.slice(before).some(c => c.messages[0].content.includes('独立结束充分性审查器')); i++) await sleep(10);
  await request(`/api/previsit/sessions/${s.session.sessionId}/stop`, {});
  r = await pendingReview;
  check('a late completion review cannot override the user explicit stop', () => {
    assert.equal(r.status, 409);
  });
  r = await create('model-failure-fixture'); s = r.data;
  check('decision failure keeps the raw turn and shows retry instead of a rule question', () => {
    assert.equal(r.status, 200); assert.equal(s.nextQuestion.policyType, 'llm_retry');
    assert.equal(s.turns.at(-1).answerText, 'model-failure-fixture'); assert.equal(s.session.completedAt, null);
  });
  before = captures.length; r = await turn(s, '我准备好了，可以继续。', s.nextQuestion); s = r.data;
  check('retry calls only the decision model and reuses the preserved substantive answer', () => {
    assert.equal(r.status, 200); assert.equal(captures.length - before, 1);
    assert.equal(JSON.parse(captures.at(-1).messages[1].content).current_exchange.answer, 'model-failure-fixture');
    assert.equal(s.nextQuestion.policyType, 'llm_dynamic');
  });
  r = await create('孩子上学前哭，我现在很着急。');
  check('semantic distress reaches the dialogue LLM and is shown exactly once', () => {
    assert.ok(r.data.nextQuestion.acknowledgement);
    assert.equal((r.data.nextQuestion.text.match(/慢慢说/g)??[]).length,1);
  });
  for (const [age,band] of [[8,'6-11'],[13,'12-14'],[16,'15-18']]) {
    r = await request('/api/previsit/sessions',{profile:{age,respondent:'child'},speakerRole:'child',chiefComplaint:'我现在很害怕。'});
    check(`HTTP child age ${age} carries ${band} into state and autonomous dialogue`,()=>{
      const stateBody=[...captures].reverse().find(c=>c.messages[0].content.includes('实时语义证据评估器'));
      assert.equal(JSON.parse(stateBody.messages[1].content).respondent.age_band,band);
      if(r.data.nextQuestion.targetSlotOrIssue!=='safety_clues') {
        const c=JSON.parse(captures.at(-1).messages[1].content.split('\n').find(s=>s.startsWith('{')));
        assert.equal(c.respondent_context.age_band,band);
      }
      assert.equal(r.data.nextQuestion.acknowledgement,'你可以慢慢说。');
      assert.doesNotMatch(r.data.nextQuestion.text,/您/);
    });
  }
  r = await create('孩子昨晚一直哭。'); s = r.data;
  check('model-supplied unsupported parent reassurance is suppressed',()=>assert.equal(s.nextQuestion.acknowledgement,''));
  const beforePause=captures.length, pendingQuestion=s.nextQuestion;
  r=await turn(s,'我想先休息一下。',s.nextQuestion); s=r.data;
  check('pause saves the turn without another model call or content question',()=>{
    assert.equal(captures.length,beforePause);assert.equal(s.nextQuestion.policyType,'interaction_pause');
    assert.equal(s.session.completedAt,null);assert.doesNotMatch(s.nextQuestion.text,/[？?]/);
  });
  r=await turn(s,'我准备好了，可以继续。',s.nextQuestion); s=r.data;
  check('resume restores the pending question without reinterpreting the control as evidence',()=>{
    assert.equal(captures.length,beforePause);assert.equal(s.nextQuestion.text,pendingQuestion.text);
  });
  r=await turn(s,'我现在不想继续回答了。',s.nextQuestion);
  check('explicit stop completes through the existing packet flow without further questioning',()=>{
    assert.equal(captures.length,beforePause);assert.equal(r.data.session.status,'completed');assert.equal(r.data.nextQuestion,null);
    assert.ok(r.data.packets.length);
  });
  await start('semantic','off','shadow'); r=await create('孩子每周三次，每次十分钟。');
  await sleep(150); const quality=await request(`/api/previsit/sessions/${r.data.session.sessionId}`);
  check('background communication audit is recorded without changing live evidence',()=>{
    const a=quality.data.decisionLogs.flatMap(d=>d.modelAudits).find(a=>a.task==='dialogue_quality_audit');
    assert.equal(a.status,'success');assert.ok(!('output' in a));
    assert.equal(facet(quality.data,'frequency_severity','frequency').sufficiency,'sufficient');
  });
  await start('rule'); before = captures.length;
  r = await create('孩子每周三次，每次十分钟。');
  check('rule control mode performs no semantic calls and preserves legacy state behavior', () => {
    assert.equal(r.status, 200); assert.equal(captures.length, before);
    assert.equal(facet(r.data, 'frequency_severity', 'frequency').status, 'partial');
  });
  await start('shadow'); delayAll = 1000; before = captures.length;
  const shadowBegan = Date.now(); r = await create('孩子每周三次，每次十分钟。');
  check('shadow mode responds with rule state before the slow semantic audit finishes', () => {
    assert.equal(r.status, 200); assert.ok(Date.now() - shadowBegan < 650);
    assert.equal(facet(r.data, 'frequency_severity', 'frequency').status, 'partial');
  });
  await sleep(450);
  const audited = await request(`/api/previsit/sessions/${r.data.session.sessionId}`);
  check('shadow audit is recorded privately and never changes the real state', () => {
    assert.equal(captures.length - before, 1);
    assert.equal(facet(audited.data, 'frequency_severity', 'frequency').status, 'partial');
    assert.ok(audited.data.decisionLogs[0].modelAudits.some(a => a.task === 'semantic_evidence_assessment'));
    assert.ok(audited.data.decisionLogs[0].modelAudits.every(a => !('output' in a)));
  });
  console.log(`semantic HTTP regression: ${checks} checks passed`);
} finally {
  delayAll = 0; await stop(); model.closeAllConnections(); await new Promise(r => model.close(r));
  rmSync(root, { recursive: true, force: true });
}
