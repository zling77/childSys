import React, { useEffect, useRef, useState } from 'react';
import { questionRecording, recordingForEvidence } from '../../core/mediaTimeline.mjs';

const API = import.meta.env.VITE_API_URL ?? '/api';
let activePlayer = null;
const clock = ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

export function QuestionRecording({ turn, session, compact = false }) {
  const match = questionRecording(turn, session);
  const player = useRef(null);
  const [expanded, setExpanded] = useState(false), [playing, setPlaying] = useState(false), [error, setError] = useState('');
  const id = `${turn?.qaId}:${match?.record.mediaId}`;
  useEffect(() => {
    setExpanded(false); setPlaying(false); setError('');
    const media = player.current;
    return () => { media?.pause(); if (activePlayer === media) activePlayer = null; };
  }, [id]);
  if (!turn) return null;
  const label = !match ? '无原始录音' : match.kind === 'full' ? '整段回放（未定位本题）' : playing ? '暂停原始录音' : '播放本题原始录音';
  const play = async () => {
    const media = player.current;
    if (!media) return;
    if (!media.paused) { media.pause(); return; }
    setExpanded(true); setError('');
    try {
      if (media.readyState < 1) {
        await new Promise((resolve, reject) => {
          const done = () => { clearTimeout(timer); media.removeEventListener('loadedmetadata', done); media.removeEventListener('error', fail); resolve(); };
          const fail = () => { clearTimeout(timer); media.removeEventListener('loadedmetadata', done); media.removeEventListener('error', fail); reject(new Error('录音文件无法读取')); };
          const timer = setTimeout(fail, 15000);
          media.addEventListener('loadedmetadata', done, { once: true }); media.addEventListener('error', fail, { once: true }); media.load();
        });
      }
      const start = match.startMs / 1000, end = match.endMs == null ? Infinity : match.endMs / 1000;
      if (!Number.isFinite(media.currentTime) || media.currentTime < start || media.currentTime >= end || !expanded) media.currentTime = start;
      await media.play();
    } catch { setPlaying(false); setError('无法播放原始文件，请检查附件或下载后核对。'); }
  };
  const props = match ? {
    ref: player, controls: true, preload: 'none', hidden: !expanded,
    src: `${API}/previsit/media/blob/${match.record.mediaId}`,
    onPlay: () => { if (activePlayer && activePlayer !== player.current) activePlayer.pause(); activePlayer = player.current; setPlaying(true); },
    onPause: () => setPlaying(false), onEnded: () => setPlaying(false),
    onTimeUpdate: () => { if (match.endMs != null && player.current.currentTime >= match.endMs / 1000) player.current.pause(); },
    onError: () => setError('原始录音附件不可用。'),
    'aria-label': `原始录音播放器 第${turn.turnNo}题`,
  } : {};
  return <div className={`cw-recording${compact ? ' compact' : ''}`}>
    <button type="button" className="cw-play-button" disabled={!match} aria-label={`${label} 第${turn.turnNo}题`} onClick={play}><span aria-hidden="true">{playing ? 'Ⅱ' : '▶'}</span>{label}</button>
    {match && <small>{match.kind === 'window' ? `问答时间窗 ${clock(match.startMs)}–${clock(match.endMs)}` : match.kind === 'full' ? '旧录制未保存问答时间标记' : '本题关联附件'}{(match.record.modality ?? match.record.mediaType) === 'video' ? ' · 原视频含音轨' : ''}</small>}
    {!match && !compact && <small>本题未保存音频附件，文字转写不能还原原始语音。</small>}
    {match && ((match.record.modality ?? match.record.mediaType) === 'video' ? <video {...props} playsInline /> : <audio {...props} />)}
    {expanded && match && <a href={`${API}/previsit/media/blob/${match.record.mediaId}`} download>下载原始文件</a>}
    {error && <p className="error" role="alert">{error}</p>}
  </div>;
}

export function EvidenceRecording({ unit, sessions }) {
  const { turn, session } = recordingForEvidence(unit, sessions);
  return turn ? <QuestionRecording turn={turn} session={session} compact /> : null;
}
