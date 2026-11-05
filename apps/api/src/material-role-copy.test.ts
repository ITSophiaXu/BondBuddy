import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { BlobServiceClient } from '@azure/storage-blob';
import { M1_UPLOAD_LIMITS } from '@bondbuddy/contracts';
import { createServer } from './server.js';
import { azureBlobs, digest } from './data.js';
import { DOCX, PDF, docxSample } from './upload-safety.samples.js';
import { isolatedTestDatabase } from './test-database.js';
import { runStorageLifecycle } from './storage-lifecycle.js';

const connection=await isolatedTestDatabase();
const blobConnection=process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const origin='http://bondbuddy.test';

test('owner explicitly copies exact reference bytes with durable replay and isolated role', {skip:!connection||!blobConnection},async()=>{
  const pool=new Pool({connectionString:connection});
  const firstOwner=`role-${randomUUID()}`;let owner=firstOwner;
  const container=`bb-role-${randomUUID().replaceAll('-','')}`;
  const blobs=azureBlobs(blobConnection!,container);
  const app=createServer({pool,blobs,allowedOrigin:origin,principal:async()=>({userId:owner,csrfVerified:true})});
  const send=(method:string,url:string,payload?:unknown,revision?:number)=>app.inject({method:method as any,url,payload:payload as any,
    headers:{origin,...(revision?{'if-match':String(revision)}:{}),...(Buffer.isBuffer(payload)?{'content-type':'application/octet-stream'}:{})}});
  const bytes=await docxSample(),sha=digest(bytes);
  try{
    const created=await send('POST','/api/v1/projects',{name:'Synthetic role correction',kind:'update',issuer_name:null,market:null,offering:null});
    assert.equal(created.statusCode,201,created.body);
    const project=created.json().project_id as string;
    const base=`/api/v1/projects/${project}`;
    const upload=await send('POST',`${base}/materials/uploads`,{filename:'synthetic.docx',media_type:DOCX,byte_size:bytes.length,sha256:sha,role:'reference'});
    assert.equal(upload.statusCode,201,upload.body);
    assert.equal((await send('PUT',upload.json().upload_url,bytes)).statusCode,204);
    const completed=await send('POST',`${base}/materials/uploads/${upload.json().upload_id}/complete`,{byte_size:bytes.length,sha256:sha});
    assert.equal(completed.statusCode,200,completed.body);
    const source=completed.json();
    const originalInput=await send('POST',`${base}/input-revisions`,{draft_revision:1,material_versions:[{material_id:source.material_id,material_version:1}],requirement_message_ids:[]});
    assert.equal(originalInput.statusCode,201,originalInput.body);
    const oldHash=originalInput.json().input_hash;
    const request={request_key:randomUUID(),source_material_id:source.material_id,source_material_version:1,source_sha256:sha,source_media_type:DOCX,target_role:'historical'};
    const path=`${base}/materials/role-copies`;
    const invalid=[
      {...request,source_sha256:'a'.repeat(64)},
      {...request,source_media_type:PDF},
      {...request,target_role:'reference'},
      {...request,source_material_version:2},
    ];
    for(const value of invalid){
      const response=await send('POST',path,{...value,request_key:randomUUID()});
      assert.ok([404,409,422].includes(response.statusCode),response.body);
    }
    owner=`other-${randomUUID()}`;
    assert.equal((await send('POST',path,request)).statusCode,404);
    owner=firstOwner;
    const otherProject=(await send('POST','/api/v1/projects',{name:'Synthetic other project',kind:'update',issuer_name:null,market:null,offering:null})).json().project_id;
    assert.equal((await send('POST',`/api/v1/projects/${otherProject}/materials/role-copies`,{...request,request_key:randomUUID()})).statusCode,404);
    const broken=createServer({pool,blobs:{...blobs,putFile:async()=>{throw new Error('synthetic blob failure');}},allowedOrigin:origin,
      principal:async()=>({userId:owner,csrfVerified:true})});
    const brokenRequest={...request,request_key:randomUUID()};
    assert.equal((await broken.inject({method:'POST',url:path,payload:brokenRequest,headers:{origin}})).statusCode,500);
    await broken.close();
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_outbox WHERE owner_user_id=$1 AND event_type='material.role_copied'",[owner])).rows[0].n,0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_material_versions WHERE owner_user_id=$1',[owner])).rows[0].n,1);
    const failedUpload=(await pool.query('SELECT upload_id FROM bb_material_role_copy_receipts WHERE owner_user_id=$1 AND request_key=$2',[owner,brokenRequest.request_key])).rows[0].upload_id;
    await pool.query("UPDATE bb_uploads SET expires_at=now()-interval '2 hours' WHERE id=$1",[failedUpload]);
    await runStorageLifecycle(pool,blobs,{materialRetentionDays:1,orphanUploadGraceHours:1,ownerScope:owner});
    assert.equal((await pool.query('SELECT state FROM bb_uploads WHERE id=$1',[failedUpload])).rows[0].state,'purged');
    const recovered=await send('POST',path,brokenRequest);
    assert.equal(recovered.statusCode,201,recovered.body);
    assert.notEqual((await pool.query('SELECT upload_id FROM bb_material_role_copy_receipts WHERE owner_user_id=$1 AND request_key=$2',[owner,brokenRequest.request_key])).rows[0].upload_id,failedUpload);
    await pool.query(`CREATE FUNCTION bb_fail_role_copy_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.event_type='material.role_copied' THEN RAISE EXCEPTION 'synthetic copy outbox failure'; END IF;
      RETURN NEW; END $$`);
    await pool.query('CREATE TRIGGER bb_fail_role_copy_test BEFORE INSERT ON bb_outbox FOR EACH ROW EXECUTE FUNCTION bb_fail_role_copy_test()');
    try{
      assert.equal((await send('POST',path,request)).statusCode,500);
      assert.equal((await pool.query('SELECT material_id FROM bb_material_role_copy_receipts WHERE owner_user_id=$1 AND request_key=$2',[owner,request.request_key])).rows[0].material_id,null);
      assert.equal((await pool.query("SELECT count(*)::int n FROM bb_outbox WHERE owner_user_id=$1 AND event_type='material.role_copied'",[owner])).rows[0].n,1);
    }finally{
      await pool.query('DROP TRIGGER bb_fail_role_copy_test ON bb_outbox');
      await pool.query('DROP FUNCTION bb_fail_role_copy_test()');
    }
    const copied=await send('POST',path,request);
    assert.equal(copied.statusCode,201,copied.body);
    const result=copied.json();
    assert.notEqual(result.material.material_id,source.material_id);
    assert.equal(result.material.role,'historical');
    assert.equal(result.material.sha256,sha);
    assert.deepEqual((await send('GET',`${base}/materials/${result.material.material_id}/download`)).rawPayload,bytes);
    assert.equal((await send('GET',`${base}/materials/${source.material_id}`)).json().role,'reference');
    assert.equal((await send('POST',path,request)).json().material.material_id,result.material.material_id);
    assert.equal((await send('POST',path,{...request,source_sha256:'b'.repeat(64)})).statusCode,409);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2',[owner,project])).rows[0].n,3);
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_jobs WHERE owner_user_id=$1 AND material_id=$2 AND job_type='parse'",[owner,result.material.material_id])).rows[0].n,1);
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_outbox WHERE owner_user_id=$1 AND event_type='material.role_copied'",[owner])).rows[0].n,2);
    const old=(await pool.query('SELECT input_hash,material_versions FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=1',[owner,project])).rows[0];
    assert.equal(old.input_hash.trim(),oldHash);
    assert.deepEqual(old.material_versions,[{material_id:source.material_id,material_version:1}]);
    const draft=(await send('GET',base)).json();
    assert.equal(draft.update_details.has_historical,null,'copy never changes the draft choice');
    assert.equal(draft.input_revision,1,'copy never creates an input lock');
    const changed=await send('PATCH',base,{update_details:{...draft.update_details,has_historical:true}},1);
    assert.equal(changed.statusCode,200,changed.body);
    const newInput=await send('POST',`${base}/input-revisions`,{draft_revision:2,material_versions:[{material_id:result.material.material_id,material_version:1}],requirement_message_ids:[]});
    assert.equal(newInput.statusCode,201,newInput.body);
    const manifest=(await pool.query('SELECT manifest FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=2',[owner,project])).rows[0].manifest;
    assert.equal(manifest.materials[0].role,'historical');
    assert.notEqual(manifest.issuer_identity?.status,'verified');
    assert.equal((await send('DELETE',`${base}/materials/${source.material_id}`)).statusCode,204);
    assert.equal((await send('POST',path,{...request,request_key:randomUUID()})).statusCode,404,'deleted source cannot seed a new copy');
    const docx=await docxSample(),docxHash=digest(docx);
    const docxUpload=await send('POST',`${base}/materials/uploads`,{filename:'synthetic.docx',media_type:DOCX,byte_size:docx.length,sha256:docxHash,role:'reference'});
    assert.equal(docxUpload.statusCode,201,docxUpload.body);
    assert.equal((await send('PUT',docxUpload.json().upload_url,docx)).statusCode,204);
    const docxSource=await send('POST',`${base}/materials/uploads/${docxUpload.json().upload_id}/complete`,{byte_size:docx.length,sha256:docxHash});
    assert.equal(docxSource.statusCode,200,docxSource.body);
    const docxCopy=await send('POST',path,{request_key:randomUUID(),source_material_id:docxSource.json().material_id,
      source_material_version:1,source_sha256:docxHash,source_media_type:DOCX,target_role:'historical'});
    assert.equal(docxCopy.statusCode,201,docxCopy.body);
    assert.deepEqual((await send('GET',`${base}/materials/${docxCopy.json().material.material_id}/download`)).rawPayload,docx);
    // Unified updates adopt corrected historical uploads in the copy transaction.
    await pool.query(`UPDATE bb_projects SET update_details=jsonb_set(update_details,'{authoring_mode}','"unified_v1"') WHERE id=$1`,[project]);
    const automaticRequest={request_key:randomUUID(),source_material_id:docxSource.json().material_id,
      source_material_version:1,source_sha256:docxHash,source_media_type:DOCX,target_role:'historical'};
    const automatic=await send('POST',path,automaticRequest);
    assert.equal(automatic.statusCode,201,automatic.body);
    const selected=(await send('GET',`${base}/prospectus-versions`)).json();
    assert.equal(selected.versions.find((v:any)=>v.version_id===selected.current_version_id).material_id,automatic.json().material.material_id);
    assert.equal(selected.selection_revision,1);
    const newerCopy=await send('POST',path,{...automaticRequest,request_key:randomUUID()});
    assert.equal(newerCopy.statusCode,201,newerCopy.body);
    const newerSelected=(await send('GET',`${base}/prospectus-versions`)).json();
    assert.equal(newerSelected.selection_revision,2);
    assert.equal((await send('POST',path,automaticRequest)).statusCode,201);
    assert.deepEqual((await send('GET',`${base}/prospectus-versions`)).json(),newerSelected,'old copy receipt replay cannot replace the newer source');
    assert.deepEqual((await pool.query('SELECT input_hash,material_versions FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=1',[owner,project])).rows[0],old);
    // Synthetic metadata is sufficient to exercise the transactional byte-capacity guard.
    for(let index=0;index<5;index++){
      const materialId=randomUUID(),key=`synthetic/${owner}/${materialId}`,size=M1_UPLOAD_LIMITS.fileBytes;
      await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
        VALUES($1,$2,$3,'prior.pdf',$4,$5,$6,'audit',$7,now(),'completed')`,
        [materialId,owner,project,PDF,size,digest(`synthetic capacity ${index}`),key]);
      await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
        VALUES($1,1,$2,$3,$1,'audit','prior.pdf',$4,$5,$6,$7,'persisted')`,
        [materialId,owner,project,PDF,size,digest(`synthetic capacity ${index}`),key]);
    }
    const beforeCapacity=(await pool.query('SELECT count(*)::int n FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2',[owner,project])).rows[0].n;
    const overCapacity=await send('POST',path,{request_key:randomUUID(),source_material_id:docxSource.json().material_id,
      source_material_version:1,source_sha256:docxHash,source_media_type:DOCX,target_role:'historical'});
    assert.equal(overCapacity.statusCode,422,overCapacity.body);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2',[owner,project])).rows[0].n,beforeCapacity);
  }finally{
    await app.close();await pool.end();
    await BlobServiceClient.fromConnectionString(blobConnection!).getContainerClient(container).deleteIfExists();
  }
});
