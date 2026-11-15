import assert from 'node:assert/strict';
import test from 'node:test';
import {executionTiming,duration,durationStats} from './admin-inspection-timing.js';
import type {AdminInspectionRow as Row} from '@bondbuddy/contracts';
import {Inspection,type Snapshot} from './admin-inspection-model.js';
import {timingPanel,timingSummary} from './admin-inspection-render.js';

const created='2026-11-04T01:00:00Z',captured='2026-11-04T02:00:00Z';
const run:Row={id:'r',state:'succeeded',created_at:created,updated_at:captured};
const event=(seq:number,state:string,seconds:number):Row=>({run_id:'r',seq,type:'run.state_changed',state,occurred_at:new Date(Date.parse(created)+seconds*1000).toISOString()});

test('completed duration uses the actual terminal transition, not later updates or repeated terminal events',()=>{
 const events=[event(1,'queued',0),event(2,'running',2),event(3,'succeeded',62),event(4,'succeeded',100)];
 const t=executionTiming(run,events,captured);
 assert.equal(t.totalMs,62000);assert.equal(t.initialWaitMs,2000);assert.equal(t.processingMs,60000);
 assert.equal(t.endedAt,'2026-11-04T01:01:02.000Z');assert.equal(t.open,false);
});
test('missing or contradictory terminal evidence stays unknown instead of using updated_at',()=>{
 for(const events of [[],[event(1,'queued',0),event(2,'running',2)],[event(1,'queued',0),event(2,'failed',60)]]){
  assert.equal(executionTiming(run,events,captured).totalMs,null);
 }
 assert.equal(executionTiming(run,[event(1,'queued',0),event(2,'succeeded',-1)],captured).totalMs,null);
 assert.equal(executionTiming(run,[event(1,'queued',0),event(2,'succeeded',4000)],captured).totalMs,null);
});
test('missing initial events do not turn a later resumed execution into first start',()=>{
 const t=executionTiming(run,[event(20,'running',10),event(25,'succeeded',30)],captured);
 assert.equal(t.totalMs,30000);assert.equal(t.initialWaitMs,null);assert.equal(t.processingMs,null);
});
test('active and paused elapsed time ends at snapshot capture, and includes pauses',()=>{
 const events=[event(1,'queued',0),event(2,'running',2),event(3,'paused',60)];
 const t=executionTiming({...run,state:'paused'},events,captured);
 assert.equal(t.totalMs,3600000);assert.equal(t.processingMs,3598000);assert.equal(t.endedAt,null);assert.equal(t.open,true);
});
test('a resumed failed run includes earlier work; another run cannot supply its timing',()=>{
 const t=executionTiming(run,[event(1,'queued',0),event(2,'running',2),event(3,'failed',60),event(4,'queued',80),event(5,'running',90),event(6,'succeeded',120),{...event(7,'succeeded',150),run_id:'other'}],captured);
 assert.equal(t.totalMs,120000);assert.equal(t.processingMs,118000);assert.equal(t.initialWaitMs,2000);
});
test('a task cancelled before starting has a total but no fabricated processing or queue duration',()=>{
 const t=executionTiming({...run,state:'cancelled'},[event(1,'queued',0),event(2,'cancelled',10)],captured);
 assert.equal(t.totalMs,10000);assert.equal(t.processingMs,null);assert.equal(t.initialWaitMs,null);
});
test('duration formatting preserves subsecond waits, long durations and unknowns',()=>{
 assert.equal(duration(533),'533 毫秒');assert.equal(duration(2034920),'33 分 54 秒');assert.equal(duration(90061000),'1 天 1 小时 1 分 1 秒');assert.equal(duration(null),'未知');assert.equal(duration(-1),'未知');
});
test('duration summaries use known samples, distinguish empty from zero, and retain slow tails',()=>{
 const values=[...Array.from({length:19},(_,i)=>(i+1)*1000),100000];const stats=durationStats(values.reverse());
 assert.equal(stats.count,20);assert.equal(stats.mean,14500);assert.equal(stats.p50,10000);assert.equal(stats.p95,19000);assert.equal(stats.max,100000);
 assert.deepEqual(durationStats([]),{count:0,mean:null,p50:null,p95:null,max:null});assert.equal(durationStats([0]).mean,0);
});

