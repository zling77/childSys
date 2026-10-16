import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { isAsrSupported, useSpeechRecognition } from './useSpeechRecognition.js';
import { useNarration, useNarrationPlayback } from './useNarration.js';
import { cancelSpeak, isTtsSupported, prepareTts } from './tts.js';
import { mediaErrorMessage, useContinuousMediaCapture } from './useMediaCapture.js';
import { ClinicianWorkbench as ClinicianView } from './ClinicianWorkbench.jsx';

const API_BASE = import.meta.env.VITE_API_URL ?? '/api';

function App() {
  const route = normalizeRoute(window.location.pathname);
  if (route === 'home') return <HomePage />;

  const portal = {
    guardian: { title: '家长端预问诊', subtitle: 'Guardian Previsit' },
    child: { title: '儿童端小问诊', subtitle: 'Child-friendly Previsit' },
    clinician: { title: '医生端工作台', subtitle: 'Clinician Previsit Review' },
  }[route];

  return (
    <div className={`app app-${route}`}>
      <aside className="rail">
        <div>
          <div className="brand"><span className="brand-mark">+</span>儿童心理预问诊</div>
          <div className="subbrand">{portal.subtitle}</div>
        </div>
        <div className="portal-nav">
          <div className="portal-current">{portal.title}</div>
          <a href="/">返回总入口</a>
        </div>
      </aside>
      <main className="workspace">
        {route === 'guardian' && <GuardianFlow />}
        {route === 'child' && <ChildFlow />}
        {route === 'clinician' && <ClinicianView />}
      </main>
    </div>
  );
}

function HomePage() {
  useNarration('您好，这里是儿童心理预问诊系统。请选择家长端、儿童端，或医生端。', 'home-entry', { rate: 0.94, pitch: 1, volume: 1 });
  const warmVoice = () => {
    void prepareTts();
  };
  return (
    <main className="landing">
      <div className="landing-inner">
        <div className="landing-copy">
          <div className="eyebrow">儿童医院 · 门诊前沟通</div>
          <h1>儿童心理预问诊系统</h1>
          <NarrationButton idleLabel="重播页面说明" className="narration-button landing-narration" />
          <HospitalScene />
        </div>
        <div className="entry-grid">
          <a className="entry-card guardian" href="/guardian" onPointerDown={warmVoice}>
            <span>家长或监护人填写</span>
            <b>家长端</b>
            <small>用语音讲述孩子近期的情况，完成门诊前信息整理。</small>
          </a>
          <a className="entry-card child" href="/child" onPointerDown={warmVoice}>
            <span>适合孩子本人回答</span>
            <b>儿童端</b>
            <small>更简单、更友好的语音对话，请在家长陪同下使用。</small>
          </a>
          <a className="entry-card clinician" href="/clinician">
            <span>仅供医务人员</span>
            <b>医生端</b>
            <small>查看预问诊摘要、风险线索和重要异常。</small>
          </a>
        </div>
      </div>
    </main>
  );
}

function GuardianFlow() {
  return <PatientFlow mode="guardian" />;
}

function ChildFlow() {
  return <PatientFlow mode="child" />;
}

