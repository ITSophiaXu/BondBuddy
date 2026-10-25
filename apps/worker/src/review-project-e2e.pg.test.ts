// Synthetic model findings; real HTTP handlers, PG queue, private blobs and trusted Word exporter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { BlobServiceClient } from '@azure/storage-blob';
import { createServer } from '@bondbuddy/api';
import { azureBlobs,digest } from '@bondbuddy/api/data';
import { isolatedTestDatabase } from './test-database.js';
import { makeWorkerDocxFixture } from './docx-test-fixture.js';
import { inputLockStage,materialsReadyStage,runPipelineOnce } from './run-pipeline.js';
import { historicalWordDeliveryStage } from './historical-word-stage.js';
import { reviewFileStage,loadReviewFileInput } from './review-file-stage.js';
import { correctionFiles } from './review-correction-stage.js';
import {grantCredits,publishPrices} from '../../api/dist/billing.js';
import {INITIAL_FIXED_PRICES} from '@bondbuddy/contracts';
import {transaction} from '@bondbuddy/api/data';

const connection=await isolatedTestDatabase(undefined,'review-project-e2e'),storage=process.env.BB_TEST_AZURITE_CONNECTION_STRING;
test('project review: real dual Word delivery, explicit promotion, manual export, idempotency and owner isolation',{skip:!connection||!storage||!process.env.BONDBUDDY_TEST_PYTHON,timeout:240000},async()=>{
  const pool=new Pool({connectionString:connection}),user=randomUUID(),container='bb-review-e2e-'+randomUUID().replaceAll('-','');let owner=user;
  const blobs=azureBlobs(storage!,container),origin='http://bondbuddy.test';
  const app=createServer({pool,blobs,allowedOrigin:origin,enableRunRuntime:true,enablePaidReview:true,principal:async()=>({userId:owner,csrfVerified:true})});
  app.addHook('onError',async(_r,_p,e)=>{if(!(e as any).status)process.stderr.write(e.message+'\n');});
  const send=(method:string,url:string,payload?:unknown)=>app.inject({method:method as any,url,payload:payload as any,headers:{origin,...(Buffer.isBuffer(payload)?{'content-type':'application/octet-stream'}:{})}});
  const ok=async(method:string,url:string,payload?:unknown)=>{const r=await send(method,url,payload);assert.ok(r.statusCode<300,r.body);return r.body?r.json():null;};
  try{
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[user,'rv_'+randomUUID().replaceAll('-','').slice(0,12)]);
    await transaction(pool,c=>grantCredits(c,{owner:user,source:'existing_grant',key:randomUUID(),points:1000000,expiresAt:null,actor:'synthetic',reason:'isolated paid review delivery test'}));
    await publishPrices(pool,{id:'synthetic-review-pair',prices:{...INITIAL_FIXED_PRICES,full_review:300,differential_review:100},effectiveAt:'2026-01-01T00:00:00Z',actor:'synthetic',reason:'isolated paid review test prices'});
    const p=await ok('POST','/api/v1/projects',{kind:'generation',name:'Synthetic cross-kind review',issuer_name:'Synthetic issuer',market:'sse',offering:'private'}),path='/api/v1/projects/'+p.project_id;
    assert.equal((await ok('POST',path+'/review-entry',{})).project_id,p.project_id);
    const bytes=makeWorkerDocxFixture({externalLink:false}),declaration={byte_size:bytes.length,sha256:digest(bytes)};
    const upload=await ok('POST',path+'/materials/uploads',{...declaration,filename:'synthetic.docx',media_type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',role:'historical'});
    assert.equal((await send('PUT',upload.upload_url,bytes)).statusCode,204);
    const m=await ok('POST',path+'/materials/uploads/'+upload.upload_id+'/complete',declaration),pin={material_id:m.material_id,material_version:m.material_version,sha256:m.sha256};
    const versions=await ok('GET',path+'/prospectus-versions');assert.equal(versions.versions.length,1);
    const select={request_id:randomUUID(),expected_selection_revision:0,version_id:versions.versions[0].version_id};
    const selection=await ok('POST',path+'/prospectus-versions/current',select);
    await ok('PUT',path+'/review-draft',{kind:'input',expected_version:0,input:{source_material_ref:pin,material_versions:[pin],requirements:['synthetic test'],as_of:null}});
    const baseRequest={execution_request_id:randomUUID(),operation:'full_review',expected_input_version:1,source_report_id:null,expected_plan_version:null,finding_ids:[]};
    const quote=await ok('POST',path+'/review-executions/quote',baseRequest);
    const request={...baseRequest,quote_id:quote.quote.quote_id};
    const first=await ok('POST',path+'/review-executions',request);assert.equal((await ok('POST',path+'/review-executions',request)).run_id,first.run_id);
    const markdown='## 格式与标点\n### 合成文本修订\n- 复核类别：格式与标点\n- 问题说明：合成修改\n- 原文披露：Synthetic worker upload fixture\n- 核对依据：合成依据\n- 处理方式：直接修改\n- 替换文本：Synthetic reviewed fixture\n- 缺少材料：无\n';
    const execute=(model:any)=>runPipelineOnce({pool,blobs,leaseSeconds:120,stages:[inputLockStage,materialsReadyStage,model,historicalWordDeliveryStage()],onUnexpectedError:e=>assert.fail(JSON.stringify(e))});
    assert.equal(await execute({name:'model_generation',run:async(ctx:any)=>({kind:'done',value:await correctionFiles(ctx,await loadReviewFileInput(ctx),Buffer.from(markdown))})}),'succeeded');
    const ws=await ok('GET',path+'/review-workspace');assert.equal(ws.project.kind,'generation');assert.deepEqual(ws.artifacts.map((a:any)=>a.kind).sort(),['clean','report','revision']);
    const charge=await ok('GET','/api/v1/runs/'+first.run_id+'/credit-charge');assert.equal(charge.state,'settled');
    assert.equal(charge.progress.charged_points,quote.quote.points,'paid pair completes the existing settlement policy');
    for(const a of ws.artifacts){const meta=await ok('GET','/api/v1/artifacts/'+a.artifact_id);const file=await send('GET',meta.download_url);assert.equal(file.statusCode,200);assert.equal(digest(file.rawPayload),meta.sha256);}
    const v2=await ok('GET',path+'/prospectus-versions');assert.equal(v2.versions.length,2);assert.equal(v2.current_version_id,selection.current_version_id,'review must not auto-select');
    const generated=v2.versions.find((v:any)=>v.run_id===first.run_id);
    const imported=await ok('POST',path+'/review-source',{version_id:generated.version_id});assert.equal(imported.sha256,generated.sha256);
    assert.equal((await ok('POST',path+'/review-source',{version_id:generated.version_id})).material_id,imported.material_id);
    const editor=await ok('GET',path+'/review-executions/'+first.run_id+'/editor');assert.equal(editor.snapshot.issues[0].applied,true);
    const exportRequest={request_id:randomUUID(),source_run_id:first.run_id,expected_editor_sha256:editor.sha256,decisions:editor.snapshot.issues.map((i:any)=>({id:i.id,decision:'manual',manual_text:'Manually corrected fixture'}))};
    assert.equal((await send('POST',path+'/review-exports',{...exportRequest,expected_editor_sha256:'0'.repeat(64)})).statusCode,409);
    const exported=await ok('POST',path+'/review-exports',exportRequest);assert.equal((await ok('POST',path+'/review-exports',exportRequest)).run_id,exported.run_id);
    const exporting=await ok('GET',path+'/review-workspace');
    assert.equal(exporting.timeline.find((e:any)=>e.kind==='task'&&e.task.run.run_id===exported.run_id).task.export_only,true,'refresh retains deterministic export identity');
    assert.equal((await send('POST',path+'/review-exports',{...exportRequest,decisions:[]})).statusCode,409);
    assert.equal(await execute(reviewFileStage()),'succeeded');
    const after=await ok('GET',path+'/review-executions/'+exported.run_id+'/editor');assert.equal(after.snapshot.issues[0].manual_text,'Manually corrected fixture');assert.equal(after.snapshot.issues[0].applied,true);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts a JOIN bb_jobs j ON j.id=a.job_id WHERE j.run_id=$1',[exported.run_id])).rows[0].n,0,'manual export has no model call');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_credit_reservations WHERE run_id=$1',[exported.run_id])).rows[0].n,0,'manual export reserves no credits');
    assert.equal((await pool.query('SELECT billing_mode FROM bb_runs WHERE id=$1',[exported.run_id])).rows[0].billing_mode,'platform_trial');
    const final=await ok('GET',path+'/prospectus-versions');assert.equal(final.versions.length,3);assert.equal(final.current_version_id,selection.current_version_id);
    await ok('POST',path+'/prospectus-versions/current',{request_id:randomUUID(),version_id:final.versions[0].version_id,expected_selection_revision:final.selection_revision});
    const update=await ok('POST',path+'/update-workspace',{});
    const updateVersions=await ok('GET','/api/v1/projects/'+update.update_project_id+'/prospectus-versions');
    assert.equal(updateVersions.versions.find((v:any)=>v.version_id===updateVersions.current_version_id).sha256,final.versions[0].sha256,'manual review promotion carries into update workspace');
    // A provider can finish after its first progress message. The collector must
    // preserve that evidence and fail delivery, without publishing an unchanged pair.
    const incompleteRequest={...baseRequest,execution_request_id:randomUUID()};
    const incompleteQuote=await ok('POST',path+'/review-executions/quote',incompleteRequest);
    const incomplete=await ok('POST',path+'/review-executions',{...incompleteRequest,quote_id:incompleteQuote.quote.quote_id});
    assert.equal(await execute(reviewFileStage({model:options=>({name:options.name,run:async()=>{
      const directory=await mkdtemp(join(tmpdir(),'review-progress-only-'));
      try{
        await options.fileWorkspace!.prepare(directory);
        return {kind:'done',value:await options.fileWorkspace!.collect(directory,{call_id:'synthetic-progress-only'} as never,{text:'BB_REVIEW_PROGRESS:read_materials:started'})};
      }finally{await rm(directory,{recursive:true,force:true});}
    }})})),'failed');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_review_artifacts WHERE run_id=$1',[incomplete.run_id])).rows[0].n,0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_review_editors WHERE run_id=$1',[incomplete.run_id])).rows[0].n,0);
    const preserved=await ok('GET',path+'/review-workspace');assert.equal(preserved.artifact_run.run_id,exported.run_id,'failed review preserves previous successful artifacts');
    owner=randomUUID();assert.equal((await send('GET',path+'/review-executions/'+first.run_id+'/editor')).statusCode,404);assert.equal((await send('POST',path+'/review-exports',{...exportRequest,request_id:randomUUID()})).statusCode,404);assert.equal((await send('POST',path+'/review-source',{version_id:generated.version_id})).statusCode,404);
  }finally{await app.close();await BlobServiceClient.fromConnectionString(storage!).getContainerClient(container).deleteIfExists();await pool.end();}
});
