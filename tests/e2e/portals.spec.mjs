import { expect, test } from '@playwright/test';

const API = 'http://127.0.0.1:4276/api';

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ request }) => {
  const response = await request.post(`${API}/previsit/demo/reset`, { data: {} });
  expect(response.ok()).toBeTruthy();
});

test('总入口提供家长、儿童和医生三个独立入口，且页面进入时自动播报', async ({ page }) => {
  await installBrowserMediaMocks(page);
  await page.goto('/');

  await expect(page.getByRole('link', { name: /家长端/ })).toHaveAttribute('href', '/guardian');
  await expect(page.getByRole('link', { name: /儿童端/ })).toHaveAttribute('href', '/child');
  await expect(page.getByRole('link', { name: /医生端/ })).toHaveAttribute('href', '/clinician');
  await expect.poll(() => page.evaluate(() => window.__portalTest.speakCalls)).toBeGreaterThanOrEqual(1);
  await expect.poll(() => page.evaluate(() => window.__portalTest.voiceNames.at(-1))).toContain('Xiaoxiao Online');
  const callsBeforeReplay = await page.evaluate(() => window.__portalTest.speakCalls);
  await page.getByRole('button', { name: '重播页面说明' }).click();
  await expect.poll(() => page.evaluate(() => window.__portalTest.speakCalls)).toBe(callsBeforeReplay + 1);
  await page.evaluate(() => { window.__portalTest.failOnlineOnce = true; });
  const callsBeforeFallback = await page.evaluate(() => window.__portalTest.speakCalls);
  await page.getByRole('button', { name: '重播页面说明' }).click();
  await expect.poll(() => page.evaluate(() => window.__portalTest.speakCalls)).toBe(callsBeforeFallback + 2);
  // Current narration retries the preferred voice after a transient failure;
  // browserSpeak no longer switches voice or invokes speechSynthesis.resume.
  await expect.poll(() => page.evaluate(() => window.__portalTest.voiceNames.at(-1))).toContain('Xiaoxiao Online');
  await expect.poll(() => page.evaluate(() => window.__previsitTtsStatus?.status)).toBe('end');
});

test('waits for a delayed online Chinese voice before using a local fallback', async ({ page }) => {
  await installBrowserMediaMocks(page, { delayOnlineVoice: true });
  await page.goto('/');

  await expect.poll(() => page.evaluate(() => window.__portalTest.voiceListenerCount)).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => window.__portalTest.speakCalls)).toBe(0);
  await expect(page.getByRole('button', { name: '重播页面说明' })).toBeVisible();
  await page.evaluate(() => window.__portalTest.revealOnlineVoice());
  await expect.poll(() => page.evaluate(() => window.__portalTest.speakCalls)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__portalTest.voiceNames.at(-1))).toContain('Xiaoxiao Online');
});

