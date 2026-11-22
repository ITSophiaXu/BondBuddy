// Real disposable PostgreSQL with the captured consumer ACL. No provider,
// native process, cloud operation or model intent is needed to scan a pause.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {digest,transaction,type PrivateBlobs} from '@bondbuddy/api/data';
import {grantCredits} from '../../api/dist/billing.js';
import {inputManifestHash} from '@bondbuddy/api/production-rule-pin';
import {pausedRunSweepCandidates,beginPausedRunSweep,completePausedRunSweep,resumeVerifiedWorkflow,claim,pauseRun} from '@bondbuddy/api/queue';
import {configureTrialGuard,trialConfigFromEnv} from '@bondbuddy/api/trial-guard';
import type {AuthoringWorkflowV1} from '@bondbuddy/contracts';
import {WorkerRuntime} from './runtime.js';
import {assertManagedDatabasePrivileges} from './managed-database-preflight.js';
import {isolatedTestDatabase} from './test-database.js';

const connection=await isolatedTestDatabase(undefined,'paused-run-sweep');
const stages=['awaiting_materials','credits_exhausted','billing_reconcile','trial_limit'] as const;
const ident=(s:string)=>'"'+s.replaceAll('"','""')+'"';
test('paused sweep reaches ready work behind blocked pages with the restricted consumer',{skip:!connection,timeout:90000},async t=>{
 const admin=new Pool({connectionString:connection}),role='synthetic_paused_'+randomUUID().replaceAll('-',''),password=randomUUID();
 await admin.query(`CREATE ROLE ${ident(role)} LOGIN PASSWORD '${password}'`);
 const acl=JSON.parse(await readFile(new URL('../src/fixtures/managed-runtime-acl.json',import.meta.url),'utf8'));
 for(const table of acl.tables){
  for(const privilege of table.privileges)await admin.query(`GRANT ${privilege} ON public.${ident(table.name)} TO ${ident(role)}`);
  for(const [privilege,columns] of Object.entries(table.columns) as [string,string[]][])
   await admin.query(`GRANT ${privilege}(${columns.map(ident).join(',')}) ON public.${ident(table.name)} TO ${ident(role)}`);
 }
 for(const name of ['managed-model-activity-grants.sql','managed-capacity-settlement-grants.sql','managed-execution-prerequisites.sql']){
  const sql=await readFile(new URL('../../../deploy/m1/security/'+name,import.meta.url),'utf8');await admin.query(sql.replaceAll(':"runtime_role"',ident(role)));
 }
 const url=new URL(connection!);url.username=role;url.password=password;const worker=new Pool({connectionString:url.toString()});
 configureTrialGuard(trialConfigFromEnv({BB_TRIAL_GUARD:'off'}));
 t.after(async()=>{configureTrialGuard(null);await worker.end();await admin.query(`DROP OWNED BY ${ident(role)}`);await admin.query(`DROP ROLE ${ident(role)}`);await admin.end();});
 await assertManagedDatabasePrivileges(worker);
 const objects=new Map<string,Buffer>(),blobs:PrivateBlobs={put:async(k,b)=>{objects.set(k,Buffer.from(b));},get:async k=>objects.get(k)!,getIfExists:async k=>objects.get(k)??null,getIfExistsBounded:async(k,max)=>{const b=objects.get(k);return b&&b.length<=max?b:null;},exists:async k=>objects.has(k),delete:async k=>{objects.delete(k);}};
 const runtime=()=>new WorkerRuntime({pool:worker,blobs,kinds:['run'],runKinds:['generation'],runStages:[],concurrency:1,parseSlots:0,interactiveSlots:0,logSink:null,candidateRetention:{pendingCount:async()=>0}});
 const add=async(stage:typeof stages[number],index:number,options:{missingObject?:boolean;unsupported?:boolean;nullDue?:boolean;queryError?:boolean}={})=>{
  const owner=randomUUID(),id='paused_'+stage+'_'+String(index).padStart(3,'0')+'_'+randomUUID(),h='a'.repeat(64);
  await admin.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'paused_'+owner.slice(0,8)]);
  if(stage==='credits_exhausted')await transaction(admin,c=>grantCredits(c,{owner,source:'existing_grant',key:randomUUID(),points:1,expiresAt:null,actor:'synthetic',reason:'Synthetic paused sweep credit readiness'}));
  const pins=options.queryError?[{material_id:'synthetic-bad-version',material_version:'not-an-int',role:'historical',sha256:h}]:[];
  const manifest={synthetic:true,materials:pins},hash=inputManifestHash(manifest);
  await admin.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic pause sweep','generation')",[id,owner]);
  await admin.query("INSERT INTO bb_input_revisions(project_id,owner_user_id,revision,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,$2,1,1,$3,$4,$5,'[]')",[id,owner,hash,manifest,JSON.stringify(pins.map(p=>({material_id:p.material_id,material_version:p.material_version})))]);
  await admin.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage,event_cursor) VALUES($1,$2,$1,1,$3,$1,'generation',$3,'paused',$4,1)",[id,owner,hash,stage]);
  const checkpoint:Record<string,unknown>={};
  if(options.missingObject||options.unsupported){
   const body={version:'authoring-plan-v1' as const,input_hash:hash,baseline_hash:null,material_snapshot_hash:h,knowledge_hash:h,chapters:[{chapter_id:'one',order:0,title:'Synthetic paused chapter',required:true,depends_on:[],source_node_ids:[],evidence_refs:[],batches:[{batch_id:'first',order:0,allowed_node_ids:[],context_refs:[],output_contract:'document-projection-v1' as const}]}],limits:{call_ms:1000,repair_ms:1000,repair_revisions:2,context_records:600,context_chars:18000,context_bytes:96000,output_bytes:98304}};
   const plan={...body,plan_hash:inputManifestHash(body)},bytes=Buffer.from(JSON.stringify(plan));
   const w:AuthoringWorkflowV1={protocol_version:1,input_hash:hash,plan_hash:plan.plan_hash,plan,plan_ref:{key:`users/${owner}/projects/${id}/runs/${id}/workflow-v1/plan.json`,sha256:digest(bytes),byte_size:bytes.length},phase:'authoring',next_cursor:{chapter:0,batch:0},completed:[],run_deadline_at:new Date(Date.now()+60000).toISOString(),token_budget:{limit:1000,used_known:0,unknown_calls:[]},repair_budget:{used_ms:0,used_revisions:0},phase_failures:{authoring:0,postprocess:0},handoff_id:null,postprocess_manifest:null};
   checkpoint.workflow_v1=options.unsupported?{...w,protocol_version:2}:w;checkpoint.never_admitted_v1={version:'never-admitted-v1',job_id:id};
  }
  if(options.nullDue)checkpoint.paused_sweep_v1={[stage]:{version:1,pause_event_seq:1,next_due_ms:null,disposition:'waiting'}};
  await admin.query("INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage,credit_pause_requested,checkpoint) VALUES($1,$2,$1,'generation','default','paused',$3,$4,$5)",[id,owner,stage,stage==='credits_exhausted',checkpoint]);
  await admin.query("INSERT INTO bb_run_events(id,owner_user_id,run_id,seq,trace_id,type,state,stage,payload) VALUES($1,$2,$3,1,$3,'run.state_changed','paused',$4,$5)",[randomUUID(),owner,id,stage,{reason:stage==='awaiting_materials'?'material_parse_pending':'synthetic_paused'}]);
  return id;
 };
 const state=async(id:string)=>(await admin.query('SELECT state,lease_token,updated_at,checkpoint FROM bb_jobs WHERE id=$1',[id])).rows[0];
 for(const stage of stages)await t.test(`${stage}: twenty missing-object pauses cannot hide the twenty-first ready run`,async()=>{
  const blocked:string[]=[];for(let i=0;i<20;i++)blocked.push(await add(stage,i,{missingObject:true,nullDue:i===0}));
  const ready=await add(stage,20),before=await Promise.all(blocked.map(state)),sweep=runtime();
  await sweep.sweep();assert.equal((await state(ready)).state,'paused','one pass stays within its twenty-item budget');
  await runtime().sweep();assert.equal((await state(ready)).state,'queued','durable due rotation survives a recreated runtime');
  for(const [i,id] of blocked.entries()){
   const row=await state(id);assert.equal(row.state,'paused');assert.equal(row.lease_token,null);assert.deepEqual(row.updated_at,before[i]!.updated_at,'readiness scans cannot rewrite the immutable pause clock');
   const scan=row.checkpoint.paused_sweep_v1?.[stage];assert.equal(scan.disposition,'waiting');assert.equal(scan.reason_code,'resume_guard_blocked');assert.equal(scan.attempts,1);assert.ok(scan.next_due_ms>scan.last_checked_ms);
  }
  assert.equal((await state(ready)).checkpoint.paused_sweep_v1?.[stage]?.disposition,'resumed');
  await admin.query("UPDATE bb_jobs SET state='cancelled' WHERE id=ANY($1::text[])",[[...blocked,ready]]);
 });
 await t.test('one actual readiness SQL error does not stop its page or another pause class',async()=>{
  const bad=await add('awaiting_materials',0,{queryError:true}),ready=await add('awaiting_materials',1),billing=await add('billing_reconcile',0);
  await runtime().sweep();assert.equal((await state(ready)).state,'queued');assert.equal((await state(billing)).state,'queued');
  const scan=(await state(bad)).checkpoint.paused_sweep_v1.awaiting_materials;assert.equal(scan.disposition,'error');assert.equal(scan.reason_code,'readiness_check_failed');
  await admin.query("UPDATE bb_jobs SET state='cancelled' WHERE id=ANY($1::text[])",[[bad,ready,billing]]);
 });
 await t.test('unsupported workflow is explained once without blocking a supported legacy pause',async()=>{
  const unsupported=await add('trial_limit',0,{unsupported:true}),ready=await add('trial_limit',1);
  await runtime().sweep();assert.equal((await state(ready)).state,'queued');
  const first=await state(unsupported),scan=first.checkpoint.paused_sweep_v1.trial_limit;assert.equal(scan.disposition,'manual_required');assert.equal(scan.reason_code,'workflow_protocol_unsupported');
  await runtime().sweep();assert.deepEqual(await state(unsupported),first,'manual unsupported state is not retried every pass');
  await admin.query("UPDATE bb_jobs SET state='cancelled' WHERE id=ANY($1::text[])",[[unsupported,ready]]);
 });
 await t.test('a stopped checking pass survives restart; a real new pause invalidates its old ticket',async()=>{
  const id=await add('trial_limit',0),candidate=(await pausedRunSweepCandidates(worker,'trial_limit',20,['generation'])).find(row=>row.job_id===id)!;
  const ticket=await beginPausedRunSweep(worker,candidate,'trial_limit');assert.ok(ticket);
  const checking=await state(id);assert.equal(checking.checkpoint.paused_sweep_v1.trial_limit.disposition,'checking');
  await runtime().sweep();assert.deepEqual(await state(id),checking,'a replacement process honors the persisted checking deadline');
  assert.equal(await resumeVerifiedWorkflow(worker,candidate.owner_user_id,id,'trial_limit_cleared',{blobs}),true);
  const lease=await claim(worker,30,{runKinds:['generation']});assert.equal(lease?.jobId,id);assert.ok(lease);
  await pauseRun(worker,lease,'trial_limit','synthetic_new_pause');
  const next=(await pausedRunSweepCandidates(worker,'trial_limit',20,['generation'])).find(row=>row.job_id===id)!;assert.ok(next);
  assert.notEqual(next.pause_event_seq,candidate.pause_event_seq);
  assert.equal(await completePausedRunSweep(worker,candidate,'trial_limit',ticket,'resumed','blocker_cleared'),false,'late completion cannot overwrite the new pause');
  const newTicket=await beginPausedRunSweep(worker,next,'trial_limit');assert.ok(newTicket);assert.notEqual(newTicket,ticket);
  assert.equal((await state(id)).checkpoint.paused_sweep_v1.trial_limit.attempts,1,'a new pause resets the old retry history');
  assert.equal(await completePausedRunSweep(worker,next,'trial_limit',newTicket,'waiting','synthetic_blocker'),true);
 });
 assert.equal((await admin.query('SELECT count(*)::int n FROM bb_model_call_attempts')).rows[0].n,0);
});
