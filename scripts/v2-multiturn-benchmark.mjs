import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

// Evaluation code only. Never changes production sources, models or databases.
const root = process.cwd();
const corpusPath = process.env.V2_CORPUS ?? 'D:/ALLpostgraduate/毕业/开题/测试语料/动态追问自然语境测试语料_v2.json';
const corpusBytes = fs.readFileSync(corpusPath);
const corpus = JSON.parse(corpusBytes);
const backgrounds = JSON.parse(fs.readFileSync('scripts/fixtures/v2-background-replies.json', 'utf8'));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const runDir = process.env.V2_RUN_DIR ?? path.join(root, 'output', `v2-multiturn-${Date.now()}`);
fs.mkdirSync(runDir, { recursive: true });
const previousConfig=fs.existsSync(path.join(runDir,'config.json'))?JSON.parse(fs.readFileSync(path.join(runDir,'config.json'),'utf8')):null;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'previsit-v2-'));
const evaluatorBase = process.env.V2_EVALUATOR_BASE ?? 'http://192.168.1.204:11434';
const evaluatorModel = process.env.V2_EVALUATOR_MODEL ?? 'qwen3.6:35b-a3b';
const maxTurns = 24;
const models = ['PREVISIT_LLM_MODEL', 'PREVISIT_STATE_MODEL', 'PREVISIT_LLM_CLARIFY_MODEL'].map(k => process.env[k] ?? process.env.PREVISIT_LLM_MODEL);
if (models.some(m => m !== 'qwen3.8:27b')) throw new Error('All tested dynamic models must be qwen3.8:27b');
const writeJson = (file, value) => fs.writeFileSync(path.join(runDir, file), JSON.stringify(value, null, 2));
const append = (file, value) => fs.appendFileSync(path.join(runDir, file), JSON.stringify(value) + '\n');
const parseJson = text => JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
const sourceFiles = [];
function collect(dir, base = dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory() && !['node_modules','data'].includes(entry.name)) collect(p, base);
    else if (/\.(mjs|jsx|css|js)$/.test(p)) sourceFiles.push(p);
  }
}
for (const dir of ['core', 'server', 'web/src']) collect(path.join(root, dir));
const protectedHashes = Object.fromEntries(sourceFiles.map(p => [path.relative(root, p), hash(fs.readFileSync(p))]));
const config = { startedAt: new Date().toISOString(), corpusPath, corpusSha256: hash(corpusBytes),
  caseCount: corpus.cases.length, originalTurns: corpus.cases.reduce((n,c)=>n+c.turns.length,0),
  goldAnnotations: corpus.cases.reduce((n,c)=>n+c.turns.reduce((n,t)=>n+t.gold_updates.length,0),0),
  baseline: 'Independent ChildPsych-rule-baseline checkout, LLM off, original rule state/planner',
  testedEndpoint: process.env.PREVISIT_LLM_BASE_URL, testedModels: models,
  evaluatorBase, evaluatorModel, evaluatorTemperature: 0, evaluatorSeed: 20261021,
  deferredReview: Boolean(process.env.V2_DEFER_JUDGING), llmTemperature:Number(process.env.PREVISIT_LLM_TEMPERATURE??.2),
  stateTimeoutMs:Number(process.env.PREVISIT_STATE_TIMEOUT_MS??8000),dialogueTimeoutMs:8000,
  respondent: 'Frozen v2 original answer/background cards; independent model selects IDs only, cannot generate answers',
  evaluatorLimitations: 'Same-family machine evaluator; not clinician adjudication. Uncertain judgments remain separate.',
  maxTurns, maxConsecutiveDecisionRetries: 2, safety: 'Stop ordinary interview at first open-risk safety handoff; not natural completion',
  opening: 'Seed empty session using each arm original store, submit v2 first question/answer via real turn API with matched slot/facet metadata. All later questions are produced by the tested arm.',
  repeatedCases: ['R001','R022','R025','R026','R029','R030'], repeats: 3,
  codeCommit: execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(), protectedHashes,
  runnerSha256: hash(fs.readFileSync(import.meta.filename)), backgroundRepliesSha256: hash(fs.readFileSync('scripts/fixtures/v2-background-replies.json')) };
