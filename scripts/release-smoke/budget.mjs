export const AUTHORING_TIMEOUT_MS=5*60*60*1000;
export const MAX_SIZE_REPAIRS=2;
export const POSTPROCESS_ALLOWANCE_MS=30*60*1000;

export function newExecutionBudget(){
 return {version:'release-model-budget-v1',authoringTimeoutMs:AUTHORING_TIMEOUT_MS,maxSizeRepairs:MAX_SIZE_REPAIRS,maxAuthoringCalls:1+MAX_SIZE_REPAIRS,postprocessAllowanceMs:POSTPROCESS_ALLOWANCE_MS,journeyWaitBudgetMs:(1+MAX_SIZE_REPAIRS)*AUTHORING_TIMEOUT_MS+POSTPROCESS_ALLOWANCE_MS};
}
export function assertExecutionBudget(budget){
 const expected=newExecutionBudget();
 if(!budget||Object.keys(budget).length!==Object.keys(expected).length||Object.entries(expected).some(([key,value])=>budget[key]!==value))throw Error('Missing or changed execution budget; preserve the original tasks, do not resubmit them');
 return budget;
}
export function assertWorkerBudget(budget,configured,live){
 assertExecutionBudget(budget);
 if(String(configured)!==String(budget.authoringTimeoutMs)||String(live)!==String(budget.authoringTimeoutMs))throw Error('Running worker authoring timeout differs from the original execution budget');
}
export function journeyDeadline(report,now=Date.now()){
 const {journeyWaitBudgetMs}=assertExecutionBudget(report.executionBudget);
 if(!Number.isSafeInteger(now)||now<0)throw Error('Invalid journey clock');
 if(report.journeyWaitStartedAt===undefined&&report.journeyWaitDeadlineAt===undefined){
  report.journeyWaitStartedAt=new Date(now).toISOString();
  report.journeyWaitDeadlineAt=new Date(now+journeyWaitBudgetMs).toISOString();
 }
 const start=Date.parse(report.journeyWaitStartedAt),deadline=Date.parse(report.journeyWaitDeadlineAt);
 if(!Number.isSafeInteger(start)||!Number.isSafeInteger(deadline)||deadline-start!==journeyWaitBudgetMs)throw Error('Missing or changed original journey deadline');
 return deadline;
}
export function waitingExpired(report,now=Date.now()){
 return now>=journeyDeadline(report,now);
}
export function expirePendingJourneys(report,now=Date.now()){
 if(!waitingExpired(report,now))return false;
 for(const entry of report.cases.filter(c=>c.status==='submitted')){
  entry.status='failed';entry.error='Waiting exceeded the original '+report.executionBudget.journeyWaitBudgetMs/60000+' minute budget; original task retained, not resubmitted';
 }
 return true;
}
