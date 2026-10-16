import React, { useCallback, useEffect, useRef, useState } from 'react';
import './clinician.css';
import { ClinicianLlmPanel } from './ClinicianLlmPanel.jsx';
import { ClassifiedEvidence, QuestionEvidence, RiskClues } from './ClinicianEvidenceViews.jsx';
import { EvidenceRecording, QuestionRecording } from './QuestionRecording.jsx';
import { combineCurrentEvidence, clinicianRiskLabels, groupClinicianEvidence } from '../../core/clinicianPresentation.mjs';

const API = import.meta.env.VITE_API_URL ?? '/api';
const roles = { child: '患儿', caregiver: '监护人', teacher_school: '教师／学校', scale: '量表', clinical_record: '既往记录', clinician: '医生补充', other: '其他来源' };
const semanticLabels = { supports: '一致陈述', supplements: '增加细节', corrects: '明确修正', contradicts: '来源分歧', not_comparable: '场景不同', unknown: '待核实' };
const temporalLabels = { before: '旧证据时段早于新证据', after: '旧证据时段晚于新证据', same_window: '同一时间窗', overlaps: '时间窗部分重叠', contains: '旧时间窗包含新时间窗', contained_by: '新时间窗包含旧时间窗', unknown: '时间关系未明' };
const statusLabels = { reported: '已取得陈述', disputed: '存在分歧', pending_review: '待核实', missing: '缺失', completed: '采集结束', in_progress: '采集中', needs_clinician_review: '需优先核实' };
const reviewLabels = { seen: '已查看', needs_followup: '需补充', reviewed: '已记录核实结果' };
const contexts = { home: '家庭', school: '学校', clinic: '门诊', online: '线上', unknown: '场景未明' };
const eventLabels = { evidence_added: '新增证据', relation_added: '记录证据关系', correction_registered: '记录修正链', conflict_detected: '保留分歧', state_updated: '更新主题状态', packet_generated: '生成报告', review_recorded: '记录医生核实', material_added: '加入来源材料', session_linked: '关联会话', session_relinked: '移出关联会话', membership_evidence_archived: '保留移出会话的历史证据' };
const sections = [ ['主要表现', 'main_symptoms'], ['病程与频率', 'course'], ['功能影响', 'functional_impact'], ['诱因与背景', 'background_context'], ['睡眠、躯体与发育史', 'physical_and_developmental_history'], ['既往求助与干预', 'prior_help_and_treatment'], ['求助目标与支持资源', 'goals_and_strengths'] ];

