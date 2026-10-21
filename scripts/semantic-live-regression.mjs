import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

// Explicit live command only; never part of the deterministic regression suite.
// Inputs and databases are synthetic. Existing patient records are not opened.
const root=mkdtempSync(join(tmpdir(),'previsit-live-'));
const dbPath=join(root,'synthetic.db');
const holder=createServer(); await new Promise(r=>holder.listen(0,'127.0.0.1',r));
const port=holder.address().port; await new Promise(r=>holder.close(r));
const base=`http://127.0.0.1:${port}`;
const deadline=process.env.PREVISIT_LIVE_STATE_TIMEOUT_MS??process.env.PREVISIT_STATE_TIMEOUT_MS??'8000';
let output='',db;
const child=spawn(process.execPath,['server/index.mjs'],{cwd:process.cwd(),windowsHide:true,
  env:{...process.env,HOST:'127.0.0.1',PORT:String(port),PREVISIT_DB_PATH:dbPath,PREVISIT_MEDIA_ROOT:join(root,'media'),
    PREVISIT_STATE_BUILDER_MODE:'semantic',PREVISIT_STATE_TIMEOUT_MS:deadline,PREVISIT_STATE_OUTPUT_FORMAT:process.env.PREVISIT_STATE_OUTPUT_FORMAT??'json_schema',
    PREVISIT_LLM_MODE:'dynamic',PREVISIT_DIALOGUE_AUDIT_MODE:'off',PREVISIT_CLINICIAN_LLM_MODE:'off',PREVISIT_OLLAMA_SSH_HOST:''},
  stdio:['ignore','pipe','pipe']});
