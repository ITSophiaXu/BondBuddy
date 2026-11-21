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
import {CodexDurableJournal} from './durable-probe-journal.js';
import {inputLockStage,materialsReadyStage,runPipelineOnce,codexModelStage} from './run-pipeline.js';
import {projectQaModelStage,projectQaDeliveryStage,groundedQaAnswer} from './project-qa-stage.js';
import {projectFilesRoot} from './project-file-tools.js';
import {loadCodexAdapterConfig} from './codex-adapter.js';
const database=await isolatedTestDatabase(undefined,'project-qa-e2e'),storage=process.env.BB_TEST_AZURITE_CONNECTION_STRING;
test('project Q&A: free extraction, confirmed count, grounded Word, knowledge review, versions, billing and ownership',{skip:!database||!storage||!process.env.BONDBUDDY_TEST_PYTHON,timeout:300000},async()=>{
 const pool=new Pool({connectionString:database}),owner=randomUUID(),other=randomUUID(),container='bb-qa-'+randomUUID().replaceAll('-','');let actor=owner,calls=0,fail=false,pauseOnce=true,failQuestion='';
 const blobs=azureBlobs(storage!,container),origin='http://bondbuddy.test',app=createServer({pool,blobs,historicalBillingFixture:true,allowedOrigin:origin,enableRunRuntime:true,principal:async()=>({userId:actor,csrfVerified:true})});
 const send=(method:string,url:string,payload?:unknown)=>app.inject({method:method as any,url,payload:payload as any,headers:{origin,...(Buffer.isBuffer(payload)?{'content-type':'application/octet-stream'}:{})}});
 const ok=async(method:string,url:string,payload?:unknown)=>{const r=await send(method,url,payload);assert.ok(r.statusCode<300,method+' '+url+' '+r.body);return r.body?r.json():null;};
 const model:typeof codexModelStage=o=>({name:o.name,replay:true,run:async ctx=>{
  const gate=await ctx.validateBeforeModelCall?.();if(gate)return gate;if(fail)return {kind:'fail',code:'SYNTHETIC_PROVIDER_FAILED'};
  if(o.logicalCallId===failQuestion)return {kind:'fail',code:'MODEL_OUTPUT_SCHEMA_INVALID'};
  if(pauseOnce){
   const frozen=(await pool.query('SELECT manifest FROM bb_project_qa_runs WHERE run_id=$1',[ctx.run.id])).rows[0].manifest as QaInput;
   if(o.logicalCallId==='qa-'+frozen.questions[1]?.id){pauseOnce=false;return {kind:'pause',stage:'capability_not_ready',reason:'synthetic_checkpoint_pause'};}
  }
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
  // A valid supplementary Word without extractable text must not erase the
  // readable adopted prospectus or silently disappear from the delivered gaps.
  execFileSync(process.env.BONDBUDDY_TEST_PYTHON!,['-c','from docx import Document; import sys; Document().save(sys.argv[1])',join(dir,'synthetic-unreadable-attachment.docx')]);
  const upload=async(filename:string,role='other')=>{const bytes=await readFile(join(dir,filename)),decl={byte_size:bytes.length,sha256:digest(bytes)},u=await ok('POST',path+'/materials/uploads',{...decl,filename,role:filename==='synthetic-materials.docx'?'historical':role,media_type:filename.endsWith('.pdf')?'application/pdf':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'});await ok('PUT',u.upload_url,bytes);const m=await ok('POST',path+'/materials/uploads/'+u.upload_id+'/complete',decl);return {kind:'material' as const,pin:{source_project_id:p.project_id,material_id:m.material_id,material_version:m.material_version,sha256:m.sha256}};};
  const source=await upload('synthetic-questions.docx'),material=await upload('synthetic-materials.docx'),unreadableAttachment=await upload('synthetic-unreadable-attachment.docx'),request={request_id:randomUUID(),source};
  const prep=await ok('POST',base+'/prepare',request);assert.equal((await ok('POST',base+'/prepare',request)).run_id,prep.run_id);assert.equal(await execute(),'succeeded');assert.equal(calls,0);assert.deepEqual(await creditBalance(pool,owner),{available:1000,frozen:0});
  let w=await ok('GET',base) as QaWorkspace,prepared=w.runs[0];assert.equal(prepared.result!.questions.length,3);assert.equal(prepared.artifact_id,null);assert.equal(w.prospectus,null);
  const questions=[{...prepared.result!.questions[0],end:prepared.result!.questions[1].end,question:prepared.result!.questions[0].question+'\n'+prepared.result!.questions[1].question},prepared.result!.questions[2]];
  const draft={preparation_id:prep.run_id,questions,materials:[material,unreadableAttachment],requirements:'合成测试，逐题标注依据和缺失材料',use_knowledge:true};
  assert.equal((await send('POST',base+'/draft',{expected_revision:0,draft:{...draft,questions:[{...questions[0],question:'篡改问题'}]}})).statusCode,422);
  w=await ok('POST',base+'/draft',{expected_revision:0,draft});assert.equal((await send('POST',base+'/draft',{expected_revision:0,draft})).statusCode,409);
  const blocked=await send('POST',base+'/runs',{request_id:randomUUID(),expected_revision:1,expected_points:'120',price_version:PROJECT_QA_PRICE.version});
  assert.equal(blocked.statusCode,422);assert.equal(blocked.json().code,'INPUT_REQUIRED');
  assert.deepEqual(await creditBalance(pool,owner),{available:1000,frozen:0});assert.equal(calls,0);
  const savedProspectus=await ok('POST',path+'/prospectus-versions',{request_id:randomUUID(),expected_selection_revision:0,material_id:material.pin.material_id,material_version:material.pin.material_version,sha256:material.pin.sha256});
  await ok('POST',path+'/prospectus-versions/current',{request_id:randomUUID(),expected_selection_revision:savedProspectus.selection_revision,version_id:savedProspectus.versions[0].version_id});
  assert.equal((await ok('GET',base)).prospectus.asset.pin.sha256,material.pin.sha256);
  w=await ok('POST',base+'/draft',{expected_revision:w.revision,draft:{...draft,materials:[]}});
  assert.equal((await send('POST',base+'/runs',{request_id:randomUUID(),expected_revision:w.revision,expected_points:'120',price_version:PROJECT_QA_PRICE.version})).statusCode,422);
  assert.deepEqual(await creditBalance(pool,owner),{available:1000,frozen:0});assert.equal(calls,0);
  w=await ok('POST',base+'/draft',{expected_revision:w.revision,draft});
  const content={title:'合成公募用途案例',url:'https://example.com/synthetic-public-case',topic:'募集资金用途',question:'请说明募集资金用途',answer:'公开回复合成样例，不是真实发行人事实。',approach:'先说明用途，再核对债务金额与发行规模。',evidence_requirements:'募集书与债务明细。'},caseReq={request_id:randomUUID(),content};
  let cases=await ok('POST','/api/v1/qa/cases',caseReq);assert.equal(cases.cases[0].status,'pending');const caseId=cases.cases[0].id;
  assert.equal((await send('POST',`/api/v1/qa/cases/${caseId}/review`,{expected_revision:1,status:'approved',review_note:'合成来源仅供测试'})).statusCode,403);
  actor=other;assert.equal((await ok('GET','/api/v1/qa/cases')).cases.length,0);assert.equal((await send('GET',base)).statusCode,404);assert.equal((await send('POST',base+'/prepare',request)).statusCode,404);actor=owner;
  await pool.query("INSERT INTO bb_qa_case_reviewers(user_id,actor,reason) VALUES($1,'synthetic','synthetic test reviewer')",[owner]);
  cases=await ok('POST',`/api/v1/qa/cases/${caseId}/review`,{expected_revision:1,status:'approved',review_note:'核对合成来源与用途问题。仅测试用途。'});assert.equal(cases.cases[0].status,'approved');
  const submit={request_id:randomUUID(),expected_revision:w.revision,expected_points:'120',price_version:PROJECT_QA_PRICE.version};
  assert.equal((await send('POST',base+'/runs',{...submit,expected_points:'60'})).statusCode,409);
  const run=await ok('POST',base+'/runs',submit);assert.equal((await ok('POST',base+'/runs',submit)).run_id,run.run_id);assert.deepEqual(await creditBalance(pool,owner),{available:880,frozen:120});
  await ok('POST',`/api/v1/qa/cases/${caseId}/review`,{expected_revision:2,status:'withdrawn',review_note:'测试后撤回；已锁定任务保留快照。'});
  assert.equal(await execute(),'paused');assert.equal(calls,1);assert.equal((await pool.query('SELECT count(*) n FROM bb_project_qa_answers WHERE run_id=$1',[run.run_id])).rows[0].n,'1');
  const savedBeforeResume=(await pool.query('SELECT answer,sha256 FROM bb_project_qa_answers WHERE run_id=$1 AND question_id=$2',[run.run_id,questions[0].id])).rows[0];assert.ok(savedBeforeResume);
  assert.deepEqual(await creditBalance(pool,owner),{available:880,frozen:120});
  await ok('POST','/api/v1/runs/'+run.run_id+'/resume',{reason:'synthetic checkpoint resume'});
  assert.equal(await execute(),'succeeded');assert.equal(calls,2,'completed question is reused on resume');assert.deepEqual(await creditBalance(pool,owner),{available:880,frozen:0});
  assert.deepEqual((await pool.query('SELECT answer,sha256 FROM bb_project_qa_answers WHERE run_id=$1 AND question_id=$2',[run.run_id,questions[0].id])).rows[0],savedBeforeResume,'resume preserves the completed answer and its hash');
  const attempts=(await pool.query('SELECT a.logical_call_id,count(*)::int attempts FROM bb_model_call_attempts a JOIN bb_jobs j ON j.id=a.job_id AND j.owner_user_id=a.owner_user_id WHERE j.run_id=$1 GROUP BY a.logical_call_id ORDER BY a.logical_call_id',[run.run_id])).rows;
  assert.deepEqual(attempts,questions.map(q=>({logical_call_id:'qa-'+q.id,attempts:1})).sort((a,b)=>a.logical_call_id.localeCompare(b.logical_call_id)),'each question has one durable model intent across pause/resume');
  w=await ok('GET',base);const answered=w.runs[0];assert.equal(answered.result!.answers.length,2);assert.equal(answered.result!.answers[0].status,'draft');assert.equal(answered.result!.answers[1].status,'missing');assert.equal(answered.charged_points,'120');assert.equal(answered.manifest.cases[0].id,caseId);
  assert.deepEqual(answered.manifest.materials.map(m=>m.asset),[material,unreadableAttachment],'one paid run pins both readable and unreadable attachments');
  assert.deepEqual(answered.manifest.prospectus!.asset,material,'the mandatory adopted prospectus remains readable');
  const readableEvidence=answered.result!.evidence[0],unreadableEvidence=answered.result!.evidence[1],usableAnswer=answered.result!.answers[0];
  assert.equal(answered.result!.evidence.length,2);assert.equal(readableEvidence.filename,'synthetic-materials.docx');assert.equal(readableEvidence.snapshot.sha256,material.pin.sha256);
  assert.equal(unreadableEvidence.filename,'synthetic-unreadable-attachment.docx');assert.equal(unreadableEvidence.snapshot.sha256,unreadableAttachment.pin.sha256);assert.equal(unreadableEvidence.snapshot.coverage,'partial');assert.ok(unreadableEvidence.snapshot.spans.every(s=>!s.text.trim()));
  assert.ok(answered.result!.warnings.some(w=>w.includes(unreadableEvidence.filename)&&w.includes('没有可提取的文字')),'the unreadable attachment has a named extraction gap');
  assert.match(usableAnswer.answer,/5 亿元/);assert.ok(usableAnswer.citations.length>0&&usableAnswer.citations.every(c=>c.asset_index===0&&readableEvidence.snapshot.spans.some(s=>s.id===c.span_id&&s.text.includes(c.quote))),'usable answers retain verifiable citations to the readable material');
  assert.ok(answered.result!.answers[1].missing_materials.some(m=>m.includes('回款计划')));assert.deepEqual(answered.result!.answers[1].citations,[]);
  const mixedSettlement=(await pool.query("SELECT count(*)::int count,coalesce(sum(points),0)::int points FROM bb_credit_events WHERE owner_user_id=$1 AND run_id=$2 AND kind='settle'",[owner,run.run_id])).rows[0];assert.deepEqual(mixedSettlement,{count:1,points:120},'resume settles the confirmed two-question scope once, with no attachment surcharge');
  const replayCounts=async()=>(await pool.query('SELECT (SELECT count(*)::int FROM bb_runs WHERE owner_user_id=$1) runs,(SELECT count(*)::int FROM bb_credit_events WHERE owner_user_id=$1) credit_events',[owner])).rows[0];
  const beforeCompletedReplay=await replayCounts();assert.equal((await ok('POST',base+'/runs',submit)).run_id,run.run_id);assert.deepEqual(await replayCounts(),beforeCompletedReplay,'completed-request replay adds no run or credit event');assert.deepEqual(await creditBalance(pool,owner),{available:880,frozen:0});assert.equal(calls,2);
  const ungrounded=groundedQaAnswer({...answered.result!.answers[0],citations:[{asset_index:0,span_id:'p1',quote:'这条引文不存在'}],case_ids:['not-approved']},questions[0],answered.manifest,answered.result!.evidence);
  assert.equal(ungrounded.status,'missing');assert.equal(ungrounded.citations.length,0);assert.equal(ungrounded.case_ids.length,0);assert.doesNotMatch(ungrounded.answer,/5 亿元/);
  assert.equal((await pool.query("SELECT count(*) n FROM bb_outbox WHERE aggregate_type='qa_case'")).rows[0].n,'3');
  const a=await ok('GET','/api/v1/artifacts/'+answered.artifact_id),bytes=(await send('GET',a.download_url)).rawPayload;assert.equal(digest(bytes),a.sha256);assert.match(a.filename,/已回填回答/);await writeFile(join(dir,'synthetic-filled-round-1.docx'),bytes);
  const text=execFileSync(process.env.BONDBUDDY_TEST_PYTHON!,['-c','import io,sys,zipfile; from lxml import etree; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); print("".join(etree.fromstring(z.read("word/document.xml")).itertext()))'],{input:bytes,encoding:'utf8',env:{...process.env,PYTHONIOENCODING:'utf-8'}});assert.match(text,/待补材料/);assert.match(text,/回款计划/);assert.match(text,/本期募集资金 5 亿元全部用于偿还有息债务/);assert.match(text,/回答依据问题 1.*synthetic-materials\.docx/);assert.doesNotMatch(text,/参考公开案例|合成公募用途案例|https:\/\/example.com\/synthetic-public-case/);
  assert.deepEqual(answered.result!.answers[0].case_ids,[caseId]);assert.equal(answered.result!.answers[0].citations[0].quote,'本期发行规模为人民币 5 亿元，募集资金全部用于偿还有息债务。');
  actor=other;assert.equal((await send('GET',a.download_url)).statusCode,404);actor=owner;
  assert.equal((await ok('GET',path+'/tasks')).items[0].operation,'qa_answer');assert.equal((await ok('GET','/api/v1/credits/consumption-history')).items[0].task_name,'项目问答');assert.equal((await ok('GET',path+'/files')).items.filter((f:any)=>f.folder==='4.2').length,1);
  const again=await ok('POST',base+'/runs',{...submit,request_id:randomUUID()});assert.equal(await execute(),'succeeded');w=await ok('GET',base);assert.equal(w.runs[0].manifest.cases.length,0,'withdrawn case excluded from new run');assert.notEqual(w.runs[0].artifact_id,answered.artifact_id);assert.equal(digest((await send('GET',a.download_url)).rawPayload),a.sha256);
  const a2=await ok('GET','/api/v1/artifacts/'+w.runs[0].artifact_id);await writeFile(join(dir,'synthetic-filled-round-2.docx'),(await send('GET',a2.download_url)).rawPayload);
  const versions=(await ok('GET',path+'/files')).items.filter((f:any)=>f.folder==='4.2');assert.equal(versions.length,2);assert.ok(versions.every((f:any)=>f.version_count===2));
  const cancel=await ok('POST',base+'/runs',{...submit,request_id:randomUUID()});await ok('POST','/api/v1/runs/'+cancel.run_id+'/cancel',{reason:'synthetic cancellation'});assert.deepEqual(await creditBalance(pool,owner),{available:760,frozen:0});
  fail=true;await ok('POST',base+'/runs',{...submit,request_id:randomUUID()});assert.equal(await execute(),'failed');assert.deepEqual(await creditBalance(pool,owner),{available:760,frozen:0});
  await assert.rejects(pool.query("UPDATE bb_project_qa_runs SET manifest='{}' WHERE run_id=$1",[run.run_id]),/immutable/);
  // PDF follows the same real upload -> free preparation -> pinned draft ->
  // wallet/worker -> private Word download pipeline. Only model replies are synthetic.
  fail=false;const callsBeforePdf=calls;
  execFileSync(process.env.BONDBUDDY_TEST_PYTHON!,['-c','from pathlib import Path; import sys,runpy; runpy.run_path("python/tests/test_project_qa.py")["pdf_fixture"](Path(sys.argv[1]),["1. What is the funding purpose?", ""])',join(dir,'synthetic-questions.pdf')],{cwd:projectFilesRoot,env:{...process.env,PYTHONPATH:join(projectFilesRoot,'python')}});
  const pdf=await upload('synthetic-questions.pdf'),pdfPrep=await ok('POST',base+'/prepare',{request_id:randomUUID(),source:pdf});
  assert.equal(await execute(),'succeeded');assert.equal(calls,callsBeforePdf);assert.deepEqual(await creditBalance(pool,owner),{available:760,frozen:0});
  w=await ok('GET',base);const pdfPrepared=w.runs.find(r=>r.run_id===pdfPrep.run_id)!;
  assert.equal(pdfPrepared.manifest.source.asset.pin.sha256,pdf.pin.sha256);assert.equal(pdfPrepared.result!.questions.length,1);
  assert.ok(pdfPrepared.result!.warnings.some(w=>w.includes('第 2 页无法提取文字')));
  w=await ok('POST',base+'/draft',{expected_revision:w.revision,draft:{preparation_id:pdfPrep.run_id,questions:pdfPrepared.result!.questions,materials:[material],requirements:'合成 PDF 测试',use_knowledge:false}});
  const pdfRun=await ok('POST',base+'/runs',{request_id:randomUUID(),expected_revision:w.revision,expected_points:'60',price_version:PROJECT_QA_PRICE.version});
  assert.equal(await execute(),'succeeded');assert.equal(calls,callsBeforePdf+1);assert.deepEqual(await creditBalance(pool,owner),{available:700,frozen:0});
  w=await ok('GET',base);const pdfAnswer=w.runs.find(r=>r.run_id===pdfRun.run_id)!,pdfArtifact=await ok('GET','/api/v1/artifacts/'+pdfAnswer.artifact_id),pdfWord=(await send('GET',pdfArtifact.download_url)).rawPayload;
  assert.equal(digest(pdfWord),pdfArtifact.sha256);await writeFile(join(dir,'synthetic-pdf-answered.docx'),pdfWord);
  const pdfText=execFileSync(process.env.BONDBUDDY_TEST_PYTHON!,['-c','import io,sys; from docx import Document; print("\\n".join(p.text for p in Document(io.BytesIO(sys.stdin.buffer.read())).paragraphs))'],{input:pdfWord,encoding:'utf8',env:{...process.env,PYTHONIOENCODING:'utf-8'}});
  assert.match(pdfText,/What is the funding purpose/);assert.match(pdfText,/本期募集资金 5 亿元全部用于偿还有息债务/);assert.doesNotMatch(pdfText,/参考公开案例/);assert.match(pdfText,/第 2 页无法提取文字/);
  // An unreadable mandatory prospectus fails before a model call and releases the reservation.
  execFileSync(process.env.BONDBUDDY_TEST_PYTHON!,['-c','from docx import Document; import sys; Document().save(sys.argv[1])',join(dir,'synthetic-empty-prospectus.docx')]);
  const blank=await upload('synthetic-empty-prospectus.docx','historical'),current=await ok('GET',path+'/prospectus-versions');
  await ok('POST',path+'/prospectus-versions',{request_id:randomUUID(),expected_selection_revision:current.selection_revision,material_id:blank.pin.material_id,material_version:blank.pin.material_version,sha256:blank.pin.sha256});
  w=await ok('GET',base);w=await ok('POST',base+'/draft',{expected_revision:w.revision,draft:{...w.draft,materials:[blank]}});
  const beforeUnreadable=await creditBalance(pool,owner),callsBeforeUnreadable=calls;
  const unreadable=await ok('POST',base+'/runs',{request_id:randomUUID(),expected_revision:w.revision,expected_points:String(w.draft.questions.length*60),price_version:PROJECT_QA_PRICE.version});
  assert.equal(await execute(),'failed');assert.equal(calls,callsBeforeUnreadable);assert.deepEqual(await creditBalance(pool,owner),beforeUnreadable);
  const failed=(await ok('GET',base)).runs.find((r:any)=>r.run_id===unreadable.run_id);assert.equal(failed.error_code,'MATERIAL_UNREADABLE');assert.equal(failed.artifact_id,null);
  // A later question failing must not cause completed answers to be regenerated
  // on an unchanged, explicitly submitted retry. Original failure/credits remain.
  const selection=await ok('GET',path+'/prospectus-versions');
  await ok('POST',path+'/prospectus-versions/current',{request_id:randomUUID(),expected_selection_revision:selection.selection_revision,version_id:savedProspectus.versions[0].version_id});
  w=await ok('GET',base);w=await ok('POST',base+'/draft',{expected_revision:w.revision,draft:{...draft,use_knowledge:false}});
  const retrySubmit={request_id:randomUUID(),expected_revision:w.revision,expected_points:'120',price_version:PROJECT_QA_PRICE.version};
  const beforeRetry=await creditBalance(pool,owner),callsBeforeRetry=calls;
  failQuestion='qa-'+questions[1].id;
  const partial=await ok('POST',base+'/runs',retrySubmit);assert.equal(await execute(),'failed');assert.equal(calls,callsBeforeRetry+1);
  assert.deepEqual(await creditBalance(pool,owner),beforeRetry);
  const partialAnswers=(await pool.query('SELECT answer,sha256 FROM bb_project_qa_answers WHERE run_id=$1',[partial.run_id])).rows;
  assert.equal(partialAnswers.length,1);
  // Provider observation failures can record only the event code, as in the incident.
  await pool.query('UPDATE bb_jobs SET error_code=NULL WHERE run_id=$1',[partial.run_id]);
  assert.equal((await ok('GET',base)).runs.find((r:any)=>r.run_id===partial.run_id).error_code,'MODEL_OUTPUT_SCHEMA_INVALID');
  failQuestion='';
  const retry=await ok('POST',base+'/runs',{...retrySubmit,request_id:randomUUID()});assert.equal(await execute(),'succeeded');
  assert.equal(calls,callsBeforeRetry+2,'only the unfinished question calls the model again');
  const retryAnswers=(await pool.query('SELECT answer,sha256 FROM bb_project_qa_answers WHERE run_id=$1 ORDER BY question_id',[retry.run_id])).rows;
  assert.equal(retryAnswers.length,2);assert.ok(retryAnswers.some(a=>a.sha256===partialAnswers[0].sha256));
  const retryJob=(await pool.query('SELECT checkpoint FROM bb_jobs WHERE run_id=$1',[retry.run_id])).rows[0];
  assert.equal(Object.values(retryJob.checkpoint.stages).filter((v:any)=>v.source_run_id===partial.run_id).length,1);
  assert.equal((await pool.query('SELECT state FROM bb_runs WHERE id=$1',[partial.run_id])).rows[0].state,'failed');
  assert.equal((await pool.query("SELECT count(*) n FROM bb_credit_events WHERE run_id=$1 AND kind='settle'",[partial.run_id])).rows[0].n,'0');
  assert.deepEqual(await creditBalance(pool,owner),{available:beforeRetry.available-120,frozen:0});
  const retried=(await ok('GET',base)).runs.find((r:any)=>r.run_id===retry.run_id),retryArtifact=await ok('GET','/api/v1/artifacts/'+retried.artifact_id);
  assert.equal(digest((await send('GET',retryArtifact.download_url)).rawPayload),retryArtifact.sha256);
  w=await ok('GET',base);w=await ok('POST',base+'/draft',{expected_revision:w.revision,draft:{...draft,use_knowledge:false,requirements:'合成测试，新增要求必须重新作答'}});
  const changed=await ok('POST',base+'/runs',{...retrySubmit,request_id:randomUUID(),expected_revision:w.revision});
  assert.equal(await execute(),'succeeded');assert.equal(calls,callsBeforeRetry+4,'changed requirements cannot reuse old partial answers');
  const changedJob=(await pool.query('SELECT checkpoint FROM bb_jobs WHERE run_id=$1',[changed.run_id])).rows[0];
  assert.equal(Object.values(changedJob.checkpoint.stages).filter((v:any)=>v.source_run_id).length,0);
 }finally{await app.close();await pool.end();await BlobServiceClient.fromConnectionString(storage!).getContainerClient(container).deleteIfExists();}
});
