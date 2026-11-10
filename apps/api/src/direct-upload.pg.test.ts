import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { BlobServiceClient } from '@azure/storage-blob';
import { DIRECT_UPLOAD_TRANSPORT, UPLOAD_TRANSPORT_HEADER, UPLOAD_BYTES_PENDING_FIELD_ERROR, M1_UPLOAD_LIMITS } from '@bondbuddy/contracts';
import { createServer } from './server.js';
import { azureBlobs, digest } from './data.js';
import { docxSample, DOCX } from './upload-safety.samples.js';
import { isolatedTestDatabase } from './test-database.js';
import { runUploadConfirmationOnce } from './upload-confirmation.js';

const connection=await isolatedTestDatabase(undefined,'direct-upload');
const storage=process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const options={skip:!connection||!storage};
const negotiation={[UPLOAD_TRANSPORT_HEADER]:DIRECT_UPLOAD_TRANSPORT};
async function fixture(enabled=true){
 const pool=new Pool({connectionString:connection,options:'-c jit=off'}),owner='direct-'+randomUUID(),name='bb-direct-'+randomUUID().replaceAll('-','');
 const service=BlobServiceClient.fromConnectionString(storage!),container=service.getContainerClient(name),blobs=azureBlobs(storage!,name);
 let actor=owner,csrf=true;
 const make=()=>createServer({pool,blobs,directBlobUploads:enabled,allowedOrigin:'https://bondbuddy.test',principal:async()=>({userId:actor,csrfVerified:csrf})});
 let app=make();
 const send=(method:string,path:string,body?:unknown,headers:Record<string,string>={})=>app.inject({method:method as any,url:path,payload:body as any,headers:{origin:'https://bondbuddy.test',...(Buffer.isBuffer(body)?{'content-type':'application/octet-stream'}:{}),...headers}});
 const created=await send('POST','/api/v1/projects',{name:'Synthetic direct upload',kind:'update',issuer_name:null,market:null,offering:null});assert.equal(created.statusCode,201,created.body);
 const projectId=created.json().project_id,base=`/api/v1/projects/${projectId}/materials/uploads`;
 await pool.query("UPDATE bb_projects SET update_details=jsonb_build_object('authoring_mode','unified_v1') WHERE id=$1",[projectId]);
 const create=async(bytes:Buffer,change:Record<string,unknown>={},headers:Record<string,string>=negotiation)=>{
  const declaration={byte_size:bytes.length,sha256:digest(bytes)},r=await send('POST',base,{filename:'synthetic.docx',media_type:DOCX,role:'historical',...declaration,...change},headers);
  assert.equal(r.statusCode,201,r.body);return {session:r.json(),declaration:{...declaration,...Object.fromEntries(Object.entries(change).filter(([k])=>['byte_size','sha256'].includes(k)))} as typeof declaration,headers:r.headers};
 };
 const put=async(url:string,bytes:Buffer)=>{
  // Avoid assertion helpers or SDK errors that would print a signed URL.
  try {return await fetch(url,{method:'PUT',headers:{'Content-Type':'application/octet-stream','x-ms-blob-type':'BlockBlob','If-None-Match':'*'},body:new Uint8Array(bytes)});}
  catch {throw new Error('Synthetic Blob PUT failed');}
 };
 const complete=(u:Awaited<ReturnType<typeof create>>)=>send('POST',`${base}/${u.session.upload_id}/complete`,u.declaration,{prefer:'respond-async'});
 const noCalls=async()=>assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE owner_user_id=$1',[owner])).rows[0].n,0);
 return {pool,owner,blobs,container,base,create,put,complete,send,noCalls,foreign:()=>actor='foreign-'+randomUUID(),own:()=>actor=owner,csrf:(value:boolean)=>csrf=value,reopen:async()=>{await app.close();app=make();},close:async()=>{await noCalls();await app.close();await pool.end();await container.deleteIfExists();}};
}

