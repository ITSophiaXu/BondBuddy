// Real local PG16/HTTPS Blob, real disk spools, actual runtime in a bounded cgroup.
// Generated opaque originals exercise byte/storage limits, not worst-case PDF parsing.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir,readdir,stat,rm} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {resolve,join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Pool} from 'pg';
import {BlobServiceClient} from '@azure/storage-blob';
import {DIRECT_UPLOAD_TRANSPORT,UPLOAD_TRANSPORT_HEADER} from '@bondbuddy/contracts';
import {createServer} from '../apps/api/dist/server.js';
import {azureBlobs} from '../apps/api/dist/data.js';
import {isolatedTestDatabase} from '../apps/api/dist/test-database.js';

const execute=promisify(execFile),root=resolve(process.argv[2]);assert.ok(process.argv[2]);
const storage=process.env.BB_TEST_AZURITE_CONNECTION_STRING,db=await isolatedTestDatabase(undefined,'confirmation-four-capacity');assert.ok(storage&&db);
assert.ok(['localhost','127.0.0.1'].includes(new URL(db).hostname));
const service=BlobServiceClient.fromConnectionString(storage);assert.ok(['localhost','127.0.0.1'].includes(new URL(service.url).hostname));
const network=process.env.BB_TEST_DOCKER_NETWORK;assert.ok(/^bb943-four-local-net$/.test(network));
const image='mcr.microsoft.com/azure-storage/azurite:3.35.0',owner='four-'+randomUUID(),container='bb-four-'+randomUUID().replaceAll('-','');
const pool=new Pool({connectionString:db}),blobs=azureBlobs(storage,container),origin='http://bondbuddy.test';
const app=createServer({pool,blobs,directBlobUploads:true,allowedOrigin:origin,principal:async()=>({userId:owner,csrfVerified:true})});
const send=(method,url,payload)=>app.inject({method,url,payload,headers:{origin,[UPLOAD_TRANSPORT_HEADER]:DIRECT_UPLOAD_TRANSPORT,...(url.endsWith('/complete')?{prefer:'respond-async'}:{})}});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,limit=120000){const end=Date.now()+limit;while(!await check()){if(Date.now()>end)throw Error('Isolated capacity wait timed out');await pause(100);}}
let currentName;const results=[];
try{
 await mkdir(root,{recursive:true,mode:0o700});
 const createUpload=async(project,fill,size)=>{
  const input=join(root,'input.bin'),hash=createHash('sha256'),chunk=Buffer.alloc(1024*1024,fill);
  await pipeline(Readable.from((function*(){for(let n=0;n<size;n+=chunk.length){const b=chunk.subarray(0,Math.min(chunk.length,size-n));hash.update(b);yield b;}})()),createWriteStream(input,{mode:0o600}));
  const declaration={sha256:hash.digest('hex'),byte_size:size};
  const made=await send('POST',`/api/v1/projects/${project}/materials/uploads`,{filename:'synthetic-'+fill+'.pdf',media_type:'application/pdf',role:'other',...declaration});assert.equal(made.statusCode,201,made.body);
  const id=made.json().upload_id,key=(await pool.query('SELECT object_key FROM bb_uploads WHERE id=$1',[id])).rows[0].object_key;
  await blobs.putFile(key,input,'application/pdf');await rm(input);
  const path=`/api/v1/projects/${project}/materials/uploads/${id}/complete`;
  return {id,key,path,declaration};
 };
 for(const mode of ['budget-gated','serial','four']){
  const concurrency=mode==='serial'?1:4,budget=(concurrency===4?448:128)*1024*1024;
  const dir=join(root,mode);await mkdir(dir,{mode:0o700});await mkdir(join(dir,'spool'),{mode:0o700});
  const p=await send('POST','/api/v1/projects',{name:'Synthetic confirmation capacity',kind:'update',issuer_name:null,market:null,offering:null});assert.equal(p.statusCode,201,p.body);
  const project=p.json().project_id,uploads=[];
  for(let index=0;index<4;index++)uploads.push(await createUpload(project,120+index,100*1024*1024));
  const small=await createUpload(project,124,16*1024*1024);uploads.push(small);
  for(const u of uploads.slice(0,mode==='budget-gated'?4:5))assert.equal((await send('POST',u.path,u.declaration)).statusCode,202);
  const internalDb=new URL(db);internalDb.hostname='bb943-four-local-pg';internalDb.port='5432';
  const internalStorage=storage.replace('https://127.0.0.1:25433/','https://bb943-four-local-azurite:10000/');
  // Share only the local Blob network namespace so its loopback-SAN TLS remains strict.
  const tlsStorage=internalStorage.replace('https://bb943-four-local-azurite:10000/','https://127.0.0.1:10000/');
  const env={DATABASE_URL:internalDb.href,AZURE_STORAGE_CONNECTION_STRING:tlsStorage,NODE_EXTRA_CA_CERTS:'/fixture/cert.pem',BB_UPLOAD_CONFIRMATION_ENABLED:'1',BB_UPLOAD_CONFIRMATION_CONCURRENCY:String(concurrency),BB_UPLOAD_CONFIRMATION_LANE:'general',BB_UPLOAD_CONFIRMATION_SMALL_SLOT:'1',BB_UPLOAD_CONFIRMATION_POLL_MS:'100',BB_UPLOAD_CONFIRMATION_CONTAINER:container,BB_UPLOAD_SPOOL_DIR:'/fixture/spool',BB_UPLOAD_SPOOL_MAX_BYTES:String(budget)};
  await writeFile(join(dir,'child.private.json'),JSON.stringify({env,gate:mode==='budget-gated'}),{mode:0o600});
  await writeFile(join(dir,'cert.pem'),await readFile(process.env.NODE_EXTRA_CA_CERTS),{mode:0o600});
  currentName='bb943-four-confirm-'+mode;
  const began=performance.now();
  await execute('docker',['run','-d','--name',currentName,'--label','bondbuddy.synthetic.owner=943-upload-four-20261114','--network','container:bb943-four-local-azurite','--user',`${process.getuid()}:${process.getgid()}`,'--memory','1536m','--memory-swap','1536m','--cpus','1','--read-only','--env','NODE_EXTRA_CA_CERTS=/fixture/cert.pem','--mount',`type=bind,src=${process.cwd()},dst=/work,readonly`,'--mount',`type=bind,src=${dir},dst=/fixture`,'--workdir','/work','--entrypoint','node',image,'--expose-gc','--max-old-space-size=384','scripts/upload-four-confirmation-child.mjs']);
  const getLogs=async()=>(await execute('docker',['logs',currentName])).stdout;
  await until(async()=>{const logs=await getLogs();if(/stopped:|Error:/.test(logs))throw Error('Child failed; retain stderr');return logs.includes('"kind":"started"');});
  let peakSpool=0;
  if(mode==='budget-gated'){
   await until(async()=>{const logs=await getLogs();return logs.split('\n').filter(s=>s.includes('"kind":"actual_read"')&&s.includes('104857600')).length===4;});
   const items=await readdir(join(dir,'spool'));for(const f of items)peakSpool+=(await stat(join(dir,'spool',f))).size;
   assert.equal(peakSpool,400*1024*1024);
   assert.equal((await pool.query("SELECT count(*)::int n FROM bb_outbox WHERE aggregate_id=ANY($1::text[]) AND lease_token IS NOT NULL",[uploads.slice(0,4).map(u=>u.id)])).rows[0].n,4);
   assert.equal((await send('POST',small.path,small.declaration)).statusCode,202);
   await until(async()=>(await pool.query('SELECT state FROM bb_upload_confirmations WHERE upload_id=$1',[small.id])).rows[0].state==='completed');
   assert.equal((await pool.query("SELECT count(*)::int n FROM bb_upload_confirmations WHERE upload_id=ANY($1::text[]) AND state='verifying'",[uploads.slice(0,4).map(u=>u.id)])).rows[0].n,4);
   await writeFile(join(dir,'release'),'release',{mode:0o600});
  }
  await until(async()=>(await pool.query("SELECT count(*)::int n FROM bb_upload_confirmations WHERE upload_id=ANY($1::text[]) AND state='completed'",[uploads.map(u=>u.id)])).rows[0].n===5);
  const elapsed=performance.now()-began;
  const cgroup=JSON.parse((await execute('docker',['exec',currentName,'node','-e',"const f=require('fs');console.log(JSON.stringify({current:f.readFileSync('/sys/fs/cgroup/memory.current','utf8'),peak:f.readFileSync('/sys/fs/cgroup/memory.peak','utf8'),events:f.readFileSync('/sys/fs/cgroup/memory.events','utf8')}))"])).stdout);
  await execute('docker',['stop','--time','30',currentName]);
  const logs=await getLogs();await writeFile(join(dir,'runtime.log'),logs,{mode:0o600});
  const state=JSON.parse((await execute('docker',['inspect',currentName])).stdout)[0];
  assert.equal(state.State.ExitCode,0);assert.equal(state.State.OOMKilled,false);assert.equal(state.HostConfig.Memory,1536*1024*1024);assert.equal(state.HostConfig.MemorySwap,state.HostConfig.Memory);assert.equal(state.HostConfig.NanoCpus,1e9);
  assert.match(cgroup.events,/oom_kill 0/);assert.ok(Number(cgroup.peak)<=state.HostConfig.Memory);
  const reads=logs.split('\n').filter(Boolean).map(s=>JSON.parse(s)).filter(s=>s.kind==='actual_read');
  assert.equal(reads.length,5);for(const u of uploads){const r=reads.find(r=>r.key===u.key);assert.equal(r.proof.sha256,u.declaration.sha256);assert.equal(r.proof.byteSize,u.declaration.byte_size);assert.ok(r.proof.etag);assert.ok(r.reserved_bytes<=budget);}
  if(mode==='budget-gated')assert.equal(reads.find(r=>r.key===small.key).reserved_bytes,416*1024*1024);
  assert.match(logs,/"kind":"stopped","reserved_bytes":0/);
  assert.deepEqual((await readdir(join(dir,'spool'))).filter(f=>f!=='.confirmation.lock'),[]);
  const integrity=[];
  for(const u of uploads){
   const saved=await send('POST',u.path,u.declaration);assert.equal(saved.statusCode,200,saved.body);
   assert.deepEqual((await send('POST',u.path,u.declaration)).json(),saved.json());
   const rows=(await pool.query('SELECT m.sha256,m.byte_size,r.object_etag FROM bb_material_versions m JOIN bb_upload_integrity_receipts r ON r.material_id=m.id AND r.material_version=m.version WHERE m.upload_id=$1',[u.id])).rows;assert.equal(rows.length,1);assert.equal(rows[0].sha256.trim(),u.declaration.sha256);assert.equal(Number(rows[0].byte_size),u.declaration.byte_size);assert.equal(rows[0].object_etag,reads.find(r=>r.key===u.key).proof.etag);integrity.push(rows[0]);
  }
  results.push({mode,concurrency,elapsed_ms:elapsed,peak_spool_observed_bytes:Math.max(peakSpool,...reads.map(r=>r.reserved_bytes)),cgroup,integrity,peak_actual_reads:Math.max(...reads.map(r=>r.peak_reads)),passed:true});
  await execute('docker',['rm',currentName]);currentName=undefined;
  for(const u of uploads)await blobs.delete(u.key);
 }
 const receipt={at:new Date().toISOString(),results,scope:'Same generated original bytes. Gated budget run is not a speed result; serial/four runs have no artificial delays. No model/parse jobs executed.',passed:true};
 await writeFile(join(root,'receipt.json'),JSON.stringify(receipt,null,2),{mode:0o600});console.log(JSON.stringify(receipt));
}finally{
 if(currentName){const mode=currentName.replace('bb943-four-confirm-','');await writeFile(join(root,mode,'release'),'cleanup',{mode:0o600}).catch(()=>{});await execute('docker',['stop','--time','30',currentName]).catch(()=>{});}
 await app.close();await pool.end();await service.getContainerClient(container).deleteIfExists();
}
