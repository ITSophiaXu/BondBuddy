import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {spoolPerformanceAttributes,workflowBudgetGuard,withChapterBudget,reportSpoolHealth} from './workflow-observability.js';
import type {DurableSpoolManifest} from './durable-spool.js';
const scope={ownerUserId:'owner',projectId:'project',runId:'run',jobId:'job',leaseToken:'private-lease-token'};
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
function alerts(){const items:{kind:string;detail:Record<string,unknown>}[]=[];const pool={query:async(_text:string,values:unknown[])=>{items.push({kind:String(values[1]),detail:values[4] as Record<string,unknown>});return {rows:[{id:'synthetic-alert'}]};}} as unknown as Pool;return {items,pool};}
test('asynchronous receipt metadata preserves original call/session identity and hashes the lease token',()=>{
 const manifest={identity:{ownerUserId:'owner',projectId:'project',runId:'run',jobId:'job',attemptId:'attempt',logicalCallId:'logical',attemptNo:2,leaseToken:scope.leaseToken,
  originalExecution:{nodeId:'node',epoch:'original-epoch',sessionId:'original-session'}}} as DurableSpoolManifest;
 const attributes=spoolPerformanceAttributes(manifest,{directory:'/private/capture',spoolId:'a'.repeat(64),manifestSha256:'b'.repeat(64)});
 assert.equal(attributes.call_id,'attempt');assert.equal(attributes.logical_call_id,'logical');assert.equal(attributes.attempt_no,2);assert.equal(attributes.spool_id,'a'.repeat(64));
 assert.equal(attributes.original_execution_node_epoch,'original-epoch');assert.equal(attributes.original_execution_session_id,'original-session');assert.equal(attributes.lease_token_sha256,digest(scope.leaseToken));
 assert.ok(!JSON.stringify(attributes).includes(scope.leaseToken));assert.ok(!JSON.stringify(attributes).includes('/private/capture'));
});
test('unknown usage and exhausted token budgets emit precise alerts without authorizing a send',async()=>{
 const a=alerts();assert.deepEqual(await workflowBudgetGuard(a.pool,scope,{used_known:0,unknown_calls:['call']},100,{chapter_id:'chapter-0'}),{kind:'pause',stage:'provider_reconcile',reason:'workflow_usage_unknown'});
 assert.deepEqual(await workflowBudgetGuard(a.pool,scope,{used_known:100,unknown_calls:[]},100,{chapter_id:'chapter-1'}),{kind:'pause',stage:'credits_exhausted',reason:'workflow_token_budget_exhausted'});
 assert.deepEqual(a.items.map(item=>item.kind),['workflow_usage_unknown','workflow_chapter_budget_exhausted']);
 assert.equal(a.items[0]!.detail.call_id,'call');assert.equal(a.items[0]!.detail.run_id,'run');assert.equal(a.items[0]!.detail.lease_token_sha256,digest(scope.leaseToken));
 assert.equal(await workflowBudgetGuard(a.pool,scope,{used_known:10,unknown_calls:[]},100),undefined);assert.equal(a.items.length,2);
});
test('deadline budget alerts retain the original exception and never extend the deadline',async()=>{
 const a=alerts(),failure=Error('WORKFLOW_REPAIR_BUDGET_EXHAUSTED');
 await assert.rejects(withChapterBudget(a.pool,scope,{chapter_id:'chapter-2'},()=>{throw failure;}),error=>error===failure);
 assert.equal(a.items[0]?.kind,'workflow_chapter_budget_exhausted');assert.equal(a.items[0]?.detail.error_code,failure.message);
});
test('spool age uses the five minute threshold and low disk emits an independent critical alert',async()=>{
 const a=alerts(),now=Date.parse('2026-11-22T00:00:00Z');
 assert.equal(await reportSpoolHealth(a.pool,{pending:1,gcPending:0,oldestPendingAt:new Date(now-300000).toISOString(),lowDisk:false,availableBytes:300000000},undefined,now),0);
 assert.equal(await reportSpoolHealth(a.pool,{pending:1,gcPending:0,oldestPendingAt:new Date(now-300001).toISOString(),lowDisk:true,availableBytes:1},undefined,now),2);
 assert.deepEqual(a.items.map(item=>item.kind),['spool_pending_stale','spool_low_disk']);
 assert.equal(a.items[0]!.detail.oldest_age_ms,300001);assert.equal(a.items[1]!.detail.available_bytes,1);
});
