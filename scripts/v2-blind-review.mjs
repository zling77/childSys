import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Offline review only, after timed conversations have finished. No system edits.
const directory=path.resolve(process.argv[2]??'');
if(!process.argv[2])throw new Error('Usage: node scripts/v2-blind-review.mjs <run-directory>');
const config=JSON.parse(fs.readFileSync(path.join(directory,'config.json'),'utf8'));
const corpus=JSON.parse(fs.readFileSync(config.corpusPath,'utf8'));
const out=path.join(directory,'review-indexed-v2');fs.mkdirSync(out,{recursive:true});
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const rubric=[
  '你是技术测试的版本标签隐藏评审员。不推测算法、模型或版本，不偏好简短或冗长的访谈。不作诊断。金标准只是合成语料标注，不表示每一事实都必须问到。',
  '输入questions是系统实际问的问题，answers是受访者实际回答，两者分开排列。Q1为固定开场，不评价为系统选题错误。',
  'control=true只是界面的继续/技术重试，不是内容问题，不计重复追问，不撤销先前拒答，也不能补充任何患者事实。',
  '每条gold分别判断：是否在answers实际披露；是否正确进入最终结构化证据/状态。未披露不等于模型抽取遗漏，须分开。背景可能包含未被询问的信息。',
  'retained=yes必须出现在合适证据或状态中，且信息的肯否、时间范围、观察/转述/推测/未知没有被扭曲。仅保留整段原始访谈，不等于每个事实已结构化。可用等价字段；没有专门字段不自动判错。',
  'retained=yes给出实际存在的E编号或S编号；no/uncertain给空数组。E是证据、S是字段状态，只是引用编号，不代表算法版本。disclosure_ref只给实际披露该事实的一个A编号，没披露则null。已有question前提不能当患者事实。',
  '判断重复必须读Q里的问题内容与先前A里的信息。不能仅因新问题得到相同回答或不知道就判重复。尤其频率时间范围不同于开始时间；第一次询问开始时间不能因为已有频率范围就判重复。',
  'repeat：已获得可用答案后再次索取同一事实；第一次澄清、真正补缺、核实明确矛盾不算。unavailable：已经明确本来源不知道某一事实后仍问该事实。refusal：本人已明确拒绝的同一内容被换标签或措辞重问。',
  '拒答某一事件细节不妨碍询问独立生活影响。另一个人的拒绝不等于当前回答者自己拒绝；但不能让当前来源猜测他人内心或逼迫他人披露。',
  'issues每项引用一个当前Q和一个在它之前的A，必须直接支持问题；禁止仅因卡片编号重复而判断重复。一个问题可涉及多个问题类型，但每种类型每个Q只列一次。',
  '只有natural_complete评估过早结束。概况已可用或剩余信息确实不可获得，可带着未填字段结束。只有未获得仍可提供、且缺少它会妨碍理解实际困扰的关键事实，才early=yes。规则硬上限、测试上限、安全交接、缺题、模型卡住均为early=na。',
  'source/polarity/time/unsupported错误必须有一个实际evidence/state id。估计次数或模糊时间可以充分，但不能被精确化；推测不能升级为确定原因。他人经历不能算本人经历。',
  'sim只列严重答非所问或错误透露当前来源不能知道的信息；自然长答附加相关信息允许。avoid是语料错误提醒，只在本次实际上下文满足条件时使用。',
  'Q1/A1为原语料固定输入，含有故意设计的含糊或跑题，不评价成模拟器错误。sim只检查后续回答路由。',
  '不要抄写任何原话，用已有编号引用。只输出紧凑JSON：',
  '{"facts":[["T1G1","yes",["evidence或state id"],"A1"]],"issues":[["Q4","A2","repeat"]],"early":["no",[]],"errors":[["source","实际id"]],"sim":[["Q2","off_topic"]]}',
  'facts每项依次为gold id、retained（yes/no/uncertain）、refs数组、disclosure_ref（A编号或null）。每个gold恰好一次。issues的kind只有repeat/refusal/unavailable。early依次为yes/no/uncertain/na、缺少的gold编号。errors的kind只有source/polarity/time/unsupported。sim依次为Q编号、off_topic或source_scope。无问题使用空数组。禁止输出reason、解释、依据或推理文字，只输出标签和已有编号。'
].join('\n');
const sha=hash(rubric);fs.writeFileSync(path.join(out,'protocol.json'),JSON.stringify({rubric,rubricHash:sha,reviewerModel:config.evaluatorModel,reviewerEndpoint:config.evaluatorBase,
  codeHash:hash(fs.readFileSync(import.meta.filename)),temperature:0,seed:20261021,limitations:'Same-family automated reviewer; no clinical human ground-truth adjudication.'},null,2));
