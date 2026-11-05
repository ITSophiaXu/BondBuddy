import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createServer } from './server.js';
import { azureBlobs, digest } from './data.js';
import { claim, finish, promoteWordArtifact } from './queue.js';
import { makeSyntheticDocxFixture } from './docx-fixtures.js';
import { DOCX } from './upload-safety.samples.js';
import { isolatedTestDatabase } from './test-database.js';

const connection=await isolatedTestDatabase(undefined,'project-collection');
const storage=process.env.BB_TEST_AZURITE_CONNECTION_STRING;
test('project collection: root membership, real uploads/downloads, task history, pagination, failed retry and owner isolation',{skip:!connection||!storage},async()=>{
  const pool=new Pool({connectionString:connection});const firstOwner='collection-'+randomUUID();let owner=firstOwner;
  const blobs=azureBlobs(storage!);const origin='http://bondbuddy.test';
  const app=createServer({pool,blobs,allowedOrigin:origin,principal:async()=>({userId:owner,csrfVerified:true}),enableSyntheticQueue:true});
  app.addHook('onError',async(_req,_reply,error)=>{if(!(error as any).status)process.stderr.write(error.message+'\n');});
  const send=(method:string,url:string,payload?:any,headers:Record<string,string>={})=>app.inject({method:method as any,url,payload,headers:{origin,...headers,...(Buffer.isBuffer(payload)?{'content-type':'application/octet-stream'}:{})}});
  const ok=async(method:string,url:string,payload?:any,headers?:Record<string,string>)=>{const r=await send(method,url,payload,headers);assert.ok(r.statusCode<300,r.body);return r.body?r.json():null;};
  const create=(kind:string,name:string)=>ok('POST','/api/v1/projects',{name,kind,issuer_name:'Synthetic issuer',market:'sse',offering:'private'});
  try{
    const root=await create('review','合成项目 root');
    const child=await ok('POST',`/api/v1/projects/${root.project_id}/update-workspace`,{});
    const member=child.update_project_id;
    const topic=await ok('POST','/api/v1/m4/topics',{creation_request_id:randomUUID(),name:'合成文件主题',source_project_id:root.project_id});
    const p=await create('update','空白项目');
    let list=await ok('GET','/api/v1/projects');
    assert.equal(list.items.length,2,'update workspace and linked generation project are not duplicate project rows');
    assert.equal(list.items.find((x:any)=>x.project_id===p.project_id).task_summary.attention,1);
    const bytes=makeSyntheticDocxFixture({text:'collection-upload'}),declaration={byte_size:bytes.length,sha256:digest(bytes)};
    const upload=await ok('POST',`/api/v1/projects/${member}/materials/uploads`,{...declaration,filename:'合成募集书.docx',media_type:DOCX,role:'historical'});
    assert.equal((await send('PUT',upload.upload_url,bytes)).statusCode,204);
    const material=await ok('POST',`/api/v1/projects/${member}/materials/uploads/${upload.upload_id}/complete`,declaration);
    let files=await ok('GET',`/api/v1/projects/${root.project_id}/files`);assert.equal(files.items.length,1);assert.equal(files.items[0].folder,'2');
    assert.equal(files.items[0].sha256,material.sha256);
    assert.deepEqual((await send('GET',`/api/v1/projects/${member}/materials/${material.material_id}/download`)).rawPayload,bytes);
    assert.deepEqual((await send('GET',`/api/v1/projects/${member}/materials/${material.material_id}/download?version=1`)).rawPayload,bytes);
    assert.equal((await ok('GET',`/api/v1/projects/${member}/materials/${material.material_id}?version=1`)).sha256,material.sha256);
    for(const suffix of ['','/download'])assert.equal((await send('GET',`/api/v1/projects/${member}/materials/${material.material_id}${suffix}?version=999`)).statusCode,404,'an absent version never falls back to latest');
    // Queue submissions use the unchanged test execution path; no provider call or billing.
    let currentProject=await ok('GET',`/api/v1/projects/${member}`);
    currentProject=await ok('PATCH',`/api/v1/projects/${member}`,{update_details:{...currentProject.update_details,
      source_prospectuses:[{material_id:material.material_id,material_version:material.material_version,sha256:material.sha256,
        issuer_name:null,relation:'same_issuer',market:'sse',offering:'private',status:'user_asserted',
        reporting_periods:[{start:'2025-01-01',end:'2025-12-31',period_kind:'annual',scope:'consolidated',status:'user_asserted',evidence_refs:[]}]}]}},
      {'if-match':String(currentProject.draft_revision)});
    const snapshot=await ok('POST',`/api/v1/projects/${member}/input-revisions`,{draft_revision:currentProject.draft_revision,
      material_versions:[{material_id:material.material_id,material_version:material.material_version}],requirement_message_ids:[]});
    const request={project_id:member,input_revision:1,input_hash:snapshot.input_hash,task_kind:'update',input_manifest_ref:'synthetic',storage_origin:'cloud',workspace_id:'synthetic'};
    const execute=()=>ok('POST','/api/v1/runs/execute',{...request,execution_request_id:randomUUID()});
    const run1=await execute();const lease1=await claim(pool,30);assert.equal(lease1!.runId,run1.run_id);
    list=await ok('GET','/api/v1/projects');let row=list.items.find((x:any)=>x.project_id===root.project_id);assert.equal(row.task_summary.active,1);assert.equal(row.task_summary.latest.kind,'update');assert.equal(row.file_count,1);
    const artifact=await promoteWordArtifact(pool,lease1!,makeSyntheticDocxFixture(),blobs);
    files=await ok('GET',`/api/v1/projects/${root.project_id}/files`);assert.equal(files.items.length,1,'unsettled artifacts stay hidden');
    await finish(pool,lease1!,'succeeded',{artifactId:artifact.artifactId,artifactVersion:artifact.artifactVersion,blobs});
    const run2=await execute();const lease2=await claim(pool,30);await finish(pool,lease2!,'failed',{errorCode:'DATA_UNAVAILABLE'});
    list=await ok('GET','/api/v1/projects');row=list.items.find((x:any)=>x.project_id===root.project_id);
    assert.equal(row.status,'failed');assert.equal(row.task_summary.attention,1);assert.equal(row.task_summary.recent_result.run_id,run2.run_id);
    assert.equal(row.file_count,2,'older successful result survives latest failure');
    const first=await ok('GET',`/api/v1/projects/${root.project_id}/tasks?limit=1`);
    assert.equal(first.items[0].run_id,run2.run_id);assert.equal(first.items[0].kind,'update');assert.ok(first.page.has_more);
    const second=await ok('GET',`/api/v1/projects/${root.project_id}/tasks?limit=1&cursor=${first.page.next_cursor}`);
    assert.equal(second.items[0].run_id,run1.run_id);assert.equal(second.page.has_more,false);
    assert.equal((await send('GET',`/api/v1/projects/${p.project_id}/tasks?cursor=${first.page.next_cursor}`)).statusCode,422);
    files=await ok('GET',`/api/v1/projects/${root.project_id}/files`);assert.equal(files.items.filter((f:any)=>f.latest).length,row.file_count);
    const result=files.items.find((f:any)=>f.source==='artifact');const download=await ok('GET','/api/v1/artifacts/'+result.file_id);
    assert.equal(digest((await send('GET',download.download_url)).rawPayload),result.sha256);
    await execute();const lease3=await claim(pool,30);const newer=await promoteWordArtifact(pool,lease3!,makeSyntheticDocxFixture({text:'Second synthetic edition'}),blobs);
    await finish(pool,lease3!,'succeeded',{artifactId:newer.artifactId,artifactVersion:newer.artifactVersion,blobs});
    files=await ok('GET',`/api/v1/projects/${root.project_id}/files`);
    assert.equal(files.items.filter((f:any)=>f.source==='artifact').length,2,'immutable previous edition remains available');
    const latestFile=files.items.find((f:any)=>f.source==='artifact'&&f.latest);assert.equal(latestFile.file_id,newer.artifactId);assert.equal(latestFile.version_count,2);
    row=(await ok('GET','/api/v1/projects')).items.find((x:any)=>x.project_id===root.project_id);
    assert.equal(row.file_count,2,'logical file count does not double-count history');assert.equal(row.task_summary.attention,0,'old failure no longer needs attention after a successful retry');
    await ok('POST',`/api/v1/projects/${root.project_id}/archive`,{archived:true});assert.equal((await ok('GET','/api/v1/projects')).items.length,1);
    assert.equal((await ok('GET',`/api/v1/projects/${root.project_id}/files`)).items.length,files.items.length);
    await ok('POST',`/api/v1/projects/${root.project_id}/archive`,{archived:false});
    owner='other-'+randomUUID();assert.equal((await ok('GET','/api/v1/projects')).items.length,0);
    for(const path of ['files','tasks'])assert.equal((await send('GET',`/api/v1/projects/${root.project_id}/${path}`)).statusCode,404);
    assert.equal((await send('GET',`/api/v1/projects/${member}/materials/${material.material_id}/download?version=1`)).statusCode,404);
    assert.ok(topic);
  }finally{await app.close();await pool.end();}
});
