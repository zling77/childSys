import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createStore} from '../server/store.mjs';
import {createStore as createRuleStore} from '../../ChildPsych-rule-baseline/server/store.mjs';
import {handleTurn} from '../core/orchestrator.mjs';
import {handleTurn as ruleTurn} from '../../ChildPsych-rule-baseline/core/orchestrator.mjs';
import {explicitNonEvidenceResponse} from '../core/semanticEvidence.mjs';
import {assessTurnEvidence,stateBuilderSettings} from '../core/llm/semanticStateBuilder.mjs';
import {createLlmRuntimeFromEnv} from '../core/llm/provider.mjs';

// Post-hoc diagnostic probe, not part of the prespecified n=30 main sample.
const out=path.resolve(process.argv[2]??'output');fs.mkdirSync(out,{recursive:true});
const tempRoot=path.resolve(os.tmpdir()),tmp=fs.mkdtempSync(path.join(tempRoot,'v2-expression-'));
const current=createStore(path.join(tmp,'current.db')),rule=createRuleStore(path.join(tmp,'rule.db'));
const runtime=createLlmRuntimeFromEnv(),settings=stateBuilderSettings();
const rows=[];
try{
  for(const profile of [{age:10,respondent:'guardian'},{age:8,respondent:'child'},{age:16,respondent:'child'}]){
    for(const answerText of ['我不知道。','这个我不知道。']){
      const speakerRole=profile.respondent;
      const question={text:speakerRole==='child'?'这种情况大概是什么时候开始的？':'孩子这种情况大概是什么时候开始的？',targetSlotOrIssue:'onset_course',targetFacetId:'onset_time'};
      const input={speakerRole,answerText,currentQuestion:question};
      const currentId=current.createSession({profile,stateBuilderMode:'semantic'}).sessionId,snapshot=current.getSnapshot(currentId);
      const prior={turnNo:1,speakerRole,questionText:'最近最困扰的是什么？',answerText:speakerRole==='child'?'我最近上学前会哭。':'孩子最近上学前会哭。'};
      snapshot.turns=[prior];
      const fast=explicitNonEvidenceResponse(input);
      const assessed=fast?{validated:{claims:[],assessments:[],responses:[fast],safety:[],rejected:[]},audit:null}:await assessTurnEvidence(snapshot,input,runtime.provider,settings);
      const result=handleTurn(snapshot,{...input,semanticAssessment:assessed.validated??{claims:[],assessments:[],responses:[],safety:[],rejected:[]}});
      const facet=result.slotStates.find(s=>s.slotId==='onset_course').value.facets.onset_time;
      const ruleId=rule.createSession({profile}).sessionId;
      const controlSnapshot=rule.getSnapshot(ruleId);controlSnapshot.turns=[prior];
      const control=ruleTurn(controlSnapshot,input).slotStates.find(s=>s.slotId==='onset_course').value.facets.onset_time;
      rows.push({profile,answerText,expectedKinds:['unavailable','uncertain'],fastPath:Boolean(fast),semanticKind:facet.responseState?.kind??null,semanticStatus:facet.status,
        correct:['unavailable','uncertain'].includes(facet.responseState?.kind),stateAudit:assessed.audit,ruleStatus:control.status,ruleValue:control.value});
      console.log(JSON.stringify(rows.at(-1)));
    }
  }
}finally{
  current.close();rule.close();
  fs.writeFileSync(path.join(out,'unknown-expression-diagnostic.json'),JSON.stringify({postHoc:true,context:'identical minimal opening about crying before school, then onset question; not a replacement for full-history observations',model:runtime.provider.evidenceModel,endpoint:process.env.PREVISIT_LLM_BASE_URL,rows},null,2));
  if(path.dirname(path.resolve(tmp))!==tempRoot||!path.basename(tmp).startsWith('v2-expression-'))throw new Error('Unsafe temporary directory');
  fs.rmSync(tmp,{recursive:true,force:true});
}
