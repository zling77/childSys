import React, { useState } from 'react';
import { QuestionRecording } from './QuestionRecording.jsx';

const API = import.meta.env.VITE_API_URL ?? '/api';

function SessionRecord({ session }) {
  const [archive, setArchive] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const url = `${API}/previsit/transcripts/${encodeURIComponent(session.sessionId)}`;
  async function load() {
    setLoading(true); setError('');
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`读取原始记录失败 (${response.status})`);
      setArchive(await response.json());
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }
  const media = archive?.mediaRecords ?? session.mediaRecords ?? [];
  return <details className="ce-inline-details" onToggle={event => { if (event.currentTarget.open && !archive && !loading) void load(); }}>
    <summary>{session.sessionId} · 展开原文转写和音视频</summary>
    <p className="ce-help">自动转写未经人工校对；文字输入与语音原文分别保留。未提交片段不会自动作为诊断证据。</p>
    <button type="button" className="ghost compact" onClick={load} disabled={loading}>{loading ? '正在读取…' : '刷新原始记录'}</button>{' '}
    <a href={`${url}?format=txt`} download>下载原始转写 TXT</a>{' '}<a href={url} download={`${session.sessionId}-original-transcript.json`}>下载核对 JSON</a>
    {error && <p className="error" role="alert">{error}</p>}
    <h4>逐轮提交回答</h4>
    {(archive?.turns ?? session.turns).map(turn => <article className="ce-qa-card" key={turn.qaId}>
      <b>第 {turn.turnNo} 轮</b><p>系统：{turn.questionText || '开放式主诉'}</p><p>提交回答：{turn.answerText}</p>
      <QuestionRecording turn={turn} session={{ ...session, mediaRecords: media }} compact />
    </article>)}
    <details className="ce-inline-details"><summary>展开后台原始语音转写（含未提交片段）</summary>
      {archive?.segments?.length ? archive.segments.map(segment => <p className="ce-original" key={segment.id}>第 {segment.turnNo} 轮 · {new Date(segment.recordedAt).toLocaleTimeString('zh-CN')} · {segment.kind === 'final' ? '识别结果' : '未确认临时结果'}：{segment.text}</p>) : <p>尚无独立语音转写记录；旧会话仍可查看逐轮回答。</p>}
      {archive?.drafts?.filter(d => d.text).map(d => <p key={d.turnNo}>文字输入留存 · 第 {d.turnNo} 轮：{d.text}</p>)}
    </details>
    <details className="ce-inline-details"><summary>展开全程音视频（{media.length} 个文件）</summary>
      {media.map(m => <article className="ce-media" key={m.mediaId}>
        <b>{m.fileName || m.mediaId}</b>
        {m.mimeType?.startsWith('video/') || m.modality === 'video' ? <><video controls preload="none" src={`${API}/previsit/media/blob/${m.mediaId}`} /><span>仅听音频</span><audio controls preload="none" src={`${API}/previsit/media/blob/${m.mediaId}`} /></> : <audio controls preload="none" src={`${API}/previsit/media/blob/${m.mediaId}`} />}
        <a href={`${API}/previsit/media/blob/${m.mediaId}`} download>下载原始音视频</a>
      </article>)}
    </details>
  </details>;
}

export function OriginalSessionRecords({ sessions }) {
  return <details className="cw-fold original-session-records">
    <summary>原始转写与全程音视频（展开核对）</summary>
    {sessions.map(session => <SessionRecord key={session.sessionId} session={session} />)}
  </details>;
}
