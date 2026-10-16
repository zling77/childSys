import { test, expect } from '@playwright/test';
const API = 'http://127.0.0.1:4276/api/previsit';
let fixture;
test.beforeEach(async ({ request }) => {
  await request.post(`${API}/demo/reset`, { data: {} });
  const response = await request.post(`${API}/clinician/workspace-fixture`, { data: {} });
  expect(response.ok()).toBeTruthy(); fixture = await response.json();
});
async function open(page) { await page.goto(`/clinician?case=${fixture.caseId}`); await expect(page.locator('.ed-topbar')).toContainText('上学、睡眠与安全线索'); }
function syntheticWav(durationSeconds = 3) {
  const rate = 16000, samples = rate * durationSeconds, wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / rate) * 1000), 44 + i * 2);
  return `data:audio/wav;base64,${wav.toString('base64')}`;
}

test('概览保留来源风险原话，八个问题都有明确的录音状态', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message)); await open(page);
  await expect(page.getByRole('heading', { name: 'AI 整合总结' })).toBeVisible();
  const risk = page.locator('.cw-risk-card').filter({ hasText: '死亡／消失想法' });
  await expect(risk).toContainText('没有采取行动，也没有准备东西');
  await expect(page.getByText('否认与观察范围说明')).toHaveCount(0);
  await page.getByRole('button', { name: '问答与录音', exact: true }).click();
  await expect(page.locator('.cw-question-card')).toHaveCount(8);
  await expect(page.locator('.cw-question-card .cw-play-button:disabled')).toHaveCount(8);
  await page.locator('.cw-answer-fold summary').first().click();
  await expect(page.locator('.cw-answer-text').first()).toContainText('近两周孩子不愿意上学');
  expect(errors).toEqual([]);
});

test('分类与来源筛选保留引用，原文抽屉可以用键盘关闭', async ({ page }) => {
  await open(page); await page.getByRole('button', { name: '分类证据', exact: true }).click();
  await page.getByLabel('信息来源').selectOption('child');
  await expect(page.locator('.cw-evidence-card')).not.toHaveCount(0);
  await expect(page.locator('.cw-source-caregiver')).toHaveCount(0);
  await page.getByRole('button', { name: /安全线索与支持/ }).click();
  await expect(page.locator('.cw-category')).toHaveCount(1);
  if (await page.locator('.cw-category').getAttribute('open') === null) await page.locator('.cw-category > summary').click();
  await page.locator('.cw-evidence-card .cw-reference').first().click();
  await expect(page.getByRole('dialog').locator('mark')).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('button', { name: /无原始录音/ })).toBeDisabled();
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('原始文件播放从本题时间窗开始，到结束边界暂停', async ({ page, request }) => {
  const bundle = await (await request.get(`${API}/clinician/cases/${fixture.caseId}`)).json();
  const session = bundle.sessions[0];
  const response = await request.post(`${API}/media`, { data: { sessionId: session.sessionId, turnNo: 0, modality: 'audio', durationMs: 3000, questionText: '测试用合成正弦音，非真人语音', targetSlotOrIssue: 'full_session', dataUrl: syntheticWav(), timeline: [{ turnNo: 1, startMs: 100, endMs: 1100 }, { turnNo: 2, startMs: 1400, endMs: 2500 }] } });
  expect(response.ok()).toBeTruthy();
  const saved = (await response.json()).mediaRecord;
  expect(saved.timeline[1].qaId).toBe(session.turns[1].qaId);
  await open(page); await page.getByRole('button', { name: '问答与录音', exact: true }).click();
  const question = page.locator('.cw-question-card').nth(1);
  await question.getByRole('button', { name: '播放本题原始录音 第2题', exact: true }).click();
  await expect(question.locator('audio')).toBeVisible();
  await expect.poll(() => question.locator('audio').evaluate(audio => audio.currentTime)).toBeGreaterThanOrEqual(1.4);
  await expect.poll(() => question.locator('audio').evaluate(audio => audio.paused), { timeout: 6000 }).toBeTruthy();
  const stoppedAt = await question.locator('audio').evaluate(audio => audio.currentTime); expect(stoppedAt).toBeLessThan(2.9);
  await expect(question.getByRole('alert')).toHaveCount(0);
});

test('非法录音时间窗在落盘前拒绝，旧文件显示整段未定位回放', async ({ page, request }) => {
  const bundle = await (await request.get(`${API}/clinician/cases/${fixture.caseId}`)).json();
  const session = bundle.sessions[0];
  const data = { sessionId: session.sessionId, turnNo: 0, modality: 'audio', durationMs: 3000, dataUrl: syntheticWav() };
  const invalid = await request.post(`${API}/media`, { data: { ...data, timeline: [{ turnNo: 99, startMs: 0, endMs: 1000 }] } });
  expect(invalid.status()).toBe(400); expect((await (await request.get(`${API}/media/${session.sessionId}`)).json()).mediaRecords).toHaveLength(0);
  expect((await request.post(`${API}/media`, { data })).ok()).toBeTruthy();
  await open(page); await page.getByRole('button', { name: '问答与录音', exact: true }).click();
  await expect(page.locator('.cw-play-button').first()).toContainText('整段回放（未定位本题）');
});

test('全程WebM视频中的本题音轨可以定位并按时间窗停止', async ({ page, request }) => {
  await open(page);
  // Encode a synthetic canvas and oscillator. This never requests a microphone or camera.
  const dataUrl = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 60;
    const painter = canvas.getContext('2d'); let frame = 0;
    const paint = setInterval(() => { painter.fillStyle = frame++ % 2 ? '#246a61' : '#486480'; painter.fillRect(0, 0, 80, 60); }, 60);
    const audio = new AudioContext(), oscillator = audio.createOscillator(), destination = audio.createMediaStreamDestination();
    oscillator.connect(destination); oscillator.start(); await audio.resume();
    const stream = canvas.captureStream(15); destination.stream.getAudioTracks().forEach(track => stream.addTrack(track));
    const mimeType = ['video/webm;codecs=vp8,opus', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, { mimeType }), chunks = [];
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    const stopped = new Promise(resolve => { recorder.onstop = resolve; }); recorder.start(500);
    await new Promise(resolve => setTimeout(resolve, 3000)); recorder.stop(); await stopped;
    clearInterval(paint); stream.getTracks().forEach(track => track.stop()); oscillator.stop(); await audio.close();
    return new Promise(resolve => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(new Blob(chunks, { type: recorder.mimeType })); });
  });
  const bundle = await (await request.get(`${API}/clinician/cases/${fixture.caseId}`)).json(), session = bundle.sessions[0];
  const response = await request.post(`${API}/media`, { data: { sessionId: session.sessionId, turnNo: 0, modality: 'video', durationMs: 3100, dataUrl, timeline: [{ turnNo: 1, startMs: 500, endMs: 2000 }], questionText: '合成视频与音轨测试，非真人录音' } });
  expect(response.ok()).toBeTruthy();
  await page.reload(); await page.getByRole('button', { name: '问答与录音', exact: true }).click();
  const question = page.locator('.cw-question-card').first();
  await question.getByRole('button', { name: '播放本题原始录音 第1题', exact: true }).click();
  await expect(question.locator('video')).toBeVisible();
  await expect.poll(() => question.locator('video').evaluate(video => video.currentTime)).toBeGreaterThanOrEqual(0.5);
  await expect.poll(() => question.locator('video').evaluate(video => video.paused), { timeout: 6000 }).toBeTruthy();
  expect(await question.locator('video').evaluate(video => video.currentTime)).toBeLessThan(2.8);
  await expect(question.getByRole('alert')).toHaveCount(0);
});