test('家长端完成自由主诉并进入动态问诊，可主动停止并生成医生报告', async ({ page, request }) => {
  await installBrowserMediaMocks(page);
  await page.goto('/guardian');
  await completeProfileAndConsent(page, { age: '10', grade: '小学四年级' });

  await expect(page.getByRole('heading', { name: '自由讲述本次来诊原因' })).toBeVisible();
  const wizardButtons = page.locator('.wizard-action-buttons > button');
  const backButtonBox = await wizardButtons.nth(0).boundingBox();
  const nextButtonBox = await wizardButtons.nth(1).boundingBox();
  expect(backButtonBox).not.toBeNull();
  expect(nextButtonBox).not.toBeNull();
  expect(Math.abs(backButtonBox.width - nextButtonBox.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(backButtonBox.height - nextButtonBox.height)).toBeLessThanOrEqual(1);
  await expect(page.getByText('情绪低落', { exact: true })).toHaveCount(0);
  // Wait for the chief-complaint page narration, rather than racing its 80ms startup timer.
  await expect.poll(() => page.evaluate(() => window.__portalTest.spokenTexts.at(-1))).toContain('您最希望医生帮助孩子解决什么问题');
  await expect.poll(() => page.evaluate(() => window.__previsitTtsStatus?.status)).toBe('end');
  await expect.poll(() => page.evaluate(() => window.__portalTest.recognitionStarts)).toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: '开始语音转写' })).toHaveCount(0);
  await expect(page.locator('.transcript-preview')).toHaveCount(0);

  const chief = '孩子最近一个月上课容易走神，写作业拖拉，老师说课堂参与下降。';
  await fillTextFallback(page, chief);
  await page.getByRole('button', { name: '开始预问诊' }).click();

  await expect(page.getByRole('button', { name: '重播当前问题' })).toBeVisible();
  const firstQuestion = await page.locator('.next-question > p').innerText();
  await expect.poll(() => page.evaluate(() => window.__portalTest.spokenTexts.at(-1))).toBe(firstQuestion);
  await fillTextFallback(page, '大概一个月前开始，最近一周更明显。');
  await page.getByRole('button', { name: '说完了，继续' }).click();
  await expect(page.locator('.next-question > p')).not.toHaveText(firstQuestion);
  await expect(page.getByText('大概一个月前开始，最近一周更明显。', { exact: true })).toHaveCount(0);
  const sessionLabel = await page.locator('.page-head > div > p').innerText();
  const sessionId = sessionLabel.replace(/^会话\s*/, '').trim();
  await page.getByRole('button', { name: '停止问诊并生成报告' }).click();
  await expect(page.getByText('本次预问诊已完成', { exact: true })).toBeVisible();
  const stopped = await request.get(`${API}/previsit/sessions/${sessionId}`);
  expect(stopped.ok()).toBeTruthy();
  const stoppedBody = await stopped.json();
  expect(stoppedBody.session.status).toBe('completed');
  expect(stoppedBody.nextQuestion).toBeNull();
  expect(stoppedBody.packets).toHaveLength(1);
  await expect.poll(async () => {
    const response = await request.get(`${API}/previsit/media/${sessionId}`);
    return (await response.json()).mediaRecords.length;
  }).toBe(1);
  const savedRecording = (await (await request.get(`${API}/previsit/media/${sessionId}`)).json()).mediaRecords[0];
  expect(savedRecording.timeline).toHaveLength(2);
  expect(savedRecording.timeline.map(span => span.turnNo)).toEqual([1, 2]);
  expect(savedRecording.timeline[0].startMs).toBeGreaterThanOrEqual(0);
  expect(savedRecording.timeline[1].startMs).toBeGreaterThanOrEqual(savedRecording.timeline[0].endMs);
  expect(savedRecording.timeline[1].endMs).toBeLessThanOrEqual(savedRecording.durationMs);
  expect(savedRecording.timeline.every(span => span.qaId.startsWith(`QA-${sessionId}-`))).toBeTruthy();
});

test('儿童端保持儿童身份、儿童化问法和一轮一问', async ({ page }) => {
  await installBrowserMediaMocks(page);
  await page.goto('/child');

  await expect(page.getByText('我自己回答', { exact: true })).toBeVisible();
  await completeProfileAndConsent(page, { age: '11', grade: '小学五年级', child: true });
  await fillTextFallback(page, '我最近在学校总觉得紧张，不太想进教室。');
  await page.getByRole('button', { name: '开始预问诊' }).click();

  const question = page.locator('.next-question > p');
  await expect(question).toBeVisible();
  await expect(question).not.toContainText(/您|家长|孩子/);
  const questionText = await question.innerText();
  expect((questionText.match(/[？?]/g) ?? []).length).toBe(1);
  await fillTextFallback(page, '最近一次是周一早上，到教室门口时最紧张。');
  await page.getByRole('button', { name: '说完了，继续' }).click();
  await expect(page.getByText('最近一次是周一早上，到教室门口时最紧张。', { exact: true })).toHaveCount(0);
});

