// SYNTHETIC materials/model. Real API, PostgreSQL, private Blob, Word delivery, leases and accounting.
// The model seam uses the durable journal but does not spawn Codex or call a supplier.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp,mkdir,readFile,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { BlobServiceClient } from '@azure/storage-blob';
import { createServer } from '@bondbuddy/api';
import { azureBlobs,digest,transaction } from '@bondbuddy/api/data';
import { savePromptSnapshot } from '@bondbuddy/api/log-ops';
import { checkpointStage,resumePausedRun,action } from '@bondbuddy/api/queue';
import { publishM4BillingConfig,type M4BillingConfig } from '@bondbuddy/api/m4-billing';
import { grantCredits,creditBalance } from '../../api/dist/billing.js';
import { M4_BILLING_TASKS,type M4MaterialPin,type M4Artifact } from '@bondbuddy/contracts';
import { loadCodexAdapterConfig } from './codex-adapter.js';
import type { ProviderUsage } from '@bondbuddy/api/provider-results';
import { CodexDurableJournal } from './durable-probe-journal.js';
import { isolatedTestDatabase } from './test-database.js';
import { makeWorkerDocxFixture } from './docx-test-fixture.js';
import { defaultRunStages,runPipelineOnce,type RunPipelineDependencies,type StageContext,type codexModelStage } from './run-pipeline.js';
import { m4DocumentStage } from './m4-document-stage.js';
import { m4QaStage } from './m4-qa-stage.js';
import { loadM4WorkerInput } from './m4-input.js';
import { modelGenerationRouter } from './model-generation-router.js';
import { historicalWordDeliveryStage } from './historical-word-stage.js';