if(previousConfig){
  if(previousConfig.corpusSha256!==config.corpusSha256||previousConfig.backgroundRepliesSha256!==config.backgroundRepliesSha256||JSON.stringify(previousConfig.testedModels)!==JSON.stringify(config.testedModels)
    ||Object.entries(previousConfig.protectedHashes).some(([p,h])=>protectedHashes[p]!==h))throw new Error('Resume would change corpus, replies, tested models or protected runtime');
  config.startedAt=previousConfig.startedAt;
  config.collectionSegments=[...(previousConfig.collectionSegments??[{runnerSha256:previousConfig.runnerSha256,startedAt:previousConfig.startedAt,routerMaxPredict:150}]),
    {startedAt:new Date().toISOString(),runnerSha256:config.runnerSha256,routerMaxPredict:320,note:'Resume after external-router JSON truncation; ID-only output, same factual cards/model/seed; completed valid conversations retained. Simulator time excluded from primary system latency.'}];
}
writeJson('config.json', config);
console.log('RUN_DIR ' + runDir);

async function evaluator(task, messages, maxPredict) {
  const started = Date.now();
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(evaluatorBase + '/api/chat', { method: 'POST', headers: {'content-type':'application/json'},
        body: JSON.stringify({ model: evaluatorModel, stream: false, think: false, format: 'json', keep_alive: '30m', messages,
          options: { num_ctx: 16384, num_predict: maxPredict, temperature: 0, seed: 20261021 } }), signal: AbortSignal.timeout(60000) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      let output;
      try{output=parseJson(data.message?.content??'');}catch(error){append('evaluator-invalid-json.jsonl',{task,attempt,data,messages});throw error;}
      append('evaluator-calls.jsonl', {task, attempt, inputHash:hash(JSON.stringify(messages)), output, elapsedMs:Date.now()-started,
        model:data.model, loadNs:data.load_duration, promptTokens:data.prompt_eval_count, outputTokens:data.eval_count});
      return output;
    } catch (error) { lastError = error; append('instrumentation-errors.jsonl', {task, attempt, error:error.message}); }
  }
  throw new Error(`evaluator_${task}: ${lastError.message}`);
}

function answerCards(c) {
  const cards = c.turns.map(t => ({ id:`T${t.turn}`, originalQuestion:t.question, text:t.answer,
    concepts:t.gold_updates.map(g=>g.concept), source:'v2_original', originalTurn:t.turn }));
  // Recover deictic context already provided by the original corpus question.
  if(c.case_id==='R001')cards.find(x=>x.id==='T3').text='这两周'+cards.find(x=>x.id==='T3').text;
  if(c.case_id==='R023')cards.find(x=>x.id==='T2').text='晚上睡着以后会再醒来。'+cards.find(x=>x.id==='T2').text;
  return [...cards, ...(backgrounds[c.case_id]??[]).map((text,i)=>({id:`B${i+1}`,text,source:'v2_background'}))];
}
const routerCache=new Map();
if(previousConfig&&fs.existsSync(path.join(runDir,'evaluator-calls.jsonl')))for(const line of fs.readFileSync(path.join(runDir,'evaluator-calls.jsonl'),'utf8').trim().split('\n').filter(Boolean)){
  const call=JSON.parse(line);if(call.task==='route')routerCache.set(call.inputHash,call.output);
}
async function answerQuestion(c, question, history, selected) {
  const cards=answerCards(c);
  const messages=[{role:'system',content:[
    '你是实验应答路由器，不是访谈策略器。根据当前问题，从固定回答卡片中选择一个最直接相关的编号。只能选编号，不能生成或补充事实。',
    '必须按问题内容选择，不能按卡片顺序播放，也不能为了让访谈完整而透露无关卡片。说过的事实允许在确有重问时再次选择，不能隐去系统的重复追问。',
    '拒答属于特定内容范围：问被拒绝的事件人物、经过、原因仍应选择拒答卡片。范围外的睡眠或生活影响可以选择相应卡片。',
    '卡片是多句自然回答，选中会完整发送。必须直接回答所问事实，不能仅因提到同一场景或含不知道就选。若没有能直接回答当前问题的卡片，选择UNKNOWN，代表本来源目前无法提供，不得编造阴性、安全或病史。',
    '只输出一个JSON对象且只有answer_id字段，例如{"answer_id":"UNKNOWN"}。严禁输出reason、依据、解释或推理。不要评判系统，不知道哪个版本。'
  ].join('\n')},{role:'user',content:JSON.stringify({profile:c.profile,question:question.text,history:history.slice(-4).map(t=>({question:t.question,answer:t.answer})),alreadySelected:selected,cards})}];
  const key=hash(JSON.stringify(messages));
  let output=routerCache.get(key);
  if(output)append('router-cache-hits.jsonl',{key,caseId:c.case_id});
  else{output=await evaluator('route',messages,320);routerCache.set(key,output);}
  const card=cards.find(x=>x.id===output.answer_id);
  if(!card&&output.answer_id!=='UNKNOWN')throw new Error('router_invalid_card_id');
  return {id:card?.id??'UNKNOWN',answer:card?.text??'这个我不知道。',reason:output.reason};
}

