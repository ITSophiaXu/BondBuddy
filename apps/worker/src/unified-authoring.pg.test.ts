// Synthetic model responses; real API, PostgreSQL, Blob, parser, Word writer and download checks.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { latestProviderAttempt } from '@bondbuddy/api/provider-results';
import { Pool } from 'pg';
import { BlobServiceClient } from '@azure/storage-blob';
import { createServer } from '@bondbuddy/api';
import { azureBlobs, digest } from '@bondbuddy/api/data';
import { emptyUpdateDetails, type SourceProspectus } from '@bondbuddy/contracts';
import { isolatedTestDatabase } from './test-database.js';
import { makeWorkerDocxFixture } from './docx-test-fixture.js';
import { runMaterialParseOnce } from './material-parse-job.js';
import { runDocumentParser } from './document-parser.js';
import { inputLockStage, materialsReadyStage, runPipelineOnce, type StageContext } from './run-pipeline.js';
import { unifiedModelGenerationStage } from './unified-model-stage.js';
import { unifiedWordDeliveryStage } from './unified-word-stage.js';
import { loadCodexAdapterConfig } from './codex-adapter.js';

const database = await isolatedTestDatabase(undefined,'unified-authoring');
const connection = process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const origin = 'http://bondbuddy.test';
const live=process.env.BB_TEST_LIVE_AUTHORING==='1';
const periods = [{start:'2025-01-01',end:'2025-12-31',period_kind:'annual' as const,scope:'consolidated' as const,status:'user_asserted' as const,evidence_refs:[]}];

