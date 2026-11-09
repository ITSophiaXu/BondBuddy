// Synthetic operator trends in a real, isolated PostgreSQL clone. No provider or payment is called.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {Pool} from 'pg';
import {Value} from '@sinclair/typebox/value';
import {adminDashboardSchemas} from '@bondbuddy/contracts';
import {isolatedTestDatabase} from './test-database.js';
import {adminDashboardOverview,adminDashboardTasks,adminDashboardUsers,parseDashboardFilter} from './admin-dashboard.js';

const connection=await isolatedTestDatabase('BB_TEST_ADMIN_DASHBOARD_DATABASE_URL','admin-dashboard-trends');
const day=(value:string,offset=0)=>new Date(Date.parse(value.slice(0,10)+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);
async function fixture(options:{timezone?:string}={}){
  const pool=new Pool({connectionString:connection,max:1,...(options.timezone?{options:'-c timezone='+options.timezone}:{})});
  const owner=randomUUID(),project=randomUUID();
  await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'admin_trend_'+owner.slice(0,8)]);
  await pool.query('INSERT INTO bb_credit_accounts(owner_user_id) VALUES($1)',[owner]);
  await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic admin trend','update')",[project,owner]);
  await pool.query("INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,1,$2,1,$3,'{}','[]','[]')",[project,owner,'a'.repeat(64)]);
  async function run(at:string,state='failed'){
    const id=randomUUID();
    await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,created_at,updated_at) VALUES($1,$2,$3,1,$4,$1,'update',$4,$5,$6,$6)",[id,owner,project,'a'.repeat(64),state,at]);
    return id;
  }
  async function settle(runId:string,points:number){
    const id=randomUUID();
    // Synthetic persisted accounting observations, not a checkout or a new charge.
    await pool.query("INSERT INTO bb_credit_events(id,owner_user_id,event_key,kind,points,run_id,actor,reason) VALUES($1,$2,$1,'settle',$3,$4,'synthetic-test','admin trend aggregate fixture')",[id,owner,points,runId]);
  }
  async function usage(runId:string,model:string,input:number,output:number,duplicate=false){
    const proposedJob=randomUUID(),attempt=randomUUID(),logical='synthetic-'+attempt;
    await pool.query("INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state) VALUES($1,$2,$3,'update','synthetic','failed') ON CONFLICT (run_id) DO NOTHING",[proposedJob,owner,runId]);
    const job=(await pool.query('SELECT id FROM bb_jobs WHERE owner_user_id=$1 AND run_id=$2',[owner,runId])).rows[0].id as string;
    await pool.query("INSERT INTO bb_model_call_attempts(id,owner_user_id,job_id,logical_call_id,attempt_no,status,model_id,created_at) VALUES($1,$2,$3,$4,1,'completed',$5,'2026-01-01T00:00:00Z')",[attempt,owner,job,logical,model]);
    for(const source of duplicate?['provider','framework']:['provider']){
      await pool.query("INSERT INTO bb_usage_observations(id,owner_user_id,attempt_id,source,source_event_id,usage_status,input_tokens,output_tokens) VALUES($1,$2,$3,$4,$1,'measured',$5,$6)",[randomUUID(),owner,attempt,source,input,output]);
    }
    await pool.query("INSERT INTO bb_model_call_attempt_runtime(id,owner_user_id,project_id,job_id,run_id,trace_id,attempt_id,logical_call_id,attempt_no,adapter,adapter_version,model_provider,model_config_version,provider_request_id_status,started_at,duration_ms,tool_attempts,pricing_status) VALUES($1,$2,$3,$4,$5,$5,$6,$7,1,'codex_exec','synthetic-1','synthetic_trend','synthetic-1','unknown','2026-01-01T00:00:00Z',10,0,'unknown')",[randomUUID(),owner,project,job,runId,attempt,logical]);
  }
  return {pool,owner,run,settle,usage};
}
const overview=(h:Awaited<ReturnType<typeof fixture>>,query:Record<string,string>)=>adminDashboardOverview(h.pool,h.owner,parseDashboardFilter({user_id:h.owner,...query}));

