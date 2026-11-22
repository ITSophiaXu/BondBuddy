// Synthetic provider observations over an isolated real PostgreSQL database.
// This suite exercises persistence/budget APIs; it does not claim native Stop proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {digest,type PrivateBlobs} from '@bondbuddy/api/data';
import {inputManifestHash} from '@bondbuddy/api/production-rule-pin';
import {savePromptSnapshot} from '@bondbuddy/api/log-ops';
import {persistProviderResultObject,recordProviderCallObservation} from '@bondbuddy/api/provider-results';
import {configureExecutionCapacity,registerExecutionRuntime,heartbeatExecutionRuntime} from '@bondbuddy/api/execution-capacity';
import {claim,recordWorkflowFailure,type Lease} from '@bondbuddy/api/queue';
import type {AuthoringWorkflowV1,DocumentProjectionV1} from '@bondbuddy/contracts';
import {isolatedTestDatabase} from './test-database.js';
import {workflowAuthoringStage} from './workflow-authoring-stage.js';
import {buildAuthoringPlan,blockIdentity} from './workflow-authoring.js';
import type {ChapterContextV1} from './workflow-input.js';
import {loadCodexAdapterConfig} from './codex-adapter.js';
import {codexModelStage,type StageContext} from './run-pipeline.js';

