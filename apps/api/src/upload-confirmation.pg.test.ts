import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {test} from 'node:test';
import {Pool} from 'pg';
import {BlobServiceClient} from '@azure/storage-blob';
import {createServer} from './server.js';
import {azureBlobs,digest,project,transaction,Problem} from './data.js';
import {docxSample,DOCX} from './upload-safety.samples.js';
import {claimUploadConfirmation,processUploadConfirmation,runUploadConfirmationOnce} from './upload-confirmation.js';
import {runStorageLifecycle} from './storage-lifecycle.js';
import {lockStorageObject} from './storage-object-lock.js';
import {isolatedTestDatabase} from './test-database.js';
const connection=await isolatedTestDatabase(undefined,'async-confirmation');
const storage=process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const options={skip:!connection||!storage};
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
function gate(){let release!:()=>void;const wait=new Promise<void>(r=>release=r);return {wait,release};}
async function fixture(){
  const pool=new Pool({connectionString:connection}),owner='async-'+randomUUID(),container='bb-async-'+randomUUID().replaceAll('-','');
  const blobs=azureBlobs(storage!,container),origin='http://bondbuddy.test';let actor=owner;
  let app=createServer({pool,blobs,allowedOrigin:origin,principal:async()=>({userId:actor,csrfVerified:true})});
  const send=(method:string,url:string,payload?:unknown,async=false)=>app.inject({method:method as any,url,payload:payload as any,headers:{origin,...(Buffer.isBuffer(payload)?{'content-type':'application/octet-stream'}:{}),...(async?{prefer:'respond-async'}:{})}});
  const p=await send('POST','/api/v1/projects',{name:'Synthetic confirmation',kind:'update',issuer_name:null,market:null,offering:null});assert.equal(p.statusCode,201,p.body);
  const id=p.json().project_id;
  await pool.query("UPDATE bb_projects SET update_details=jsonb_build_object('authoring_mode','unified_v1') WHERE id=$1",[id]);
  const upload=async(bytes:Buffer|undefined=undefined,filename='synthetic.docx')=>{
    bytes??=await docxSample();
    const declaration={byte_size:bytes.length,sha256:digest(bytes)};
    const r=await send('POST',`/api/v1/projects/${id}/materials/uploads`,{...declaration,filename,role:'historical',media_type:DOCX});assert.equal(r.statusCode,201,r.body);
    const u=r.json();const put=await send('PUT',u.upload_url,bytes);assert.equal(put.statusCode,204,put.body);
    const row=(await pool.query('SELECT * FROM bb_uploads WHERE id=$1',[u.upload_id])).rows[0];
    return {id:u.upload_id,key:row.object_key,bytes,declaration,path:`/api/v1/projects/${id}/materials/uploads/${u.upload_id}/complete`};
  };
  return {pool,blobs,owner,id,upload,send,foreign:()=>actor='foreign-'+randomUUID(),reopen:async()=>{const previous=app;app=createServer({pool,blobs,allowedOrigin:origin,principal:async()=>({userId:actor,csrfVerified:true})});await previous.close();},close:async()=>{await app.close();await pool.end();await BlobServiceClient.fromConnectionString(storage!).getContainerClient(container).deleteIfExists();}};
}