test('default UTC trend contains all 14 calendar days including idle dates, while summary remains unrestricted',{skip:!connection},async()=>{
  const h=await fixture();
  try{
    const today=(await h.pool.query("SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD') AS date")).rows[0].date as string;
    await h.run(today+'T00:00:00Z');await h.run(day(today,-13)+'T12:00:00Z');await h.run(day(today,-30)+'T12:00:00Z');
    const result=await overview(h,{});
    assert.equal(result.tasks,3);assert.deepEqual(result.range,{from:null,to:null});
    assert.equal(result.daily.length,14);assert.equal(result.daily[0].date,day(today,-13));assert.equal(result.daily.at(-1)!.date,today);
    assert.equal(result.daily.reduce((n,p)=>n+p.tasks,0),2);
    assert.equal(result.daily.filter(p=>p.tasks===0).length,12);
    assert.ok(result.daily.every(p=>p.cost_amount===null&&p.currency===null));
  }finally{await h.pool.end();}
});

test('historical to anchors the default 14-day trend without discarding older summary tasks',{skip:!connection},async()=>{
  const h=await fixture();
  try{
    await h.run('2026-10-01T12:00:00Z');await h.run('2026-10-14T12:00:00Z');await h.run('2026-09-01T12:00:00Z');
    const result=await overview(h,{to:'2026-10-14'});
    assert.equal(result.tasks,3);assert.equal(result.daily.length,14);
    assert.equal(result.daily[0].date,'2026-10-01');assert.equal(result.daily.at(-1)!.date,'2026-10-14');
    assert.equal(result.daily.reduce((n,p)=>n+p.tasks,0),2);
  }finally{await h.pool.end();}
});

test('90, 91 and 120-day filters keep complete summaries and paginated details with a schema-valid last-90-day trend',{skip:!connection},async()=>{
  const h=await fixture();
  try{
    for(let i=0;i<120;i++)await h.run(day('2026-01-01',i)+'T12:00:00Z');
    for(const days of [90,91,120]){
      const query={user_id:h.owner,from:'2026-01-01',to:day('2026-01-01',days-1),limit:'100'};
      const filter=parseDashboardFilter(query),result=await adminDashboardOverview(h.pool,h.owner,filter);
      assert.equal(result.tasks,days);assert.equal(result.daily.length,Math.min(days,90));
      assert.equal(result.daily[0].date,day('2026-01-01',Math.max(0,days-90)));
      assert.equal(result.daily.at(-1)!.date,query.to);
      assert.equal(result.daily.reduce((n,p)=>n+p.tasks,0),Math.min(days,90));
      assert.ok(result.daily.every(p=>p.tasks===1&&p.active_users===1));
      assert.ok(Value.Check(adminDashboardSchemas.AdminDashboardOverviewResponse,result),'the existing maxItems=90 contract remains valid');
      const users=await adminDashboardUsers(h.pool,h.owner,filter);assert.equal(users.items[0].runs,days);
      let tasks=await adminDashboardTasks(h.pool,h.owner,filter),total=tasks.items.length;
      while(tasks.next_cursor){tasks=await adminDashboardTasks(h.pool,h.owner,parseDashboardFilter({...query,cursor:tasks.next_cursor}));total+=tasks.items.length;}
      assert.equal(total,days,'all selected tasks remain reachable');
    }
  }finally{await h.pool.end();}
});

test('UTC midnight grouping and credit dates remain unchanged in an Asia/Shanghai PostgreSQL session',{skip:!connection},async()=>{
  const h=await fixture({timezone:'Asia/Shanghai'});
  try{
    const first=await h.run('2026-01-01T23:59:59Z'),second=await h.run('2026-01-02T00:00:00Z');
    await h.settle(first,7);await h.settle(second,11);
    const china=await overview(h,{from:'2026-01-01',to:'2026-01-02'});
    assert.deepEqual(china.daily.map(p=>({date:p.date,tasks:p.tasks,credits:p.credit_settled_points})),[
      {date:'2026-01-01',tasks:1,credits:'7'},{date:'2026-01-02',tasks:1,credits:'11'}]);
    await h.pool.query("SET TIME ZONE 'UTC'");
    assert.deepEqual((await overview(h,{from:'2026-01-01',to:'2026-01-02'})).daily,china.daily);
  }finally{await h.pool.end();}
});

