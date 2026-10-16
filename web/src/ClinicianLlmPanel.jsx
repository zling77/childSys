import React, { useEffect, useRef, useState } from 'react';
import { EvidenceReferences } from './ClinicianEvidenceViews.jsx';

const API = import.meta.env.VITE_API_URL ?? '/api';
const labels = { main_symptoms: '主要表现', course: '病程与频率', functional_impact: '功能影响', background_context: '诱因与背景', physical_and_developmental_history: '睡眠、躯体与发育史', prior_help_and_treatment: '既往求助与干预', goals_and_strengths: '求助目标与支持资源', differences: '来源差异', verification: '待核实事项' };
const relationLabels = { supports: '一致陈述', supplements: '增加细节', contradicts: '候选分歧', corrects: '明确修正', not_comparable: '范围不同', unknown: '关系未决' };
const contextLabels = { home: '家庭', school: '学校', clinic: '门诊', online: '线上', unknown: '场景未明' };
const stageLabels = { extract: '抽取原文证据', relations: '比较证据关系', expression: '整理医生版表达' };
const uniq = units => [...new Map(units.map(u => [`${u.sourceIdentity}:${u.claim}:${u.referenced_time_span?.raw_text}`, u])).values()];
async function call(caseId, body) {
  const response = await fetch(`${API}/previsit/clinician/cases/${encodeURIComponent(caseId)}/llm`, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'LLM 分析失败');
  return data;
}

