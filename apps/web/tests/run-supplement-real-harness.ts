// Synthetic inputs; real main bundle, HTTP/session/CSRF, PostgreSQL and private disk bytes.
// Only the original queued run is seeded. No worker or external supplier is started.
import assert from 'node:assert/strict';
import {mkdir,readFile,readdir,stat,unlink,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {Pool} from 'pg';
import {emptyUpdateDetails,isM4Manifest,M4ManifestSchema,M4_DOCUMENT_BILLING_TASKS,m4DocumentInputIssues,ReviewDraftInputSchema,ReviewExecutionOriginSchema} from '@bondbuddy/contracts';
import {Value} from '@sinclair/typebox/value';
import type {FastifyRequest,FastifyReply} from 'fastify';
import {createServer} from '../../api/dist/server.js';
import {isolatedTestDatabase} from '../../api/dist/test-database.js';
import {digest,transaction,uid,type PrivateBlobs} from '../../api/dist/data.js';
import {creditBalance,grantCredits} from '../../api/dist/billing.js';
import {inputManifestHash} from '../../api/dist/production-rule-pin.js';
import {emptyM4Draft} from '../../api/dist/m4-workspace.js';
import {makeSyntheticDocxFixture} from '../../api/dist/docx-fixtures.js';
import {loadM4Knowledge} from '../../api/dist/m4-knowledge.js';
import {claim,finish} from '../../api/dist/queue.js';
import {syntheticReviewPair} from '../../api/dist/review-delivery-test-fixture.js';

export type RealSurface='m1'|'m3'|'m4';
export type RealFixture=Awaited<ReturnType<Awaited<ReturnType<typeof startRealSupplement>>['fixture']>>;

export async function startRealSupplement(){
  const template=process.env.BB_TEST_DATABASE_URL;
  assert.ok(template,'BB_TEST_DATABASE_URL must name the isolated local template');
  const local=new URL(template);
  assert.ok(['127.0.0.1','localhost'].includes(local.hostname)&&local.port==='15526','Use only the dedicated local PG port');
  const connection=await isolatedTestDatabase(undefined,'supplement-real-main');
  assert.ok(connection);
  const pool=new Pool({connectionString:connection});
  const baseURL='http://127.0.0.1:5198';
  const artifactRoot=process.env.BB_SUPPLEMENT_REAL_EVIDENCE_DIR||resolve(process.cwd(),'../../.local/supplement-preparation-real/evidence');
  const bytesRoot=join(artifactRoot,`private-bytes-${process.pid}`);
  await mkdir(bytesRoot,{recursive:true});
  const pathFor=(key:string)=>join(bytesRoot,digest(key));
  const getIfExists=async(key:string)=>{try{return await readFile(pathFor(key));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}};
  const blobs:PrivateBlobs={
    async put(key,bytes){await writeFile(pathFor(key),bytes,{mode:0o600});},
    async get(key){const b=await getIfExists(key);if(!b)throw new Error('Private object absent');return b;},
    getIfExists,
    async getIfExistsBounded(key,maxBytes){try{if((await stat(pathFor(key))).size>maxBytes)throw new Error('Private object exceeds read bound');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}return getIfExists(key);},
    async exists(key){return (await getIfExists(key))!==null;},
    async delete(key){try{await unlink(pathFor(key));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}},
  };
  const app=createServer({pool,blobs,allowedOrigin:baseURL,enableRunRuntime:true});
  const dist=resolve(process.cwd(),'dist');
  const html=await readFile(join(dist,'index.html'));
  const favicon=await readFile(join(dist,'favicon.svg'));
  const assets=new Map<string,Buffer>();
  for(const name of await readdir(join(dist,'assets')))assets.set(`/assets/${name}`,await readFile(join(dist,'assets',name)));
  app.get('/',async(_request:FastifyRequest,reply:FastifyReply)=>reply.type('text/html; charset=utf-8').send(html));
  app.get('/assets/*',async(request:FastifyRequest,reply:FastifyReply)=>{const path=new URL(request.url,baseURL).pathname,bytes=assets.get(path);if(!bytes)return reply.code(404).send();return reply.type(path.endsWith('.js')?'application/javascript':path.endsWith('.css')?'text/css':'application/octet-stream').send(bytes);});
  app.get('/favicon.ico',async(_request:FastifyRequest,reply:FastifyReply)=>reply.code(204).send());
  app.get('/favicon.svg',async(_request:FastifyRequest,reply:FastifyReply)=>reply.type('image/svg+xml').send(favicon));
  await app.listen({host:'127.0.0.1',port:5198});
  const owner=`real-main-${uid()}`,access=uid(),csrf=uid();
  await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,`real_${uid().replaceAll('-','').slice(0,20)}`]);
  await pool.query(`INSERT INTO bb_auth_sessions(id,user_id,access_hash,refresh_hash,csrf_hash,access_expires_at,refresh_expires_at)
    VALUES($1,$2,$3,$4,$5,now()+interval '1 hour',now()+interval '1 day')`,[uid(),owner,digest(access),digest(uid()),digest(csrf)]);
  await transaction(pool,db=>grantCredits(db,{owner,points:10000,key:`synthetic-${uid()}`,source:'existing_grant',expiresAt:null,actor:'synthetic-test',reason:'Nonempty ledger before real-main preparation'}));
  const headers={cookie:`bb_session=${access}; bb_csrf=${csrf}`,'x-bb-csrf':csrf,origin:baseURL};
  const request=async(method:string,path:string,body?:unknown)=>{
    const response=await fetch(`${baseURL}${path}`,{method,headers:{...headers,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const raw=await response.text();assert.ok(response.ok,`${method} ${path}: ${response.status} ${raw}`);return raw?JSON.parse(raw):null;
  };
  const upload=async(project:string,name:string,bytes:Buffer,role='other',media='text/plain')=>{
    const sha256=digest(bytes),declaration={filename:name,media_type:media,byte_size:bytes.length,sha256,role};
    const session=await request('POST',`/api/v1/projects/${project}/materials/uploads`,declaration);
    const written=await fetch(`${baseURL}${session.upload_url}`,{method:'PUT',headers:{...headers,'content-type':'application/octet-stream'},body:new Uint8Array(bytes)});
    assert.equal(written.status,204,await written.text());
    return request('POST',`/api/v1/projects/${project}/materials/uploads/${session.upload_id}/complete`,{byte_size:bytes.length,sha256});
  };
  const createProject=async(kind:string,name:string)=>request('POST','/api/v1/projects',{creation_request_id:uid(),name,kind,issuer_name:'合成测试发行人',market:'sse',offering:'private',update_details:{...emptyUpdateDetails(),authoring_mode:'unified_v1',reporting_cutoff:'2026-09-30'}});
  const fixture=async(surface:RealSurface,reviewUpdate=false)=>{
    const source=await createProject(surface==='m3'?'review':'update',`合成 ${surface.toUpperCase()} 补料主页面验收`);
    let projectId=source.project_id,topic:string|undefined;
    const sourceBytes=makeSyntheticDocxFixture({text:`Synthetic original material ${surface} ${uid()}`});
    const material=await upload(projectId,`synthetic-${surface}-original.docx`,sourceBytes,'other','application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    const basePin={material_id:material.material_id,material_version:material.material_version,sha256:material.sha256};
    const runId=uid(),jobId=uid();
    const reviewInput={source_material_ref:basePin,material_versions:[basePin],requirements:['Synthetic frozen review requirement'],as_of:'2026-09-30'};
    const origin={version:'review-execution-origin-v1',entrypoint:'quick_action',accepted_proposal:null,context_report_ref:null};
    assert.ok(Value.Check(ReviewDraftInputSchema,reviewInput),JSON.stringify([...Value.Errors(ReviewDraftInputSchema,reviewInput)]));
    assert.ok(Value.Check(ReviewExecutionOriginSchema,origin));
    if(reviewUpdate){
      assert.equal(surface,'m3');
      await request('PUT',`/api/v1/projects/${projectId}/review-draft`,{kind:'input',expected_version:0,input:reviewInput});
      const sourceRun=await request('POST',`/api/v1/projects/${projectId}/review-executions`,{execution_request_id:uid(),operation:'full_review',expected_input_version:1,source_report_id:null,expected_plan_version:null,finding_ids:[]});
      const lease=await claim(pool,120,{runKinds:['review']});assert.ok(lease);assert.equal(lease.runId,sourceRun.run_id,'Run this fixture before any other queued review journey');
      // Synthetic source result, real private bytes, promotion, checkpoint and finish.
      // This supplies the review-updates precondition; it is not model/Word acceptance evidence.
      const pair=await syntheticReviewPair(pool,lease,blobs);assert.ok(pair.status==='available');
      await finish(pool,lease,'succeeded',{artifactId:pair.artifactId,artifactVersion:pair.artifactVersion,blobs});
      const target=await request('POST',`/api/v1/projects/${projectId}/review-updates`,{execution_request_id:uid(),source_run_id:sourceRun.run_id,requirements:'Synthetic requirement from completed review file'});
      const row=(await pool.query('SELECT * FROM bb_runs WHERE id=$1',[target.run_id])).rows[0];
      const job=(await pool.query('SELECT * FROM bb_jobs WHERE run_id=$1',[target.run_id])).rows[0];
      const input=(await pool.query('SELECT manifest FROM bb_input_revisions WHERE project_id=$1 AND revision=$2',[projectId,row.input_revision])).rows[0];
      assert.ok(!input.manifest.review&&input.manifest.authoring?.review_result,'Use the real review-updates manifest shape');
      return {surface,projectId,sourceProject:source.project_id,basePin,sourceBytes,runId:target.run_id as string,jobId:job.id as string,topic,manifest:input.manifest,hash:row.input_hash.trim() as string,route:`/#/projects/${projectId}/review?tab=making&run=${target.run_id}`};
    }
    let manifest:any={project_kind:surface==='m3'?'review':'update',name:source.name,draft_revision:1,issuer_name:source.issuer_name,market:'sse',offering:'private',update_details:source.update_details,materials:[{...basePin,role:'other'}]};
    if(surface==='m3'){
      await request('PUT',`/api/v1/projects/${projectId}/review-draft`,{kind:'input',expected_version:0,input:reviewInput});
      manifest.review={version:'review_v1',operation:'full_review',report_id:uid(),version_number:1,draft_version:1,input:reviewInput,origin,context_messages:[],source_report_id:null,finding_ids:[],source_report_sha256:null};
    }
    if(surface==='m4'){
      const created=await request('POST','/api/v1/m4/topics',{creation_request_id:uid(),name:'合成 M4 单份文书补料验收',source_project_id:projectId,surface:'materials'});
      topic=created.topic.topic_id;projectId=created.topic.project_id;
      const pin={...basePin,source_project_id:source.project_id};
      const input={...emptyM4Draft('underwriter'),source_material:pin,materials:[pin],fields:{issuer_name:'合成测试发行人',market:'sse',offering:'private',broker:''},requirements:[]};
      assert.deepEqual(m4DocumentInputIssues(input),[],'M4 frozen input must satisfy the actual execution gate');
      await request('PUT',`/api/v1/m4/topics/${topic}/drafts/underwriter`,{expected_version:0,input});
      manifest={version:'m4-document-input-v1',kind:'document',project_name:source.name,topic_id:topic,execution_scope_project_id:source.project_id,draft_version:1,input,template_material:null,market:'sse',offering:'private',knowledge:loadM4Knowledge('sse','underwriter','private'),billing_task:M4_DOCUMENT_BILLING_TASKS.underwriter};
      assert.ok(isM4Manifest(manifest),JSON.stringify([...Value.Errors(M4ManifestSchema,manifest)]));
    }
    const hash=inputManifestHash(manifest),task=surface==='m4'?'generation':surface==='m3'?'review':'update';
    await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,1,$2,1,$3,$4,$5,'[]')`,[projectId,owner,hash,manifest,JSON.stringify(surface==='m4'?manifest.input.materials:manifest.materials)]);
    await pool.query('UPDATE bb_projects SET latest_input_revision=1 WHERE id=$1',[projectId]);
    await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage)
      VALUES($1,$2,$3,1,$4,$5,$6,$7,'queued','queued')`,[runId,owner,projectId,hash,uid(),task,digest(uid())]);
    await pool.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage,user_pause_requested,checkpoint)
      VALUES($1,$2,$3,$4,$5,'queued','queued',false,$6)`,[jobId,owner,runId,task,surface==='m4'?'m4_document_v1':'default',{synthetic_original_checkpoint:'seeded queued starting point'}]);
    if(surface==='m3')await pool.query(`INSERT INTO bb_review_executions(run_id,owner_user_id,project_id,version,operation,snapshot)
      VALUES($1,$2,$3,1,'full_review',$4)`,[runId,owner,projectId,{input:reviewInput,input_version:1,finding_ids:[],plan:null,origin,context_messages:[]}]);
    if(surface==='m4')await pool.query('INSERT INTO bb_m4_executions(run_id,owner_user_id,topic_id,manifest,input_hash) VALUES($1,$2,$3,$4,$5)',[runId,owner,topic,manifest,hash]);
    const route=surface==='m4'?`/#generate?topic=${topic}&run=${runId}`:surface==='m3'?`/#/projects/${projectId}/review?tab=making&run=${runId}`:`/#/projects/${projectId}?run=${runId}`;
    return {surface,projectId,sourceProject:source.project_id,basePin,sourceBytes,runId,jobId,topic,manifest,hash,route};
  };
  const evidence=async(f:{projectId:string;runId:string;jobId:string;topic?:string})=>{
    const scoped:Record<string,unknown>={};
    for(const [name,sql,arg] of [
      ['run','SELECT * FROM bb_runs WHERE id=$1',f.runId],['job','SELECT * FROM bb_jobs WHERE run_id=$1',f.runId],
      ['input','SELECT * FROM bb_input_revisions WHERE project_id=$1 ORDER BY revision',f.projectId],['project','SELECT * FROM bb_projects WHERE id=$1',f.projectId],
      ['reviewDraft','SELECT * FROM bb_review_drafts WHERE project_id=$1',f.projectId],['review','SELECT * FROM bb_review_executions WHERE run_id=$1',f.runId],
      ['m4Draft','SELECT * FROM bb_m4_drafts WHERE topic_id=$1',f.topic??''],['m4','SELECT * FROM bb_m4_executions WHERE run_id=$1',f.runId],
      ['attempts','SELECT * FROM bb_model_call_attempts WHERE job_id=$1 ORDER BY id',f.jobId],['events','SELECT * FROM bb_run_events WHERE run_id=$1 ORDER BY seq',f.runId],
      ['creditEvents','SELECT * FROM bb_credit_events WHERE owner_user_id=$1 ORDER BY id',owner],['reservations','SELECT * FROM bb_credit_reservations WHERE owner_user_id=$1 ORDER BY id',owner],
      ['lots','SELECT * FROM bb_credit_lots WHERE owner_user_id=$1 ORDER BY id',owner],['creditAccount','SELECT * FROM bb_credit_accounts WHERE owner_user_id=$1',owner],
      ['ownerJobs','SELECT * FROM bb_jobs WHERE owner_user_id=$1 ORDER BY id',owner],
      ['outbox','SELECT * FROM bb_outbox WHERE owner_user_id=$1 ORDER BY id',owner],
    ])scoped[name]=(await pool.query(sql,[arg])).rows;
    return {...scoped,balance:await creditBalance(pool,owner)};
  };
  const verifyBytes=async(f:{projectId:string},pin:{material_id:string;material_version:number;sha256:string},bytes:Buffer)=>{
    const row=(await pool.query('SELECT * FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4',[owner,f.projectId,pin.material_id,pin.material_version])).rows[0];
    assert.ok(row);assert.equal(row.sha256.trim(),digest(bytes));assert.equal(Number(row.byte_size),bytes.length);
    assert.deepEqual(await blobs.get(row.object_key),bytes);
    const response=await fetch(`${baseURL}/api/v1/projects/${f.projectId}/materials/${pin.material_id}/download?version=${pin.material_version}`,{headers});
    assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
    assert.equal((await fetch(`${baseURL}/api/v1/projects/${f.projectId}/materials/${pin.material_id}/download?version=${pin.material_version}`)).status,401,'Private bytes require an actual authenticated session');
  };
  let closed=false;
  return {baseURL,artifactRoot,pool,blobs,owner,csrf,access,headers,request,upload,fixture,evidence,verifyBytes,
    async close(){
      if(closed)return;closed=true;
      try{await app.close();}finally{await pool.end();}
      // Playwright may terminate workers without firing beforeExit. Drop only this
      // worker's clone, after closing every app/pool connection, never the template.
      const clone=new URL(connection),cloneName=decodeURIComponent(clone.pathname.slice(1)),templateName=decodeURIComponent(local.pathname.slice(1));
      const prefix=`${templateName.slice(0,40)}_t${process.pid}_`;
      assert.ok(clone.hostname===local.hostname&&clone.port==='15526'&&clone.port===local.port&&clone.username===local.username);
      assert.ok(cloneName!==templateName&&cloneName.startsWith(prefix)&&/^[a-zA-Z0-9_]+$/.test(cloneName)&&/^[a-f0-9]{8}$/.test(cloneName.slice(prefix.length)),'Refuse cleanup outside this worker local clone');
      const maintenance=new URL(clone);maintenance.pathname='/postgres';
      const cleanup=new Pool({connectionString:maintenance.toString(),max:1});
      try{await cleanup.query(`DROP DATABASE IF EXISTS "${cloneName}"`);}finally{await cleanup.end();}
    }};
}