test('全程记录同意为必选项，患者流程不显示手动保存控件', async ({ page }) => {
  await installBrowserMediaMocks(page);
  await page.goto('/guardian');
  await fillProfileAndConsent(page, { age: '10', grade: '小学四年级' });
  await page.getByRole('button', { name: '进入设备自检' }).click();

  await expect(page.getByRole('heading', { name: '音视频设备自检' })).toBeVisible();
  await expect(page.getByRole('button', { name: '进入主诉描述' })).toBeEnabled();
  await page.getByRole('button', { name: '进入主诉描述' }).click();
  await expect.poll(() => page.evaluate(() => window.__portalTest.mediaRequests.at(-1)?.video?.facingMode)).toBe('user');
  await expect(page.getByRole('button', { name: '录音记录' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '录像记录' })).toHaveCount(0);
  await expect(page.getByText(/保存音频|保存视频|保存音视频/)).toHaveCount(0);
});

test('设备权限被拒绝时显示可读提示而不是页面脚本异常', async ({ page }) => {
  await installBrowserMediaMocks(page);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/guardian');
  await fillProfileAndConsent(page, { age: '10', grade: '小学四年级' });
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const error = new Error('permission denied');
      error.name = 'NotAllowedError';
      throw error;
    };
  });
  await page.getByRole('button', { name: '进入设备自检' }).click();

  await expect(page.getByText('浏览器没有音视频权限，请在地址栏左侧网站设置中允许麦克风/摄像头。').first()).toBeVisible();
  await expect(page.getByRole('button', { name: '进入主诉描述' })).toBeDisabled();
  expect(pageErrors).toEqual([]);
});

test('进入设备页自动检测，低音量你好转写通过，静音和无转写不放行', async ({ page }) => {
  await installBrowserMediaMocks(page);
  await page.goto('/guardian');
  await fillProfileAndConsent(page, { age: '10', grade: '小学四年级' });
  await page.evaluate(() => { window.__portalTest.micAmplitude = 0; window.__portalTest.autoDeviceGreeting = false; });
  await page.getByRole('button', { name: '进入设备自检' }).click();
  await expect(page.getByRole('button', { name: /检测摄像头|检测网络/ })).toHaveCount(0);
  const next = page.getByRole('button', { name: '进入主诉描述' });
  await expect(next).toBeDisabled();
  await expect(page.locator('.device-tile').filter({ hasText: '网络' })).toContainText('网络正常');
  await page.waitForTimeout(900);
  await expect(next).toBeDisabled();
  await page.evaluate(() => { window.__portalTest.micAmplitude = 0.001; });
  await page.waitForTimeout(850);
  await expect(next).toBeDisabled();
  await page.evaluate(() => { window.__portalTest.micAmplitude = 0.005; });
  await page.waitForTimeout(300);
  await expect(next).toBeDisabled();
  await page.evaluate(() => window.__portalTest.emitRecognition('你好'));
  await expect(next).toBeEnabled();
  await expect(page.locator('.device-tile').filter({ hasText: '麦克风' })).toContainText('麦克风和语音转写正常');
});

test('实时听写不可用时区分音频检测与转写状态，仍可用文字输入', async ({ page }) => {
  await installBrowserMediaMocks(page);
  await page.goto('/guardian');
  await page.evaluate(() => {
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: undefined });
    Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: undefined });
    window.__portalTest.micAmplitude = 0.005;
  });
  await completeProfileAndConsent(page, { age: '10', grade: '小学四年级' });
  await expect(page.getByLabel('文字输入（可选）')).toBeVisible();
  await fillTextFallback(page, '孩子最近上课容易走神，想了解怎样帮助他。');
  const creation = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/previsit/sessions');
  await page.getByRole('button', { name: '开始预问诊' }).click();
  const data = await (await creation).json();
  expect(data.session.profile.deviceCheck.mic).toBe('ok');
  expect(data.session.profile.deviceCheck.asr).toBe('unavailable');
  expect(data.turns[0].answerText).toContain('上课容易走神');
});

