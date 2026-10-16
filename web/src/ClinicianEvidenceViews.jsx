import React, { useMemo, useState } from 'react';
import { evidenceCategories, groupClinicianEvidence, riskScopeLabels } from '../../core/clinicianPresentation.mjs';
import { EvidenceRecording, QuestionRecording } from './QuestionRecording.jsx';

const roles = { child: '患儿', caregiver: '监护人', guardian: '监护人', teacher_school: '教师／学校', scale: '量表', clinical_record: '既往记录', clinician: '医生补充', other: '其他来源' };
const polarities = { affirmed: '肯定陈述', negated: '否认陈述', uncertain: '不确定' };
const time = unit => unit.referenced_time_span?.raw_text || '指向时间未明';
const source = unit => {
  const role = roles[unit.sourceRole] || '来源未明';
  return `${role}${unit.sourceLabel && unit.sourceLabel !== role ? ` · ${unit.sourceLabel}` : ''}${unit.sourceMode === 'reported' ? `（转述${roles[unit.reportedSourceRole] || '其他来源'}）` : ''}`;
};

export function EvidenceReferences({ ids, byId, onTrace }) {
  return <span className="cw-references">{ids.filter(id => byId.has(id)).map((id, index) => <button key={id} type="button" title={id} className="cw-reference" onClick={() => onTrace(id)} aria-label={`查看原文 ${id}`}>{index + 1} · {source(byId.get(id))}原文 <span aria-hidden="true">↗</span></button>)}</span>;
}

export function RiskClues({ tags, byId, onTrace, reviews = [], ruleIds, onReview, disabled }) {
  const active = tags.filter(tag => !['denied', 'not_observed'].includes(tag.scope));
  const limited = tags.filter(tag => ['denied', 'not_observed'].includes(tag.scope));
  const card = tag => {
    const reviewKind = ['impact', 'difference'].includes(tag.kind) ? 'evidence' : 'risk';
    const references = tag.evidenceIds.map(id => byId.get(id)).filter(Boolean);
    const originals = [...new Map(references.map(unit => [[unit.sessionId ?? unit.materialId, unit.inputRound, unit.originalText ?? unit.claim].join('|'), unit])).values()];
    const id = [...byId.values()].find(unit => ruleIds.has(unit.evidenceId) && (reviewKind !== 'risk' || unit.riskFlag) && references.some(ref => unit.evidenceId === ref.evidenceId || (unit.sessionId && unit.sessionId === ref.sessionId && unit.inputRound === ref.inputRound) || (unit.materialId && unit.materialId === ref.materialId)))?.evidenceId;
    const latest = id && [...reviews].reverse().find(review => review.targetKind === reviewKind && review.targetId === id);
    return <article className={`ce-risk-card cw-risk-card cw-risk-${tag.scope}`} key={tag.id}>
      <div className="cw-card-title"><b>{tag.label}</b><span className="cw-status">{riskScopeLabels[tag.scope]}</span></div>
      <p>{tag.note}</p>
      <div className="cw-risk-quotes">{originals.map(unit => <div key={unit.evidenceId}><span>{source(unit)} · {time(unit)}</span><blockquote>{unit.originalText || unit.claim}</blockquote></div>)}</div>
      <EvidenceReferences ids={originals.map(unit => unit.evidenceId)} byId={byId} onTrace={onTrace} />
      {id && <div className="ce-review-state">{latest && <span>{latest.status === 'reviewed' ? '已记录核实结果' : latest.status === 'seen' ? '已查看' : '需补充'}{latest.note ? `：${latest.note}` : ''}</span>}<button type="button" disabled={disabled} onClick={() => onReview({ kind: reviewKind, id })}>{latest ? '补充核实记录' : '记录查看／核实'}</button></div>}
    </article>;
  };
  return <section className="ed-panel cw-risk-panel"><div className="ed-panel-header"><h3>风险与核实线索</h3><span>来源原话 · 非风险等级</span></div><div className="ce-panel-body">
    <p className="ce-help">标签整理原话中的安全、功能影响与分歧线索；否认、未观察到和信息缺失分别保留，不能据此认定已排除风险。</p>
    {active.length ? <div className="cw-risk-grid">{active.map(card)}</div> : <p className="cw-empty">当前材料未形成已报告或待核实的风险线索标签。</p>}
    {limited.length > 0 && <details className="cw-fold"><summary>否认与观察范围说明 <span>{limited.length}类</span></summary><div className="cw-risk-grid">{limited.map(card)}</div></details>}
  </div></section>;
}

