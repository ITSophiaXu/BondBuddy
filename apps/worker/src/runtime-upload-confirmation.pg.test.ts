// Synthetic local PG/Azurite verification. No supplier, customer file or model run.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {readdir,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {Pool} from 'pg';
import {BlobServiceClient} from '@azure/storage-blob';
import {createServer} from '@bondbuddy/api';
import {azureBlobs,digest} from '@bondbuddy/api/data';
import {WorkerRuntime} from './runtime.js';
import {isolatedTestDatabase} from './test-database.js';

const connection=await isolatedTestDatabase(undefined,'confirmation-reserved-slot');
const storage=process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const MiB=1024*1024;
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
function gate(){let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});return {wait,release};}
async function until(check:()=>Promise<boolean>,ms=15000){const end=Date.now()+ms;while(!await check()){if(Date.now()>end)throw new Error('Synthetic confirmation timed out');await sleep(25);}}

for(const smallSlot of [false,true])test(`one 71 MiB confirmation and a reserved small lane: enabled=${smallSlot}`,{skip:!connection||!storage},async()=>{
  const pool=new Pool({connectionString:connection,options:'-c jit=off'}),owner='reserved-'+randomUUID(),container='bb943-'+randomUUID().replaceAll('-','');
  const blobs=azureBlobs(storage!,container),origin='http://bondbuddy.test',blocked=gate(),started=gate();
  const app=createServer({pool,blobs,allowedOrigin:origin,principal:async()=>({userId:owner,csrfVerified:true})});
  const send=(method:string,url:string,payload?:any)=>app.inject({method:method as any,url,payload,headers:{origin,...(Buffer.isBuffer(payload)?{'content-type':'application/octet-stream'}:{}),...(url.endsWith('/complete')?{prefer:'respond-async'}:{})}});
  let runtime:WorkerRuntime|undefined;
  const before=process.env.BB_UPLOAD_SPOOL_MAX_BYTES;process.env.BB_UPLOAD_SPOOL_MAX_BYTES=String(128*MiB);
  try{
    const project=await send('POST','/api/v1/projects',{name:'Synthetic reserved confirmation',kind:'update',issuer_name:null,market:null,offering:null});assert.equal(project.statusCode,201,project.body);
    const projectId=project.json().project_id;
    await pool.query("UPDATE bb_projects SET update_details=jsonb_build_object('authoring_mode','unified_v1') WHERE id=$1",[projectId]);
    const upload=async(bytes:number,fill:number)=>{
      const body=Buffer.alloc(bytes,fill),declaration={byte_size:body.length,sha256:digest(body)};
      const created=await send('POST',`/api/v1/projects/${projectId}/materials/uploads`,{filename:`synthetic-${bytes}-${fill}.docx`,media_type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',role:'historical',...declaration});assert.equal(created.statusCode,201,created.body);
      const u=created.json();assert.equal((await send('PUT',u.upload_url,body)).statusCode,204);
      assert.equal((await send('POST',`/api/v1/projects/${projectId}/materials/uploads/${u.upload_id}/complete`,declaration)).statusCode,202);
      const row=(await pool.query('SELECT object_key FROM bb_uploads WHERE id=$1',[u.upload_id])).rows[0];
      return {id:u.upload_id,key:row.object_key,declaration};
    };
    const big=await upload(71*MiB,120),otherBig=await upload(71*MiB,121);
    const small=await Promise.all([upload(6*MiB,122),upload(233771,123),upload(147886,124)]);
    const read=blobs.readToFile!;let active=0,peak=0,peakSpoolBytes=0;
    const declarations=new Map([big,otherBig,...small].map(u=>[u.key,u.declaration.byte_size]));
    blobs.readToFile=async(key,path,limit,options)=>{
      assert.equal(limit,declarations.get(key),'actual read ceiling is the immutable declaration');
      active++;peak=Math.max(peak,active);
      try{
        if(small.some(u=>u.key===key))await started.wait;
        const proof=await read(key,path,limit,options);
        const root=process.env.BB_UPLOAD_SPOOL_DIR!;
        const sizes=await Promise.all((await readdir(root)).map(async name=>{try{return (await stat(join(root,name))).size;}catch{return 0;}}));
        peakSpoolBytes=Math.max(peakSpoolBytes,sizes.reduce((a,b)=>a+b,0));
        if(key===big.key){started.release();await blocked.wait;}return proof;
      }
      finally{active--;}
    };
    const events:Record<string,unknown>[]=[];
    runtime=new WorkerRuntime({pool,blobs,kinds:['parse'],concurrency:1,interactiveSlots:0,parseSlots:0,uploadConfirmationEnabled:true,uploadConfirmationSmallSlot:smallSlot,pollMs:100,drainMs:10000,heartbeatMs:1000,workerId:'synthetic943-'+randomUUID(),log:event=>events.push(event)});
    const start=Date.now();runtime.start();await started.wait;
    const savedSmall=async()=>Number((await pool.query("SELECT count(*)::int n FROM bb_material_versions WHERE owner_user_id=$1 AND upload_id=ANY($2::text[])",[owner,small.map(u=>u.id)])).rows[0].n);
    if(smallSlot){
      await until(async()=>await savedSmall()===small.length);
      assert.equal((await pool.query('SELECT state FROM bb_upload_confirmations WHERE upload_id=$1',[big.id])).rows[0].state,'verifying');
      assert.equal((await pool.query('SELECT o.delivery_attempts FROM bb_outbox o JOIN bb_upload_confirmations c ON c.outbox_id=o.id WHERE c.upload_id=$1',[otherBig.id])).rows[0].delivery_attempts,0,'small lane never claims another large object');
      assert.ok(peak<=2);assert.equal(peak,2);
      assert.ok(events.some(e=>e.kind==='upload_confirmation'&&e.lane==='small'&&e.outcome==='completed'));
    }else{
      await sleep(500);assert.equal(await savedSmall(),0,'serial baseline remains blocked by the large confirmation');assert.equal(peak,1);
    }
    const blockedElapsed=Date.now()-start;blocked.release();
    await until(async()=>Number((await pool.query("SELECT count(*)::int n FROM bb_upload_confirmations WHERE owner_user_id=$1 AND state='completed'",[owner])).rows[0].n)===5);
    await runtime.stop();runtime=undefined;
    assert.ok(peakSpoolBytes<=116*MiB);if(smallSlot)assert.ok(peakSpoolBytes>71*MiB);
    const rows=(await pool.query('SELECT u.id,u.byte_size,u.sha256,u.received_bytes,u.received_sha256,count(m.id)::int materials FROM bb_uploads u LEFT JOIN bb_material_versions m ON m.upload_id=u.id WHERE u.owner_user_id=$1 GROUP BY u.id',[owner])).rows;
    assert.equal(rows.length,5);for(const row of rows){assert.equal(row.materials,1);assert.equal(row.byte_size,row.received_bytes);assert.equal(row.sha256,row.received_sha256);}
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE owner_user_id=$1',[owner])).rows[0].n,0);
    console.log(JSON.stringify({synthetic:true,small_slot:smallSlot,bulk_bytes:71*MiB,small_completed_before_bulk:smallSlot?small.length:0,peak_reads:peak,peak_spool_bytes:peakSpoolBytes,blocked_observation_ms:blockedElapsed}));
  }finally{
    blocked.release();await runtime?.stop();await app.close();await pool.end();await BlobServiceClient.fromConnectionString(storage!).getContainerClient(container).deleteIfExists();
    if(before===undefined)delete process.env.BB_UPLOAD_SPOOL_MAX_BYTES;else process.env.BB_UPLOAD_SPOOL_MAX_BYTES=before;
  }
});