test('AI整合结论展示引用，详细摘要默认折叠，窄屏无横向溢出', async ({ page, request }) => {
  const bundle = await (await request.get(`${API}/clinician/cases/${fixture.caseId}`)).json();
  const unit = bundle.evidenceState.evidenceUnits.find(unit => unit.claim.includes('想消失'));
  // UI contract fixture only; the real Ollama demonstration is saved separately.
  await page.route(`**/clinician/cases/${fixture.caseId}/llm`, route => route.fulfill({ json: { enabled: true, model: 'UI测试模型', caseId: fixture.caseId, stale: false, promptVersion: 'ui-fixture', analysis: { evidenceRevision: bundle.clinicalCase.evidenceRevision, totalMs: 1000, state: bundle.evidenceState, doctorStatements: [{ section: 'integrated_assessment', text: '患儿报告近两周有时想消失，但没有采取行动，也没有准备东西。', evidenceIds: [unit.evidenceId], origin: 'llm' }], models: { extract: 'ui-fixture', relations: 'ui-fixture', expression: 'ui-fixture' }, warnings: [], audits: [], statistics: { ruleEvidence: 1, llmEvidence: 1, ruleDisputedTopics: 0, llmDisputedTopics: 0, traceableEvidence: 1, guardedRelations: 0 } } } }));
  await page.setViewportSize({ width: 390, height: 844 }); await open(page);
  await expect(page.locator('.cw-integrated-summary')).toContainText('患儿报告近两周');
  await expect(page.locator('.cl-detail-fold')).not.toHaveAttribute('open', '');
  await page.locator('.cw-integrated-summary .cw-reference').click(); await expect(page.getByRole('dialog').locator('mark')).toBeVisible();
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.getByRole('button', { name: '分类证据', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
});

test('独立预问诊入口复制同一病例的两端链接且不携带来源原话', async ({ page, request }) => {
  await page.addInitScript(() => {
    window.__copiedInterviewEntries = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async text => { window.__copiedInterviewEntries.push(text); } },
    });
  });
  const bundle = await (await request.get(`${API}/clinician/cases/${fixture.caseId}`)).json();
  const sourceAnswers = bundle.sessions.flatMap(session => session.turns.map(turn => turn.answerText));
  await open(page);
  await page.getByText('本病例的独立预问诊入口', { exact: true }).click();
  for (const [index, role] of ['child', 'guardian'].entries()) {
    await page.getByRole('button', { name: role === 'child' ? '复制儿童端入口' : '复制家长端入口', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.__copiedInterviewEntries.length)).toBe(index + 1);
    const copied = await page.evaluate(position => window.__copiedInterviewEntries[position], index);
    const url = new URL(copied);
    expect(url.origin).toBe(new URL(page.url()).origin);
    expect(url.pathname).toBe(`/${role}`);
    expect([...url.searchParams.entries()]).toEqual([['caseId', fixture.caseId]]);
    expect(url.hash).toBe('');
    for (const answer of sourceAnswers.filter(Boolean)) expect(decodeURIComponent(copied)).not.toContain(answer);
    await expect(page.getByRole('status')).toContainText('两端分别作答，不显示另一端答案');
  }
});
