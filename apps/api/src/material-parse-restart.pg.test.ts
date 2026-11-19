import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {Pool} from 'pg';
import {isolatedTestDatabase} from './test-database.js';
import {createServer} from './server.js';
import {transaction} from './data.js';
import {enqueueMaterialParse,claimMaterialParse} from './material-jobs.js';
const connection=await isolatedTestDatabase();
test('material parse restart keeps the original job and checkpoints, joins duplicate requests, and enforces owner/version/terminal boundaries',{skip:!connection},async()=>{
 const pool=new Pool({connectionString:connection});let owner='restart-'+randomUUID();const originalOwner=owner,origin='http://bondbuddy.test';
 const app=createServer({pool,allowedOrigin:origin,principal:async()=>({userId:owner,csrfVerified:true}),enableSyntheticQueue:true});
 const send=(method:string,url:string,payload?:unknown)=>app.inject({method:method as any,url,headers:{origin},payload:payload as any});
 try{
  const response=await send('POST','/api/v1/projects',{name:'Synthetic parse restart',kind:'update',issuer_name:null,market:'sse',offering:'private'});
  assert.equal(response.statusCode,201,response.body);const project=response.json().project_id,upload=randomUUID(),material=randomUUID(),sha='a'.repeat(64);
  await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
   VALUES($1,$2,$3,'synthetic.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',10,$4,'historical',$5,now()+interval '1 hour','completed')`,[upload,owner,project,sha,'synthetic/'+upload]);
  await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
   VALUES($1,1,$2,$3,$4,'historical','synthetic.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',10,$5,$6,'parsed')`,[material,owner,project,upload,sha,'synthetic/'+material]);
  const job=await transaction(pool,c=>enqueueMaterialParse(c,{owner,projectId:project,materialId:material,materialVersion:1,sha256:sha,traceId:randomUUID()}));
  const checkpoint={stages:{parse_evidence:{snapshot_id:'synthetic-snapshot',parse_status:'parsed'}}};
  await pool.query("UPDATE bb_jobs SET state='paused',stage='awaiting_ocr',attempts=1,checkpoint=$2 WHERE id=$1",[job.jobId,checkpoint]);
  const url='/api/v1/projects/'+project+'/materials/'+material+'/parse-job/resume',body={job_id:job.jobId,material_version:1,material_sha256:sha};
  owner='foreign-'+randomUUID();assert.equal((await send('POST',url,body)).statusCode,404);owner=originalOwner;
  assert.equal((await send('POST',url,{...body,material_version:2})).statusCode,409);
  assert.equal((await send('POST',url,{...body,job_id:randomUUID()})).statusCode,409);
  assert.equal((await send('POST',url,{...body,material_sha256:'b'.repeat(64)})).statusCode,409);
  const replies=await Promise.all([send('POST',url,body),send('POST',url,body)]);
  for(const reply of replies){assert.equal(reply.statusCode,200,reply.body);assert.equal(reply.json().job_id,job.jobId);assert.equal(reply.json().state,'queued');}
  const stored=(await pool.query('SELECT state,attempts,checkpoint FROM bb_jobs WHERE id=$1',[job.jobId])).rows[0];
  assert.deepEqual(stored,{state:'queued',attempts:0,checkpoint});
  assert.equal((await pool.query("SELECT count(*)::int n FROM bb_job_events WHERE job_id=$1 AND type='material_parse.resumed'",[job.jobId])).rows[0].n,1);
  const lease=await claimMaterialParse(pool);assert.equal(lease?.jobId,job.jobId);assert.deepEqual(lease?.checkpoint,checkpoint);
  assert.equal((await send('POST',url,body)).json().state,'running');
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_jobs WHERE material_id=$1',[material])).rows[0].n,1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts')).rows[0].n,0);
  await pool.query("UPDATE bb_jobs SET state='succeeded',result='{}'::jsonb,lease_token=NULL,lease_until=NULL WHERE id=$1",[job.jobId]);
  assert.equal((await send('POST',url,body)).statusCode,409);
 }finally{await app.close();await pool.end();}
});