export function ClinicianLlmPanel({ bundle, historical, onResult, onTrace }) {
  const caseId = bundle.clinicalCase.caseId;
  const [result, setResult] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [tab, setTab] = useState('doctor'), [trace, setTrace] = useState(null), [elapsed, setElapsed] = useState(0);
  const active = useRef(caseId), revision = useRef(0), job = useRef(0);
  useEffect(() => {
    active.current = caseId; const token = ++revision.current;
    setResult(null); setError(''); setTrace(null); setBusy(false); setElapsed(0);
    call(caseId).then(data => { if (active.current === caseId && revision.current === token) setResult(data); }).catch(e => { if (active.current === caseId && revision.current === token) setError(e.message); });
    return () => { revision.current += 1; };
  }, [caseId, bundle.clinicalCase.evidenceRevision]);
  useEffect(() => { onResult?.(result ? { ...result, caseId } : null); }, [result, caseId, onResult]);
  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    const clock = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    const poll = setInterval(() => { call(caseId).then(data => { if (active.current === caseId) setResult(data); }).catch(() => {}); }, 2500);
    return () => { clearInterval(clock); clearInterval(poll); };
  }, [busy, caseId]);
  async function generate(force = false) {
    const token = ++job.current;
    setBusy(true); setError(''); setElapsed(0);
    try {
      const data = await call(caseId, { force });
      if (active.current === caseId && job.current === token) { setResult(data); setTab('doctor'); }
    } catch (e) { if (active.current === caseId && job.current === token) setError(e.message); }
    finally { if (active.current === caseId && job.current === token) setBusy(false); }
  }
  const analysis = result?.analysis, llmUnits = analysis?.state.evidenceUnits ?? [], ruleUnits = bundle.evidenceState.evidenceUnits;
  const byId = new Map([...ruleUnits, ...llmUnits].map(u => [u.evidenceId, u]));
  const traceUnit = byId.get(trace);
  const ruleRelations = bundle.evidenceState.evidenceRelations;
  const grouped = Object.entries(labels).map(([key, label]) => ({ key, label, rows: analysis?.doctorStatements.filter(s => s.section === key) ?? [] })).filter(g => g.rows.length);
  const showTrace = id => onTrace ? onTrace(id) : setTrace(id);
  const citations = ids => <EvidenceReferences ids={ids} byId={byId} onTrace={showTrace} />;
  const integrated = analysis?.doctorStatements.filter(row => row.section === 'integrated_assessment') ?? [];
  const overviewRows = [...integrated, ...(analysis?.doctorStatements.filter(row => row.section === 'differences' && !integrated.some(summary => row.evidenceIds.every(id => summary.evidenceIds.includes(id)))) ?? [])];
  const doctor = <div className="cl-doctor">{grouped.map(group => <section key={group.key}><h4>{group.label}</h4>{group.rows.map((row, index) => <article key={index}><p>{row.text}</p><div className="ce-provenance"><span>{[...new Set(row.evidenceIds.map(id => { const u = byId.get(id); return u ? `${u.sourceLabel} · ${u.referenced_time_span.raw_text || '时间未明'}` : ''; }))].join('；')}</span></div><div>{citations(row.evidenceIds)}{row.origin === 'validation-fallback' && <small>校验后保留的原文提示</small>}</div></article>)}</section>)}</div>;
  return <section className="ed-panel cl-panel" aria-label="规则版与LLM版对照">
    <div className="ed-panel-header"><h3>AI 整合总结</h3><span>{result ? result.enabled ? result.model : '医生端模型未启用' : '正在读取模型配置'}</span></div>
    <div className="ce-panel-body">
      <div className="cl-controls"><button type="button" className="ed-inline-primary" disabled={busy || !result?.enabled || historical} onClick={() => generate(false)}>{busy ? `${stageLabels[result?.stage] || '模型分析中'} · ${elapsed}秒` : !analysis ? '生成 AI 整合总结' : result.stale ? '更新 AI 整合总结' : '读取已保存的总结'}</button>
        {analysis && <button type="button" className="ed-inline-secondary" disabled={busy || !result?.enabled || historical} onClick={() => generate(true)}>重新分析</button>}
        {analysis && <small>证据版本 {analysis.evidenceRevision} · {(analysis.totalMs / 1000).toFixed(1)}秒 · 已保存</small>}
      </div>
      <p className="ce-help">整合主要困扰、时间与功能影响，保留来源差异和待核实点。以下是材料整理结论，需由医生结合原文与原始录音判断。</p>
      {historical && <p className="ce-help">本面板为当前材料的独立 LLM 分析；下方历史规则报告按所选版本显示。返回最新视图后可生成模型版。</p>}
      {result?.stale && <div className="ce-update-banner">材料、核实记录或模型配置已更新。此模型版属于旧版本，请更新后使用。</div>}
      {error && <p className="error" role="alert">{error} 规则版仍可查看。</p>}
      {!analysis ? <p className="cl-empty">尚未生成 AI 总结。分类证据和逐题问答已可直接查看。</p> : <>
        {!!analysis.warnings.length && <p className="cl-warning">校验记录：{analysis.warnings.join('；')}。未通过的表述不作为总结结论。</p>}
        <div className="cw-integrated-summary"><div className="cw-summary-kicker">材料整合结论 <span>待医生核实</span></div>{overviewRows.length ? overviewRows.map((row, index) => <article key={index}><p>{row.text}</p>{citations(row.evidenceIds)}{row.origin === 'validation-fallback' && <small>校验后保留的原文提示</small>}</article>) : <p className="ce-help">当前已保存报告没有单独的整合结论，可更新后生成。下方保留原分类摘要。</p>}</div>
        <details className="cw-fold cl-detail-fold"><summary>分类摘要、证据关系与接入前后对照</summary>
        <div className="cl-tabs" role="tablist" aria-label="LLM分析视图">{[['compare', '并排对照'], ['doctor', 'LLM 医生版'], ['evidence', '抽取证据'], ['relations', '关系初判']].map(([key, label]) => <button type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} key={key} onClick={() => setTab(key)}>{label}</button>)}</div>
        {tab === 'compare' && <>
          <div className="cl-metrics"><span>规则证据 <b>{analysis.statistics.ruleEvidence}</b></span><span>LLM证据 <b>{analysis.statistics.llmEvidence}</b></span><span>规则分歧主题 <b>{analysis.statistics.ruleDisputedTopics}</b></span><span>LLM分歧主题 <b>{analysis.statistics.llmDisputedTopics}</b></span><span>原文定位通过 <b>{analysis.statistics.traceableEvidence}/{analysis.statistics.llmEvidence}</b></span></div>
          <p className="ce-help">证据粒度不同，条数增加或减少均不代表准确率变化。“原文定位通过”仅检查引用位置。</p>
          <div className="cl-columns"><section><div className="cl-column-title">接入前 · 规则版</div><p className="cl-rule-overview">{bundle.currentContent.summary}</p>{uniq(ruleUnits.filter(u => !u.superseded)).map(u => <article className="cl-rule-statement" key={u.evidenceId}><p>{u.claim}</p><small>{u.sourceLabel} · {u.referenced_time_span.raw_text || '时间未明'}</small>{citations([u.evidenceId])}</article>)}<h4>规则关系</h4>{ruleRelations.length ? ruleRelations.map(r => <p className="cl-relation-note" key={r.relationId}><b>{relationLabels[r.semanticRelation]}</b> · {r.rationale}</p>) : <p className="ce-help">没有形成可比关系。</p>}</section>
            <section><div className="cl-column-title cl-llm-title">接入后 · LLM 医生版</div>{doctor}<h4>模型关系初判</h4>{analysis.state.evidenceRelations.length ? analysis.state.evidenceRelations.map(r => <p className="cl-relation-note" key={r.relationId}><b>{relationLabels[r.semanticRelation]}</b> · {r.rationale}{r.guarded && <small>（范围校验调整）</small>}</p>) : <p className="ce-help">暂无跨来源或跨轮次可比关系。</p>}</section></div>
        </>}
        {tab === 'doctor' && doctor}
        {tab === 'evidence' && <div className="ed-table-wrap"><table className="ed-table"><thead><tr><th>证据原文</th><th>来源与时间</th><th>主题／字段</th><th>极性</th><th>追溯</th></tr></thead><tbody>{llmUnits.map(u => <tr key={u.evidenceId}><td>{u.claim}{u.superseded && <small>已修正的原记录</small>}</td><td>{u.sourceLabel}<br />{u.referenced_time_span.raw_text || '时间未明'}</td><td>{u.topicLabel}／{u.facetLabel}</td><td>{{ affirmed: '肯定', negated: '否定', uncertain: '不确定' }[u.polarity]}</td><td>{citations([u.evidenceId])}</td></tr>)}</tbody></table></div>}
        {tab === 'relations' && <div className="ce-relations">{analysis.state.evidenceRelations.map(r => <article className="ce-relation" key={r.relationId}><b>{relationLabels[r.semanticRelation]} · 系统候选</b><div className="ce-pair">{[r.priorEvidenceId, r.newEvidenceId].map(id => <section key={id}><p>{byId.get(id)?.claim}</p><small>{byId.get(id)?.sourceLabel}</small>{citations([id])}</section>)}</div><p>{r.rationale}</p>{r.guarded && <p>范围校验调整了模型建议，双方原文保留。</p>}</article>)}</div>}
        <details className="cl-audit"><summary>生成与校验记录</summary><p>模型：抽取 {analysis.models.extract}；关系 {analysis.models.relations}；表达 {analysis.models.expression}。</p><p>提示词版本 {analysis.promptVersion} · 总耗时 {(analysis.totalMs / 1000).toFixed(1)}秒 · 关系范围调整 {analysis.statistics.guardedRelations}项</p>{analysis.audits.map(a => <p key={a.stage}>{stageLabels[a.stage]}：{(a.latencyMs / 1000).toFixed(1)}秒；输出 {a.outputTokens ?? 0} tokens。</p>)}</details>
        </details>
      </>}
    </div>
    {traceUnit && <div className="ce-drawer-backdrop" onClick={() => setTrace(null)}><aside className="ce-drawer" role="dialog" aria-modal="true" aria-label="LLM证据原文追溯" onClick={e => e.stopPropagation()}><header><h3>证据原文追溯</h3><button type="button" onClick={() => setTrace(null)}>关闭</button></header><code>{traceUnit.evidenceId}</code><h4>来源与范围</h4><p>{traceUnit.sourceLabel} · {traceUnit.sourceMode === 'reported' ? '转述材料' : '直接提供'} · {contextLabels[traceUnit.observationContext]}</p><p>{traceUnit.topicLabel}／{traceUnit.facetLabel} · {traceUnit.referenced_time_span.raw_text || '指向时间未明'}</p><h4>完整原文与支撑片段</h4><p className="ce-original">{traceUnit.originalText.slice(0, traceUnit.traceRef.start)}<mark>{traceUnit.originalText.slice(traceUnit.traceRef.start, traceUnit.traceRef.end)}</mark>{traceUnit.originalText.slice(traceUnit.traceRef.end)}</p><p className="ce-help">精确引用可以核对模型依据；仍需人工判断引用是否充分支持表述。</p></aside></div>}
  </section>;
}