test(`unified API → real parsing → ${live?'real provider on synthetic materials':'synthetic model'} → real Word pair, immutable requirements, previous output and owner isolation`,
  {skip:!database || !connection,timeout:live?900000:180000},async()=>{
    const pool = new Pool({connectionString:database});
    const container = `bb-unified-${randomUUID().replaceAll('-','')}`;
    const blobs = azureBlobs(connection!,container);
    const owner = `unified-${randomUUID()}`;
    let active = owner;
    const app = createServer({pool,blobs,allowedOrigin:origin,principal:async()=>({userId:active,csrfVerified:true}),enableSyntheticQueue:true});
    const send = (method:string,url:string,payload?:unknown,headers:Record<string,string>={})=>app.inject({method:method as any,url,
      headers:{origin,...headers},payload:payload as any});
    try {
      await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,`unified_${randomUUID().slice(0,8)}`]);
      for(const scenario of (live?['same_issuer']:[null,'same_issuer','parent','subsidiary','similar_business','absent_metadata','partial_metadata']) as (null|'same_issuer'|'parent'|'subsidiary'|'similar_business'|'absent_metadata'|'partial_metadata')[]){
        const missingMetadata=scenario==='absent_metadata'||scenario==='partial_metadata';
        const relation=missingMetadata?null:scenario;
        const created=await send('POST','/api/v1/projects',{kind:'update',name:`Synthetic unified ${relation}`,issuer_name:'合成目标发行人',market:'sse',offering:'private',
          update_details:{...emptyUpdateDetails(),authoring_mode:'unified_v1',target_reporting_periods:periods}});
        assert.equal(created.statusCode,201,created.body);
        const project=created.json().project_id;
        const refs:{material_id:string;material_version:number}[]=[];
        let source:SourceProspectus|undefined;
        for(const role of missingMetadata?['historical']:relation?['historical','audit']:['audit']){
          const bytes=role==='historical'?makeWorkerDocxFixture({externalLink:false}):Buffer.from('合成目标发行人：2025年净资产120万元；无新增对外担保。');
          const media=role==='historical'?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'text/plain';
          const declaration={byte_size:bytes.length,sha256:digest(bytes)};
          const upload=await send('POST',`/api/v1/projects/${project}/materials/uploads`,{...declaration,filename:`synthetic.${role==='historical'?'docx':'txt'}`,media_type:media,role});
          assert.equal(upload.statusCode,201,upload.body);
          assert.equal((await send('PUT',upload.json().upload_url,bytes,{'content-type':'application/octet-stream'})).statusCode,204);
          const complete=await send('POST',`/api/v1/projects/${project}/materials/uploads/${upload.json().upload_id}/complete`,declaration);
          assert.equal(complete.statusCode,200,complete.body);
          refs.push({material_id:complete.json().material_id,material_version:1});
          if(role==='historical') source={...refs.at(-1)!,sha256:declaration.sha256,issuer_name:relation==='same_issuer'?'合成目标发行人':'合成参考企业',
            relation,market:'szse',offering:'public_all',reporting_periods:periods,status:'user_asserted'};
          if(scenario==='absent_metadata')source=undefined;
          if(scenario==='partial_metadata'&&source)source={...source,issuer_name:null,relation:null,market:null,offering:null,reporting_periods:[]};
          assert.equal(await runMaterialParseOnce({pool,material:{pool,blobs:{getPrivate:key=>blobs.getIfExists(key)},
            parser:request=>runDocumentParser(request,{pythonExecutable:process.env.BONDBUDDY_TEST_PYTHON??'python3'})}}),'succeeded');
        }
        const details={...created.json().update_details,source_prospectuses:source?[source]:[]};
        const patched=await send('PATCH',`/api/v1/projects/${project}`,{update_details:details},{'if-match':'1'});
        assert.equal(patched.statusCode,200,patched.body);
        const message={message_id:randomUUID(),submission_request_id:randomUUID(),expected_message_version:null,body:'合成要求：明确2025年信息，缺项标待确认。',material_versions:[]};
        const saved=await send('POST',`/api/v1/projects/${project}/messages`,message);
        assert.equal(saved.statusCode,201,saved.body);
        const lock=async()=>{
          const messagePage=await send('GET',`/api/v1/projects/${project}/messages`);
          assert.equal(messagePage.statusCode,200,messagePage.body);
          const messages=messagePage.json().project_message_set_ref;
          const response=await send('POST',`/api/v1/projects/${project}/input-revisions`,{draft_revision:2,material_versions:refs,
            requirement_message_ids:messages.message_ids,project_message_set_ref:messages});
          assert.equal(response.statusCode,201,response.body);return response.json();
        };
        const input=await lock();
        const manifest=(await pool.query('SELECT manifest FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',[owner,project,input.input_revision])).rows[0].manifest;
        assert.equal(manifest.issuer_name,'合成目标发行人');
        assert.deepEqual(manifest.authoring.source_prospectuses,source?[source]:[]);
        assert.equal(manifest.authoring.requirements[0].message_version,1);
        assert.ok(manifest.authoring.knowledge[0].path.includes('sse-private'));
        assert.equal(manifest.authoring.previous_output,undefined);
        const start=async(locked:any)=>{
          const request={execution_request_id:`unified-${project}-${locked.input_revision}`,project_id:project,input_revision:locked.input_revision,input_hash:locked.input_hash,
            task_kind:'update',input_manifest_ref:'server-input',storage_origin:'cloud',workspace_id:'synthetic'};
          const responses=await Promise.all([send('POST','/api/v1/runs/execute',request),send('POST','/api/v1/runs/execute',request)]);
          for(const r of responses)assert.equal(r.statusCode,202,r.body);
          assert.equal(responses[0].json().run_id,responses[1].json().run_id);
          assert.equal(responses[0].json().channel,'production');return responses[0].json();
        };
        const run=await start(input);
        // A later edit never mutates the already locked requirement body.
        assert.equal((await send('POST',`/api/v1/projects/${project}/messages`,{...message,submission_request_id:randomUUID(),expected_message_version:1,body:'合成后续要求：下一轮才生效。'})).statusCode,201);
        let modelCalls=0;
        const model=unifiedModelGenerationStage({direct:true,...(live?{config:loadCodexAdapterConfig()}:{model:options=>({name:options.name,run:async(ctx:StageContext)=>{
          // Exercise the real durable-journal boundary even though model replies are synthetic.
          assert.equal(await latestProviderAttempt(pool,ctx.lease,options.logicalCallId),null);
          const prompt=await options.buildPrompt(ctx);
          const data=JSON.parse(prompt.split('输入数据：\n')[1]!);
          if(data.requirements)assert.deepEqual(data.requirements,[run.input_revision===ctx.run.input_revision?message.body:'合成后续要求：下一轮才生效。']);
          modelCalls++;
          const value=options.name.includes('read_')?{notes:[{text:'合成目标发行人2025年净资产120万元',evidence:[data.records[0].id],pending:false}]}:
            options.name.includes('outline')?{chapters:['合成财务会计信息']}:
            options.name.includes('draft_')?{blocks:[{kind:'heading',text:'合成财务会计信息',rows:[],evidence:['target'],pending:[]},
              {kind:'paragraph',text:'合成目标发行人2025年净资产120万元。',rows:[],evidence:['target'],pending:[]}],summary:['合成编制'] }:
              {reviewed:data.records.map((r:any)=>r.id),edits:[{record_id:data.records[0].id,after:`合成目标发行人2025年净资产120万元，第${ctx.run.input_revision}轮。`,evidence:['target'],pending:[]}],additions:[],summary:['合成更新']};
          assert.ok(options.validate(value));return {kind:'done',value};
        }})})});
        const execute=async()=>runPipelineOnce({pool,blobs,stages:[inputLockStage,materialsReadyStage,model,unifiedWordDeliveryStage()],
          onUnexpectedError:error=>assert.fail(JSON.stringify(error))});
        assert.equal(await execute(),'succeeded');
        if(!live)assert.ok(modelCalls>0);
        else {
          const calls=(await pool.query('SELECT logical_call_id,outcome,usage_status,total_tokens FROM bb_provider_call_observations WHERE run_id=$1',[run.run_id])).rows;
          assert.ok(calls.length>0);assert.ok(calls.every(c=>c.outcome==='completed'&&c.usage_status==='measured'&&c.total_tokens>0));
          console.log(JSON.stringify({synthetic_materials:true,real_provider:true,calls}));
        }
        const delivered=(await send('GET',`/api/v1/runs/${run.run_id}`)).json();
        assert.equal(delivered.state,'succeeded');
        const artifact=(await send('GET',`/api/v1/artifacts/${delivered.artifact_id}`)).json();
        assert.equal(artifact.word_delivery.baseline_kind,relation||missingMetadata?'uploaded_source':'none');
        for(const variant of ['revision','clean']){
          const file=(await send('GET',`/api/v1/artifacts/${artifact.word_delivery[`${variant}_artifact_id`]}`)).json();
          const response=await send('GET',file.download_url);
          assert.equal(response.statusCode,200,response.body);assert.equal(digest(response.rawPayload),file.sha256);
        }
        if(!relation&&!missingMetadata){
          const next=await lock();
          const pin=(await pool.query('SELECT manifest FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',[owner,project,next.input_revision])).rows[0].manifest.authoring.previous_output;
          assert.equal(pin.artifact_id,artifact.word_delivery.clean_artifact_id);
          const nextRun=await start(next);assert.equal(await execute(),'succeeded');
          const nextArtifact=(await send('GET',`/api/v1/artifacts/${(await send('GET',`/api/v1/runs/${nextRun.run_id}`)).json().artifact_id}`)).json();
          assert.equal(nextArtifact.word_delivery.baseline_kind,'project_output');
        }
        active=`other-${randomUUID()}`;
        assert.equal((await send('GET',`/api/v1/runs/${run.run_id}`)).statusCode,404);
        assert.equal((await send('GET',`/api/v1/artifacts/${delivered.artifact_id}`)).statusCode,404);
        active=owner;
      }
    }finally{await app.close();await pool.end();await BlobServiceClient.fromConnectionString(connection!).getContainerClient(container).deleteIfExists();}
  });
