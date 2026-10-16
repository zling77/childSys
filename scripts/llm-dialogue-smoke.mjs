import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const testRoot = mkdtempSync(join(tmpdir(), 'previsit-live-dialogue-'));
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: root,
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    PREVISIT_DB_PATH: join(testRoot, 'dialogue.db'),
    PREVISIT_MEDIA_ROOT: join(testRoot, 'media'),
    PREVISIT_LLM_MODE: 'dynamic',
    PREVISIT_OLLAMA_SSH_HOST: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });

try {
  await waitForHealth();
  const created = await request('/api/previsit/sessions', {
    profile: { age: 10, grade: '小学四年级', respondent: 'guardian' },
    chiefComplaint: '孩子最近不太愿意上学。',
    speakerRole: 'guardian',
    openingQuestion: '这次来门诊，您最想让医生了解孩子的哪些情况？',
  });
  const second = await request('/api/previsit/turns', {
    sessionId: created.session.sessionId,
    speakerRole: 'guardian',
    answerText: '孩子写作业有时比较慢，而且一送到学校门口就哭。',
    currentQuestion: created.nextQuestion,
  });

  const audit = second.decisionLogs.at(-1)?.modelAudits?.find((item) => item.task === 'llm_dynamic_next_question');
  console.log(JSON.stringify({
    model: audit?.model,
    promptVersion: audit?.promptVersion,
    rawModelOutput: audit?.output,
    acceptedQuestion: second.nextQuestion?.text,
    acceptedTarget: second.nextQuestion?.targetSlotOrIssue,
  }, null, 2));
  assert.match(created.nextQuestion?.text ?? '', /上学|学校/);
  assert.doesNotMatch(created.nextQuestion?.text ?? '', /我理解|这让我很担心|这确实让人很担心|您提到/);
  assert.doesNotMatch(created.nextQuestion?.text ?? '', /最影响孩子哪一块/);
  assert.equal(audit?.status, 'success', audit?.error ?? 'dynamic model audit missing');
  assert.equal(second.nextQuestion?.policyType, 'llm_dynamic');
  assert.equal(second.decisionLogs.at(-1)?.boundaryCheckResult?.modelSuggestionAccepted, true);
  assert.match(second.nextQuestion?.text ?? '', /学校|校门|哭|送到/);
  assert.doesNotMatch(second.nextQuestion?.text ?? '', /听起来|我理解|这让我很担心|这确实让人很担心|您提到/);
  assert.notEqual(second.nextQuestion?.text, '在家、学校和同伴相处时表现是否一样，孩子本人、家长和老师分别怎么描述？');

  const distressCreated = await request('/api/previsit/sessions', {
    profile: { age: 10, grade: '小学四年级', respondent: 'guardian' },
    chiefComplaint: '孩子最近不太愿意上学。',
    speakerRole: 'guardian',
    openingQuestion: '这次来门诊，您最想让医生了解孩子的哪些情况？',
  });
  const distressTurn = await request('/api/previsit/turns', {
    sessionId: distressCreated.session.sessionId,
    speakerRole: 'guardian',
    answerText: '我现在真的很担心，不知道该怎么办，孩子一到学校门口就哭。',
    currentQuestion: distressCreated.nextQuestion,
  });
  assert.match(distressTurn.nextQuestion?.text ?? '', /^听起来您现在有些担心，我们慢慢把情况说清楚。/);

  const quotedChildCreated = await request('/api/previsit/sessions', {
    profile: { age: 10, grade: '小学四年级', respondent: 'guardian' },
    chiefComplaint: '孩子最近不太愿意上学。',
    speakerRole: 'guardian',
    openingQuestion: '这次来门诊，您最想让医生了解孩子的哪些情况？',
  });
  const quotedChildTurn = await request('/api/previsit/turns', {
    sessionId: quotedChildCreated.session.sessionId,
    speakerRole: 'guardian',
    answerText: '孩子说“我很难受”，一到学校门口就哭。',
    currentQuestion: quotedChildCreated.nextQuestion,
  });
  assert.doesNotMatch(
    quotedChildTurn.nextQuestion?.text ?? '',
    /^听起来您/,
    'a guardian quoting the child must not be misread as the guardian reporting personal distress',
  );

  console.log(JSON.stringify({
    model: audit.model,
    firstQuestion: created.nextQuestion?.text,
    specificAnswer: '孩子写作业有时比较慢，而且一送到学校门口就哭。',
    adaptiveNextQuestion: second.nextQuestion?.text,
    explicitDistressAnswer: '我现在真的很担心，不知道该怎么办，孩子一到学校门口就哭。',
    supportedAcknowledgement: distressTurn.nextQuestion?.text,
    quotedChildAnswer: '孩子说“我很难受”，一到学校门口就哭。',
    quotedChildNextQuestion: quotedChildTurn.nextQuestion?.text,
    target: second.nextQuestion?.targetSlotOrIssue,
    reason: second.decisionLogs.at(-1)?.selectionReason,
  }, null, 2));
} finally {
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 2_000))]);
  rmSync(testRoot, { recursive: true, force: true });
}

async function request(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));
  return data;
}

async function waitForHealth() {
  for (let index = 0; index < 60; index += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Retry while the temporary server initializes.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`temporary server failed to start\n${output}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}
