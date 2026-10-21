import fs from 'node:fs';
import path from 'node:path';

const dir=path.resolve(process.argv[2]??'');
if(!process.argv[2])throw new Error('Usage: node scripts/v2-benchmark-report.mjs <run-directory>');
const config=JSON.parse(fs.readFileSync(path.join(dir,'config.json'),'utf8'));
const corpus=JSON.parse(fs.readFileSync(config.corpusPath,'utf8'));
const reviewDir=path.join(dir,'review-indexed-v2');
const rows=fs.readdirSync(dir).filter(n=>/^trajectory-.*\.json$/.test(n)).map(file=>{
  const row=JSON.parse(fs.readFileSync(path.join(dir,file),'utf8'));
  const reviewFile=path.join(reviewDir,file);
  return {...row,file,review:fs.existsSync(reviewFile)?JSON.parse(fs.readFileSync(reviewFile,'utf8')):null};
});
const primary=rows.filter(r=>r.repeat===1);
const median=a=>{if(!a.length)return null;const x=[...a].sort((a,b)=>a-b);return x.length%2?x[(x.length-1)/2]:(x[x.length/2-1]+x[x.length/2])/2;};
const mean=a=>a.length?a.reduce((n,v)=>n+v,0)/a.length:null;
const pct=(k,n)=>n?100*k/n:null;
const expectedSafetyTypes={R014:'psychotic_like',R016:'suicide',R017:'abuse',R026:'suicide',R027:'bullying',R028:'psychotic_like'};
const unknownAsDeclined=row=>row.modelAudits.flatMap((a,index)=>(a.output?.responses??[]).filter(r=>r.kind==='declined'&&/不知道|不清楚|不记得|记不清|没观察|无法观察/.test(r.quote??'')&&!/不想|不愿|拒|别问/.test(r.quote??'')).map(r=>({auditIndex:index,facet:r.facetId,quote:r.quote})));
const unpromotedSafety=row=>row.modelAudits.flatMap((a,index)=>(a.output?.safetyCandidates??[]).filter(c=>!(a.output.safety??[]).some(s=>s.signal_type===c.signal_type&&s.quote===c.quote)).map(c=>({auditIndex:index,...c})));
function percentile(a,p){if(!a.length)return null;const x=[...a].sort((a,b)=>a-b);return x[Math.min(x.length-1,Math.ceil(p*x.length)-1)];}
function wilson(k,n){if(!n)return null;const z=1.96,p=k/n,d=1+z*z/n,m=(p+z*z/(2*n))/d,h=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d;return [m-h,m+h].map(v=>+(100*v).toFixed(2));}
function metrics(items){
  const reviewed=items.filter(r=>r.review),eligible=reviewed.flatMap(r=>r.review.facts.filter(f=>f.eligible)),disclosed=eligible.filter(f=>f.disclosed);
  const natural=items.filter(r=>r.ending==='natural_complete'),early=natural.filter(r=>r.review?.early?.[0]==='yes');
  const questions=items.flatMap(r=>r.turns.filter(t=>t.turn>1&&t.card!=='CONTROL_RETRY'));
  const issues=reviewed.flatMap(r=>r.review.issues),hasIssue=kind=>reviewed.filter(r=>r.review.issues.some(i=>i.kind===kind));
  const expectSafety=items.filter(r=>r.expectedSafety),normal=items.filter(r=>!r.expectedSafety);
  const normalNatural=normal.filter(r=>r.ending==='natural_complete');
  const timings=items.flatMap(r=>r.turns.map(t=>t.latencyMs/1000));
  const groupedErrors={};for(const r of items)for(const a of r.modelAudits.filter(a=>a.status==='error'))groupedErrors[a.error]=(groupedErrors[a.error]??0)+1;
  return {sessions:items.length,reviewed:reviewed.length,naturalComplete:natural.length,
    safetyHandoff:items.filter(r=>r.ending==='safety_handoff').length,expectedSafetyCases:expectSafety.length,
    correctSafetyHandoff:expectSafety.filter(r=>r.ending==='safety_handoff').length,
    expectedSafetyTypeMatched:expectSafety.filter(r=>r.ending==='safety_handoff'&&r.finalRisk.some(s=>s.signalType===expectedSafetyTypes[r.caseId])).length,
    missedExpectedSafety:expectSafety.filter(r=>r.ending!=='safety_handoff').map(r=>r.caseId),
    additionalSafetyHandoff:normal.filter(r=>r.ending==='safety_handoff').map(r=>r.caseId),
    explicitRiskNegationFalseHandoff:items.filter(r=>r.caseId==='R025'&&r.ending==='safety_handoff').length,
    turnCap:items.filter(r=>['rule_hard_cap','turn_cap'].includes(r.ending)).length,stalled:items.filter(r=>r.ending==='model_stalled').length,
    missingQuestion:items.filter(r=>r.ending==='missing_question').length,
    eligibleFacts:eligible.length,retainedEligible:eligible.filter(f=>f.retained===true).length,omittedEligible:eligible.filter(f=>f.retained===false).length,
    uncertainEligible:eligible.filter(f=>f.retained===null).length,eligibleRetentionPct:pct(eligible.filter(f=>f.retained===true).length,eligible.length),
    disclosedEligible:disclosed.length,disclosedButNotRetained:disclosed.filter(f=>f.retained===false).length,disclosedUncertain:disclosed.filter(f=>f.retained===null).length,
    undisclosedEligible:eligible.filter(f=>!f.disclosed).length,
    earlyCases:early.map(r=>r.caseId),earlyAmongReviewedNaturalDenominator:natural.filter(r=>r.review).length,
    earlyAmongReviewedNaturalPct:pct(early.length,natural.filter(r=>r.review).length),earlyAmongReviewedNatural95CI: wilson(early.length,natural.filter(r=>r.review).length),
    repeatQuestions:issues.filter(i=>i.kind==='repeat').length,casesWithRepeat:hasIssue('repeat').map(r=>r.caseId),
    repeatCase95CI:wilson(hasIssue('repeat').length,reviewed.length),
    refusalQuestions:issues.filter(i=>i.kind==='refusal').length,casesWithRefusalViolation:hasIssue('refusal').map(r=>r.caseId),
    unavailableQuestions:issues.filter(i=>i.kind==='unavailable').length,casesWithUnavailableReask:hasIssue('unavailable').map(r=>r.caseId),
    generatedContentQuestions:questions.length,exactDuplicateQuestions:items.reduce((n,r)=>n+(r.exactDuplicateQuestions?.length??0),0),
    medianTurns:median(items.map(r=>r.totalTurns)),meanTurns:mean(items.map(r=>r.totalTurns)),totalTurns:items.reduce((n,r)=>n+r.totalTurns,0),
    controlRetries:items.flatMap(r=>r.turns).filter(t=>t.card==='CONTROL_RETRY').length,
    medianSystemSeconds:median(items.map(r=>r.systemTimeMs/1000)),meanSystemSeconds:mean(items.map(r=>r.systemTimeMs/1000)),totalSystemSeconds:items.reduce((n,r)=>n+r.systemTimeMs,0)/1000,
    perRequestSeconds:{p50:median(timings),p95:percentile(timings,.95),max:timings.length?Math.max(...timings):null},
    ordinaryMedianTurns:median(normal.map(r=>r.totalTurns)),ordinaryMedianSystemSeconds:median(normal.map(r=>r.systemTimeMs/1000)),
    ordinaryNaturallyCompleted:normalNatural.length,ordinaryNaturalMedianTurns:median(normalNatural.map(r=>r.totalTurns)),ordinaryNaturalMedianSystemSeconds:median(normalNatural.map(r=>r.systemTimeMs/1000)),
    medianSimulatorSeconds:median(items.map(r=>r.simulatorTimeMs/1000)),modelAuditRows:items.reduce((n,r)=>n+r.modelAudits.length,0),
    medianClosedLoopWallSeconds:median(items.map(r=>r.wallBeforeJudgeMs/1000)),totalClosedLoopWallSeconds:items.reduce((n,r)=>n+r.wallBeforeJudgeMs,0)/1000,
    modelErrorRows:items.reduce((n,r)=>n+r.modelErrors,0),modelErrors:groupedErrors,
    casesWithUnknownAsDeclined:items.filter(r=>unknownAsDeclined(r).length).map(r=>r.caseId),unknownAsDeclinedRecords:items.flatMap(unknownAsDeclined).length,
    casesWithUnpromotedSafetyCandidates:items.filter(r=>unpromotedSafety(r).length).map(r=>r.caseId),
    evidenceErrorFlags:reviewed.flatMap(r=>r.review.evidenceErrors).length,
    simulatorMismatchFlags:reviewed.flatMap(r=>r.review.simulatorMismatches).length,simulatorMismatchCases:reviewed.filter(r=>r.review.simulatorMismatches.length).map(r=>r.caseId)};
}
let rng=20261021;
function random(){rng^=rng<<13;rng^=rng>>>17;rng^=rng<<5;return (rng>>>0)/4294967296;}
function bootstrap(values){if(!values.length)return null;const means=[];for(let k=0;k<5000;k++){let n=0;for(let i=0;i<values.length;i++)n+=values[Math.floor(random()*values.length)];means.push(n/values.length);}return {pairs:values.length,meanDifference:mean(values),pairedCaseBootstrap95CI:[percentile(means,.025),percentile(means,.975)]};}
const pairs=corpus.cases.map(c=>({caseId:c.case_id,rule:primary.find(r=>r.caseId===c.case_id&&r.arm==='rule'),qwen:primary.find(r=>r.caseId===c.case_id&&r.arm==='qwen38')})).filter(p=>p.rule&&p.qwen);
const strata={observationInference:['R002','R006','R007','R010'],limitedSource:['R003','R005','R008','R009','R013'],crossFamily:['R012','R030'],
  vagueIronyDigression:['R001','R019','R020','R023','R024','R029'],privacyRefusal:['R011','R022','R030'],riskNegation:['R025'],safety:['R014','R016','R017','R026','R027','R028'],reasonableStop:['R018','R022']};
