import assert from 'node:assert/strict';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import Fastify from 'fastify';
import type {Pool} from 'pg';
import {PerformanceTraceRuntime,withPerformanceSpan,startPerformanceSpan,currentPerformanceSpanId,recordPerformanceInterval,sanitizePerformanceAttributes,type PerformanceSessionRecord,type PerformanceSpanRecord} from './performance-trace.js';
import {installPerformanceRoutes} from './performance-routes.js';
import {parsePerformanceFilters,parsePerformancePage} from './performance-data.js';
const scope={ownerUserId:'owner',projectId:'project',runId:'run',jobId:'job'};
function capture(options:ConstructorParameters<typeof PerformanceTraceRuntime>[1]={}){
 const spans=new Map<string,PerformanceSpanRecord>(),sessions=new Map<string,PerformanceSessionRecord>();
 const runtime=new PerformanceTraceRuntime(async(ss,ps)=>{for(const s of ss)sessions.set(s.session_id,structuredClone(s));for(const p of ps)spans.set(p.span_id,structuredClone(p));},options);
 return {runtime,spans,sessions};
}
test('nested and concurrent spans retain exact identities and monotonic durations; business result is unchanged',async()=>{
 const c=capture();const value=await c.runtime.trace(scope,async root=>{
  assert.equal(root.spanId,currentPerformanceSpanId());
  return withPerformanceSpan('model.call',{logical_call_id:'call',model_id:'model'},async parent=>{
   await Promise.all([withPerformanceSpan('model.tool',{tool_type:'read'},async()=>{await delay(20);}),withPerformanceSpan('model.tool',{tool_type:'write'},async()=>{await delay(10);})]);
   return {parent:parent.spanId,value:42};
  });
 });await c.runtime.drain();
 assert.equal(value.value,42);assert.equal(c.spans.size,4);
 const tools=[...c.spans.values()].filter(s=>s.step_key==='model.tool');
 assert.equal(tools.length,2);assert(tools.every(s=>s.parent_span_id===value.parent&&s.attributes.logical_call_id==='call'&&s.attributes.model_id==='model'));
 assert(tools.every(s=>s.duration_ms!==null&&s.duration_ms>=5));assert.equal([...c.sessions.values()][0].complete,true);
 assert.equal(currentPerformanceSpanId(),null);
});
test('explicit reused/paused outcomes survive wrappers; errors propagate by identity; missing end stays incomplete',async()=>{
 const c=capture(),failure=new Error('business failure');
 await c.runtime.trace(scope,async root=>{
  await withPerformanceSpan('model.replay',{},span=>{span.end('reused');return 'cached';});
  await assert.rejects(withPerformanceSpan('document.render',{},()=>{throw failure;}),e=>e===failure);
  startPerformanceSpan('tool.unfinished',{});
  root.end('paused');
 });await c.runtime.flush();
 const rows=[...c.spans.values()];
 assert.equal(rows.find(s=>s.step_key==='model.replay')?.status,'reused');
 assert.equal(rows.find(s=>s.step_key==='document.render')?.status,'failed');
 assert.equal(rows.find(s=>s.step_key==='run.execution')?.status,'paused');
 assert.equal(rows.find(s=>s.step_key==='tool.unfinished')?.duration_ms,null);
 assert.equal([...c.sessions.values()][0].complete,false);
});
test('database and claim observation intervals are root siblings with true historical duration',async()=>{
 const c=capture();await c.runtime.trace(scope,async()=>{
  recordPerformanceInterval('job.queue_wait',{startedAt:'2026-01-01T00:00:00Z',endedAt:'2026-01-01T00:00:02Z',clockSource:'database_event_interval'});
  recordPerformanceInterval('worker.claim',{startedAt:'2026-01-01T00:00:00Z',endedAt:'2026-01-01T00:00:01Z',clockSource:'wall_clock_observation'});
 });await c.runtime.drain();const rows=[...c.spans.values()].filter(s=>s.step_key!=='run.execution');
 assert.deepEqual(rows.map(r=>r.duration_ms),[2000,1000]);assert(rows.every(r=>r.parent_span_id===null));
});
test('no-context instrumentation is a no-op and private text/URLs/commands are rejected',async()=>{
 assert.equal(startPerformanceSpan('test',{}).spanId,null);
 assert.equal(await withPerformanceSpan('test',{},()=>7),7);
 const {attributes,invalid}=sanitizePerformanceAttributes({prompt:'secret',command:'rm stuff',tool_name:'https://secret?token=abc',bytes:4,ttft_ms:null,first_stdout_ms:null,timing_complete:false,tool_type:'read'});
 assert.deepEqual(attributes,{bytes:4,ttft_ms:null,first_stdout_ms:null,timing_complete:false,tool_type:'read'});assert.equal(invalid,3);
});
test('bounded overflow is counted and a failed sink never changes a business result or exception',async()=>{
 const c=capture({maxPending:2});
 const result=await c.runtime.trace(scope,async()=>{for(let i=0;i<8;i++)await withPerformanceSpan('short.step',{},()=>i);return 9;});await c.runtime.drain();
 assert.equal(result,9);assert([...c.sessions.values()].some(s=>s.dropped>0&&!s.complete));assert(c.spans.size<=2);
 const error=new Error('same'),broken=new PerformanceTraceRuntime(async()=>{throw Error('sink unavailable');});
 assert.equal(await broken.trace({...scope,runId:'broken'},()=>42),42);await broken.flush();
 await assert.rejects(broken.trace({...scope,runId:'other'},()=>{throw error;}),e=>e===error);
 await broken.drain(10);
});
test('strict performance filter and cursor validation rejects extra keys and cross-run cursors',()=>{
 assert.throws(()=>parsePerformanceFilters({sql:'delete'}));assert.throws(()=>parsePerformanceFilters({step_key:"x' OR 1=1"}));
 assert.throws(()=>parsePerformanceFilters({from:'2026-01-02T00:00:00Z',to:'2026-01-01T00:00:00Z'}));
 assert.throws(()=>parsePerformancePage('run',{limit:0}));
 const cursor=Buffer.from(JSON.stringify({run_id:'other',started_at:new Date().toISOString(),snapshot_at:new Date().toISOString(),span_id:'span'})).toString('base64url');
 assert.throws(()=>parsePerformancePage('run',{cursor}));
 assert.equal(parsePerformancePage('run',{}).limit,200);
});
test('performance routes require log_reader before reading/auditing any operational data',async()=>{
 for(const allowed of [false,true]){
  const calls:string[]=[];const query=async(sql:string)=>{calls.push(sql);if(sql.includes('bb_operator_grants'))return {rows:allowed?[{role:'log_reader'}]:[]};return {rows:[]};};
  const app=Fastify();app.setErrorHandler((e:any,_r,reply)=>reply.code(e.status??500).send({code:e.code}));
  installPerformanceRoutes(app,{db:()=>({query,connect:async()=>({query,release(){}})} as unknown as Pool),owner:async()=> 'viewer'});
  try{const response=await app.inject('/api/v1/admin/performance/summary?unexpected=1');assert.equal(response.statusCode,allowed?422:404);assert.equal(calls.length,1);}finally{await app.close();}
 }
});

