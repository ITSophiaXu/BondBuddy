import {test} from 'node:test';
import assert from 'node:assert/strict';
import {newFlowBudget,assertFlowBudget,caseDeadline,classifyState,expireCase,assertSubmissionCanStart} from './journey-state.mjs';
const now=Date.parse('2026-11-12T00:00:00Z');
test('all five serial journeys have independent finite budgets; workpapers use one shared plan',()=>{
 const budget=newFlowBudget();assert.equal(Object.keys(budget.cases).length,5);
 assert.equal(budget.cases['update-rq-202509'],55800000);assert.equal(budget.cases['qa-dongying'],170*60000);
 assert.equal(budget.workpaperSharedPlans,1);assert.equal(budget.cases['workpaper-dongying'],330*60000);
 assert.equal(budget.suiteBudgetMs,Object.values(budget.cases).reduce((a,b)=>a+b,0));
});
test('resume cannot reset either case or suite deadline, and a second case has its own budget',()=>{
 const report={flowBudget:newFlowBudget()},first={id:'update-rq-202509'},second={id:'qa-dongying'};
 const deadline=caseDeadline(report,first,now);const copy=JSON.parse(JSON.stringify({report,first}));
 assert.equal(caseDeadline(copy.report,copy.first,now+3600000),deadline);assert.deepEqual(copy,{report,first});
 assert.equal(caseDeadline(report,second,now+3600000),now+3600000+170*60000);
 const preserved=first.runId='original';first.status='submitted';assert.equal(expireCase(report,first,deadline),true);
 assert.equal(first.status,'failed');assert.equal(first.runId,preserved);
});
test('partial, changed or old budgets fail closed without rewriting their deadlines',()=>{
 for(const budget of [undefined,{}, {...newFlowBudget(),version:'old'},{...newFlowBudget(),suiteBudgetMs:Infinity}])assert.throws(()=>assertFlowBudget(budget));
 const report={flowBudget:newFlowBudget()},entry={id:'update-rq-202509',waitStartedAt:new Date(now).toISOString()};
 assert.throws(()=>caseDeadline(report,entry,now));assert.equal(entry.waitDeadlineAt,undefined);
});
test('settlement and delivery stay pending; failures, partial batches and test-only completions never pass',()=>{
 for(const state of ['preparing','queued','running','validating','delivering','settlement_pending'])assert.equal(classifyState(state),'waiting');
 assert.equal(classifyState('succeeded'),'ready');assert.equal(classifyState('complete',{batch:true}),'ready');
 for(const state of ['failed','cancelled','rejected','partial','test_completed','unknown','complete'])assert.equal(classifyState(state),'failed');
 for(const state of ['paused','awaiting_input'])assert.equal(classifyState(state),'attention');
});
test('a sent task with a lost receipt cannot silently become a new submission',()=>{
 assert.throws(()=>assertSubmissionCanStart({submissionRequest:{requestId:'old'}}),/do not submit/);
 assert.throws(()=>assertSubmissionCanStart({submissionRequest:{},submissionReceipt:{},submissionConflict:true}),/identity changed/);
 assertSubmissionCanStart({});assertSubmissionCanStart({submissionRequest:{},submissionReceipt:{run_id:'old'}});
});