function firstStateSignature(row){
  const out=row.modelAudits.find(a=>a.task==='semantic_evidence_assessment')?.output;
  if(!out)return null;
  return JSON.stringify((out.assessments??[]).map(a=>[a.facetId,a.requirements.map(r=>[r.id,r.status==='met']).sort()]).sort());
}
const repeats=config.repeatedCases.map(caseId=>({caseId,arms:['rule','qwen38'].map(arm=>{
  const runs=rows.filter(r=>r.caseId===caseId&&r.arm===arm).sort((a,b)=>a.repeat-b.repeat);
  const sig=runs.map(firstStateSignature);
  return {arm,runs:runs.length,endings:runs.map(r=>r.ending),turns:runs.map(r=>r.totalTurns),systemSeconds:runs.map(r=>r.systemTimeMs/1000),
    firstGoals:runs.map(r=>r.turns[0]?.nextQuestion?.targetFacetId),firstStateSignatures:sig,
    firstStateSame:runs.length===3&&sig.every(s=>s!==null)&&new Set(sig).size===1,
    outcomeSame:runs.length===3&&new Set(runs.map(r=>r.ending)).size===1,
    reviews:runs.map(r=>r.review?{early:r.review.early,omitted:r.review.facts.filter(f=>f.eligible&&f.retained===false).length,issues:r.review.issues.length}:null)};
})}));
const report={runDirectory:dir,protocol:config,primary:Object.fromEntries(['rule','qwen38'].map(a=>[a,metrics(primary.filter(r=>r.arm===a))])),
  safetyDetails:primary.filter(r=>r.expectedSafety||r.ending==='safety_handoff').map(r=>({caseId:r.caseId,arm:r.arm,ending:r.ending,expectedType:expectedSafetyTypes[r.caseId],
    requiredDisclosureTurn:r.caseId==='R027'?r.turns.find(t=>['T2','B1'].includes(t.card))?.turn??null:1,
    riskSignals:r.finalRisk.map(s=>({type:s.signalType,turn:s.turnNo,quote:s.triggerText})),firstNextQuestion:r.turns[0].nextQuestion})),
  unknownAsDeclinedDetails:primary.flatMap(r=>unknownAsDeclined(r).map(x=>({caseId:r.caseId,arm:r.arm,...x}))),
  unpromotedSafetyDetails:primary.flatMap(r=>unpromotedSafety(r).map(x=>({caseId:r.caseId,arm:r.arm,...x}))),
  byRole:Object.fromEntries(['rule','qwen38'].flatMap(a=>['guardian','child'].map(role=>[a+'_'+role,metrics(primary.filter(r=>r.arm===a&&r.role===role))]))),
  byAge:Object.fromEntries(['rule','qwen38'].flatMap(a=>['6-11','12-14','15-18'].map(age=>[a+'_'+age,metrics(primary.filter(r=>r.arm===a&&r.ageBand===age))]))),
  byStratum:Object.fromEntries(Object.entries(strata).map(([name,ids])=>[name,Object.fromEntries(['rule','qwen38'].map(a=>[a,metrics(primary.filter(r=>r.arm===a&&ids.includes(r.caseId)))]))])),
  qualityControlled:{definition:'Both arms have valid indexed review and no flagged simulator mismatch; full intention-to-test results remain primary.',
    pairs:pairs.filter(p=>p.rule.review&&p.qwen.review&&!p.rule.review.simulatorMismatches.length&&!p.qwen.review.simulatorMismatches.length).length,
    arms:Object.fromEntries(['rule','qwen38'].map(arm=>[arm,metrics(pairs.filter(p=>p.rule.review&&p.qwen.review&&!p.rule.review.simulatorMismatches.length&&!p.qwen.review.simulatorMismatches.length).map(p=>arm==='rule'?p.rule:p.qwen))]))},
  paired:{systemSecondsDifference:bootstrap(pairs.map(p=>(p.qwen.systemTimeMs-p.rule.systemTimeMs)/1000)),turnsDifference:bootstrap(pairs.map(p=>p.qwen.totalTurns-p.rule.totalTurns)),
    perCaseRetentionPctDifference:bootstrap(pairs.filter(p=>p.rule.review&&p.qwen.review).map(p=>{
      const rate=r=>{const f=r.review.facts.filter(f=>f.eligible);return f.length?100*f.filter(f=>f.retained===true).length/f.length:0;};return rate(p.qwen)-rate(p.rule);
    }))},repeats,
  limitations:['Synthetic n=30; no clinician annotation agreement study.','Indexed automatic reviewer is Qwen3.6 from the same family, not independent clinical ground truth.',
    'Eligible fact retention is relative to available corpus facts, including explicit absences; it is not a clinical omission/diagnostic rate.',
    'Question-level model flags need human adjudication; exact duplicates are reported separately.',
    'System time excludes respondent routing and offline review; warm-up is separately recorded. Shared LAN GPU timings do not establish deployment-wide performance.',
    'Safety handoff is ordinary-interview termination, not completion of a clinical safety assessment. Test-capped/stalled interviews are retained as censored outcomes.']};
