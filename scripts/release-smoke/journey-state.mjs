import {AUTHORING_TIMEOUT_MS,POSTPROCESS_ALLOWANCE_MS,MAX_SIZE_REPAIRS} from './budget.mjs';

const minute=60000;
export const FLOW_BUDGET_VERSION='release-five-flow-budget-v1';
export function newFlowBudget(){
 const cases={
  'update-rq-202509':(1+MAX_SIZE_REPAIRS)*AUTHORING_TIMEOUT_MS+POSTPROCESS_ALLOWANCE_MS,
  'review-dongying':AUTHORING_TIMEOUT_MS+POSTPROCESS_ALLOWANCE_MS,
  'qa-dongying':7*2*10*minute+POSTPROCESS_ALLOWANCE_MS,
  'integrity-dongying':AUTHORING_TIMEOUT_MS+POSTPROCESS_ALLOWANCE_MS,
  'workpaper-dongying':AUTHORING_TIMEOUT_MS+POSTPROCESS_ALLOWANCE_MS,
 };
 return {version:FLOW_BUDGET_VERSION,structuredTimeoutMs:10*minute,maxSchemaReasks:1,qaQuestions:7,workpaperSharedPlans:1,cases,suiteBudgetMs:Object.values(cases).reduce((a,b)=>a+b,0)};
}
export function assertFlowBudget(value){
 const expected=newFlowBudget();
 if(!value||JSON.stringify(value)!==JSON.stringify(expected))throw Error('Missing or changed five-flow monitoring budget; preserve original tasks');
 return value;
}
function fixedDeadline(target,startKey,endKey,budget,now){
 if(!Number.isSafeInteger(now)||now<0)throw Error('Invalid monitoring clock');
 if(target[startKey]===undefined&&target[endKey]===undefined){target[startKey]=new Date(now).toISOString();target[endKey]=new Date(now+budget).toISOString();}
 const start=Date.parse(target[startKey]),end=Date.parse(target[endKey]);
 if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||end-start!==budget)throw Error('Missing or changed original monitoring deadline');
 return end;
}
export function caseDeadline(report,entry,now=Date.now()){
 const budget=assertFlowBudget(report.flowBudget),duration=budget.cases[entry.id];
 if(!duration)throw Error('Unknown release journey');
 const suite=fixedDeadline(report,'suiteWaitStartedAt','suiteWaitDeadlineAt',budget.suiteBudgetMs,now);
 return Math.min(suite,fixedDeadline(entry,'waitStartedAt','waitDeadlineAt',duration,now));
}
export function classifyState(state,{batch=false}={}){
 if((batch&&state==='complete')||(!batch&&state==='succeeded'))return 'ready';
 if(['preparing','queued','running','validating','delivering','settlement_pending'].includes(state))return 'waiting';
 if(['awaiting_input','paused'].includes(state))return 'attention';
 return 'failed';
}
export function expireCase(report,entry,now=Date.now()){
 if(now<caseDeadline(report,entry,now))return false;
 if(entry.status!=='passed'){
  entry.status='failed';entry.error='Original journey monitoring deadline expired; accepted task retained without resubmission';
 }
 return true;
}
export function assertSubmissionCanStart(entry){
 if(entry.submissionRequest&&!entry.submissionReceipt)throw Error('An original task request has no resolved receipt; do not submit another task');
 if(entry.submissionConflict)throw Error('Task submission identity changed; preserve both attempts for diagnosis');
}
