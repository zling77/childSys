const ttsBus = new EventTarget();
const API_BASE = import.meta.env.VITE_API_URL ?? '/api';
const neuralTtsUrl = `${API_BASE}/previsit/tts`;

let speakCancelSeq = 0;
let speaking = 0;
let currentPlaybackFinish = null;
let currentAudio = null;
let currentObjectUrl = null;
let currentUtteranceFinish = null;
let testVoiceDiscoveryPromise = null;
const neuralAudioCache = new Map();

const preferredZhVoiceNames = [
  'Microsoft Xiaoxiao Online (Natural)',
  'Microsoft Xiaoxiao Online',
  'Xiaoxiao Online',
  'Microsoft Xiaoyi Online (Natural)',
  'Microsoft Xiaoyi Online',
  'Xiaoyi Online',
  'Microsoft Xiaohan Online',
  'Xiaohan Online',
  'Microsoft Xiaomo Online',
  'Xiaomo Online',
  'Microsoft Xiaoxiao',
  'Microsoft Xiaoyi',
  'Tingting',
  'Xiaoxiao',
  'Xiaoyi',
  'Mei-Jia',
  'Sin-Ji',
  '婷婷',
  '晓晓',
  '晓伊',
  '美佳',
];

export function isTtsSupported() {
  return typeof window !== 'undefined'
    && (typeof window.Audio === 'function' || 'speechSynthesis' in window);
}

export function isSpeaking() {
  return speaking > 0;
}

export function onTtsState(handler) {
  const start = () => handler(true);
  const end = () => handler(false);
  ttsBus.addEventListener('speak-start', start);
  ttsBus.addEventListener('speak-end', end);
  handler(speaking > 0);
  return () => {
    ttsBus.removeEventListener('speak-start', start);
    ttsBus.removeEventListener('speak-end', end);
  };
}

function ttsBegin() {
  if (speaking === 0) ttsBus.dispatchEvent(new Event('speak-start'));
  speaking += 1;
}

function ttsEnd() {
  speaking = Math.max(0, speaking - 1);
  if (speaking === 0) ttsBus.dispatchEvent(new Event('speak-end'));
}

export function prepareTts() {
  // Product narration no longer waits for browser voice discovery. The neural
  // audio endpoint is fetched as soon as the actual text is known.
  if (typeof window !== 'undefined' && window.__portalTest) return discoverTestVoices();
  return Promise.resolve([]);
}

export async function speak(text, options = {}) {
  const spokenText = String(text ?? '').trim();
  if (!spokenText || !isTtsSupported()) return 'unsupported';
  const seq = speakCancelSeq;

  // Keep the browser speech path available to the existing deterministic E2E
  // harness. Real users always try the natural server voice first.
  if (typeof window !== 'undefined' && window.__portalTest) {
    const voices = await discoverTestVoices();
    return seq === speakCancelSeq ? browserSpeak(spokenText, options, seq, voices) : 'cancelled';
  }

  try {
    const audioBlob = await fetchNeuralAudio(spokenText);
    if (seq !== speakCancelSeq) return 'cancelled';
    const status = await playNeuralAudio(audioBlob, options, seq);
    if (status !== 'error') return status;
  } catch {
    if (seq !== speakCancelSeq) return 'cancelled';
  }

  // Network/service failure falls back immediately; there is no five-second
  // wait that can cause a previous question to start speaking too late.
  return browserSpeak(spokenText, options, seq, immediateBrowserVoices());
}

function fetchNeuralAudio(text) {
  let pending = neuralAudioCache.get(text);
  if (pending) return pending;
  pending = fetch(neuralTtsUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  }).then(async (response) => {
    if (!response.ok) throw new Error(`neural TTS HTTP ${response.status}`);
    return response.blob();
  }).catch((error) => {
    neuralAudioCache.delete(text);
    throw error;
  });
  if (neuralAudioCache.size >= 40) neuralAudioCache.delete(neuralAudioCache.keys().next().value);
  neuralAudioCache.set(text, pending);
  return pending;
}

function playNeuralAudio(blob, options, seq) {
  return new Promise((resolve) => {
    if (seq !== speakCancelSeq) {
      resolve('cancelled');
      return;
    }
    const objectUrl = URL.createObjectURL(blob);
    const audio = new Audio(objectUrl);
    let done = false;
    let began = false;
    const finish = (status) => {
      if (done) return;
      done = true;
      if (currentPlaybackFinish === cancelCurrent) currentPlaybackFinish = null;
      if (currentAudio === audio) currentAudio = null;
      if (currentObjectUrl === objectUrl) currentObjectUrl = null;
      URL.revokeObjectURL(objectUrl);
      if (began) ttsEnd();
      publishTtsStatus(status, { engine: 'edge-neural', voiceName: 'zh-CN-XiaoxiaoNeural' });
      resolve(status);
    };
    const cancelCurrent = () => {
      try {
        audio.pause();
        audio.currentTime = 0;
      } catch {
        /* ignore */
      }
      finish('cancelled');
    };
    currentPlaybackFinish = cancelCurrent;
    currentAudio = audio;
    currentObjectUrl = objectUrl;
    audio.preload = 'auto';
    audio.volume = options.volume ?? 1;
    audio.onended = () => finish('end');
    audio.onerror = () => finish('error');

    Promise.resolve(audio.play()).then(() => {
      if (seq !== speakCancelSeq) {
        cancelCurrent();
        return;
      }
      began = true;
      ttsBegin();
      publishTtsStatus('speaking', { engine: 'edge-neural', voiceName: 'zh-CN-XiaoxiaoNeural' });
    }).catch((error) => {
      const blocked = error?.name === 'NotAllowedError';
      finish(blocked ? 'blocked' : 'error');
    });
  });
}

