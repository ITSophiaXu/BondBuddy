import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { BlobServiceClient } from '@azure/storage-blob';
import { emptyUpdateDetails, M1_UPLOAD_LIMITS, M1_UPLOAD_MIME_TYPES } from '@bondbuddy/contracts';
import { Pool } from 'pg';
import { azureBlobs, digest, verifiedMedia, verifiedMediaFileDetailed } from './data.js';
import { createServer } from './server.js';
import { isolatedTestDatabase } from './test-database.js';
import { pdfWidgetSample } from './upload-safety.samples.js';

const root = fileURLToPath(new URL('../../../tests/samples/2026-09-25/', import.meta.url));
const connection = await isolatedTestDatabase();
const storage = process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const origin = 'http://bondbuddy.test';

test('every supported project material is stored opaquely without content parsing', async () => {
  const directory=await mkdtemp(join(tmpdir(),'bb-original-'));
  try {
    const bytes=Buffer.from('opaque original: no document structure, \x00 /JavaScript /Sig =FORMULA()');
    const path=join(directory,'original'); await writeFile(path,bytes);
    for (const media of M1_UPLOAD_MIME_TYPES) {
      assert.equal(await verifiedMedia(bytes,media),media);
      assert.deepEqual(await verifiedMediaFileDetailed(path,bytes.length,media),{mediaType:media,signatureAssessment:null});
    }
    assert.deepEqual(await readFile(path),bytes);
    await assert.rejects(verifiedMedia(Buffer.alloc(0),'application/pdf'),(e:any)=>e.uploadReason==='size_limit');
    await assert.rejects(verifiedMediaFileDetailed(path,M1_UPLOAD_LIMITS.fileBytes+1,'application/pdf'),(e:any)=>e.uploadReason==='size_limit');
    await assert.rejects(verifiedMediaFileDetailed(path,bytes.length+1,'application/pdf'),(e:any)=>e.code==='MATERIAL_CONTENT_MISMATCH');
    await assert.rejects(verifiedMedia(bytes,'application/x-executable'),(e:any)=>e.code==='MATERIAL_FORMAT_UNSUPPORTED');
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('both authorized qx audit originals retain their exact bytes and need no signature profile', async () => {
  const manifest=JSON.parse(await readFile(join(root,'manifest.json'),'utf8'));
  const files=manifest.cases.find((c:any)=>c.case_id==='qx-202606').files.filter((f:any)=>['qx-202606-02','qx-202606-03'].includes(f.file_id));
  assert.equal(files.length,2);
  for (const entry of files) {
    const path=join(root,entry.path),bytes=await readFile(path);
    assert.equal(bytes.length,entry.bytes);assert.equal(digest(bytes),entry.sha256);
    assert.deepEqual(await verifiedMediaFileDetailed(path,bytes.length,'application/pdf'),{mediaType:'application/pdf',signatureAssessment:null});
    assert.equal(digest(await readFile(path)),entry.sha256);
  }
});

test('raw material public upload preserves bytes, ownership, idempotency and old signature records without starting parsing', {skip:!connection||!storage}, async () => {
  const pool=new Pool({connectionString:connection});
  const originalOwner=`raw-upload-${randomUUID()}`;let owner=originalOwner;
  const container=`bb-raw-${randomUUID().replaceAll('-','')}`,blobs=azureBlobs(storage!,container);
  const app=createServer({pool,blobs,allowedOrigin:origin,principal:async()=>({userId:owner,csrfVerified:true})});
  const send=(method:string,url:string,payload?:unknown)=>app.inject({method:method as any,url,payload:payload as any,
    headers:{origin,'content-type':Buffer.isBuffer(payload)?'application/octet-stream':'application/json'}});
  try {
    const created=await send('POST','/api/v1/projects',{name:'Synthetic raw originals',kind:'update',issuer_name:null,market:null,offering:null,
      update_details:{...emptyUpdateDetails(),authoring_mode:'unified_v1'}});
    assert.equal(created.statusCode,201,created.body);const project=created.json().project_id;
    const begin=async(bytes:Buffer,media:string,filename:string)=>{
      const r=await send('POST',`/api/v1/projects/${project}/materials/uploads`,{filename,role:'audit',media_type:media,byte_size:bytes.length,sha256:digest(bytes)});
      assert.equal(r.statusCode,201,r.body);return r.json();
    };
    const complete=(session:any,bytes:Buffer)=>send('POST',`/api/v1/projects/${project}/materials/uploads/${session.upload_id}/complete`,{byte_size:bytes.length,sha256:digest(bytes)});
    const files:Array<[Buffer,string,string]>=M1_UPLOAD_MIME_TYPES.map((media,i)=>[Buffer.from(`opaque original ${i}: \x00 /Sig /JavaScript`),media,`original.${['docx','pdf','xlsx','csv','txt','png','jpg'][i]}`]);
    const manifest=JSON.parse(await readFile(join(root,'manifest.json'),'utf8'));
    for(const entry of manifest.cases.find((c:any)=>c.case_id==='qx-202606').files.filter((f:any)=>['qx-202606-02','qx-202606-03'].includes(f.file_id)))
      files.push([await readFile(join(root,entry.path)),'application/pdf',`${entry.file_id}.pdf`]);
    for(const [bytes,media,name] of files) {
      const session=await begin(bytes,media,name);
      owner='another-owner';assert.equal((await send('PUT',session.upload_url,bytes)).statusCode,404);owner=originalOwner;
      const put=await send('PUT',session.upload_url,bytes);assert.equal(put.statusCode,204,put.body);
      const saved=await complete(session,bytes);assert.equal(saved.statusCode,200,saved.body);const material=saved.json();
      assert.equal(material.signature_assessment,null);assert.equal(material.sha256,digest(bytes));
      assert.deepEqual(await blobs.get(`users/${owner}/projects/${project}/uploads/${session.upload_id}`),bytes);
      assert.equal((await complete(session,bytes)).json().material_id,material.material_id);
      const retry=await begin(bytes,media,`renamed-${name}`);assert.equal((await send('PUT',retry.upload_url,bytes)).statusCode,204);
      assert.equal((await complete(retry,bytes)).json().material_id,material.material_id,'same original creates no duplicate material');
      owner='another-owner';assert.equal((await send('GET',`/api/v1/projects/${project}/materials/${material.material_id}`)).statusCode,404);owner=originalOwner;
    }
    const wrong=await begin(Buffer.from('expected'),'text/plain','mismatch.txt');
    const rejected=await send('PUT',wrong.upload_url,Buffer.from('altered!'));
    assert.equal(rejected.statusCode,422);assert.equal(rejected.json().code,'MATERIAL_CONTENT_MISMATCH');
    assert.equal(await blobs.getIfExists(`users/${owner}/projects/${project}/uploads/${wrong.upload_id}`),null);

    // Simulate a pre-upgrade persisted record in this isolated database. Its assessment is immutable.
    const bytes=pdfWidgetSample(),prior=await begin(bytes,'application/pdf','old-signed.pdf');
    assert.equal((await send('PUT',prior.upload_url,bytes)).statusCode,204);
    const oldId=randomUUID(),assessment={status:'signature_unverified',profile_version:'signed-pdf-classic-v1',signature_count:1};
    await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state,signature_assessment)
      SELECT $1,1,owner_user_id,project_id,id,role,filename,declared_media_type,byte_size,sha256,object_key,'persisted',$3::jsonb FROM bb_uploads WHERE id=$2`,[oldId,prior.upload_id,JSON.stringify(assessment)]);
    await pool.query("UPDATE bb_uploads SET state='completed' WHERE id=$1",[prior.upload_id]);
    const repeat=await begin(bytes,'application/pdf','signed-again.pdf');assert.equal((await send('PUT',repeat.upload_url,bytes)).statusCode,204);
    const reused=await complete(repeat,bytes);assert.equal(reused.statusCode,200,reused.body);
    assert.equal(reused.json().material_id,oldId);assert.deepEqual(reused.json().signature_assessment,assessment);
    await assert.rejects(pool.query('UPDATE bb_material_versions SET signature_assessment=NULL WHERE id=$1',[oldId]),(e:any)=>e.code==='23514');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_jobs WHERE owner_user_id=$1 AND project_id=$2',[owner,project])).rows[0].n,0,'upload creates no parse or business task');
  } finally {
    await app.close();await pool.end();
    await BlobServiceClient.fromConnectionString(storage!).getContainerClient(container).deleteIfExists();
  }
});
