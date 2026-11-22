import assert from 'node:assert/strict';
import test from 'node:test';
import {executionTiming,duration,durationStats} from './admin-inspection-timing.js';
import type {AdminInspectionRow as Row} from '@bondbuddy/contracts';

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
