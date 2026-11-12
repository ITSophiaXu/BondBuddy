import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {newExecutionBudget,assertExecutionBudget,assertWorkerBudget,journeyDeadline,waitingExpired,expirePendingJourneys} from './budget.mjs';
import {verdict} from './support.mjs';
const start=Date.parse('2026-11-12T00:00:00Z');
const fresh=()=>({executionBudget:newExecutionBudget(),cases:[{id:'update-rq-202509',status:'submitted',runId:'existing-run'}]});
test('budget agrees with the product five-hour timeout and two bounded file repairs',()=>{
 const adapter=readFileSync(new URL('../../apps/worker/src/codex-adapter.ts',import.meta.url),'utf8');
 const compose=readFileSync(new URL('../../deploy/m1/compose.yaml',import.meta.url),'utf8');
 const repair=readFileSync(new URL('../../apps/worker/src/file-authoring-repair.ts',import.meta.url),'utf8');
 const pipeline=readFileSync(new URL('../../apps/worker/src/run-pipeline.ts',import.meta.url),'utf8');
 assert.match(adapter,/authoring_timeout_ms: Number\(env\.BB_CODEX_AUTHORING_TIMEOUT_MS \|\| 18000000\)/);
 assert.match(compose,/BB_CODEX_AUTHORING_TIMEOUT_MS: \$\{BB_CODEX_AUTHORING_TIMEOUT_MS:-18000000\}/);
 assert.match(repair,/MAX_SIZE_REPAIRS = 2/);assert.match(pipeline,/output: options\.fileWorkspace \? \{kind:'text'\}/);
 assert.equal(newExecutionBudget().authoringTimeoutMs,18000000);assert.equal(newExecutionBudget().journeyWaitBudgetMs,55800000);
});
test('a valid three-hour run and both repair budgets remain within the finite deadline',()=>{
 const report=fresh();journeyDeadline(report,start);
 for(const elapsed of [65*60000,3*60*60000+23*60000,5*60*60000,10*60*60000,15*60*60000,55800000-1])assert.equal(expirePendingJourneys(report,start+elapsed),false);
 assert.equal(report.cases[0].status,'submitted');
 assert.equal(expirePendingJourneys(report,start+55800000),true);
 assert.equal(report.cases[0].status,'failed');assert.equal(report.cases[0].runId,'existing-run');assert.equal(verdict(report.cases),'blocked');
});
test('resume preserves the persisted budget and absolute deadline instead of buying another wait window',()=>{
 const original=fresh(),deadline=journeyDeadline(original,start),resumed=JSON.parse(JSON.stringify(original));
 assert.equal(journeyDeadline(resumed,start+4*60*60000),deadline);
 assert.equal(waitingExpired(resumed,deadline-1),false);assert.equal(waitingExpired(resumed,deadline),true);
 assert.deepEqual(resumed,original);
});
test('missing/tampered budgets and worker timeout drift are rejected without changing report',()=>{
 const budget=newExecutionBudget();assertWorkerBudget(budget,'18000000',18000000);
 for(const bad of [undefined,{}, {...budget,authoringTimeoutMs:3600000},{...budget,journeyWaitBudgetMs:Infinity},{...budget,maxSizeRepairs:3}])assert.throws(()=>assertExecutionBudget(bad));
 for(const settings of [['3600000','18000000'],['18000000','3600000'],[undefined,'18000000']])assert.throws(()=>assertWorkerBudget(budget,...settings));
 const report=fresh();journeyDeadline(report,start);report.journeyWaitDeadlineAt=new Date(start+60000).toISOString();
 assert.throws(()=>journeyDeadline(report,start+1));
 const partial=fresh();partial.journeyWaitStartedAt=new Date(start).toISOString();assert.throws(()=>journeyDeadline(partial,start));
});
test('expiration never promotes failed, paused or timed-out journeys to success',()=>{
 for(const status of ['failed','paused','timed_out']){
  const report=fresh();report.cases[0].status=status;journeyDeadline(report,start);
  expirePendingJourneys(report,start+55800000);assert.equal(report.cases[0].status,status);assert.equal(verdict(report.cases),'blocked');
 }
});
