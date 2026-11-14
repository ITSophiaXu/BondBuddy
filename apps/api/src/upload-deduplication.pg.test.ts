// Real local PostgreSQL/Azurite requests; no production storage or model calls.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import {syncBuiltinESMExports} from 'node:module';
import {mock,test} from 'node:test';
import {Pool} from 'pg';
import {BlobServiceClient} from '@azure/storage-blob';
import {createServer} from './server.js';
import {azureBlobs,digest} from './data.js';
import {runUploadConfirmationOnce} from './upload-confirmation.js';
import {isolatedTestDatabase} from './test-database.js';
import {DOCX} from './upload-safety.samples.js';

const connection=await isolatedTestDatabase(undefined,'upload-deduplication');
const storage=process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const options={skip:!connection||!storage};

// Observe actual outgoing Blob GETs while keeping the original HTTP clients and
// streams. A function-call counter would miss an unexpected extra SDK download.
function downloads(container:string){
  const keys:string[]=[],prefix=`/${container}/`;
  const watch=(transport:{request:typeof http.request})=>{
    const request=transport.request;
    return mock.method(transport,'request',(...args:any[])=>{
      const outgoing=Reflect.apply(request,transport,args) as http.ClientRequest;
      const path=decodeURIComponent(new URL(outgoing.path,'http://synthetic.invalid').pathname),at=path.indexOf(prefix);
      if(outgoing.method==='GET'&&at>=0)keys.push(path.slice(at+prefix.length));
      return outgoing;
    });
  };
  const hooks=[watch(http),watch(https)];
  syncBuiltinESMExports();
  return {keys,restore:()=>{for(const hook of hooks)hook.mock.restore();syncBuiltinESMExports();}};
}

async function fixture(){
  const pool=new Pool({connectionString:connection,options:'-c jit=off'}),owner='dedup-'+randomUUID(),container='bb-dedup-'+randomUUID().replaceAll('-','');
  const blobs=azureBlobs(storage!,container),origin='http://bondbuddy.test';let actor=owner;
  const app=createServer({pool,blobs,allowedOrigin:origin,principal:async()=>({userId:actor,csrfVerified:true})});
  const send=(method:string,url:string,payload?:any,async=false)=>app.inject({method:method as any,url,payload,headers:{origin,...(Buffer.isBuffer(payload)?{'content-type':'application/octet-stream'}:{}),...(async?{prefer:'respond-async'}:{})}});
  const createProject=async()=>{
    const p=await send('POST','/api/v1/projects',{name:'Synthetic deduplication',kind:'update',issuer_name:null,market:null,offering:null});assert.equal(p.statusCode,201,p.body);
    const id=p.json().project_id as string;
    await pool.query("UPDATE bb_projects SET update_details=jsonb_build_object('authoring_mode','unified_v1') WHERE id=$1",[id]);
    return id;
  };
  const id=await createProject();
  const upload=async(bytes=Buffer.from('Synthetic original material for upload reuse'),scope:{projectId?:string;role?:string}={})=>{
    const projectId=scope.projectId??id,declaration={byte_size:bytes.length,sha256:digest(bytes)};
    const created=await send('POST',`/api/v1/projects/${projectId}/materials/uploads`,{...declaration,filename:'synthetic.docx',role:scope.role??'other',media_type:DOCX});assert.equal(created.statusCode,201,created.body);
    const u=created.json();assert.equal((await send('PUT',u.upload_url,bytes)).statusCode,204);
    const row=(await pool.query('SELECT object_key FROM bb_uploads WHERE id=$1',[u.upload_id])).rows[0];
    return {id:u.upload_id as string,key:row.object_key as string,bytes,declaration,path:`/api/v1/projects/${projectId}/materials/uploads/${u.upload_id}/complete`};
  };
  const complete=async(u:Awaited<ReturnType<typeof upload>>,async=false)=>{
    const response=await send('POST',u.path,u.declaration,async);
    if(!async){assert.equal(response.statusCode,200,response.body);return response.json();}
    assert.equal(response.statusCode,202,response.body);assert.equal(await runUploadConfirmationOnce(pool,blobs),'completed');
    const final=await send('POST',u.path,u.declaration,true);assert.equal(final.statusCode,200,final.body);return final.json();
  };
  const retry=async(uploadId:string)=>pool.query("UPDATE bb_outbox SET next_attempt_at=NULL WHERE aggregate_id=$1 AND event_type='upload.complete_requested'",[uploadId]);
  return {pool,owner,id,container,blobs,send,upload,complete,retry,createProject,foreign:()=>actor='dedup-foreign-'+randomUUID(),
    close:async()=>{await app.close();await pool.end();await BlobServiceClient.fromConnectionString(storage!).getContainerClient(container).deleteIfExists();}};
}

for(const async of [false,true])test(`duplicate upload reads only its new object when canonical receipt is current: async=${async}`,options,async()=>{
  const f=await fixture();let observed:ReturnType<typeof downloads>|undefined;
  try{
    const first=await f.upload(),saved=await f.complete(first);
    const duplicate=await f.upload(first.bytes);observed=downloads(f.container);
    const result=await f.complete(duplicate,async);
    assert.equal(result.material_id,saved.material_id);assert.equal(result.sha256,digest(first.bytes));assert.equal(result.byte_size,first.bytes.length);
    assert.deepEqual(observed.keys,[duplicate.key],'new bytes must be read once; an already verified canonical version must not be downloaded again');
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM bb_material_versions WHERE owner_user_id=$1',[f.owner])).rows[0].n,1);
    assert.equal((await f.pool.query('SELECT material_id FROM bb_upload_reuse_receipts WHERE upload_id=$1',[duplicate.id])).rows[0].material_id,saved.material_id);
  }finally{observed?.restore();await f.close();}
});

