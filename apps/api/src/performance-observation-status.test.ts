import test from 'node:test';
import assert from 'node:assert/strict';
import {PerformanceTraceRuntime,recordPerformanceInterval,type PerformanceSpanRecord,type PerformanceSessionRecord,type PerformanceInterval} from './performance-trace.js';
test('completed child observations preserve failed and cancelled outcomes and reject running or negative intervals',async()=>{
 const spans=new Map<string,PerformanceSpanRecord>(),sessions=new Map<string,PerformanceSessionRecord>();
 const runtime=new PerformanceTraceRuntime(async(ss,ps)=>{for(const row of ss)sessions.set(row.session_id,row);for(const row of ps)spans.set(row.span_id,row);});
 const interval={startedAt:'2026-11-22T00:00:00.000Z',endedAt:'2026-11-22T00:00:00.020Z',clockSource:'wall_clock_observation' as const};
 await runtime.trace({ownerUserId:'owner',projectId:'project',runId:'run',jobId:'job'},async()=>{
  recordPerformanceInterval('spool.readback',{...interval,status:'failed'},{measurement_source:'private_blob_child_observation'});
  recordPerformanceInterval('spool.cancelled',{...interval,status:'cancelled'},{});
  recordPerformanceInterval('spool.default',interval,{});
  recordPerformanceInterval('spool.invalid',{...interval,status:'running'} as unknown as PerformanceInterval,{});
  recordPerformanceInterval('spool.negative',{...interval,endedAt:'2026-11-21T23:59:59Z',status:'failed'},{});
 });await runtime.drain();
 const rows=[...spans.values()],failed=rows.find(row=>row.step_key==='spool.readback')!;
 assert.equal(failed.status,'failed');assert.equal(failed.duration_ms,20);assert.equal(failed.clock_source,'wall_clock_observation');
 assert.equal(rows.find(row=>row.step_key==='spool.cancelled')!.status,'cancelled');assert.equal(rows.find(row=>row.step_key==='spool.default')!.status,'succeeded');
 assert.ok(!rows.some(row=>row.step_key==='spool.invalid'||row.step_key==='spool.negative'));
 assert.equal([...sessions.values()][0]!.invalid_attributes,2);assert.equal([...sessions.values()][0]!.dropped,2);assert.equal([...sessions.values()][0]!.complete,false);
});