async function freePort() { const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p; }
async function backend(arm) {
  const cwd=arm==='rule'?path.resolve(root,'../ChildPsych-rule-baseline'):root;
  const port=await freePort(), dbPath=path.join(tmp,arm+'.db');
  const saved=path.join(runDir,`${arm}-synthetic.db`);if(previousConfig&&fs.existsSync(saved))fs.copyFileSync(saved,dbPath);
  let logs='';
  const child=spawn(process.execPath,['server/index.mjs'],{cwd,windowsHide:true,stdio:['ignore','pipe','pipe'],
    env:{...process.env,HOST:'127.0.0.1',PORT:String(port),PREVISIT_DB_PATH:dbPath,PREVISIT_MEDIA_ROOT:path.join(tmp,arm+'-media'),
      PREVISIT_STATE_BUILDER_MODE:arm==='rule'?'rule':'semantic',PREVISIT_LLM_MODE:arm==='rule'?'off':'dynamic',
      PREVISIT_STATE_OUTPUT_FORMAT:process.env.PREVISIT_STATE_OUTPUT_FORMAT??'json_schema',
      PREVISIT_DIALOGUE_AUDIT_MODE:'off',PREVISIT_CLINICIAN_LLM_MODE:'off',PREVISIT_OLLAMA_SSH_HOST:''}});
  child.stdout.on('data',c=>logs+=c);child.stderr.on('data',c=>logs+=c);
  const base=`http://127.0.0.1:${port}`;
  for(let i=0;i<150;i++){
    try{if((await fetch(base+'/health')).ok){const {createStore}=await import(pathToFileURL(path.join(cwd,'server/store.mjs')));return {arm,child,base,db:new Database(dbPath,{readonly:true}),createStore,logs:()=>logs,dbPath};}}catch{}
    if(child.exitCode!=null)throw new Error('Backend startup failed '+logs);
    await new Promise(r=>setTimeout(r,100));
  }
  throw new Error('Backend not ready '+logs);
}
async function request(b,route,body) {
  const start=Date.now();const response=await fetch(b.base+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(45000)});
  const snapshot=await response.json();if(!response.ok)throw new Error(`HTTP ${response.status}: ${JSON.stringify(snapshot)}`);
  return {snapshot,latencyMs:Date.now()-start};
}
function audits(b,id) { return b.db.prepare('SELECT task,model,status,latency_ms,error,output_json FROM model_audit_log WHERE session_id=? ORDER BY created_at').all(id).map(r=>({...r,output:parseNullable(r.output_json),output_json:undefined})); }
function parseNullable(t){try{return JSON.parse(t??'null');}catch{return null;}}
const golds=c=>c.turns.flatMap(t=>t.gold_updates.map((g,i)=>({id:`T${t.turn}G${i+1}`,bankId:`T${t.turn}`,...g})));
const safetyIds=new Set(['R014','R016','R017','R026','R027','R028']);
const positiveGold=g=>!/(?:context|attribution|opinion|unknown|unavailable|limited|unverified|uncertain|not_reported|did_not_understand|declined|unresolved|secondhand_uncertain|alternative_explanation|out_of_subject)/.test(g.status);