test('医生端按临床优先级展示，隐藏内部过程并保持队列选择', async ({ page, request }) => {
  const seed = await request.post(`${API}/previsit/demo/seed`, { data: {} });
  expect(seed.ok()).toBeTruthy();
  const mixedSourceCreate = await request.post(`${API}/previsit/sessions`, {
    data: {
      profile: { age: 11, sex: 'U', grade: '小学五年级', respondent: 'guardian' },
      chiefComplaint: '家长先说孩子最近不愿意进教室。',
      speakerRole: 'guardian',
      openingQuestion: '这次来门诊，您最想让医生了解孩子的哪些情况？',
    },
  });
  expect(mixedSourceCreate.ok()).toBeTruthy();
  const mixedSourceSession = await mixedSourceCreate.json();
  const mixedSourceTurn = await request.post(`${API}/previsit/turns`, {
    data: {
      sessionId: mixedSourceSession.session.sessionId,
      speakerRole: 'child',
      answerText: '我到教室门口会紧张，担心同学看我。',
      currentQuestion: mixedSourceSession.nextQuestion,
    },
  });
  expect(mixedSourceTurn.ok()).toBeTruthy();
  const mixedPacket = await request.post(`${API}/previsit/clinician/cases/${mixedSourceSession.session.caseId}/packet`, { data: {} });
  expect(mixedPacket.ok()).toBeTruthy();
  await page.goto(`/clinician?case=${mixedSourceSession.session.caseId}`);
  await expect(page.locator('.app-clinician > .rail')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'AI 整合总结' })).toBeVisible();
  const ruleSummary = page.locator('.cw-legacy-summary');
  await expect(ruleSummary).not.toHaveAttribute('open', '');
  await ruleSummary.locator('> summary').click();
  await expect(page.getByRole('heading', { name: '结构化预问诊摘要' })).toBeVisible();
  await expect(page.getByRole('button', { name: '摘要已是最新' })).toBeDisabled();
  const unchangedPacket = await request.post(`${API}/previsit/clinician/cases/${mixedSourceSession.session.caseId}/packet`, { data: {} });
  expect(unchangedPacket.ok()).toBeTruthy();
  expect((await unchangedPacket.json()).changed).toBe(false);
  await page.reload();
  await expect(page.locator('.cw-legacy-summary')).not.toHaveAttribute('open', '');
  await page.getByRole('button', { name: '材料与历史', exact: true }).click();
  await expect(page.locator('.original-session-records')).not.toHaveAttribute('open', '');
  await page.getByText('采集覆盖、完整证据表与技术明细', { exact: true }).click();
  const traceDetails = page.locator('.ed-panel').filter({ has: page.getByRole('heading', { name: '采集过程明细' }) }).locator('details');
  await expect(traceDetails).toHaveCount(3);
  for (let index = 0; index < 3; index += 1) await expect(traceDetails.nth(index)).not.toHaveAttribute('open', '');
  await page.getByText('采集覆盖状态', { exact: true }).click();
  await expect(page.locator('.ce-coverage-grid article').first()).toBeVisible();

  const attentionCase = page.getByRole('button', { name: /8岁 · 小学二年级.*老师说孩子上课走神/ });
  await attentionCase.click();
  await expect(page.getByRole('heading', { name: '8岁 · 男 · 小学二年级' })).toBeVisible();
  await page.waitForTimeout(3_300);
  await expect(page.getByRole('heading', { name: '8岁 · 男 · 小学二年级' })).toBeVisible();

  const mixedSourceCase = page.getByRole('button', { name: /家长先说孩子最近不愿意进教室/ });
  await mixedSourceCase.click();
  await page.getByRole('button', { name: '材料与历史', exact: true }).click();
  await page.getByText('采集覆盖、完整证据表与技术明细', { exact: true }).click();
  const qaTimeline = page.locator('.ed-panel').filter({ has: page.getByRole('heading', { name: '采集过程明细' }) }).locator('details').first();
  await expect(qaTimeline.locator('summary')).toContainText('多源问答时间线');
  await qaTimeline.locator('summary').click();
  await expect(qaTimeline.getByText('监护人 1 条', { exact: true })).toBeVisible();
  await expect(qaTimeline.getByText('患儿 1 条', { exact: true })).toBeVisible();
  await expect(qaTimeline.locator('.ce-qa-card')).toHaveCount(2);
  await expect(qaTimeline.locator('.ce-qa-card code').first()).toContainText(`QA-${mixedSourceSession.session.sessionId}-1`);
  await expect(qaTimeline.getByText('系统提问：', { exact: true }).first()).toBeVisible();
  await expect(qaTimeline.getByText('监护人回答：', { exact: true })).toBeVisible();
  await expect(qaTimeline.getByText('患儿回答：', { exact: true })).toBeVisible();
  await expect(page.getByText('open_narrative', { exact: true })).toHaveCount(0);

  await expect(page.locator('.ed-demo-tools')).not.toHaveAttribute('open', '');
});

