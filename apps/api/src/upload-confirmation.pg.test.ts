import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {test} from 'node:test';
import {Pool} from 'pg';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {BlobServiceClient} from '@azure/storage-blob';
import {createServer} from './server.js';
import {azureBlobs,digest,project,transaction,Problem} from './data.js';
import {docxSample,DOCX} from './upload-safety.samples.js';
import {claimUploadConfirmation,processUploadConfirmation,runUploadConfirmationOnce} from './upload-confirmation.js';
import {runStorageLifecycle} from './storage-lifecycle.js';
import {lockStorageObject} from './storage-object-lock.js';
import {isolatedTestDatabase} from './test-database.js';
import {UPLOAD_BYTES_PENDING_FIELD_ERROR} from '@bondbuddy/contracts';
import {UPLOAD_CONFIRMATION_SMALL_MAX_BYTES} from './upload-confirmation.js';
const connection=await isolatedTestDatabase(undefined,'async-confirmation');
const storage=process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const options={skip:!connection||!storage};
const execute=promisify(execFile);
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
function gate(){let release!:()=>void;const wait=new Promise<void>(r=>release=r);return {wait,release};}
async function fixture(){
  const pool=new Pool({connectionString:connection,options:'-c jit=off'}),owner='async-'+randomUUID(),container='bb-async-'+randomUUID().replaceAll('-','');
  const blobs=azureBlobs(storage!,container),origin='http://bondbuddy.test';let actor=owner;
  let app=createServer({pool,blobs,allowedOrigin:origin,principal:async()=>({userId:actor,csrfVerified:true})});
  const send=(method:string,url:string,payload?:unknown,async=false,headers:Record<string,string>={})=>app.inject({method:method as any,url,payload:payload as any,headers:{origin,...(Buffer.isBuffer(payload)?{'content-type':'application/octet-stream'}:{}),...(async?{prefer:'respond-async'}:{}),...headers}});
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
  return {pool,blobs,owner,id,container,upload,send,foreign:()=>actor='foreign-'+randomUUID(),own:()=>actor=owner,reopen:async()=>{const previous=app;app=createServer({pool,blobs,allowedOrigin:origin,principal:async()=>({userId:actor,csrfVerified:true})});await previous.close();},close:async()=>{await app.close();await pool.end();await BlobServiceClient.fromConnectionString(storage!).getContainerClient(container).deleteIfExists();}};
}

test('small and large claims partition the exact 16 MiB boundary before taking a lease',options,async()=>{
 const f=await fixture();try{
  const large=await f.upload(Buffer.alloc(UPLOAD_CONFIRMATION_SMALL_MAX_BYTES+1,120),'large.docx');
  const edge=await f.upload(Buffer.alloc(UPLOAD_CONFIRMATION_SMALL_MAX_BYTES,121),'edge.docx');
  const small=await f.upload(Buffer.from('synthetic small opaque bytes'),'small.docx');
  for(const u of [large,edge,small])assert.equal((await f.send('POST',u.path,u.declaration,true)).statusCode,202);
  const largeClaims=await Promise.all(Array.from({length:3},()=>claimUploadConfirmation(f.pool,120,'large')));
  assert.deepEqual(largeClaims.filter(Boolean).map(c=>c!.uploadId),[large.id]);
  for(const u of [edge,small])assert.equal((await f.pool.query('SELECT o.delivery_attempts FROM bb_outbox o JOIN bb_upload_confirmations c ON c.outbox_id=o.id WHERE c.upload_id=$1',[u.id])).rows[0].delivery_attempts,0,'large lane never leases or retries a small upload');
  const claims=await Promise.all(Array.from({length:3},()=>claimUploadConfirmation(f.pool,120,'small')));
  assert.deepEqual(claims.filter(Boolean).map(c=>c!.uploadId).sort(),[edge.id,small.id].sort());
  assert.equal((await f.pool.query('SELECT o.delivery_attempts FROM bb_outbox o JOIN bb_upload_confirmations c ON c.outbox_id=o.id WHERE c.upload_id=$1',[large.id])).rows[0].delivery_attempts,1);
  assert.equal(await claimUploadConfirmation(f.pool,120,'large'),null);
  assert.equal(await claimUploadConfirmation(f.pool,120,'small'),null);
  // Finish every lease created by this fixture: claims are intentionally global
  // within the test database, so pending work must not escape to the next test.
  for(const lease of [...claims,...largeClaims].filter((c):c is NonNullable<typeof c>=>c!==null))
    assert.equal(await processUploadConfirmation(f.pool,f.blobs,lease),'completed');
 }finally{await f.close();}
});

