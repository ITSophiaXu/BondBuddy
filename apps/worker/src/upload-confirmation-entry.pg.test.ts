// Synthetic real PostgreSQL/Azurite, including the actual standalone process.
import assert from 'node:assert/strict';
import {spawn,type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {Pool} from 'pg';
import {BlobServiceClient} from '@azure/storage-blob';
import {createServer} from '@bondbuddy/api';
import {azureBlobs,digest} from '@bondbuddy/api/data';
import {isolatedTestDatabase} from './test-database.js';

const connection=await isolatedTestDatabase(undefined,'confirmation-entry');
const storage=process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check:()=>Promise<boolean>,ms=20000){const end=Date.now()+ms;while(!await check()){if(Date.now()>end)throw new Error('Synthetic standalone confirmation timed out');await pause(25);}}

test('standalone entry drains SIGTERM, leaves parse/run queues untouched and replays cached receipts',{skip:!connection||!storage,timeout:60000},async()=>{
  const pool=new Pool({connectionString:connection}),owner='confirm-entry-'+randomUUID(),container='bb943-'+randomUUID().replaceAll('-','');
  const blobs=azureBlobs(storage!,container),origin='http://bondbuddy.test';
  const app=createServer({pool,blobs,allowedOrigin:origin,principal:async()=>({userId:owner,csrfVerified:true})});
  const send=(method:string,url:string,payload?:any)=>app.inject({method:method as any,url,payload,headers:{origin,...(Buffer.isBuffer(payload)?{'content-type':'application/octet-stream'}:{}),...(url.endsWith('/complete')?{prefer:'respond-async'}:{})}});
  const root=await mkdtemp(join(tmpdir(),'bb-confirmation-entry-'));
  let child:ChildProcess|undefined,exited:Promise<number|null>|undefined,output='',locked=false;
  const blocker=await pool.connect();
  const start=()=>{
    child=spawn(process.execPath,[fileURLToPath(new URL('./upload-confirmation-runtime.js',import.meta.url))],{env:{PATH:process.env.PATH,TMPDIR:root,
      NODE_EXTRA_CA_CERTS:process.env.NODE_EXTRA_CA_CERTS,DATABASE_URL:connection,AZURE_STORAGE_CONNECTION_STRING:storage,BB_UPLOAD_CONFIRMATION_ENABLED:'1',BB_UPLOAD_CONFIRMATION_SMALL_SLOT:'0',BB_UPLOAD_CONFIRMATION_POLL_MS:'100',BB_UPLOAD_CONFIRMATION_CONTAINER:container,BB_UPLOAD_SPOOL_DIR:root,BB_UPLOAD_SPOOL_MAX_BYTES:'134217728'}});
    exited=new Promise(resolve=>child!.once('exit',code=>resolve(code)));
    child.stdout!.on('data',data=>{output+=String(data);});child.stderr!.on('data',data=>{output+=String(data);});
  };
  try{
    const project=await send('POST','/api/v1/projects',{name:'Synthetic standalone entry',kind:'update',issuer_name:null,market:null,offering:null});assert.equal(project.statusCode,201,project.body);
    const id=project.json().project_id;
    const upload=async(fill:number)=>{
      const bytes=Buffer.alloc(1024*1024,fill),declaration={byte_size:bytes.length,sha256:digest(bytes)};
      const created=await send('POST',`/api/v1/projects/${id}/materials/uploads`,{filename:`synthetic-${fill}.docx`,media_type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',role:'historical',...declaration});assert.equal(created.statusCode,201,created.body);
      const u=created.json(),path=`/api/v1/projects/${id}/materials/uploads/${u.upload_id}/complete`;
      assert.equal((await send('PUT',u.upload_url,bytes)).statusCode,204);
      assert.equal((await send('POST',path,declaration)).statusCode,202);
      return {id:u.upload_id,path,declaration};
    };
    const first=await upload(120),second=await upload(121);
    // Seed a legal queued run without executing it or invoking a provider.
    const hash='a'.repeat(64),run=randomUUID(),job=randomUUID();
    await pool.query("INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,1,$2,1,$3,'{}','[]','[]')",[id,owner,hash]);
    await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,1,$4,$1,'update',$4,'queued')",[run,owner,id,hash]);
    await pool.query("INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state) VALUES($1,$2,$3,'run','update','queued')",[job,owner,run]);
    await blocker.query('BEGIN');await blocker.query('SELECT id FROM bb_projects WHERE id=$1 FOR UPDATE',[id]);locked=true;
    start();
    await until(async()=>output.includes('"phase":"read"'));
    child!.kill('SIGTERM');await pause(300);
    assert.equal(child!.exitCode,null,'SIGTERM waits for the blocked commit, not early lease/spool release');
    assert.equal((await pool.query('SELECT state FROM bb_upload_confirmations WHERE upload_id=$1',[second.id])).rows[0].state,'queued');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_outbox WHERE aggregate_id=$1 AND lease_token IS NOT NULL',[first.id])).rows[0].n,1);
    await blocker.query('COMMIT');locked=false;
    assert.equal(await exited,0,output);
    assert.equal((await pool.query('SELECT state FROM bb_upload_confirmations WHERE upload_id=$1',[first.id])).rows[0].state,'completed');
    assert.equal((await pool.query('SELECT state FROM bb_upload_confirmations WHERE upload_id=$1',[second.id])).rows[0].state,'queued','no claim after SIGTERM');
    assert.deepEqual((await readdir(root)).filter(name=>name!=='.confirmation.lock'),[]);
    start();await until(async()=>(await pool.query("SELECT count(*)::int n FROM bb_upload_confirmations WHERE owner_user_id=$1 AND state='completed'",[owner])).rows[0].n===2);
    child!.kill('SIGTERM');assert.equal(await exited,0,output);
    const read=blobs.readToFile!;let reads=0;blobs.readToFile=async(...args)=>{reads++;return read(...args);};
    for(const u of [first,second]){
      const saved=await send('POST',u.path,u.declaration);assert.equal(saved.statusCode,200,saved.body);
      assert.equal(saved.json().sha256,u.declaration.sha256);
      assert.deepEqual((await send('POST',u.path,u.declaration)).json(),saved.json());
    }
    assert.equal(reads,0,'API polls use persisted full proof plus ETag, with no second full read');
    const jobs=(await pool.query('SELECT job_type,state,attempts,lease_token FROM bb_jobs WHERE owner_user_id=$1',[owner])).rows;
    assert.ok(jobs.some(j=>j.job_type==='parse'));assert.ok(jobs.some(j=>j.job_type==='run'));
    for(const j of jobs){assert.equal(j.state,'queued');assert.equal(j.attempts,0);assert.equal(j.lease_token,null);}
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE owner_user_id=$1',[owner])).rows[0].n,0);
    assert.match(output,/"phase":"inspection"/);assert.match(output,/"phase":"commit"/);assert.match(output,/"kind":"stopped"/);
    assert.doesNotMatch(output,/AccountKey|postgresql:|BlobEndpoint|synthetic-confirmation-only/);
  }finally{
    if(locked)await blocker.query('ROLLBACK');blocker.release();
    if(child&&child.exitCode===null){child.kill('SIGTERM');await exited;}
    await app.close();await pool.end();await BlobServiceClient.fromConnectionString(storage!).getContainerClient(container).deleteIfExists();
    await rm(root,{recursive:true,force:true});
  }
});