async function completeProfileAndConsent(page, { age, grade }) {
  await fillProfileAndConsent(page, { age, grade });
  await page.getByRole('button', { name: '进入设备自检' }).click();
  await expect(page.getByRole('button', { name: '进入主诉描述' })).toBeEnabled();
  await page.getByRole('button', { name: '进入主诉描述' }).click();
}

for (const mode of ['guardian', 'child']) {
  test(`${mode}自动持续听写、换题不停止录像，转写原文隐藏并保存，结束保留未提交片段`, async ({ page, request }) => {
    await installBrowserMediaMocks(page);
    await page.goto(`/${mode}`);
    await completeProfileAndConsent(page, { age: '10', grade: '小学四年级' });
    await expect.poll(() => page.evaluate(() => Boolean(window.__portalTest.activeRecognition))).toBeTruthy();
    await expect(page.locator('[data-voice-input-control]')).toHaveCount(0);
    await expect(page.locator('.voice-mic')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(/前端不限定症状类别|全程录音录像中|语音转写在后台保留|本轮以您输入的文字提交/);
    await expect(page.getByLabel('文字输入（可选）')).toHaveValue('');
    const chief = '最近一个月每天上课紧张，晚上睡不着，影响了作业和上学。';
    await page.evaluate(text => window.__portalTest.emitRecognition(text), chief);
    const tail = '这一句是点击继续后才返回的最后识别结果。';
    await page.evaluate(text => { window.__portalTest.finalOnStop = text; }, tail);
    await expect(page.locator('body')).not.toContainText(chief);
    const creation = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/previsit/sessions');
    await page.getByRole('button', { name: '开始预问诊' }).click();
    const created = await (await creation).json();
    expect(created.session.profile.childName).toBe('测试儿童');
    expect(created.session.profile.deviceCheck.asr).toBe('ok');
    expect(created.turns[0].answerText).toBe(chief + tail);
    const sessionId = created.session.sessionId;
    await expect.poll(() => page.evaluate(() => Boolean(window.__portalTest.activeRecognition))).toBeTruthy();
    const starts = await page.evaluate(() => window.__portalTest.recognitionStarts);
    await page.evaluate(() => window.__portalTest.activeRecognition.stop());
    await expect.poll(() => page.evaluate(() => window.__portalTest.recognitionStarts)).toBeGreaterThan(starts);
    await expect.poll(() => page.evaluate(() => Boolean(window.__portalTest.activeRecognition))).toBeTruthy();
    const rawAnswer = '刚才想到的是上周星期一进教室之前会紧张。';
    await page.evaluate(text => window.__portalTest.emitRecognition(text), rawAnswer);
    await expect(page.getByLabel('文字输入（可选）')).toHaveValue('');
    const typed = '补充文字：最近一个月每周大约三次，都是在上学之前。';
    await fillTextFallback(page, typed);
    await page.getByRole('button', { name: '说完了，继续' }).click();
    await expect.poll(async () => (await (await request.get(`${API}/previsit/sessions/${sessionId}`)).json()).turns.length).toBe(2);
    await expect.poll(() => page.evaluate(() => Boolean(window.__portalTest.activeRecognition))).toBeTruthy();
    expect(await page.evaluate(() => window.__portalTest.captureStarts)).toBe(1);
    expect(await page.evaluate(() => window.__portalTest.mediaStopCalls)).toBe(0);
    const unsubmitted = '这一句还没有点继续，也必须留下来给医生核对。';
    await page.evaluate(text => window.__portalTest.emitRecognition(text), unsubmitted);
    await page.getByRole('button', { name: '停止问诊并生成报告' }).click();
    await expect(page.getByText(mode === 'child' ? '谢谢你认真地告诉我们' : '本次预问诊已完成', { exact: true })).toBeVisible();
    await expect(page.getByRole('img', { name: /家长陪伴孩子/ })).toBeVisible();
    await page.screenshot({ path: `output/${mode}-completion-preview.png`, fullPage: true });
    const archive = await (await request.get(`${API}/previsit/transcripts/${sessionId}`)).json();
    expect(archive.turns.map(t => t.answerText)).toEqual([chief + tail, typed]);
    expect(archive.segments.map(s => s.text)).toEqual([chief, tail, rawAnswer, unsubmitted]);
    expect(archive.mediaRecords).toHaveLength(1);
    expect(archive.mediaRecords[0].timeline.map(t => t.turnNo)).toEqual([1, 2]);
    expect(await page.evaluate(() => window.__portalTest.mediaStopCalls)).toBe(1);
    const rawFile = await request.get(`${API}/previsit/transcripts/${sessionId}?format=txt`);
    expect(await rawFile.text()).toContain(unsubmitted);
    await page.goto(`/clinician?case=${created.session.caseId}`);
    await expect(page.locator('.ed-topbar h2')).toContainText('测试儿童');
    await page.getByRole('button', { name: '材料与历史', exact: true }).click();
    const originals = page.locator('.original-session-records');
    await expect(originals).not.toHaveAttribute('open', '');
    await originals.locator('> summary').click();
    await originals.getByText(`${sessionId} · 展开原文转写和音视频`, { exact: true }).click();
    await originals.getByText('展开后台原始语音转写（含未提交片段）', { exact: true }).click();
    await expect(originals.getByText(unsubmitted, { exact: false })).toBeVisible();
    await expect(originals.getByRole('link', { name: '下载原始转写 TXT' })).toBeVisible();
  });
}

async function fillProfileAndConsent(page, { age, grade }) {
  await expect(page.getByRole('button', { name: '下一步', exact: true })).toBeDisabled();
  await page.getByLabel('儿童姓名').fill('测试儿童');
  await page.getByLabel('年龄').fill(age);
  await page.getByLabel('年级').fill(grade);
  await page.getByRole('button', { name: '下一步' }).click();
  await page.getByLabel('签名人姓名').fill('测试监护人');
  await page.getByLabel('身份证末 4 位').fill('0000');
  await page.getByRole('checkbox', { name: /我已阅读并理解以上内容/ }).check();
  await page.getByRole('checkbox', { name: /全程录制音频和视频/ }).check();
  const canvas = page.locator('canvas.signature-canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('signature canvas is not visible');
  await page.mouse.move(box.x + 30, box.y + 45);
  await page.mouse.down();
  await page.mouse.move(box.x + 130, box.y + 75, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByRole('button', { name: '进入设备自检' })).toBeEnabled();
}

async function fillTextFallback(page, text) {
  await page.getByLabel('文字输入（可选）').fill(text);
}

async function installBrowserMediaMocks(page, { delayOnlineVoice = false } = {}) {
  await page.addInitScript(({ shouldDelayOnlineVoice }) => {
    const voiceListeners = new Set();
    const onlineVoice = { name: 'Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)', lang: 'zh-CN', localService: false };
    const localVoices = [
      { name: 'Microsoft Yaoyao - Chinese (Simplified, PRC)', lang: 'zh-CN', localService: true },
      { name: 'Microsoft Huihui - Chinese (Simplified, PRC)', lang: 'zh-CN', localService: true },
    ];
    const state = {
      speakCalls: 0,
      cancelCalls: 0,
      resumeCalls: 0,
      failOnlineOnce: false,
      mediaStopCalls: 0,
      mediaRequests: [],
      voiceNames: [],
      spokenTexts: [],
      nextRecognitionText: '',
      recognitionStarts: 0,
      activeRecognition: null,
      captureStarts: 0,
      micAmplitude: 0.08,
      autoDeviceGreeting: true,
      onlineVoiceReady: !shouldDelayOnlineVoice,
      voiceListenerCount: 0,
      revealOnlineVoice: () => {
        state.onlineVoiceReady = true;
        for (const listener of voiceListeners) listener();
      },
    };
    Object.defineProperty(window, '__portalTest', { value: state });

    class FakeUtterance {
      constructor(text) { this.text = text; }
    }
    const speechSynthesis = {
      getVoices: () => state.onlineVoiceReady ? [onlineVoice, ...localVoices] : localVoices,
      addEventListener: (name, listener) => {
        if (name !== 'voiceschanged') return;
        voiceListeners.add(listener);
        state.voiceListenerCount = voiceListeners.size;
      },
      removeEventListener: (name, listener) => {
        if (name !== 'voiceschanged') return;
        voiceListeners.delete(listener);
        state.voiceListenerCount = voiceListeners.size;
      },
      speak: (utterance) => {
        state.speakCalls += 1;
        state.voiceNames.push(utterance.voice?.name ?? 'browser-default');
        state.spokenTexts.push(utterance.text);
        if (state.failOnlineOnce && utterance.voice?.localService === false) {
          state.failOnlineOnce = false;
          queueMicrotask(() => utterance.onerror?.({ error: 'voice-unavailable' }));
        } else {
          queueMicrotask(() => utterance.onend?.());
        }
      },
      resume: () => { state.resumeCalls += 1; },
      cancel: () => { state.cancelCalls += 1; },
    };
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable: true, value: FakeUtterance });
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: speechSynthesis });

    const fakeTrack = { stop: () => {} };
    const fakeStream = {
      getTracks: () => [fakeTrack],
      getVideoTracks: () => [fakeTrack],
      getAudioTracks: () => [fakeTrack],
    };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async (constraints) => {
          state.mediaRequests.push(structuredClone(constraints));
          return fakeStream;
        },
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
      configurable: true,
      get() { return this.__testStream ?? null; },
      set(value) { this.__testStream = value; },
    });

    class FakeMediaRecorder {
      static isTypeSupported() { return true; }
      constructor(_stream, options = {}) {
        this.mimeType = options.mimeType || 'audio/webm';
        this.state = 'inactive';
      }
      start() { this.state = 'recording'; state.captureStarts += 1; }
      stop() {
        if (this.state === 'inactive') return;
        this.state = 'inactive';
        state.mediaStopCalls += 1;
        this.ondataavailable?.({ data: new Blob(['test-audio'], { type: this.mimeType }) });
        this.onstop?.();
      }
    }
    Object.defineProperty(window, 'MediaRecorder', { configurable: true, value: FakeMediaRecorder });

    class FakeAudioContext {
      constructor() { this.state = 'running'; }
      createMediaStreamSource() { return { connect: () => {} }; }
      createAnalyser() {
        return {
          fftSize: 512,
          frequencyBinCount: 256,
          getByteFrequencyData: (data) => data.fill(32),
          getFloatTimeDomainData: (data) => { for (let i = 0; i < data.length; i += 1) data[i] = Math.sin(i * 0.2) * state.micAmplitude; },
        };
      }
      close() {}
      resume() {}
    }
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: FakeAudioContext });

    class FakeSpeechRecognition {
      constructor() { this.results = []; }
      emit(text, final = true) {
        this.onsoundstart?.(); this.onspeechstart?.();
        const result = { 0: { transcript: text }, length: 1, isFinal: final };
        const resultIndex = this.results.length;
        this.results.push(result);
        this.onresult?.({ resultIndex, results: this.results });
        this.onspeechend?.();
      }
      start() {
        state.activeRecognition = this;
        state.recognitionStarts += 1;
        queueMicrotask(() => {
          this.onaudiostart?.();
          if (document.querySelector('.device-check') && state.autoDeviceGreeting) { this.emit('你好'); return; }
          const transcript = state.nextRecognitionText;
          if (transcript) { state.nextRecognitionText = ''; this.emit(transcript); }
        });
      }
      stop() {
        if (this.stopPending) return;
        if (state.activeRecognition === this && state.finalOnStop) {
          this.stopPending = true;
          const final = state.finalOnStop; state.finalOnStop = '';
          setTimeout(() => { this.emit(final); state.activeRecognition = null; this.onend?.(); }, 35);
          return;
        }
        if (state.activeRecognition === this) state.activeRecognition = null;
        this.onend?.();
      }
      abort() { this.onerror?.({ error: 'aborted' }); this.stop(); }
    }
    state.emitRecognition = (text, final = true) => {
      if (!state.activeRecognition) throw new Error('No automatic recognition is active');
      state.activeRecognition.emit(text, final);
    };
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: FakeSpeechRecognition });
  }, { shouldDelayOnlineVoice: delayOnlineVoice });
}