test('a small reuse pin cannot read a larger or changed canonical declaration',options,async()=>{
 const f=await fixture();try{
  const first=await f.upload();await f.send('POST',first.path,first.declaration,true);assert.equal(await runUploadConfirmationOnce(f.pool,f.blobs),'completed');
  const duplicate=await f.upload(first.bytes,'copy.docx');await f.send('POST',duplicate.path,duplicate.declaration,true);assert.equal(await runUploadConfirmationOnce(f.pool,f.blobs),'completed');
  // Corrupt legacy metadata cannot turn a small pin into an unbounded canonical read.
  await f.pool.query('UPDATE bb_material_versions SET byte_size=$2 WHERE upload_id=$1',[first.id,UPLOAD_CONFIRMATION_SMALL_MAX_BYTES+1]);
  await f.pool.query("UPDATE bb_upload_confirmations SET state='queued',result=NULL WHERE upload_id=$1",[duplicate.id]);
  await f.pool.query('UPDATE bb_outbox SET delivered_at=NULL WHERE id=(SELECT outbox_id FROM bb_upload_confirmations WHERE upload_id=$1)',[duplicate.id]);
  let reads=0;const read=f.blobs.readToFile!;f.blobs.readToFile=async(...args)=>{reads++;return read(...args);};
  assert.equal(await runUploadConfirmationOnce(f.pool,f.blobs,'small'),'retry');assert.equal(reads,0);
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM bb_material_versions WHERE owner_user_id=$1',[f.owner])).rows[0].n,1);
  await f.pool.query('UPDATE bb_material_versions SET byte_size=$2 WHERE upload_id=$1',[first.id,first.declaration.byte_size]);
  await f.pool.query('UPDATE bb_outbox SET next_attempt_at=NULL WHERE id=(SELECT outbox_id FROM bb_upload_confirmations WHERE upload_id=$1)',[duplicate.id]);
  assert.equal(await runUploadConfirmationOnce(f.pool,f.blobs,'small'),'completed');
 }finally{await f.close();}
});

test('a slow Blob PUT reports explicit pending bytes without holding the project lock or accepting confirmation',options,async()=>{
 const f=await fixture(),entered=gate(),blocked=gate();let put:ReturnType<typeof f.send>|undefined;
 const original=f.blobs.putFile!.bind(f.blobs);
 f.blobs.putFile=async(...args)=>{entered.release();await blocked.wait;return original(...args);};
 try{
  const bytes=await docxSample(),declaration={byte_size:bytes.length,sha256:digest(bytes)};
  const created=await f.send('POST',`/api/v1/projects/${f.id}/materials/uploads`,{...declaration,filename:'synthetic.docx',role:'historical',media_type:DOCX});assert.equal(created.statusCode,201,created.body);
  const uploadId=created.json().upload_id,path=`/api/v1/projects/${f.id}/materials/uploads/${uploadId}/complete`;
  put=f.send('PUT',created.json().upload_url,bytes);await entered.wait;
  const fast=async<T>(work:Promise<T>):Promise<T>=>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Pending bytes held a project lock')),1500);})]);}finally{clearTimeout(timer);}};
  const start=Date.now(),pending=await fast(f.send('POST',path,declaration,true));assert.equal(pending.statusCode,422,pending.body);assert.ok(Date.now()-start<1500);
  assert.equal(pending.json().code,'MATERIAL_UNREADABLE');assert.deepEqual(pending.json().field_errors,[UPLOAD_BYTES_PENDING_FIELD_ERROR]);
  const mismatch=await fast(f.send('POST',path,{...declaration,sha256:'f'.repeat(64)},true));assert.equal(mismatch.statusCode,409);assert.deepEqual(mismatch.json().field_errors,[]);
  f.foreign();const denied=await fast(f.send('POST',path,declaration,true));assert.equal(denied.statusCode,404);assert.deepEqual(denied.json().field_errors,[]);f.own();
  const revision=(await f.pool.query('SELECT draft_revision FROM bb_projects WHERE id=$1',[f.id])).rows[0].draft_revision;
  const patch=await fast(f.send('PATCH',`/api/v1/projects/${f.id}`,{name:'Synthetic edit while bytes are pending'},false,{'if-match':String(revision)}));assert.equal(patch.statusCode,200,patch.body);
  const u=(await f.pool.query('SELECT state,received_bytes FROM bb_uploads WHERE id=$1',[uploadId])).rows[0];assert.equal(u.state,'uploading');assert.equal(u.received_bytes,null);
  assert.equal((await f.pool.query("SELECT count(*)::int n FROM bb_outbox WHERE aggregate_id=$1 AND event_type='upload.complete_requested'",[uploadId])).rows[0].n,0);
  blocked.release();assert.equal((await put).statusCode,204);
  assert.equal((await f.send('POST',path,declaration,true)).statusCode,202);assert.equal(await runUploadConfirmationOnce(f.pool,f.blobs),'completed');
  const final=await f.send('POST',path,declaration,true);assert.equal(final.statusCode,200,final.body);assert.equal(final.json().sha256,declaration.sha256);
 }finally{blocked.release();if(put)await put.catch(()=>{});await f.close();}
});