const database=await isolatedTestDatabase(undefined,'m4-pipeline'),connection=process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const python=process.env.BONDBUDDY_TEST_PYTHON??'python3',root=resolve(fileURLToPath(import.meta.url),'../../../..');
const usage:ProviderUsage={status:'measured',input_tokens:1000,cached_input_tokens:0,output_tokens:100,reasoning_tokens:0,total_tokens:1100};
test('synthetic M4 document and QA pipeline: real deliveries/capped metering, crash reuse, unknown-usage reconciliation and semantic execution',
  {skip:!database||!connection,timeout:180000},async()=>{
  const pool=new Pool({connectionString:database}),base=resolve(tmpdir()),directory=await mkdtemp(join(base,'bb-m4-pg-'));
  const container=`bb-m4-${randomUUID().replaceAll('-','')}`,blobs=azureBlobs(connection!,container),owner=`m4pg-${randomUUID()}`;let actor=owner;
  const app=createServer({pool,blobs,allowedOrigin:'http://bondbuddy.test',principal:async()=>({userId:actor,csrfVerified:true}),enableSyntheticQueue:true});
  const send=(method:string,url:string,payload?:unknown)=>app.inject({method:method as never,url,payload:payload as never,headers:{origin:'http://bondbuddy.test'}});
  const ok=async(method:string,url:string,payload?:unknown)=>{const response=await send(method,url,payload);assert.equal(response.statusCode,200,response.body);return response.json();};
  let modelCalls=0,unknown=false;
  const config={...loadCodexAdapterConfig({}),model_id:'synthetic-m4-model',model_config_version:'synthetic-m4-config'};
  const syntheticModel:typeof codexModelStage=options=>({name:options.name,replay:true,run:async(ctx:StageContext)=>{
    const gate=await ctx.validateBeforeModelCall?.();if(gate)return gate;
    const journal=new CodexDurableJournal({pool,blobs,lease:ctx.lease,validateResult:options.validate});
    const prior=await journal.latestAttempt(options.logicalCallId);
    if(prior){assert.equal(prior.status,'completed');const saved=await journal.readCompleted(options.logicalCallId,prior.attempt_no);assert.ok(saved);
      return {kind:'done',value:saved.value,checkpoint:{logical_call_id:options.logicalCallId,synthetic_model:true}};}
    const snapshotVersion=Number((await pool.query("SELECT COALESCE(max(version),0)+1 AS version FROM bb_snapshot_refs WHERE owner_user_id=$1 AND project_id=$2 AND snapshot_kind='model_request'",[owner,ctx.run.project_id])).rows[0].version);
    const snapshot=await savePromptSnapshot(pool,blobs,{owner,projectId:ctx.run.project_id,runId:ctx.run.id,kind:'model_request',version:snapshotVersion,
      body:await options.buildPrompt(ctx),inputRevision:ctx.run.input_revision,inputHash:ctx.run.input_hash,templateVersion:options.templateVersion});
    await checkpointStage(pool,ctx.lease,'synthetic_m4_prompt',{snapshot_id:snapshot,synthetic_model:true});
    const intent={owner_user_id:owner,project_id:ctx.run.project_id,job_id:ctx.lease.jobId,run_id:ctx.run.id,trace_id:ctx.run.id,
      logical_call_id:options.logicalCallId,call_id:randomUUID(),attempt_no:1,model_id:config.model_id,model_config_version:config.model_config_version,prompt_snapshot_ref:snapshot};
    const cwd=join(directory,intent.call_id);await mkdir(cwd,{mode:0o700});
    assert.ok(options.fileWorkspace);await options.fileWorkspace.prepare(cwd);await journal.recordIntent(intent);modelCalls++;
    const task=JSON.parse(await readFile(join(cwd,'input.json'),'utf8')).task;
    if(task.kind==='qa'){
      const proposal=task.execution_proposal;
      await writeFile(join(cwd,'output/reply.json'),JSON.stringify({content:'SYNTHETIC M4 answer; no professional acceptance.',citations:[],requirements:[],fields:{},
        intent:proposal?'execute':'answer',document_type:proposal?.document_type??null,target_business:null,retrieval:'not_performed'}));
    }else{
      // Actual editable paragraphs and native tables; synthetic text is explicitly marked in both artifacts.
      await promisify(execFile)(python,['-B','-c',`from pathlib import Path\nfrom docx import Document\np=Path(${JSON.stringify(cwd)})/'output'\nfor name,title in [('document.docx','SYNTHETIC M4 summary'),('preparation-note.docx','SYNTHETIC preparation note')]:\n d=Document();d.add_heading(title,0);d.add_paragraph('Synthetic only; no professional acceptance.');t=d.add_table(rows=2,cols=2);t.cell(0,0).text='Item';t.cell(0,1).text='Amount';t.cell(1,0).text='Assets';t.cell(1,1).text='100';d.save(p/name)\n`],{cwd:root,timeout:30000});
    }
    const value=await options.fileWorkspace.collect(cwd,intent,{text:'Synthetic file authoring complete'});
    const ref=await journal.storeResult(intent,Buffer.from(JSON.stringify(value)),options.resultSchemaVersion);
    await journal.recordObservation({...intent,...ref,provider_request_id:null,finish_reason:'stop',outcome:unknown?'pending_reconcile':'completed',
      usage:unknown?{status:'unknown',input_tokens:null,cached_input_tokens:null,output_tokens:null,reasoning_tokens:null,total_tokens:null}:usage,error_code:unknown?'MODEL_USAGE_PENDING':null});
    return {kind:'done',value,checkpoint:{logical_call_id:options.logicalCallId,synthetic_model:true}};
  }});
  const pipeline=(afterStage?:RunPipelineDependencies['afterStage'])=>runPipelineOnce({pool,blobs,leaseSeconds:60,
    runKinds:['generation','qa'],stages:defaultRunStages({model_generation:modelGenerationRouter({m4Document:m4DocumentStage({config,model:syntheticModel}),m4Qa:m4QaStage({config,model:syntheticModel})}),word_delivery:historicalWordDeliveryStage()}),
    afterStage,onUnexpectedError:error=>assert.fail(JSON.stringify(error))});
  try{
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,`synthetic_m4pg_${randomUUID().slice(0,8)}`]);
    const sourceProject=randomUUID();await pool.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind,issuer_name,market,offering) VALUES($1,$2,'Synthetic source','update','Synthetic issuer','sse','private')`,[sourceProject,owner]);
    const source=makeWorkerDocxFixture({externalLink:false}),material=randomUUID(),upload=randomUUID(),key=`users/${owner}/projects/${sourceProject}/synthetic-source.docx`;
    await blobs.put(key,source,'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
      VALUES($1,$2,$3,'synthetic-source.docx',$4,$5,$6,'other',$7,now()+interval '1 hour','completed')`,[upload,owner,sourceProject,'application/vnd.openxmlformats-officedocument.wordprocessingml.document',source.length,digest(source),key]);
    await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES($1,1,$2,$3,$4,'other','synthetic-source.docx',$5,$6,$7,$8,'persisted')`,[material,owner,sourceProject,upload,'application/vnd.openxmlformats-officedocument.wordprocessingml.document',source.length,digest(source),key]);
    const pin:M4MaterialPin={source_project_id:sourceProject,material_id:material,material_version:1,sha256:digest(source)};
    const topic=(await ok('POST','/api/v1/m4/topics',{creation_request_id:randomUUID(),name:'Synthetic M4 pipeline',source_project_id:sourceProject})).topic;
    const path=(suffix:string)=>`/api/v1/m4/topics/${topic.topic_id}/${suffix}`;
    const optionalBrokerTemplate=(await ok('POST','/api/v1/m4/templates',{creation_request_id:randomUUID(),name:'Synthetic private summary template',broker:'',document_type:'private_summary',market:'sse',material:pin})).template;
    const template={template_id:optionalBrokerTemplate.template_id,template_version:optionalBrokerTemplate.template_version,sha256:optionalBrokerTemplate.sha256};
    await ok('PUT',path('drafts/private_summary'),{expected_version:0,input:{document_type:'private_summary',source_material:pin,materials:[pin],template,edit_base:null,scope:'whole',fields:{issuer_name:'Synthetic issuer',market:'sse'},requirements:[]}});
    const rate={input_microyuan_per_million:1000000,cached_microyuan_per_million:1000000,output_microyuan_per_million:2000000};
    const cost:M4BillingConfig={model_id:config.model_id,rates:{[config.model_id]:rate},budgets:Object.fromEntries(Object.keys(M4_BILLING_TASKS).map(k=>[k,{input_tokens:1000000,output_tokens:1000000,reserve_factor:1.2}])) as M4BillingConfig['budgets']};
    await transaction(pool,c=>grantCredits(c,{owner,source:'purchase',key:'synthetic-m4-fund',points:1,expiresAt:null,actor:'synthetic-test',reason:'synthetic-only'}));
    const start=async()=>{const q=await ok('POST',path('quote'),{kind:'document',document_type:'private_summary',expected_draft_version:1});
      const request={execution_request_id:randomUUID(),document_type:'private_summary',expected_draft_version:1,quote_id:q.quote.quote_id,entrypoint:'workspace'};
      const r=(await ok('POST',path('execute'),request)).run;assert.equal((await ok('POST',path('execute'),request)).run.run_id,r.run_id);return {r,q};};
    const verifyPendingReading=async(artifact:M4Artifact)=>{
      const pin={source_project_id:artifact.source_project_id,artifact_id:artifact.artifact_id,artifact_version:artifact.artifact_version,sha256:artifact.sha256};
      const content='解释当前成果的主要信息',context={document_type:null,draft_version:0,source_material:null,citations:[],reading_artifact:pin};
      const quote=await ok('POST',path('quote'),{kind:'qa',content,context});
      const reading=(await ok('POST',path('messages'),{submission_request_id:randomUUID(),content,context,quote_id:quote.quote.quote_id})).run;
      const readRun=(await pool.query('SELECT * FROM bb_runs WHERE id=$1',[reading.run_id])).rows[0],ctx={pool,run:readRun,
        lease:{owner,runId:readRun.id,executionVersion:1,inputRevision:readRun.input_revision,inputHash:readRun.input_hash.trim()}} as StageContext;
      const loaded=await loadM4WorkerInput(ctx);assert.equal(loaded.artifacts.length,1);assert.deepEqual(loaded.artifacts[0].pin,pin);
      if(artifact.kind==='qa_text')assert.match(loaded.artifacts[0].bodyContent!,/SYNTHETIC M4 answer/);
      await assert.rejects(loadM4WorkerInput({...ctx,run:{...readRun,owner_user_id:randomUUID()}}),/INPUT_REVISION_CONFLICT/);
      if(artifact.kind==='qa_text'){
        await assert.rejects(pool.query("UPDATE bb_artifact_versions SET delivery_status='revoked' WHERE id=$1 AND version=$2",[pin.artifact_id,pin.artifact_version]),
          error=>(error as {code?:string}).code==='23514','text cannot bypass its exact available delivery-evidence guard');
      }else{
        await pool.query("UPDATE bb_artifact_versions SET delivery_status='revoked' WHERE id=$1 AND version=$2",[pin.artifact_id,pin.artifact_version]);
        await assert.rejects(loadM4WorkerInput(ctx),/INPUT_REVISION_CONFLICT/);
        await pool.query("UPDATE bb_artifact_versions SET delivery_status='available' WHERE id=$1 AND version=$2",[pin.artifact_id,pin.artifact_version]);
      }
      assert.equal((await loadM4WorkerInput(ctx)).artifacts[0].pin.sha256,pin.sha256);
      const bad=await send('POST',path('quote'),{kind:'qa',content,context:{...context,reading_artifact:{...pin,sha256:'0'.repeat(64)}}});assert.equal(bad.statusCode,404,bad.body);
      await action(pool,owner,reading.run_id,'cancel');
    };
    const first=await start();
    assert.equal(await pipeline(),'paused');assert.equal(modelCalls,0,'one point is consumed at the durable input checkpoint');
    await transaction(pool,c=>grantCredits(c,{owner,source:'purchase',key:'synthetic-partial-recharge',points:1000,expiresAt:null,actor:'synthetic-test',reason:'synthetic-only'}));
    assert.equal(await resumePausedRun(pool,owner,first.r.run_id,'credits_recharged'),true);
    await assert.rejects(pipeline(async stage=>{if(stage==='word_promoted')throw Error('SYNTHETIC_CRASH');}),/SYNTHETIC_CRASH/);
    assert.equal(modelCalls,1);await pool.query("UPDATE bb_jobs SET lease_until=now()-interval '1 second' WHERE run_id=$1",[first.r.run_id]);
    assert.equal(await pipeline(),'paused');assert.equal(modelCalls,1,'completed durable result was reused after crash');
    assert.equal((await pool.query('SELECT stage FROM bb_runs WHERE id=$1',[first.r.run_id])).rows[0].stage,'credits_exhausted');
    assert.equal((await ok('GET',path('workspace'))).artifacts.length,0,'saved files remain private until the locked price is settled');
    const savedPair=(await pool.query('SELECT artifact_id FROM bb_m4_artifacts WHERE run_id=$1 ORDER BY kind',[first.r.run_id])).rows;
    assert.equal(savedPair.length,2);
    await transaction(pool,c=>grantCredits(c,{owner,source:'purchase',key:'synthetic-final-recharge',points:100000,expiresAt:null,actor:'synthetic-test',reason:'synthetic-only'}));
    assert.equal(await resumePausedRun(pool,owner,first.r.run_id,'credits_recharged'),true);
    assert.equal(await pipeline(),'succeeded');assert.equal(modelCalls,1,'final payment reuses saved model result');
    assert.deepEqual((await pool.query('SELECT artifact_id FROM bb_m4_artifacts WHERE run_id=$1 ORDER BY kind',[first.r.run_id])).rows,savedPair);
    const workspace=await ok('GET',path('workspace')),artifacts=workspace.artifacts.filter((a:{run_id:string})=>a.run_id===first.r.run_id);
    assert.deepEqual(artifacts.map((a:{kind:string})=>a.kind).sort(),['document','preparation_note']);
    for(const artifact of artifacts){const file=await send('GET',`/api/v1/m4/artifacts/${artifact.artifact_id}/versions/${artifact.artifact_version}/bytes`);
      assert.equal(file.statusCode,200,file.body);assert.equal(digest(file.rawPayload),artifact.sha256);
      const preview=await ok('GET',`/api/v1/m4/artifacts/${artifact.artifact_id}/versions/${artifact.artifact_version}/preview`);assert.match(preview.content,/SYNTHETIC/);assert.match(preview.content,/Assets \| 100/);}
    assert.equal((await pool.query(`SELECT count(*)::int n FROM bb_word_delivery_evidence WHERE run_id=$1 AND delivery_code='readback_verified'`,[first.r.run_id])).rows[0].n,2);
    const paid=(await pool.query('SELECT state,charged_points,points FROM bb_credit_reservations WHERE run_id=$1',[first.r.run_id])).rows[0];
    assert.equal(paid.state,'settled');assert.equal(Number(paid.charged_points),4500);assert.equal(Number(paid.points),4500);assert.equal((await creditBalance(pool,owner)).frozen,0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_m4_billing_configs')).rows[0].n,0,'document delivery works without cost configuration');
    await publishM4BillingConfig(pool,{id:'synthetic-m4-pipeline-rates',config:cost,effective_at:'2026-01-01T00:00:00Z',actor:'synthetic-test',reason:'synthetic-only'});
    actor=randomUUID();assert.equal((await send('GET',`/api/v1/m4/artifacts/${artifacts[0].artifact_id}/versions/1/bytes`)).statusCode,404);actor=owner;
    unknown=true;const pending=await start();assert.equal(await pipeline(),'succeeded');assert.equal(modelCalls,2);
    assert.equal((await pool.query('SELECT state FROM bb_runs WHERE id=$1',[pending.r.run_id])).rows[0].state,'succeeded');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_m4_artifacts WHERE run_id=$1',[pending.r.run_id])).rows[0].n,2,'fixed price requires both real files, independent of token reporting');
    const pendingWorkspace=await ok('GET',path('workspace'));
    await verifyPendingReading(pendingWorkspace.artifacts.find((a:M4Artifact)=>a.run_id===pending.r.run_id&&a.kind==='document'));
    const unknownUsage=(await pool.query('SELECT a.usage_status FROM bb_model_call_attempts a JOIN bb_jobs j ON j.id=a.job_id WHERE j.run_id=$1',[pending.r.run_id])).rows[0];
    assert.equal(unknownUsage.usage_status,'unknown','unknown supplier usage is retained, never invented for fixed settlement');
    assert.equal(Number((await pool.query('SELECT charged_points FROM bb_credit_reservations WHERE run_id=$1',[pending.r.run_id])).rows[0].charged_points),4500);
    assert.equal(Number((await pool.query("SELECT sum(points) n FROM bb_credit_events WHERE run_id=$1 AND kind='settle'",[pending.r.run_id])).rows[0].n),4500);
    assert.equal((await creditBalance(pool,owner)).frozen,0);
    // Pure QA follows the same durable pipeline but delivers authenticated text without any Word promotion.
    const context={document_type:null,draft_version:0,source_material:pin,citations:[],reading_artifact:null};
    const content='解释材料中负债的概念',qaQuote=await ok('POST',path('quote'),{kind:'qa',content,context});
    const qaRun=(await ok('POST',path('messages'),{submission_request_id:randomUUID(),content,context,quote_id:qaQuote.quote.quote_id})).run;
    assert.equal(await pipeline(),'paused');assert.equal(modelCalls,3);
    assert.equal((await pool.query('SELECT state FROM bb_runs WHERE id=$1',[qaRun.run_id])).rows[0].state,'settlement_pending');
    const qaWorkspace=await ok('GET',path('workspace')),textArtifact=qaWorkspace.artifacts.find((a:{run_id:string})=>a.run_id===qaRun.run_id);
    assert.equal(textArtifact.kind,'qa_text');
    await verifyPendingReading(textArtifact);
    const exported=await send('GET',`/api/v1/m4/artifacts/${textArtifact.artifact_id}/versions/1/bytes`);
    assert.equal(exported.statusCode,200,exported.body);assert.match(exported.body,/SYNTHETIC M4 answer/);assert.equal(digest(exported.rawPayload),textArtifact.sha256);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_word_delivery_evidence WHERE run_id=$1',[qaRun.run_id])).rows[0].n,0);
    assert.equal(await resumePausedRun(pool,owner,qaRun.run_id,'provider_reconciled'),false);
    const qaAttempt=(await pool.query('SELECT a.id FROM bb_model_call_attempts a JOIN bb_jobs j ON j.id=a.job_id WHERE j.run_id=$1',[qaRun.run_id])).rows[0].id;
    await pool.query(`INSERT INTO bb_usage_observations(id,owner_user_id,attempt_id,source,source_event_id,usage_status,input_tokens,cached_input_tokens,output_tokens,reasoning_tokens)
      VALUES($1,$2,$3,'provider','synthetic-reconciled-usage','measured',1000,0,100,0)`,[randomUUID(),owner,qaAttempt]);
    assert.equal(await resumePausedRun(pool,owner,qaRun.run_id,'provider_reconciled'),true);assert.equal(await pipeline(),'succeeded');assert.equal(modelCalls,3);
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_credit_events WHERE run_id=$1 AND kind='settle'",[qaRun.run_id])).rows[0].n,1);
    // A natural execution message is understood by QA once; only the API creates the priced document task.
    unknown=false;
    const semanticQuote=await ok('POST',path('quote'),{kind:'document',document_type:'private_summary',expected_draft_version:1});
    const semanticRequest={submission_request_id:randomUUID(),content:'资料已确认，请按照当前输入开始制作私募摘要。',
      context:{...context,document_type:'private_summary',draft_version:1},quote_id:semanticQuote.quote.quote_id,execute:true};
    const semanticRun=(await ok('POST',path('messages'),semanticRequest)).run;assert.equal(semanticRun.billing_mode,'platform_trial');
    assert.equal(await pipeline(),'succeeded');assert.equal(modelCalls,4);
    const semanticWorkspace=await ok('GET',path('workspace')),queued=semanticWorkspace.tasks.filter((t:{manifest:{kind:string};run:{state:string}})=>t.manifest.kind==='document'&&t.run.state==='queued');
    assert.equal(queued.length,1);assert.equal(queued[0].manifest.input.document_type,'private_summary');
    assert.equal(await pipeline(),'succeeded');assert.equal(modelCalls,5);
    assert.equal((await ok('POST',path('messages'),semanticRequest)).run.run_id,semanticRun.run_id);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_credit_reservations WHERE quote_id=$1',[semanticQuote.quote.quote_id])).rows[0].n,1);
    assert.equal((await creditBalance(pool,owner)).frozen,0);
  }finally{
    await app.close();await pool.end();
    assert.ok(directory.startsWith(base+(process.platform==='win32'?'\\':'/')));
    const cleanup=await Promise.allSettled([BlobServiceClient.fromConnectionString(connection!).getContainerClient(container).deleteIfExists(),rm(directory,{recursive:true,force:true})]);
    const failures=cleanup.filter((result):result is PromiseRejectedResult=>result.status==='rejected').map(result=>result.reason);
    if(failures.length)throw new AggregateError(failures,'Synthetic M4 pipeline cleanup failed');
  }
});
