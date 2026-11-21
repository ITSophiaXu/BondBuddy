// Synthetic entities; real owner/run/job locks, durable events and outbox. No external model or billing.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { REVIEW_ACTION_CODES, type ReviewAction } from '@bondbuddy/contracts';
import { recordReviewAction, type Lease } from './queue.js';
import { isolatedTestDatabase } from './test-database.js';
import { createServer } from './server.js';
import { digest, uid } from './data.js';

const database=await isolatedTestDatabase(undefined,'review-actions');
test('review actions preserve execution state and obey owner, lease, replay and terminal boundaries',{skip:!database,timeout:30000},async t=>{
  const pool=new Pool({connectionString:database});
  async function fixture(){
    const owner=randomUUID(),project=randomUUID(),runId=randomUUID(),jobId=randomUUID(),token=randomUUID(),hash='a'.repeat(64);
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,`act_${owner.replaceAll('-','').slice(0,16)}`]);
    await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic actions','review')",[project,owner]);
    await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,1,$2,1,$3,'{}','[]','[]')`,[project,owner,hash]);
    await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage)
      VALUES($1,$2,$3,1,$4,$5,'review',$4,'running','provider_call')`,[runId,owner,project,hash,randomUUID()]);
    await pool.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage,checkpoint,lease_token,lease_until)
      VALUES($1,$2,$3,'run','review','running','review_cli_v3_prompt','{"stages":{"input_lock":{"fixed":true}}}',$4,now()+interval '60 seconds')`,[jobId,owner,runId,token]);
    const lease:Lease={jobId,runId,owner,token,checkpoint:{},attempts:1};
    const action:ReviewAction={version:'review-action-v1',action_id:hash,code:'read_materials',state:'started'};
    const events=async()=>(await pool.query('SELECT seq,state,stage,payload FROM bb_run_events WHERE run_id=$1 ORDER BY seq',[runId])).rows;
    return {lease,action,events};
  }
  try{
    await t.test('atomic progress/outbox, stable identity, no stage/checkpoint or billing mutation',async()=>{
      const f=await fixture();
      const snapshot=async()=>({run:(await pool.query('SELECT state,stage,input_hash,input_revision FROM bb_runs WHERE id=$1',[f.lease.runId])).rows[0],
        job:(await pool.query('SELECT state,stage,checkpoint,attempts,lease_token,lease_until FROM bb_jobs WHERE id=$1',[f.lease.jobId])).rows[0]});
      const before=await snapshot();assert.equal(await recordReviewAction(pool,f.lease,f.action),true);
      assert.equal(await recordReviewAction(pool,f.lease,f.action),false);
      assert.equal(await recordReviewAction(pool,f.lease,{...f.action,state:'completed'}),true);
      for(const state of ['started','completed','failed'] as const)assert.equal(await recordReviewAction(pool,f.lease,{...f.action,state}),false);
      assert.deepEqual(await snapshot(),before);
      const events=await f.events();assert.deepEqual(events.map(e=>[e.seq,e.state,e.stage,e.payload.action.state]),[[1,'running','provider_call','started'],[2,'running','provider_call','completed']]);
      assert.equal((await pool.query('SELECT event_cursor FROM bb_runs WHERE id=$1',[f.lease.runId])).rows[0].event_cursor,2);
      assert.equal((await pool.query("SELECT count(*)::int n FROM bb_outbox WHERE aggregate_id=$1 AND event_type='run.progress'",[f.lease.runId])).rows[0].n,2);
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_credit_events WHERE owner_user_id=$1',[f.lease.owner])).rows[0].n,0);
      await assert.rejects(recordReviewAction(pool,f.lease,{...f.action,prompt:'private'} as ReviewAction),{code:'VALIDATION_FAILED'});
      assert.equal((await f.events()).length,2);
    });
    await t.test('expired/wrong leases, foreign owners, paused and terminal tasks reject late actions',async()=>{
      for(const mode of ['expired','wrong-token','foreign-owner','paused','cancelled','failed'] as const){
        const f=await fixture();
        if(mode==='expired')await pool.query("UPDATE bb_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[f.lease.jobId]);
        else if(mode==='wrong-token')f.lease.token=randomUUID();
        else if(mode==='foreign-owner')f.lease.owner=randomUUID();
        else await pool.query('UPDATE bb_runs SET state=$2 WHERE id=$1',[f.lease.runId,mode]);
        assert.equal(await recordReviewAction(pool,f.lease,f.action),false,mode);assert.deepEqual(await f.events(),[]);
      }
    });
    await t.test('a cancelled task winning the run lock cannot receive in-flight activity',async()=>{
      const f=await fixture(),cancellation=await pool.connect();let progress:Promise<boolean>|undefined;
      try{
        await cancellation.query('BEGIN');await cancellation.query('SELECT id FROM bb_runs WHERE id=$1 FOR UPDATE',[f.lease.runId]);
        progress=recordReviewAction(pool,f.lease,f.action);
        await cancellation.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1",[f.lease.runId]);
        await cancellation.query("UPDATE bb_jobs SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE id=$1",[f.lease.jobId]);
        await cancellation.query('COMMIT');assert.equal(await progress,false);assert.deepEqual(await f.events(),[]);
      }finally{await cancellation.query('ROLLBACK');cancellation.release();await progress;}
    });
  }finally{await pool.end();}
});

test('long review timelines retain bounded completed categories with ordering, deduplication and owner/project isolation',
  {skip:!database,timeout:30000},async()=>{
    const pool=new Pool({connectionString:database});
    const originalOwner=`synthetic-action-timeline-${randomUUID()}`;
    let owner=originalOwner;
    const origin='http://bondbuddy.test';
    const app=createServer({pool,historicalBillingFixture:true,enableSubscriptionBilling:false,enablePaidAuthoring:false,enablePaidReview:false,
      principal:async()=>({userId:owner,csrfVerified:true}),allowedOrigin:origin});
    const send=(method:string,url:string,payload?:unknown)=>app.inject({method:method as any,url,headers:{origin},payload:payload as any});
    const ok=(response:{statusCode:number;body:string})=>assert.ok(response.statusCode>=200&&response.statusCode<300,response.body);
    async function execution(){
      const created=await send('POST','/api/v1/projects',{name:'Synthetic long action history',kind:'review',issuer_name:null,market:null,offering:null});ok(created);
      const projectId=created.json().project_id,base=`/api/v1/projects/${projectId}`;
      const materialId=uid(),uploadId=uid(),sha256=digest(`synthetic timeline source ${projectId}`);
      await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
        VALUES($1,$2,$3,'synthetic.pdf','application/pdf',25,$4,'historical',$5,now()+interval '1 hour','completed')`,
      [uploadId,owner,projectId,sha256,`synthetic/${uploadId}`]);
      await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
        VALUES($1,1,$2,$3,$4,'historical','synthetic.pdf','application/pdf',25,$5,$6,'persisted')`,
      [materialId,owner,projectId,uploadId,sha256,`synthetic/${materialId}`]);
      const pin={material_id:materialId,material_version:1,sha256};
      ok(await send('PUT',`${base}/review-draft`,{kind:'input',expected_version:0,
        input:{source_material_ref:pin,material_versions:[pin],requirements:[],as_of:null}}));
      const response=await send('POST',`${base}/review-executions`,{execution_request_id:uid(),operation:'full_review',expected_input_version:1,
        source_report_id:null,expected_plan_version:null,finding_ids:[]});ok(response);
      return {base,runId:response.json().run_id as string,owner};
    }
    async function event(run:{runId:string;owner:string},seq:number,action:unknown){
      await pool.query(`INSERT INTO bb_run_events(id,owner_user_id,run_id,seq,trace_id,type,state,stage,payload)
        VALUES($1,$2,$3,$4,$3,'run.progress','running','review_sources',$5)`,
      [uid(),run.owner,run.runId,seq,{reason:'review_action',action}]);
    }
    const action=(code:ReviewAction['code'],state:ReviewAction['state'],identity:string):ReviewAction=>
      ({version:'review-action-v1',action_id:digest(identity),code,state});
    async function task(run:{base:string;runId:string}){
      const response=await send('GET',`${run.base}/review-workspace`);ok(response);
      const tasks=response.json().timeline.filter((entry:any)=>entry.kind==='task');
      assert.equal(tasks.length,1,'another project/owner never adds a task');
      assert.equal(tasks[0].task.run.run_id,run.runId);
      return tasks[0].task;
    }
    try{
      const run=await execution(),otherProject=await execution();
      await event(otherProject,2,action('prepare_report','completed','other project'));
      owner=`synthetic-action-other-${randomUUID()}`;
      const otherOwner=await execution();
      await event(otherOwner,2,action('check_compliance','completed','other owner'));
      owner=originalOwner;
      for(const [index,code] of REVIEW_ACTION_CODES.entries())await event(run,index+2,action(code,'completed',`early ${code}`));
      await event(run,10,action('check_financial','completed','latest early financial'));
      await event(run,11,{...action('check_financial','completed','invalid identity'),action_id:'invalid'});
      await event(run,12,{...action('check_financial','completed','invalid code'),code:'unknown_action'});
      await event(run,13,{...action('check_financial','completed','invalid version'),version:'review-action-v2'});
      await event(run,14,{...action('check_financial','completed','private extra'),prompt:'private model text'});
      for(let seq=15;seq<=94;seq++)await event(run,seq,action('read_materials','started',`reading ${seq}`));
      await pool.query('UPDATE bb_runs SET event_cursor=94 WHERE id=$1',[run.runId]);
      const first=await task(run),events=first.events;
      const earlySequences=[2,3,5,6,7,8,9,10];
      assert.equal(events.length,60+REVIEW_ACTION_CODES.length,'fixed categories add at most eight events');
      assert.deepEqual(events.map((e:any)=>e.seq),[...earlySequences,...Array.from({length:60},(_,i)=>i+35)]);
      assert.equal(new Set(events.map((e:any)=>e.event_id)).size,events.length);
      assert.deepEqual(new Set(events.filter((e:any)=>e.payload.action.state==='completed').map((e:any)=>e.payload.action.code)),new Set(REVIEW_ACTION_CODES));
      assert.equal(events.find((e:any)=>e.payload.action.code==='check_financial').seq,10,'latest valid completion wins over old or malformed records');
      assert.equal(first.run.state,'queued','snapshot state remains authoritative');
      assert.ok(!JSON.stringify(first).includes('private model text'));
      await event(run,95,action('prepare_report','completed','recent report'));
      await pool.query('UPDATE bb_runs SET event_cursor=95 WHERE id=$1',[run.runId]);
      const recent=(await task(run)).events;
      assert.equal(recent.length,67,'completion in the recent window is returned once');
      assert.deepEqual(recent.map((e:any)=>e.seq),[2,3,5,6,7,8,10,...Array.from({length:60},(_,i)=>i+36)]);
      assert.equal(new Set(recent.map((e:any)=>e.event_id)).size,recent.length);
      assert.deepEqual((await task(otherProject)).events.filter((e:any)=>e.payload.action).map((e:any)=>e.payload.action.action_id),[digest('other project')]);
      assert.equal((await send('GET',`${otherOwner.base}/review-workspace`)).statusCode,404);
      owner=otherOwner.owner;
      assert.equal((await send('GET',`${run.base}/review-workspace`)).statusCode,404);
      assert.deepEqual((await task(otherOwner)).events.filter((e:any)=>e.payload.action).map((e:any)=>e.payload.action.action_id),[digest('other owner')]);
    }finally{await app.close();await pool.end();}
  });