const connection=await isolatedTestDatabase(undefined,'workflow-validation-extra');
test('persisted workflow budgets and phase failures survive recreated worker contexts',{timeout:60000},async t=>{
 assert.ok(connection,'A migrated isolated test database is required; absence is not a skipped pass');
 const admin=new Pool({connectionString:connection}),worker=new Pool({connectionString:connection});
 t.after(async()=>{await worker.end();await admin.end();});
 const owner=randomUUID(),nodeId=randomUUID(),epoch=randomUUID(),sessionId=randomUUID(),h='a'.repeat(64),registration='synthetic-workflow-budget-registration-0123456789';
 await admin.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'synthetic_budget_'+owner.slice(0,8)]);
 await configureExecutionCapacity(admin,0,{managed_nodes:true,global_model_limit:4,max_nodes:2,budget_available:true,workflow_slots_enabled:true});
 const identity={account_id:'synthetic',region:'synthetic',instance_id:'budget-node',epoch};
 await admin.query(`INSERT INTO bb_execution_nodes(id,account_id,region,instance_id,epoch,state,source_sha256,image_sha256,launch_manifest_sha256,capabilities,expected_services,registration_token_sha256,cloud_start_operation_id)
  VALUES($1,$2,$3,$4,$5,'ready',$6,$6,$6,ARRAY['authoring','postprocess'],$7,$8,'synthetic-start')`,
  [nodeId,identity.account_id,identity.region,identity.instance_id,epoch,h,JSON.stringify([{service_id:'authoring',capabilities:['authoring','postprocess'],workflow_protocol_version:1}]),inputManifestHash(registration)]);
 await registerExecutionRuntime(worker,{identity,session_id:sessionId},{service_id:'authoring',capabilities:['authoring','postprocess'],source_sha256:h,image_sha256:h,launch_manifest_sha256:h,registration_token:registration,process_identity:{pid:'1',synthetic:'true'},workflow_protocol_version:1} as any);
 await heartbeatExecutionRuntime(worker,{native_processes:0,unpersisted_results:0,ready:true});
 t.afterEach(async()=>{await admin.query("UPDATE bb_jobs SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE owner_user_id=$1 AND state<>'cancelled'",[owner]);});
 const objects=new Map<string,Buffer>();
 const blobs:PrivateBlobs={put:async(k,b)=>{objects.set(k,Buffer.from(b));},get:async k=>{const bytes=objects.get(k);assert.ok(bytes);return bytes;},getIfExists:async k=>objects.get(k)??null,getIfExistsBounded:async(k,max)=>{const bytes=objects.get(k);return bytes&&bytes.length<=max?bytes:null;},exists:async k=>objects.has(k),delete:async k=>{objects.delete(k);}};
 const stored=async(id:string)=>(await admin.query('SELECT checkpoint,attempts,lease_token,execution_admission_phase FROM bb_jobs WHERE id=$1',[id])).rows[0];
 const context=async(lease:Lease):Promise<StageContext>=>{
  const row=await stored(lease.jobId),fresh={...lease,checkpoint:row.checkpoint};
  return {pool:worker,blobs,lease:fresh,run:(await admin.query('SELECT * FROM bb_runs WHERE id=$1',[lease.runId])).rows[0],signal:new AbortController().signal,checkpoint:row.checkpoint.stages,values:new Map()};
 };
 const add=async(limit:number,attempts=0)=>{
  const id=randomUUID(),manifest={synthetic:true,authoring:{version:'unified_v1'}},inputHash=inputManifestHash(manifest),deadline=new Date(Date.now()+300000).toISOString();
  const input={manifest:{issuer_name:'Synthetic issuer',market:'sse',offering:'private',update_details:{},materials:[],authoring:{version:'unified_v1',source_prospectuses:[],knowledge:[{path:'synthetic.md',markdown:'# One\n# Two'}],requirements:[]}},materials:[],requirements:['Synthetic budget test']} as unknown as ChapterContextV1['input'];
  const parser_version='synthetic-parser-v1',chapters=[{title:'One',source_node_ids:[]},{title:'Two',source_node_ids:[]}],material_snapshot_hash=inputManifestHash({input,parser_version});
  const corpus:ChapterContextV1={version:'chapter-context-v1',input_hash:inputHash,parser_version,input,source:null,chapters,nodes:[],material_snapshot_hash};
  const bytes=Buffer.from(JSON.stringify(corpus)),key=`users/${owner}/projects/${id}/runs/${id}/workflow-v1/context.json`;objects.set(key,bytes);
  const plan=buildAuthoringPlan({inputHash,baselineHash:null,materialSnapshotHash:material_snapshot_hash,knowledgeHash:inputManifestHash(input.manifest.authoring.knowledge),chapters,contextRefs:[]});
  const w:AuthoringWorkflowV1={protocol_version:1,input_hash:inputHash,plan_hash:plan.plan_hash,plan,phase:'authoring',next_cursor:{chapter:0,batch:0},completed:[],run_deadline_at:deadline,token_budget:{limit,used_known:0,unknown_calls:[]},repair_budget:{used_ms:0,used_revisions:0},phase_failures:{authoring:0,postprocess:0},handoff_id:null,postprocess_manifest:null};
  const stages={workflow_budget_v1:{run_deadline_at:deadline},chapter_context_v1:{ref:{key,sha256:digest(bytes),byte_size:bytes.length},input_hash:inputHash,material_snapshot_hash}};
  await admin.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic budget','generation')",[id,owner]);
  await admin.query("INSERT INTO bb_input_revisions(project_id,owner_user_id,revision,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,$2,1,1,$3,$4,'[]','[]')",[id,owner,inputHash,manifest]);
  await admin.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$1,1,$3,$1,'generation',$3,'queued')",[id,owner,inputHash]);
  await admin.query("INSERT INTO bb_jobs(id,owner_user_id,project_id,run_id,job_type,subtype,state,attempts,checkpoint) VALUES($1,$2,$1,$1,'generation','default','queued',$3,$4)",[id,owner,attempts,{workflow_v1:w,stages}]);
  await heartbeatExecutionRuntime(worker,{native_processes:0,unpersisted_results:0,ready:true});
  const lease=await claim(worker,90,{runKinds:['generation'],workflowPhase:'authoring'});assert.equal(lease?.jobId,id);assert.ok(lease);
  return {id,lease,deadline};
 };
 let sends=0;
 const model:typeof codexModelStage=options=>({name:options.name,run:async ctx=>{
  sends++;
  const w=ctx.lease.checkpoint.workflow_v1 as AuthoringWorkflowV1,c=w.next_cursor.chapter,b=w.next_cursor.batch,chapter=w.plan.chapters[c]!,batch=chapter.batches[b]!;
  const projection:DocumentProjectionV1={version:'document-projection-v1',input_hash:w.input_hash,plan_hash:w.plan_hash,chapter_id:chapter.chapter_id,batch_id:batch.batch_id,blocks:[{block_id:blockIdentity(w.plan_hash,chapter.chapter_id,batch.batch_id,0),order:0,kind:'paragraph',text:'Synthetic budget chapter',rows:[],evidence:['target'],pending:[],heading_level:null,style_key:'body',table_id:null,row_order:null}],summary:[]};
  assert.equal(await options.validate!(projection),true);
  assert.ok(Date.parse(options.deadlineAt!)<=Date.parse(w.run_deadline_at),'a chapter never extends the persisted run deadline');
  const callId=randomUUID(),logical=options.logicalCallId!,snapshot=await savePromptSnapshot(worker,blobs,{owner,projectId:ctx.run.project_id,runId:ctx.run.id,kind:'model_request',body:'Synthetic budget call',inputRevision:1,inputHash:w.input_hash,templateVersion:'synthetic-budget-v1'});
  await worker.query("INSERT INTO bb_model_call_attempts(id,owner_user_id,job_id,logical_call_id,attempt_no,status,model_id,prompt_snapshot_id) VALUES($1,$2,$3,$4,1,'pending_reconcile','synthetic',$5)",[callId,owner,ctx.lease.jobId,logical,snapshot]);
  const intent={owner_user_id:owner,project_id:ctx.run.project_id,job_id:ctx.lease.jobId,run_id:ctx.run.id,trace_id:ctx.run.id,logical_call_id:logical,call_id:callId,attempt_no:1,model_id:'synthetic',model_config_version:'synthetic-budget-v1',prompt_snapshot_ref:snapshot};
  const validate=(value:unknown)=>inputManifestHash(value)===inputManifestHash(projection),result=await persistProviderResultObject({blobs,intent,bytes:Buffer.from(JSON.stringify(projection)),resultSchemaVersion:'document-projection-v1',validate});
  await recordProviderCallObservation(worker,blobs,{...intent,...result,provider_request_id:null,finish_reason:'stop',outcome:'completed',usage:{status:'measured',input_tokens:10,output_tokens:5,total_tokens:15,cached_input_tokens:null,reasoning_tokens:null},error_code:null},validate,{lease:ctx.lease});
  return {kind:'done',value:projection};
 }});
 const config={...loadCodexAdapterConfig({}),timeout_ms:600000,authoring_timeout_ms:600000};
 const stage=()=>workflowAuthoringStage({model,config,tokenLimit:100000});

 await t.test('committed tokens stop the next chapter and a recreated context cannot reset the limit or deadline',async()=>{
  const f=await add(15),start=sends;
  const firstContext=await context(f.lease),realNow=Date.now.bind(Date);let ticks=0;
  // Deterministically advance between remaining-budget calculation and call
  // construction. Rebuilding an absolute deadline as later-now + old-remaining
  // must fail the model's exact <= persisted-deadline assertion, even on a fast host.
  const clock=t.mock.method(Date,'now',()=>realNow()+(++ticks)*25);
  try{
   assert.deepEqual(await stage().run(firstContext),{kind:'pause',stage:'credits_exhausted',reason:'workflow_token_budget_exhausted'});
   assert.ok(ticks>1,'the synthetic clock crosses distinct budget and call construction points');
  }finally{clock.mock.restore();}
  const first=await stored(f.id);assert.equal(first.checkpoint.workflow_v1.completed.length,1);assert.equal(first.checkpoint.workflow_v1.token_budget.used_known,15);assert.equal(first.checkpoint.workflow_v1.token_budget.limit,15);assert.equal(first.checkpoint.workflow_v1.run_deadline_at,f.deadline);
  assert.deepEqual(await stage().run(await context(f.lease)),{kind:'pause',stage:'credits_exhausted',reason:'workflow_token_budget_exhausted'});
  assert.equal(sends-start,1);assert.deepEqual((await stored(f.id)).checkpoint.workflow_v1,first.checkpoint.workflow_v1);assert.equal((await stored(f.id)).checkpoint.stages.workflow_budget_v1.run_deadline_at,f.deadline);
 });
 await t.test('an unknown persisted attempt blocks all new sends even with a new configured token limit',async()=>{
  const f=await add(100),unknown=randomUUID(),start=sends;
  await worker.query("INSERT INTO bb_model_call_attempts(id,owner_user_id,job_id,logical_call_id,attempt_no,status) VALUES($1,$2,$3,$4,1,'pending_reconcile')",[unknown,owner,f.id,'c'.repeat(64)]);
  const before=await stored(f.id);
  assert.deepEqual(await stage().run(await context(f.lease)),{kind:'pause',stage:'provider_reconcile',reason:'workflow_usage_unknown'});
  assert.deepEqual(await stage().run(await context(f.lease)),{kind:'pause',stage:'provider_reconcile',reason:'workflow_usage_unknown'});
  assert.equal(sends,start);assert.deepEqual(await stored(f.id),before);
 });
 await t.test('an expired persisted deadline fails before another model send despite a longer new configuration',async()=>{
  const f=await add(100),expired=new Date(Date.now()-1000).toISOString(),start=sends;
  await admin.query("UPDATE bb_jobs SET checkpoint=jsonb_set(jsonb_set(checkpoint,'{workflow_v1,run_deadline_at}',to_jsonb($2::text)),'{stages,workflow_budget_v1,run_deadline_at}',to_jsonb($2::text)) WHERE id=$1",[f.id,expired]);
  const before=await stored(f.id);await assert.rejects(stage().run(await context(f.lease)),/WORKFLOW_RUN_DEADLINE/);assert.equal(sends,start);assert.deepEqual(await stored(f.id),before);
 });
 await t.test('two chapter commits and normal handoff preserve cumulative budgets without adding phase failures at attempts above three',async()=>{
  const f=await add(30,7),start=sends;assert.equal(f.lease.attempts,8);
  assert.deepEqual(await stage().run(await context(f.lease)),{kind:'handoff_pending'});
  const row=await stored(f.id),w=row.checkpoint.workflow_v1 as AuthoringWorkflowV1;
  assert.equal(sends-start,2);assert.equal(w.phase,'postprocess');assert.equal(w.completed.length,2);assert.deepEqual(w.token_budget,{limit:30,used_known:30,unknown_calls:[]});assert.equal(w.run_deadline_at,f.deadline);assert.equal(row.checkpoint.stages.workflow_budget_v1.run_deadline_at,f.deadline);assert.deepEqual(w.phase_failures,{authoring:0,postprocess:0});assert.equal(row.attempts,8);assert.equal(row.execution_admission_phase,'authoring');assert.equal(row.lease_token,f.lease.token);
  assert.deepEqual((await context(f.lease)).lease.checkpoint.workflow_v1,w,'a new context reads the same postprocess budget and original lease responsibility');
 });
 for(const phase of ['authoring','postprocess'] as const)await t.test(`${phase} true failures exhaust independently at three and survive context recreation`,async()=>{
  const f=await add(100,7);const other=phase==='authoring'?'postprocess':'authoring';
  for(let i=1;i<=3;i++){
   const fresh=await context(f.lease);assert.deepEqual(await recordWorkflowFailure(worker,fresh.lease,phase),{failures:i,exhausted:i>=3});
   const row=await stored(f.id);assert.equal(row.checkpoint.workflow_v1.phase_failures[phase],i);assert.equal(row.checkpoint.workflow_v1.phase_failures[other],0);assert.equal(row.attempts,8);assert.equal(row.checkpoint.workflow_v1.run_deadline_at,f.deadline);assert.equal(row.checkpoint.workflow_v1.token_budget.limit,100);
  }
 });
});