test('31-second real Blob validation returns 202 quickly, survives reopen, and does not hold the project lock',options,async()=>{
 const f=await fixture();const blocked=gate(),started=gate();let work:Promise<string>|undefined;
 try{
  const big=await docxSample([],Buffer.from(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic ${randomBytes(7*1024*1024).toString('base64')}</w:t></w:r></w:p></w:body></w:document>`));
  const u=await f.upload(big);assert.ok(big.length>=6*1024*1024);
  const begin=Date.now(),responses=await Promise.all([f.send('POST',u.path,u.declaration,true),f.send('POST',u.path,u.declaration,true)]);
  assert.ok(Date.now()-begin<2000);for(const r of responses){assert.equal(r.statusCode,202,r.body);assert.equal(r.json().upload_id,u.id);assert.equal(r.headers['retry-after'],'2');}
  assert.equal((await f.pool.query("SELECT count(*)::int n FROM bb_outbox WHERE aggregate_id=$1 AND event_type='upload.complete_requested'",[u.id])).rows[0].n,1);
  const read=f.blobs.readToFile!;f.blobs.readToFile=async(...args)=>{const proof=await read(...args);if(args[0]===u.key){started.release();await blocked.wait;}return proof;};
  work=runUploadConfirmationOnce(f.pool,f.blobs);await started.wait;
  await f.reopen();assert.equal((await f.send('POST',u.path,u.declaration,true)).statusCode,202);
  const saveStart=Date.now();await transaction(f.pool,async c=>{await c.query("SET LOCAL lock_timeout='1 second'");await project(c,f.owner,f.id,true);await c.query('UPDATE bb_projects SET name=$2 WHERE id=$1',[f.id,'Synthetic concurrent save']);});
  const small=await f.upload(undefined,'small.docx');assert.equal((await f.send('POST',small.path,small.declaration,true)).statusCode,202);assert.ok(Date.now()-saveStart<2000);
  await f.pool.query("UPDATE bb_uploads SET expires_at=now()-interval '1 day' WHERE id=$1",[u.id]);
  const cleanup=await runStorageLifecycle(f.pool,f.blobs,{ownerScope:f.owner,materialRetentionDays:0,orphanUploadGraceHours:0});assert.equal(cleanup.orphanUploadsQueued,0);assert.equal(await f.blobs.exists(u.key),true);
  await sleep(31_000);blocked.release();assert.equal(await work,'completed');
  const final=await f.send('POST',u.path,u.declaration,true);assert.equal(final.statusCode,200,final.body);assert.equal(final.json().sha256,u.declaration.sha256);
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM bb_material_versions WHERE owner_user_id=$1 AND upload_id=$2',[f.owner,u.id])).rows[0].n,1);
  assert.equal(await runUploadConfirmationOnce(f.pool,f.blobs),'completed');
  assert.equal((await f.send('POST',small.path,small.declaration,true)).statusCode,200);
 }finally{blocked.release();await work?.catch(()=>{});await f.close();}
});

test('expired lease and abandoned process recover; the old token cannot publish material or adoption',options,async()=>{
 const f=await fixture();const blocked=gate(),started=gate();try{
  const u=await f.upload();await f.send('POST',u.path,u.declaration,true);const old=(await claimUploadConfirmation(f.pool))!;
  const read=f.blobs.readToFile!;let once=true;f.blobs.readToFile=async(...args)=>{const result=await read(...args);if(once){once=false;started.release();await blocked.wait;}return result;};
  const stale=processUploadConfirmation(f.pool,f.blobs,old);await started.wait;
  await f.pool.query("UPDATE bb_outbox SET lease_until=now()-interval '1 second' WHERE id=$1",[old.id]);
  const current=(await claimUploadConfirmation(f.pool))!;assert.notEqual(current.token,old.token);
  assert.equal(await processUploadConfirmation(f.pool,f.blobs,current),'completed');
  const selection=(await f.pool.query('SELECT * FROM bb_prospectus_selection WHERE project_id=$1',[f.id])).rows[0];
  blocked.release();assert.equal(await stale,'lease_lost');
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM bb_material_versions WHERE owner_user_id=$1',[f.owner])).rows[0].n,1);
  assert.equal((await f.pool.query('SELECT revision FROM bb_prospectus_selection WHERE project_id=$1',[f.id])).rows[0].revision,selection.revision);
  const abandoned=await f.upload(undefined,'abandoned.docx');await f.send('POST',abandoned.path,abandoned.declaration,true);const lost=(await claimUploadConfirmation(f.pool))!;
  await f.reopen();await f.pool.query("UPDATE bb_outbox SET lease_until=now()-interval '1 second' WHERE id=$1",[lost.id]);
  assert.equal(await runUploadConfirmationOnce(f.pool,f.blobs),'completed');assert.equal((await f.send('POST',abandoned.path,abandoned.declaration,true)).statusCode,200);
 }finally{blocked.release();await f.close();}
});

test('canonical reuse is verified and replay never readopts an older prospectus',options,async()=>{
 const f=await fixture();try{
  const first=await f.upload();await f.send('POST',first.path,first.declaration,true);assert.equal(await runUploadConfirmationOnce(f.pool,f.blobs),'completed');const original=(await f.send('POST',first.path,first.declaration,true)).json();
  const newer=await f.upload(await docxSample([],Buffer.from(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>New synthetic prospectus</w:t></w:r></w:p></w:body></w:document>`)),'newer.docx');await f.send('POST',newer.path,newer.declaration,true);await runUploadConfirmationOnce(f.pool,f.blobs);
  const selected=(await f.pool.query('SELECT * FROM bb_prospectus_selection WHERE project_id=$1',[f.id])).rows[0];
  await f.send('POST',first.path,first.declaration,true);
  assert.equal((await f.pool.query('SELECT version_id FROM bb_prospectus_selection WHERE project_id=$1',[f.id])).rows[0].version_id,selected.version_id);
  const duplicate=await f.upload(first.bytes,'renamed.docx');await f.send('POST',duplicate.path,duplicate.declaration,true);assert.equal(await runUploadConfirmationOnce(f.pool,f.blobs),'completed');const reused=(await f.send('POST',duplicate.path,duplicate.declaration,true)).json();assert.equal(reused.material_id,original.material_id);
  const receipt=(await f.pool.query('SELECT object_key FROM bb_upload_integrity_receipts WHERE material_id=$1',[original.material_id])).rows;assert.ok(receipt.every(r=>r.object_key===first.key));
  assert.equal((await f.pool.query('SELECT canonical_object_key FROM bb_upload_confirmations WHERE upload_id=$1',[duplicate.id])).rows[0].canonical_object_key,first.key);
  await f.blobs.put(duplicate.key,Buffer.alloc(duplicate.bytes.length,120),DOCX);
  assert.equal((await f.send('POST',duplicate.path,duplicate.declaration,true)).statusCode,200,'replay verifies canonical material, not redundant staging');
 }finally{await f.close();}
});