export function ClassifiedEvidence({ units, byId, sessions, onTrace }) {
  const [category, setCategory] = useState('all'), [role, setRole] = useState('all'), [query, setQuery] = useState('');
  const filtered = useMemo(() => units.filter(unit => (role === 'all' || unit.sourceRole === role) && (!query || [unit.claim, unit.topicLabel, unit.facetLabel, source(unit)].join(' ').includes(query.trim()))), [units, role, query]);
  const groups = groupClinicianEvidence(filtered).filter(group => category === 'all' || category === group.id);
  return <section className="ed-panel cw-evidence-panel"><div className="ed-panel-header"><h3>分类证据</h3><span>{filtered.length}条当前陈述 · 原文可追溯</span></div><div className="ce-panel-body">
    <div className="cw-evidence-toolbar"><label>搜索证据<input type="search" placeholder="表现、来源或具体原话" value={query} onChange={event => setQuery(event.target.value)} /></label><label>信息来源<select value={role} onChange={event => setRole(event.target.value)}><option value="all">所有来源</option>{[...new Set(units.map(unit => unit.sourceRole))].map(role => <option key={role} value={role}>{roles[role]}</option>)}</select></label></div>
    <div className="cw-category-filter" aria-label="证据分类"><button type="button" className={category === 'all' ? 'active' : ''} onClick={() => setCategory('all')}>全部</button>{evidenceCategories.map(group => <button type="button" key={group.id} className={category === group.id ? 'active' : ''} onClick={() => setCategory(group.id)}>{group.label}<span>{filtered.filter(unit => group.slots.includes(unit.slotId)).length}</span></button>)}</div>
    <div className="cw-category-list">{groups.map((group, index) => <details className="cw-category" key={group.id} open={index === 0 && group.units.length > 0}>
      <summary><span><b>{group.label}</b><small>{group.description}</small></span><strong>{group.units.length}</strong></summary>
      {!group.units.length ? <p className="cw-empty">此分类尚未取得可追溯证据。</p> : group.topics.map(topic => <section className="cw-topic" key={topic.slotId}><h4>{topic.label}</h4>{topic.units.map(unit => <article className="cw-evidence-card" key={unit.evidenceId}>
        <div className="cw-card-title"><span className={`cw-source cw-source-${unit.sourceRole}`}>{source(unit)}</span><span className={`cw-polarity ${unit.polarity}`}>{polarities[unit.polarity]}</span></div>
        <p>{unit.claim}</p><div className="cw-evidence-meta"><span>{time(unit)}</span><span>{unit.facetLabel}</span><small>{unit.evidenceId.startsWith('LE-') ? '模型抽取候选' : '规则整理'}</small></div>
        <div className="cw-evidence-footer"><EvidenceReferences ids={[unit.evidenceId]} byId={byId} onTrace={onTrace} /><EvidenceRecording unit={unit} sessions={sessions} /></div>
        <details className="cw-fold cw-original-fold"><summary>完整输入与来源范围</summary><p className="ce-original">{unit.originalText}</p><small>来源方式：{unit.sourceMode === 'reported' ? `转述${roles[unit.reportedSourceRole] || '其他来源'}` : '直接提供'} · 材料形成时间：{unit.observedTime ? new Date(unit.observedTime).toLocaleDateString('zh-CN') : '未说明'}</small></details>
      </article>)}</section>)}
    </details>)}</div>
  </div></section>;
}

export function QuestionEvidence({ sessions, units, byId, onTrace }) {
  const [role, setRole] = useState('all'), [category, setCategory] = useState('all');
  const questions = sessions.flatMap(session => session.turns.map(turn => ({ session, turn, units: units.filter(unit => unit.sessionId === session.sessionId && (unit.traceRef?.qaId === turn.qaId || unit.inputRound === turn.turnNo)) }))).filter(row => (role === 'all' || row.turn.speakerRole === role) && (category === 'all' || evidenceCategories.find(group => group.id === category)?.slots.some(slot => row.units.some(unit => unit.slotId === slot) || row.turn.targetSlotOrIssue === slot)));
  return <section className="ed-panel cw-questions-panel"><div className="ed-panel-header"><h3>问答与原始录音</h3><span>{questions.length}题 · 逐题核对</span></div><div className="ce-panel-body">
    <p className="ce-help">先听原始录音，再结合转写和抽取证据判断。时间标记对应问答窗口，尚未做词级语音对齐。</p>
    <div className="cw-evidence-toolbar"><label>回答来源<select value={role} onChange={event => setRole(event.target.value)}><option value="all">全部回答者</option>{[...new Set(sessions.flatMap(session => session.turns.map(turn => turn.speakerRole)))].map(role => <option key={role} value={role}>{roles[role] || '其他回答者'}</option>)}</select></label><label>证据分类<select value={category} onChange={event => setCategory(event.target.value)}><option value="all">全部问题</option>{evidenceCategories.map(group => <option key={group.id} value={group.id}>{group.label}</option>)}</select></label></div>
    {!questions.length && <p className="cw-empty">当前筛选下没有关联问答。来源材料可在“分类证据”中查看。</p>}
    <div className="cw-question-list">{questions.map(({ session, turn, units }) => <article className="ce-qa-card cw-question-card" key={turn.qaId}>
      <div className="cw-question-heading"><span className="cw-question-number">Q{String(turn.turnNo).padStart(2, '0')}</span><div><span className="cw-source">{roles[turn.speakerRole] || '回答者'}</span><h4>{turn.questionText || '本次最希望医生了解的主要困扰'}</h4></div></div>
      <QuestionRecording turn={turn} session={session} />
      <details className="cw-fold cw-answer-fold"><summary><span>文字回答与关联证据</span><small>{turn.answerText?.slice(0, 70)}{turn.answerText?.length > 70 ? '…' : ''}</small></summary><p className="cw-answer-text">{turn.answerText}</p><EvidenceReferences ids={units.map(unit => unit.evidenceId)} byId={byId} onTrace={onTrace} /><p className="ce-help">{turn.qaId} · {new Date(turn.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</p></details>
    </article>)}</div>
  </div></section>;
}