function compactState(snapshot) {
  return snapshot.slotStates.flatMap(s=>Object.values(s.value?.facets??{}).filter(f=>f.status!=='missing').map(f=>({id:`${s.slotId}.${f.facetId}`,
    label:f.label,status:f.status,sufficiency:f.sufficiency,value:f.value,requirements:f.requirements,
    response:f.responseState,evidenceIds:f.evidenceIds}))).map(f=>({...f,requirements:undefined}));
}
async function judge(c,row,snapshot) {
  const evidence=(snapshot.evidenceUnits??[]).map(e=>({id:e.evidenceId,slot:e.slotId,facet:e.facetId,turn:e.turnNo,text:e.rawText,
    polarity:e.polarity,source:e.source,speakerRole:e.speakerRole,
    semantic:e.value?.semanticClaim,provenance:e.value?.provenance}));
  const gold=golds(c).map(g=>({...g,disclosedByCard:row.disclosedCards.includes(g.bankId),positiveForRecall:positiveGold(g)}));
  const prompt=[
    '你是盲态技术测试评审器。不要推测被测算法或模型，不作诊断。只依据固定v2金标准、实际问答及最终结构化证据评价。',
    '逐条gold输出retained=true/false/null。true表示相关信息确实进入合适字段或证据，极性、观察/转述/推测、未知/拒答和时间范围没有被扭曲；原始对话被保存不等于结构化证据已正确保留。',
    '每条同时输出disclosed、disclosure_turn和disclosure_quote，表示事实是否确实被本次实际回答披露；不能仅按卡片编号判断，背景卡也可能表达同一事实。disclosed=true必须引用实际回答的连续子串及轮次，false时turn=null、quote=""。',
    '若一个事实只是原话作为整段文本被放进不相关字段，不能算正确保留。可使用等价字段，不要求字面标签一致。null仅用于无法判定，不要强猜。',
    'true必须给出至少一个现有证据id或状态id，支持引用必须能在输入中找到；false/null的refs=[]。',
    '检查每个系统追问：repeat=已得到可用答案后再次索取相同事实，真正补缺或核实矛盾不算；refusal=换标签或措辞再次索取此前本人明确拒绝的同一内容；unavailable=明知本来源无法提供仍重复索取。',
    '开场原始问题不评价成系统生成错误。第一次合理澄清不要算重复。拒答某次事件不妨碍询问范围外生活影响。每个issue给当前turn和支持依据的previous_turn，引用两段实际文本。',
    '自然结束才评估premature。概况可用、信息无法获得或继续收益有限可结束，不要求所有字段问满。只有尚可提供且会影响理解实际困扰的关键事实遗漏才判true。测试轮次上限、模型卡住和安全交接不叫自然结束，不判过早结束。',
    '识别明显捏造、误归因来源、把过去当现在、把估计当精确、把他人风险当本人、肯否颠倒。只列可引用证据支持的错误。',
    '检查模拟回答是否严重答非所问；自然回答带附加信息允许，保留语料风格。不要因为不按预设顺序就判模拟器错误。',
    '使用紧凑数组减少抄写，只输出以下JSON：{"facts":[["T1G1",true,["已有证据或状态id"],true,1,"回答子串","依据"]],"issues":[[2,1,"repeat","本轮问题子串","既往回答子串"]],"premature":[false,[],"依据"],"errors":[["source","已有id","依据"]],"mismatch":[[2,"依据"]]}。',
    'facts每项依次为id、retained、refs、disclosed、disclosure_turn、disclosure_quote、reason，每个gold编号恰好一次。issues每项依次为turn、previous_turn、kind、question_quote、previous_quote。premature为verdict、missing_gold_ids、reason；errors为kind、ref、reason；mismatch为turn、reason。kind只用前述枚举。引用只摘最短可识别连续子串（通常6至15字），reason不超过15字，不抄写整段原话。'
  ].join('\n');
  const input={profile:c.profile,style_tags:c.style_tags,gold,hiddenBackground:c.background_for_simulation,ending:row.ending,
    actualDialogue:row.turns.map(t=>({turn:t.turn,question:t.question,answer:t.answer})),state:compactState(snapshot),evidence};
  const raw=await evaluator('judge',[{role:'system',content:prompt},{role:'user',content:JSON.stringify(input)}],3200);
  const result={facts:raw.facts?.map(f=>({id:f[0],retained:f[1],refs:f[2],disclosed:f[3],disclosure_turn:f[4],disclosure_quote:f[5],reason:f[6]})),
    question_issues:raw.issues?.map(i=>({turn:i[0],previous_turn:i[1],kind:i[2],question_quote:i[3],previous_quote:i[4]})),
    premature:{verdict:raw.premature?.[0],missing_gold_ids:raw.premature?.[1],reason:raw.premature?.[2]},
    evidence_errors:raw.errors?.map(e=>({kind:e[0],ref:e[1],reason:e[2]})),simulator_mismatch:raw.mismatch?.map(m=>({turn:m[0],reason:m[1]}))};
  const byGold=new Map(gold.map(g=>[g.id,g]));
  if(!Array.isArray(result.facts)||result.facts.length!==gold.length||new Set(result.facts.map(f=>f.id)).size!==gold.length||result.facts.some(f=>!byGold.has(f.id)))throw new Error('judge_incomplete_gold');
  const refs=new Set([...evidence.map(e=>e.id),...input.state.map(s=>s.id)]);
  for(const f of result.facts)if(f.retained===true&&(!f.refs?.length||f.refs.some(r=>!refs.has(r))))throw new Error('judge_untraceable_fact');
  for(const f of result.facts)if(f.disclosed===true){const t=row.turns.find(t=>t.turn===f.disclosure_turn);if(!t||!f.disclosure_quote||!t.answer.includes(f.disclosure_quote))throw new Error('judge_untraceable_disclosure');}
  if(result.facts.some(f=>typeof f.disclosed!=='boolean'||![true,false,null].includes(f.retained)))throw new Error('judge_invalid_fact_status');
  const issues=[];
  for(const issue of result.question_issues??[]){
    const current=row.turns.find(t=>t.turn===issue.turn),prior=row.turns.find(t=>t.turn===issue.previous_turn);
    if(!current||!prior||issue.turn<=1||issue.previous_turn>=issue.turn||!current.question?.includes(issue.question_quote)||!prior.answer?.includes(issue.previous_quote)||!issue.question_quote||!issue.previous_quote){append('judge-rejected-issues.jsonl',{caseId:c.case_id,issue});continue;}
    if(['repeat','refusal','unavailable'].includes(issue.kind))issues.push(issue);
  }
  if(row.ending!=='natural_complete')result.premature={verdict:null,missing_gold_ids:[],reason:'Not a natural completion; excluded from premature-completion denominator'};
  return {...result,question_issues:issues,facts:result.facts.map(f=>({...f,positiveForRecall:byGold.get(f.id).positiveForRecall}))};
}