async function request(path, body, signal) {
  const response = await fetch(`${API}/previsit/clinician${path}`, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}
async function demoRequest(path) {
  const response = await fetch(`${API}/previsit/demo/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '演示工具执行失败');
  return data;
}
function dateText(value) { return value ? /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? `${value}（仅日期）` : new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '未记录'; }
function sourceText(unit) { return `${unit.sourceLabel || roles[unit.sourceRole]}${unit.sourceMode === 'reported' ? `（转述${roles[unit.reportedSourceRole] || '其他来源'}）` : ''}`; }
function timeText(unit) { const span = unit.referenced_time_span; return span?.raw_text || '指向时间未说明'; }
function sexText(value) { return ({ M: '男', F: '女' })[value] || '性别未填'; }
function uniqueStatements(units) { return [...new Map(units.map((unit) => [`${unit.sourceIdentity}:${unit.traceText}:${timeText(unit)}`, unit])).values()]; }
function Badge({ type, children }) { return <span className={`ce-badge ce-${type || 'reported'}`}>{children}</span>; }
function Panel({ title, meta, children, className = '' }) { return <section className={`ed-panel ${className}`}><div className="ed-panel-header"><h3>{title}</h3>{meta && <span>{meta}</span>}</div><div className="ce-panel-body">{children}</div></section>; }
function EvidenceLink({ id, onTrace }) { return <button type="button" className="ce-evidence-link" onClick={() => onTrace(id)} aria-label={`查看证据 ${id}`}>{id}</button>; }
function Statement({ unit, onTrace, muted = false }) {
  return <article className={`ce-statement${muted ? ' ce-superseded' : ''}`}><p>{unit.claim}</p><div className="ce-provenance"><span>{sourceText(unit)}</span><span>{timeText(unit)}</span><span>{contexts[unit.observationContext]}</span>{unit.superseded && <Badge type="corrects">原记录，已被明确纠正</Badge>}<EvidenceLink id={unit.evidenceId} onTrace={onTrace} /></div></article>;
}

export function ClinicianWorkbench() {
  const [queue, setQueue] = useState([]);
  const [selected, setSelected] = useState(() => new URLSearchParams(window.location.search).get('case'));
  const [filter, setFilter] = useState('all');
  const [bundle, setBundle] = useState(null);
  const [allSessions, setAllSessions] = useState([]);
  const [contracts, setContracts] = useState([]);
  const [online, setOnline] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(false);
  const [traceId, setTraceId] = useState(null);
  const [reviewTarget, setReviewTarget] = useState(null);
  const [viewedPacket, setViewedPacket] = useState(null);
  const [relationFilter, setRelationFilter] = useState('important');
  const [comparison, setComparison] = useState(null);
  const selectedRef = useRef(null);
  const detailCounter = useRef(0);
  const queueCounter = useRef(0);
  const versionCounter = useRef(0);
  const materialRef = useRef(null);
  const [materialTarget, setMaterialTarget] = useState(null);
  const [view, setView] = useState('overview');
  const [llmResult, setLlmResult] = useState(null);
  const onLlmResult = useCallback(result => setLlmResult(result), []);
  const [queueOpen, setQueueOpen] = useState(() => window.innerWidth >= 1100);

  const refreshQueue = useCallback(async () => {
    const token = ++queueCounter.current;
    try {
      const [{ cases }, { sessions }] = await Promise.all([request(`/cases?status=${filter}`), request('/sessions')]);
      if (token !== queueCounter.current) return;
      setQueue(cases); setAllSessions(sessions); setOnline(true);
      setSelected((current) => cases.some((row) => row.caseId === current) ? current : cases[0]?.caseId ?? null);
    } catch (e) { if (token === queueCounter.current) { setOnline(false); setError(e.message); } }
  }, [filter]);

  const loadDetail = useCallback(async (caseId, { resetVersion = true } = {}) => {
    if (!caseId) return;
    const token = ++detailCounter.current;
    setLoading(true);
    try {
      const data = await request(`/cases/${caseId}`);
      if (token !== detailCounter.current || selectedRef.current !== caseId) return;
      setBundle(data);
      if (resetVersion) { setViewedPacket(null); setComparison(null); versionCounter.current += 1; }
      setError('');
    } catch (e) { if (token === detailCounter.current && selectedRef.current === caseId) setError(e.message); }
    finally { if (token === detailCounter.current && selectedRef.current === caseId) setLoading(false); }
  }, []);

  useEffect(() => { refreshQueue(); const timer = setInterval(refreshQueue, 3000); return () => { clearInterval(timer); queueCounter.current += 1; }; }, [refreshQueue]);
  useEffect(() => { request('/contracts').then((data) => setContracts(data.contracts)).catch((e) => setError(e.message)); }, []);
  useEffect(() => {
    selectedRef.current = selected; detailCounter.current += 1; versionCounter.current += 1;
    setBundle(null); setViewedPacket(null); setComparison(null); setTraceId(null); setReviewTarget(null); setNotice(''); setMaterialTarget(null); setLlmResult(null); setView('overview');
    if (selected) loadDetail(selected);
  }, [selected, loadDetail]);

  async function mutate(action, callback) {
    const caseId = selectedRef.current;
    setBusy(action); setError('');
    try {
      const result = await callback(caseId);
      if (selectedRef.current !== caseId) return result;
      if (action === 'packet') setNotice(result.changed ? `已根据当前证据生成医生包版本 ${result.packet.version}。` : '证据及核实记录没有变化，保留原报告版本。');
      else setNotice('记录已保存。可更新报告纳入本次变化。');
      await refreshQueue();
      await loadDetail(caseId);
      return result;
    } catch (e) { if (selectedRef.current === caseId) setError(e.message); throw e; }
    finally { setBusy(''); }
  }
  async function generatePacket() { try { await mutate('packet', (caseId) => request(`/cases/${caseId}/packet`, {})); } catch { /* shown above */ } }
  async function copyInterviewEntry(role) {
    const url = new URL(`/${role}`, window.location.origin);
    url.searchParams.set('caseId', selected);
    try {
      const response = await fetch(`${API}/previsit/access/invitations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ caseId: selected, role }) });
      if (response.status !== 404) {
        if (!response.ok) throw new Error('无法生成病例入口，请确认医生身份验证。');
        const invitation = await response.json();
        if (!invitation.token) throw new Error('病例入口生成失败，请重试。');
        url.searchParams.set('invite', invitation.token);
      }
    } catch (error) { setError(error.message); return; }
    try {
      await navigator.clipboard.writeText(url.href);
      setNotice(`已复制本病例的${role === 'child' ? '儿童' : '家长'}端入口。两端分别作答，不显示另一端答案。`);
    } catch {
      setNotice(`本病例${role === 'child' ? '儿童' : '家长'}端入口：${url.href}`);
    }
  }
  async function selectVersion(version) {
    const token = ++versionCounter.current;
    const caseId = selectedRef.current;
    setTraceId(null); setReviewTarget(null);
    if (version === 'latest') { setViewedPacket(null); return; }
    try { const data = await request(`/cases/${caseId}/packets/${version}`); if (token === versionCounter.current && selectedRef.current === caseId) setViewedPacket(data.packet); } catch (e) { setError(e.message); }
  }
  async function runDemo(path) {
    setBusy(path); setError('');
    try { await demoRequest(path); setSelected(null); setBundle(null); await refreshQueue(); } catch (e) { setError(e.message); } finally { setBusy(''); }
  }
  async function addLlmComparisons() {
    setBusy('llm-fixtures'); setError('');
    try { const data = await request('/llm/comparison-fixtures', {}); await refreshQueue(); setSelected(data.cases[0]?.caseId ?? null); setNotice('已添加完全模拟的 LLM 对照病例，现有病例保留。'); }
    catch (e) { setError(e.message); } finally { setBusy(''); }
  }
  async function addWorkspaceDemo() {
    setBusy('workspace-fixture'); setError('');
    try { const data = await request('/workspace-fixture', {}); await refreshQueue(); setSelected(data.caseId); setNotice('已添加完全模拟的医生工作台病例；原有数据保留，此病例没有真实录音。'); }
    catch (e) { setError(e.message); } finally { setBusy(''); }
  }
  function addCorrection(unit) {
    setView('records');
    setTraceId(null); setReviewTarget(null);
    setMaterialTarget(unit);
    if (materialRef.current) { materialRef.current.open = true; materialRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  }

  const packet = viewedPacket ?? bundle?.packet;
  const content = viewedPacket?.content ?? bundle?.currentContent;
  const state = content?.evidence_state ?? bundle?.evidenceState;
  const units = state?.evidenceUnits ?? [];
  const modelUnits = llmResult?.caseId === selected ? llmResult.analysis?.state.evidenceUnits ?? [] : [];
  const unitsById = new Map([...units, ...modelUnits].map((unit) => [unit.evidenceId, unit]));
  const row = queue.find((item) => item.caseId === selected);
  const historical = !!viewedPacket;
  const currentAnalysis = llmResult?.caseId === selected && !llmResult.stale && !historical ? llmResult.analysis : null;
  const displayUnits = combineCurrentEvidence(units, currentAnalysis?.state.evidenceUnits ?? []);
  const currentRelations = [...(state?.evidenceRelations ?? []), ...(currentAnalysis?.state.evidenceRelations ?? [])];
  const riskTags = clinicianRiskLabels(displayUnits, currentRelations);
  const categoryGroups = groupClinicianEvidence(displayUnits);
  const ruleIds = new Set(units.map(unit => unit.evidenceId));
  const detailStale = row && bundle && row.evidenceRevision > bundle.clinicalCase.evidenceRevision;
  const packetStale = bundle && (!bundle.packet || bundle.packet.evidenceRevision < bundle.clinicalCase.evidenceRevision);
  const traceUnit = unitsById.get(traceId);
  const visibleReviews = viewedPacket?.content?.reviews ?? bundle?.reviews ?? [];
  const relations = (state?.evidenceRelations ?? []).filter((relation) => relationFilter === 'all' || (relationFilter === 'important' ? ['contradicts', 'corrects'].includes(relation.semanticRelation) || ['possible_discrepancy', 'different_time', 'different_context', 'observation_vs_experience'].includes(relation.reasonCode) : relation.semanticRelation === relationFilter));

  return <div className="ed-shell ce-shell">
    <aside className="ed-sidebar cw-case-sidebar">
      <details className="cw-queue-disclosure" open={queueOpen} onToggle={event => setQueueOpen(event.currentTarget.open)}><summary><span>病例队列</span><b>{row?.title || "选择就诊病例"}</b><small>{queue.length}个病例</small></summary>
      <div className="ed-queue-title"><div><b>就诊病例队列</b><span>按同一病例汇集多来源材料</span></div><strong>{queue.length}</strong></div>
      <label className="ed-field-label" htmlFor="clinicalCaseFilter">队列状态</label>
      <select id="clinicalCaseFilter" value={filter} onChange={(e) => setFilter(e.target.value)}><option value="all">全部病例</option><option value="in_progress">采集中</option><option value="completed">采集结束</option><option value="needs_clinician_review">需优先核实</option></select>
      <button className="ed-primary-button" onClick={refreshQueue}>刷新队列</button>
      <div className="ed-queue">{!queue.length && <div className="ed-sidebar-empty">暂无病例，请完成预问诊或生成演示病例。</div>}{queue.map((item) => <button key={item.caseId} onClick={() => { setSelected(item.caseId); const url = new URL(window.location.href); url.searchParams.set("case", item.caseId); window.history.replaceState(null, "", url); if (window.innerWidth < 1100) setQueueOpen(false); }} className={`ed-queue-row${selected === item.caseId ? ' active' : ''}`}><span>{item.profile.age ?? '-'}岁 · {item.profile.grade || '年级未填'}</span><b>{item.title}</b><small>{item.sessionCount}个会话 · {item.evidenceCount}条证据 · {statusLabels[item.status]}</small>{item.riskCount > 0 && <i>需优先核实</i>}{item.conflictCount > 0 && <small>{item.conflictCount}个主题存在分歧</small>}</button>)}</div>
      <details className="ed-demo-tools"><summary>演示数据工具</summary><div><button className="ed-secondary-button" disabled={!!busy} onClick={addWorkspaceDemo}>添加医生工作台演示（完全模拟）</button><button className="ed-secondary-button" disabled={!!busy} onClick={addLlmComparisons}>添加 LLM 对照病例（保留现有数据）</button><button className="ed-secondary-button" disabled={!!busy} onClick={() => runDemo('seed')}>生成演示病例</button><p className="ce-help">“生成演示病例”会清空本副本数据库，并创建预问诊及论文演示病例。</p><button className="ed-danger-button" disabled={!!busy} onClick={() => runDemo('reset')}>清空演示数据</button></div></details>
      </details>
      <div className={`ed-health${online === false ? ' ce-offline' : ''}`}><span />{online === null ? '正在检测服务' : online ? '病例服务连接正常' : '病例服务连接失败'}</div>
    </aside>
    <main className="ed-main">
      {error && <div className="error" role="alert">{error}</div>}
      {notice && <div className="ce-notice" role="status">{notice}</div>}
      {selected && !bundle ? <Panel title="正在加载病例"><p>加载病例证据与报告…</p></Panel> : !bundle ? <Panel title="请选择一个病例"><p>关联来源、核实分歧和查看证据形成过程。</p></Panel> : <>
        <section className="ed-topbar"><div><div className="ed-topbar-kicker">{bundle.clinicalCase.caseId}</div><h2>{bundle.clinicalCase.profile.age ?? '-'}岁 · {sexText(bundle.clinicalCase.profile.sex)} · {bundle.clinicalCase.profile.grade || '年级未填'}</h2><p>{bundle.clinicalCase.title}</p><small>证据版本 {bundle.clinicalCase.evidenceRevision} · {bundle.sessions.length}个关联会话</small></div><div className="ed-topbar-side"><Badge type={row?.riskCount ? 'risk' : 'reported'}>{row?.riskCount ? '需优先核实' : '来源陈述待医生核对'}</Badge><button className="ed-inline-secondary" disabled={loading || !!busy} onClick={() => loadDetail(selected)}>刷新病例详情</button></div></section>
        {detailStale && <div className="ce-update-banner" role="status">当前病例有新证据。<button onClick={() => loadDetail(selected)}>载入最新证据</button></div>}
        <details className="cw-fold"><summary>本病例的独立预问诊入口</summary><div className="ce-report-actions"><button className="ed-inline-secondary" onClick={() => copyInterviewEntry('child')}>复制儿童端入口</button><button className="ed-inline-secondary" onClick={() => copyInterviewEntry('guardian')}>复制家长端入口</button></div><p className="ce-help">仅为同一患儿使用这些入口。每端独立保存回答；其他来源只提示关注领域，不向受访者展示原话。未使用病例入口的会话仍可在材料与历史中明确关联。</p></details>
        {historical && <div className="ce-update-banner">正在查看历史报告 v{viewedPacket.version}。核实及材料操作在最新证据视图中进行。<button onClick={() => selectVersion('latest')}>返回最新视图</button></div>}
        <div className="cw-case-facts"><span><b>{bundle.sessions.length}</b>个来源会话</span><span><b>{displayUnits.length}</b>条当前陈述</span><span><b>{bundle.sessions.flatMap(session => session.turns).length}</b>个问答</span><span><b>{bundle.sessions.flatMap(session => session.mediaRecords ?? []).length}</b>个录音／视频附件</span></div>
        <nav className="cw-workspace-tabs" aria-label="病例工作区">{[['overview', '病例概览'], ['evidence', '分类证据'], ['questions', '问答与录音'], ['differences', '差异与核实'], ['records', '材料与历史']].map(([key, label]) => <button type="button" key={key} className={view === key ? 'active' : ''} aria-current={view === key ? 'page' : undefined} onClick={() => setView(key)}>{label}</button>)}</nav>
        <div hidden={view !== 'overview'}><ClinicianLlmPanel key={bundle.clinicalCase.caseId} bundle={bundle} historical={historical} onResult={onLlmResult} onTrace={setTraceId} /></div>
        {view === 'overview' && <>
          <RiskClues tags={riskTags} byId={unitsById} onTrace={setTraceId} reviews={visibleReviews} ruleIds={ruleIds} onReview={setReviewTarget} disabled={historical} />
          <Panel title="证据分类概览" meta="按临床问诊主题组织"><div className="cw-at-a-glance">{categoryGroups.map(group => <button type="button" key={group.id} onClick={() => setView('evidence')}><span>{group.label}</span><b>{group.units.length}<small>条陈述</small></b></button>)}</div></Panel>
          <Panel title="待核实与信息缺口" meta="缺失不等于否认"><div className="cw-gap-preview">{(content.missing_information ?? []).slice(0, 3).map(issue => <article key={issue.issue_id}><b>{issue.label}</b><p>{issue.note}</p><ReviewButton kind="issue" id={issue.issue_id} reviews={visibleReviews} disabled={historical} onReview={setReviewTarget} /></article>)}</div><button type="button" className="cw-text-button" onClick={() => setView('differences')}>查看全部核实事项 →</button></Panel>
          <details className="cw-fold cw-legacy-summary"><summary>规则摘要、报告保存与版本回看</summary>
        <Panel title="结构化预问诊摘要" meta={viewedPacket ? `医生包版本 ${packet.version} · 证据版本 ${packet.evidenceRevision} · 历史机器草稿` : bundle.packet ? `规则版 · 医生包版本 ${bundle.packet.version} · 当前证据版本 ${bundle.clinicalCase.evidenceRevision}${packetStale ? ' · 预览尚未保存' : ' · 机器草稿'}` : '规则版当前证据预览 · 报告尚未保存'}>
          <div className="ce-report-actions"><button className="ed-inline-primary" disabled={!!busy || historical || !packetStale} onClick={generatePacket}>{busy === 'packet' ? '生成中…' : !bundle.packet ? '生成预问诊摘要' : packetStale ? '更新结构化摘要' : '摘要已是最新'}</button>{bundle.packetHistory.length > 0 && <label>报告历史 <select aria-label="报告历史版本" value={viewedPacket?.version ?? 'latest'} onChange={(e) => selectVersion(e.target.value)}><option value="latest">当前证据视图</option>{bundle.packetHistory.map((p) => <option key={p.version} value={p.version}>v{p.version} · {dateText(p.createdAt)}</option>)}</select></label>}</div>
          {packetStale && !historical && <p className="ce-help">当前预览已纳入最新证据与核实记录，尚未保存为新报告。保存后可在报告历史中回看此快照。</p>}
          <p className="ce-summary-lead">{content.summary}</p><div className="ce-summary-grid">{sections.map(([title, key], index) => <SummarySection key={key} title={title} rows={content[key] ?? []} unitsById={unitsById} onTrace={setTraceId} collapsible={index > 3} />)}</div>
        </Panel>
          </details>
        </>}
        {view === 'evidence' && <ClassifiedEvidence key={selected} units={displayUnits} byId={unitsById} sessions={bundle.sessions} onTrace={setTraceId} />}
        {view === 'questions' && <QuestionEvidence key={selected} sessions={bundle.sessions} units={displayUnits} byId={unitsById} onTrace={setTraceId} />}
        {view === 'differences' && <>
        <Panel title="需优先核实" meta="核实记录与证据状态分别保存">
          <div className="ce-priority-grid"><section><h4>风险相关原话</h4>{(content?.risk_notes ?? units.filter((u) => u.riskFlag).map((u) => ({ evidence_id: u.evidenceId }))).length ? (content?.risk_notes ?? units.filter((u) => u.riskFlag).map((u) => ({ evidence_id: u.evidenceId }))).map((risk) => { const unit = unitsById.get(risk.evidence_id); return unit && <article className="ce-risk-card" key={unit.evidenceId}><Statement unit={unit} onTrace={setTraceId} /><ReviewButton kind="risk" id={unit.evidenceId} reviews={visibleReviews} disabled={historical} onReview={setReviewTarget} /></article>; }) : <p>未记录风险相关原话；不能据此认定已排除风险。</p>}</section>
            <section><h4>缺失与待核实字段</h4><details className="ce-missing-details"><summary>查看缺失与待核实字段</summary><div className="ce-missing-list">{(content?.missing_information ?? state.topicStates.flatMap((topic) => topic.facets.filter((f) => f.required && !f.evidenceIds.length).map((f) => ({ issue_id: `${topic.topicId}:${f.facetId}`, label: `${topic.label}／${f.label}`, note: '尚未取得可追溯证据。' })))).map((issue) => <article key={issue.issue_id}><b>{issue.label}</b><p>{issue.note}</p><ReviewButton kind="issue" id={issue.issue_id} reviews={visibleReviews} disabled={historical} onReview={setReviewTarget} /></article>)}</div></details></section></div>
        </Panel>
        <Panel title="来源差异与时序变化" meta={`${state.evidenceRelations.length}条关系 · ${state.revisionChains.length}条修正链`}>
          <label className="ce-filter">查看关系 <select value={relationFilter} onChange={(e) => setRelationFilter(e.target.value)}><option value="important">分歧、修正与范围差异</option><option value="supports">一致陈述</option><option value="supplements">增加细节</option><option value="all">全部关系（含未决）</option></select></label>
          {!relations.length && <p className="ed-empty">当前筛选下没有关系。来源、时间或命题不足时，系统保留未决原因。</p>}
          <div className="ce-relations">{relations.map((relation) => <article key={relation.relationId} className="ce-relation"><div className="ce-relation-head"><Badge type={relation.semanticRelation}>{semanticLabels[relation.semanticRelation]}</Badge><span>{temporalLabels[relation.temporalRelation]}</span><small>系统候选，待核实</small></div><div className="ce-pair">{[relation.priorEvidenceId, relation.newEvidenceId].map((id, i) => <section key={id}><b>{i ? '后进入的证据' : '先进入的证据'}</b>{unitsById.get(id) && <Statement unit={unitsById.get(id)} onTrace={setTraceId} muted={unitsById.get(id).superseded} />}</section>)}</div><p>{relation.rationale}</p><ReviewButton kind="relation" id={relation.relationId} reviews={visibleReviews} disabled={historical} onReview={setReviewTarget} /></article>)}</div>
        </Panel>
        <Panel title="主题证据状态" meta="来源陈述及分歧，均不等于临床确认"><details className="ce-inline-details"><summary>展开各主题的证据状态</summary><div className="ce-topic-grid">{state.topicStates.filter((t) => t.evidenceIds.length).map((topic) => <article key={topic.topicId}><div><b>{topic.label}</b><Badge type={topic.status}>{statusLabels[topic.status]}</Badge></div>{uniqueStatements(topic.effectiveEvidenceIds.map((id) => unitsById.get(id)).filter(Boolean)).map((unit) => <Statement key={unit.evidenceId} unit={unit} onTrace={setTraceId} />)}</article>)}</div></details></Panel>
        </>}
        {view === 'records' && <>
        <Panel title="来源与会话" meta="缺少某一来源不等于病例不合格">
          <div className="ce-source-overview">{Object.entries(roles).map(([role, label]) => { const count = units.filter((u) => u.sourceRole === role).length; return <span className={count ? 'available' : ''} key={role}><b>{label}</b>{count ? `${count}条证据` : '尚未提供'}</span>; })}</div>
          <details className="ce-inline-details"><summary>关联同一患儿的独立会话</summary><p className="ce-help">确认属于同一患儿及本次就诊后再关联。移出会话可恢复为独立病例，历史报告保留。</p><AssociationForm sessions={allSessions.filter((s) => s.caseId !== selected)} disabled={!!busy || historical} onSubmit={async (sessionId) => mutate('associate', (caseId) => request(`/cases/${caseId}/sessions`, { sessionId }))} />
            <div className="ce-session-list">{bundle.sessions.map((session) => <article key={session.sessionId}><code>{session.sessionId}</code><p>{session.chiefComplaint || '主诉未填'}</p><small>采集覆盖 {session.progress?.percent ?? 0}% · {session.turns.length}轮；仅表示信息采集进度</small>{bundle.sessions.length > 1 && <button disabled={!!busy || historical} onClick={async () => { try { await mutate('detach', (caseId) => request(`/cases/${caseId}/sessions/${session.sessionId}/detach`, {})); } catch { /* shown */ } }}>移出本病例</button>}</article>)}</div>
          </details>
        </Panel>
        <Panel title="材料与医生补充"><details ref={materialRef} className="ce-inline-details"><summary>添加学校、量表、既往记录或医生核实材料</summary><p className="ce-help">保留提供者与材料原文。材料时间、观察场景和指向时间没有说明时，系统保留未知。</p><MaterialForm contracts={contracts} target={materialTarget} disabled={!!busy || historical} onCancelTarget={() => setMaterialTarget(null)} onSubmit={async (input) => { await mutate('material', (caseId) => request(`/cases/${caseId}/materials`, input)); setMaterialTarget(null); }} /></details>{bundle.materials.length > 0 && <div className="ce-material-list">{bundle.materials.map((m) => <article key={m.materialId}><b>{m.sourceLabel || roles[m.sourceRole]}</b><small> · {dateText(m.createdAt)}</small><p>{m.text}</p></article>)}</div>}</Panel>
        <Panel title="更新历史与报告比较" meta={`${bundle.events.length}条事件`}><VersionCompare history={bundle.packetHistory} disabled={!!busy} comparison={comparison} onCompare={async (from, to) => { const caseId = selectedRef.current; const result = await request(`/cases/${caseId}/compare?from=${from}&to=${to}`); if (selectedRef.current === caseId) setComparison(result); }} />
          <details className="ce-inline-details"><summary>查看状态形成记录</summary><div className="ce-event-list">{[...bundle.events].reverse().map((event) => <article key={event.eventId}><b>{eventLabels[event.eventType] || event.eventType}</b><small>证据版本 {event.evidenceRevision} · {dateText(event.createdAt)}</small><p>{event.detail.rationale || event.detail.note || event.detail.note === '' ? event.detail.rationale || event.detail.note : event.detail.evidenceId || event.detail.materialId || event.detail.sessionId || (event.detail.version ? `报告版本 ${event.detail.version}` : `证据 ${event.detail.evidenceCount ?? '-'}条，关系 ${event.detail.relationCount ?? '-'}条`)}</p></article>)}</div></details>
        </Panel>
          <details className="cw-fold"><summary>采集覆盖、完整证据表与技术明细</summary>
        <Panel title="采集过程明细" meta={`${units.length}条证据`}><details className="ce-inline-details"><summary>{new Set(bundle.sessions.flatMap((s) => s.turns.map((t) => t.speakerRole))).size > 1 ? '多源问答时间线' : '问答输入时间线'}</summary><div className="ce-provenance">{['guardian','child'].map((role) => { const n = bundle.sessions.flatMap((s) => s.turns).filter((t) => t.speakerRole === role).length; return n > 0 && <span key={role}>{role === 'child' ? '患儿' : '监护人'} {n} 条</span>; })}</div>{bundle.sessions.map((s) => <section key={s.sessionId} className="ce-qa-section"><b>{s.sessionId}</b>{s.turns.map((turn) => <article key={turn.qaId} className="ce-qa-card"><code>{turn.qaId}</code><p><b>系统提问：</b>{turn.questionText || '开放式主诉入口'}</p><p><b>{turn.speakerRole === 'child' ? '患儿' : '监护人'}回答：</b>{turn.answerText}</p><div>{units.filter((u) => u.traceRef.qaId === turn.qaId).map((u) => <EvidenceLink key={u.evidenceId} id={u.evidenceId} onTrace={setTraceId} />)}</div></article>)}</section>)}</details>
          <details className="ce-inline-details"><summary>证据原文追溯</summary><div className="ed-table-wrap"><table className="ed-table"><thead><tr><th>证据</th><th>来源</th><th>主题与字段</th><th>指向时间</th><th>极性</th><th>结构化陈述</th></tr></thead><tbody>{units.map((u) => <tr key={u.evidenceId}><td><EvidenceLink id={u.evidenceId} onTrace={setTraceId} />{u.superseded && <small>历史修正记录</small>}</td><td>{sourceText(u)}</td><td>{u.topicLabel}／{u.facetLabel}</td><td>{timeText(u)}</td><td>{{ affirmed: '肯定', negated: '否定', uncertain: '不确定' }[u.polarity]}</td><td>{u.claim}</td></tr>)}</tbody></table></div></details>
          <details className="ce-inline-details"><summary>采集覆盖状态</summary>{bundle.sessions.map((s) => <section key={s.sessionId}><b>{s.sessionId} · 采集覆盖 {s.progress?.percent ?? 0}%</b><div className="ce-coverage-grid">{s.slotStates.filter((t) => t.value?.facets).map((t) => <article key={t.slotId}><b>{t.label}</b><span>{{ filled: '已采集', partial: '部分信息', missing: '缺失', ambiguous: '待核实', conflict: '采集记录有分歧' }[t.status] || t.status}</span><p>{t.value?.text}</p></article>)}</div></section>)}</details>
        </Panel>
          </details>
        {bundle.sessions.some((s) => s.mediaRecords?.length) && <Panel title="音视频附件" meta="供回放核实；尚未实现证据片段精确定位">{bundle.sessions.flatMap((s) => s.mediaRecords ?? []).map((m) => <article className="ce-media" key={m.mediaId}><b>{m.modality === 'video' ? '视频' : '音频'} · {m.sessionId}</b>{m.modality === 'video' ? <video controls src={`${API}/previsit/media/blob/${m.mediaId}`} /> : <audio controls src={`${API}/previsit/media/blob/${m.mediaId}`} />}<a href={`${API}/previsit/media/blob/${m.mediaId}`} download>下载原始文件</a></article>)}</Panel>}
        </>}
        <p className="ce-boundary">研究原型 · AI 结论与风险标签用于整理来源材料，需医生结合原文及原始录音判断。</p>
      </>}
    </main>
    {(traceUnit || reviewTarget) && <TraceDrawer unit={traceUnit} reviewTarget={reviewTarget ?? (traceUnit ? { kind: 'evidence', id: traceUnit.evidenceId } : null)} unitsById={unitsById} bundle={bundle} reviews={visibleReviews} historical={historical} disabled={!!busy} onClose={() => { setTraceId(null); setReviewTarget(null); }} onCorrection={addCorrection} onSubmit={async (input) => { await mutate('review', (caseId) => request(`/cases/${caseId}/reviews`, input)); setReviewTarget(null); }} />}
  </div>;
}