test('body/hash/version changes reject; persistent terminal error survives reopen and foreign owner is refused',options,async()=>{
 const f=await fixture();const blocked=gate(),started=gate();try{
  const u=await f.upload();await f.send('POST',u.path,u.declaration,true);
  const read=f.blobs.readToFile!;f.blobs.readToFile=async(...args)=>{const proof=await read(...args);started.release();await blocked.wait;return proof;};
  const work=runUploadConfirmationOnce(f.pool,f.blobs);await started.wait;
  await f.blobs.put(u.key,Buffer.alloc(u.bytes.length,120),DOCX);blocked.release();assert.equal(await work,'retry');
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM bb_material_versions WHERE owner_user_id=$1',[f.owner])).rows[0].n,0);
  f.blobs.readToFile=read;await f.pool.query('UPDATE bb_outbox SET next_attempt_at=NULL WHERE aggregate_id=$1',[u.id]);assert.equal(await runUploadConfirmationOnce(f.pool,f.blobs),'failed');
  const error=await f.send('POST',u.path,u.declaration,true);assert.equal(error.statusCode,422);assert.equal(error.json().code,'MATERIAL_CONTENT_MISMATCH');
  await f.reopen();assert.equal((await f.send('POST',u.path,u.declaration,true)).json().code,error.json().code);
  assert.equal((await f.send('POST',u.path,{...u.declaration,sha256:'a'.repeat(64)},true)).statusCode,409);
  f.foreign();assert.equal((await f.send('POST',u.path,u.declaration,true)).statusCode,404);
 }finally{blocked.release();await f.close();}
});

test('deleted projects/materials and deleting uploads cannot be resurrected by confirmation',options,async()=>{
 for(const mutation of ['upload','project','material']){
  const f=await fixture();try{
   const u=await f.upload();await f.send('POST',u.path,u.declaration,true);
   if(mutation==='material')assert.equal(await runUploadConfirmationOnce(f.pool,f.blobs),'completed');
   if(mutation==='upload')await f.pool.query("UPDATE bb_uploads SET state='deleting' WHERE id=$1",[u.id]);
   if(mutation==='project')await f.pool.query('UPDATE bb_projects SET deleted_at=now() WHERE id=$1',[f.id]);
   if(mutation==='material')await f.pool.query('UPDATE bb_material_versions SET deleted_at=now() WHERE upload_id=$1',[u.id]);
   assert.equal((await f.send('POST',u.path,u.declaration,true)).statusCode,404);
   if(mutation!=='material')assert.equal(await runUploadConfirmationOnce(f.pool,f.blobs),'failed');
   assert.equal((await f.pool.query('SELECT count(*)::int n FROM bb_material_versions WHERE owner_user_id=$1 AND deleted_at IS NULL',[f.owner])).rows[0].n,0);
  }finally{await f.close();}
 }
});

test('pin registration and actual Blob deletion share the object advisory critical section',options,async()=>{
 const f=await fixture();const readStarted=gate(),allowRead=gate();try{
  const u=await f.upload();await f.pool.query("UPDATE bb_uploads SET expires_at=now()-interval '1 day' WHERE id=$1",[u.id]);
  const get=f.blobs.getIfExists;f.blobs.getIfExists=async key=>{const bytes=await get(key);readStarted.release();await allowRead.wait;return bytes;};
  const cleanup=runStorageLifecycle(f.pool,f.blobs,{ownerScope:f.owner,materialRetentionDays:0,orphanUploadGraceHours:0});await readStarted.wait;
  // Registration rejects an orphan already committed as deleting, even before actual deletion.
  assert.equal((await f.send('POST',u.path,u.declaration,true)).statusCode,404);
  const c=await f.pool.connect();await c.query('BEGIN');await lockStorageObject(c,f.owner,u.key);
  allowRead.release();let deleted=false;const del=f.blobs.delete;f.blobs.delete=async key=>{deleted=true;await del(key);};
  await sleep(100);assert.equal(deleted,false,'actual delete waits for the shared object lock');
  await c.query('COMMIT');c.release();assert.equal((await cleanup).purged,1);assert.equal(deleted,true);
 }finally{allowRead.release();await f.close();}
});
