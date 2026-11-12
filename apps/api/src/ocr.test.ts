import { uploadSyntheticReference, quoteSyntheticAuthoringRun } from './test-authoring-source.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { emptyUpdateDetails, type OcrEngineResponse, type OcrCorrectionRequest } from '@bondbuddy/contracts';
import { azureBlobs, digest, uid } from './data.js';
import { createServer } from './server.js';
import { storeOcr, validateOcrResponse, readOcr, correctOcr, authorizeOcrMaterial } from './ocr.js';
import { pngSample, PNG } from './upload-safety.samples.js';
import { isolatedTestDatabase } from './test-database.js';

const connection = await isolatedTestDatabase();

function response(materialId='material',requestId='request'):OcrEngineResponse {
  return {schema_version:'ocr-response-v1',request_id:requestId,processor_version:'synthetic-ocr-v1',engine_version:'synthetic-only',language:'eng',language_data_sha256:{eng:'a'.repeat(64)},purpose:'source_preflight',status:'needs_confirmation',
    material:{material_id:materialId,material_version:1,media_type:PNG,sha256:digest(pngSample)},page_count:1,coverage:'complete',
    pages:[{page:1,width:pngSample.readUInt32BE(16),height:pngSample.readUInt32BE(20),rotation_clockwise:0,coordinate_system:'rendered_pixels_top_left',image_sha256:digest(pngSample),image_base64:pngSample.toString('base64'),warnings:['synthetic_only']}],
    records:[{record_id:'p1-r1',page:1,bbox:[0,0,1,1],text:'(1,234.50)',confidence:.4,numeric:{kind:'number',decimal:'-1234.50',unit:null},cell:null,uncertainty:['critical_value_requires_confirmation'],eligible_for_manuscript:false}],warnings:['synthetic_only'],error:null,eligible_for_manuscript:false};
}
test('OCR validator rejects wrong identities, coordinates, edited pixels and certainty promotion',()=>{
  const value=response();const expected={materialId:'material',version:1,sha256:digest(pngSample),mediaType:PNG,requestId:'request',purpose:'source_preflight'};
  assert.equal(validateOcrResponse(value,expected).status,'needs_confirmation');
  for(const mutate of [
    (v:any)=>v.material.material_id='foreign',
    (v:any)=>v.records[0].eligible_for_manuscript=true,
    (v:any)=>v.records[0].bbox=[0,0,100000,100000],
    (v:any)=>v.pages[0].image_sha256='b'.repeat(64),
    (v:any)=>v.records.push(v.records[0]),
    (v:any)=>v.coverage='partial',
    (v:any)=>v.records[0].uncertainty=[]
  ]){const bad=structuredClone(value);mutate(bad);assert.throws(()=>validateOcrResponse(bad,expected));}
});