for(const enabled of [false,true])test(`rolling compatibility: flag=${enabled}, legacy client keeps the 204 path`,options,async()=>{
 const f=await fixture(enabled);try{
  const bytes=await docxSample(),u=await f.create(bytes,{},enabled?{}:negotiation);
  assert.equal(u.session.upload_transport,undefined);assert.ok(u.session.upload_url.startsWith('/api/v1/'));
  assert.equal((await f.send('PUT',u.session.upload_url,bytes)).statusCode,204);
  assert.equal((await f.complete(u)).statusCode,202);assert.equal(await runUploadConfirmationOnce(f.pool,f.blobs),'completed');assert.equal((await f.complete(u)).statusCode,200);
 }finally{await f.close();}
});

test('HTTPS SAS is single-blob create-only; lost receipt/reopen confirms one material without overwrite',options,async()=>{
 const f=await fixture();try{
  const bytes=await docxSample([],Buffer.from(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic ${randomBytes(7*1024*1024).toString('base64')}</w:t></w:r></w:p></w:body></w:document>`));assert.ok(bytes.length>=6*1024*1024);
  const u=await f.create(bytes),target=new URL(u.session.upload_url),query=target.searchParams;
  assert.equal(u.session.upload_transport,DIRECT_UPLOAD_TRANSPORT);assert.equal(u.headers['cache-control'],'no-store');
  assert.equal(target.protocol,'https:');assert.equal(query.get('sp'),'c');assert.equal(query.get('sr'),'b');assert.equal(query.get('spr'),'https');assert.ok(Date.parse(query.get('se')!)<=Date.now()+15*60_000);
  const row=(await f.pool.query('SELECT * FROM bb_uploads WHERE id=$1',[u.session.upload_id])).rows[0];
  assert.equal(row.upload_transport,DIRECT_UPLOAD_TRANSPORT);assert.ok(!JSON.stringify(row).includes('sig='));
  assert.equal((await f.send('PUT',`${f.base}/${row.id}/bytes`,bytes)).statusCode,409);
  const pending=await f.complete(u);assert.equal(pending.statusCode,422);assert.deepEqual(pending.json().field_errors,[UPLOAD_BYTES_PENDING_FIELD_ERROR]);
  f.foreign();assert.equal((await f.complete(u)).statusCode,404);assert.equal((await f.send('POST',`${f.base}/${row.id}/session`,u.declaration,negotiation)).statusCode,404);f.own();
  f.csrf(false);assert.equal((await f.send('POST',`${f.base}/${row.id}/session`,u.declaration,negotiation)).statusCode,403);f.csrf(true);
  assert.equal((await f.send('POST',`${f.base}/${row.id}/session`,{...u.declaration,sha256:'f'.repeat(64)},negotiation)).statusCode,409);
  const refresh=await f.send('POST',`${f.base}/${row.id}/session`,u.declaration,negotiation);assert.equal(refresh.statusCode,200);assert.equal(refresh.json().upload_id,row.id);
  const preflight=await fetch(target.origin+target.pathname,{method:'OPTIONS',headers:{Origin:'https://bondbuddy.test','Access-Control-Request-Method':'PUT','Access-Control-Request-Headers':'content-type,x-ms-blob-type,if-none-match'}});
  // CORS is configured only on this synthetic storage service by the test setup.
  assert.equal(preflight.status,200);assert.equal(preflight.headers.get('access-control-allow-origin'),'https://bondbuddy.test');
  assert.equal((await f.put(u.session.upload_url,bytes)).status,201);
  const before=await f.blobs.headVersion!(row.object_key);
  assert.ok([403,409,412].includes((await f.put(u.session.upload_url,Buffer.from('replacement'))).status));
  assert.ok((await f.blobs.headVersion!(row.object_key))?.etag===before?.etag);
  assert.equal((await fetch(u.session.upload_url)).status,403);
  assert.equal((await fetch(u.session.upload_url,{method:'DELETE'})).status,403);
  const other=new URL(u.session.upload_url);other.pathname+='/different';assert.equal((await f.put(other.href,bytes)).status,403);
  await f.reopen();assert.equal((await f.complete(u)).statusCode,202);
  assert.equal((await f.pool.query('SELECT state FROM bb_uploads WHERE id=$1',[row.id])).rows[0].state,'uploading');
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM bb_material_versions WHERE owner_user_id=$1',[f.owner])).rows[0].n,0);
  assert.equal(await runUploadConfirmationOnce(f.pool,f.blobs),'completed');
  const saved=await f.complete(u);assert.equal(saved.statusCode,200,saved.body);assert.equal(saved.json().sha256,u.declaration.sha256);assert.equal(saved.json().byte_size,bytes.length);
  assert.equal((await f.complete(u)).json().material_id,saved.json().material_id);
  assert.equal((await f.send('POST',`${f.base}/${row.id}/session`,u.declaration,negotiation)).statusCode,409);
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM bb_material_versions WHERE owner_user_id=$1',[f.owner])).rows[0].n,1);
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM bb_upload_integrity_receipts WHERE owner_user_id=$1',[f.owner])).rows[0].n,1);
 }finally{await f.close();}
});

for(const kind of ['hash','size'] as const)test(`direct ${kind} mismatch is rejected, version safely removed, repeat complete remains terminal`,options,async()=>{
 const f=await fixture();try{
  const bytes=await docxSample();
  const u=await f.create(bytes,kind==='hash'?{sha256:'f'.repeat(64)}:kind==='size'?{byte_size:bytes.length-1}:{});
  assert.equal((await f.put(u.session.upload_url,bytes)).status,201);assert.equal((await f.complete(u)).statusCode,202);
  assert.equal(await runUploadConfirmationOnce(f.pool,f.blobs),'failed');
  const result=await f.complete(u);assert.ok([415,422].includes(result.statusCode));const repeated=await f.complete(u);assert.equal(repeated.statusCode,result.statusCode);assert.equal(repeated.json().message,result.json().message);assert.deepEqual(repeated.json().field_errors,result.json().field_errors);
  const row=(await f.pool.query('SELECT object_key,state FROM bb_uploads WHERE id=$1',[u.session.upload_id])).rows[0];assert.equal(row.state,'uploading');assert.equal(await f.blobs.exists(row.object_key),false);
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM bb_material_versions WHERE owner_user_id=$1',[f.owner])).rows[0].n,0);
 }finally{await f.close();}
});

test('100 MiB declaration bound is retained and direct signing refuses HTTP even for an emulator',options,async()=>{
 const f=await fixture();try{
  const r=await f.send('POST',f.base,{filename:'synthetic.docx',media_type:DOCX,role:'historical',byte_size:M1_UPLOAD_LIMITS.fileBytes+1,sha256:'f'.repeat(64)},negotiation);assert.equal(r.statusCode,422);
  const insecure=azureBlobs(storage!.replaceAll('https','http'),'never-created');
  await assert.rejects(insecure.createUploadUrl!('synthetic',new Date(Date.now()+60_000)),{status:503,code:'DATA_UNAVAILABLE'});
 }finally{await f.close();}
});

test('original bytes remain opaque; unsupported declaration is rejected without content sniffing or model calls',options,async()=>{
 const f=await fixture();try{
  const invalid=await f.send('POST',f.base,{filename:'synthetic.exe',media_type:'application/x-msdownload',role:'other',byte_size:10,sha256:'f'.repeat(64)},negotiation);assert.equal(invalid.statusCode,422);
  const opaque=Buffer.from('synthetic opaque original bytes; saving does not attest content safety'),u=await f.create(opaque);
  assert.equal((await f.put(u.session.upload_url,opaque)).status,201);assert.equal((await f.complete(u)).statusCode,202);assert.equal(await runUploadConfirmationOnce(f.pool,f.blobs),'completed');assert.equal((await f.complete(u)).statusCode,200);
 }finally{await f.close();}
});
test('SAS cannot bind size; an actual object above 100 MiB is refused and conditionally cleaned',options,async()=>{
 const f=await fixture();try{
  const actual=Buffer.alloc(M1_UPLOAD_LIMITS.fileBytes+1,120),u=await f.create(actual,{byte_size:M1_UPLOAD_LIMITS.fileBytes});
  assert.equal((await f.put(u.session.upload_url,actual)).status,201);assert.equal((await f.complete(u)).statusCode,202);
  assert.equal(await runUploadConfirmationOnce(f.pool,f.blobs),'failed');const rejected=await f.complete(u);assert.equal(rejected.statusCode,422);assert.equal(rejected.json().code,'MATERIAL_CONTENT_MISMATCH');
  const row=(await f.pool.query('SELECT object_key FROM bb_uploads WHERE id=$1',[u.session.upload_id])).rows[0];assert.equal(await f.blobs.exists(row.object_key),false);
 }finally{await f.close();}
});
