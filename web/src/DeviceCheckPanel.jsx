import React, { useEffect, useRef } from 'react';
import { mediaErrorMessage } from './useMediaCapture.js';
import { isSpeaking, onTtsState } from './tts.js';
import { createMicrophoneCheck } from './deviceAudioCheck.js';

const API = import.meta.env.VITE_API_URL ?? '/api';
const label = status => ({ ok: '正常', fail: '需检查', pending: '检测中' })[status] || '检测中';

export function DeviceCheckPanel({ value, onChange }) {
  const videoRef = useRef(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  useEffect(() => {
    let alive = true, stream, ctx, frame, checking = false, networkTimer, recognition;
    let transcriptVerified = false, transcriptionUnavailable = false, nextProbeAt = 0;
    const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    let narration = isSpeaking(), lastNarration = performance.now();
    const update = patch => { if (alive) onChange(current => ({ ...current, ...patch, detail: { ...current.detail, ...patch.detail }, checkedAt: Date.now() })); };
    const stopRecognition = () => { const current = recognition; recognition = null; try { current?.abort(); } catch {} };
    const unsubscribe = onTtsState(active => { narration = active; lastNarration = performance.now(); if (active) stopRecognition(); });
    const networkController = new AbortController();
    async function network() {
      const width = window.screen?.width || window.innerWidth, height = window.screen?.height || window.innerHeight;
      update({ net: 'pending', screen: width > 0 && height > 0 ? 'ok' : 'fail', detail: { screen: `${width}×${height} · ${navigator.maxTouchPoints > 0 ? '支持触控' : '非触控设备'}` } });
      const started = performance.now();
      networkTimer = window.setTimeout(() => networkController.abort(), 5000);
      try {
        const response = await fetch(`${API.replace(/\/api$/, '')}/health`, { cache: 'no-store', signal: networkController.signal });
        const health = response.ok ? await response.json() : null;
        const ok = health?.ok === true, elapsed = Math.round(performance.now() - started);
        update({ net: ok ? 'ok' : 'fail', netRttMs: elapsed, detail: { net: ok ? `网络正常 · ${elapsed}ms` : '暂时无法连接系统服务' } });
      } catch { update({ net: 'fail', detail: { net: '暂时无法连接系统服务，请检查网络后返回此页。' } }); }
      finally { window.clearTimeout(networkTimer); }
    }
    function release() {
      stopRecognition();
      window.cancelAnimationFrame(frame);
      stream?.getTracks().forEach(track => track.stop()); stream = null;
      if (ctx) { void ctx.close?.(); ctx = null; }
    }
    function probeTranscription() {
      if (!Recognition || recognition || transcriptVerified || transcriptionUnavailable || !alive) return;
      const probe = new Recognition(); recognition = probe;
      probe.lang = 'zh-CN'; probe.continuous = false; probe.interimResults = true;
      probe.onresult = event => {
        if (!alive || narration || performance.now() - lastNarration < 350) return;
        const recognized = Array.from(event.results).map(result => result[0]?.transcript ?? '').join('').replace(/[\s\p{P}\p{S}]/gu, '');
        if (recognized.length < 2) return;
        transcriptVerified = true;
        update({ mic: 'ok', asr: 'ok', detail: { mic: '麦克风和语音转写正常' } });
        // The greeting is a device check, never an interview answer.
        try { probe.stop(); } catch {}
      };
      probe.onerror = event => {
        if (!alive || ['aborted', 'no-speech'].includes(event.error)) return;
        transcriptionUnavailable = true;
        update({ asr: 'unavailable' });
      };
      probe.onend = () => { if (recognition === probe) recognition = null; nextProbeAt = performance.now() + 350; };
      try { probe.start(); }
      catch { recognition = null; transcriptionUnavailable = true; update({ asr: 'unavailable' }); }
    }
    async function media() {
      if (checking || !alive) return;
      checking = true; release();
      transcriptVerified = false; transcriptionUnavailable = !Recognition;
      update({ mic: 'pending', asr: Recognition ? 'pending' : 'unavailable', camera: 'pending', micLevel: 0, detail: { mic: '请说“你好”。', camera: '正在连接摄像头' } });
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('浏览器不支持音视频检测，请使用最新版 Chrome 或 Edge。');
        const acquired = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: { width: 640, height: 480, facingMode: 'user' } });
        if (!alive) { acquired.getTracks().forEach(track => track.stop()); return; }
        stream = acquired;
        if (videoRef.current) videoRef.current.srcObject = stream;
        const hasCamera = stream.getVideoTracks().some(track => track.readyState !== 'ended');
        const hasMic = stream.getAudioTracks().some(track => track.readyState !== 'ended');
        update({ camera: hasCamera ? 'ok' : 'fail', mic: hasMic ? 'pending' : 'fail', detail: { camera: hasCamera ? '摄像头已连接，画面仅本地预览' : '未检测到摄像头', mic: hasMic ? '请说“你好”。' : '未检测到麦克风' } });
        if (!hasMic) return;
        const AudioContext = window.AudioContext ?? window.webkitAudioContext;
        if (!AudioContext) throw new Error('浏览器不支持音量检测，请使用最新版 Chrome 或 Edge。');
        ctx = new AudioContext();
        if (ctx.state === 'suspended') await ctx.resume();
        if (!alive || !ctx) return;
        const source = ctx.createMediaStreamSource(stream), analyser = ctx.createAnalyser();
        analyser.fftSize = 1024; source.connect(analyser);
        const data = new Float32Array(analyser.fftSize), check = createMicrophoneCheck();
        let lastUpdate = 0;
        const tick = now => {
          if (!alive || !ctx) return;
          analyser.getFloatTimeDomainData(data);
          const result = check.sample(data, now, { speaking: narration || now - lastNarration < 350, running: ctx.state === 'running' });
          if (!narration && now - lastNarration >= 350 && now >= nextProbeAt) probeTranscription();
          const micOk = transcriptVerified || (transcriptionUnavailable && result.passed);
          if (now - lastUpdate >= 100) {
            lastUpdate = now;
            update({ micLevel: result.level, mic: micOk ? 'ok' : 'pending', detail: { mic: transcriptVerified ? '麦克风和语音转写正常' : micOk ? '麦克风正常；实时听写暂不可用，可使用文字输入。' : ctx.state !== 'running' ? '请轻触页面后说“你好”。' : narration ? '读完后，请说“你好”。' : '请说“你好”。' } });
          }
          frame = window.requestAnimationFrame(tick);
        };
        frame = window.requestAnimationFrame(tick);
        for (const track of stream.getTracks()) track.addEventListener?.('ended', () => {
          window.cancelAnimationFrame(frame);
          update({ [track.kind === 'video' ? 'camera' : 'mic']: 'fail', detail: { [track.kind === 'video' ? 'camera' : 'mic']: '设备已断开，请重新连接后返回此页。' } });
        });
      } catch (error) {
        const message = mediaErrorMessage(error); release();
        update({ mic: 'fail', camera: 'fail', detail: { mic: message, camera: message } });
      } finally { checking = false; }
    }
    const resume = () => { if (ctx?.state === 'suspended') void ctx.resume().catch(() => {}); };
    const onFocus = () => { if (valueRef.current.mic === 'fail' || valueRef.current.camera === 'fail') void media(); };
    window.addEventListener('pointerdown', resume);
    window.addEventListener('keydown', resume);
    window.addEventListener('focus', onFocus);
    void network(); void media();
    return () => { alive = false; networkController.abort(); window.clearTimeout(networkTimer); unsubscribe(); release(); window.removeEventListener('pointerdown', resume); window.removeEventListener('keydown', resume); window.removeEventListener('focus', onFocus); };
  }, [onChange]);
  return <div className="device-check">
    <p className="device-auto-hint">正在自动检测，请说“你好”。</p>
    <div className="device-grid-lite">
      <div className={`device-tile ${value.camera}`}><b>摄像头</b><span>{label(value.camera)}</span><small>{value.detail.camera}</small><video ref={videoRef} autoPlay muted playsInline /></div>
      <div className={`device-tile ${value.mic}`}><b>麦克风</b><span>{label(value.mic)}</span><small>{value.detail.mic}</small><div className="mic-bars">{Array.from({ length: 14 }, (_, i) => <i key={i} className={value.micLevel > i * 7 ? 'on' : ''} />)}</div></div>
      <div className={`device-tile ${value.net}`}><b>网络</b><span>{label(value.net)}</span><small>{value.detail.net}</small></div>
      <div className={`device-tile ${value.screen}`}><b>屏幕</b><span>{label(value.screen)}</span><small>{value.detail.screen}</small></div>
    </div>
  </div>;
}
