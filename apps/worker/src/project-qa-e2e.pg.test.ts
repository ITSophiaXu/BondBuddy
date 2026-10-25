// Synthetic model replies; actual API, wallet, queue, private blobs, Python Word and download authorization.
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
import {CodexDurableJournal} from './durable-probe-journal.js';
import {inputLockStage,materialsReadyStage,runPipelineOnce,codexModelStage} from './run-pipeline.js';
import {projectQaModelStage,projectQaDeliveryStage,groundedQaAnswer} from './project-qa-stage.js';
import {projectFilesRoot} from './project-file-tools.js';
import {loadCodexAdapterConfig} from './codex-adapter.js';
const database=await isolatedTestDatabase(undefined,'project-qa-e2e'),storage=process.env.BB_TEST_AZURITE_CONNECTION_STRING;
test('project Q&A: free extraction, confirmed count, grounded Word, knowledge review, versions, billing and ownership',{skip:!database||!storage||!process.env.BONDBUDDY_TEST_PYTHON,timeout:300000},async()=>{
 const pool=new Pool({connectionString:database}),owner=randomUUID(),other=randomUUID(),container='bb-qa-'+randomUUID().replaceAll('-','');let actor=owner,calls=0,fail=false,pauseOnce=true;
 const blobs=azureBlobs(storage!,container),origin='http://bondbuddy.test',app=createServer({pool,blobs,allowedOrigin:origin,enableRunRuntime:true,principal:async()=>({userId:actor,csrfVerified:true})});
 const send=(method:string,url:string,payload?:unknown)=>app.inject({method:method as any,url,payload:payload as any,headers:{origin,...(Buffer.isBuffer(payload)?{'content-type':'application/octet-stream'}:{})}});
 const ok=async(method:string,url:string,payload?:unknown)=>{const r=await send(method,url,payload);assert.ok(r.statusCode<300,method+' '+url+' '+r.body);return r.body?r.json():null;};
 const model:typeof codexModelStage=o=>({name:o.name,replay:true,run:async ctx=>{
  const gate=await ctx.validateBeforeModelCall?.();if(gate)return gate;if(fail)return {kind:'fail',code:'SYNTHETIC_PROVIDER_FAILED'};
  if(pauseOnce&&calls===1){pauseOnce=false;return {kind:'pause',stage:'capability_not_ready',reason:'synthetic_checkpoint_pause'};}
  const journal=new CodexDurableJournal({pool,blobs,lease:ctx.lease,validateResult:o.validate}),old=await journal.latestAttempt(o.logicalCallId);
  if(old){const saved=await journal.readCompleted(o.logicalCallId,old.attempt_no);assert.ok(saved);return {kind:'done',value:saved.value};}
  // Exercise the real prompt snapshot/checkpoint path, stopping only at the provider gate.
  // Re-enter it to prove that a replay reuses the persisted prompt before the synthetic reply.
  let builds=0;
  const real=codexModelStage({...o,buildPrompt:async context=>{builds++;const prompt=await o.buildPrompt(context);assert.ok(prompt.includes('合成'));return prompt;}});
  for(let replay=0;replay<2;replay++){
   let gates=0;
   assert.deepEqual(await real.run({...ctx,validateBeforeModelCall:async()=>++gates===2?{kind:'fail',code:'SYNTHETIC_CHECKPOINT_ONLY'}:null}),{kind:'fail',code:'SYNTHETIC_CHECKPOINT_ONLY'});
   assert.equal(gates,2,'the actual checkpoint must succeed before reaching the provider gate');
  }
  assert.equal(builds,1,'replay reuses the prompt snapshot');
  const snapshot=ctx.checkpoint[o.name+'_prompt'].snapshot_id as string;
  assert.ok(snapshot);
  const persisted=(await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[ctx.lease.jobId])).rows[0].checkpoint;
  assert.equal(persisted.stages[o.name+'_prompt'].snapshot_id,snapshot);
  const intent={owner_user_id:owner,project_id:ctx.run.project_id,job_id:ctx.lease.jobId,run_id:ctx.run.id,trace_id:ctx.run.id,logical_call_id:o.logicalCallId,call_id:randomUUID(),attempt_no:1,model_id:'synthetic-qa',model_config_version:'synthetic-v1',prompt_snapshot_ref:snapshot};await journal.recordIntent(intent);calls++;
  const input=(await pool.query('SELECT manifest FROM bb_project_qa_runs WHERE run_id=$1',[ctx.run.id])).rows[0].manifest as QaInput,q=input.questions.find(q=>'qa-'+q.id===o.logicalCallId)!;
  const first=q===input.questions[0],value={question_id:q.id,answer:first?'本期募集资金 5 亿元全部用于偿还有息债务。':'请补充往来占款回收证据。',status:first?'draft':'missing',missing_materials:first?[]:['往来占款明细、回款计划与最近一期回款凭证。'],citations:first?[{asset_index:0,span_id:'p1',quote:'本期发行规模为人民币 5 亿元，募集资金全部用于偿还有息债务。'}]:[],case_ids:input.cases.map(c=>c.id),approach:'合成回答：说明事项、核对金额并列明证据要求。'};
  assert.ok(o.validate(value));const ref=await journal.storeResult(intent,Buffer.from(JSON.stringify(value)),o.resultSchemaVersion);await journal.recordObservation({...intent,...ref,provider_request_id:null,finish_reason:'stop',outcome:'completed',usage:{status:'measured',input_tokens:100,cached_input_tokens:0,output_tokens:20,reasoning_tokens:0,total_tokens:120},error_code:null});return {kind:'done',value};
 }});
 const stage=projectQaModelStage({model,config:()=>loadCodexAdapterConfig({})}),execute=()=>runPipelineOnce({pool,blobs,leaseSeconds:120,runKinds:['generation'],stages:[inputLockStage,materialsReadyStage,stage,projectQaDeliveryStage()],onUnexpectedError:e=>assert.fail(JSON.stringify(e))});
 try{
  for(const id of [owner,other])await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[id,'qa_'+id.slice(0,8)]);
  await transaction(pool,c=>grantCredits(c,{owner,source:'purchase',key:randomUUID(),points:1000,expiresAt:null,actor:'synthetic',reason:'qa test'}));
  const p=await ok('POST','/api/v1/projects',{kind:'generation',name:'合成问答测试项目',issuer_name:'合成发行人',market:'sse',offering:'public'}),path='/api/v1/projects/'+p.project_id,base=path+'/qa';
  const dir=process.env.BB_QA_TEST_OUTPUT_DIRECTORY!;await mkdir(dir,{recursive:true});
  execFileSync(process.env.BONDBUDDY_TEST_PYTHON!,['-c','from pathlib import Path; import sys; import runpy; runpy.run_path("python/tests/test_project_qa.py")["fixtures"](Path(sys.argv[1]))',dir],{cwd:projectFilesRoot,env:{...process.env,PYTHONPATH:join(projectFilesRoot,'python'),PYTHONIOENCODING:'utf-8'}});
  const upload=async(filename:string)=>{const bytes=await readFile(join(dir,filename)),decl={byte_size:bytes.length,sha256:digest(bytes)},u=await ok('POST',path+'/materials/uploads',{...decl,filename,role:'other',media_type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'});await ok('PUT',u.upload_url,bytes);const m=await ok('POST',path+'/materials/uploads/'+u.upload_id+'/complete',decl);return {kind:'material' as const,pin:{source_project_id:p.project_id,material_id:m.material_id,material_version:m.material_version,sha256:m.sha256}};};
  const source=await upload('synthetic-questions.docx'),material=await upload('synthetic-materials.docx'),request={request_id:randomUUID(),source};
  const prep=await ok('POST',base+'/prepare',request);assert.equal((await ok('POST',base+'/prepare',request)).run_id,prep.run_id);assert.equal(await execute(),'succeeded');assert.equal(calls,0);assert.deepEqual(await creditBalance(pool,owner),{available:1000,frozen:0});
  let w=await ok('GET',base) as QaWorkspace,prepared=w.runs[0];assert.equal(prepared.result!.questions.length,3);
  const questions=[{...prepared.result!.questions[0],end:prepared.result!.questions[1].end,question:prepared.result!.questions[0].question+'\n'+prepared.result!.questions[1].question},prepared.result!.questions[2]];
  const draft={preparation_id:prep.run_id,questions,materials:[material],requirements:'合成测试，逐题标注依据和缺失材料',use_knowledge:true};
  assert.equal((await send('POST',base+'/draft',{expected_revision:0,draft:{...draft,questions:[{...questions[0],question:'篡改问题'}]}})).statusCode,422);
  w=await ok('POST',base+'/draft',{expected_revision:0,draft});assert.equal((await send('POST',base+'/draft',{expected_revision:0,draft})).statusCode,409);
  const content={title:'合成公募用途案例',url:'https://example.com/synthetic-public-case',topic:'募集资金用途',question:'请说明募集资金用途',answer:'公开回复合成样例，不是真实发行人事实。',approach:'先说明用途，再核对债务金额与发行规模。',evidence_requirements:'募集书与债务明细。'},caseReq={request_id:randomUUID(),content};
  let cases=await ok('POST','/api/v1/qa/cases',caseReq);assert.equal(cases.cases[0].status,'pending');const caseId=cases.cases[0].id;
  assert.equal((await send('POST',`/api/v1/qa/cases/${caseId}/review`,{expected_revision:1,status:'approved',review_note:'合成来源仅供测试'})).statusCode,403);
  actor=other;assert.equal((await ok('GET','/api/v1/qa/cases')).cases.length,0);assert.equal((await send('GET',base)).statusCode,404);assert.equal((await send('POST',base+'/prepare',request)).statusCode,404);actor=owner;
  await pool.query("INSERT INTO bb_qa_case_reviewers(user_id,actor,reason) VALUES($1,'synthetic','synthetic test reviewer')",[owner]);
  cases=await ok('POST',`/api/v1/qa/cases/${caseId}/review`,{expected_revision:1,status:'approved',review_note:'核对合成来源与用途问题。仅测试用途。'});assert.equal(cases.cases[0].status,'approved');
  const submit={request_id:randomUUID(),expected_revision:1,expected_points:120,price_version:PROJECT_QA_PRICE.version};
  assert.equal((await send('POST',base+'/runs',{...submit,expected_points:60})).statusCode,409);
  const run=await ok('POST',base+'/runs',submit);assert.equal((await ok('POST',base+'/runs',submit)).run_id,run.run_id);assert.deepEqual(await creditBalance(pool,owner),{available:880,frozen:120});
  await ok('POST',`/api/v1/qa/cases/${caseId}/review`,{expected_revision:2,status:'withdrawn',review_note:'测试后撤回；已锁定任务保留快照。'});
  assert.equal(await execute(),'paused');assert.equal(calls,1);assert.equal((await pool.query('SELECT count(*) n FROM bb_project_qa_answers WHERE run_id=$1',[run.run_id])).rows[0].n,'1');
  assert.deepEqual(await creditBalance(pool,owner),{available:880,frozen:120});
  await ok('POST','/api/v1/runs/'+run.run_id+'/resume',{reason:'synthetic checkpoint resume'});
  assert.equal(await execute(),'succeeded');assert.equal(calls,2,'completed question is reused on resume');assert.deepEqual(await creditBalance(pool,owner),{available:880,frozen:0});
  w=await ok('GET',base);const answered=w.runs[0];assert.equal(answered.result!.answers.length,2);assert.equal(answered.result!.answers[0].status,'draft');assert.equal(answered.result!.answers[1].status,'missing');assert.equal(answered.charged_points,120);assert.equal(answered.manifest.cases[0].id,caseId);
  const ungrounded=groundedQaAnswer({...answered.result!.answers[0],citations:[{asset_index:0,span_id:'p1',quote:'这条引文不存在'}],case_ids:['not-approved']},questions[0],answered.manifest,answered.result!.evidence);
  assert.equal(ungrounded.status,'missing');assert.equal(ungrounded.citations.length,0);assert.equal(ungrounded.case_ids.length,0);assert.doesNotMatch(ungrounded.answer,/5 亿元/);
  assert.equal((await pool.query("SELECT count(*) n FROM bb_outbox WHERE aggregate_type='qa_case'")).rows[0].n,'3');
  const a=await ok('GET','/api/v1/artifacts/'+answered.artifact_id),bytes=(await send('GET',a.download_url)).rawPayload;assert.equal(digest(bytes),a.sha256);assert.match(a.filename,/已回填回答/);await writeFile(join(dir,'synthetic-filled-round-1.docx'),bytes);
  const text=execFileSync(process.env.BONDBUDDY_TEST_PYTHON!,['-c','import io,sys,zipfile; from lxml import etree; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); print("".join(etree.fromstring(z.read("word/document.xml")).itertext()))'],{input:bytes,encoding:'utf8',env:{...process.env,PYTHONIOENCODING:'utf-8'}});assert.match(text,/待补材料/);assert.match(text,/回款计划/);assert.match(text,/回答依据/);assert.match(text,/合成公募用途案例/);
  actor=other;assert.equal((await send('GET',a.download_url)).statusCode,404);actor=owner;
  assert.equal((await ok('GET',path+'/tasks')).items[0].operation,'qa_answer');assert.equal((await ok('GET','/api/v1/credits/consumption-history')).items[0].task_name,'项目问答');assert.equal((await ok('GET',path+'/files')).items.filter((f:any)=>f.folder==='4.2').length,1);
  const again=await ok('POST',base+'/runs',{...submit,request_id:randomUUID()});assert.equal(await execute(),'succeeded');w=await ok('GET',base);assert.equal(w.runs[0].manifest.cases.length,0,'withdrawn case excluded from new run');assert.notEqual(w.runs[0].artifact_id,answered.artifact_id);assert.equal(digest((await send('GET',a.download_url)).rawPayload),a.sha256);
  const a2=await ok('GET','/api/v1/artifacts/'+w.runs[0].artifact_id);await writeFile(join(dir,'synthetic-filled-round-2.docx'),(await send('GET',a2.download_url)).rawPayload);
  const versions=(await ok('GET',path+'/files')).items.filter((f:any)=>f.folder==='4.2');assert.equal(versions.length,2);assert.ok(versions.every((f:any)=>f.version_count===2));
  const cancel=await ok('POST',base+'/runs',{...submit,request_id:randomUUID()});await ok('POST','/api/v1/runs/'+cancel.run_id+'/cancel',{reason:'synthetic cancellation'});assert.deepEqual(await creditBalance(pool,owner),{available:760,frozen:0});
  fail=true;await ok('POST',base+'/runs',{...submit,request_id:randomUUID()});assert.equal(await execute(),'failed');assert.deepEqual(await creditBalance(pool,owner),{available:760,frozen:0});
  await assert.rejects(pool.query("UPDATE bb_project_qa_runs SET manifest='{}' WHERE run_id=$1",[run.run_id]),/immutable/);
 }finally{await app.close();await pool.end();await BlobServiceClient.fromConnectionString(storage!).getContainerClient(container).deleteIfExists();}
});
