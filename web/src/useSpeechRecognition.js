import { useCallback, useEffect, useRef, useState } from 'react';
import { cancelSpeak, onTtsState } from './tts.js';

const SpeechRecognitionCtor =
  typeof window !== 'undefined'
    ? window.SpeechRecognition ?? window.webkitSpeechRecognition
    : undefined;

export function isAsrSupported() {
  return Boolean(SpeechRecognitionCtor);
}

export function useSpeechRecognition(options = {}) {
  const [state, setState] = useState(SpeechRecognitionCtor ? 'idle' : 'unsupported');
  const [transcript, setTranscript] = useState('');
  const [interim, setInterim] = useState('');
  const [error, setError] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const [status, setStatus] = useState('');
  const recognitionRef = useRef(null);
  const wantsListeningRef = useRef(false);
  const ttsActiveRef = useRef(false);
  const diagnosticTimerRef = useRef(null);
  const restartTimerRef = useRef(null);
  const intentionalStopRef = useRef(false);
  const fatalErrorRef = useRef(false);
  const startRecognitionRef = useRef(null);
  const heardAudioRef = useRef(false);
  const receivedResultRef = useRef(false);

  const clearDiagnosticTimer = useCallback(() => {
    if (diagnosticTimerRef.current) {
      window.clearTimeout(diagnosticTimerRef.current);
      diagnosticTimerRef.current = null;
    }
  }, []);

  const clearRestartTimer = useCallback(() => {
    if (restartTimerRef.current) {
      window.clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
  }, []);

  const scheduleNoResultHint = useCallback(() => {
    clearDiagnosticTimer();
    diagnosticTimerRef.current = window.setTimeout(() => {
      if (!recognitionRef.current || receivedResultRef.current) return;
      if (heardAudioRef.current) {
        setStatus('检测到声音，但还没生成文字；请尽量靠近麦克风并继续说。');
      } else {
        setStatus('麦克风已打开，但还没检测到声音；请检查系统输入设备和 Chrome 麦克风权限。');
      }
    }, 7000);
  }, [clearDiagnosticTimer]);

  const ensureMicrophoneAccess = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) return true;
    let stream = null;
    try {
      setStatus('正在请求麦克风权限...');
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setStatus('麦克风权限已允许，正在启动识别...');
      return true;
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      wantsListeningRef.current = false;
      setState('error');
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        setErrorCode('permission_denied');
        setError('麦克风权限被拒绝。请在 Chrome 地址栏左侧的网站设置里允许麦克风，或展开下方文字输入继续。');
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        setErrorCode('microphone_missing');
        setError('没有找到可用麦克风。请检查系统输入设备。');
      } else {
        setErrorCode('microphone_unavailable');
        setError(`无法打开麦克风：${err instanceof Error ? err.message : String(err)}`);
      }
      setStatus('');
      return false;
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
    }
  }, []);

  const createRecognition = useCallback(() => {
    if (!SpeechRecognitionCtor) return null;
    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = options.continuous ?? true;
    recognition.interimResults = true;
    recognition.lang = options.lang ?? 'zh-CN';
    recognition.onresult = (event) => {
      let finalText = '';
      let interimText = '';
      receivedResultRef.current = true;
      clearDiagnosticTimer();
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const alternative = result[0];
        if (result.isFinal) finalText += alternative.transcript;
        else interimText += alternative.transcript;
      }
      if (finalText) setTranscript((current) => appendRecognizedText(current, finalText));
      setInterim(normalizeSpeechText(interimText));
      setStatus(finalText ? '已识别到文字，提交前请确认。' : '正在识别，结果会自动填入文本框。');
    };
    recognition.onaudiostart = () => {
      setStatus('麦克风已连接，请开始说话。');
      scheduleNoResultHint();
    };
    recognition.onsoundstart = () => {
      heardAudioRef.current = true;
      setStatus('检测到声音，正在识别文字。');
      scheduleNoResultHint();
    };
    recognition.onspeechstart = () => {
      heardAudioRef.current = true;
      setStatus('检测到讲话，正在转写。');
      scheduleNoResultHint();
    };
    recognition.onspeechend = () => {
      setStatus('讲话结束，正在整理识别结果。');
    };
    recognition.onnomatch = () => {
      setError('听到了声音，但没有识别出文字。请靠近麦克风，放慢语速再试。');
      setStatus('');
      clearDiagnosticTimer();
    };
    recognition.onerror = (event) => {
      clearDiagnosticTimer();
      if (event.error === 'aborted') return;
      if (event.error === 'no-speech') {
        setErrorCode('');
        setError('');
        setStatus('暂时没有听到说话声，系统会继续等待。');
        setState('listening');
        return;
      }
      fatalErrorRef.current = true;
      if (event.error === 'network' || event.error === 'service-not-allowed') {
        wantsListeningRef.current = false;
        setErrorCode('service_unavailable');
        setError('当前浏览器无法连接实时语音转写服务。可重试或改用最新版 Chrome/Edge；文字输入已自动展开。');
      } else if (event.error === 'not-allowed') {
        wantsListeningRef.current = false;
        setErrorCode('permission_denied');
        setError('浏览器未允许语音识别。请检查网站麦克风权限；文字输入已自动展开。');
      } else {
        setErrorCode('recognition_error');
        setError(`语音识别异常：${event.error}`);
      }
      setStatus('');
      setState('error');
    };
    recognition.onend = () => {
      clearDiagnosticTimer();
      if (recognitionRef.current && recognitionRef.current !== recognition) return;
      recognitionRef.current = null;
      setInterim('');
      if (fatalErrorRef.current) {
        setState('error');
        return;
      }
      if (intentionalStopRef.current || !wantsListeningRef.current) {
        intentionalStopRef.current = false;
        setStatus(receivedResultRef.current ? '语音输入已停止，请核对转写文字。' : '语音输入已停止。');
        setState('idle');
        return;
      }
      if (ttsActiveRef.current) {
        setStatus('系统正在读题，读完后会恢复听写。');
        setState('idle');
        return;
      }
      setStatus('检测到短暂停顿，正在继续听写。');
      setState('requesting');
      clearRestartTimer();
      restartTimerRef.current = window.setTimeout(() => {
        if (wantsListeningRef.current && !ttsActiveRef.current) startRecognitionRef.current?.();
      }, 280);
    };
    return recognition;
  }, [clearDiagnosticTimer, clearRestartTimer, options.continuous, options.lang, scheduleNoResultHint]);

  const startRecognitionNow = useCallback(() => {
    if (!SpeechRecognitionCtor) {
      setState('unsupported');
      return;
    }
    clearRestartTimer();
    if (recognitionRef.current) {
      try {
        recognitionRef.current.abort();
      } catch {
        /* ignore */
      }
      recognitionRef.current = null;
    }
    const recognition = createRecognition();
    if (!recognition) return;
    try {
      fatalErrorRef.current = false;
      intentionalStopRef.current = false;
      heardAudioRef.current = false;
      receivedResultRef.current = false;
      setInterim('');
      recognitionRef.current = recognition;
      recognition.start();
      setError('');
      setErrorCode('');
      setStatus('正在听写，请开始说话。');
      setState('listening');
      scheduleNoResultHint();
    } catch (err) {
      recognitionRef.current = null;
      setErrorCode('start_failed');
      setError(err instanceof Error ? err.message : String(err));
      setStatus('');
      setState('error');
    }
  }, [clearRestartTimer, createRecognition, scheduleNoResultHint]);

  useEffect(() => {
    startRecognitionRef.current = startRecognitionNow;
  }, [startRecognitionNow]);

  const start = useCallback(async () => {
    clearRestartTimer();
    intentionalStopRef.current = false;
    fatalErrorRef.current = false;
    wantsListeningRef.current = false;
    cancelSpeak();
    ttsActiveRef.current = false;
    wantsListeningRef.current = true;
    setError('');
    setErrorCode('');
    setState('requesting');
    const canUseMicrophone = await ensureMicrophoneAccess();
    if (!canUseMicrophone || !wantsListeningRef.current) return;
    startRecognitionNow();
  }, [clearRestartTimer, ensureMicrophoneAccess, startRecognitionNow]);

  const stop = useCallback(() => {
    intentionalStopRef.current = true;
    wantsListeningRef.current = false;
    clearDiagnosticTimer();
    clearRestartTimer();
    if (recognitionRef.current) {
      setStatus('正在整理识别结果...');
      recognitionRef.current.stop();
    } else {
      intentionalStopRef.current = false;
      setStatus('语音输入已停止。');
      setState('idle');
    }
  }, [clearDiagnosticTimer, clearRestartTimer]);

  const reset = useCallback(() => {
    clearDiagnosticTimer();
    clearRestartTimer();
    setTranscript('');
    setInterim('');
    setError('');
    setErrorCode('');
    setStatus('');
  }, [clearDiagnosticTimer, clearRestartTimer]);

  useEffect(() => {
    return () => {
      wantsListeningRef.current = false;
      clearDiagnosticTimer();
      clearRestartTimer();
      try {
        recognitionRef.current?.abort();
      } catch {
        /* ignore */
      }
    };
  }, [clearDiagnosticTimer, clearRestartTimer]);

  useEffect(() => {
    return onTtsState((active) => {
      ttsActiveRef.current = active;
      if (active) {
        clearDiagnosticTimer();
        clearRestartTimer();
        try {
          recognitionRef.current?.abort();
        } catch {
          /* ignore */
        }
        recognitionRef.current = null;
        if (wantsListeningRef.current) setState('idle');
        if (wantsListeningRef.current) setStatus('系统正在读题，读完后再开始听写。');
        return;
      }
      if (wantsListeningRef.current && !recognitionRef.current) {
        startRecognitionNow();
      }
    });
  }, [clearDiagnosticTimer, clearRestartTimer, startRecognitionNow]);

  return { state, transcript, interim, error, errorCode, status, start, stop, reset };
}

function normalizeSpeechText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function appendRecognizedText(currentValue, nextValue) {
  const current = normalizeSpeechText(currentValue);
  const next = normalizeSpeechText(nextValue);
  if (!next || current.endsWith(next)) return current;
  if (!current) return next;
  if (next.startsWith(current)) return next;
  const maximumOverlap = Math.min(current.length, next.length, 24);
  for (let size = maximumOverlap; size > 0; size -= 1) {
    if (current.endsWith(next.slice(0, size))) return `${current}${next.slice(size)}`;
  }
  return `${current}${next}`;
}
