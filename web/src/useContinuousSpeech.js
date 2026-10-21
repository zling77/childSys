import { useCallback, useEffect, useRef, useState } from 'react';
import { isSpeaking, onTtsState } from './tts.js';

// Recognition may restart between utterances; the independent MediaRecorder
// keeps recording throughout narration, submissions and recognition restarts.
export function useContinuousSpeech({ enabled, scope, turnNo, onSegment }) {
  const supported = typeof window !== 'undefined' && Boolean(window.SpeechRecognition ?? window.webkitSpeechRecognition);
  const [text, setText] = useState('');
  const [status, setStatus] = useState(supported ? 'idle' : 'unsupported');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [tts, setTts] = useState(isSpeaking());
  const context = useRef({ scope, turnNo, onSegment });
  context.current = { scope, turnNo, onSegment };
  const recorder = useRef(null);
  const buffer = useRef({ scope, final: '', interim: '', lastId: null });
  const flushRef = useRef(null);

  useEffect(() => onTtsState(setTts), []);
  useEffect(() => {
    buffer.current = { scope, final: '', interim: '', lastId: null };
    setText('');
    setError('');
  }, [scope]);

  useEffect(() => {
    if (!supported || !enabled || tts) {
      if (supported) setStatus(tts ? 'narrating' : 'idle');
      return undefined;
    }
    let disposed = false;
    let timer;
    let failures = 0;
    let sequence = 0;
    const captured = { scope, turnNo };
    const recordId = `ASR-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const start = () => {
      if (disposed) return;
      const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
      const recognition = new Recognition();
      const instanceId = `${recordId}-${++sequence}`;
      let fatal = false;
      let finishing = false;
      let flushing;
      const emitted = new Map();
      let settle;
      const ended = new Promise(resolve => { settle = resolve; });
      recorder.current = recognition;
      recognition.lang = 'zh-CN';
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.onresult = event => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i];
          const value = String(result[0]?.transcript ?? '').trim();
          if (!value) continue;
          if (result.isFinal) {
            const id = `${instanceId}-${i}`;
            if (!emitted.has(id)) {
              if (buffer.current.scope === captured.scope) buffer.current.final += value;
              const segment = { id, ...captured, text: value, kind: 'final', recordedAt: Date.now() };
              emitted.set(id, segment);
              context.current.onSegment?.(segment);
            }
          } else interim += value;
        }
        if (buffer.current.scope === captured.scope) {
          buffer.current.interim = interim;
          setText(buffer.current.final + interim);
        }
      };
      recognition.onstart = recognition.onaudiostart = () => { if (!disposed) { setStatus('listening'); setError(''); } };
      recognition.onerror = event => {
        if (disposed || ['aborted', 'no-speech'].includes(event.error)) return;
        fatal = ['not-allowed', 'service-not-allowed', 'audio-capture'].includes(event.error) || ++failures > 2;
        setStatus('error');
        setError('实时转写暂不可用，录音录像仍在继续。可以重试转写或使用文字输入。');
      };
      recognition.onend = () => {
        if (recorder.current === recognition) recorder.current = null;
        settle();
        if (!disposed && !fatal && !finishing) timer = window.setTimeout(start, 280);
      };
      flushRef.current = () => {
        if (flushing) return flushing;
        flushing = (async () => {
        finishing = true;
        try { recognition.stop(); } catch { settle(); }
        let timeout;
        await Promise.race([ended, new Promise(resolve => { timeout = window.setTimeout(resolve, 900); })]);
        window.clearTimeout(timeout);
        // An unconfirmed partial result is retained as such, never relabelled final.
        if (buffer.current.scope === captured.scope && buffer.current.interim) {
          const partial = buffer.current.interim;
          context.current.onSegment?.({ id: `${instanceId}-partial`, ...captured, text: partial, kind: 'unconfirmed', recordedAt: Date.now() });
        }
        recognition.onresult = null;
        try { recognition.abort(); } catch { /* already ended */ }
        return buffer.current.scope === captured.scope ? buffer.current.final + buffer.current.interim : '';
        })();
        return flushing;
      };
      try { setStatus('requesting'); recognition.start(); }
      catch { fatal = true; settle(); setStatus('error'); setError('无法启动实时转写，请重试或使用文字输入。'); }
    };
    start();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      const recognition = recorder.current;
      recorder.current = null;
      // stop() allows the browser to deliver its last final result.
      try { recognition?.stop(); } catch { /* already stopped */ }
    };
  }, [enabled, retry, scope, supported, tts, turnNo]);

  const flush = useCallback(async () => {
    if (flushRef.current) return flushRef.current();
    return buffer.current.final + buffer.current.interim;
  }, []);
  return { text, status, error, supported, flush, retry: () => setRetry(value => value + 1) };
}
