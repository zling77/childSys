import { useCallback, useEffect, useRef, useState } from 'react';
import { cancelSpeak } from './tts.js';

export function isMediaCaptureSupported() {
  return typeof navigator !== 'undefined'
    && Boolean(navigator.mediaDevices?.getUserMedia)
    && typeof MediaRecorder !== 'undefined';
}

export function useMediaCapture() {
  const [recording, setRecording] = useState(null);
  const [records, setRecords] = useState([]);
  const [error, setError] = useState('');
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const startedAtRef = useRef(0);
  const recordsRef = useRef([]);
  const discardOnStopRef = useRef(false);
  recordsRef.current = records;

  const stopTracks = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const start = useCallback(async (modality) => {
    cancelSpeak();
    if (!isMediaCaptureSupported()) {
      setError('当前浏览器不支持音视频采集。');
      return;
    }
    if (recording) return;
    setError('');
    const constraints = modality === 'video'
      ? { audio: true, video: { width: 640, height: 480, facingMode: 'user' } }
      : { audio: true };
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      const mimeType = chooseMimeType(modality);
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      discardOnStopRef.current = false;
      chunksRef.current = [];
      streamRef.current = stream;
      startedAtRef.current = Date.now();

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const type = recorder.mimeType || mimeType || (modality === 'video' ? 'video/webm' : 'audio/webm');
        const blob = new Blob(chunksRef.current, { type });
        const durationMs = Date.now() - startedAtRef.current;
        const discard = discardOnStopRef.current;
        discardOnStopRef.current = false;
        recorderRef.current = null;
        stopTracks();
        if (!discard && blob.size > 0) {
          const url = URL.createObjectURL(blob);
          setRecords((current) => [
            ...current,
            {
              id: `media-${Date.now()}-${Math.random().toString(16).slice(2)}`,
              modality,
              blob,
              url,
              mimeType: type,
              durationMs,
              blobSize: blob.size,
              createdAt: Date.now(),
            },
          ]);
        }
        setRecording(null);
      };

      recorder.start();
      recorderRef.current = recorder;
      setRecording(modality);
    } catch (err) {
      stopTracks();
      setRecording(null);
      setError(mediaErrorMessage(err));
    }
  }, [recording, stopTracks]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
      return;
    }
    stopTracks();
    setRecording(null);
  }, [stopTracks]);

  const remove = useCallback((id) => {
    setRecords((current) => {
      const target = current.find((item) => item.id === id);
      if (target) URL.revokeObjectURL(target.url);
      return current.filter((item) => item.id !== id);
    });
  }, []);

  const clearAll = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      discardOnStopRef.current = true;
      try {
        recorder.stop();
      } catch {
        stopTracks();
      }
    } else {
      stopTracks();
    }
    recorderRef.current = null;
    setRecording(null);
    setRecords((current) => {
      current.forEach((item) => URL.revokeObjectURL(item.url));
      return [];
    });
    setError('');
  }, [stopTracks]);

  useEffect(() => {
    return () => {
      try {
        if (recorderRef.current && recorderRef.current.state !== 'inactive') {
          discardOnStopRef.current = true;
          recorderRef.current.stop();
        }
      } catch {
        /* ignore */
      }
      stopTracks();
      recordsRef.current.forEach((item) => URL.revokeObjectURL(item.url));
    };
  }, [stopTracks]);

  return { recording, records, error, start, stop, remove, clearAll };
}

export function useContinuousMediaCapture() {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState('');
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const startedAtRef = useRef(0);
  const stopPromiseRef = useRef(null);
  const stopResolveRef = useRef(null);
  const discardOnStopRef = useRef(false);
  const timelineRef = useRef([]);
  const activeQuestionRef = useRef(null);

  const stopTracks = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const start = useCallback(async () => {
    if (recorderRef.current?.state === 'recording') return true;
    if (!isMediaCaptureSupported()) {
      setError('当前浏览器不支持本次问诊所需的设备采集。');
      return false;
    }
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { width: 640, height: 480, facingMode: 'user' },
      });
      const mimeType = chooseMimeType('video');
      const recorder = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        videoBitsPerSecond: 400_000,
        audioBitsPerSecond: 48_000,
      });
      streamRef.current = stream;
      recorderRef.current = recorder;
      chunksRef.current = [];
      startedAtRef.current = Date.now();
      discardOnStopRef.current = false;
      timelineRef.current = [];
      activeQuestionRef.current = null;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const type = recorder.mimeType || mimeType || 'video/webm';
        const blob = new Blob(chunksRef.current, { type });
        const record = !discardOnStopRef.current && blob.size > 0
          ? {
              id: `media-full-${Date.now()}-${Math.random().toString(16).slice(2)}`,
              modality: 'video',
              blob,
              mimeType: type,
              durationMs: Date.now() - startedAtRef.current,
              blobSize: blob.size,
              createdAt: Date.now(),
              recordingStartedAt: startedAtRef.current,
              timeline: [...timelineRef.current],
            }
          : null;
        discardOnStopRef.current = false;
        recorderRef.current = null;
        chunksRef.current = [];
        stopTracks();
        setRecording(false);
        stopResolveRef.current?.(record);
        stopResolveRef.current = null;
        stopPromiseRef.current = null;
      };

      recorder.start(1_000);
      setRecording(true);
      return true;
    } catch (err) {
      recorderRef.current = null;
      stopTracks();
      setRecording(false);
      setError(mediaErrorMessage(err));
      return false;
    }
  }, [stopTracks]);

  const markQuestionStart = useCallback((turnNo) => {
    if (recorderRef.current?.state !== 'recording' || activeQuestionRef.current?.turnNo === turnNo) return;
    activeQuestionRef.current = { turnNo, startMs: Math.max(0, Date.now() - startedAtRef.current) };
  }, []);
  const markQuestionEnd = useCallback((turnNo, submittedAt = Date.now()) => {
    const active = activeQuestionRef.current;
    if (!active || active.turnNo !== turnNo) return;
    const endMs = Math.max(active.startMs + 1, submittedAt - startedAtRef.current);
    timelineRef.current = [...timelineRef.current.filter(row => row.turnNo !== turnNo), { ...active, endMs }];
    activeQuestionRef.current = null;
  }, []);

  const stop = useCallback(() => {
    if (stopPromiseRef.current) return stopPromiseRef.current;
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') {
      stopTracks();
      setRecording(false);
      return Promise.resolve(null);
    }
    stopPromiseRef.current = new Promise((resolve) => {
      stopResolveRef.current = resolve;
      recorder.stop();
    });
    return stopPromiseRef.current;
  }, [stopTracks]);

  useEffect(() => () => {
    discardOnStopRef.current = true;
    try {
      if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
    } catch {
      stopTracks();
    }
  }, [stopTracks]);

  return { recording, error, start, stop, markQuestionStart, markQuestionEnd };
}

function chooseMimeType(modality) {
  const candidates = modality === 'video'
    ? ['video/webm;codecs=vp8', 'video/webm']
    : ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
}

export function mediaErrorMessage(err) {
  const name = err instanceof Error ? err.name : '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return '浏览器没有音视频权限，请在地址栏左侧网站设置中允许麦克风/摄像头。';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return '没有找到可用的麦克风或摄像头。';
  }
  return err instanceof Error ? err.message : String(err);
}
