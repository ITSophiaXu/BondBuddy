// Component integration only: disposable real PostgreSQL and host call/task
// cgroups, synthetic provider, local private object storage; no cloud/model API.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {Pool} from 'pg';
import {digest,transaction,type PrivateBlobs} from '@bondbuddy/api/data';
import {grantCredits,reserveCreditLots} from '../../api/dist/billing.js';
import {inputManifestHash} from '@bondbuddy/api/production-rule-pin';
import {configureExecutionCapacity,registerExecutionRuntime,heartbeatExecutionRuntime} from '@bondbuddy/api/execution-capacity';
import {claim,releaseLease,completeManagedRunRelease,finish} from '@bondbuddy/api/queue';
import {emptyUpdateDetails,type AuthoringWorkflowV1} from '@bondbuddy/contracts';
import {isolatedTestDatabase} from './test-database.js';
import {initializeTaskExecution,withTaskExecution,withBackgroundTaskExecution,taskNativeProcesses,taskReleaseProof,retireTaskExecution,taskExecFile} from './task-execution.js';
import {workflowAuthoringStage} from './workflow-authoring-stage.js';
import {writeWorkflowObject,type ChapterContextV1} from './workflow-input.js';
import {codexModelStage,runPipelineOnce,inputLockStage,materialsReadyStage,type StageContext,type StageOutcome} from './run-pipeline.js';
import {boundedPrivateBlobs} from './bounded-private-blobs.js';
import {loadCodexAdapterConfig} from './codex-adapter.js';
import {fileAuthoringDeliveryStage,type FileAuthoringResult} from './file-authoring-stage.js';
import {nativeExecutionProcesses} from './execution-node-runtime.js';