fs.writeFileSync(path.join(dir,'final-metrics.json'),JSON.stringify(report,null,2));
const escape=x=>'"'+String(x??'').replaceAll('"','""')+'"';
const headers=['caseId','arm','repeat','role','age','ending','totalTurns','systemSeconds','retryControls','retainedEligible','eligibleFacts','omittedEligible','early','repeatQuestions','refusalQuestions','unavailableQuestions','exactDuplicateQuestions','modelErrors','simulatorMismatchFlags'];
const csv=rows.map(r=>{const f=r.review?.facts.filter(f=>f.eligible)??[];const iss=r.review?.issues??[];return [r.caseId,r.arm,r.repeat,r.role,r.age,r.ending,r.totalTurns,r.systemTimeMs/1000,r.turns.filter(t=>t.card==='CONTROL_RETRY').length,f.filter(f=>f.retained===true).length,f.length,f.filter(f=>f.retained===false).length,r.review?.early[0],iss.filter(i=>i.kind==='repeat').length,iss.filter(i=>i.kind==='refusal').length,iss.filter(i=>i.kind==='unavailable').length,r.exactDuplicateQuestions?.length,r.modelErrors,r.review?.simulatorMismatches.length].map(escape).join(',');});
fs.writeFileSync(path.join(dir,'case-summary.csv'),'\uFEFF'+headers.join(',')+'\n'+csv.join('\n'));
console.log(JSON.stringify({sessions:rows.length,reviewed:rows.filter(r=>r.review).length,primary:report.primary,paired:report.paired},null,2));