test('stage timings prefer reported duration and fall back to start/end timestamps',()=>{
 const at=(seconds:number)=>new Date(Date.parse(created)+seconds*1000).toISOString();
 const events=[
  {run_id:'r',seq:1,type:'run.progress',stage:'input_lock',occurred_at:at(1),payload:{reason:'stage_started'}},
  {run_id:'r',seq:2,type:'run.progress',stage:'input_lock',occurred_at:at(3),payload:{reason:'stage_completed'}},
  {run_id:'r',seq:3,type:'run.progress',stage:'provider_call',occurred_at:at(10),payload:{reason:'stage_started'}},
  {run_id:'r',seq:4,type:'run.progress',stage:'provider_call',occurred_at:at(12),payload:{reason:'stage_completed',duration_ms:7000}},
  {run_id:'r',seq:5,type:'run.progress',stage:'word_delivery',occurred_at:at(20),payload:{reason:'stage_completed'}},
 ] as unknown as Row[];
 const t=executionTiming(run,events,captured);
 assert.deepEqual(t.stages,[{stage:'input_lock',ms:2000},{stage:'provider_call',ms:7000}]);
});

test('scalar inspection rows render stage details and summary while preserving the existing total table',()=>{
 const at=(seconds:number)=>new Date(Date.parse(created)+seconds*1000).toISOString();
 const rows:Row[]=[
  {run_id:'r',seq:1,type:'run.progress',stage:'input_lock',occurred_at:at(1),reason:'stage_started',duration_ms:null},
  {run_id:'r',seq:2,type:'run.progress',stage:'input_lock',occurred_at:at(3),reason:'stage_completed',duration_ms:'2000'},
  {run_id:'r',seq:3,type:'run.progress',stage:'provider_call',occurred_at:at(10),reason:'stage_started',duration_ms:null},
  {run_id:'r',seq:4,type:'run.progress',stage:'provider_call',occurred_at:at(12),reason:'stage_completed',duration_ms:'7000'},
 ];
 const snapshot:Snapshot={schema_version:1,captured_at:captured,source:'synthetic_test',release:null,scope:{run_limit:1000,run_count:1,available_run_count:1,description:'synthetic scalar API snapshot'},warnings:[],
  tables:[{name:'bb_runs',available:true,total:1,truncated:false,rows:[run]},{name:'bb_run_events',available:true,total:rows.length,truncated:false,rows}]};
 const data=new Inspection(JSON.parse(JSON.stringify(snapshot)));
 assert.deepEqual(data.timing(run).stages,[{stage:'input_lock',ms:2000},{stage:'provider_call',ms:7000}]);
 const detail=timingPanel(data,run),summary=timingSummary(data,[run]);
 assert.match(detail,/各阶段耗时/);assert.match(detail,/锁定输入/);assert.match(detail,/模型调用/);assert.match(detail,/7 秒/);
 assert.match(summary,/data-stage-duration-summary/);assert.match(summary,/平均总耗时/);
 assert.match(summary,/平均排队/);assert.match(summary,/平均处理/);
});

test('missing and malformed scalar durations fall back to timestamps without becoming zero',()=>{
 const at=(seconds:number)=>new Date(Date.parse(created)+seconds*1000).toISOString();
 for(const value of [undefined,null,'','  ','invalid',-1,Infinity,false]){
  const rows:Row[]=[
   {run_id:'r',seq:1,type:'run.progress',stage:'input_lock',occurred_at:at(1),reason:'stage_started'},
   {run_id:'r',seq:2,type:'run.progress',stage:'input_lock',occurred_at:at(3),reason:'stage_completed',duration_ms:value as Row[string]},
   {run_id:'r',seq:3,type:'run.progress',stage:'missing_start',occurred_at:at(4),reason:'stage_completed',duration_ms:value as Row[string]},
  ];
  assert.deepEqual(executionTiming(run,rows,captured).stages,[{stage:'input_lock',ms:2000}],String(value));
 }
 assert.deepEqual(executionTiming(run,[{run_id:'r',seq:1,type:'run.progress',stage:'instant',reason:'stage_completed',duration_ms:'0'}],captured).stages,[{stage:'instant',ms:0}]);
});

test('restarted stages use their latest start and ignore another run',()=>{
 const at=(seconds:number)=>new Date(Date.parse(created)+seconds*1000).toISOString();
 const rows:Row[]=[
  {run_id:'r',seq:1,type:'run.progress',stage:'input_lock',occurred_at:at(1),reason:'stage_started'},
  {run_id:'r',seq:2,type:'run.progress',stage:'input_lock',occurred_at:at(8),reason:'stage_started'},
  {run_id:'other',seq:3,type:'run.progress',stage:'input_lock',occurred_at:at(9),reason:'stage_started'},
  {run_id:'r',seq:4,type:'run.progress',stage:'input_lock',occurred_at:at(10),reason:'stage_completed',duration_ms:null},
 ];
 assert.deepEqual(executionTiming(run,rows,captured).stages,[{stage:'input_lock',ms:2000}]);
});