function PatientFlow({ mode }) {
  const isChild = mode === 'child';
  const copy = patientFlowCopy(mode);
  const speakerRole = isChild ? 'child' : 'guardian';
  const [profile, setProfile] = useState({ age: '', sex: 'U', grade: '', respondent: speakerRole });
  const [chiefComplaint, setChiefComplaint] = useState('');
  const [consent, setConsent] = useState(createInitialConsent());
  const [deviceCheck, setDeviceCheck] = useState(createInitialDeviceCheck());
  const [sessionState, setSessionState] = useState(null);
  const [activeStep, setActiveStep] = useState(0);
  const [answer, setAnswer] = useState('');
  const [captureRequested, setCaptureRequested] = useState(false);
  const [captureFinalized, setCaptureFinalized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const continuousMedia = useContinuousMediaCapture();
  const pendingFullMediaRef = useRef(null);

  const current = sessionState?.nextQuestion;
  const complete = sessionState?.session?.status === 'completed';
  const deviceReady = deviceCheck.mic === 'ok' && deviceCheck.camera === 'ok';
  const intakeNarration = sessionState ? '' : intakeGuideText(activeStep, consent, mode);
  const narrationText = complete
    ? `${copy.completeTitle}。${copy.completeDetail}`
    : current
      ? `${copy.questionNarration}${current.text}`
      : intakeNarration;
  const narrationKey = current && !complete
    ? `${sessionState?.session?.sessionId ?? 'new'}:${current.id ?? current.questionId ?? current.text}`
    : `${mode}-intake-step-${activeStep}-${consent.media ? 'media' : 'text'}`;

  useNarration(narrationText, narrationKey, {
    rate: isChild ? 0.92 : 0.94,
    pitch: isChild ? 1.02 : 1,
    volume: 1,
  });

  useEffect(() => {
    if (activeStep !== 3 || !consent.previsit || !deviceReady || captureRequested || captureFinalized) return;
    setCaptureRequested(true);
    void continuousMedia.start();
  }, [activeStep, captureFinalized, captureRequested, consent.previsit, continuousMedia.start, deviceReady]);

  useEffect(() => {
    if (!continuousMedia.recording || complete) return;
    if (sessionState && current) continuousMedia.markQuestionStart(sessionState.turns.length + 1);
    else if (!sessionState && activeStep === 3) continuousMedia.markQuestionStart(1);
  }, [continuousMedia.recording, continuousMedia.markQuestionStart, narrationKey, complete, activeStep, sessionState?.turns.length]);

  async function finalizeContinuousMedia(sessionId) {
    if (!captureFinalized) {
      setCaptureFinalized(true);
      pendingFullMediaRef.current = await continuousMedia.stop();
    }
    const record = pendingFullMediaRef.current;
    if (!record || !sessionId) return;
    await uploadMediaRecords(sessionId, 0, [record], {
      questionText: '全程问诊记录',
      targetSlotOrIssue: 'full_session',
    });
    pendingFullMediaRef.current = null;
  }

  async function start() {
    const submittedAt = Date.now();
    setBusy(true);
    setError('');
    try {
      const data = await post('/previsit/sessions', {
        // Only an explicit clinician-issued case link associates sources. A
        // normal portal visit still creates its own independent clinical case.
        caseId: new URLSearchParams(window.location.search).get('caseId') || undefined,
        caseInvitation: new URLSearchParams(window.location.search).get('invite') || undefined,
        profile: {
          ...profile,
          age: Number(profile.age) || null,
          consent: {
            ...consent,
            media: consent.media,
            signaturePng: consent.signaturePng,
            consentedAt: Date.now(),
            version: 'previsit-p0-consent-v2',
          },
          deviceCheck,
        },
        selectedComplaints: [],
        chiefComplaint,
        speakerRole,
        openingQuestion: copy.chiefQuestion,
      });
      continuousMedia.markQuestionEnd(1, submittedAt);
      setSessionState(data);
      setAnswer('');
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitAnswer() {
    if (!answer.trim() || !sessionState) return;
    const submittedAt = Date.now();
    const turnNo = sessionState.turns.length + 1;
    setBusy(true);
    setError('');
    try {
      const data = await post('/previsit/turns', {
        sessionId: sessionState.session.sessionId,
        expectedTurnNo: sessionState.turns.length + 1,
        speakerRole,
        answerText: answer,
        currentQuestion: current,
      });
      continuousMedia.markQuestionEnd(turnNo, submittedAt);
      setSessionState(data);
      setAnswer('');
      if (data.session.status === 'completed') await finalizeContinuousMedia(data.session.sessionId);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  async function stopInterview() {
    if (!sessionState || busy) return;
    setBusy(true);
    setError('');
    cancelSpeak();
    try {
      let mediaUploadError = null;
      try {
        await finalizeContinuousMedia(sessionState.session.sessionId);
      } catch (err) {
        mediaUploadError = err;
      }
      const data = await post(`/previsit/sessions/${sessionState.session.sessionId}/stop`, {});
      setSessionState(data);
      setAnswer('');
      if (mediaUploadError) setError(`报告已生成，但设备记录上传失败：${messageOf(mediaUploadError)}`);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  async function retryFullMediaUpload() {
    if (!sessionState || busy || !pendingFullMediaRef.current) return;
    setBusy(true);
    setError('');
    try {
      await finalizeContinuousMedia(sessionState.session.sessionId);
    } catch (err) {
      setError(`设备记录上传仍未成功：${messageOf(err)}`);
    } finally {
      setBusy(false);
    }
  }

  if (sessionState) {
    return (
      <section className={`flow flow-${mode}`}>
        <HeaderBlock
          title={copy.title}
          detail={`会话 ${sessionState.session.sessionId}`}
        />
        <div className="chat-layout guardian-chat-layout">
          <div className="chat-panel">
            {current && !complete ? (
              <div className="next-question">
                <div className="question-label">{copy.questionLabel}</div>
                <p>{current.text}</p>
                <NarrationButton idleLabel="重播当前问题" />
                <VoiceFirstComposer
                  value={answer}
                  onChange={setAnswer}
                  disabled={busy}
                  resetKey={narrationKey}
                  mode={mode}
                  prompt={copy.answerVoicePrompt}
                  textPlaceholder={copy.answerTextPlaceholder}
                />
                <div className="actions">
                  <button onClick={submitAnswer} disabled={busy || !answer.trim()}>
                    {busy ? '处理中...' : copy.submitAnswer}
                  </button>
                  <button type="button" className="ghost stop-interview-button" onClick={stopInterview} disabled={busy}>
                    停止问诊并生成报告
                  </button>
                </div>
              </div>
            ) : (
              <div className="complete-panel">
                <b>{copy.completeTitle}</b>
                <span>{copy.completeDetail}</span>
                <NarrationButton idleLabel="重播完成提示" className="ghost compact" />
                {pendingFullMediaRef.current && (
                  <button type="button" className="ghost" onClick={retryFullMediaUpload} disabled={busy}>
                    {busy ? '正在重试...' : '重试设备记录上传'}
                  </button>
                )}
              </div>
            )}
            {error && <div className="error">{error}</div>}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className={`flow flow-${mode}`}>
      <HeaderBlock title={copy.title} detail={copy.headerDetail} />
      <PrevisitSteps activeStep={activeStep} onStepClick={setActiveStep} consent={consent} mode={mode} />
      <div className="wizard-shell">
        {activeStep === 0 && (
          <WizardPage
            title={copy.profileTitle}
            lead={copy.profileLead}
            art="patient"
            mode={mode}
          >
            <div className="field-row">
              <label>年龄<input value={profile.age} onChange={(e) => setProfile({ ...profile, age: e.target.value })} placeholder="请输入年龄" /></label>
              <label>性别
                <select value={profile.sex} onChange={(e) => setProfile({ ...profile, sex: e.target.value })}>
                  <option value="U">未说明</option>
                  <option value="M">男</option>
                  <option value="F">女</option>
                </select>
              </label>
            </div>
            <label>年级<input value={profile.grade} onChange={(e) => setProfile({ ...profile, grade: e.target.value })} placeholder="请输入孩子所在年级" /></label>
            {isChild ? (
              <div className="respondent-card child-respondent">
                <span>这一次由</span>
                <b>我自己回答</b>
                <small>如果有不明白的地方，可以请身边的家长帮忙。</small>
              </div>
            ) : (
              <label>回答者
                <select value={profile.respondent} onChange={(e) => setProfile({ ...profile, respondent: e.target.value })}>
                  <option value="guardian">其他监护人</option>
                  <option value="mother">母亲</option>
                  <option value="father">父亲</option>
                </select>
              </label>
            )}
            <WizardActions onNext={() => setActiveStep(1)} />
          </WizardPage>
        )}

        {activeStep === 1 && (
          <WizardPage
            title={copy.consentTitle}
            lead={copy.consentLead}
            art="consent"
            mode={mode}
          >
            <ConsentChecklist consent={consent} onChange={setConsent} />
            <WizardActions
              onBack={() => setActiveStep(0)}
              onNext={() => setActiveStep(2)}
              nextDisabled={!consent.previsit}
              nextLabel="进入设备自检"
            />
          </WizardPage>
        )}

        {activeStep === 2 && (
          <WizardPage
            title={copy.mediaDeviceTitle}
            lead={copy.mediaDeviceLead}
            art="device"
            mode={mode}
          >
            <DeviceCheckPanel value={deviceCheck} onChange={setDeviceCheck} />
            <WizardActions
              onBack={() => setActiveStep(1)}
              onNext={() => setActiveStep(3)}
              nextDisabled={!deviceReady}
              nextLabel="进入主诉描述"
            />
            {!deviceReady && <div className="form-hint warn">请先完成麦克风和摄像头检测，二者均可用后才能继续。</div>}
          </WizardPage>
        )}

        {activeStep === 3 && (
          <WizardPage
            title={copy.chiefTitle}
            lead={copy.chiefLead}
            art="question"
            mode={mode}
          >
            <div className="open-chief-prompt">
              <b>{copy.chiefQuestion}</b>
              <span>{copy.chiefHint}</span>
            </div>
            <VoiceFirstComposer
              value={chiefComplaint}
              onChange={setChiefComplaint}
              disabled={busy}
              resetKey={`${mode}-chief-complaint`}
              mode={mode}
              prompt={copy.chiefVoicePrompt}
              textPlaceholder={copy.chiefTextPlaceholder}
            />
            <WizardActions
              onBack={() => setActiveStep(2)}
              onNext={start}
              nextDisabled={busy || !chiefComplaint.trim() || !consent.previsit || !deviceReady || !continuousMedia.recording}
              nextLabel={busy ? '创建中...' : (continuousMedia.recording ? '开始预问诊' : '正在准备问诊...')}
            />
            {continuousMedia.error && (
              <div className="error">
                {continuousMedia.error}
                <button type="button" className="ghost compact" onClick={() => setCaptureRequested(false)}>重新准备设备</button>
              </div>
            )}
            {error && <div className="error">{error}</div>}
          </WizardPage>
        )}
      </div>
    </section>
  );
}

function HospitalScene() {
  return (
    <div className="hospital-scene hero-motion" aria-hidden="true">
      <div className="hero-orbit">
        <span />
        <span />
        <span />
      </div>
      <div className="hero-card main">
        <div className="hero-card-head">
          <i />
          <i />
          <i />
        </div>
        <div className="hero-cross" />
        <div className="hero-flow-lines">
          <span />
          <span />
          <span />
        </div>
        <div className="hero-progress"><span /></div>
      </div>
      <div className="hero-card question">
        <b />
        <span />
        <span />
      </div>
      <div className="hero-card packet">
        <b />
        <span />
        <span />
        <span />
      </div>
      <div className="hero-wave">
        <span />
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

function PrevisitSteps({ activeStep = 0, onStepClick, consent, mode = 'guardian' }) {
  const unlocked = [true, true, Boolean(consent?.previsit), Boolean(consent?.previsit)];
  const labels = mode === 'child'
    ? ['关于我', '和家长确认', '检查设备', '说说心里话']
    : ['基本信息', '知情签署', '设备自检', '主诉描述'];
  return (
    <div className="previsit-steps">
      {labels.map((label, index) => (
        <button
          type="button"
          className={`previsit-step${index === activeStep ? ' active' : ''}${index < activeStep ? ' done' : ''}`}
          key={label}
          onClick={() => onStepClick?.(index)}
          disabled={!unlocked[index] && index !== activeStep}
        >
          <span>{index + 1}</span>
          <b>{label}</b>
        </button>
      ))}
    </div>
  );
}

function WizardPage({ title, lead, art, mode = 'guardian', children }) {
  return (
    <div className={`wizard-page wizard-page-${mode}`}>
      <section className="wizard-main panel">
        <div className="wizard-title">
          <span className="wizard-icon">{hospitalStepIcon(art)}</span>
          <div>
            <h2>{title}</h2>
            <p>{lead}</p>
            <NarrationButton idleLabel="重播本页语音" className="ghost compact wizard-narration" />
          </div>
        </div>
        {children}
      </section>
      <aside className="wizard-aside">
        <PediatricArt type={art} mode={mode} />
      </aside>
    </div>
  );
}

function WizardActions({ onBack, onNext, nextDisabled = false, nextLabel = '下一步' }) {
  return (
    <div className="wizard-actions">
      <div />
      <div className="wizard-action-buttons">
        {onBack && <button type="button" className="ghost" onClick={onBack}>上一步</button>}
        <button type="button" className="primary" onClick={onNext} disabled={nextDisabled}>{nextLabel}</button>
      </div>
    </div>
  );
}

function NarrationButton({ idleLabel, className = 'narration-button' }) {
  const narration = useNarrationPlayback();
  return (
    <button
      type="button"
      className={className}
      onClick={narration.toggle}
      data-narration-control="true"
      disabled={!isTtsSupported()}
      aria-pressed={narration.playing}
    >
      {narration.playing ? '停止语音播报' : idleLabel}
    </button>
  );
}

function PediatricArt({ type, mode = 'guardian' }) {
  const titles = mode === 'child'
    ? {
        patient: '让我们认识你',
        consent: '请家长来帮忙',
        device: '听听你的声音',
        question: '慢慢说，别着急',
      }
    : {
        patient: '儿童医院导诊',
        consent: '安心签署',
        device: '设备准备',
        question: '说给医生听',
      };
  const title = titles[type] ?? titles.patient;
  const detail = mode === 'child'
    ? '没有标准答案，只要说你真正的感受就好。'
    : '一步一步来，信息会整理给医生面诊时参考。';
  return (
    <div className={`pediatric-art art-${type}`}>
      <div className="pediatric-motion" aria-hidden="true">
        <div className="motion-panel">
          <div className="motion-header">
            <span />
            <span />
            <span />
          </div>
          <div className="motion-cross" />
          <div className="motion-lines">
            <span />
            <span />
            <span />
          </div>
          <div className="motion-progress">
            <span />
          </div>
        </div>
        <div className="motion-chat chat-one">
          <span />
          <span />
        </div>
        <div className="motion-chat chat-two">
          <span />
          <span />
        </div>
        <div className="motion-wave">
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
        <div className="motion-token token-star" />
        <div className="motion-token token-heart" />
        <div className="motion-token token-check" />
      </div>
      <b>{title}</b>
      <span>{detail}</span>
    </div>
  );
}

function hospitalStepIcon(type) {
  return ({ patient: '1', consent: '2', device: '3', question: '4' })[type] ?? '1';
}

function intakeGuideText(step, consent, mode = 'guardian') {
  if (mode === 'child') {
    if (step === 0) return '嗨，你好。先让我们认识一下你。请填写年龄、性别和年级。';
    if (step === 1) return '这一页请身边的家长一起阅读并完成签名。你可以随时停下来。';
    if (step === 2) return consent?.media
      ? '我们来试试麦克风和摄像头。请在家长帮助下点击检测，然后对麦克风说，你好。'
      : '我们先试试麦克风。请在家长帮助下点击检测，然后对麦克风说，你好。摄像头不会开启。';
    if (step === 3) {
      return consent?.media
        ? '现在请点击大麦克风，说说最近有什么事让你不舒服、烦恼，或者想让医生知道。'
        : '现在请点击大麦克风，说说最近有什么事让你不舒服、烦恼，或者想让医生知道。如果麦克风不能用，可以展开文字输入。';
    }
    return '';
  }
  if (step === 0) return '您好，这里是儿童心理门诊预问诊。请先填写孩子的年龄、性别、年级和回答者信息。';
  if (step === 1) return '现在请阅读知情同意说明，并完成签名。预问诊过程中可以随时停止。';
  if (step === 2) return consent?.media
    ? '接下来进行音视频设备自检。请点击检测摄像头和麦克风，然后对着麦克风轻声说，你好。'
    : '接下来进行语音设备自检。请点击检测麦克风，然后对着麦克风轻声说，你好。摄像头不会开启。';
  if (step === 3) {
    return consent?.media
      ? '现在请点击大麦克风，用自己的话说说这次来门诊最想让医生了解的事情。如有需要，也可以保留录音或录像。'
      : '现在请点击大麦克风，用自己的话说说这次来门诊最想让医生了解的事情。如果语音不可用，可以展开文字输入。';
  }
  return '';
}

function patientFlowCopy(mode) {
  if (mode === 'child') {
    return {
      title: '儿童端小问诊',
      headerDetail: '请在家长陪同下使用',
      questionNarration: '我们接着聊。',
      questionLabel: '我们接着聊',
      answerVoicePrompt: '点一下麦克风，说出你的答案',
      answerTextPlaceholder: '如果麦克风不能用，可以在这里打字。',
      submitAnswer: '说完了，继续',
      completeTitle: '谢谢你认真地告诉我们',
      completeDetail: '你说的内容会整理给医生，医生会再当面和你聊。',
      profileTitle: '先认识一下你',
      profileLead: '这些信息会帮助系统用更合适的方式和你说话。',
      consentTitle: '请家长一起确认',
      consentLead: '这一步请身边的家长阅读说明并完成签名。',
      deviceTitle: '试试麦克风',
      deviceLead: '请在家长帮助下完成检测，确保我们能听清你说话；这一步不会开启摄像头。',
      mediaDeviceTitle: '试试麦克风和摄像头',
      mediaDeviceLead: '请在家长帮助下完成麦克风和摄像头检测。',
      chiefTitle: '先说说你想聊的事',
      chiefLead: '没有固定选项，也没有标准答案，用你自己的话说就好。',
      chiefQuestion: '最近有什么事让你不舒服、烦恼，或者想让医生知道？',
      chiefHint: '可以说学校、家里、身体或心情上的任何事。',
      chiefVoicePrompt: '点一下麦克风，慢慢说给我们听',
      chiefTextPlaceholder: '如果麦克风不能用，可以在这里打字。',
    };
  }
  return {
    title: '家长端预问诊',
    headerDetail: '请尽量在安静环境中用语音回答',
    questionNarration: '下一问。',
    questionLabel: '下一问',
    answerVoicePrompt: '点击麦克风，直接口述您的回答',
    answerTextPlaceholder: '如需要，可在这里修正语音转写；语音不可用时也可直接输入。',
    submitAnswer: '确认转写并继续',
    completeTitle: '本次预问诊已完成',
    completeDetail: '主要症状、风险线索和重要异常已整理供医生查看。',
    profileTitle: '基本信息',
    profileLead: '先填写孩子的基本情况，后面的问题会根据这些信息调整表述。',
    consentTitle: '知情签署',
    consentLead: '请阅读说明并完成电子签名。签署后才能继续进入预问诊。',
    deviceTitle: '语音设备自检',
    deviceLead: '语音是主要回答方式，请先确认麦克风可用；本步骤不会开启摄像头。',
    mediaDeviceTitle: '音视频设备自检',
    mediaDeviceLead: '请确认麦克风和摄像头均可用。',
    chiefTitle: '自由讲述本次来诊原因',
    chiefLead: '前端不限定症状类别，请用自己的话完整讲述想反映的问题。',
    chiefQuestion: '这次来门诊，您最想让医生了解孩子的哪些情况？',
    chiefHint: '可以从最近的变化说起，也可以说学校、家庭、睡眠、饮食、情绪或行为上的任何担心。',
    chiefVoicePrompt: '点击麦克风，从您最担心的事开始说',
    chiefTextPlaceholder: '如需要，可在这里修正语音转写；语音不可用时也可直接输入。',
  };
}

function createInitialConsent() {
  return {
    agreed: false,
    previsit: false,
    media: false,
    signerRole: 'guardian',
    signerName: '',
    idLast4: '',
    proxyRelation: '',
    proxyStatement: false,
    signaturePng: '',
    researchUse: false,
    deidentifiedShare: false,
  };
}

function createInitialDeviceCheck() {
  return {
    mic: 'pending',
    camera: 'pending',
    net: 'pending',
    screen: 'pending',
    detail: {
      mic: '尚未检测麦克风',
      camera: '尚未检测摄像头',
      net: '尚未检测网络',
      screen: `${window.screen?.width ?? '-'}×${window.screen?.height ?? '-'}`,
    },
    micLevel: 0,
    netRttMs: null,
    checkedAt: null,
  };
}

function ConsentChecklist({ consent, onChange }) {
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef(null);

  function update(patch) {
    onChange({ ...consent, ...patch });
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = '#17212b';
  }, []);

  const missing = [];
  if (!consent.agreed) missing.push('勾选同意条款');
  if (!consent.media) missing.push('同意全程音视频记录');
  if (!consent.signerName.trim()) missing.push(consent.signerRole === 'proxy' ? '代签人姓名' : '签名人姓名');
  if (!/^\d{4}$/.test(consent.idLast4)) missing.push('身份证末 4 位');
  if (consent.signerRole === 'proxy' && !consent.proxyRelation.trim()) missing.push('代签人与患儿关系');
  if (consent.signerRole === 'proxy' && !consent.proxyStatement) missing.push('代签声明');
  if (!consent.signaturePng) missing.push('电子签名');
  const valid = missing.length === 0;

  useEffect(() => {
    if (consent.previsit === valid) return;
    onChange({ ...consent, previsit: valid });
  }, [consent, onChange, valid]);

  function pointOf(event) {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const source = event.touches?.[0] ?? event;
    return {
      x: (source.clientX - rect.left) * (canvas.width / rect.width),
      y: (source.clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  function startDrawing(event) {
    event.preventDefault();
    drawingRef.current = true;
    lastPointRef.current = pointOf(event);
  }

  function moveDrawing(event) {
    if (!drawingRef.current || !lastPointRef.current) return;
    event.preventDefault();
    const next = pointOf(event);
    const ctx = canvasRef.current.getContext('2d');
    ctx.beginPath();
    ctx.moveTo(lastPointRef.current.x, lastPointRef.current.y);
    ctx.lineTo(next.x, next.y);
    ctx.stroke();
    lastPointRef.current = next;
    update({ signaturePng: canvasRef.current.toDataURL('image/png') });
  }

  function endDrawing() {
    drawingRef.current = false;
    if (canvasRef.current) update({ signaturePng: canvasRef.current.toDataURL('image/png') });
  }

  function clearSignature() {
    const canvas = canvasRef.current;
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    update({ signaturePng: '' });
  }

  return (
    <div className="consent-box">
      <div className="consent-lead">
        <b>一句话说明</b>
        <span>这是门诊前的信息整理，帮助医生更快了解孩子近期的主要困扰。预问诊过程中可以随时停止。</span>
      </div>

      <div className="consent-sections">
        <section>
          <h3>一、预问诊内容</h3>
          <p>系统会询问基本信息、主诉和若干追问，并把回答整理成医生端可查看的结构化预问诊包。</p>
        </section>
        <section>
          <h3>二、采集的数据</h3>
          <p>包括文字回答、语音听写文本、追问日志、风险线索提示，以及在您单独授权后录制的音频或视频片段。</p>
        </section>
        <section>
          <h3>三、使用范围</h3>
          <p>数据仅用于本次门诊前沟通和医生面诊核实。</p>
        </section>
      </div>

      <div className="signer-card">
        <div className="signer-role">
          <label>
            <input
              type="radio"
              name="signerRole"
              checked={consent.signerRole === 'guardian'}
              onChange={() => update({ signerRole: 'guardian', proxyRelation: '', proxyStatement: false })}
            />
            监护人本人签署
          </label>
          <label>
            <input
              type="radio"
              name="signerRole"
              checked={consent.signerRole === 'proxy'}
              onChange={() => update({ signerRole: 'proxy' })}
            />
            家属 / 陪同人员代签
          </label>
        </div>
        <div className="field-row">
          <label>{consent.signerRole === 'proxy' ? '代签人姓名' : '签名人姓名'}
            <input value={consent.signerName} onChange={(event) => update({ signerName: event.target.value })} />
          </label>
          <label>身份证末 4 位
            <input
              inputMode="numeric"
              maxLength={4}
              value={consent.idLast4}
              onChange={(event) => update({ idLast4: event.target.value.replace(/\D/g, '').slice(0, 4) })}
            />
          </label>
        </div>
        {consent.signerRole === 'proxy' && (
          <>
            <label>与患儿关系
              <input value={consent.proxyRelation} onChange={(event) => update({ proxyRelation: event.target.value })} placeholder="如：父亲 / 母亲 / 祖父母 / 其他监护人" />
            </label>
            <label className={consent.proxyStatement ? 'consent-row checked' : 'consent-row'}>
              <input
                type="checkbox"
                checked={consent.proxyStatement}
                onChange={(event) => update({ proxyStatement: event.target.checked })}
              />
              <span>
                <b>代签声明</b>
                <small>我确认已向监护人/患儿说明预问诊目的，并获得其同意后代为签署。</small>
              </span>
            </label>
          </>
        )}
      </div>

      <div className="signature-card">
        <div className="signature-head">
          <div>
            <b>电子签名</b>
            <span>请在下方签名区用鼠标、触控板或手指签名。</span>
          </div>
          <button type="button" className="ghost compact" onClick={clearSignature}>清除</button>
        </div>
        <canvas
          ref={canvasRef}
          width={900}
          height={180}
          className="signature-canvas"
          onMouseDown={startDrawing}
          onMouseMove={moveDrawing}
          onMouseUp={endDrawing}
          onMouseLeave={endDrawing}
          onTouchStart={startDrawing}
          onTouchMove={moveDrawing}
          onTouchEnd={endDrawing}
        />
      </div>

      <label className={consent.agreed ? 'consent-row checked' : 'consent-row'}>
        <input
          type="checkbox"
          checked={consent.agreed}
          onChange={(event) => update({ agreed: event.target.checked })}
        />
        <span>
          <b>我已阅读并理解以上内容，自愿进行本次预问诊</b>
          <small>完成签署后，系统会自动进入主诉采集和追问。</small>
        </span>
      </label>

      <label className={consent.media ? 'consent-row checked' : 'consent-row'}>
        <input
          type="checkbox"
          checked={consent.media}
          onChange={(event) => update({ media: event.target.checked })}
        />
        <span>
          <b>我知情并同意本次预问诊全程录制音频和视频</b>
          <small>记录从主诉描述开始，持续至问诊正常结束或主动停止，仅供医生端回放核实和结合已有回答整理报告。</small>
        </span>
      </label>

      <div className="research-consent">
        <b>可选研究授权</b>
        <label>
          <input
            type="checkbox"
            checked={consent.researchUse}
            onChange={(event) => update({ researchUse: event.target.checked })}
          />
          去标识化后的文字、答题和交互特征可用于本地科研分析。
        </label>
        <label>
          <input
            type="checkbox"
            checked={consent.deidentifiedShare}
            onChange={(event) => update({ deidentifiedShare: event.target.checked })}
          />
          去标识化数据可与合作科研人员共享；不包含姓名、身份证、签名原图。
        </label>
      </div>

      {!valid && (
        <div className="missing-consent">
          <b>还差 {missing.length} 项才能继续：</b>
          <span>{missing.join('、')}</span>
        </div>
      )}
    </div>
  );
}

function DeviceCheckPanel({ value, onChange }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const audioContextRef = useRef(null);
  const animationRef = useRef(0);
  const [busy, setBusy] = useState('');

  useEffect(() => {
    return () => stopDeviceStreams();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function update(patch) {
    onChange({
      ...value,
      ...patch,
      detail: { ...value.detail, ...(patch.detail ?? {}) },
      checkedAt: Date.now(),
    });
  }

  function stopDeviceStreams() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
    audioContextRef.current?.close?.();
    audioContextRef.current = null;
  }

  async function checkMediaDevices() {
    if (!navigator.mediaDevices?.getUserMedia) {
      update({
        mic: 'fail',
        camera: 'fail',
        detail: {
          mic: '浏览器不支持麦克风检测',
          camera: '浏览器不支持摄像头检测',
        },
      });
      return;
    }
    setBusy('media');
    stopDeviceStreams();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { width: 640, height: 480, facingMode: 'user' },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      const hasCamera = stream.getVideoTracks().length > 0;
      update({
        mic: 'pending',
        camera: hasCamera ? 'ok' : 'fail',
        detail: {
          mic: '请对麦克风说“你好”，检测到声音后通过',
          camera: hasCamera ? '摄像头已连接，画面仅本地预览' : '未检测到摄像头',
        },
      });
      attachMicMeter(stream);
    } catch (err) {
      const message = mediaErrorMessage(err);
      update({
        mic: 'fail',
        camera: 'fail',
        detail: {
          mic: message,
          camera: message,
        },
      });
    } finally {
      setBusy('');
    }
  }

  async function attachMicMeter(stream) {
    const AudioContextCtor = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioContextCtor) {
      update({ mic: 'fail', detail: { mic: '浏览器不支持音量检测' } });
      return;
    }
    const ctx = new AudioContextCtor();
    audioContextRef.current = ctx;
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        /* ignore */
      }
    }
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteFrequencyData(data);
      const average = data.reduce((sum, item) => sum + item, 0) / data.length;
      const level = Math.min(100, Math.round((average / 96) * 100));
      onChange((current) => ({
        ...current,
        micLevel: level,
        mic: level > 12 ? 'ok' : current.mic,
        detail: {
          ...current.detail,
          mic: level > 12 ? '已检测到声音，麦克风正常' : '请对麦克风说“你好”',
        },
        checkedAt: Date.now(),
      }));
      animationRef.current = requestAnimationFrame(tick);
    };
    tick();
  }

  async function checkNetwork() {
    setBusy('net');
    const started = performance.now();
    try {
      const res = await fetch(`${API_BASE.replace(/\/api$/, '')}/health`, { cache: 'no-store' });
      const elapsed = Math.round(performance.now() - started);
      update({
        net: res.ok ? 'ok' : 'fail',
        netRttMs: elapsed,
        screen: 'ok',
        detail: {
          net: res.ok ? `网络正常 · ${elapsed}ms` : '健康检查失败',
          screen: `${window.screen?.width ?? '-'}×${window.screen?.height ?? '-'} · ${navigator.maxTouchPoints > 0 ? '支持触控' : '非触控设备'}`,
        },
      });
    } catch (err) {
      update({ net: 'fail', detail: { net: err instanceof Error ? err.message : String(err) } });
    } finally {
      setBusy('');
    }
  }

  const micBars = Array.from({ length: 14 });
  const cameraStatus = value.camera;
  const cameraDetail = value.detail.camera;

  return (
    <div className="device-check">
      <div className="device-actions">
        <button type="button" className="ghost" onClick={checkMediaDevices} disabled={busy === 'media'}>
          {busy === 'media' ? '检测中...' : '检测摄像头和麦克风'}
        </button>
        <button type="button" className="ghost" onClick={checkNetwork} disabled={busy === 'net'}>
          {busy === 'net' ? '检测中...' : '检测网络和屏幕'}
        </button>
      </div>
      <div className="device-grid-lite">
        <div className={`device-tile ${cameraStatus}`}>
          <b>摄像头</b>
          <span>{deviceStatusLabel(cameraStatus)}</span>
          <small>{cameraDetail}</small>
          <video ref={videoRef} autoPlay muted playsInline />
        </div>
        <div className={`device-tile ${value.mic}`}>
          <b>麦克风</b>
          <span>{deviceStatusLabel(value.mic)}</span>
          <small>{value.detail.mic}</small>
          <div className="mic-bars">
            {micBars.map((_, index) => <i key={index} className={value.micLevel > index * 7 ? 'on' : ''} />)}
          </div>
        </div>
        <div className={`device-tile ${value.net}`}>
          <b>网络</b>
          <span>{deviceStatusLabel(value.net)}</span>
          <small>{value.detail.net}</small>
        </div>
        <div className={`device-tile ${value.screen}`}>
          <b>屏幕</b>
          <span>{deviceStatusLabel(value.screen)}</span>
          <small>{value.detail.screen}</small>
        </div>
      </div>
    </div>
  );
}

function VoiceFirstComposer({
  value,
  onChange,
  disabled = false,
  resetKey = 'stable',
  mode = 'guardian',
  forceTextFallback = false,
  prompt,
  textPlaceholder,
}) {
  const hasText = Boolean(value.trim());
  const childMode = mode === 'child';
  const [textFallbackOpen, setTextFallbackOpen] = useState(!isAsrSupported() || forceTextFallback);
  const [voiceFallbackReason, setVoiceFallbackReason] = useState(
    isAsrSupported() && !forceTextFallback ? '' : (forceTextFallback ? 'device-check-failed' : 'unsupported'),
  );
  const [voiceState, setVoiceState] = useState(isAsrSupported() ? 'idle' : 'unsupported');
  const transcriptStatus = hasText
    ? '已记录'
    : voiceState === 'listening'
      ? '正在听写'
      : voiceState === 'requesting'
        ? '正在启动'
        : voiceState === 'error' || voiceState === 'unsupported'
          ? '转写不可用'
          : '等待开始';
  const emptyTranscriptText = voiceState === 'listening'
    ? (childMode ? '正在听你说话，请继续。' : '麦克风已打开，请继续口述。')
    : voiceState === 'requesting'
      ? '正在请求麦克风并启动语音识别...'
      : (childMode ? '点击上方麦克风开始说话。' : '点击上方麦克风开始口述。');

  const showTextFallback = useCallback((reason = 'unavailable') => {
    setVoiceFallbackReason(reason);
    setTextFallbackOpen(true);
  }, []);
  const clearVoiceFallback = useCallback(() => setVoiceFallbackReason(''), []);

  useEffect(() => {
    if (forceTextFallback) showTextFallback('device-check-failed');
  }, [forceTextFallback, showTextFallback]);

  return (
    <section className={`voice-first-composer${childMode ? ' child-voice-composer' : ''}`}>
      <div className="voice-first-heading">
        <b>{prompt}</b>
        <span>{childMode ? '说完后可以看看文字有没有听错。' : '系统会边听边转成文字，提交前可修正。'}</span>
      </div>
      <VoiceInputControl
        value={value}
        onChange={onChange}
        disabled={disabled}
        resetKey={resetKey}
        prominent
        mode={mode}
        onFallbackRequest={showTextFallback}
        onRecognitionAvailable={clearVoiceFallback}
        onStateChange={setVoiceState}
      />
      <div className={hasText ? 'transcript-preview has-text' : 'transcript-preview'} aria-live="polite">
        <div className="transcript-preview-head">
          <b>{childMode ? '我听到的内容' : '当前语音转写'}</b>
          <span>{transcriptStatus}</span>
        </div>
        <p>{hasText ? value : emptyTranscriptText}</p>
      </div>
      <details
        className="text-fallback"
        open={textFallbackOpen}
        onToggle={(event) => setTextFallbackOpen(event.currentTarget.open)}
      >
        <summary>
          {hasText
            ? '查看并修正转写文字'
            : (voiceFallbackReason ? '实时转写暂不可用，使用文字输入' : '语音不方便？展开文字输入')}
        </summary>
        <label>
          <span>{hasText ? '请核对或修正' : '文字备用输入'}</span>
          {voiceFallbackReason && (
            <small className="text-fallback-note">
              这里的文字用于系统理解当前回答并生成下一问，提交前可以核对和修改。
            </small>
          )}
          <textarea
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={textPlaceholder}
            rows={5}
            disabled={disabled}
          />
        </label>
      </details>
    </section>
  );
}

function VoiceInputControl({
  value,
  onChange,
  disabled = false,
  resetKey = 'stable',
  prominent = false,
  mode = 'guardian',
  onFallbackRequest,
  onRecognitionAvailable,
  onStateChange,
}) {
  const asr = useSpeechRecognition({ continuous: true, lang: 'zh-CN' });
  const [baseText, setBaseText] = useState('');
  const listening = asr.state === 'listening';
  const recognizedText = `${asr.transcript}${asr.interim}`.trim();
  const childMode = mode === 'child';

  useEffect(() => {
    asr.stop();
    asr.reset();
    setBaseText('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  useEffect(() => {
    if (!recognizedText) return;
    const combined = joinVoiceText(baseText, recognizedText);
    onChange(combined);
  }, [baseText, onChange, recognizedText]);

  useEffect(() => {
    onStateChange?.(asr.state);
    if (asr.state === 'listening') onRecognitionAvailable?.();
    else if (asr.state === 'unsupported') onFallbackRequest?.('unsupported');
    else if (asr.error) onFallbackRequest?.(asr.errorCode || 'unavailable');
  }, [asr.error, asr.errorCode, asr.state, onFallbackRequest, onRecognitionAvailable, onStateChange]);

  function toggleVoice() {
    if (listening) {
      asr.stop();
      return;
    }
    setBaseText(value);
    asr.reset();
    asr.start();
  }

  if (!isAsrSupported()) {
    return (
      <div className={prominent ? 'voice-control prominent muted' : 'voice-control muted'}>
        <b>当前浏览器不提供实时语音转写</b>
        <span>建议改用最新版 Chrome 或 Edge；当前页已自动展开文字输入。</span>
      </div>
    );
  }

  return (
    <div className={`voice-control${listening ? ' listening' : ''}${prominent ? ' prominent' : ''}`}>
      <button
        type="button"
        className={listening ? 'voice-button active' : 'voice-button'}
        onClick={toggleVoice}
        disabled={disabled}
        aria-pressed={listening}
        aria-label={listening ? '停止语音转写' : '开始语音转写'}
        data-voice-input-control="true"
      >
        {prominent ? <span className="voice-mic" aria-hidden="true" /> : <span className="voice-dot" />}
        <span>{listening ? (childMode ? '说完了，点这里停止' : '正在听写 · 点击停止') : (childMode ? '点击开始说话' : '点击开始语音回答')}</span>
      </button>
      <span className="voice-hint" role="status" aria-live="polite">
        {asr.status || (listening ? '麦克风已打开，请继续说。' : '麦克风尚未开始。')}
      </span>
      {asr.error && <span className="voice-error">{asr.error}</span>}
    </div>
  );
}

function joinVoiceText(baseText, voiceText) {
  const base = String(baseText ?? '').trimEnd();
  const voice = String(voiceText ?? '').trim();
  if (!voice) return base;
  if (!base) return voice;
  return `${base}${/[，。！？；：,.!?;:]$/.test(base) ? '' : '，'}${voice}`;
}

function LegacyClinicianView() {
  const [queue, setQueue] = useState([]);
  const [selected, setSelected] = useState(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [packet, setPacket] = useState(null);
  const [evidence, setEvidence] = useState(null);
  const [mediaRecords, setMediaRecords] = useState([]);
  const [error, setError] = useState('');
  const [busyAction, setBusyAction] = useState('');
  const [packetNotice, setPacketNotice] = useState('');

  async function refreshQueue() {
    try {
      const suffix = statusFilter === 'all' ? '' : `?status=${encodeURIComponent(statusFilter)}`;
      const data = await get(`/previsit/doctor/queue${suffix}`);
      const sessions = data.sessions ?? [];
      setQueue(sessions);
      setSelected((current) => sessions.some((row) => row.sessionId === current)
        ? current
        : sessions[0]?.sessionId ?? null);
      if (!sessions[0]) {
        setPacket(null);
        setEvidence(null);
        setMediaRecords([]);
      }
    } catch (err) {
      setError(messageOf(err));
    }
  }

  async function loadDetail(sessionId) {
    if (!sessionId) return;
    setError('');
    try {
      const [packetData, evidenceData, mediaData] = await Promise.all([
        get(`/previsit/packet/${sessionId}`),
        get(`/previsit/evidence/${sessionId}`),
        get(`/previsit/media/${sessionId}`),
      ]);
      setPacket(packetData.packet);
      setEvidence(evidenceData);
      setMediaRecords(mediaData.mediaRecords ?? []);
    } catch (err) {
      setError(messageOf(err));
    }
  }

  async function resetDemoData() {
    setBusyAction('reset');
    setError('');
    try {
      await post('/previsit/demo/reset', {});
      setSelected(null);
      setPacket(null);
      setEvidence(null);
      setMediaRecords([]);
      await refreshQueue();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusyAction('');
    }
  }

  async function seedDemoData() {
    setBusyAction('seed');
    setError('');
    try {
      const result = await post('/previsit/demo/seed', {});
      const first = result.created?.[0]?.sessionId ?? null;
      await refreshQueue();
      if (first) setSelected(first);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusyAction('');
    }
  }

  async function regeneratePacket() {
    if (!selected) return;
    setBusyAction('packet');
    setError('');
    try {
      const data = await post(`/previsit/packet/${selected}/generate`, {});
      setPacket(data.packet);
      setPacketNotice(data.changed
        ? `已根据最新问诊证据更新为医生包版本 ${data.packet.version}。`
        : '当前没有新增问诊证据，结构化摘要已是最新版本。');
      await refreshQueue();
      await loadDetail(selected);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusyAction('');
    }
  }

  useEffect(() => {
    refreshQueue();
    const timer = setInterval(refreshQueue, 3000);
    return () => clearInterval(timer);
  }, [statusFilter]);

  useEffect(() => {
    setPacketNotice('');
    if (selected) loadDetail(selected);
  }, [selected]);

  const selectedRow = queue.find((row) => row.sessionId === selected);

  return (
    <div className="ed-shell">
      <aside className="ed-sidebar">
        <div className="ed-queue-title">
          <div>
            <b>预问诊队列</b>
            <span>选择患者查看门诊前摘要</span>
          </div>
          <strong>{queue.length}</strong>
        </div>
        <div className="ed-notice">
          <strong>安全边界</strong>
          <span>仅整理预问诊证据、风险线索和缺失信息；不输出诊断、治疗建议或医生面诊问题。</span>
        </div>
        <label className="ed-field-label" htmlFor="clinicianStatusFilter">队列状态</label>
        <select id="clinicianStatusFilter" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
          <option value="all">全部会话</option>
          <option value="in_progress">进行中</option>
          <option value="completed">已完成</option>
          <option value="needs_clinician_review">需优先核实</option>
          <option value="draft">草稿</option>
        </select>
        <button className="ed-primary-button" onClick={refreshQueue}>刷新队列</button>
        <div className="ed-queue">
          {queue.length === 0 && <div className="ed-sidebar-empty">暂无会话</div>}
          {queue.map((row) => (
            <button
              key={row.sessionId}
              className={row.sessionId === selected ? 'ed-queue-row active' : 'ed-queue-row'}
              onClick={() => setSelected(row.sessionId)}
            >
              <span>{row.profile?.age ?? '-'}岁 · {row.profile?.grade ?? '-'}</span>
              <b>{shortText(row.chiefComplaint || row.sessionId, 34)}</b>
              <small>{statusLabel(row.status)} · {row.progress?.percent ?? 0}% · {row.turnCount}轮</small>
              {row.riskCount > 0 && <i>需优先核实</i>}
            </button>
          ))}
        </div>
        <details className="ed-demo-tools">
          <summary>演示数据工具</summary>
          <div>
            <button className="ed-secondary-button" onClick={seedDemoData} disabled={busyAction === 'seed'}>
              {busyAction === 'seed' ? '生成中...' : '生成演示病例'}
            </button>
            <button className="ed-danger-button" onClick={resetDemoData} disabled={busyAction === 'reset'}>
              {busyAction === 'reset' ? '清空中...' : '清空演示数据'}
            </button>
          </div>
        </details>
        <div className="ed-health">
          <span />
          预问诊服务在线
        </div>
      </aside>

      <main className="ed-main">
        {error && <div className="error">{error}</div>}
        {selectedRow ? (
          <AlignedClinicianWorkbench
            packet={packet}
            row={selectedRow}
            evidence={evidence}
            mediaRecords={mediaRecords}
            onRegenerate={regeneratePacket}
            regenerating={busyAction === 'packet'}
            packetNotice={packetNotice}
          />
        ) : (
          <section className="ed-panel ed-empty-stage">
            <b>请选择一个预问诊会话</b>
            <span>选择后将显示多源时间线、证据关系、当前状态和医生版 Pre-visit Packet。</span>
          </section>
        )}
      </main>
    </div>
  );
}

function AlignedClinicianWorkbench({ packet, row, evidence, mediaRecords, onRegenerate, regenerating, packetNotice }) {
  const content = packet?.content ?? {};
  const units = evidence?.evidenceUnits ?? [];
  const states = evidence?.slotStates ?? [];
  const risks = evidence?.riskSignals ?? [];
  const turns = evidence?.dialogueTurns ?? [];
  const timeline = buildClinicianTimeline(turns, units, states, row?.sessionId);
  const relations = buildEvidenceRelations(states);
  const progress = row?.progress?.percent ?? content.completion?.percent ?? 0;
  const profile = row?.profile ?? content.basic_info ?? {};
  const hasNewEvidence = !packet || Number(row?.updatedAt ?? 0) > Number(packet?.createdAt ?? 0);

  return (
    <>
      <section className="ed-topbar">
        <div>
          <div className="ed-topbar-kicker">{row.sessionId}</div>
          <h2>{profile.age ?? '-'}岁 · {sexLabel(profile.sex)} · {profile.grade ?? '-'}</h2>
          <p>{row.chiefComplaint || content.chief_complaint?.raw_text || '尚未记录主诉'}</p>
        </div>
        <div className="ed-topbar-side">
          <div className="ed-completion">
            <span>采集完整度 {progress}%</span>
            <div><i style={{ width: `${Math.min(100, progress)}%` }} /></div>
          </div>
          <span className={`ed-status-pill ${row.status}`}>{statusLabel(row.status)}</span>
          {row.riskCount > 0 && row.status !== 'needs_clinician_review' && <span className="ed-risk-pill">需优先核实</span>}
        </div>
      </section>

      <AlignedPanel title="结构化预问诊摘要" meta={packet ? `医生包版本 ${packet.version}` : '尚未生成'} className="ed-summary-panel">
        {packet ? (
          <ClinicianSummaryOverview content={content} />
        ) : (
          <div className="ed-empty ed-packet-empty">
            <span>当前会话尚未生成结构化医生版材料。</span>
            <button className="ed-inline-primary" onClick={onRegenerate} disabled={regenerating}>
              {regenerating ? '生成中...' : '生成预问诊摘要'}
            </button>
          </div>
        )}
        {packet && (
          <>
            {packetNotice && <div className="ed-packet-update-notice" role="status">{packetNotice}</div>}
            <button className="ed-inline-secondary" onClick={onRegenerate} disabled={regenerating || !hasNewEvidence}>
              {regenerating ? '更新中...' : (hasNewEvidence ? '更新结构化摘要' : '摘要已是最新')}
            </button>
          </>
        )}
      </AlignedPanel>

      <AlignedPanel title="需优先核实" meta={`${(content.risk_notes ?? []).length} 条风险线索 · ${(content.missing_information ?? []).length} 项缺失`} className="ed-priority-panel">
        <PriorityReviewContent content={content} risks={risks} />
      </AlignedPanel>

      <AlignedPanel title="来源差异与时序变化" meta={`${relations.length} 条变化关系`}>
        <SourceDifferenceContent content={content} relations={relations} />
      </AlignedPanel>

      <AlignedPanel title="采集过程明细" meta={`${timeline.length} 轮 · ${units.length} 条证据`} className="ed-detail-panel">
        <ClinicianTraceDetails timeline={timeline} units={units} states={states} />
      </AlignedPanel>

      {(mediaRecords?.length ?? 0) > 0 && (
        <AlignedPanel title="音视频附件" meta={`${mediaRecords.length} 段`} className="ed-media-panel">
          <MediaRecordList records={mediaRecords} />
        </AlignedPanel>
      )}
    </>
  );
}

function AlignedPanel({ title, meta, className = '', children }) {
  return (
    <section className={`ed-panel${className ? ` ${className}` : ''}`}>
      <div className="ed-panel-header">
        <h3>{title}</h3>
        {meta && <span>{meta}</span>}
      </div>
      {children}
    </section>
  );
}

function ClinicianSummaryOverview({ content }) {
  const sections = [
    ['主要表现', content.main_symptoms ?? []],
    ['病程与频率', content.course ?? []],
    ['功能影响', content.functional_impact ?? []],
    ['诱因与背景', content.background_context ?? []],
  ];
  return (
    <div className="ed-clinical-summary">
      <div className="ed-summary-lead">
        <span>预问诊摘要</span>
        <p>{content.summary || '暂无可用摘要'}</p>
      </div>
      <div className="ed-summary-grid">
        {sections.map(([title, rows]) => (
          <section key={title}>
            <h4>{title}</h4>
            {rows.length === 0 ? <span>尚未采集到可用信息</span> : rows.map((row, index) => (
              <p key={index}><b>{row.label ?? row.slot_id ?? '条目'}：</b>{packetRowValue(row)}</p>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

function PriorityReviewContent({ content, risks }) {
  const riskRows = (content.risk_notes ?? []).length
    ? content.risk_notes
    : (risks ?? []).map((risk) => ({
        signal_type: risk.signalType,
        trigger_text: risk.triggerText,
        source: risk.source,
        evidence_turn: risk.turnNo,
      }));
  const abnormalities = (content.important_abnormalities ?? []).filter((row) => row.type !== 'safety_signal');
  const missing = content.missing_information ?? [];
  return (
    <div className="ed-priority-grid">
      <section className="ed-priority-column risk">
        <div className="ed-priority-title"><b>风险相关原话</b><span>仅提示核实，不做分层</span></div>
        {riskRows.length === 0 ? <p className="ed-calm-empty">未记录风险相关原话</p> : riskRows.map((row, index) => (
          <article key={index}>
            <b>{row.signal_type || '安全相关线索'}</b>
            <p>“{row.trigger_text}”</p>
            <small>{sourceDisplayLabel(row.source)}{row.evidence_turn ? ` · 第 ${row.evidence_turn} 轮` : ''} · 需医生当面核实</small>
          </article>
        ))}
      </section>
      <section className="ed-priority-column abnormal">
        <div className="ed-priority-title"><b>重要异常与变化</b><span>{abnormalities.length} 项</span></div>
        {abnormalities.length === 0 ? <p className="ed-calm-empty">暂无重要异常条目</p> : abnormalities.map((row, index) => (
          <article key={index}>
            <b>{row.label ?? row.type ?? '重要异常'}</b>
            <p>{packetRowValue(row)}</p>
            {row.note && <small>{row.note}</small>}
          </article>
        ))}
      </section>
      <section className="ed-priority-column missing">
        <div className="ed-priority-title"><b>缺失与待核实信息</b><span>{missing.length} 项</span></div>
        {missing.length === 0 ? <p className="ed-calm-empty">暂无缺失项</p> : missing.map((row, index) => (
          <article key={index}>
            <b>{row.label ?? row.slot_id ?? '待核实信息'}</b>
            <p>{row.note || stateStatusLabel(row.status)}</p>
          </article>
        ))}
      </section>
    </div>
  );
}

function SourceDifferenceContent({ content, relations }) {
  const differences = content.multi_source_differences ?? [];
  return (
    <div className="ed-source-difference-content">
      {differences.length > 0 && (
        <div className="ed-source-difference-list">
          {differences.map((row, index) => (
            <article key={index}>
              <div><b>{row.label ?? row.slot_id ?? '来源差异'}</b><span>{stateStatusLabel(row.status)}</span></div>
              <p>{row.descriptions?.join('；') || row.note}</p>
              <small>{(row.sources ?? []).map(sourceDisplayLabel).join('、') || '来源未标注'} · {(row.evidence_ids ?? []).join(' · ')}</small>
            </article>
          ))}
        </div>
      )}
      <EvidenceRelationList relations={relations} />
    </div>
  );
}

function ClinicianTraceDetails({ timeline, units, states }) {
  const sourceCounts = [...timeline.reduce((counts, turn) => {
    const label = sourceDisplayLabel(turn.source);
    counts.set(label, (counts.get(label) ?? 0) + 1);
    return counts;
  }, new Map()).entries()];
  const sourceCount = sourceCounts.length;
  return (
    <div className="ed-trace-details">
      <details>
        <summary>
          <span>{sourceCount > 1 ? '多源问答时间线' : '问答输入时间线'}</span>
          <small>{timeline.length} 个问答单元 · {sourceCount} 个来源</small>
        </summary>
        <div className="ed-timeline ed-timeline-wide">
          {timeline.length === 0 && <div className="ed-empty">暂无输入记录</div>}
          {sourceCounts.length > 0 && (
            <div className="ed-timeline-sources">
              <b>本会话输入来源</b>
              {sourceCounts.map(([source, count]) => <span key={source}>{source} {count} 条</span>)}
            </div>
          )}
          {timeline.map((turn) => (
            <article className="ed-turn-card ed-qa-card" key={turn.qaId}>
              <div className="ed-qa-head">
                <code>{turn.qaId}</code>
                <span>第 {turn.turnNo} 轮</span>
                <span className="ed-qa-source">{sourceDisplayLabel(turn.source)}</span>
              </div>
              <div className="ed-qa-pair">
                <section>
                  <b>系统提问</b>
                  <p>{turn.questionText || '开放式主诉入口'}</p>
                </section>
                <section>
                  <b>{sourceDisplayLabel(turn.source)}回答</b>
                  <p>{turn.answerText || '未记录回答文本'}</p>
                </section>
              </div>
              <small>采集主题：{turn.slotLabels.join(' / ') || '开放叙述'}{turn.evidenceIds.length ? ` · 证据 ${turn.evidenceIds.join('、')}` : ''}</small>
            </article>
          ))}
        </div>
      </details>
      <details>
        <summary><span>证据原文追溯</span><small>{units.length} 条证据</small></summary>
        <EvidenceUnitTable units={units} states={states} />
      </details>
      <details>
        <summary><span>采集覆盖状态</span><small>{states.length} 个主题</small></summary>
        <CoverageStateList states={states} />
      </details>
    </div>
  );
}

function CoverageStateList({ states }) {
  return (
    <div className="ed-coverage-grid">
      {states.map((state) => (
        <article key={`${state.complaintId}:${state.slotId}`}>
          <div><b>{state.label}</b><span className={`ed-badge state-${state.status}`}>{stateStatusLabel(state.status)}</span></div>
          <p>{state.value?.text || '尚未获得可用信息'}</p>
        </article>
      ))}
    </div>
  );
}

function EvidenceUnitTable({ units, states }) {
  const stateBySlot = new Map(states.map((state) => [state.slotId, state]));
  if (!units.length) return <div className="ed-empty">暂无证据单元</div>;
  return (
    <div className="ed-table-wrap">
      <table className="ed-table">
        <thead>
          <tr>
            <th>ID</th><th>来源</th><th>轮次</th><th>主题</th><th>时间范围</th><th>状态</th><th>原文追溯</th>
          </tr>
        </thead>
        <tbody>
          {units.map((unit) => {
            const state = stateBySlot.get(unit.slotId);
            return (
              <tr key={unit.evidenceId}>
                <td><code>{unit.evidenceId}</code></td>
                <td>{sourceDisplayLabel(unit.source)}</td>
                <td>{unit.turnNo}</td>
                <td>{state?.label ?? unit.slotId}</td>
                <td>{unit.timeScope || '未限定'}</td>
                <td><span className={`ed-badge state-${state?.status ?? 'unknown'}`}>{stateStatusLabel(state?.status)}</span></td>
                <td>{unit.rawText}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function EvidenceRelationList({ relations }) {
  if (!relations.length) return <div className="ed-empty">当前证据尚未形成支持、补充、修正或冲突关系。</div>;
  return (
    <div className="ed-relation-list">
      {relations.map((relation) => (
        <article className="ed-relation-card" key={relation.id}>
          <strong><span className={`ed-badge relation-${relation.type}`}>{relationLabel(relation.type)}</span>{relation.label}</strong>
          <p>{relation.description}</p>
          <small>{relation.evidenceIds.join(' · ')}</small>
        </article>
      ))}
    </div>
  );
}

function EvidenceStateView({ states, risks }) {
  return (
    <div className="ed-state-view">
      <article className="ed-topic-card risk-topic">
        <strong>风险线索</strong>
        {risks.length
          ? <ul>{risks.map((risk) => <li key={risk.signalId}>“{risk.triggerText}” · {sourceDisplayLabel(risk.source)} · 需医生核实</li>)}</ul>
          : <p>未记录明确风险线索。</p>}
      </article>
      {states.map((state) => (
        <article className="ed-topic-card" key={`${state.complaintId}:${state.slotId}`}>
          <strong>{state.label}<span className={`ed-badge state-${state.status}`}>{stateStatusLabel(state.status)}</span></strong>
          <p>{state.value?.text || '尚未获得可用信息'}</p>
          {(state.value?.observations ?? []).length > 1 && <small>{state.value.observations.length} 条时序观察 · {state.evidenceIds.join(' · ')}</small>}
        </article>
      ))}
    </div>
  );
}

function AlignedPacketContent({ content }) {
  const sections = [
    ['主要症状', content.main_symptoms ?? []],
    ['病程与频率', content.course ?? []],
    ['功能影响', content.functional_impact ?? []],
    ['诱因、场景与背景', content.background_context ?? []],
    ['重要异常', content.important_abnormalities ?? []],
    ['多来源差异', content.multi_source_differences ?? []],
  ];
  return (
    <div className="ed-packet">
      <div className="ed-packet-summary">
        <b>预问诊摘要</b>
        <p>{content.summary || '暂无摘要'}</p>
      </div>
      {(content.risk_notes ?? []).length > 0 && (
        <div className="ed-packet-risk">
          <b>高优先级风险线索 · 仅供医生核实</b>
          {(content.risk_notes ?? []).map((item, index) => <p key={index}>“{item.trigger_text}” · {sourceDisplayLabel(item.source)}</p>)}
        </div>
      )}
      <div className="ed-packet-sections">
        {sections.map(([title, rows]) => (
          <div className="ed-packet-section" key={title}>
            <h4>{title}</h4>
            {rows.length === 0 ? <span>暂无条目</span> : rows.map((row, index) => (
              <p key={index}><b>{row.label ?? row.slot_id ?? row.type ?? '条目'}：</b>{packetRowValue(row)}</p>
            ))}
          </div>
        ))}
        <div className="ed-packet-section">
          <h4>仍缺信息</h4>
          {(content.missing_information ?? []).length === 0
            ? <span>暂无缺失项</span>
            : (content.missing_information ?? []).map((row, index) => <p key={index}><b>{row.label}：</b>{row.note}</p>)}
        </div>
      </div>
    </div>
  );
}

function buildClinicianTimeline(turns, units, states, sessionId = 'UNKNOWN') {
  const byTurn = new Map();
  const labels = new Map(states.map((state) => [state.slotId, state.label]));
  for (const turn of turns) {
    byTurn.set(turn.turnNo, {
      qaId: turn.qaId ?? `QA-${turn.sessionId ?? sessionId}-${turn.turnNo}`,
      turnNo: turn.turnNo,
      source: turn.speakerRole === 'child' ? 'child_self_report' : turn.speakerRole === 'guardian' ? 'parent_report' : turn.speakerRole,
      questionText: turn.questionText,
      answerText: turn.answerText,
      slotLabels: [],
      evidenceIds: [],
    });
  }
  for (const unit of units) {
    const row = byTurn.get(unit.turnNo) ?? {
      qaId: `QA-${unit.sessionId ?? sessionId}-${unit.turnNo}`,
      turnNo: unit.turnNo,
      source: unit.source,
      questionText: null,
      answerText: unit.rawText || unit.value?.text || '',
      slotLabels: [],
      evidenceIds: [],
    };
    const text = unit.rawText || unit.value?.text;
    if (!row.answerText && text) row.answerText = text;
    const label = labels.get(unit.slotId) ?? (unit.slotId === 'open_narrative' ? '开放叙述' : unit.slotId);
    if (label && !row.slotLabels.includes(label)) row.slotLabels.push(label);
    if (unit.evidenceId && !row.evidenceIds.includes(unit.evidenceId)) row.evidenceIds.push(unit.evidenceId);
    byTurn.set(unit.turnNo, row);
  }
  return [...byTurn.values()].sort((left, right) => left.turnNo - right.turnNo);
}

function buildEvidenceRelations(states) {
  return states.flatMap((state) => {
    const observations = state.value?.observations ?? [];
    if (observations.length < 2) return [];
    const sourceCount = new Set(observations.map((item) => item.source).filter(Boolean)).size;
    const type = state.status === 'conflict'
      ? 'conflict'
      : state.status === 'ambiguous'
        ? 'uncertain'
        : observations.some((item, index) => index > 0 && item.text !== observations[0].text)
          ? 'supplement'
          : 'support';
    return [{
      id: `${state.slotId}-${type}`,
      type,
      label: state.label,
      evidenceIds: state.evidenceIds ?? [],
      description: type === 'conflict'
        ? '不同轮次或来源存在方向相反的描述，原始证据均被保留。'
        : type === 'uncertain'
          ? '现有描述存在不确定或量化差异，需要医生结合场景核实。'
          : type === 'supplement'
            ? `${sourceCount > 1 ? '不同来源' : '后续轮次'}对该主题进行了补充，未覆盖既有证据。`
            : '多条证据对该主题形成一致支持。',
    }];
  });
}

function sourceDisplayLabel(source) {
  return ({
    parent_report: '监护人',
    guardian: '监护人',
    child_self_report: '患儿',
    child: '患儿',
    teacher: '教师',
    scale: '量表',
    record: '既往记录',
  })[source] ?? source ?? '未知来源';
}

function stateStatusLabel(status) {
  return ({ filled: '已采集', partial: '部分信息', missing: '缺失', ambiguous: '待核实', conflict: '来源冲突' })[status] ?? '未分类';
}

function relationLabel(type) {
  return ({ support: '一致信息', supplement: '后续补充', revise: '信息修正', conflict: '来源冲突', uncertain: '待核实' })[type] ?? type;
}

function packetRowValue(row) {
  if (row.descriptions?.length) return row.descriptions.join('；');
  if (typeof row.value === 'string') return row.value;
  if (row.note) return row.note;
  return JSON.stringify(row.value ?? '');
}

function shortText(value, maxLength) {
  const text = String(value ?? '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function PacketView({
  packet,
  row,
  evidence,
  mediaRecords,
  logs,
  onRegenerate,
  regenerating,
}) {
  return (
    <ClinicianAccordionWorkbench
      packet={packet}
      row={row}
      evidence={evidence}
      mediaRecords={mediaRecords}
      logs={logs}
      onRegenerate={onRegenerate}
      regenerating={regenerating}
    />
  );
}

function ClinicianAccordionWorkbench({
  packet,
  row,
  evidence,
  mediaRecords,
  logs,
  onRegenerate,
  regenerating,
}) {
  const [open, setOpen] = useState({
    overview: true,
    clinicalSummary: true,
    risk: true,
    packet: false,
    evidence: false,
    media: false,
    logs: false,
    audit: false,
  });
  const toggle = (key) => setOpen((current) => ({ ...current, [key]: !current[key] }));

  const content = packet.content ?? {};
  const info = content.basic_info ?? {};
  const labels = content.chief_complaint?.labels ?? [];
  const evidenceUnits = evidence?.evidenceUnits ?? [];
  const mediaCount = mediaRecords?.length ?? 0;
  const mainSymptoms = content.main_symptoms ?? content.core_symptoms ?? [];
  const course = content.course ?? content.timeline ?? [];
  const functionalImpact = content.functional_impact ?? content.functional_impairment ?? [];
  const backgroundContext = content.background_context ?? content.family_school_context ?? [];
  const importantAbnormalities = (content.important_abnormalities ?? []).map((row, index) => ({
    slot_id: row.slot_id ?? row.type ?? `abnormality_${index}`,
    label: row.label ?? '重要异常',
    value: row.value,
    note: row.note,
    evidence_ids: row.evidence_ids ?? [],
  }));
  const packetCount = mainSymptoms.length
    + course.length
    + functionalImpact.length
    + backgroundContext.length
    + (content.physical_and_developmental_history?.length ?? 0)
    + (content.prior_help_and_treatment?.length ?? 0)
    + (content.goals_and_strengths?.length ?? 0);
  const riskCount = content.risk_notes?.length ?? 0;
  const issueCount = content.open_issues?.length ?? 0;
  const shadowAudit = pickShadowAudit(logs);
  const questionAudits = pickQuestionAudits(logs);
  const questionAuditSummary = summarizeQuestionAudits(questionAudits);
  const overviewMeta = [
    info.age != null ? `${info.age}岁` : null,
    info.grade,
    labels.join(' / '),
  ].filter(Boolean).join(' · ');

  return (
    <div className="cw">
      <section className="cw-strip">
        <div className="cw-strip-main">
          <div className="cw-strip-line">
            <span className="cw-id">{packet.sessionId}</span>
            <b>{info.age != null ? `${info.age}岁` : '-'} · {sexLabel(info.sex)} · {info.grade ?? '-'}</b>
            {row?.status && <span className={`cw-status ${row.status}`}>{statusLabel(row.status)}</span>}
            {content.needs_priority_review && <span className="cw-flag"><i />需优先核实</span>}
          </div>
          <span className="cw-strip-sub">原始主诉 · {content.chief_complaint?.raw_text || '未记录'}</span>
        </div>
        <div className="cw-strip-side">
          <div className="cw-progress-box">
            <span>采集完整度 {content.completion?.percent ?? 0}%</span>
            <div className="cw-progress"><i style={{ width: `${Math.min(100, content.completion?.percent ?? 0)}%` }} /></div>
          </div>
          <button className="cw-btn ghost" onClick={onRegenerate} disabled={regenerating}>
            {regenerating ? '重新生成中...' : '重新生成医生包'}
          </button>
        </div>
      </section>

      <AccordionCard cardId="overview" open={open.overview} onToggle={toggle} title="原始主诉与基本信息" meta={overviewMeta}>
        <p className="cw-summary">{content.summary || '暂无摘要'}</p>
        <div className="cw-facts">
          <Fact k="陈述者" v={(content.basic_info?.respondents ?? []).map(respondentLabel).join('、') || '监护人'} />
          <Fact k="完整度" v={`${content.completion?.percent ?? 0}%`} />
          <Fact k="内部扫描标签" v={labels.join(' / ') || '未匹配'} />
        </div>
        {content.needs_priority_review && (
          <div className="cw-priority">
            <span className="cw-priority-bar" />
            <div>
              <b>需优先核实</b>
              <span>预问诊中出现需要医生优先当面核实的线索，详见下方“风险线索 / 待面诊澄清”。系统不做风险分层。</span>
            </div>
          </div>
        )}
      </AccordionCard>

      <AccordionCard
        cardId="clinicalSummary"
        open={open.clinicalSummary}
        onToggle={toggle}
        tone="teal"
        title="临床结构化速览"
        core
        meta={`${mainSymptoms.length} 项症状 · ${importantAbnormalities.length} 项重要异常`}
        badge={<StatusBadge tone={riskCount ? 'red' : 'green'} label={riskCount ? `${riskCount} 条风险线索` : '未记录风险线索'} />}
      >
        <div className="cw-summary-notice">
          本页仅汇总预问诊已采集事实，不生成面诊问题；医生依据临床判断自行决定面诊内容。
        </div>
        {riskCount > 0 && (
          <div className="cw-priority">
            <span className="cw-priority-bar" />
            <div>
              <b>风险相关原话</b>
              <span>{(content.risk_notes ?? []).slice(0, 2).map((item) => `“${item.trigger_text}”`).join('；')}</span>
            </div>
          </div>
        )}
        <div className="cw-packet-grid cw-clinical-grid">
          <AccordionPacketSection title="主要症状" rows={mainSymptoms} />
          <AccordionPacketSection title="病程与频率" rows={course} />
          <AccordionPacketSection title="功能影响" rows={functionalImpact} />
          <AccordionPacketSection title="重要异常" rows={importantAbnormalities} />
        </div>
      </AccordionCard>

      <AccordionCard
        cardId="risk"
        open={open.risk}
        onToggle={toggle}
        tone="warn"
        title="风险线索 / 待面诊澄清"
        meta={`${riskCount} 条风险线索 · ${issueCount} 条待澄清`}
      >
        <div className="cw-risk-grid">
          <div>
            <div className="cw-subhead warn">风险线索<small>仅提示核实 · 不做分层</small></div>
            {riskCount === 0 ? (
              <div className="cw-muted-box">未记录风险线索</div>
            ) : (
              <div className="cw-col">
                {content.risk_notes.map((item, index) => (
                  <div key={index} className="cw-risknote">
                    <b>{item.signal_type}</b>
                    <span>“{item.trigger_text}”</span>
                    <small>{item.note}</small>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div>
            <div className="cw-subhead">待面诊澄清</div>
            <div className="cw-col">
              {(content.open_issues ?? []).map((issue, index) => (
                <div key={index} className="cw-issue"><span className="cw-diamond">◇</span>{issue}</div>
              ))}
              {issueCount === 0 && <div className="cw-muted-box">暂无待澄清条目</div>}
            </div>
          </div>
        </div>
      </AccordionCard>

      <AccordionCard cardId="packet" open={open.packet} onToggle={toggle} scroll title="完整结构化信息" tag="证据状态整理" meta={`${packetCount} 项结构化条目`}>
        <div className="cw-packet-grid">
          <AccordionPacketSection title="诱因、场景与来源" rows={backgroundContext} />
          <AccordionPacketSection title="睡眠、躯体与发育史" rows={content.physical_and_developmental_history ?? []} />
          <AccordionPacketSection title="既往求助与干预" rows={content.prior_help_and_treatment ?? []} />
          <AccordionPacketSection title="诉求与支持资源" rows={content.goals_and_strengths ?? []} />
          <AccordionPacketSection title="多来源差异" rows={(content.multi_source_differences ?? []).map((row) => ({
            ...row,
            value: row.descriptions?.join('；') || row.note,
          }))} />
          <AccordionPacketSection title="仍缺信息" rows={(content.missing_information ?? []).map((row) => ({
            ...row,
            value: row.note,
          }))} />
        </div>
      </AccordionCard>

      <AccordionCard cardId="evidence" open={open.evidence} onToggle={toggle} scroll title="证据回放" meta={`${evidenceUnits.length} 条证据`}>
        <div className="cw-col">
          {evidenceUnits.length === 0 && <div className="cw-muted-box">暂无证据</div>}
          {evidenceUnits.map((item) => (
            <div key={item.evidenceId} className="cw-ev-row">
              <span className="cw-ev-id">{item.evidenceId}</span>
              <div>
                <span className="cw-ev-text">{item.rawText}</span>
                <small>{item.source} · {item.domain} · {item.slotId}{item.turnNo != null ? ` · 第${item.turnNo}轮` : ''}</small>
              </div>
            </div>
          ))}
        </div>
      </AccordionCard>

      <AccordionCard cardId="media" open={open.media} onToggle={toggle} scroll title="音视频记录" meta={`${mediaCount} 段记录`}>
        <MediaRecordList records={mediaRecords ?? []} />
      </AccordionCard>

      <AccordionCard cardId="logs" open={open.logs} onToggle={toggle} scroll title="策略日志" meta={`${logs.length} 轮策略`}>
        <AccordionDecisionLogList logs={logs} evidenceUnits={evidenceUnits} />
      </AccordionCard>

      <AccordionCard
        cardId="audit"
        open={open.audit}
        onToggle={toggle}
        title="模型审计 · LLM 辅助"
        meta={questionAudits.length ? `${questionAudits.length} 轮提问辅助` : undefined}
        badge={questionAudits.length
          ? <StatusBadge tone={questionAuditSummary.error ? 'red' : 'green'} label={`提问 ${questionAuditSummary.success}/${questionAuditSummary.total}`} />
          : shadowAudit
            ? <StatusBadge tone={shadowAudit.status === 'success' ? 'green' : shadowAudit.status === 'error' ? 'red' : 'grey'} label={`shadow · ${shadowAudit.status}`} />
          : <StatusBadge tone="grey" label="未运行" />}
      >
        <LlmAuditView shadowAudit={shadowAudit} questionAudits={questionAudits} />
      </AccordionCard>
    </div>
  );
}

function AccordionCard({ cardId, open, onToggle, title, meta, badge, core, tag, tone, scroll, children }) {
  return (
    <section className={`cw-card${tone ? ` tone-${tone}` : ''}`}>
      <button className="cw-head" onClick={() => onToggle(cardId)}>
        <span className="cw-head-left">
          <span className={`cw-chev${open ? ' is-open' : ''}`}>▶</span>
          <span className="cw-title">{title}</span>
          {core && <span className="cw-core">核心</span>}
          {tag && <span className="cw-tag">{tag}</span>}
        </span>
        <span className="cw-head-right">
          {meta && <span className="cw-meta">{meta}</span>}
          {badge}
        </span>
      </button>
      {open && <div className={`cw-body${scroll ? ' is-scroll' : ''}`}>{children}</div>}
    </section>
  );
}

function StatusBadge({ tone, label }) {
  return <span className={`cw-badge is-${tone}`}>{label}</span>;
}

function Fact({ k, v }) {
  return (
    <div className="cw-fact">
      <span>{k}</span>
      <b>{v}</b>
    </div>
  );
}

function AccordionPacketSection({ title, rows = [] }) {
  return (
    <div className="cw-packet-col">
      <h3>{title}</h3>
      {rows.length === 0 ? <div className="cw-muted-box small">暂无条目</div> : (
        <div className="cw-col">
          {rows.map((row, index) => (
            <div key={`${row.slot_id}-${index}`} className="cw-prow">
              <b>{row.label ?? row.slot_id ?? '未命名条目'}</b>
              <span>{typeof row.value === 'string' ? row.value : JSON.stringify(row.value ?? '')}</span>
              {row.note && <span className="cw-prow-note">{row.note}</span>}
              {(row.evidence_ids ?? []).length > 0 && <small>{row.evidence_ids.join(', ')}</small>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AccordionDecisionLogList({ logs, evidenceUnits }) {
  if (!logs.length) return <div className="cw-muted-box">暂无策略日志</div>;
  return (
    <div className="cw-col">
      {logs.map((log) => {
        const candidates = log.candidateQuestions ?? [];
        const ruleUnits = evidenceUnits.filter((item) => item.turnNo === log.turnNo);
        return (
          <div key={log.decisionId} className="cw-log">
            <div className="cw-log-head">
              <span className="cw-round">第 {log.turnNo} 轮</span>
              <b>{log.selectedQuestion || '生成医生包'}</b>
            </div>
            <div className="cw-log-grid">
              <div>
                <span className="cw-log-label">规则抽取</span>
                {ruleUnits.length ? (
                  <div className="cw-log-list">
                    {ruleUnits.slice(0, 6).map((unit) => <span key={unit.evidenceId}>· {unit.slotId}：{unit.rawText}</span>)}
                  </div>
                ) : <span className="cw-muted">本轮无规则证据</span>}
              </div>
              <div>
                <span className="cw-log-label">候选问题</span>
                {candidates.length ? (
                  <div className="cw-log-list">
                    {candidates.slice(0, 5).map((item, index) => <span key={index}>· {item.candidateQuestion}</span>)}
                  </div>
                ) : <span className="cw-muted">无候选</span>}
              </div>
            </div>
            {log.selectionReason && (
              <div className="cw-log-final">
                <span className="cw-log-final-label">最终选择 · </span>{log.selectionReason}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function MediaRecordList({ records }) {
  if (!records.length) return <div className="cw-muted-box">暂无音视频记录</div>;
  return (
    <div className="cw-col">
      {records.map((record) => {
        const src = `${API_BASE}/previsit/media/blob/${encodeURIComponent(record.mediaId)}`;
        return (
          <div key={record.mediaId} className="cw-media-row">
            <div className="cw-media-head">
              <span className="cw-round">第 {record.turnNo} 轮</span>
              <b>{record.modality === 'video' ? '视频记录' : '音频记录'}</b>
              <small>{formatDuration(record.durationMs)} · {formatBytes(record.blobSize)} · {record.targetSlotOrIssue || '未标注槽位'}</small>
            </div>
            {record.questionText && <div className="cw-media-question">{record.questionText}</div>}
            {record.modality === 'video'
              ? <video src={src} controls />
              : <audio src={src} controls />}
            <a className="cw-media-download" href={src} download={record.fileName}>下载原始文件</a>
          </div>
        );
      })}
    </div>
  );
}

function LlmAuditView({ shadowAudit, questionAudits }) {
  return (
    <div className="cw-audit">
      <LlmQuestionAuditView audits={questionAudits} />
      <LlmShadowView audit={shadowAudit} />
    </div>
  );
}

function LlmQuestionAuditView({ audits }) {
  if (!audits.length) {
    return <div className="cw-muted-box small">本例暂无 LLM 动态提问或澄清调用。</div>;
  }
  return (
    <div className="cw-col">
      {audits.slice(-6).map((audit) => {
        const output = audit.output ?? {};
        const dynamic = audit.task === 'llm_dynamic_next_question';
        const visibleResult = audit.status === 'success'
          ? dynamic
            ? output.next_action === 'complete' ? '模型建议结束（仍需规则终止条件复核）' : output.question
            : output.need_clarification ? output.question : '模型判断本轮回答可进入下一题'
          : audit.error || audit.status;
        return (
          <div key={audit.callId} className="cw-slot">
            <span className="cw-slot-id">第 {audit.turnNo} 轮 · {dynamic ? '动态下一问' : '澄清追问'}</span>
            <span className="cw-slot-val">{visibleResult}</span>
            <small>
              {audit.provider} · {audit.model} · {audit.status}
              {audit.latencyMs ? ` · ${audit.latencyMs}ms` : ''}
              {output.reason ? ` · ${output.reason}` : ''}
            </small>
          </div>
        );
      })}
    </div>
  );
}

function LlmShadowView({ audit }) {
  if (!audit) return <div className="cw-muted-box">本例暂无 LLM shadow 抽取输出。</div>;
  const output = audit.output ?? {};
  const slots = output.slots ?? [];
  return (
    <div className="cw-audit">
      <div className="cw-audit-line">
        <span className={`cw-badge is-${audit.status === 'success' ? 'green' : audit.status === 'error' ? 'red' : 'grey'}`}>
          {audit.provider} · {audit.model} · {audit.status}{audit.latencyMs ? ` · ${audit.latencyMs}ms` : ''}
        </span>
        <span className="cw-muted">规则抽取与 LLM 抽取并列对照，仅供审计，不改变对家长可见的流程。</span>
      </div>
      {audit.error && <div className="cw-audit-error">{audit.error}</div>}
      {slots.length ? (
        <div className="cw-col">
          {slots.slice(0, 8).map((slot, index) => (
            <div key={index} className="cw-slot">
              <span className="cw-slot-id">{slot.slot_id}</span>
              <span className="cw-slot-val">{slot.value}</span>
              {slot.confidence != null && <small>conf {slot.confidence}</small>}
            </div>
          ))}
        </div>
      ) : <div className="cw-muted-box small">无 slot 输出</div>}
    </div>
  );
}

function pickQuestionAudits(logs) {
  return (logs ?? [])
    .flatMap((log) => log.modelAudits ?? [])
    .filter((item) => ['llm_clarify_followup', 'llm_dynamic_next_question'].includes(item.task));
}

function summarizeQuestionAudits(audits) {
  const total = audits.length;
  const success = audits.filter((audit) => audit.status === 'success').length;
  return {
    total,
    success,
    error: audits.some((audit) => audit.status === 'error'),
  };
}

function pickShadowAudit(logs) {
  for (let index = (logs?.length ?? 0) - 1; index >= 0; index -= 1) {
    const audit = (logs[index].modelAudits ?? []).find((item) => item.task === 'llm_extract_shadow');
    if (audit) return audit;
  }
  return null;
}

function sexLabel(sex) {
  return ({ M: '男', F: '女', U: '未说明' })[sex] ?? (sex || '-');
}

function respondentLabel(respondent) {
  return ({ mother: '母亲', father: '父亲', guardian: '监护人', child: '患儿本人' })[respondent] ?? respondent;
}

function HeaderBlock({ title, detail }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {detail && <p>{detail}</p>}
      </div>
    </header>
  );
}

function Panel({ title, children }) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

async function get(path) {
  const res = await fetch(API_BASE + path);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function post(path, body) {
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function uploadMediaRecords(sessionId, turnNo, records, context) {
  if (!records?.length) return [];
  const uploaded = [];
  for (const record of records) {
    const dataUrl = await blobToDataUrl(record.blob);
    const result = await post('/previsit/media', {
      sessionId,
      turnNo,
      modality: record.modality,
      mimeType: record.mimeType,
      durationMs: record.durationMs,
      timeline: record.timeline ?? [],
      recordingStartedAt: record.recordingStartedAt ?? null,
      questionText: context.questionText,
      targetSlotOrIssue: context.targetSlotOrIssue,
      dataUrl,
    });
    uploaded.push(result.mediaRecord);
  }
  return uploaded;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('failed to read media blob'));
    reader.readAsDataURL(blob);
  });
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(Number(ms ?? 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatBytes(bytes) {
  const value = Number(bytes ?? 0);
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

function slotLabel(id) {
  return id?.replaceAll('_', ' ') ?? '下一步';
}

function statusText(status) {
  return ({ missing: '缺失', partial: '部分', filled: '已采集', ambiguous: '模糊', conflict: '冲突' })[status] ?? status;
}

function statusLabel(status) {
  return ({
    draft: '草稿',
    in_progress: '进行中',
    completed: '已完成',
    needs_clinician_review: '需优先核实',
  })[status] ?? status;
}

function deviceStatusLabel(status) {
  return ({
    pending: '待检测',
    ok: '正常',
    fail: '异常',
    skipped: '已跳过',
  })[status] ?? status;
}

function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}

function normalizeRoute(pathname) {
  const path = pathname.replace(/\/+$/, '');
  if (path === '/guardian') return 'guardian';
  if (path === '/child') return 'child';
  if (path === '/clinician') return 'clinician';
  return 'home';
}

createRoot(document.getElementById('root')).render(<App />);