const openingFacets={R001:['presenting_problem','primary_concern'],R002:['sleep_appetite_physical','sleep_change'],R003:['current_manifestations','manifestation_description'],R004:['current_manifestations','manifestation_description'],R005:['triggers_context','trigger_pattern'],R006:['current_manifestations','manifestation_description'],R007:['triggers_context','trigger_pattern'],R008:['current_manifestations','manifestation_description'],R009:['triggers_context','trigger_pattern'],R010:['triggers_context','trigger_pattern'],R011:['sleep_appetite_physical','appetite_change'],R012:['settings_and_sources','cross_setting_pattern'],R013:['sleep_appetite_physical','sleep_change'],R014:['current_manifestations','recent_episode'],R015:['current_manifestations','manifestation_description'],R016:['current_manifestations','manifestation_description'],R017:['current_manifestations','recent_episode'],R018:['onset_course','course_pattern'],R019:['presenting_problem','primary_concern'],R020:['current_manifestations','manifestation_description'],R021:['current_manifestations','manifestation_description'],R022:['current_manifestations','recent_episode'],R023:['sleep_appetite_physical','sleep_change'],R024:['sleep_appetite_physical','sleep_change'],R025:['safety_clues','self_harm_or_suicide'],R026:['current_manifestations','manifestation_description'],R027:['current_manifestations','recent_episode'],R028:['current_manifestations','recent_episode'],R029:['sleep_appetite_physical','sleep_change'],R030:['settings_and_sources','cross_setting_pattern']};

