import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { BlobServiceClient } from '@azure/storage-blob';
import { PROSPECTUS_DOCX_ONLY_FIELD_ERROR } from '@bondbuddy/contracts';
import { createServer } from './server.js';
import { azureBlobs, digest } from './data.js';
import { DOCX, PDF, docxSample, pdfSample } from './upload-safety.samples.js';
import { isolatedTestDatabase } from './test-database.js';

const connection=await isolatedTestDatabase();
const blobConnection=process.env.BB_TEST_AZURITE_CONNECTION_STRING;
test('Word-only update sources cover new and pending uploads without changing saved PDFs or other materials',
  {skip:!connection||!blobConnection},async()=>{
  const pool=new Pool({connectionString:connection}),owner=`docx-${randomUUID()}`;
  const container=`bb-docx-${randomUUID().replaceAll('-','')}`,blobs=azureBlobs(blobConnection!,container);
  const origin='http://bondbuddy.test';
  const app=createServer({pool,blobs,allowedOrigin:origin,principal:async()=>({userId:owner,csrfVerified:true})});
  const send=(method:string,url:string,payload?:unknown)=>app.inject({method:method as any,url,payload:payload as any,
    headers:{origin,...(Buffer.isBuffer(payload)?{'content-type':'application/octet-stream'}:{})}});
  const create=async(kind:string)=>{
    const r=await send('POST','/api/v1/projects',{name:'Synthetic Word-only sources',kind,issuer_name:null,market:null,offering:null});
    assert.equal(r.statusCode,201,r.body);return r.json().project_id as string;
  };
  const pdf=pdfSample(),word=await docxSample();
  const upload=async(project:string,role:string,filename:string,media_type:string,bytes:Buffer)=>{
    const base=`/api/v1/projects/${project}`,declaration={byte_size:bytes.length,sha256:digest(bytes)};
    const session=await send('POST',`${base}/materials/uploads`,{...declaration,role,filename,media_type});
    assert.equal(session.statusCode,201,session.body);
    const put=await send('PUT',session.json().upload_url,bytes);assert.equal(put.statusCode,204,put.body);
    const complete=await send('POST',`${base}/materials/uploads/${session.json().upload_id}/complete`,declaration);
    assert.equal(complete.statusCode,200,complete.body);return complete.json();
  };
  const rejected=(r:Awaited<ReturnType<typeof send>>)=>{
    assert.equal(r.statusCode,422,r.body);assert.equal(r.json().code,'MATERIAL_FORMAT_UNSUPPORTED');
    assert.deepEqual(r.json().field_errors,[PROSPECTUS_DOCX_ONLY_FIELD_ERROR]);
  };
  try{
    const project=await create('update'),base=`/api/v1/projects/${project}`;
    assert.equal((await send('GET',`${base}/prospectus-versions`)).json().upload_docx_only,true);
    for(const role of ['historical','reference']){
      rejected(await send('POST',`${base}/materials/uploads`,{filename:'history.pdf',media_type:PDF,role,byte_size:pdf.length,sha256:digest(pdf)}));
    }
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_uploads WHERE project_id=$1',[project])).rows[0].n,0,'rejection reserves no upload');
    const mismatched=await send('POST',`${base}/materials/uploads`,{filename:'history.pdf',media_type:DOCX,role:'historical',byte_size:word.length,sha256:digest(word)});
    assert.equal(mismatched.statusCode,422);
    const savedWord=await upload(project,'historical','history.DOCX',DOCX,word);
    await upload(project,'reference','reference.docx',DOCX,word);
    const audit=await upload(project,'audit','audit.pdf',PDF,pdf);
    assert.equal(audit.media_type,PDF);
    const other=await create('generation');
    assert.equal((await send('GET',`/api/v1/projects/${other}/prospectus-versions`)).json().upload_docx_only,false);
    assert.equal((await upload(other,'reference','reference.pdf',PDF,pdf)).media_type,PDF);

    // Simulate records created before this policy. No customer files or production state.
    const seed=async(role:string,completed:boolean)=>{
      const id=randomUUID(),key=`users/${owner}/projects/${project}/uploads/${id}`;
      await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
        VALUES($1,$2,$3,'legacy.pdf',$4,$5,$6,$7,$8,now()+interval '15 minutes',$9)`,[id,owner,project,PDF,pdf.length,digest(pdf),role,key,completed?'completed':'uploading']);
      if(completed){
        await blobs.put(key,pdf,PDF);
        await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
          VALUES($1,1,$2,$3,$1,$4,'legacy.pdf',$5,$6,$7,$8,'persisted')`,[id,owner,project,role,PDF,pdf.length,digest(pdf),key]);
      }
      return id;
    };
    for(const role of ['historical','reference']){
      const pending=await seed(role,false);
      rejected(await send('PUT',`${base}/materials/uploads/${pending}/bytes`,pdf));
      await pool.query("UPDATE bb_uploads SET state='received' WHERE id=$1",[pending]);
      rejected(await send('POST',`${base}/materials/uploads/${pending}/complete`,{byte_size:pdf.length,sha256:digest(pdf)}));
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_material_versions WHERE upload_id=$1',[pending])).rows[0].n,0);
    }
    const legacy=await seed('historical',true);
    const replay=await send('POST',`${base}/materials/uploads/${legacy}/complete`,{byte_size:pdf.length,sha256:digest(pdf)});
    assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().material_id,legacy);
    assert.deepEqual((await send('GET',`${base}/materials/${legacy}/download`)).rawPayload,pdf);
    const state=(await send('GET',`${base}/prospectus-versions`)).json();
    assert.ok(state.versions.some((v:any)=>v.material_id===savedWord.material_id));
    const legacyVersion=state.versions.find((v:any)=>v.material_id===legacy);
    assert.ok(legacyVersion,'existing PDF version is retained');
    const select=await send('POST',`${base}/prospectus-versions/current`,{request_id:randomUUID(),expected_selection_revision:state.selection_revision,version_id:legacyVersion.version_id});
    assert.equal(select.statusCode,200,select.body);
    const reference=await seed('reference',true);
    rejected(await send('POST',`${base}/materials/role-copies`,{request_key:randomUUID(),source_material_id:reference,source_material_version:1,source_sha256:digest(pdf),source_media_type:PDF,target_role:'historical'}));
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_material_role_copy_receipts WHERE source_material_id=$1',[reference])).rows[0].n,0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE owner_user_id=$1',[owner])).rows[0].n,0);
  }finally{
    await app.close();await pool.end();
    await BlobServiceClient.fromConnectionString(blobConnection!).getContainerClient(container).deleteIfExists();
  }
});