test('独立预问诊入口使家长会话归入已有病例且保留来源隔离', async ({ page, request }) => {
  const childQuote = '最近天天睡不好，夜里醒来时我会默数七只紫色海豚。';
  const childResponse = await request.post(`${API}/previsit/sessions`, {
    data: {
      profile: { age: 10, grade: '小学四年级', respondent: 'child' },
      speakerRole: 'child',
      chiefComplaint: childQuote,
    },
  });
  expect(childResponse.ok()).toBeTruthy();
  const child = await childResponse.json();
  const caseId = child.session.caseId;
  expect(caseId).toBeTruthy();
  const childEvidenceIds = new Set(child.evidenceUnits.map(unit => unit.evidenceId));

  await installBrowserMediaMocks(page);
  await page.goto(`/guardian?caseId=${encodeURIComponent(caseId)}`);
  await completeProfileAndConsent(page, { age: '10', grade: '小学四年级' });
  const guardianChief = '孩子最近写作业比较慢，我想了解怎么帮助他。';
  await fillTextFallback(page, guardianChief);
  const creation = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/previsit/sessions');
  await page.getByRole('button', { name: '开始预问诊' }).click();
  const guardianResponse = await creation;
  expect(guardianResponse.ok()).toBeTruthy();
  const guardian = await guardianResponse.json();
  expect(guardian.session.caseId).toBe(caseId);
  expect(guardian.session.sessionId).not.toBe(child.session.sessionId);
  expect(guardian.turns).toHaveLength(1);
  expect(guardian.turns[0].answerText).toBe(guardianChief);
  expect(guardian.turns[0].speakerRole).toBe('guardian');
  expect(guardian.evidenceUnits.every(unit => unit.sessionId === guardian.session.sessionId)).toBeTruthy();
  expect(guardian.evidenceUnits.some(unit => childEvidenceIds.has(unit.evidenceId))).toBeFalsy();
  expect(JSON.stringify(guardian)).not.toContain(childQuote);
  expect(JSON.stringify(guardian)).not.toContain('紫色海豚');
  await expect(page.locator('.next-question > p')).toBeVisible();
  await expect(page.locator('body')).not.toContainText(childQuote);
  await expect(page.locator('.next-question > p')).not.toContainText('紫色海豚');

  const saved = await (await request.get(`${API}/previsit/sessions/${guardian.session.sessionId}`)).json();
  expect(saved.session.caseId).toBe(caseId);
  expect(saved.turns.map(turn => turn.answerText)).toEqual([guardianChief]);
  expect(JSON.stringify(saved)).not.toContain(childQuote);
  const bundle = await (await request.get(`${API}/previsit/clinician/cases/${caseId}`)).json();
  expect(new Set(bundle.sessions.map(session => session.sessionId))).toEqual(new Set([
    child.session.sessionId, guardian.session.sessionId,
  ]));
  const childSaved = await (await request.get(`${API}/previsit/sessions/${child.session.sessionId}`)).json();
  expect(childSaved.turns.map(turn => turn.answerText)).toEqual([childQuote]);
});