const connection=await isolatedTestDatabase(undefined,'workflow-authoring-native');
test('real workflow checkpoints, phase handoff and unknown call barrier',{
 skip:!connection||!process.env.BB_SYNTHETIC_TASK_CGROUP_CONTEXT,timeout:240000
},async t=>{
 const admin=new Pool({connectionString:connection}),worker=new Pool({connectionString:connection});
 const root=await mkdtemp(join(tmpdir(),'bb-workflow-native-'));
 t.after(async()=>{await worker.end();await admin.end();await rm(root,{recursive:true,force:true});});
 const fixture=JSON.parse(process.env.BB_SYNTHETIC_TASK_CGROUP_CONTEXT!),h='a'.repeat(64),registration='synthetic-workflow-registration-0123456789';
 await configureExecutionCapacity(admin,0,{managed_nodes:true,global_model_limit:4,max_nodes:2,budget_available:true,workflow_slots_enabled:true,authoring_slots:2,postprocess_slots:1});
 const nodeId=randomUUID(),services=[{service_id:'authoring',capabilities:['authoring','postprocess'],workflow_protocol_version:1}];
 await admin.query(`INSERT INTO bb_execution_nodes(id,account_id,region,instance_id,epoch,state,source_sha256,image_sha256,launch_manifest_sha256,capabilities,expected_services,registration_token_sha256,cloud_start_operation_id)
  VALUES($1,$2,$3,$4,$5,'ready',$6,$6,$6,ARRAY['authoring','postprocess'],$7,$8,'synthetic-start')`,
  [nodeId,fixture.identity.account_id,fixture.identity.region,fixture.identity.instance_id,fixture.identity.epoch,h,JSON.stringify(services),inputManifestHash(registration)]);
 await registerExecutionRuntime(worker,fixture,{service_id:'authoring',capabilities:['authoring','postprocess'],source_sha256:h,image_sha256:h,launch_manifest_sha256:h,registration_token:registration,process_identity:{pid:String(process.pid)},workflow_protocol_version:1} as any);
 await heartbeatExecutionRuntime(worker,{native_processes:0,unpersisted_results:0,ready:true});
 await initializeTaskExecution(worker);
 const owner=randomUUID();await admin.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'synthetic_workflow_'+owner.slice(0,8)]);
 // A disk-backed, private fixture exercises actual byte writes and bounded
 // readback across recreated StageContext objects. It is not an Azure claim.
 const blobRoot=join(root,'objects');await mkdir(blobRoot,{mode:0o700});
 const path=(key:string)=>{assert.ok(key.startsWith('users/')||key.startsWith('owners/'));assert.ok(!key.includes('..'));return join(blobRoot,key);};
 const read=async(key:string)=>{try{return await readFile(path(key));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}};
 const blobs:PrivateBlobs={put:async(key,bytes)=>{const p=path(key);await mkdir(dirname(p),{recursive:true,mode:0o700});await writeFile(p,bytes,{mode:0o600});},get:async key=>{const b=await read(key);if(!b)throw Error('synthetic object missing');return b;},getIfExists:read,
  getIfExistsBounded:async(key,max)=>{const b=await read(key);if(b&&b.length>max)throw Error('synthetic bounded read exceeded');return b;},exists:async key=>!!await read(key),delete:async key=>{await rm(path(key),{force:true});}};
 const statePath=join(root,'synthetic-sends.jsonl');process.env.BB_SYNTHETIC_JSON_STATE=statePath;
 const config={...loadCodexAdapterConfig({}),command:[process.execPath,fileURLToPath(new URL('../test-fixtures/codex/fake-workflow-json.mjs',import.meta.url))],credential:{kind:'env' as const,name:'BB_SYNTHETIC_JSON_STATE'},work_root:join(root,'adapter'),timeout_ms:30000,authoring_timeout_ms:90000,max_schema_reasks:0};
 const sends=async()=>{try{return (await readFile(statePath,'utf8')).trim().split('\n').filter(Boolean).map(s=>JSON.parse(s));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}};
 const add=async()=>{
  const id=randomUUID(),manifest={synthetic:true,authoring:{version:'unified_v1'}},hash=inputManifestHash(manifest);
  await admin.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'synthetic workflow','generation')",[id,owner]);
  await admin.query("INSERT INTO bb_input_revisions(project_id,owner_user_id,revision,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,$2,1,1,$3,$4,'[]','[]')",[id,owner,hash,manifest]);
  await admin.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$1,1,$3,$1,'generation',$3,'queued')",[id,owner,hash]);
  await admin.query("INSERT INTO bb_jobs(id,owner_user_id,project_id,run_id,job_type,subtype,state) VALUES($1,$2,$1,$1,'generation','default','queued')",[id,owner]);
  return id;
 };
 type Lease=NonNullable<Awaited<ReturnType<typeof claim>>>;
 const context=async(lease:Lease):Promise<StageContext>=>({pool:worker,blobs,lease,run:(await admin.query('SELECT * FROM bb_runs WHERE id=$1',[lease.runId])).rows[0],signal:new AbortController().signal,checkpoint:(lease.checkpoint.stages??{}) as StageContext['checkpoint'],values:new Map()});
 const readyHeartbeat=async()=>heartbeatExecutionRuntime(worker,{native_processes:await nativeExecutionProcesses(),unpersisted_results:0,ready:true});
 const next=async(id:string,phase:'authoring'|'postprocess')=>{await readyHeartbeat();const lease=await claim(worker,90,{runKinds:['generation'],workflowPhase:phase});assert.equal(lease?.jobId,id);return lease!;};
 const seed=async(ctx:StageContext)=>{
  const input={manifest:{issuer_name:'Synthetic issuer',market:'sse',offering:'private',update_details:{},materials:[],authoring:{version:'unified_v1',source_prospectuses:[],knowledge:[{path:'synthetic.md',markdown:'# 第一章\n# 第二章'}],requirements:[]}},materials:[],requirements:['Synthetic fixture; do not invent verified facts']} as unknown as ChapterContextV1['input'];
  const parser_version='synthetic-parser-v1',value:ChapterContextV1={version:'chapter-context-v1',input_hash:ctx.run.input_hash.trim(),parser_version,input,source:null,chapters:[{title:'第一章',source_node_ids:[]},{title:'第二章',source_node_ids:[]}],nodes:[],material_snapshot_hash:inputManifestHash({input,parser_version})};
  const ref=await writeWorkflowObject(ctx,'chapter-context.json',Buffer.from(JSON.stringify(value)));
  ctx.checkpoint.chapter_context_v1={ref,material_snapshot_hash:value.material_snapshot_hash,input_hash:value.input_hash};
  await admin.query("UPDATE bb_jobs SET checkpoint=jsonb_set(checkpoint,'{stages}',$2::jsonb) WHERE id=$1",[ctx.lease.jobId,JSON.stringify(ctx.checkpoint)]);
  ctx.lease.checkpoint.stages=ctx.checkpoint;
 };
 const scoped=async(ctx:StageContext,stage=workflowAuthoringStage({config,tokenLimit:1000}),before?:()=>Promise<void>)=>{
  let outcome!:StageOutcome;
  await withTaskExecution(worker,{kind:'job',id:ctx.lease.jobId,token:ctx.lease.token},async()=>{
   await before?.();outcome=await stage.run(ctx);return 'handoff_pending' as const;
  });return outcome;
 };
 const release=async(lease:Lease)=>{
  assert.equal(await taskNativeProcesses(lease),0);
  const proof=taskReleaseProof(worker,lease);
  await releaseLease(worker,lease);
  const result=await completeManagedRunRelease(worker,lease,proof);
  assert.notEqual(result,'blocked');await retireTaskExecution(lease);return result;
 };
 const cancel=async(id:string)=>{await admin.query("UPDATE bb_jobs SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE id=$1",[id]);await admin.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1",[id]);};

 if(!['controlled','delivery'].includes(process.env.BB_WORKFLOW_NATIVE_CASE??''))await t.test('two chapters commit only measured provider results and hand off through real empty proof',async()=>{
  const id=await add(),lease=await next(id,'authoring'),ctx=await context(lease);await seed(ctx);
  const start=(await sends()).length;
  assert.deepEqual(await scoped(ctx),{kind:'handoff_pending'});
  const w=(await admin.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[id])).rows[0].checkpoint.workflow_v1 as AuthoringWorkflowV1;
  assert.equal(w.phase,'postprocess');assert.equal(w.completed.length,2);assert.deepEqual(w.next_cursor,{chapter:2,batch:0});
  assert.equal((await sends()).length-start,3);
  for(const receipt of w.completed){const b=await blobs.get(receipt.object.key);assert.equal(digest(b),receipt.object.sha256);}
  assert.deepEqual((await admin.query('SELECT status FROM bb_model_call_attempts WHERE job_id=$1 ORDER BY created_at',[id])).rows.map(r=>r.status),['completed','completed','completed']);
  assert.equal((await admin.query('SELECT count(*)::int n FROM bb_sealed_model_captures WHERE job_id=$1',[id])).rows[0].n,3);
  assert.equal((await admin.query('SELECT count(*)::int n FROM bb_model_capacity_holders WHERE admission_job_id=$1',[id])).rows[0].n,0);
  assert.equal((await admin.query('SELECT execution_admission_phase FROM bb_jobs WHERE id=$1',[id])).rows[0].execution_admission_phase,'authoring');
  await assert.rejects(finish(worker,lease,'succeeded'),/Verified Word artifact required/);
  assert.equal((await admin.query('SELECT state FROM bb_runs WHERE id=$1',[id])).rows[0].state,'running');
  assert.equal(await release(lease),'queued');
  const post=await next(id,'postprocess');assert.notEqual(post.token,lease.token);const postCtx=await context(post);
  let generated!:StageOutcome,delivered!:StageOutcome;
  await withTaskExecution(worker,{kind:'job',id,token:post.token},async()=>{
   generated=await workflowAuthoringStage({config,tokenLimit:1000}).run(postCtx);assert.equal(generated.kind,'done');
   if(generated.kind!=='done')throw Error('synthetic postprocess not done');
   const generatedValue=generated.value as FileAuthoringResult;
   const emptyPath=join(root,'empty-quality-candidate.docx');
   await taskExecFile(process.env.BONDBUDDY_WORD_PYTHON!,['-B','-s','-c','from docx import Document; import sys; Document().save(sys.argv[1])',emptyPath],{timeout:30000,signal:postCtx.signal});
   const empty=await readFile(emptyPath),emptyHash=digest(empty),emptyKey=`owners/${owner}/projects/${id}/runs/${id}/file-authoring/${emptyHash}/empty-clean.docx`;
   await blobs.put(emptyKey,empty,'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
   postCtx.values.set('model_generation',{...generatedValue,files:{...generatedValue.files,'clean.docx':{key:emptyKey,sha256:emptyHash,byte_size:empty.length}}});
   const rejected=await fileAuthoringDeliveryStage().run(postCtx);
   assert.equal(rejected.kind,'fail');if(rejected.kind==='fail')assert.equal(rejected.code,'WORD_QUALITY_REJECTED');
   assert.equal((await admin.query('SELECT count(*)::int n FROM bb_artifact_versions WHERE run_id=$1',[id])).rows[0].n,0);
   postCtx.values.set('model_generation',generated.value);
   delivered=await fileAuthoringDeliveryStage().run(postCtx);
   assert.equal(delivered.kind,'deliver');
   await assert.rejects(finish(worker,post,'succeeded'),/Verified Word artifact required/);
   return 'handoff_pending' as const;
  });
  assert.equal((await sends()).length-start,3,'postprocess cannot issue another model call');
  assert.equal((await admin.query('SELECT count(*)::int n FROM bb_artifact_versions WHERE run_id=$1',[id])).rows[0].n,0,'candidate and quality pass do not promote or settle');
  assert.equal((await admin.query('SELECT state FROM bb_runs WHERE id=$1',[id])).rows[0].state,'running');
  await cancel(id);await release(post);
 });

 if(!['controlled','delivery','direct'].includes(process.env.BB_WORKFLOW_NATIVE_CASE??''))await t.test('recreated stage skips a hash verified committed chapter and outline',async()=>{
  const id=await add(),lease=await next(id,'authoring'),ctx=await context(lease);await seed(ctx);const start=(await sends()).length;
  const crash:typeof codexModelStage=options=>options.name==='workflow_1_0_0'?{name:options.name,run:async()=>{throw Error('SYNTHETIC_CRASH_BEFORE_SECOND_INTENT');}}:codexModelStage(options);
  await assert.rejects(scoped(ctx,workflowAuthoringStage({config,tokenLimit:1000,model:crash})),/SYNTHETIC_CRASH_BEFORE_SECOND_INTENT/);
  const saved=(await admin.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[id])).rows[0].checkpoint.workflow_v1 as AuthoringWorkflowV1;assert.equal(saved.completed.length,1);
  assert.equal(await release(lease),'queued');
  const resumed=await next(id,'authoring'),fresh=await context(resumed);
  assert.deepEqual(await scoped(fresh),{kind:'handoff_pending'});
  const current=(await admin.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[id])).rows[0].checkpoint.workflow_v1 as AuthoringWorkflowV1;
  assert.deepEqual(current.completed[0],saved.completed[0]);assert.equal(current.completed.length,2);
  assert.equal((await sends()).length-start,3,'outline and first verified chapter must not be sent twice');
  await cancel(id);await release(resumed);
 });

 if(!['controlled','delivery','direct'].includes(process.env.BB_WORKFLOW_NATIVE_CASE??''))await t.test('an unknown committed intent pauses A without resending while B can execute',async()=>{
  const id=await add(),lease=await next(id,'authoring'),ctx=await context(lease);await seed(ctx);const start=(await sends()).length;
  const crash:typeof codexModelStage=options=>codexModelStage({...options,wrapJournal:journal=>{
   const original=journal.recordIntent.bind(journal);journal.recordIntent=async intent=>{await original(intent);throw Error('SYNTHETIC_CRASH_AFTER_INTENT');};return journal;
  }});
  await assert.rejects(scoped(ctx,workflowAuthoringStage({config,tokenLimit:1000,model:crash})),/SYNTHETIC_CRASH_AFTER_INTENT/);
  assert.equal((await sends()).length,start,'crash happened before native provider send');
  const b=await add(),peer=await next(b,'authoring'),peerCtx=await context(peer);await seed(peerCtx);
  assert.deepEqual(await scoped(peerCtx),{kind:'handoff_pending'},'B proceeds while A retains its original token');
  assert.equal((await admin.query('SELECT lease_token FROM bb_jobs WHERE id=$1',[id])).rows[0].lease_token,lease.token);
  assert.equal(await release(lease),'paused');
  const parked=(await admin.query('SELECT state,stage,lease_token FROM bb_jobs WHERE id=$1',[id])).rows[0];assert.deepEqual(parked,{state:'paused',stage:'provider_reconcile',lease_token:null});
  const count=(await sends()).length;assert.equal(await claim(worker,90,{runKinds:['generation'],workflowPhase:'authoring'}),null);assert.equal((await sends()).length,count);
  assert.equal((await admin.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE job_id=$1',[id])).rows[0].n,1);
  await cancel(b);await release(peer);await cancel(id);
 });

 if(!['delivery','direct'].includes(process.env.BB_WORKFLOW_NATIVE_CASE??''))await t.test('controlled DOCX restores editor V2 receipts and pending comments before trusted finalize',async()=>{
  const id=await add(),lease=await next(id,'authoring'),ctx=await context(lease),start=(await sends()).length;
  process.env.BB_WORKFLOW_WORK_ROOT=join(root,'controlled-workspaces');
  const seedControlled=async()=>{
   const sourcePath=join(root,'controlled-source.docx');
   await taskExecFile(process.env.BONDBUDDY_WORD_PYTHON!,['-B','-s','-c',"from docx import Document; import sys; d=Document(); d.add_heading('第一章 合成概况',1); d.add_paragraph('合成发行人资料。本段只作测试，不包含真实企业财务事实。'); d.add_heading('第二章 合成经营',1); d.add_paragraph('合成发行人经营说明。本段只作测试，专业审核尚未执行。'); d.save(sys.argv[1])",sourcePath],{timeout:30000,signal:ctx.signal});
   const source=await readFile(sourcePath),pin={material_id:'source',material_version:1,sha256:digest(source),role:'historical'};
   const ref=await writeWorkflowObject(ctx,'source.docx',source);
   const input={manifest:{issuer_name:'合成发行人',market:'sse',offering:'private',update_details:{...emptyUpdateDetails(),authoring_mode:'unified_v1'},materials:[pin],authoring:{version:'unified_v1',source_prospectuses:[],knowledge:[],knowledge_status:'authoring_reference_not_compliance_approval',requirements:[],format_policy:{version:'source-format-v1',mode:'preserve_docx',selection:'automatic',template:{kind:'material',material_id:pin.material_id,material_version:1,sha256:pin.sha256}}}},materials:[{pin,filename:'source.docx',mediaType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',objectKey:ref.key,records:[],pending:[]}],requirements:['Synthetic controlled recovery fixture']} as ChapterContextV1['input'];
   const inventoryResult=await taskExecFile(process.env.BONDBUDDY_WORD_PYTHON!,['-B','-s','-m','bondbuddy_file_authoring.chapter_inventory',sourcePath],{cwd:'/app',env:{...process.env,PYTHONPATH:'/app/python'},timeout:30000,maxBuffer:1024*1024,signal:ctx.signal});
   const inventory=JSON.parse(inventoryResult.stdout);assert.equal(inventory.source_sha256,pin.sha256);assert.equal(inventory.chapters.length,2);
   const parser_version='synthetic-parser-v1',value:ChapterContextV1={version:'chapter-context-v1',input_hash:ctx.run.input_hash.trim(),parser_version,input,source:ref,chapters:inventory.chapters,nodes:inventory.nodes,material_snapshot_hash:inputManifestHash({input,parser_version})};
   const contextRef=await writeWorkflowObject(ctx,'chapter-context.json',Buffer.from(JSON.stringify(value)));ctx.checkpoint.chapter_context_v1={ref:contextRef,material_snapshot_hash:value.material_snapshot_hash,input_hash:value.input_hash};ctx.lease.checkpoint.stages=ctx.checkpoint;
   await admin.query("UPDATE bb_jobs SET checkpoint=jsonb_set(checkpoint,'{stages}',$2::jsonb) WHERE id=$1",[id,JSON.stringify(ctx.checkpoint)]);
  };
  const crash:typeof codexModelStage=options=>options.name==='workflow_1_0_0'?{name:options.name,run:async()=>{throw Error('SYNTHETIC_CONTROLLED_CRASH_AFTER_FIRST_COMMIT');}}:codexModelStage(options);
  await assert.rejects(scoped(ctx,workflowAuthoringStage({config,tokenLimit:1000,model:crash}),seedControlled),/SYNTHETIC_CONTROLLED_CRASH_AFTER_FIRST_COMMIT/);
  const first=(await admin.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[id])).rows[0].checkpoint.workflow_v1 as AuthoringWorkflowV1;assert.equal(first.completed.length,1);assert.ok(first.completed[0]!.projection_version>=2);assert.ok(first.completed[0]!.accepted_op_receipts.length>=2);
  const prior=JSON.parse((await blobs.get(first.completed[0]!.object.key)).toString('utf8'));assert.ok(prior.editor_manifest);assert.ok(prior.editor_objects.length>=2);
  for(const object of prior.editor_objects)assert.equal(digest(await blobs.get(object.ref.key)),object.ref.sha256);
  assert.equal(await release(lease),'queued');
  const workspace=join(process.env.BB_WORKFLOW_WORK_ROOT!,'workflow-state',digest(id),ctx.run.input_hash.trim());assert.ok(workspace.startsWith(root+'/'));await rm(workspace,{recursive:true,force:true});
  const resumed=await next(id,'authoring'),fresh=await context(resumed);assert.deepEqual(await scoped(fresh),{kind:'handoff_pending'});
  const complete=(await admin.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[id])).rows[0].checkpoint.workflow_v1 as AuthoringWorkflowV1;
  assert.deepEqual(complete.completed[0],first.completed[0]);assert.equal(complete.completed.length,2);assert.ok(complete.completed[1]!.projection_version>first.completed[0]!.projection_version);
  assert.equal((await sends()).length-start,2,'DOCX path sends no outline or repeated first chapter');assert.equal(await release(resumed),'queued');
  const post=await next(id,'postprocess'),postCtx=await context(post);
  await withTaskExecution(worker,{kind:'job',id,token:post.token},async()=>{
   const generated=await workflowAuthoringStage({config,tokenLimit:1000}).run(postCtx);assert.equal(generated.kind,'done');if(generated.kind!=='done')throw Error('controlled postprocess not done');postCtx.values.set('model_generation',generated.value);
   const delivered=await fileAuthoringDeliveryStage().run(postCtx);assert.equal(delivered.kind,'deliver');if(delivered.kind!=='deliver')throw Error('controlled trusted finalize failed');
   const tracked=join(root,'controlled-tracked.docx');await writeFile(tracked,delivered.bytes);
   const comments=await taskExecFile(process.env.BONDBUDDY_WORD_PYTHON!,['-B','-s','-c',"from zipfile import ZipFile; import sys; z=ZipFile(sys.argv[1]); print(z.read('word/comments.xml').decode('utf-8'))",tracked],{timeout:30000,signal:postCtx.signal});
   assert.match(comments.stdout,/Synthetic pending chapter-0/);assert.match(comments.stdout,/Synthetic pending chapter-1/);
   assert.equal((delivered.wordSummary?.quality_gate as any)?.status,'passed');await assert.rejects(finish(worker,post,'succeeded'),/Verified Word artifact required/);return 'handoff_pending' as const;
  });
  assert.equal((await sends()).length-start,2);await cancel(id);await release(post);
 });

 if(!['controlled','direct'].includes(process.env.BB_WORKFLOW_NATIVE_CASE??''))await t.test('real paid pipeline joins a stalled Blob child and resumes promoted Word without duplicate delivery or charge',async()=>{
  // Administrative seeding is explicit synthetic fixture data. The stages below
  // use the real immutable input gate, original material loader, accounting and
  // delivery APIs; no stage or finish outcome is substituted.
  const id=randomUUID(),material=randomUUID(),upload=randomUUID(),reservation=randomUUID(),quote=randomUUID(),price=randomUUID();
  const sourcePath=join(root,'paid-source.docx');
  await withBackgroundTaskExecution(()=>taskExecFile(process.env.BONDBUDDY_WORD_PYTHON!,['-B','-s','-c',"from docx import Document; import sys; d=Document(); d.add_heading('第一章 合成概况',1); d.add_paragraph('合成发行人资料。本段只作测试，不包含真实企业财务事实。'); d.add_heading('第二章 合成经营',1); d.add_paragraph('合成发行人经营说明。本段只作测试，专业审核尚未执行。'); d.save(sys.argv[1])",sourcePath],{timeout:30000}));
  const source=await readFile(sourcePath),sourceHash=digest(source),key=`users/${owner}/projects/${id}/materials/${material}/source.docx`,media='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  await blobs.put(key,source,media);
  const pin={material_id:material,material_version:1,role:'historical',sha256:sourceHash};
  const period={start:'2025-01-01',end:'2025-12-31',period_kind:'annual' as const,scope:'consolidated' as const,status:'user_asserted' as const,evidence_refs:[]};
  const knowledge='# 第一章 合成概况\n\n合成资料仅用于固定集成测试，不属于合规审核。\n# 第二章 合成经营\n\n不得伪造财务事实。';
  const manifest={kind:'update',draft_revision:1,issuer_name:'合成发行人',market:'sse',offering:'private',materials:[pin],
   update_details:{...emptyUpdateDetails(),authoring_mode:'unified_v1',target_reporting_periods:[period]},
   authoring:{version:'unified_v1',source_prospectuses:[{...pin,issuer_name:'合成发行人',relation:'same_issuer',market:'sse',offering:'private',reporting_periods:[period],status:'user_asserted'}],
    knowledge:[{path:'synthetic-paid.md',markdown:knowledge,sha256:digest(knowledge)}],knowledge_status:'authoring_reference_not_compliance_approval',requirements:[],
    format_policy:{version:'source-format-v1',mode:'preserve_docx',selection:'automatic',template:{kind:'material',material_id:material,material_version:1,sha256:sourceHash}}}};
  const hash=inputManifestHash(manifest);
  await transaction(admin,async c=>{
   await c.query("INSERT INTO bb_projects(id,owner_user_id,name,kind,issuer_name,market,offering) VALUES($1,$2,'Synthetic paid workflow','update','合成发行人','sse','private')",[id,owner]);
   await c.query("INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state,received_sha256,received_bytes) VALUES($1,$2,$3,'source.docx',$4,$5,$6,'historical',$7,now()+interval '1 hour','completed',$6,$5)",[upload,owner,id,media,source.length,sourceHash,key]);
   await c.query("INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state) VALUES($1,1,$2,$3,$4,'historical','source.docx',$5,$6,$7,$8,'ready')",[material,owner,id,upload,media,source.length,sourceHash,key]);
   await c.query("INSERT INTO bb_input_revisions(project_id,owner_user_id,revision,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,$2,1,1,$3,$4,$5,'[]')",[id,owner,hash,manifest,JSON.stringify([pin])]);
   await c.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,channel) VALUES($1,$2,$1,1,$3,$1,'update',$3,'queued','production')",[id,owner,hash]);
   await c.query("INSERT INTO bb_jobs(id,owner_user_id,project_id,run_id,job_type,subtype,state) VALUES($1,$2,$1,$1,'update','default','queued')",[id,owner]);
   await grantCredits(c,{owner,source:'existing_grant',key:randomUUID(),points:100,expiresAt:null,actor:'synthetic',reason:'Synthetic full-pipeline settlement fixture'});
   await c.query("INSERT INTO bb_credit_price_versions(id,prices,effective_at,actor,reason) VALUES($1,'{}',clock_timestamp(),'synthetic','Synthetic pipeline price')",[price]);
   await c.query("INSERT INTO bb_credit_quotes(id,owner_user_id,project_id,input_revision,input_hash,price_version,task_type,points,reason) VALUES($1,$2,$3,1,$4,$5,'annual',60,'Synthetic pipeline reservation')",[quote,owner,id,hash,price]);
   await c.query("INSERT INTO bb_credit_reservations(id,owner_user_id,run_id,quote_id,points,billing_policy) VALUES($1,$2,$3,$4,60,'on_delivery')",[reservation,owner,id,quote]);
   await reserveCreditLots(c,owner,reservation,60n);
   await c.query("UPDATE bb_runs SET billing_mode='fixed_credits',reservation_id=$2 WHERE id=$1",[id,reservation]);
  });
  const bounded=boundedPrivateBlobs(blobs,{connectionString:blobRoot,timeoutMs:1500,command:[process.execPath,fileURLToPath(new URL('../test-fixtures/codex/fake-private-blob-io.mjs',import.meta.url))]});
  const stages=[inputLockStage,materialsReadyStage,workflowAuthoringStage({config,tokenLimit:1000}),fileAuthoringDeliveryStage()];
  const take=async(phase:'authoring'|'postprocess',afterStage?:(name:string,lease:Lease)=>Promise<void>)=>{
   let claimed:Lease|undefined;
   await readyHeartbeat();
   const outcome=await runPipelineOnce({pool:worker,blobs:bounded,leaseSeconds:90,runKinds:['update'],workflowPhase:phase,stages,
    onLease:lease=>{if(lease){claimed=lease;assert.equal(lease.jobId,id);}},afterStage});
   assert.ok(claimed);return {outcome,lease:claimed!};
  };
  const start=(await sends()).length,author=await take('authoring');assert.equal(author.outcome,'handoff_pending');
  assert.equal((await sends()).length-start,2);
  assert.equal(await release(author.lease),'queued');
  const held=async()=>assert.deepEqual((await admin.query('SELECT state,COALESCE(charged_points,0)::text AS charged_points FROM bb_credit_reservations WHERE id=$1',[reservation])).rows[0],{state:'held',charged_points:'0'});
  await held();
  // This fixed child actually blocks and ignores SIGTERM. Production bounded IO
  // must kill and join it before retry can expose an empty task release proof.
  await writeFile(join(blobRoot,'stall-next.json'),JSON.stringify({op:'get',suffix:'/chapter-context.json'}),{mode:0o600});
  const stalled=await take('postprocess');assert.equal(stalled.outcome,'retry');assert.notEqual(stalled.lease.token,author.lease.token);
  const stalledPid=Number((await readFile(join(blobRoot,'stalled-pid'),'utf8')).trim());assert.ok(stalledPid>1);
  assert.throws(()=>process.kill(stalledPid,0),(error:unknown)=>(error as NodeJS.ErrnoException).code==='ESRCH','retry returned only after the real stalled child exited');
  assert.equal(await release(stalled.lease),'queued');await held();
  assert.equal((await admin.query('SELECT count(*)::int n FROM bb_model_capacity_holders WHERE admission_job_id=$1',[id])).rows[0].n,0);
  let promotedLease:Lease|undefined;
  await assert.rejects(take('postprocess',async(name,lease)=>{if(name==='word_promoted'){promotedLease=lease;throw Error('SYNTHETIC_CRASH');}}),/SYNTHETIC_CRASH/);
  assert.ok(promotedLease);assert.notEqual(promotedLease.token,stalled.lease.token);
  const before=(await admin.query("SELECT id,version,sha256,delivery_status FROM bb_artifact_versions WHERE run_id=$1 ORDER BY id",[id])).rows;
  assert.equal(before.length,2);assert.ok(before.every(r=>r.delivery_status==='available'));
  assert.equal((await admin.query("SELECT checkpoint->'stages' ? 'word_delivery_pair' AS paired FROM bb_jobs WHERE id=$1",[id])).rows[0].paired,false);
  await held();assert.equal(await release(promotedLease),'queued');
  const recovered=await take('postprocess');assert.equal(recovered.outcome,'pause_pending');assert.notEqual(recovered.lease.token,promotedLease.token);
  assert.equal((await admin.query('SELECT state FROM bb_runs WHERE id=$1',[id])).rows[0].state,'running','success waits for positive task release');await held();
  assert.equal(await taskNativeProcesses(recovered.lease),0);
  const finalProof=taskReleaseProof(worker,recovered.lease),finalRelease=await release(recovered.lease);assert.equal(finalRelease,'succeeded');
  const final=(await admin.query("SELECT r.state,r.channel,r.artifact_id,j.state AS job_state,j.lease_token,j.checkpoint FROM bb_runs r JOIN bb_jobs j ON j.run_id=r.id WHERE r.id=$1",[id])).rows[0];
  assert.equal(final.state,'succeeded');assert.equal(final.channel,'production');assert.equal(final.job_state,'succeeded');assert.equal(final.lease_token,null);
  assert.equal(final.checkpoint.positive_release_v1.lease_token,recovered.lease.token);assert.equal(final.checkpoint.positive_release_v1.native_processes,0);
  assert.equal(final.checkpoint.stages.word_delivery_pair.revision_artifact_id,final.artifact_id);assert.notEqual(final.checkpoint.stages.word_delivery_pair.clean_artifact_id,final.artifact_id);
  const after=(await admin.query("SELECT a.id,a.version,a.sha256,a.delivery_status,a.object_key,e.delivery_code,e.readback_sha256,e.candidate_sha256 FROM bb_artifact_versions a JOIN bb_word_delivery_evidence e ON e.id=a.word_delivery_evidence_id WHERE a.run_id=$1 ORDER BY a.id",[id])).rows;
  assert.equal(after.length,2);assert.deepEqual(after.map(({id,version,sha256,delivery_status})=>({id,version,sha256,delivery_status})),before);
  for(const artifact of after){assert.equal(artifact.delivery_code,'readback_verified');assert.equal(artifact.readback_sha256.trim(),artifact.sha256.trim());assert.equal(artifact.candidate_sha256.trim(),artifact.sha256.trim());assert.equal(digest(await blobs.get(artifact.object_key)),artifact.sha256.trim());}
  assert.deepEqual((await admin.query('SELECT state,charged_points::text FROM bb_credit_reservations WHERE id=$1',[reservation])).rows[0],{state:'settled',charged_points:'60'});
  assert.deepEqual((await admin.query('SELECT sum(remaining)::int remaining,sum(frozen)::int frozen FROM bb_credit_lots WHERE owner_user_id=$1',[owner])).rows[0],{remaining:40,frozen:0});
  assert.equal((await admin.query("SELECT count(*)::int n FROM bb_credit_events WHERE reservation_id=$1 AND kind='settle'",[reservation])).rows[0].n,1);
  assert.equal((await admin.query("SELECT count(*)::int n FROM bb_prospectus_versions WHERE run_id=$1",[id])).rows[0].n,1);
  assert.equal((await sends()).length-start,2,'postprocess IO retry and promotion crash never resend committed chapters');
  assert.equal(await completeManagedRunRelease(worker,recovered.lease,finalProof),'stale','a repeated completion cannot settle or register again');
 });
});
