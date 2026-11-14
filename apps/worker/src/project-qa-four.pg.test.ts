// Synthetic model replies; actual API, wallet, queue, private blobs, Python Word and download authorization.
// HTTP monetary amounts use the current int64 string protocol; database balances remain numbers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Pool} from 'pg';
import {BlobServiceClient} from '@azure/storage-blob';
import {createServer} from '@bondbuddy/api';
import {azureBlobs,digest,transaction} from '@bondbuddy/api/data';
import {grantCredits,creditBalance} from '../../api/dist/billing.js';
import {PROJECT_QA_PRICE,type QaInput,type QaWorkspace} from '@bondbuddy/contracts';
import {isolatedTestDatabase} from './test-database.js';
import {DeferredQaJournal} from './deferred-qa-journal.js';
import {Value} from '@sinclair/typebox/value';
import {QaWorkspaceSchema,QaAnswerSchema,billingDtoSchema,Int64Schema,encodeBillingDto} from '@bondbuddy/contracts';
import {readQa} from '@bondbuddy/api/project-qa';
import {inputManifestHash} from '@bondbuddy/api/production-rule-pin';
import {savePromptSnapshot} from '@bondbuddy/api/log-ops';
import {inputLockStage,materialsReadyStage,runPipelineOnce,codexModelStage} from './run-pipeline.js';
import {projectQaModelStage,projectQaDeliveryStage,groundedQaAnswer} from './project-qa-stage.js';
import {projectFilesRoot} from './project-file-tools.js';
import {loadCodexAdapterConfig} from './codex-adapter.js';
const database=await isolatedTestDatabase(undefined,'project-qa-four'),storage=process.env.BB_TEST_AZURITE_CONNECTION_STRING;
test('four question stage persists three siblings after failure or unknown and reuses successes without charging twice',{skip:!database||!storage||!process.env.BONDBUDDY_TEST_PYTHON,timeout:300000},async()=>{
 const pool=new Pool({connectionString:database}),owner=randomUUID(),other=randomUUID(),container='bb-qa-'+randomUUID().replaceAll('-','');let actor=owner,calls=0,active=0,peak=0,mode:'failed'|'unknown'|'success'='failed';
 const blobs=azureBlobs(storage!,container),origin='http://bondbuddy.test',app=createServer({pool,blobs,historicalBillingFixture:true,allowedOrigin:origin,enableRunRuntime:true,principal:async()=>({userId:actor,csrfVerified:true})});
 const send=(method:string,url:string,payload?:unknown)=>app.inject({method:method as any,url,payload:payload as any,headers:{origin,...(Buffer.isBuffer(payload)?{'content-type':'application/octet-stream'}:{})}});
 const ok=async(method:string,url:string,payload?:unknown)=>{const r=await send(method,url,payload);assert.ok(r.statusCode<300,method+' '+url+' '+r.body);return r.body?r.json():null;};
 let allStartedResolve:()=>void;let allStarted=new Promise<void>(resolve=>{allStartedResolve=resolve;});
 const model:typeof codexModelStage=o=>({name:o.name,replay:true,run:async ctx=>{
  const journal=new DeferredQaJournal({pool,blobs,lease:ctx.lease,validateResult:o.validate});
  const prior=await journal.latestAttempt(o.logicalCallId);if(prior){const saved=await journal.readCompleted(o.logicalCallId,prior.attempt_no);if(saved)return {kind:'done',value:saved.value};return {kind:'pause',stage:'provider_reconcile',reason:'provider_result_pending'};}
  const snapshot=await savePromptSnapshot(pool,blobs,{owner,projectId:ctx.run.project_id,runId:ctx.run.id,kind:'model_request',body:await o.buildPrompt(ctx),inputRevision:ctx.run.input_revision,inputHash:ctx.run.input_hash,templateVersion:o.templateVersion});
  const intent={owner_user_id:owner,project_id:ctx.run.project_id,job_id:ctx.lease.jobId,run_id:ctx.run.id,trace_id:ctx.run.id,logical_call_id:o.logicalCallId,call_id:randomUUID(),attempt_no:1,model_id:'synthetic-qa',model_config_version:'synthetic-v1',prompt_snapshot_ref:snapshot};await journal.recordIntent(intent);calls++;peak=Math.max(peak,++active);
  try{
   if(mode!=='success'){if(active===4)allStartedResolve!();await allStarted;}
   const input=(await pool.query('SELECT manifest FROM bb_project_qa_runs WHERE run_id=$1',[ctx.run.id])).rows[0].manifest as QaInput;
   const q=input.questions.find(q=>'qa-'+q.id===o.logicalCallId)!,first=q.id===input.questions[0].id;
   await new Promise(resolve=>setTimeout(resolve,first?10:150));
   const usage={status:'measured' as const,input_tokens:100,cached_input_tokens:0,output_tokens:20,reasoning_tokens:0,total_tokens:120};
   if(first&&mode!=='success'){
    await journal.recordObservation({...intent,provider_request_id:null,finish_reason:null,outcome:mode==='unknown'?'pending_reconcile':'failed',result_ref:null,result_sha256:null,result_schema_version:null,result_byte_size:null,error_code:mode==='unknown'?'MODEL_PROCESS_FAILED':'MODEL_OUTPUT_SCHEMA_INVALID',usage:mode==='unknown'?{status:'unknown',input_tokens:null,cached_input_tokens:null,output_tokens:null,reasoning_tokens:null,total_tokens:null}:usage});
    return mode==='unknown'?{kind:'pause',stage:'provider_reconcile',reason:'provider_result_pending'}:{kind:'fail',code:'MODEL_OUTPUT_SCHEMA_INVALID'};
   }
   const answer={question_id:q.id,answer:'请补充本题对应的原始证据。',status:'missing',missing_materials:['本题对应的可读披露与明细。'],citations:[],case_ids:[],approach:'仅依据提供的合成披露核对，不编造未披露事实。'};
   assert.ok(Value.Check(QaAnswerSchema,answer)&&o.validate(answer));const ref=await journal.storeResult(intent,Buffer.from(JSON.stringify(answer)),o.resultSchemaVersion);
   await journal.recordObservation({...intent,...ref,provider_request_id:null,finish_reason:'stop',outcome:'completed',usage,error_code:null});return {kind:'done',value:answer};
  }finally{active--;}
 }});
 const stage=projectQaModelStage({model,config:()=>loadCodexAdapterConfig({})}),execute=()=>runPipelineOnce({pool,blobs,leaseSeconds:120,runKinds:['generation'],stages:[inputLockStage,materialsReadyStage,stage,projectQaDeliveryStage()],onUnexpectedError:e=>assert.fail(JSON.stringify(e))});
 try{
  for(const id of [owner,other])await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[id,'qa_'+id.slice(0,8)]);
  await transaction(pool,c=>grantCredits(c,{owner,source:'purchase',key:randomUUID(),points:1000,expiresAt:null,actor:'synthetic',reason:'qa test'}));
  const p=await ok('POST','/api/v1/projects',{kind:'generation',name:'合成问答测试项目',issuer_name:'合成发行人',market:'sse',offering:'public'}),path='/api/v1/projects/'+p.project_id,base=path+'/qa';
  const dir=process.env.BB_QA_TEST_OUTPUT_DIRECTORY!;await mkdir(dir,{recursive:true});
  execFileSync(process.env.BONDBUDDY_TEST_PYTHON!,['-c','from pathlib import Path; import sys; import runpy; runpy.run_path("python/tests/test_project_qa.py")["fixtures"](Path(sys.argv[1]))',dir],{cwd:projectFilesRoot,env:{...process.env,PYTHONPATH:join(projectFilesRoot,'python'),PYTHONIOENCODING:'utf-8'}});
  execFileSync(process.env.BONDBUDDY_TEST_PYTHON!,['-c','from docx import Document; import sys; d=Document(sys.argv[1]); d.add_paragraph("4. 请说明合成发行人的其他偿付安排。"); d.save(sys.argv[1])',join(dir,'synthetic-questions.docx')]);
  // A valid supplementary Word without extractable text must not erase the
  // readable adopted prospectus or silently disappear from the delivered gaps.
  execFileSync(process.env.BONDBUDDY_TEST_PYTHON!,['-c','from docx import Document; import sys; Document().save(sys.argv[1])',join(dir,'synthetic-unreadable-attachment.docx')]);
  const upload=async(filename:string,role='other')=>{const bytes=await readFile(join(dir,filename)),decl={byte_size:bytes.length,sha256:digest(bytes)},u=await ok('POST',path+'/materials/uploads',{...decl,filename,role:filename==='synthetic-materials.docx'?'historical':role,media_type:filename.endsWith('.pdf')?'application/pdf':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'});await ok('PUT',u.upload_url,bytes);const m=await ok('POST',path+'/materials/uploads/'+u.upload_id+'/complete',decl);return {kind:'material' as const,pin:{source_project_id:p.project_id,material_id:m.material_id,material_version:m.material_version,sha256:m.sha256}};};
  const source=await upload('synthetic-questions.docx'),material=await upload('synthetic-materials.docx'),unreadableAttachment=await upload('synthetic-unreadable-attachment.docx'),request={request_id:randomUUID(),source};
  const prep=await ok('POST',base+'/prepare',request);assert.equal((await ok('POST',base+'/prepare',request)).run_id,prep.run_id);assert.equal(await execute(),'succeeded');assert.equal(calls,0);assert.deepEqual(await creditBalance(pool,owner),{available:1000,frozen:0});
  let w=await ok('GET',base) as QaWorkspace,prepared=w.runs[0];assert.equal(prepared.result!.questions.length,4);assert.equal(prepared.artifact_id,null);assert.equal(w.prospectus,null);
  const questions=prepared.result!.questions;
  const savedProspectus=await ok('POST',path+'/prospectus-versions',{request_id:randomUUID(),expected_selection_revision:0,material_id:material.pin.material_id,material_version:material.pin.material_version,sha256:material.pin.sha256});
  await ok('POST',path+'/prospectus-versions/current',{request_id:randomUUID(),expected_selection_revision:savedProspectus.selection_revision,version_id:savedProspectus.versions[0].version_id});
  w=await ok('POST',base+'/draft',{expected_revision:0,draft:{preparation_id:prep.run_id,questions,materials:[material],requirements:'四路合成验证，保留缺失证据。',use_knowledge:false}});
  const submit={request_id:randomUUID(),expected_revision:w.revision,expected_points:'240',price_version:PROJECT_QA_PRICE.version};
  const failed=await ok('POST',base+'/runs',submit);assert.equal(await execute(),'failed');assert.equal(active,0);assert.equal(peak,4);assert.equal(calls,4);
  const successes=(await pool.query('SELECT question_id,answer,sha256 FROM bb_project_qa_answers WHERE run_id=$1 ORDER BY question_id',[failed.run_id])).rows;assert.equal(successes.length,3);
  assert.equal((await pool.query("SELECT count(*)::int n FROM bb_model_call_attempts a JOIN bb_jobs j ON j.id=a.job_id WHERE j.run_id=$1 AND a.status='completed'",[failed.run_id])).rows[0].n,3);
  assert.deepEqual(await creditBalance(pool,owner),{available:1000,frozen:0});
  const wire=await ok('GET',base);assert.ok(Value.Check(billingDtoSchema(QaWorkspaceSchema,'qaWorkspace',Int64Schema) as typeof QaWorkspaceSchema,wire),'existing browser strict schema still reads the monetary wire');
  const visible=wire.runs.find((r:any)=>r.run_id===failed.run_id);assert.ok(visible);assert.equal(Object.hasOwn(visible.manifest,'max_parallel'),false);
  const persisted=(await readQa(pool,owner,p.project_id)).runs.find(r=>r.run_id===failed.run_id)!;
  assert.deepEqual(visible.manifest,encodeBillingDto('qaRun',persisted).manifest,'only the unchanged monetary codec projects the frozen manifest');
  const hash=(await pool.query('SELECT input_hash FROM bb_project_qa_runs WHERE run_id=$1',[failed.run_id])).rows[0].input_hash;assert.equal(inputManifestHash(persisted.manifest),hash);
  mode='success';const recovered=await ok('POST',base+'/runs',{...submit,request_id:randomUUID()});assert.equal(await execute(),'succeeded');assert.equal(calls,5,'only the failed question issues a new call');
  assert.deepEqual(await creditBalance(pool,owner),{available:760,frozen:0});
  const recoveredAnswers=(await pool.query('SELECT question_id,answer,sha256 FROM bb_project_qa_answers WHERE run_id=$1 ORDER BY question_id',[recovered.run_id])).rows;
  assert.equal(recoveredAnswers.length,4);for(const success of successes)assert.deepEqual(recoveredAnswers.find(a=>a.question_id===success.question_id),success);
  assert.equal(await execute(),'idle');assert.equal(calls,5);
  w=await ok('POST',base+'/draft',{expected_revision:w.revision,draft:{preparation_id:prep.run_id,questions,materials:[material],requirements:'四路不确定调用独立验收，不复用不同要求的答案。',use_knowledge:false}});
  mode='unknown';peak=0;allStarted=new Promise<void>(resolve=>{allStartedResolve=resolve;});const uncertain=await ok('POST',base+'/runs',{...submit,expected_revision:w.revision,request_id:randomUUID()});assert.equal(await execute(),'paused');assert.equal(peak,4);assert.equal(active,0);assert.equal(calls,9);
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_project_qa_answers WHERE run_id=$1',[uncertain.run_id])).rows[0].n,3);
  assert.equal((await pool.query("SELECT count(*)::int n FROM bb_model_call_attempts a JOIN bb_jobs j ON j.id=a.job_id WHERE j.run_id=$1 AND a.status='pending_reconcile'",[uncertain.run_id])).rows[0].n,1);
  assert.deepEqual(await creditBalance(pool,owner),{available:520,frozen:240});
  assert.equal(await execute(),'idle');assert.equal(calls,9,'the unknown provider attempt is not resent');
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_jobs WHERE run_id=$1 AND (lease_token IS NOT NULL OR lease_until IS NOT NULL)',[uncertain.run_id])).rows[0].n,0);
 }finally{await app.close();await pool.end();await BlobServiceClient.fromConnectionString(storage!).getContainerClient(container).deleteIfExists();}
});
