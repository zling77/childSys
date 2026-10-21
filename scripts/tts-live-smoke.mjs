import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const base = process.env.PREVISIT_PREVIEW_URL || 'http://127.0.0.1:5176';
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROME_PATH,
  headless: true, args: ['--autoplay-policy=no-user-gesture-required'],
});
try {
  const page = await browser.newPage();
  const requests = [];
  page.on('response', response => {
    if (response.url().endsWith('/api/previsit/tts')) requests.push({ status: response.status(), contentType: response.headers()['content-type'], engine: response.headers()['x-previsit-tts-engine'] });
  });
  await page.addInitScript(() => {
    window.__browserFallbackCalls = 0;
    const speak = window.speechSynthesis.speak.bind(window.speechSynthesis);
    window.speechSynthesis.speak = utterance => { window.__browserFallbackCalls += 1; return speak(utterance); };
  });
  await page.goto(base);
  await page.waitForFunction(() => window.__previsitTtsStatus?.engine === 'edge-neural' && window.__previsitTtsStatus.status === 'end', null, { timeout: 45000 });
  const result = await page.evaluate(() => ({ playback: window.__previsitTtsStatus, browserFallbackCalls: window.__browserFallbackCalls }));
  assert.equal(result.playback.voiceName, 'zh-CN-XiaoxiaoNeural');
  assert.equal(result.browserFallbackCalls, 0);
  assert.ok(requests.some(r => r.status === 200 && r.engine === 'edge-neural' && r.contentType?.includes('audio/mpeg')));
  const report = { ...result, requests, testedAt: new Date().toISOString(), note: 'Real endpoint and browser MP3 playback; no microphone or camera accessed.' };
  writeFileSync('output/tts-live-check.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await browser.close(); }