test('31-second real Blob validation returns 202 quickly, survives reopen, and does not hold the project lock',options,async()=>{
 const f=await fixture();const blocked=gate(),started=gate();let work:Promise<string>|undefined;
 try{
  const big=await docxSample([],Buffer.from(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic ${randomBytes(17*1024*1024).toString('base64')}</w:t></w:r></w:p></w:body></w:document>`));
  const u=await f.upload(big);assert.ok(big.length>16*1024*1024);
  const begin=Date.now(),responses=await Promise.all([f.send('POST',u.path,u.declaration,true),f.send('POST',u.path,u.declaration,true)]);
  assert.ok(Date.now()-begin<2000);for(const r of responses){assert.equal(r.statusCode,202,r.body);assert.equal(r.json().upload_id,u.id);assert.equal(r.headers['retry-after'],'2');}
  assert.equal((await f.pool.query("SELECT count(*)::int n FROM bb_outbox WHERE aggregate_id=$1 AND event_type='upload.complete_requested'",[u.id])).rows[0].n,1);
  const read=f.blobs.readToFile!;f.blobs.readToFile=async(...args)=>{const proof=await read(...args);if(args[0]===u.key){started.release();await blocked.wait;}return proof;};
  work=runUploadConfirmationOnce(f.pool,f.blobs);await started.wait;
  await f.reopen();assert.equal((await f.send('POST',u.path,u.declaration,true)).statusCode,202);
  const saveStart=Date.now();await transaction(f.pool,async c=>{await c.query("SET LOCAL lock_timeout='1s'");await project(c,f.owner,f.id,true);await c.query('UPDATE bb_projects SET name=$2 WHERE id=$1',[f.id,'Synthetic concurrent save']);});
  const small=await f.upload(undefined,'small.docx');assert.equal((await f.send('POST',small.path,small.declaration,true)).statusCode,202);assert.ok(Date.now()-saveStart<2000);
  await f.pool.query("UPDATE bb_uploads SET expires_at=now()-interval '1 day' WHERE id=$1",[u.id]);
  const cleanup=await runStorageLifecycle(f.pool,f.blobs,{ownerScope:f.owner,materialRetentionDays:0,orphanUploadGraceHours:0});assert.equal(cleanup.orphanUploadsQueued,0);assert.equal(await f.blobs.exists(u.key),true);
  await sleep(31_000);blocked.release();assert.equal(await work,'completed');
  const final=await f.send('POST',u.path,u.declaration,true);assert.equal(final.statusCode,200,final.body);assert.equal(final.json().sha256,u.declaration.sha256);
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM bb_material_versions WHERE owner_user_id=$1 AND upload_id=$2',[f.owner,u.id])).rows[0].n,1);
  const event=(await f.pool.query("SELECT payload FROM bb_outbox WHERE aggregate_id=$1 AND event_type='upload.complete_requested'",[u.id])).rows[0].payload;
  assert.equal((await f.pool.query("SELECT trace_id FROM bb_operations WHERE request_id=$1 AND operation_kind='material_complete'",[event.request_id])).rows[0].trace_id,event.trace_id);
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
  const abandoned=await f.upload(undefined,'abandoned.docx');await f.send('POST',abandoned.path,abandoned.declaration,true);const child=await execute(process.execPath,['--input-type=module','-e',"import {Pool} from 'pg';import {claimUploadConfirmation} from '@bondbuddy/api/upload-confirmation';const p=new Pool({connectionString:process.env.DATABASE_URL,options:'-c jit=off'});try{console.log(JSON.stringify(await claimUploadConfirmation(p)))}finally{await p.end()}"],{env:{...process.env,DATABASE_URL:connection}});
  const lost=JSON.parse(child.stdout);assert.equal(lost.uploadId,abandoned.id);
  await f.reopen();await f.pool.query("UPDATE bb_outbox SET lease_until=now()-interval '1 second' WHERE id=$1",[lost.id]);
  const restarted=await execute(process.execPath,['--input-type=module','-e',"import {Pool} from 'pg';import {azureBlobs} from '@bondbuddy/api/data';import {runUploadConfirmationOnce} from '@bondbuddy/api/upload-confirmation';const p=new Pool({connectionString:process.env.DATABASE_URL,options:'-c jit=off'});try{console.log(await runUploadConfirmationOnce(p,azureBlobs(process.env.BB_TEST_AZURITE_CONNECTION_STRING,process.env.BB_TEST_CONTAINER)))}finally{await p.end()}"],{env:{...process.env,DATABASE_URL:connection,BB_TEST_CONTAINER:f.container}}).catch(()=>null);
  // Restarted subprocess shares only durable PG/Blob state.
  assert.ok(restarted);assert.equal(restarted.stdout.trim(),'completed');assert.equal((await f.send('POST',abandoned.path,abandoned.declaration,true)).statusCode,200);
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
  // Restore declared staging bytes for the existing lifecycle's deletion hash guard.
  await f.blobs.put(duplicate.key,duplicate.bytes,DOCX);
  await f.pool.query("UPDATE bb_uploads SET expires_at=now()-interval '1 day' WHERE id=$1",[duplicate.id]);
  assert.equal((await runStorageLifecycle(f.pool,f.blobs,{ownerScope:f.owner,materialRetentionDays:0,orphanUploadGraceHours:0})).purged,1);
  assert.equal(await f.blobs.exists(duplicate.key),false);
  assert.equal((await f.send('POST',duplicate.path,duplicate.declaration,true)).statusCode,200);
  assert.equal((await f.send('POST',duplicate.path,duplicate.declaration)).statusCode,200,'legacy sync replay keeps canonical receipt after staging purge');

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


test('temporary storage faults persist and recover, while exhausted retries return a durable failure',options,async()=>{
 const f=await fixture();try{
  const u=await f.upload();await f.send('POST',u.path,u.declaration,true);
  const read=f.blobs.readToFile!;f.blobs.readToFile=async()=>null;
  assert.equal(await runUploadConfirmationOnce(f.pool,f.blobs),'retry');
  const waiting=(await f.pool.query('SELECT state,last_error FROM bb_upload_confirmations WHERE upload_id=$1',[u.id])).rows[0];assert.equal(waiting.state,'queued');assert.equal(waiting.last_error.code,'DATA_UNAVAILABLE');
  await f.reopen();assert.equal((await f.send('POST',u.path,u.declaration,true)).statusCode,202);
  f.blobs.readToFile=read;await f.pool.query('UPDATE bb_outbox SET next_attempt_at=NULL WHERE aggregate_id=$1',[u.id]);assert.equal(await runUploadConfirmationOnce(f.pool,f.blobs),'completed');assert.equal((await f.send('POST',u.path,u.declaration,true)).statusCode,200);
  const exhausted=await f.upload(undefined,'exhausted.docx');await f.send('POST',exhausted.path,exhausted.declaration,true);f.blobs.readToFile=async()=>null;
  await f.pool.query('UPDATE bb_outbox SET delivery_attempts=11 WHERE aggregate_id=$1',[exhausted.id]);assert.equal(await runUploadConfirmationOnce(f.pool,f.blobs),'failed');
  assert.equal((await f.pool.query('SELECT state,error FROM bb_upload_confirmations WHERE upload_id=$1',[exhausted.id])).rows[0].error.code,'DATA_UNAVAILABLE');
  assert.equal(await runUploadConfirmationOnce(f.pool,f.blobs),'idle');
  f.blobs.readToFile=read;
  assert.equal((await f.send('POST',exhausted.path,exhausted.declaration,true)).statusCode,202,'same upload resumes after exhausted transient retries');
  assert.equal((await f.pool.query('SELECT last_error FROM bb_upload_confirmations WHERE upload_id=$1',[exhausted.id])).rows[0].last_error.code,'DATA_UNAVAILABLE');
  assert.equal(await runUploadConfirmationOnce(f.pool,f.blobs),'completed');assert.equal((await f.send('POST',exhausted.path,exhausted.declaration,true)).statusCode,200);
 }finally{await f.close();}
});


test('versionless private adapter returns final 200 after full-body proof rather than requeueing forever',options,async()=>{
 const f=await fixture();try{
  f.blobs.headVersion=undefined;
  const read=f.blobs.readToFile!;let reads=0;f.blobs.readToFile=async(...args)=>{reads++;const proof=await read(...args);return proof?{byteSize:proof.byteSize,sha256:proof.sha256}:null;};
  const u=await f.upload();assert.equal((await f.send('POST',u.path,u.declaration,true)).statusCode,202);assert.equal(await runUploadConfirmationOnce(f.pool,f.blobs),'completed');
  const fullReads=reads;const result=await f.send('POST',u.path,u.declaration,true);assert.equal(result.statusCode,200,result.body);assert.equal(reads,fullReads+1);assert.equal(result.json().sha256,u.declaration.sha256);
  await f.blobs.put(u.key,Buffer.alloc(u.bytes.length,120),DOCX);assert.equal((await f.send('POST',u.path,u.declaration,true)).statusCode,503);
 }finally{await f.close();}
});

test('completed requeue waits for the same-object deletion section and refuses deleted canonical material',options,async()=>{
 const f=await fixture();const headStarted=gate(),allowHead=gate();try{
  const u=await f.upload();await f.send('POST',u.path,u.declaration,true);assert.equal(await runUploadConfirmationOnce(f.pool,f.blobs),'completed');
  await f.blobs.put(u.key,u.bytes,DOCX); // New ETag requires a full-read refresh.
  const head=f.blobs.headVersion!;let once=true;f.blobs.headVersion=async key=>{const current=await head(key);if(once){once=false;headStarted.release();await allowHead.wait;}return current;};
  const pending=f.send('POST',u.path,u.declaration,true);await headStarted.wait;
  // Logical deletion commits before its physical purge, in the existing lock order.
  await transaction(f.pool,async c=>{await project(c,f.owner,f.id,true);await c.query('SELECT id FROM bb_uploads WHERE id=$1 FOR UPDATE',[u.id]);await c.query('UPDATE bb_material_versions SET deleted_at=now() WHERE upload_id=$1',[u.id]);});
  const deletion=await f.pool.connect();await deletion.query('BEGIN');await lockStorageObject(deletion,f.owner,u.key);await f.blobs.delete(u.key);
  allowHead.release();let settled=false;void pending.then(()=>settled=true);await sleep(100);assert.equal(settled,false);
  await deletion.query('COMMIT');deletion.release();
  const result=await pending;assert.equal(result.statusCode,404,result.body);
  assert.equal((await f.pool.query('SELECT state FROM bb_upload_confirmations WHERE upload_id=$1',[u.id])).rows[0].state,'completed','failed repin must not activate queued state');
 }finally{allowHead.release();await f.close();}
});


test('retry appends canonical B after A is logically deleted and retains A pin until terminal',options,async()=>{
 const f=await fixture();const started=gate(),blocked=gate();let work:Promise<string>|undefined;try{
  const a=await f.upload();const saved=await f.send('POST',a.path,a.declaration);assert.equal(saved.statusCode,200);
  const duplicate=await f.upload(a.bytes,'duplicate.docx');await f.send('POST',duplicate.path,duplicate.declaration,true);
  const head=f.blobs.headVersion!;let once=true;f.blobs.headVersion=async key=>{const version=await head(key);if(key===a.key&&once){once=false;started.release();await blocked.wait;}return version;};
  work=runUploadConfirmationOnce(f.pool,f.blobs);await started.wait;
  assert.equal((await f.pool.query('SELECT bb_upload_confirmation_bytes_pinned($1,$2) pinned',[f.owner,a.key])).rows[0].pinned,true);
  assert.equal((await f.send('DELETE',`/api/v1/projects/${f.id}/materials/${saved.json().material_id}`)).statusCode,204);
  const b=await f.upload(a.bytes,'canonical-b.docx');const newer=await f.send('POST',b.path,b.declaration);assert.equal(newer.statusCode,200,newer.body);
  blocked.release();assert.equal(await work,'retry');assert.equal((await f.pool.query('SELECT bb_upload_confirmation_bytes_pinned($1,$2) pinned',[f.owner,a.key])).rows[0].pinned,true);
  assert.equal((await f.pool.query('SELECT last_error FROM bb_upload_confirmations WHERE upload_id=$1',[duplicate.id])).rows[0].last_error.message,'UPLOAD_REVERIFY_REQUIRED','the changed canonical material, not a HEAD timeout, requires the retry');
  await f.pool.query('UPDATE bb_outbox SET next_attempt_at=NULL WHERE aggregate_id=$1',[duplicate.id]);assert.equal(await runUploadConfirmationOnce(f.pool,f.blobs),'completed');
  const pin=(await f.pool.query('SELECT canonical_object_keys FROM bb_upload_confirmations WHERE upload_id=$1',[duplicate.id])).rows[0];assert.deepEqual(pin.canonical_object_keys,[a.key,b.key]);
  const result=await f.send('POST',duplicate.path,duplicate.declaration,true);assert.equal(result.statusCode,200);assert.equal(result.json().material_id,newer.json().material_id);
 }finally{blocked.release();await work?.catch(()=>{});await f.close();}
});