child.stdout.on('data',c=>{output+=c;});child.stderr.on('data',c=>{output+=c;});
const report={synthetic:true,endpoint:process.env.PREVISIT_LLM_BASE_URL,stateDeadlineMs:Number(deadline),cases:[],checks:[],failures:[]};
const check=(name,test)=>{try{test();report.checks.push(name);console.log('PASS '+name);}catch(e){report.failures.push({name,error:e.message});console.log('FAIL '+name+': '+e.message);}};
const request=async(path,body)=>{const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(40000)});if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.json();};
const facet=(s,id)=>s.slotStates.flatMap(s=>Object.values(s.value?.facets??{})).find(f=>f.facetId===id);
function record(name,s){
  const rows=db.prepare('SELECT task,model,status,latency_ms,error FROM model_audit_log WHERE session_id=? AND turn_no=? ORDER BY created_at').all(s.session.sessionId,s.turns.at(-1).turnNo);
  const current=s.nextQuestion;
  const boundary=JSON.parse(db.prepare('SELECT boundary_check_result_json b FROM next_question_decision_log WHERE session_id=? AND turn_no=?').get(s.session.sessionId,s.turns.at(-1).turnNo).b);
  report.cases.push({name,age:s.session.profile.age,role:s.session.profile.respondent,audits:rows,frequency:facet(s,'frequency')?.sufficiency,recentEpisode:facet(s,'recent_episode')?.sufficiency,
    nextTarget:current?.targetFacetId,acknowledgement:current?.acknowledgement,question:current?.questionText??current?.text,
    modelAccepted:boundary.modelSuggestionAccepted,rejectionReason:boundary.modelRejectionReason});
  if (rows.some(a=>a.task==='llm_dynamic_next_question'&&a.status==='error')) report.cases.at(-1).decisionErrors = db.prepare("SELECT output_json FROM model_audit_log WHERE session_id=? AND turn_no=? AND task='llm_dynamic_next_question'").all(s.session.sessionId,s.turns.at(-1).turnNo).map(r=>JSON.parse(r.output_json??'null'));
  console.log(JSON.stringify(report.cases.at(-1)));
  check(name+' actual evidence model completed',()=>assert.ok(rows.some(a=>a.task==='semantic_evidence_assessment'&&a.status==='success')));
  check(name+' actual question model completed and was accepted',()=>{
    if(current?.targetSlotOrIssue==='safety_clues') {
      assert.equal(rows.some(a=>a.task==='llm_dynamic_next_question'),false);
      return;
    }
    assert.ok(rows.some(a=>a.task==='llm_dynamic_next_question'&&a.status==='success'));
    assert.equal(s.decisionLogs.at(-1).boundaryCheckResult.modelSuggestionAccepted,true);
  });
}
try{
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}
  if(!ready)throw new Error('Temporary test backend failed to start: '+output.slice(-300));
  db=new Database(dbPath,{readonly:true});
  for(const c of [
    {name:'guardian-current-distress',role:'guardian',age:10,text:'孩子最近两周在上学前哭过三次，我现在很着急。',emotion:true},
    {name:'child-6-11',role:'child',age:8,text:'我这两周上学前哭过三次，我现在很害怕。',emotion:true},
    {name:'child-12-14-other-emotion',role:'child',age:13,text:'我这两周上学前哭过三次，妈妈说她很生气。',emotion:false},
    {name:'child-15-18',role:'child',age:16,text:'我最近两周上学前哭过三次，我现在很难过。',emotion:true},
  ]){
    const s=await request('/api/previsit/sessions',{profile:{age:c.age,respondent:c.role},speakerRole:c.role,chiefComplaint:c.text});
    record(c.name,s);
    check(c.name+' sufficient frequency is not asked again',()=>{assert.equal(facet(s,'frequency').sufficiency,'sufficient');assert.notEqual(s.nextQuestion?.targetFacetId,'frequency');});
    check(c.name+' acknowledgement and audience',()=>{
      assert.equal(Boolean(s.nextQuestion?.acknowledgement),c.emotion);
      assert.equal((s.nextQuestion?.text.match(/[？?]/g)??[]).length,1);
      if(c.role==='guardian')assert.doesNotMatch(s.nextQuestion.text,/你/);else assert.doesNotMatch(s.nextQuestion.text,/您/);
    });
  }
  let s=await request('/api/previsit/sessions',{profile:{age:10,respondent:'guardian'},chiefComplaint:'孩子哭过三次。'});
  record('count-without-window',s);
  check('count alone remains partial',()=>assert.equal(facet(s,'frequency').sufficiency,'partial'));
  s=await request('/api/previsit/turns',{sessionId:s.session.sessionId,expectedTurnNo:s.turns.length+1,answerText:'最近两周。',
    currentQuestion:{text:'这三次是多长时间内发生的？',targetSlotOrIssue:'frequency_severity',targetFacetId:'frequency'}});
  record('cross-turn-window',s);
  check('cross-turn completion prevents repeated full-frequency question',()=>{
    assert.equal(facet(s,'frequency').sufficiency,'sufficient');assert.notEqual(s.nextQuestion?.targetFacetId,'frequency');
  });
  check('a time-only supplement does not imply unavailable further information or end the interview',()=>assert.notEqual(s.session.status,'completed'));
  // Keep a premature completion as a failure, but do not let its HTTP 409 hide
  // the independent refusal and already-disclosed-event tests that follow.
  if(s.session.status==='completed')s=await request('/api/previsit/sessions',{profile:{age:10,respondent:'guardian'},chiefComplaint:'孩子最近两周在上学前哭过三次。'});
  s=await request('/api/previsit/turns',{sessionId:s.session.sessionId,expectedTurnNo:s.turns.length+1,answerText:'这个我不想说。',
    currentQuestion:{text:'最近一次发生了什么？',targetSlotOrIssue:'current_manifestations',targetFacetId:'recent_episode'}});
  check('scoped refusal is respected and does not reopen completed frequency',()=>{
    assert.equal(facet(s,'recent_episode').status,'declined');assert.notEqual(s.nextQuestion?.targetFacetId,'recent_episode');assert.equal(facet(s,'frequency').sufficiency,'sufficient');
  });
  s=await request('/api/previsit/sessions',{profile:{age:10,respondent:'guardian'},chiefComplaint:
    '孩子最近两周在上学前哭过三次。最近一次是上周一早上在家准备上学时，他抱着书包哭着说不想去学校，最后迟到半小时。'});
  record('concrete-event-already-disclosed',s);
  check('LLM reads the disclosed event and changes direction even if a synonymous state field was not filled',()=>{
    assert.equal(facet(s,'frequency').sufficiency,'sufficient');
    assert.notEqual(s.nextQuestion?.targetFacetId,'recent_episode');assert.notEqual(s.nextQuestion?.targetFacetId,'frequency');
  });
  console.log(`Live regression: ${report.checks.length} passed, ${report.failures.length} failed`);
}catch(error){report.failures.push({name:'live-run',error:error.message});console.error(error.message);}
finally{
  mkdirSync('output',{recursive:true});
  if(existsSync('output/semantic-live-regression.json'))copyFileSync('output/semantic-live-regression.json',`output/semantic-live-regression-${Date.now()}.json`);
  writeFileSync('output/semantic-live-regression.json',JSON.stringify(report,null,2));
  db?.close();if(child.exitCode==null){const ended=once(child,'exit');child.kill();await ended;}
  rmSync(root,{recursive:true,force:true});
}
if(report.failures.length)process.exitCode=1;