async function session(b,c,repeat) {
  const wallStarted=Date.now();
  const row={caseId:c.case_id,title:c.title,arm:b.arm,repeat,role:c.profile.respondent==='child'?'child':'guardian',age:c.profile.age,
    ageBand:c.profile.age_band,styleTags:c.style_tags,expectedSafety:safetyIds.has(c.case_id),turns:[],disclosedCards:['T1'],
    systemTimeMs:0,simulatorTimeMs:0,ending:null};
  let snapshot,retryCount=0;
  const seed=b.createStore(b.dbPath);let seeded;
  try{seeded=seed.createSession({profile:{...c.profile,respondent:row.role,synthetic:true},stateBuilderMode:b.arm==='rule'?'rule':'semantic'});}finally{seed.close();}
  const [slot,facet]=openingFacets[c.case_id];
  const first=await request(b,'/api/previsit/turns',{sessionId:seeded.sessionId,expectedTurnNo:1,speakerRole:row.role,answerText:c.turns[0].answer,
    currentQuestion:{text:c.turns[0].question,policyType:'corpus_opening',targetSlotOrIssue:slot,targetFacetId:facet}});
  snapshot=first.snapshot;row.sessionId=snapshot.session.sessionId;row.systemTimeMs+=first.latencyMs;
  row.turns.push({turn:1,question:c.turns[0].question,answer:c.turns[0].answer,card:'T1',latencyMs:first.latencyMs,nextQuestion:snapshot.nextQuestion,
    progress:snapshot.progress,status:snapshot.session.status});
  while(true){
    const openRisk=(snapshot.riskSignals??[]).some(s=>s.status!=='closed');
    if(openRisk&&(snapshot.nextQuestion?.targetSlotOrIssue==='safety_clues'||snapshot.session.status==='needs_clinician_review')){row.ending='safety_handoff';break;}
    if(snapshot.session.completedAt!=null||snapshot.session.status==='completed'){
      row.completionReason=snapshot.decisionLogs.at(-1)?.selectionReason;
      row.ending=/24轮安全上限/.test(row.completionReason??'')?'rule_hard_cap':'natural_complete';break;
    }
    if(row.turns.length>=maxTurns){row.ending='turn_cap';break;}
    const q=snapshot.nextQuestion;
    if(!q?.text){row.ending='missing_question';break;}
    let response;
    if(['llm_retry','interaction_pause'].includes(q.policyType)){
      if(retryCount>=2){row.ending='model_stalled';break;}
      retryCount++;response={id:'CONTROL_RETRY',answer:'我准备好了，可以继续。',reason:'fixed retry control; no new facts'};
    }else{
      retryCount=0;const start=Date.now();response=await answerQuestion(c,q,row.turns,row.disclosedCards);row.simulatorTimeMs+=Date.now()-start;
      if(response.id!=='UNKNOWN')row.disclosedCards.push(response.id);
    }
    const answered=await request(b,'/api/previsit/turns',{sessionId:row.sessionId,expectedTurnNo:snapshot.turns.length+1,speakerRole:row.role,answerText:response.answer,currentQuestion:q});
    snapshot=answered.snapshot;row.systemTimeMs+=answered.latencyMs;
    row.turns.push({turn:snapshot.turns.at(-1).turnNo,question:q.text,target:q.targetFacetId,slot:q.targetSlotOrIssue,policy:q.policyType,
      answer:response.answer,card:response.id,routerReason:response.reason,latencyMs:answered.latencyMs,nextQuestion:snapshot.nextQuestion,progress:snapshot.progress,status:snapshot.session.status});
    append('turns.jsonl',{caseId:c.case_id,arm:b.arm,repeat,...row.turns.at(-1)});
  }
  row.disclosedCards=[...new Set(row.disclosedCards)];row.totalTurns=row.turns.length;row.followupTurns=row.turns.filter(t=>t.turn>1&&t.card!=='CONTROL_RETRY').length;
  row.modelAudits=audits(b,row.sessionId);row.modelErrors=row.modelAudits.filter(a=>a.status==='error').length;
  const normalizeQuestion=q=>String(q).replace(/[\s，。！？、,.!?；;：:“”"']/g,'');
  row.exactDuplicateQuestions=row.turns.filter((t,i)=>i>0&&t.card!=='CONTROL_RETRY'&&row.turns.slice(1,i).some(p=>normalizeQuestion(p.question)===normalizeQuestion(t.question))).map(t=>t.turn);
  row.finalState=compactState(snapshot);row.finalEvidence=snapshot.evidenceUnits;row.finalRisk=snapshot.riskSignals;
  row.finalProgress=snapshot.progress;row.wallBeforeJudgeMs=Date.now()-wallStarted;
  // Persist the unjudged trajectory before any evaluation failure.
  writeJson(`trajectory-${c.case_id}-${b.arm}-r${repeat}.json`,row);
  if(!process.env.V2_DEFER_JUDGING)try{row.judgment=await judge(c,row,snapshot);}catch(e){row.judgeError=e.message;append('instrumentation-errors.jsonl',{task:'judge_validation',caseId:c.case_id,arm:b.arm,repeat,error:e.message});}
  append('sessions.jsonl',row);
  console.log(JSON.stringify({case:c.case_id,arm:b.arm,repeat,ending:row.ending,turns:row.totalTurns,systemSeconds:Math.round(row.systemTimeMs/1000),modelErrors:row.modelErrors,
    omitted:row.judgment?.facts.filter(f=>f.positiveForRecall&&f.retained===false).length,questionIssues:row.judgment?.question_issues.length,premature:row.judgment?.premature?.verdict,judgeError:row.judgeError}));
  return row;
}

function wilson(k,n){if(!n)return null;const z=1.96,p=k/n,d=1+z*z/n,m=(p+z*z/(2*n))/d,h=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d;return [m-h,m+h].map(v=>+v.toFixed(4));}
function median(a){if(!a.length)return null;const x=[...a].sort((a,b)=>a-b);return x.length%2?x[(x.length-1)/2]:(x[x.length/2-1]+x[x.length/2])/2;}
function summarize(rows){
  const judged=rows.filter(r=>r.judgment),facts=judged.flatMap(r=>r.judgment.facts),positive=facts.filter(f=>f.positiveForRecall),disclosed=positive.filter(f=>f.disclosed);
  const issues=judged.flatMap(r=>r.judgment.question_issues),normal=rows.filter(r=>!r.expectedSafety),natural=rows.filter(r=>r.ending==='natural_complete');
  const premature=natural.filter(r=>r.judgment?.premature?.verdict===true).length;
  return {sessions:rows.length,judgedSessions:judged.length,naturalCompleted:natural.length,safetyHandoffs:rows.filter(r=>r.ending==='safety_handoff').length,
    expectedSafety:rows.filter(r=>r.expectedSafety).length,correctSafetyHandoffs:rows.filter(r=>r.expectedSafety&&r.ending==='safety_handoff').length,
    falseSafetyHandoffs:rows.filter(r=>!r.expectedSafety&&r.ending==='safety_handoff').length,
    stalled:rows.filter(r=>r.ending==='model_stalled').length,turnCap:rows.filter(r=>['turn_cap','rule_hard_cap'].includes(r.ending)).length,
    missingQuestion:rows.filter(r=>r.ending==='missing_question').length,exactDuplicateQuestions:rows.reduce((n,r)=>n+(r.exactDuplicateQuestions?.length??0),0),
    modelErrors:rows.reduce((n,r)=>n+r.modelErrors,0),modelCalls:rows.reduce((n,r)=>n+r.modelAudits.length,0),
    positiveFacts:positive.length,retainedPositive:positive.filter(f=>f.retained===true).length,omittedPositive:positive.filter(f=>f.retained===false).length,uncertainPositive:positive.filter(f=>f.retained==null).length,
    disclosedPositive:disclosed.length,disclosedButNotRetained:disclosed.filter(f=>f.retained===false).length,undisclosedPositive:positive.filter(f=>!f.disclosed).length,
    repeatQuestions:issues.filter(i=>i.kind==='repeat').length,refusalViolations:issues.filter(i=>i.kind==='refusal').length,unavailableReasks:issues.filter(i=>i.kind==='unavailable').length,
    casesWithRepeat:judged.filter(r=>r.judgment.question_issues.some(i=>i.kind==='repeat')).length,
    casesWithRefusalViolation:judged.filter(r=>r.judgment.question_issues.some(i=>i.kind==='refusal')).length,
    prematureCases:premature,prematureAmongNatural95CI:wilson(premature,natural.filter(r=>r.judgment).length),
    medianTurns:median(rows.map(r=>r.totalTurns)),meanTurns:rows.reduce((n,r)=>n+r.totalTurns,0)/rows.length,
    ordinaryMedianTurns:median(normal.map(r=>r.totalTurns)),ordinaryMedianSystemSeconds:median(normal.map(r=>r.systemTimeMs/1000)),
    totalSystemSeconds:rows.reduce((n,r)=>n+r.systemTimeMs,0)/1000,medianSystemSeconds:median(rows.map(r=>r.systemTimeMs/1000)),
    medianSimulatorSeconds:median(rows.map(r=>r.simulatorTimeMs/1000)),
    evidenceErrors:judged.reduce((n,r)=>n+(r.judgment.evidence_errors?.length??0),0),simulatorMismatches:judged.reduce((n,r)=>n+(r.judgment.simulator_mismatch?.length??0),0)};
}

if(process.env.V2_RESCORE){
  const directory=path.resolve(process.env.V2_RESCORE);
  const scored=[];
  for(const file of fs.readdirSync(directory).filter(f=>/^trajectory-.*\.json$/.test(f))){
    if(process.env.V2_CASES&&!process.env.V2_CASES.split(',').some(id=>file.includes(id)))continue;
    const row=JSON.parse(fs.readFileSync(path.join(directory,file),'utf8'));
    const slots=new Map();for(const f of row.finalState){const [slotId,facetId]=f.id.split('.');if(!slots.has(slotId))slots.set(slotId,{slotId,value:{facets:{}}});slots.get(slotId).value.facets[facetId]={...f,facetId};}
    const snapshot={slotStates:[...slots.values()],evidenceUnits:row.finalEvidence};
    try{const judgment=await judge(corpus.cases.find(c=>c.case_id===row.caseId),row,snapshot);const result={file,judgment};scored.push(result);writeJson('rescored.json',scored);console.log(JSON.stringify({file,valid:true,issues:judgment.question_issues.length,facts:judgment.facts.length}));}
    catch(error){console.log(JSON.stringify({file,error:error.message}));process.exitCode=1;}
  }
  fs.rmSync(tmp,{recursive:true,force:true});
  process.exit(process.exitCode??0);
}
const backends=[],rows=previousConfig&&fs.existsSync(path.join(runDir,'sessions.jsonl'))?fs.readFileSync(path.join(runDir,'sessions.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
const done=(arm,id,repeat)=>rows.some(r=>r.arm===arm&&r.caseId===id&&r.repeat===repeat);
try{
  backends.push(await backend('rule'),await backend('qwen38'));
  // Warm-up is outside latency metrics and separately recorded.
  const warmStarted=Date.now();const warm=await fetch(process.env.PREVISIT_LLM_BASE_URL.replace(/\/v1\/?$/,'')+'/api/chat',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({model:'qwen3.8:27b',stream:false,think:false,messages:[{role:'user',content:'只回复：测试准备好'}],options:{num_ctx:8192,num_predict:20}}),signal:AbortSignal.timeout(90000)});
  const warmed=await warm.json();if(!warm.ok)throw new Error(JSON.stringify(warmed));writeJson(previousConfig?`warmup-resume-${Date.now()}.json`:'warmup.json',{elapsedMs:Date.now()-warmStarted,model:warmed.model,reply:warmed.message?.content});
  const selected=process.env.V2_CASES?new Set(process.env.V2_CASES.split(',')):null;
  for(const c of corpus.cases.filter(c=>!selected||selected.has(c.case_id))){
    const arms=Number(c.case_id.slice(1))%2?backends:[...backends].reverse();
    for(const b of arms)if(!done(b.arm,c.case_id,1))rows.push(await session(b,c,1));
    writeJson('aggregate-partial.json',Object.fromEntries(backends.map(b=>[b.arm,summarize(rows.filter(r=>r.arm===b.arm))])));
  }
  if(!process.env.V2_NO_REPEATS)for(let repeat=2;repeat<=3;repeat++)for(const id of config.repeatedCases.filter(id=>!selected||selected.has(id))){
    const c=corpus.cases.find(c=>c.case_id===id);
    for(const b of backends)if(!done(b.arm,c.case_id,repeat))rows.push(await session(b,c,repeat));
  }
}catch(error){writeJson('fatal-error.json',{error:error.stack});console.error(error);process.exitCode=1;}
finally{
  for(const b of backends){await b.db.backup(path.join(runDir,`${b.arm}-synthetic.db`));b.db.close();if(b.child.exitCode==null){const ended=once(b.child,'exit');b.child.kill();await ended;}writeJson(`backend-${b.arm}-logs.json`,{logs:b.logs()});}
  const primary=rows.filter(r=>r.repeat===1);
  const changed=Object.entries(protectedHashes).filter(([p,h])=>hash(fs.readFileSync(path.join(root,p)))!==h).map(([p])=>p);
  const aggregate={finishedAt:new Date().toISOString(),runtimeFilesChanged:changed,primary:Object.fromEntries(['rule','qwen38'].map(a=>[a,summarize(primary.filter(r=>r.arm===a))])),
    byRole:Object.fromEntries(['rule','qwen38'].flatMap(a=>['guardian','child'].map(role=>[a+'_'+role,summarize(primary.filter(r=>r.arm===a&&r.role===role))]))),
    repeats:config.repeatedCases.map(id=>({caseId:id,runs:rows.filter(r=>r.caseId===id).map(r=>({arm:r.arm,repeat:r.repeat,ending:r.ending,turns:r.totalTurns,firstGoal:r.turns[0]?.nextQuestion?.targetFacetId,premature:r.judgment?.premature?.verdict,omitted:r.judgment?.facts.filter(f=>f.positiveForRecall&&f.retained===false).length,repeatQuestions:r.judgment?.question_issues.filter(i=>i.kind==='repeat').length}))}))};
  writeJson('aggregate.json',aggregate);writeJson('case-summary.json',rows.map(({turns,finalState,finalEvidence,modelAudits,judgment,...r})=>({...r,judgment})));
  writeJson('collection-status.json',{savedSessions:rows.length,expectedSessions:process.env.V2_NO_REPEATS?60:84,exitCode:process.exitCode??0,complete:rows.length===(process.env.V2_NO_REPEATS?60:84),previousInstrumentationFailure:fs.existsSync(path.join(runDir,'fatal-error.json'))});
  fs.rmSync(tmp,{recursive:true,force:true});
  console.log('COMPLETE '+runDir);console.log(JSON.stringify(aggregate.primary));
  if(changed.length)throw new Error('Protected runtime files changed: '+changed.join(','));
}