test('owned OCR snapshots and user corrections are immutable, replay-safe and private', {skip:!connection||!process.env.BB_TEST_AZURITE_CONNECTION_STRING},async()=>{
  const pool=new Pool({connectionString:connection});const blobs=azureBlobs(process.env.BB_TEST_AZURITE_CONNECTION_STRING!);
  const owner=uid();let active=owner;const origin='http://ocr.synthetic.test';
  const app=createServer({pool,blobs,allowedOrigin:origin,enableRunStaging:true,principal:async()=>({userId:active,csrfVerified:true})});
  const send=(method:any,url:string,payload?:any,extra={})=>app.inject({method,url,headers:{origin,...extra},payload});
  try {
    const created=await send('POST','/api/v1/projects',{name:'Synthetic OCR',kind:'update',issuer_name:'Synthetic OCR issuer',market:'sse',offering:'private',update_details:{...emptyUpdateDetails(),authoring_mode:'unified_v1',reporting_cutoff:'2026-09-30'}});assert.equal(created.statusCode,201,created.body);
    const projectId=created.json().project_id;
    const up=await send('POST',`/api/v1/projects/${projectId}/materials/uploads`,{filename:'synthetic.png',media_type:PNG,byte_size:pngSample.length,sha256:digest(pngSample),role:'audit'});assert.equal(up.statusCode,201,up.body);
    assert.equal((await send('PUT',up.json().upload_url,pngSample,{'content-type':'application/octet-stream'})).statusCode,204);
    const saved=await send('POST',`/api/v1/projects/${projectId}/materials/uploads/${up.json().upload_id}/complete`,{byte_size:pngSample.length,sha256:digest(pngSample)});assert.equal(saved.statusCode,200,saved.body);
    const materialId=saved.json().material_id,context={owner,projectId,materialId,version:1,requestId:uid(),purpose:'source_preflight' as const};
    const raw=response(materialId,context.requestId);
    const snapshotId=await storeOcr(pool,blobs,context,raw);assert.equal(await storeOcr(pool,blobs,context,raw),snapshotId);
    assert.equal((await pool.query("SELECT count(*) n FROM bb_outbox WHERE owner_user_id=$1 AND event_type='ocr.snapshot_saved'",[owner])).rows[0].n,'1');
    await assert.rejects(authorizeOcrMaterial(pool,{...context,purpose:'full_ocr',runId:uid()}));
    let review=await readOcr(pool,blobs,owner,projectId,materialId);
    assert.equal(review.eligible_for_manuscript,false);assert.equal('image_base64' in review.pages[0],false);
    const input:OcrCorrectionRequest={request_id:uid(),snapshot_id:snapshotId,record_id:'p1-r1',result_sha256:review.result_sha256,expected_revision:0,corrected_text:'(1,234.50)',reason:'Synthetic visual check',period:'2025',scope:'consolidated',unit:'万元'};
    const correction=await correctOcr(pool,blobs,owner,projectId,materialId,input);
    assert.deepEqual(await correctOcr(pool,blobs,owner,projectId,materialId,input),correction);
    assert.equal(correction.status,'user_asserted');assert.equal(correction.eligible_for_manuscript,false);assert.equal(correction.actor_user_id,owner);
    await assert.rejects(correctOcr(pool,blobs,owner,projectId,materialId,{...input,request_id:uid()}),/changed/);
    await correctOcr(pool,blobs,owner,projectId,materialId,{...input,request_id:uid(),expected_revision:1,corrected_text:'(1,234.60)'});
    review=await readOcr(pool,blobs,owner,projectId,materialId);assert.equal(review.corrections.length,2);assert.equal(review.records[0].text,'(1,234.50)');
    await assert.rejects(pool.query('UPDATE bb_ocr_corrections SET revision=9 WHERE snapshot_id=$1',[snapshotId]),/append-only/);
    active=uid();const route=`/api/v1/projects/${projectId}/materials/${materialId}/ocr`;
    assert.equal((await send('GET',route)).statusCode,404);
    assert.equal((await send('GET',review.pages[0].image_url)).statusCode,404);
    assert.equal((await send('POST',`${route}/corrections`,input)).statusCode,404);
    active=owner;assert.equal((await send('GET',review.pages[0].image_url)).statusCode,200);
    const source=await uploadSyntheticReference(app,projectId,{origin});
    const locked=await send('POST',`/api/v1/projects/${projectId}/input-revisions`,{...source,material_versions:[{material_id:materialId,material_version:1},...source.material_versions]});
    assert.equal(locked.statusCode,201,locked.body);
    const snapshot=locked.json();
    const quoteId=await quoteSyntheticAuthoringRun(app,pool,owner,projectId,snapshot,{origin});
    const execution=await send('POST','/api/v1/runs/execute',{execution_request_id:uid(),project_id:projectId,input_revision:snapshot.input_revision,input_hash:snapshot.input_hash,quote_id:quoteId,task_kind:'update',input_manifest_ref:'synthetic-manifest',storage_origin:'cloud',workspace_id:'synthetic-workspace'});
    assert.equal(execution.statusCode,202,execution.body);
    const runId=execution.json().run_id;
    await assert.rejects(authorizeOcrMaterial(pool,{...context,purpose:'full_ocr',runId}),/requires an active/);
    await pool.query("UPDATE bb_runs SET state='queued' WHERE id=$1",[runId]);
    const fullContext={...context,requestId:uid(),purpose:'full_ocr' as const,runId};
    assert.equal((await authorizeOcrMaterial(pool,fullContext)).id,materialId);
    const fullResponse={...raw,request_id:fullContext.requestId,purpose:'full_ocr' as const};
    await storeOcr(pool,blobs,fullContext,fullResponse);
    await assert.rejects(correctOcr(pool,blobs,owner,projectId,materialId,{...input,request_id:uid(),expected_revision:2}),/changed/);
    await pool.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1",[runId]);
    await assert.rejects(authorizeOcrMaterial(pool,fullContext),/requires an active/);

    assert.equal((await send('DELETE',`/api/v1/projects/${projectId}/materials/${materialId}`)).statusCode,204);
    assert.equal((await send('GET',route)).statusCode,404);assert.equal((await send('GET',review.pages[0].image_url)).statusCode,404);
    assert.equal((await pool.query('SELECT count(*) n FROM bb_ocr_corrections WHERE snapshot_id=$1',[snapshotId])).rows[0].n,'2');
  } finally {await app.close();await pool.end();}
});
