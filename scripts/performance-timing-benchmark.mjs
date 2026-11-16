// Synthetic async workload, real isolated PostgreSQL sink. No provider or production data.
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {isolatedTestDatabase} from '../apps/worker/dist/test-database.js';
import {withPerformanceTrace,withPerformanceSpan,flushPerformanceTraces} from '../apps/api/dist/performance-trace.js';
const database=await isolatedTestDatabase(undefined,'performance-benchmark');
if(!database)throw Error('BB_TEST_DATABASE_URL must identify a disposable migrated test template');
const pool=new Pool({connectionString:database}),owner=randomUUID(),project=randomUUID(),run=randomUUID(),hash='b'.repeat(64);
try{
 await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'perf_'+randomUUID().slice(0,8)]);
 await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic timing benchmark','update')",[project,owner]);
 await pool.query("INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,1,$2,1,$3,'{}','[]','[]')",[project,owner,hash]);
 await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,1,$4,$1,'update',$4,'queued')",[run,owner,project,hash]);
 const work=async()=>{for(let i=0;i<50;i++)await withPerformanceSpan('benchmark.synthetic_io',{item_index:i},()=>delay(20));};
 const measure=async enabled=>{const start=performance.now();if(enabled)await withPerformanceTrace(pool,{ownerUserId:owner,projectId:project,runId:run,serviceRole:'synthetic'},work);else await work();return performance.now()-start;};
 await measure(false);await measure(true);await flushPerformanceTraces(pool,5000);
 const pairs=[];
 for(let i=0;i<5;i++){
  let baseline,instrumented;
  if(i%2){instrumented=await measure(true);baseline=await measure(false);}else{baseline=await measure(false);instrumented=await measure(true);}
  await flushPerformanceTraces(pool,5000);pairs.push({baseline_ms:baseline,instrumented_ms:instrumented,delta_ms:instrumented-baseline,delta_percent:100*(instrumented-baseline)/baseline});
 }
 const median=values=>values.toSorted((a,b)=>a-b)[Math.floor(values.length/2)];
 const receipts=(await pool.query('SELECT count(*)::int sessions,count(*) FILTER(WHERE complete)::int complete_sessions,sum(dropped)::int dropped,sum(flush_errors)::int flush_errors FROM bb_performance_sessions WHERE run_id=$1',[run])).rows[0];
 console.log(JSON.stringify({synthetic:true,workload:'50 sequential asynchronous waits of 20 ms per run',pairs,median_delta_ms:median(pairs.map(p=>p.delta_ms)),median_delta_percent:median(pairs.map(p=>p.delta_percent)),receipts,note:'Local scheduling and load affect this benchmark; not a production speedup or real-model benchmark.'},null,2));
}finally{await flushPerformanceTraces(pool,1000);await pool.end();}