for(const mode of ['missing_receipt','wrong_receipt_hash','changed_etag','versionless'] as const)test(`duplicate upload verifies canonical bytes when its receipt is unusable: ${mode}`,options,async()=>{
  const f=await fixture();let observed:ReturnType<typeof downloads>|undefined;
  try{
    const first=await f.upload(),saved=await f.complete(first);
    if(mode==='missing_receipt')await f.pool.query('DELETE FROM bb_upload_integrity_receipts WHERE material_id=$1',[saved.material_id]);
    if(mode==='wrong_receipt_hash')await f.pool.query(`WITH old AS (DELETE FROM bb_upload_integrity_receipts WHERE material_id=$1 RETURNING *)
      INSERT INTO bb_upload_integrity_receipts(owner_user_id,project_id,material_id,material_version,object_key,sha256,byte_size,object_etag)
      SELECT owner_user_id,project_id,material_id,material_version,object_key,repeat('0',64),byte_size,object_etag FROM old`,[saved.material_id]);
    if(mode==='changed_etag'){
      const before=await f.blobs.headVersion!(first.key);await f.blobs.put(first.key,first.bytes,DOCX);
      assert.notEqual((await f.blobs.headVersion!(first.key))!.etag,before!.etag);
    }
    if(mode==='versionless')f.blobs.headVersion=undefined;
    const duplicate=await f.upload(first.bytes);observed=downloads(f.container);
    const result=await f.complete(duplicate);
    assert.equal(result.material_id,saved.material_id);
    assert.deepEqual(observed.keys,[duplicate.key,first.key],'an unusable receipt must fall back to a real canonical body download');
  }finally{observed?.restore();await f.close();}
});

for(const timing of ['before_receipt_check','after_receipt_head'] as const)test(`changed canonical bytes cannot be accepted through a receipt: ${timing}`,options,async()=>{
  const f=await fixture();let observed:ReturnType<typeof downloads>|undefined;
  try{
    const first=await f.upload(),saved=await f.complete(first),duplicate=await f.upload(first.bytes),replacement=Buffer.alloc(first.bytes.length,120);
    const head=f.blobs.headVersion!;
    if(timing==='before_receipt_check')await f.blobs.put(first.key,replacement,DOCX);
    else{
      let once=true;f.blobs.headVersion=async key=>{
        const version=await head(key);
        if(key===first.key&&once){once=false;await f.blobs.put(key,replacement,DOCX);}
        return version;
      };
    }
    observed=downloads(f.container);assert.equal((await f.send('POST',duplicate.path,duplicate.declaration,true)).statusCode,202);
    assert.equal(await runUploadConfirmationOnce(f.pool,f.blobs),'retry');
    const failure=(await f.pool.query('SELECT last_error FROM bb_upload_confirmations WHERE upload_id=$1',[duplicate.id])).rows[0].last_error;
    assert.equal(failure.message,timing==='before_receipt_check'?'Saved material is temporarily unavailable':'UPLOAD_REVERIFY_REQUIRED');
    assert.deepEqual(observed.keys,timing==='before_receipt_check'?[duplicate.key,first.key]:[duplicate.key]);
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM bb_upload_reuse_receipts WHERE upload_id=$1',[duplicate.id])).rows[0].n,0);
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM bb_material_versions WHERE upload_id=$1',[duplicate.id])).rows[0].n,0);
    f.blobs.headVersion=head;await f.blobs.put(first.key,first.bytes,DOCX);await f.retry(duplicate.id);
    assert.equal(await runUploadConfirmationOnce(f.pool,f.blobs),'completed');
    const result=await f.send('POST',duplicate.path,duplicate.declaration,true);assert.equal(result.statusCode,200,result.body);assert.equal(result.json().material_id,saved.material_id);
    assert.deepEqual(observed.keys.slice(-2),[duplicate.key,first.key],'the replacement ETag must acquire a new full-read proof before reuse');
  }finally{observed?.restore();await f.close();}
});

test('equal bytes in another owner, project or role never reuse the canonical material or its receipt',options,async()=>{
  const f=await fixture();let observed:ReturnType<typeof downloads>|undefined;
  try{
    const first=await f.upload(),saved=await f.complete(first),otherProject=await f.createProject();
    observed=downloads(f.container);
    const sameOwnerOtherProject=await f.upload(first.bytes,{projectId:otherProject}),sameProjectOtherRole=await f.upload(first.bytes,{role:'audit'});
    for(const upload of [sameOwnerOtherProject,sameProjectOtherRole])assert.notEqual((await f.complete(upload,true)).material_id,saved.material_id);
    f.foreign();const foreignProject=await f.createProject(),foreign=await f.upload(first.bytes,{projectId:foreignProject});
    assert.notEqual((await f.complete(foreign,true)).material_id,saved.material_id);
    assert.deepEqual(observed.keys,[sameOwnerOtherProject.key,sameProjectOtherRole.key,foreign.key]);
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM bb_upload_reuse_receipts WHERE upload_id=ANY($1::text[])',[[sameOwnerOtherProject.id,sameProjectOtherRole.id,foreign.id]])).rows[0].n,0);
  }finally{observed?.restore();await f.close();}
});
