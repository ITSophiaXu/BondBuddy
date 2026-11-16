// Synthetic suppliers and inputs; real component emits, PG admission and journals.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const roots={authoring:process.env.BB_MANAGED_AUTHORING_SOURCE,review:process.env.BB_MANAGED_REVIEW_SOURCE};
if(!roots.authoring||!roots.review||!process.env.BB_TEST_DATABASE_URL)throw Error('Both built candidates and an isolated migrated PG template are required');
const load=(root,path)=>import(pathToFileURL(join(root,path)).href);
const {isolatedTestDatabase}=await load(roots.authoring,'apps/worker/dist/test-database.js');
const hash='a'.repeat(64);
for(const [role,root] of Object.entries(roots).filter(([role])=>!process.env.BB_MANAGED_TEST_ROLE||process.env.BB_MANAGED_TEST_ROLE===role))test(`${role}: unchanged legacy input and journal run under managed admission`,{timeout:30000},async t=>{
  const connection=await isolatedTestDatabase(undefined,`narrow-overlay-${role}`);
  const {Pool}=createRequire(join(root,'package.json'))('pg');
  const pool=new Pool({connectionString:connection,max:4});t.after(()=>pool.end());
  const capacity=await load(root,'apps/api/dist/execution-capacity.js');
  const control=capacity.executionCapacityControl(pool);
  const queue=await load(root,'apps/api/dist/queue.js');
  const {inputManifestHash}=await load(root,'apps/api/dist/production-rule-pin.js');
  const {savePromptSnapshot}=await load(root,'apps/api/dist/log-ops.js');
  const adapter=await load(root,'apps/worker/dist/codex-adapter.js');
  const assistant=await load(root,'apps/worker/dist/review-assistant.js');
  const identity={account_id:'synthetic',region:'synthetic',instance_id:`narrow-${role}`,epoch:randomUUID()};
  const capabilities=role==='authoring'?['authoring']:['review','assistant'];
  await capacity.configureExecutionCapacity(pool,0,{managed_nodes:true,global_model_limit:4,max_nodes:2,budget_available:true});
  let op=await control.reserveStart({...identity,instance_id:null,instance_count:1,source_sha256:hash,image_sha256:hash,launch_manifest_sha256:hash,capabilities,services:[{service_id:'one',capabilities}]},`narrow-${role}`,1);
  op=await control.claimCloudDispatch(op.operation_id,op.revision);
  const ack=`synthetic-${role}-ack`;
  await assert.rejects(control.recordCloudResult(op.operation_id,op.revision,{state:'submitted',identity,provider_request_id:ack,observation:null}),/ACCEPTANCE_UNPROVEN/);
  op=await control.recordCloudResult(op.operation_id,op.revision,{state:'submitted',identity,provider_request_id:ack,observation:null,
    run_acceptance:{operation_id:op.operation_id,identity,provider_request_id:ack,instance_ids:[identity.instance_id],client_token:op.client_token,launch_manifest_sha256:hash,launch_binding_sha256:hash,evidence_ref:'synthetic-acceptance',evidence_sha256:hash}});
  await control.recordCloudResult(op.operation_id,op.revision,{state:'completed',identity,provider_request_id:ack,observation:{instance_state:'RUNNING',latest_operation:'RunInstances',latest_operation_state:'SUCCESS',latest_operation_request_id:ack,stop_charging_mode:null,observed_at:new Date().toISOString(),evidence_ref:'synthetic-description',evidence_sha256:hash,
    run_creation:{operation_id:op.operation_id,identity,launch_manifest_sha256:hash,launch_binding_sha256:hash,created_at:new Date().toISOString(),instance_status:'RUNNING',status_request_id:'synthetic-description'}}});
  const token='synthetic-registration-token-0123456789';
  await capacity.bindExecutionRegistration(pool,identity,op.operation_id,token);
  // A second unregistered pool cannot take either role's old queue input.
  const legacy=new Pool({connectionString:connection});t.after(()=>legacy.end());
  await assert.rejects(queue.claim(legacy,30,{runKinds:role==='authoring'?['generation']:['review']}),/admission required/);
  await assert.rejects(assistant.claimReviewAssistant(legacy),/admission required/);
  await capacity.registerExecutionRuntime(pool,{identity,session_id:randomUUID()},{service_id:'one',capabilities,source_sha256:hash,image_sha256:hash,launch_manifest_sha256:hash,registration_token:token,process_identity:{pid:String(process.pid)}});
  await capacity.heartbeatExecutionRuntime(pool,{native_processes:0,unpersisted_results:0,ready:true});
  const owner=randomUUID(),project=randomUUID();
  await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,`synthetic_${owner.replaceAll('-','').slice(0,12)}`]);
  await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind,issuer_name,market,offering) VALUES($1,$2,'Synthetic narrow candidate',$3,'合成发行人','sse','private')",[project,owner,role==='authoring'?'generation':'review']);
  const values=new Map();
  const blobs={put:async(k,b)=>{values.set(k,b);},get:async k=>values.get(k),getIfExists:async k=>values.get(k)??null,getIfExistsBounded:async(k,n)=>{const b=values.get(k);return b&&b.length<=n?b:null;},delete:async k=>{values.delete(k);},exists:async k=>values.has(k)};
  const scratch=resolve(process.env.BB_MANAGED_TEST_SCRATCH??'.managed-overlay-test',randomUUID());
  await mkdir(scratch,{recursive:true});t.after(()=>rm(scratch,{recursive:true}));
  const fake=join(scratch,'synthetic-supplier.mjs'),marker=join(scratch,'sends');
  await writeFile(fake,`import {appendFileSync} from 'node:fs';for await(const chunk of process.stdin){};const [marker,reply]=process.argv.slice(2);appendFileSync(marker,'sent\\n');const out=v=>process.stdout.write(JSON.stringify(v)+'\\n');out({type:'thread.started',thread_id:'synthetic-thread'});out({type:'turn.started'});out({type:'item.completed',item:{id:'reply',type:'agent_message',text:reply}});out({type:'turn.completed',usage:{input_tokens:83,cached_input_tokens:41,output_tokens:17,reasoning_output_tokens:3}});`);
  const reply=role==='authoring'?{answer:'Synthetic saved result',n:16}:{content:'合成回复：保留原始证据。',cited_finding_ids:[],proposal:null};
  const config={command:[process.execPath,fake,marker,JSON.stringify(reply)],model_id:'deepseek-flash',model_provider:'deepseek',base_url:'https://api.deepseek.com',wire_api:'responses',model_config_version:'synthetic-narrow-overlay',reasoning_effort:null,credential:{kind:'env',name:'BB_MANAGED_SYNTHETIC_KEY'},work_root:join(scratch,'work'),timeout_ms:5000,kill_grace_ms:100,max_output_bytes:1048576,max_schema_reasks:0,disabled_features:adapter.DEFAULT_DISABLED_FEATURES,path_env:process.env.PATH};
  process.env.BB_MANAGED_SYNTHETIC_KEY='synthetic-no-provider';
  let savedInput,runId;
  if(role==='authoring'){
    runId=randomUUID();savedInput={synthetic:true,legacy_input_version:1};const inputHash=inputManifestHash(savedInput);
    await pool.query("INSERT INTO bb_input_revisions(project_id,owner_user_id,revision,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,$2,1,1,$3,$4,'[]','[]')",[project,owner,inputHash,savedInput]);
    await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,1,$4,$1,'generation',$4,'queued')",[runId,owner,project,inputHash]);
    await pool.query("INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state) VALUES($1,$2,$1,'generation','default','queued')",[runId,owner]);
    const lease=await queue.claim(pool,120,{runKinds:['generation']});assert.equal(lease.runId,runId);
    const snapshot=await savePromptSnapshot(pool,blobs,{owner,projectId:project,runId,kind:'model_request',version:1,body:'Synthetic unchanged input',inputRevision:1,inputHash,templateVersion:'synthetic-v1'});
    const {CodexDurableJournal}=await load(root,'apps/worker/dist/durable-probe-journal.js');
    const journal=new CodexDurableJournal({pool,blobs,lease,validateResult:v=>v?.answer===reply.answer&&v.n===16});
    const call={owner_user_id:owner,project_id:project,job_id:lease.jobId,run_id:runId,trace_id:runId,logical_call_id:'synthetic-old-input',prompt_snapshot_ref:snapshot,prompt:'Synthetic unchanged input',result_schema_version:'synthetic-v1',output:{kind:'json',schema:{type:'object',properties:{answer:{type:'string'},n:{type:'integer'}},required:['answer','n'],additionalProperties:false},validate:v=>v?.answer===reply.answer&&v.n===16}};
    const result=await adapter.runContainedModelCall(call,journal,config);assert.equal(result.status,'completed',JSON.stringify(result));
    const again=await adapter.runContainedModelCall(call,journal,config);assert.equal(again.status,'reused');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_provider_result_refs WHERE job_id=$1',[lease.jobId])).rows[0].n,1);
    assert.deepEqual((await pool.query('SELECT manifest FROM bb_input_revisions WHERE project_id=$1',[project])).rows[0].manifest,savedInput);
    await pool.query("UPDATE bb_jobs SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE id=$1",[lease.jobId]);
  }else{
    const id=randomUUID(),context={project_id:project,report_id:null,finding_ids:[],material_refs:[]},content='合成提问：保留证据。';
    savedInput={version:'review-assistant-context-v1',project:{issuer_name:'合成发行人',market:'sse',offering:'private'},input:{version:0,source_material_ref:null,material_versions:[],requirements:['合成输入'],as_of:null},report:null,report_sha256:null,material_refs:[],prior_message_ids:[]};
    await pool.query("INSERT INTO bb_review_messages(id,owner_user_id,project_id,submission_request_id,request_hash,role,content,context,context_snapshot,reply_status) VALUES($1,$2,$3,$4,$5,'user',$6,$7,$8,'queued')",[id,owner,project,randomUUID(),inputManifestHash({project_id:project,content,context}),content,context,savedInput]);
    await assistant.runReviewAssistantOnce({pool,blobs,config});
    const row=(await pool.query('SELECT reply_status,context_snapshot FROM bb_review_messages WHERE id=$1',[id])).rows[0];assert.equal(row.reply_status,'completed');assert.deepEqual(row.context_snapshot,savedInput);
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_review_assistant_attempts WHERE message_id=$1 AND status='completed'",[id])).rows[0].n,1);
    assert.equal(await assistant.runReviewAssistantOnce({pool,blobs,config}),'idle');
  }
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_capacity_holders')).rows[0].n,0);
  assert.equal((await pool.query("SELECT count(*)::int n FROM information_schema.tables WHERE table_name='bb_run_model_activity'")).rows[0].n,0,'0182 is not installed');
  const node=(await control.snapshot()).nodes[0];await control.beginDrain(identity,`synthetic-${role}-drain`,node.revision);
  await capacity.heartbeatExecutionRuntime(pool,{native_processes:0,unpersisted_results:0,ready:false,finished:true});
  assert.ok(await control.drainProof(identity,`synthetic-${role}-drain`));
});
