import {assertBatchAdmission} from './batch-admission.js';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {isolatedTestDatabase} from './test-database.js';
import {assertCanonicalBusinessRunIdle,digest,transaction} from './data.js';
import {action,claim,enqueue} from './queue.js';

// Real PG queue/trigger tests. Synthetic snapshots only; no supplier calls.
const connection=await isolatedTestDatabase(undefined,'task-queue-scheduling');
async function owner(pool:Pool){const id=randomUUID();await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[id,'queue_'+id.slice(0,8)]);return id;}
async function project(pool:Pool,user:string,scope:string|null=null){const id=randomUUID();await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind,execution_scope_project_id) VALUES($1,$2,'Synthetic queued target','update',$3)",[id,user,scope]);return id;}
async function submit(pool:Pool,user:string,target:string){
 return transaction(pool,async c=>{
  const manifest={kind:'update',synthetic:true},hash=digest(JSON.stringify(manifest));
  await c.query("INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,1,$2,1,$3,$4,'[]','[]') ON CONFLICT DO NOTHING",[target,user,hash,manifest]);
  const run=(await c.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,1,$4,$5,'update',$4,'queued') RETURNING *",[randomUUID(),user,target,hash,randomUUID()])).rows[0];
  await enqueue(c,run);return run.id as string;
 });
}

test('bulk queued work yields free slots to other accounts; concurrent claims stay unique',{skip:!connection},async()=>{
 const pool=new Pool({connectionString:connection});
 try{
  const a=await owner(pool),b=await owner(pool),c=await owner(pool);
  const bulk=[];for(let i=0;i<12;i++)bulk.push(await submit(pool,a,await project(pool,a)));
  const first=await claim(pool,60,{runKinds:['update']});assert.ok(first);assert.equal(first.owner,a);
  const other=await submit(pool,b,await project(pool,b));
  const next=await claim(pool,60,{runKinds:['update']});assert.ok(next);assert.equal(next.runId,other,'new account is not behind the bulk backlog');
  const fresh=await submit(pool,c,await project(pool,c));
  const claims=await Promise.all(Array.from({length:8},()=>claim(pool,60,{runKinds:['update']})));
  assert.ok(claims.every(Boolean));assert.equal(new Set(claims.map(x=>x!.runId)).size,8);
  assert.ok(claims.some(x=>x!.runId===fresh));
  assert.ok(!claims.some(x=>x!.runId===first.runId||x!.runId===next.runId));
  await pool.query("UPDATE bb_jobs SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE owner_user_id=ANY($1::text[])",[[a,b,c]]);
  await pool.query("UPDATE bb_runs SET state='cancelled' WHERE owner_user_id=ANY($1::text[])",[[a,b,c]]);
 }finally{await pool.end();}
});

test('same source allows independent targets, including when a sibling is paused; same target remains protected',{skip:!connection},async()=>{
 const pool=new Pool({connectionString:connection});
 try{
  const user=await owner(pool),source=await project(pool,user);
  const targets=await Promise.all(Array.from({length:12},()=>project(pool,user,source)));
  const runs=await Promise.all(targets.map(target=>submit(pool,user,target)));
  assert.equal(new Set(runs).size,12);
  const leases=await Promise.all(Array.from({length:3},()=>claim(pool,60,{runKinds:['update']})));
  assert.ok(leases.every(x=>x&&runs.includes(x.runId)));
  const paused=runs.find(id=>!leases.some(x=>x!.runId===id))!;
  await action(pool,user,paused,'pause');
  const fresh=await project(pool,user,source);
  await transaction(pool,c=>assertCanonicalBusinessRunIdle(c,user,{id:fresh,kind:'update',execution_scope_project_id:source}));
  await transaction(pool,c=>assertBatchAdmission(c,user,source,'generation:synthetic','independent-item',fresh));
  assert.ok(await submit(pool,user,fresh));
  const target=targets[runs.indexOf(paused)]!;
  await assert.rejects(transaction(pool,c=>assertCanonicalBusinessRunIdle(c,user,{id:target,kind:'update',execution_scope_project_id:source})),{code:'PROJECT_RUN_ACTIVE'});
  await assert.rejects(submit(pool,user,target),/Project already has an active business run/);
  await assert.rejects(transaction(pool,c=>assertBatchAdmission(c,user,source,'generation:synthetic','independent-item',target)),{code:'PROJECT_RUN_ACTIVE'});
  const foreign=await owner(pool);
  await assert.rejects(project(pool,foreign,source),/foreign key/);
 }finally{await pool.end();}
});