test('owner and state filters count runs/users once and do not multiply usage or settlement rows',{skip:!connection},async()=>{
  const h=await fixture(),foreign=await fixture();
  try{
    const one=await h.run('2026-01-01T01:00:00Z'),two=await h.run('2026-01-01T02:00:00Z');
    const cancelled=await h.run('2026-01-01T03:00:00Z','cancelled'),outside=await h.run('2026-01-03T12:00:00Z'),foreignRun=await foreign.run('2026-01-01T04:00:00Z');
    const model='synthetic-trend-'+randomUUID();
    await h.pool.query("INSERT INTO bb_model_cost_rates(rate_ref,provider,model_id,effective_from,currency,input_per_million,cached_input_per_million,output_per_million,reasoning_output_per_million,verified_source_ref,recorded_by,recorded_reason) VALUES($1,'synthetic_trend',$2,'2025-01-01T00:00:00Z','USD',1,1,2,2,'synthetic-test-only','synthetic-test','admin trend hand-calculated fixture')",[randomUUID(),model]);
    await h.usage(one,model,100,10,true);await h.usage(one,model,200,20);
    await h.settle(one,7);await h.settle(one,11);await h.settle(two,13);
    await h.usage(cancelled,model,10000,1000);await h.settle(cancelled,101);
    await h.usage(outside,model,20000,2000);await h.settle(outside,102);
    await foreign.usage(foreignRun,model,30000,3000);await foreign.settle(foreignRun,103);
    const result=await overview(h,{from:'2026-01-01',to:'2026-01-02',state:'failed'});
    assert.equal(result.tasks,2);assert.equal(result.model_attempts,2);assert.equal(result.input_tokens,300);assert.equal(result.output_tokens,30);
    assert.equal(result.cost_amount,'0.0003600000');assert.equal(result.currency,'USD');assert.equal(result.credit_settled_points,'31');
    assert.equal(result.daily.length,2);assert.deepEqual(result.daily[0],{date:'2026-01-01',tasks:2,active_users:1,input_tokens:300,output_tokens:30,cost_amount:'0.0003600000',currency:'USD',credit_settled_points:'31'});
    assert.deepEqual(result.daily[1],{date:'2026-01-02',tasks:0,active_users:0,input_tokens:0,output_tokens:0,cost_amount:null,currency:null,credit_settled_points:'0'});
  }finally{await h.pool.end();await foreign.pool.end();}
});

test('an empty window contains idle calendar days without inventing measured zero costs',{skip:!connection},async()=>{
  const h=await fixture();
  try{
    const result=await overview(h,{from:'2026-02-01',to:'2026-02-03'});
    assert.equal(result.tasks,0);assert.equal(result.daily.length,3);
    assert.ok(result.daily.every(p=>p.tasks===0&&p.active_users===0&&p.input_tokens===0&&p.output_tokens===0&&p.credit_settled_points==='0'&&p.cost_amount===null&&p.currency===null));
  }finally{await h.pool.end();}
});

test('a measured but unpriced attempt stays null beside an idle day',{skip:!connection},async()=>{
  const h=await fixture();
  try{
    const id=await h.run('2026-02-01T12:00:00Z');await h.usage(id,'synthetic-unpriced-'+randomUUID(),55,5);
    const result=await overview(h,{from:'2026-02-01',to:'2026-02-02'});
    assert.equal(result.daily.length,2);assert.equal(result.daily[0].tasks,1);assert.equal(result.daily[0].input_tokens,55);
    assert.equal(result.daily[0].output_tokens,5);assert.equal(result.daily[0].cost_amount,null);assert.equal(result.daily[0].currency,null);
    assert.equal(result.daily[1].tasks,0);assert.equal(result.daily[1].cost_amount,null);
  }finally{await h.pool.end();}
});