function SummarySection({ title, rows, unitsById, onTrace, collapsible }) {
  const body = <>{!rows.length ? <p className="ce-empty">尚未取得此主题的可追溯证据</p> : rows.map((row) => { const statements = uniqueStatements(row.evidence_ids.map((id) => unitsById.get(id)).filter(Boolean)); return <article className="ce-summary-topic" key={row.slot_id}><div><b>{row.label}</b><Badge type={row.status}>{statusLabels[row.status]}</Badge></div>{statements.slice(0,4).map((unit) => <Statement key={unit.evidenceId} unit={unit} onTrace={onTrace} />)}{statements.length > 4 && <details className="ce-more-statements"><summary>查看其余{statements.length - 4}条陈述</summary>{statements.slice(4).map((unit) => <Statement key={unit.evidenceId} unit={unit} onTrace={onTrace} />)}</details>}</article>; })}</>;
  return collapsible ? <details className="ce-summary-section"><summary>{title}</summary>{body}</details> : <section className="ce-summary-section"><h4>{title}</h4>{body}</section>;
}
function ReviewButton({ kind, id, reviews, onReview, disabled }) {
  const latest = [...reviews].reverse().find((r) => r.targetKind === kind && r.targetId === id);
  return <div className="ce-review-state">{latest && <span>{reviewLabels[latest.status]}{latest.note ? `：${latest.note}` : ''}</span>}<button disabled={disabled} onClick={() => onReview({ kind, id })}>{latest ? '补充核实记录' : '记录查看／核实'}</button></div>;
}
function AssociationForm({ sessions, disabled, onSubmit }) {
  const [sessionId, setSessionId] = useState(''); const [verified, setVerified] = useState(false); const [error, setError] = useState('');
  useEffect(() => { if (!sessions.some((s) => s.sessionId === sessionId)) setSessionId(''); }, [sessions, sessionId]);
  return <form className="ce-association-form" onSubmit={async (e) => { e.preventDefault(); try { await onSubmit(sessionId); setSessionId(''); setVerified(false); setError(''); } catch (err) { setError(err.message); } }}><label>待关联会话<select aria-label="待关联会话" required value={sessionId} onChange={(e) => { setSessionId(e.target.value); setVerified(false); }}><option value="">请选择会话</option>{sessions.map((s) => <option key={s.sessionId} value={s.sessionId}>{s.profile.age ?? '-'}岁 · {s.profile.respondent === 'child' ? '患儿' : '监护人'} · {s.chiefComplaint.slice(0, 28)} · {s.sessionId}</option>)}</select></label><label className="ce-check"><input type="checkbox" checked={verified} onChange={(e) => setVerified(e.target.checked)} />已确认属于同一患儿及本次就诊</label><button className="ed-inline-primary" disabled={disabled || !sessionId || !verified}>关联会话</button>{error && <p className="error" role="alert">{error}</p>}</form>;
}
function MaterialForm({ contracts, target, disabled, onCancelTarget, onSubmit }) {
  const blank = { sourceRole: 'teacher_school', sourceMode: 'direct', reportedSourceRole: 'teacher_school', sourceLabel: '', text: '', observedTime: '', observationContext: 'unknown', slotId: '', facetId: '', start: '', end: '' };
  const [form, setForm] = useState(blank); const [error, setError] = useState('');
  useEffect(() => { if (target) setForm({ ...blank, sourceRole: 'clinician', slotId: target.slotId, facetId: target.facetId, observationContext: target.observationContext, start: target.referenced_time_span.start ?? '', end: target.referenced_time_span.end ?? '' }); }, [target]);
  const field = (name) => ({ value: form[name], onChange: (e) => setForm((f) => ({ ...f, [name]: e.target.value, ...(name === 'slotId' ? { facetId: '' } : {}) })) });
  const contract = contracts.find((c) => c.slotId === form.slotId);
  return <form className="ce-material-form" onSubmit={async (e) => { e.preventDefault(); setError(''); if ((form.start && !form.end) || (!form.start && form.end)) { setError('请同时填写起止日期，或均留空。'); return; } try { await onSubmit({ ...form, observedTime: form.observedTime || null, slotId: form.slotId || null, facetId: form.facetId || null, reportedSourceRole: form.sourceMode === 'reported' ? form.reportedSourceRole : null, referencedTimeSpan: form.start ? { start: form.start, end: form.end } : null, correctsEvidenceId: target?.evidenceId ?? null }); setForm(blank); } catch (err) { setError(err.message); } }}>
    {target && <div className="ce-update-banner">纠正目标：{target.evidenceId} · {target.claim}<button type="button" onClick={() => { onCancelTarget(); setForm(blank); }}>取消纠正，改为普通材料</button></div>}
    <div className="ce-form-grid"><label>提供来源<select {...field('sourceRole')} disabled={!!target}>{Object.entries(roles).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label>来源方式<select {...field('sourceMode')}><option value="direct">直接提供</option><option value="reported">转述材料</option></select></label>{form.sourceMode === 'reported' && <label>被转述来源<select {...field('reportedSourceRole')}>{Object.entries(roles).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}<label>来源说明（可选）<input {...field('sourceLabel')} maxLength={200} placeholder="如学校反馈、量表记录" /></label><label>材料形成时间（可选）<input type="date" {...field('observedTime')} /></label><label>观察场景<select {...field('observationContext')}>{Object.entries(contexts).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>主题<select aria-label="主题" {...field('slotId')} disabled={!!target}><option value="">按原文识别</option>{contracts.map((c) => <option value={c.slotId} key={c.slotId}>{c.label}</option>)}</select></label><label>字段<select aria-label="字段" {...field('facetId')} required={!!form.slotId} disabled={!form.slotId || !!target}><option value="">请选择字段</option>{contract?.facets.map((f) => <option key={f.facetId} value={f.facetId}>{f.label}</option>)}</select></label><label>证据指向的开始日期（可选）<input type="date" {...field('start')} /></label><label>证据指向的结束日期（可选）<input type="date" {...field('end')} /></label></div>
    <label>材料原文／医生核实后的补充陈述<textarea {...field('text')} required maxLength={10000} rows={4} placeholder="保存原话及其范围；例如：近两周学校出勤受到影响，缺课四天。" /></label><p className="ce-help">监护人转述学校意见时，应选择监护人为提供来源，再标注转述学校。</p><button className="ed-inline-primary" disabled={disabled}>保存材料并更新证据</button>{error && <p className="error" role="alert">{error}</p>}
  </form>;
}
function TraceDrawer({ unit, reviewTarget, bundle, reviews, historical, disabled, onClose, onCorrection, onSubmit }) {
  const [status, setStatus] = useState('seen'); const [note, setNote] = useState(''); const [author, setAuthor] = useState('本地演示医生'); const [error, setError] = useState('');
  const closeRef = useRef(null);
  const panelRef = useRef(null);
  useEffect(() => { const before = document.activeElement; closeRef.current?.focus(); const handle = (e) => { if (e.key === 'Escape') onClose(); if (e.key === 'Tab') { const elements = [...panelRef.current.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]')]; const first = elements[0]; const last = elements.at(-1); if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); } } }; document.addEventListener('keydown', handle); return () => { document.removeEventListener('keydown', handle); before?.focus?.(); }; }, []);
  useEffect(() => { setStatus('seen'); setNote(''); setError(''); }, [reviewTarget?.id]);
  const modelCandidate = unit?.evidenceId.startsWith('LE-');
  const matchingReviews = reviews.filter((r) => r.targetKind === reviewTarget.kind && r.targetId === reviewTarget.id);
  const turn = unit?.traceRef.qaId ? bundle.sessions.flatMap((s) => s.turns).find((t) => t.qaId === unit.traceRef.qaId) : null;
  return <div className="ce-drawer-backdrop" onClick={onClose}><aside className="ce-drawer" ref={panelRef} role="dialog" aria-modal="true" aria-labelledby="traceTitle" onClick={(e) => e.stopPropagation()}><header><h3 id="traceTitle">{unit ? '证据原文与核实' : '记录查看与核实'}</h3><button ref={closeRef} onClick={onClose} aria-label="关闭证据面板">关闭</button></header><code>{unit?.evidenceId || reviewTarget.id}</code>
    {unit && <>{modelCandidate && <p className="ce-help">模型抽取候选，需结合原文与录音核对。医生核实记录在原规则证据中单独保存。</p>}<h4>结构化陈述</h4><p>{unit.claim}</p><div className="ce-trace-meta"><p>来源：{sourceText(unit)}</p><p>主题／字段：{unit.topicLabel}／{unit.facetLabel}</p><p>极性：{{ affirmed: '肯定', negated: '否定', uncertain: '不确定' }[unit.polarity]}</p><p>材料形成时间：{dateText(unit.observedTime)}</p><p>录入时间：{dateText(unit.recordedAt)}</p><p>指向时间：{timeText(unit)}{unit.referenced_time_span.start ? `（${unit.referenced_time_span.start}至${unit.referenced_time_span.end}）` : ''}</p><p>观察场景：{contexts[unit.observationContext]}</p></div>{turn && <><h4>关联问题</h4><p>{turn.questionText || '开放式主诉入口'}</p><code>{turn.qaId}</code><EvidenceRecording unit={unit} sessions={bundle.sessions} /></>}<h4>原始输入与支撑片段</h4><p className="ce-original">{unit.originalText.slice(0, unit.traceRef.start)}<mark>{unit.originalText.slice(unit.traceRef.start, unit.traceRef.end)}</mark>{unit.originalText.slice(unit.traceRef.end)}</p>{unit.superseded && <p className="ce-help">此条属于修正历史，原文仍保留；核实备注不会删除或自动裁决其他来源。</p>}{!modelCandidate && <button className="ed-inline-secondary" disabled={historical || disabled} onClick={() => onCorrection(unit)}>追加医生纠正陈述</button>}</>}
    <h4>医生查看与核实记录</h4>{matchingReviews.length ? matchingReviews.map((r) => <article className="ce-review-note" key={r.reviewId}><b>{reviewLabels[r.status]}</b><p>{r.note || '未填写备注'}</p><small>{r.author} · {dateText(r.createdAt)}</small></article>) : <p>尚无记录。</p>}
    {!historical && !modelCandidate && <form className="ce-review-form" onSubmit={async (e) => { e.preventDefault(); try { await onSubmit({ targetKind: reviewTarget.kind, targetId: reviewTarget.id, status, note, author }); setNote(''); setError(''); } catch (err) { setError(err.message); } }}><label>记录状态<select value={status} onChange={(e) => setStatus(e.target.value)}>{Object.entries(reviewLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label>记录者（本地演示标识）<input value={author} onChange={(e) => setAuthor(e.target.value)} maxLength={80} /></label><label>核实依据／待补充内容<textarea value={note} onChange={(e) => setNote(e.target.value)} required={status === 'reviewed'} maxLength={3000} rows={4} /></label><p className="ce-help">“已查看”不表示已完成核实；记录核实结果不会自动关闭风险提示。</p><button className="ed-inline-primary" disabled={disabled}>保存核实记录</button>{error && <p className="error" role="alert">{error}</p>}</form>}
  </aside></div>;
}
function VersionCompare({ history, disabled, comparison, onCompare }) {
  const [from, setFrom] = useState(''); const [to, setTo] = useState(''); const [error, setError] = useState(''); const [pending, setPending] = useState(false);
  useEffect(() => { setFrom(String(history[1]?.version ?? '')); setTo(String(history[0]?.version ?? '')); }, [history.map((p) => p.version).join(',')]);
  return <div className="ce-version-compare">{history.length < 2 ? <p className="ce-help">至少保存两个不同报告版本后可进行比较。</p> : <><form onSubmit={async (e) => { e.preventDefault(); setPending(true); try { await onCompare(from, to); setError(''); } catch (err) { setError(err.message); } finally { setPending(false); } }}><label>旧版本<select value={from} onChange={(e) => setFrom(e.target.value)}>{history.map((p) => <option key={p.version} value={p.version}>v{p.version}</option>)}</select></label><label>新版本<select value={to} onChange={(e) => setTo(e.target.value)}>{history.map((p) => <option key={p.version} value={p.version}>v{p.version}</option>)}</select></label><button className="ed-inline-secondary" disabled={disabled || pending || from === to}>比较报告版本</button></form>{error && <p className="error">{error}</p>}</>}
    {comparison && <div className="ce-comparison-result"><b>v{comparison.from} → v{comparison.to}</b><p>新增证据 {comparison.changes.added.length}条 · 修正标记变化 {comparison.changes.revised.length}条 · 新关系 {comparison.changes.relationsAdded.length}条 · 新核实记录 {comparison.changes.reviewsAdded.length}条 · 移出当前关联范围 {comparison.changes.removed.length}条</p>{comparison.changes.added.map((u) => <p key={u.evidenceId}><b>新增：</b>{u.claim} · {roles[u.sourceRole]} · {timeText(u)} <code>{u.evidenceId}</code></p>)}{comparison.changes.revised.map((u) => <p key={u.evidenceId}><b>修正历史：</b>{u.claim} <code>{u.evidenceId}</code></p>)}{comparison.changes.relationsAdded.filter((r) => ['contradicts', 'corrects'].includes(r.semanticRelation)).map((r) => <p key={r.relationId}><b>{semanticLabels[r.semanticRelation]}：</b>{r.rationale}</p>)}{comparison.changes.reviewsAdded.map((r) => <p key={r.reviewId}><b>{reviewLabels[r.status]}：</b>{r.note || '已查看'} · {r.author}</p>)}</div>}
  </div>;
}