const eligible=g=>!/(?:context|attribution|opinion|unknown|unavailable|limited|unverified|uncertain|not_reported|did_not_understand|declined|unresolved|secondhand_uncertain|alternative_explanation|out_of_subject|not_verified|inference)/.test(g.status);
const names=fs.readdirSync(directory).filter(f=>/^trajectory-.*\.json$/.test(f)).sort((a,b)=>hash(a).localeCompare(hash(b)));
for(const name of names){
  if(process.env.V2_REVIEW_CASES&&!process.env.V2_REVIEW_CASES.split(',').some(id=>name.includes(id)))continue;
  const dest=path.join(out,name);
  if(fs.existsSync(dest)&&!process.env.V2_REVIEW_FORCE)continue;
  const row=JSON.parse(fs.readFileSync(path.join(directory,name),'utf8'));
  const c=corpus.cases.find(c=>c.case_id===row.caseId);
  const gold=c.turns.flatMap(t=>t.gold_updates.map((g,i)=>({id:`T${t.turn}G${i+1}`,...g,eligible:eligible(g)})));
  const referenceIndex=new Map();
  const state=row.finalState.map((s,i)=>{const id=`S${i+1}`;referenceIndex.set(id,s.id);return {id,field:s.id,label:s.label,status:s.status,sufficiency:s.sufficiency,value:s.value,response:s.response};});
  const evidence=row.finalEvidence.map((e,i)=>{
    const id=`E${i+1}`;referenceIndex.set(id,e.evidenceId);
    const claim=e.value?.semanticClaim;
    return {id,slot:e.slotId,facet:claim?.facetId??e.facetId,turn:e.turnNo,text:e.rawText,polarity:e.polarity,source:e.source,
      subject:claim?.subject,sourceMode:claim?.sourceMode,reportedSource:claim?.reportedSource,timeScope:claim?.timeScope,certainty:claim?.certainty,
      provenance:e.value?.provenance};
  });
  const questions=row.turns.map(t=>({id:`Q${t.turn}`,text:t.question,target:t.target??null,control:t.card==='CONTROL_RETRY'}));
  const answers=row.turns.map(t=>({id:`A${t.turn}`,text:t.answer}));
  const ending=row.ending==='natural_complete'&&/24轮安全上限/.test(row.completionReason??'')?'rule_hard_cap':row.ending;
  const input={profile:c.profile,style:c.style_tags,gold,hiddenBackground:c.background_for_simulation,avoid:c.turns.flatMap(t=>t.avoid??[]),questions,answers,ending,state,evidence};
  const messages=[{role:'system',content:rubric},{role:'user',content:JSON.stringify(input)}];
  let finalError;
  for(let attempt=1;attempt<=2;attempt++){
    const started=Date.now();
    try{
      const response=await fetch(config.evaluatorBase+'/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:config.evaluatorModel,stream:false,think:false,format:'json',keep_alive:'30m',messages,
        options:{num_ctx:16384,num_predict:2200,temperature:0,seed:20261021}}),signal:AbortSignal.timeout(90000)});
      const data=await response.json();if(!response.ok)throw new Error(data.error??`HTTP ${response.status}`);
      const text=data.message?.content??'';const output=JSON.parse(text.slice(text.indexOf('{'),text.lastIndexOf('}')+1));
      fs.appendFileSync(path.join(out,'calls.jsonl'),JSON.stringify({file:name,attempt,output,inputHash:hash(JSON.stringify(messages)),elapsedMs:Date.now()-started,promptTokens:data.prompt_eval_count,outputTokens:data.eval_count})+'\n');
      const facts=output.facts??[];
      if(!Array.isArray(output.early)||!['yes','no','uncertain','na'].includes(output.early[0]))throw new Error('invalid_early_verdict');
      if(facts.length!==gold.length||new Set(facts.map(f=>f[0])).size!==gold.length||facts.some(f=>!gold.some(g=>g.id===f[0])))throw new Error('invalid_gold_ids');
      const refs=new Set([...state.map(s=>s.id),...evidence.map(e=>e.id)]);
      for(const f of facts){
        if(!['yes','no','uncertain'].includes(f[1])||!Array.isArray(f[2]))throw new Error('invalid_fact_shape');
        if(f[1]==='yes'&&(!f[2].length||f[2].some(id=>!refs.has(id))))throw new Error('untraceable_retention_reference');
        if(f[1]==='yes'&&f[3]===null)throw new Error('retention_without_disclosure');
        if(f[3]!==null&&!answers.some(a=>a.id===f[3]))throw new Error('untraceable_disclosure_reference');
      }
      const rejected=[];
      const issues=(output.issues??[]).filter(i=>{
        const qt=Number(String(i[0]).slice(1)),at=Number(String(i[1]).slice(1));
        const valid=questions.some(q=>q.id===i[0]&&!q.control)&&answers.some(a=>a.id===i[1])&&qt>1&&at<qt&&['repeat','refusal','unavailable'].includes(i[2]);
        if(!valid)rejected.push(i);return valid;
      });
      const dedup=[...new Map(issues.map(i=>[i[0]+'-'+i[2],i])).values()];
      const result={file:name,caseId:row.caseId,arm:row.arm,repeat:row.repeat,ending,rubricHash:sha,
        referenceIndex:Object.fromEntries(referenceIndex),
        facts:facts.map(f=>({id:f[0],retained:f[1]==='yes'?true:f[1]==='no'?false:null,refs:f[2].map(id=>referenceIndex.get(id)??id),disclosed:f[3]!==null,disclosureRef:f[3],reason:f[4],eligible:gold.find(g=>g.id===f[0]).eligible})),
        issues:dedup.map(i=>({question:i[0],previousAnswer:i[1],kind:i[2],questionText:questions.find(q=>q.id===i[0]).text,previousAnswerText:answers.find(a=>a.id===i[1]).text})),
        early:ending==='natural_complete'?output.early:['na',[],'Not natural completion'],evidenceErrors:(output.errors??[]).map(e=>[e[0],referenceIndex.get(e[1])??e[1]]),simulatorMismatches:(output.sim??[]).filter(m=>Number(String(m[0]).slice(1))>1),rejectedIssues:rejected};
      fs.writeFileSync(dest,JSON.stringify(result,null,2));console.log(JSON.stringify({file:name,facts:result.facts.length,issues:result.issues.length,early:result.early[0],simulatorIssues:result.simulatorMismatches.length}));
      finalError=null;break;
    }catch(error){finalError=error;fs.appendFileSync(path.join(out,'errors.jsonl'),JSON.stringify({file:name,attempt,error:error.message})+'\n');}
  }
  if(finalError){console.log('REVIEW_ERROR '+name+' '+finalError.message);process.exitCode=1;}
}
