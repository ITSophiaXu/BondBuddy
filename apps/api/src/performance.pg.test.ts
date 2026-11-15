import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import Fastify,{type LightMyRequestResponse} from 'fastify';
import {withPerformanceTrace,withPerformanceSpan,flushPerformanceTraces,recordPerformanceInterval,PerformanceTraceRuntime,type PerformanceSessionRecord,type PerformanceSpanRecord} from './performance-trace.js';
import {persistPerformanceBatch} from './performance-store.js';
import {installPerformanceRoutes} from './performance-routes.js';
import {isolatedTestDatabase} from './test-database.js';
import {grantOperator} from './log-ops.js';
import {purgePerformanceSpans} from './performance-lifecycle.js';
import {recordCommittedPerformanceDispatch} from './performance-dispatch.js';
const connection=await isolatedTestDatabase(undefined,'fine-performance');
test('real PG telemetry persists independently, owner-bound, paginated, audited and aggregated beyond snapshot limits',{skip:!connection,timeout:90000},async()=>{
 const pool=new Pool({connectionString:connection}),owner='perf-'+randomUUID(),foreign='perf-'+randomUUID(),project=randomUUID(),runId=randomUUID(),operator='perf-'+randomUUID();
 const hash='a'.repeat(64);
 try{
  for(const user of [owner,foreign,operator])await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[user,'perf_'+randomUUID().replaceAll('-','').slice(0,16)]);
  await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic performance','update')",[project,owner]);
  await pool.query("INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,1,$2,1,$3,'{}','[]','[]')",[project,owner,hash]);
  await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,created_at) VALUES($1,$2,$3,1,$4,$1,'update',$4,'queued','2026-01-01')",[runId,owner,project,hash]);
  const original=(await pool.query('SELECT state,stage,event_cursor FROM bb_runs WHERE id=$1',[runId])).rows[0];
  const scope={ownerUserId:owner,projectId:project,runId,serviceRole:'synthetic',releaseSha:'test-release'};
  await withPerformanceTrace(pool,scope,async()=>{
   for(let i=0;i<5;i++)await withPerformanceSpan('document.synthetic',{item_index:i,model_id:'test-model',model_provider:'synthetic'},span=>{if(i===4)span.end('failed',{error_code:'SYNTHETIC_FAILURE'});return i;});
   recordPerformanceInterval('job.queue_wait',{startedAt:'2026-01-01T00:00:00Z',endedAt:'2026-01-01T00:00:02Z',clockSource:'database_event_interval'});
  });
  await flushPerformanceTraces(pool,5000);
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_performance_spans WHERE run_id=$1',[runId])).rows[0].n,7);
  assert.equal((await pool.query('SELECT complete FROM bb_performance_sessions WHERE run_id=$1',[runId])).rows[0].complete,true);
  assert.deepEqual((await pool.query('SELECT state,stage,event_cursor FROM bb_runs WHERE id=$1',[runId])).rows[0],original);
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_run_events WHERE run_id=$1',[runId])).rows[0].n,0);
  assert.equal((await pool.query("SELECT count(*)::int n FROM bb_outbox WHERE aggregate_id=$1",[runId])).rows[0].n,0);
  // A fake owner cannot attach telemetry even though the run ID is real.
  let ss:PerformanceSessionRecord[]=[],ps:PerformanceSpanRecord[]=[];
  const capture=new PerformanceTraceRuntime(async(s,p)=>{ss=s;ps=p;});
  await capture.trace({...scope,ownerUserId:foreign},()=>1);await capture.drain();
  const c=await pool.connect();try{await c.query('BEGIN');await assert.rejects(persistPerformanceBatch(c,ss,ps),/SCOPE_MISMATCH/);await c.query('ROLLBACK');}finally{c.release();}
  // More runs than the legacy inspection snapshot limit, with no invented telemetry.
  await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,created_at)
    SELECT $1||'-old-'||i,$2,$3,1,$4,$1||'-old-'||i,'update',$4,'queued','2026-01-01'::timestamptz FROM generate_series(1,1001) i`,[runId,owner,project,hash]);
  await grantOperator(pool,{userId:operator,role:'log_reader',grantedBy:operator,reasonCode:'synthetic_performance'});
  const app=Fastify();app.setErrorHandler((e:any,_r,reply)=>reply.code(e.status??500).send({code:e.code,message:e.message}));
  installPerformanceRoutes(app,{db:()=>pool,owner:async request=>String(request.headers['x-test-actor']??operator)});
  try{
   assert.equal((await app.inject({url:'/api/v1/admin/performance/runs/'+runId,headers:{'x-test-actor':foreign}})).statusCode,404);
   let cursor:string|null=null;const seen:string[]=[],auditIds:string[]=[];let first:any;
   do{
    const response:LightMyRequestResponse=await app.inject('/api/v1/admin/performance/runs/'+runId+'?limit=2'+(cursor?'&cursor='+cursor:''));
    assert.equal(response.statusCode,200,response.body);assert.match(String(response.headers['cache-control']),/no-store/);
    const data=response.json();first??=data;assert.equal(data.total,7);assert.equal(data.run.ended_at,null);assert.equal(data.run.started_at,null);
    auditIds.push(data.audit_id);seen.push(...data.items.map((p:any)=>p.span_id));cursor=data.next_cursor;
   }while(cursor);
   assert.equal(seen.length,7);assert.equal(new Set(seen).size,7);
   assert.equal((await pool.query('SELECT count(*)::int n FROM bb_log_access_audit WHERE id=ANY($1::text[])',[auditIds])).rows[0].n,auditIds.length);
   const summary=await app.inject('/api/v1/admin/performance/summary?owner_user_id='+owner+'&from=2025-12-31T00:00:00Z&to=2026-01-02T00:00:00Z&step_key=document.synthetic');
   assert.equal(summary.statusCode,200,summary.body);
   const value=summary.json();assert.equal(value.scope.full_filtered_scope,true);assert.equal(value.coverage.run_count,1002);assert.equal(value.coverage.uninstrumented_run_count,1001);
   assert.equal(value.coverage.complete,false);assert.equal(value.items.reduce((sum:number,r:any)=>sum+r.span_count,0),5);
   assert(value.items.some((r:any)=>r.span_status==='failed'&&r.timed_count===1));
   assert(value.items.every((r:any)=>r.p95_ms>=0&&r.p90_ms>=0));
   const model=await app.inject('/api/v1/admin/performance/summary?owner_user_id='+owner+'&model_id=test-model&release_sha=test-release');
   assert.equal(model.statusCode,200,model.body);assert.equal(model.json().items.reduce((sum:number,r:any)=>sum+r.span_count,0),5);
   // A later insert with a historical start is excluded by the first page's membership snapshot.
   const page1=await app.inject('/api/v1/admin/performance/runs/'+runId+'?limit=1'),one=page1.json();
   await withPerformanceTrace(pool,scope,()=>recordPerformanceInterval('late.interval',{startedAt:'2025-12-31T00:00:00Z',endedAt:'2025-12-31T00:00:01Z',clockSource:'database_event_interval'}));
   await flushPerformanceTraces(pool,5000);
   const page2=await app.inject('/api/v1/admin/performance/runs/'+runId+'?limit=500&cursor='+one.next_cursor);
   assert.equal(page2.statusCode,200,page2.body);assert.equal(page2.json().total,7);assert.equal(page2.json().items.some((r:any)=>r.step_key==='late.interval'),false);


   // An insert issued before page 1 but committed later is excluded even with an old recorded_at.
   const pendingSessions:PerformanceSessionRecord[]=[],pendingSpans:PerformanceSpanRecord[]=[];
   const pendingRuntime=new PerformanceTraceRuntime(async(ss,ps)=>{pendingSessions.push(...structuredClone(ss));pendingSpans.push(...structuredClone(ps));});
   pendingRuntime.observe(scope,[{stepKey:'uncommitted.interval',interval:{startedAt:'2025-12-30T00:00:00Z',endedAt:'2025-12-30T00:00:01Z',clockSource:'database_event_interval'}}]);
   await pendingRuntime.drain();
   const pendingClient=await pool.connect();
   try{
    await pendingClient.query('BEGIN');await persistPerformanceBatch(pendingClient,pendingSessions,pendingSpans);
    const beforeCommit=await app.inject('/api/v1/admin/performance/runs/'+runId+'?limit=1'),frozen=beforeCommit.json();
    assert.equal(beforeCommit.statusCode,200,beforeCommit.body);
    await pendingClient.query('COMMIT');
    const afterCommit=await app.inject('/api/v1/admin/performance/runs/'+runId+'?limit=500&cursor='+frozen.next_cursor),rest=afterCommit.json();
    assert.equal(afterCommit.statusCode,200,afterCommit.body);assert.equal(rest.total,frozen.total);
    assert.equal(rest.items.some((p:any)=>p.step_key==='uncommitted.interval'),false);
    const fresh=await app.inject('/api/v1/admin/performance/runs/'+runId+'?limit=500');
    assert.equal(fresh.json().total,frozen.total+1);
   }finally{await pendingClient.query('ROLLBACK');pendingClient.release();}
   // Only committed admission observations are emitted; idle polls create no session.
   const sessionsBefore=Number((await pool.query('SELECT count(*) n FROM bb_performance_sessions')).rows[0].n);
   recordCommittedPerformanceDispatch(pool,null,new Date(),new Date());await flushPerformanceTraces(pool);
   assert.equal(Number((await pool.query('SELECT count(*) n FROM bb_performance_sessions')).rows[0].n),sessionsBefore);
   recordCommittedPerformanceDispatch(pool,{scope:{...scope,batchId:'synthetic-batch',workItemId:'item',itemAttempt:1},batchCreatedAt:'2026-01-01T00:00:00Z',operation:'synthetic'},new Date('2026-01-01T00:00:01Z'),new Date('2026-01-01T00:00:02Z'));
   await flushPerformanceTraces(pool,5000);
   const dispatch=(await pool.query("SELECT p.* FROM bb_performance_spans p JOIN bb_performance_sessions s USING(session_id) WHERE s.service_role='batch_dispatcher'")).rows;
   assert.equal(dispatch.length,2);assert(dispatch.every(p=>p.parent_span_id===null&&p.attributes.batch_id==='synthetic-batch'));
   assert.deepEqual(dispatch.map(p=>p.duration_ms).sort((a,b)=>a-b),[1000,2000]);
   // Capture a real finished batch for exact replay, immutable-finalization and purge tests.
   const capturedSessions:PerformanceSessionRecord[]=[],capturedSpans:PerformanceSpanRecord[]=[];
   const recorder=new PerformanceTraceRuntime(async(ss,ps)=>{
    capturedSessions.push(...structuredClone(ss));capturedSpans.push(...structuredClone(ps));
    const client=await pool.connect();try{await client.query('BEGIN');await persistPerformanceBatch(client,ss,ps);await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
   });
   await recorder.trace(scope,()=>1);await recorder.drain();
   assert.equal(capturedSpans.length,1);
   const replay=await pool.connect();
   try{
    await replay.query('BEGIN');await persistPerformanceBatch(replay,capturedSessions,capturedSpans);await replay.query('COMMIT');
    await replay.query('BEGIN');
    await assert.rejects(persistPerformanceBatch(replay,capturedSessions,capturedSpans.map(p=>({...p,duration_ms:p.duration_ms!+0.125}))),/SPAN_IDENTITY_CONFLICT/);
    await replay.query('ROLLBACK');
   }finally{replay.release();}
   const retention={contentRetentionDays:180,ownerScope:[owner],now:()=>new Date(Date.now()+181*86400000)};
   assert.deepEqual(await purgePerformanceSpans(pool,retention),{sessions:0,spans:0},'active runs are retained');
   await pool.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1",[runId]);
   const hold=randomUUID();
   await pool.query("INSERT INTO bb_log_archive_legal_holds(id,user_id,actor_id,reason_code) VALUES($1,$2,$2,'synthetic_performance')",[hold,owner]);
   assert.deepEqual(await purgePerformanceSpans(pool,retention),{sessions:0,spans:0},'active user holds are respected');
   await pool.query("UPDATE bb_log_archive_legal_holds SET released_at=now(),released_by=$2 WHERE id=$1",[hold,owner]);
   const before=Number((await pool.query('SELECT count(*) n FROM bb_performance_spans WHERE run_id=$1',[runId])).rows[0].n);
   const purged=await purgePerformanceSpans(pool,retention);
   assert.equal(purged.spans,before);assert(purged.sessions>0);
   assert.deepEqual(await purgePerformanceSpans(pool,retention),{sessions:0,spans:0});
   const after=await app.inject('/api/v1/admin/performance/runs/'+runId),receipt=after.json();
   assert.equal(after.statusCode,200,after.body);assert.equal(receipt.items.length,0);
   assert.equal(receipt.coverage.purged_span_count,before);assert.equal(receipt.coverage.complete,false);
   assert(receipt.sessions.every((s:any)=>s.purged_at&&s.purge_reason==='retention_expired'&&!s.complete));
   const retry=await pool.connect();try{await retry.query('BEGIN');await assert.rejects(persistPerformanceBatch(retry,capturedSessions,capturedSpans),/SESSION_IDENTITY_CONFLICT/);await retry.query('ROLLBACK');}finally{retry.release();}
   assert.equal(Number((await pool.query('SELECT count(*) n FROM bb_performance_spans WHERE run_id=$1',[runId])).rows[0].n),0);
  }finally{await app.close();}
 }finally{await flushPerformanceTraces(pool,1000);await pool.end();}
});