function immediateBrowserVoices() {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return [];
  return window.speechSynthesis.getVoices();
}

function discoverTestVoices() {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return Promise.resolve([]);
  const current = window.speechSynthesis.getVoices();
  if (hasPreferredNaturalZhVoice(current)) return Promise.resolve(current);
  if (testVoiceDiscoveryPromise) return testVoiceDiscoveryPromise;
  testVoiceDiscoveryPromise = new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      window.speechSynthesis.removeEventListener('voiceschanged', onVoicesChanged);
      resolve(window.speechSynthesis.getVoices());
    };
    const onVoicesChanged = () => {
      if (hasPreferredNaturalZhVoice(window.speechSynthesis.getVoices())) finish();
    };
    const timer = window.setTimeout(finish, 5000);
    window.speechSynthesis.addEventListener('voiceschanged', onVoicesChanged);
    onVoicesChanged();
  }).finally(() => { testVoiceDiscoveryPromise = null; });
  return testVoiceDiscoveryPromise;
}

function pickZhVoice(voices) {
  for (const name of preferredZhVoiceNames) {
    const voice = voices.find((candidate) => (
      candidate.localService === false
      && candidate.name.toLocaleLowerCase().includes(name.toLocaleLowerCase())
    ));
    if (voice) return voice;
  }
  for (const name of preferredZhVoiceNames) {
    const voice = voices.find((candidate) => candidate.name.toLocaleLowerCase().includes(name.toLocaleLowerCase()));
    if (voice) return voice;
  }
  return voices.find((voice) => voice.lang === 'zh-CN')
    ?? voices.find((voice) => voice.lang?.startsWith('zh'))
    ?? null;
}

function hasPreferredNaturalZhVoice(voices) {
  return preferredZhVoiceNames.some((name) => voices.some((voice) => (
    voice.localService === false
    && voice.name.toLocaleLowerCase().includes(name.toLocaleLowerCase())
  )));
}

function browserSpeak(text, options, seq, voices) {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return Promise.resolve('unsupported');
  return new Promise((resolve) => {
    if (seq !== speakCancelSeq) {
      resolve('cancelled');
      return;
    }
    const voice = pickZhVoice(voices);
    const utterance = new SpeechSynthesisUtterance(text);
    let done = false;
    let began = false;
    const finish = (status) => {
      if (done) return;
      done = true;
      if (currentUtteranceFinish === cancelCurrent) currentUtteranceFinish = null;
      if (began) ttsEnd();
      publishTtsStatus(status, { engine: 'browser', voiceName: voice?.name ?? 'browser-default' });
      resolve(status);
    };
    const cancelCurrent = () => finish('cancelled');
    currentUtteranceFinish = cancelCurrent;
    utterance.lang = options.lang ?? 'zh-CN';
    utterance.rate = options.rate ?? 0.94;
    utterance.pitch = options.pitch ?? 1;
    utterance.volume = options.volume ?? 1;
    if (voice) utterance.voice = voice;
    utterance.onend = () => finish('end');
    utterance.onerror = () => finish('error');
    try {
      began = true;
      ttsBegin();
      publishTtsStatus('speaking', { engine: 'browser', voiceName: voice?.name ?? 'browser-default' });
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    } catch {
      finish('error');
    }
  });
}

function publishTtsStatus(status, details = {}) {
  if (typeof window === 'undefined') return;
  window.__previsitTtsStatus = {
    status,
    engine: details.engine ?? 'unknown',
    voiceName: details.voiceName ?? 'unknown',
    lang: 'zh-CN',
    online: details.engine === 'edge-neural',
  };
}

export function cancelSpeak() {
  speakCancelSeq += 1;
  const playbackFinish = currentPlaybackFinish;
  currentPlaybackFinish = null;
  playbackFinish?.();
  const utteranceFinish = currentUtteranceFinish;
  currentUtteranceFinish = null;
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
  }
  utteranceFinish?.();
  if (speaking > 0) {
    speaking = 0;
    ttsBus.dispatchEvent(new Event('speak-end'));
  }
}