test('closed missing-end sessions do not exhaust bounded tracing and a late end can finish the receipt',async()=>{
 const c=capture({maxSessions:1});let late:ReturnType<typeof startPerformanceSpan>|undefined;
 for(let i=0;i<4;i++){
  await c.runtime.trace({...scope,runId:'missing-'+i},()=>{const handle=startPerformanceSpan('missing.step');if(i===0)late=handle;});
  await c.runtime.drain();
 }
 assert.equal(c.sessions.size,4);assert([...c.sessions.values()].every(s=>!s.complete));
 late?.end('interrupted');await c.runtime.drain();
 assert.equal([...c.spans.values()].find(p=>p.run_id==='missing-0'&&p.step_key==='missing.step')?.status,'interrupted');
 assert.equal([...c.sessions.values()].find(s=>s.run_id==='missing-0')?.complete,true);
});

test('completed dispatch observations have no synthetic execution root, retain batch identity and fractional milliseconds',async()=>{
 const c=capture();
 c.runtime.observe({...scope,batchId:'batch',workItemId:'item',itemAttempt:2},[
  {stepKey:'batch.dispatch_transaction',interval:{startedAt:'2026-01-01T00:00:01Z',endedAt:'2026-01-01T00:00:02Z',clockSource:'wall_clock_observation'},attributes:{measurement_source:'transaction_call_through_commit'}},
  {stepKey:'batch.item_wait',interval:{startedAt:'2026-01-01T00:00:00Z',endedAt:'2026-01-01T00:00:02Z',clockSource:'wall_clock_observation'},attributes:{wait_reason:'total_elapsed_including_pauses'}}
 ]);
 await c.runtime.drain();assert.equal(c.spans.size,2);
 assert([...c.spans.values()].every(p=>p.parent_span_id===null&&p.attributes.batch_id==='batch'&&p.attributes.item_attempt===2));
 assert.equal([...c.sessions.values()][0].complete,true);
 await c.runtime.trace(scope,()=>withPerformanceSpan('fractional.step',{},()=>1));await c.runtime.drain();
 assert.equal(typeof [...c.spans.values()].find(p=>p.step_key==='fractional.step')?.duration_ms,'number');
});
