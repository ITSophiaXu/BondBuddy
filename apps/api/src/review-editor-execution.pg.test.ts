// Synthetic materials/editor bodies; real PostgreSQL, lease locks, Word promotion,
// terminal delivery receipts and HTTP. No real provider or professional review.
import assert from 'node:assert/strict';
import test from 'node:test';
import {Pool,type PoolClient} from 'pg';
import type {ReviewEditorSnapshot,ReviewExportRequest} from '@bondbuddy/contracts';
import {digest,Problem,uid,type PrivateBlobs} from './data.js';
import {makeSyntheticDocxFixture} from './docx-fixtures.js';
import {inputManifestHash} from './production-rule-pin.js';
import {checkpointStage,finish,promoteWordArtifact,type Lease} from './queue.js';
import {registerReviewEditorSnapshot,resolveReviewEditorExecution,reviewEditor,reviewEditorExecution} from './review-editor.js';
import {createServer} from './server.js';
import {isolatedTestDatabase} from './test-database.js';

const connection=await isolatedTestDatabase(undefined,'review-editor-execution');
const conflict=(error:unknown)=>error instanceof Problem&&error.status===409&&error.code==='INPUT_REVISION_CONFLICT';
const missing=(error:unknown)=>error instanceof Problem&&error.status===404;
const unavailable=(error:unknown)=>error instanceof Problem&&error.status===503&&error.code==='DATA_UNAVAILABLE';

async function context(testChannel=false){
  const pool=new Pool({connectionString:connection}),owner=uid(),projectId=uid(),runId=uid(),jobId=uid(),token=uid();
  const objects=new Map<string,Buffer>();
  const blobs:PrivateBlobs={put:async(key,bytes)=>{objects.set(key,Buffer.from(bytes));},
    get:async key=>{const bytes=objects.get(key);assert.ok(bytes);return Buffer.from(bytes);},
    getIfExists:async key=>objects.get(key)??null,
    getIfExistsBounded:async(key,limit)=>{const bytes=objects.get(key);assert.ok(!bytes||bytes.length<=limit);return bytes??null;},
    exists:async key=>objects.has(key),delete:async key=>{objects.delete(key);}};
  await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,`editor_${uid().replaceAll('-','').slice(0,20)}`]);
  await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic execution editor','review')",[projectId,owner]);
  const materialId=uid(),uploadId=uid(),bytes=Buffer.from('Synthetic source PDF registration'),sourceHash=digest(bytes);
  const sourceKey=`users/${owner}/projects/${projectId}/materials/${materialId}`;
  await blobs.put(sourceKey,bytes,'application/pdf');
  await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
    VALUES($1,$2,$3,'synthetic-source.pdf','application/pdf',$4,$5,'other',$6,now()+interval '1 hour','completed')`,
    [uploadId,owner,projectId,bytes.length,sourceHash,`users/${owner}/uploads/${uploadId}`]);
  await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
    VALUES($1,1,$2,$3,$4,'other','synthetic-source.pdf','application/pdf',$5,$6,$7,'persisted')`,
    [materialId,owner,projectId,uploadId,bytes.length,sourceHash,sourceKey]);
  const pin={material_id:materialId,material_version:1,sha256:sourceHash};
  const input={source_material_ref:pin,material_versions:[pin],requirements:['Synthetic exact source'],as_of:null};
  const origin={version:'review-execution-origin-v1',entrypoint:'quick_action',accepted_proposal:null,context_report_ref:null};
  const manifest={draft_revision:1,project_kind:'review',materials:[{...pin,role:'other'}],review:{version:'review_v1',
    operation:'full_review',version_number:1,report_id:uid(),source_report_id:null,source_report_sha256:null,finding_ids:[],input,origin,
    file_delivery:{version:'review-correction-v2',knowledge:[]}}};
  const hash=inputManifestHash(manifest);
  await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
    VALUES($1,1,$2,1,$3,$4,$5,'[]')`,[projectId,owner,hash,manifest,JSON.stringify(manifest.materials)]);
  await pool.query('UPDATE bb_projects SET latest_input_revision=1 WHERE id=$1',[projectId]);
  const grantId=testChannel?uid():null,channel=testChannel?'non_production_test':'production';
  if(grantId)await pool.query(`INSERT INTO bb_non_production_test_grants(grant_id,user_id,project_id,input_revision,input_hash,
    sample_manifest_sha256,taxonomy_hash,rule_pack_hash,granted_by,reason,expires_at)
    VALUES($1,$2,$3,1,$4,$4,$4,$4,'synthetic','execution editor boundaries',now()+interval '1 day')`,[grantId,owner,projectId,hash]);
  await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage,channel,test_grant_id)
    VALUES($1,$2,$3,1,$4,$5,'review',$4,'running','word_delivery',$6,$7)`,[runId,owner,projectId,hash,uid(),channel,grantId]);
  await pool.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage,lease_token,lease_until,attempts,channel,test_grant_id)
    VALUES($1,$2,$3,'review','default','running','word_delivery',$4,now()+interval '10 minutes',1,$5,$6)`,[jobId,owner,runId,token,channel,grantId]);
  await pool.query(`INSERT INTO bb_review_executions(run_id,owner_user_id,project_id,version,operation,snapshot)
    VALUES($1,$2,$3,1,'full_review',$4)`,[runId,owner,projectId,{input,origin,finding_ids:[],input_version:1}]);
  const lease:Lease={owner,runId,jobId,token,checkpoint:{},attempts:1,executionVersion:1,inputRevision:1,inputHash:hash};
  const snapshot:ReviewEditorSnapshot={version:'review-editor-v1',source_filename:'synthetic-source.pdf',source_sha256:sourceHash,source_format:'pdf',
    warnings:['合成材料，仅验证版本边界。'],paragraphs:[{id:'p1',text:'Synthetic original paragraph.'}],issues:[{id:'issue-1',decision:'suggested',
      manual_text:'',category:'synthetic',title:'Synthetic correction',original:'Synthetic original paragraph.',replacement:'Synthetic corrected paragraph.',
      reason:'Synthetic reason',evidence:'Synthetic evidence',missing:'',uncertain:false,paragraph_id:'p1',applied:true,limitation:''}]};
  let principal:string=owner;
  const app=createServer({pool,blobs,allowedOrigin:'http://bondbuddy.test',principal:async()=>({userId:principal,csrfVerified:true})});
  const url=`/api/v1/projects/${projectId}/review-executions/${runId}/editor`;
  const get=(query='')=>app.inject({method:'GET',url:url+query});
  const post=(body:unknown)=>app.inject({method:'POST',url:`/api/v1/projects/${projectId}/review-exports`,payload:body as any,headers:{origin:'http://bondbuddy.test'}});
  const publish=async()=>{
    const revision=await promoteWordArtifact(pool,lease,makeSyntheticDocxFixture({text:`Synthetic revision ${runId}`}),blobs,'generated_pair_v1');
    const clean=await promoteWordArtifact(pool,lease,makeSyntheticDocxFixture({text:`Synthetic clean ${runId}`}),blobs,'generated_pair_v1');
    assert.equal(revision.status,'available');assert.equal(clean.status,'available');
    if(revision.status!=='available'||clean.status!=='available')throw Error('Synthetic Word unavailable');
    await checkpointStage(pool,lease,'word_delivery_pair',{revision_artifact_id:revision.artifactId,clean_artifact_id:clean.artifactId});
    const result=await finish(pool,lease,testChannel?'test_completed':'succeeded',{artifactId:revision.artifactId,artifactVersion:1,blobs});
    assert.equal(result.state,testChannel?'test_completed':'succeeded');return {revision,clean};
  };
  return {pool,owner,projectId,runId,jobId,hash,manifest,lease,snapshot,blobs,grantId,app,url,get,post,publish,
    principal:(value:string)=>{principal=value;},close:async()=>{await app.close();await pool.end();}};
}
type Context=Awaited<ReturnType<typeof context>>;
async function rows(f:Context){
  return (await f.pool.query(`SELECT e.*,l.created_at=e.created_at AND l.snapshot=e.snapshot AND l.sha256=e.sha256 AS mirror_exact
    FROM bb_review_execution_editors e JOIN bb_review_editors l USING(owner_user_id,project_id,run_id) WHERE e.run_id=$1`,[f.runId])).rows;
}
async function rolledBack(f:Context,work:(client:PoolClient)=>Promise<void>){
  const client=await f.pool.connect();
  try{await client.query('BEGIN');await work(client);}finally{await client.query('ROLLBACK');client.release();}
}

test('trusted registration is immutable, exact replay preserves its V1 mirror, and only final delivery exposes the editor',
  {skip:!connection,timeout:30000},async t=>{
    const f=await context();t.after(f.close);
    assert.equal((await f.get()).statusCode,404);
    await registerReviewEditorSnapshot(f.pool,f.lease,f.projectId,f.snapshot);
    const saved=await rows(f);assert.equal(saved.length,1);assert.equal(saved[0].mirror_exact,true);
    assert.equal(saved[0].execution_version,1);assert.equal(saved[0].input_revision,1);assert.equal(saved[0].input_hash,f.hash);
    assert.equal(saved[0].sha256,inputManifestHash(f.snapshot));assert.deepEqual(saved[0].snapshot,f.snapshot);
    await registerReviewEditorSnapshot(f.pool,f.lease,f.projectId,structuredClone(f.snapshot));
    assert.deepEqual(await rows(f),saved);
    const changed=structuredClone(f.snapshot);changed.issues[0].replacement='Different synthetic correction';
    await assert.rejects(registerReviewEditorSnapshot(f.pool,f.lease,f.projectId,changed),conflict);
    assert.deepEqual(await rows(f),saved);
    assert.equal((await f.get()).statusCode,404,'a candidate editor is private before the real terminal receipt');
    await f.publish();
    for(const query of ['', '?execution_version=1']){
      const response=await f.get(query);assert.equal(response.statusCode,200,response.body);
      assert.equal(response.headers['cache-control'],'private, no-store');
      assert.deepEqual(response.json(),{run_id:f.runId,sha256:saved[0].sha256,snapshot:f.snapshot,execution:reviewEditorExecution(f.lease)});
    }
  });

test('expired, cancelled, wrong-token and wrong-identity writers cannot create either editor table row',
  {skip:!connection,timeout:30000},async t=>{
    for(const defect of ['expired','cancelled','paused','token','version','revision','hash','source','owner'] as const){
      const f=await context();t.after(f.close);const lease={...f.lease},snapshot=structuredClone(f.snapshot);
      if(defect==='expired')await f.pool.query("UPDATE bb_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[f.jobId]);
      if(defect==='cancelled')await f.pool.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1",[f.runId]);
      if(defect==='paused')await f.pool.query("UPDATE bb_jobs SET state='paused' WHERE id=$1",[f.jobId]);
      if(defect==='token')lease.token=uid();
      if(defect==='version')lease.executionVersion=2;
      if(defect==='revision')lease.inputRevision=2;
      if(defect==='hash')lease.inputHash=digest('different synthetic input');
      if(defect==='source')snapshot.source_sha256=digest('different synthetic source');
      if(defect==='owner')lease.owner=uid();
      await assert.rejects(registerReviewEditorSnapshot(f.pool,lease,f.projectId,snapshot),error=>conflict(error)||(defect==='owner'&&missing(error)));
      for(const table of ['bb_review_execution_editors','bb_review_editors'])assert.equal((await f.pool.query(`SELECT 1 FROM ${table} WHERE run_id=$1`,[f.runId])).rowCount,0,defect);
    }
  });

test('HTTP query, ownership and live delivery gates preserve history while retaining the current V1 input-integrity gate',
  {skip:!connection,timeout:30000},async t=>{
    const f=await context();t.after(f.close);await registerReviewEditorSnapshot(f.pool,f.lease,f.projectId,f.snapshot);const pair=await f.publish();
    for(const value of ['0','-1','1.5','NaN','2147483648','9007199254740993','1e0','','01']){
      const response=await f.get(`?execution_version=${value}`);assert.equal(response.statusCode,422,`${value}: ${response.body}`);
    }
    assert.equal((await f.get('?execution_version=1&execution_version=1')).statusCode,422);
    assert.equal((await f.get('?unknown=1')).statusCode,422);
    assert.equal((await f.get('?execution_version=2')).statusCode,404);
    f.principal(uid());assert.equal((await f.get()).statusCode,404);f.principal(f.owner);
    const otherProject=uid();await f.pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic other project','review')",[otherProject,f.owner]);
    assert.equal((await f.app.inject({method:'GET',url:`/api/v1/projects/${otherProject}/review-executions/${f.runId}/editor`})).statusCode,404);
    const manifest={...f.manifest,synthetic_projection:'later input'},hash=inputManifestHash(manifest);
    await f.pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,2,$2,1,$3,$4,$5,'[]')`,[f.projectId,f.owner,hash,manifest,JSON.stringify(manifest.materials)]);
    await f.pool.query('UPDATE bb_projects SET latest_input_revision=2 WHERE id=$1',[f.projectId]);
    await assert.rejects(f.pool.query('UPDATE bb_runs SET input_revision=2,input_hash=$2 WHERE id=$1',[f.runId,hash]),{code:'23514'},
      'the existing immutable run-origin gate still prevents input adoption');
    assert.deepEqual(await resolveReviewEditorExecution(f.pool,f.owner,f.projectId,f.runId),{
      executionVersion:1,inputRevision:1,inputHash:f.hash},'source identity is never inferred from the project latest input');
    await f.pool.query("UPDATE bb_runs SET state='paused',artifact_id=NULL,artifact_version=NULL WHERE id=$1",[f.runId]);
    const historical=await f.get();assert.equal(historical.statusCode,200,historical.body);
    assert.deepEqual(historical.json().execution,reviewEditorExecution(f.lease));
    assert.deepEqual(await resolveReviewEditorExecution(f.pool,f.owner,f.projectId,f.runId),{
      executionVersion:1,inputRevision:1,inputHash:f.hash});
    await f.pool.query("UPDATE bb_artifact_versions SET delivery_status='revoked' WHERE id=$1",[pair.clean.artifactId]);
    assert.equal((await f.get()).statusCode,404,'revoking any frozen delivery member closes editor visibility');
  });

test('missing canonical storage never falls back to legacy and damaged storage fails closed',
  {skip:!connection,timeout:30000},async t=>{
    const f=await context();t.after(f.close);await registerReviewEditorSnapshot(f.pool,f.lease,f.projectId,f.snapshot);await f.publish();
    await rolledBack(f,async client=>{
      // Reproduce impossible historical missing storage only in this private
      // clone transaction. A real deletion now requires its policy and receipt;
      // restore both guards before exercising the reader, then roll back all.
      await client.query('ALTER TABLE bb_review_execution_editors DISABLE TRIGGER bb_review_execution_editor_immutable');
      await client.query('ALTER TABLE bb_review_execution_editors DISABLE TRIGGER bb_review_body_deleted');
      await client.query('DELETE FROM bb_review_execution_editors WHERE run_id=$1',[f.runId]);
      await client.query('ALTER TABLE bb_review_execution_editors ENABLE TRIGGER bb_review_body_deleted');
      await client.query('ALTER TABLE bb_review_execution_editors ENABLE TRIGGER bb_review_execution_editor_immutable');
      assert.equal((await client.query('SELECT 1 FROM bb_review_editors WHERE run_id=$1',[f.runId])).rowCount,1);
      await assert.rejects(reviewEditor(client,f.owner,f.projectId,f.runId,f.lease),missing);
    });
    await rolledBack(f,async client=>{
      await client.query('ALTER TABLE bb_review_execution_editors DISABLE TRIGGER bb_review_execution_editor_immutable');
      await client.query(`UPDATE bb_review_execution_editors SET snapshot=jsonb_set(snapshot,'{source_filename}','"Synthetic changed filename"') WHERE run_id=$1`,[f.runId]);
      await client.query('ALTER TABLE bb_review_execution_editors ENABLE TRIGGER bb_review_execution_editor_immutable');
      await assert.rejects(reviewEditor(client,f.owner,f.projectId,f.runId,f.lease),unavailable);
    });
    assert.equal((await f.get()).statusCode,200,'corruption is confined to rolled-back disposable clone transactions');
  });

test('old and pinned export requests freeze the source edition without changing old idempotency bodies or creating model charges',
  {skip:!connection,timeout:30000},async t=>{
    for(const pinned of [false,true]){
      const f=await context();t.after(f.close);await registerReviewEditorSnapshot(f.pool,f.lease,f.projectId,f.snapshot);await f.publish();
      const body:ReviewExportRequest={request_id:uid(),source_run_id:f.runId,expected_editor_sha256:inputManifestHash(f.snapshot),
        decisions:[{id:'issue-1',decision:'manual',manual_text:'Synthetic explicit final wording.'}],
        ...(pinned?{source_execution:reviewEditorExecution(f.lease)}:{})};
      const original=JSON.stringify(body),first=await f.post(body);assert.equal(first.statusCode,200,first.body);const result=first.json();
      assert.equal(JSON.stringify(body),original);
      assert.equal((await f.post(body)).json().run_id,result.run_id);
      const stored=(await f.pool.query(`SELECT r.*,i.manifest,e.snapshot FROM bb_runs r
        JOIN bb_input_revisions i ON i.owner_user_id=r.owner_user_id AND i.project_id=r.project_id AND i.revision=r.input_revision
        JOIN bb_review_execution_snapshots e ON e.owner_user_id=r.owner_user_id AND e.run_id=r.id AND e.execution_version=1
        WHERE r.id=$1`,[result.run_id])).rows[0];
      assert.ok(stored);assert.notEqual(stored.input_hash,f.hash);assert.equal(stored.input_revision,2);
      assert.deepEqual(stored.manifest.review.file_delivery.export.source_execution,reviewEditorExecution(f.lease));
      assert.deepEqual(stored.snapshot.source_execution,reviewEditorExecution(f.lease));
      assert.equal(stored.request_hash,inputManifestHash({project_id:f.projectId,...body}));
      assert.equal(stored.reservation_id,null);
      assert.equal((await f.post({...body,source_execution:{...reviewEditorExecution(f.lease),input_hash:digest('changed synthetic source')}})).statusCode,409);
      const changed=structuredClone(body);changed.decisions[0].manual_text='Changed synthetic final wording';
      assert.equal((await f.post(changed)).statusCode,409);
      for(const table of ['bb_model_call_attempts','bb_credit_reservations','bb_credit_events'])assert.equal((await f.pool.query(`SELECT 1 FROM ${table} WHERE owner_user_id=$1`,[f.owner])).rowCount,0);
    }
  });

test('an explicit mismatched export source pin is rejected without falling back to the default edition',
  {skip:!connection,timeout:30000},async t=>{
    const f=await context();t.after(f.close);await registerReviewEditorSnapshot(f.pool,f.lease,f.projectId,f.snapshot);await f.publish();
    for(const field of ['input_revision','input_hash'] as const){
      const pin={...reviewEditorExecution(f.lease),[field]:field==='input_revision'?2:digest('wrong synthetic pin')};
      const response=await f.post({request_id:uid(),source_run_id:f.runId,expected_editor_sha256:inputManifestHash(f.snapshot),source_execution:pin,
        decisions:[{id:'issue-1',decision:'original',manual_text:''}]});
      assert.equal(response.statusCode,409,response.body);
    }
    assert.equal((await f.pool.query('SELECT 1 FROM bb_runs WHERE owner_user_id=$1',[f.owner])).rowCount,1);
  });

test('test-only editors require the enabled channel and a live exact-input test grant',
  {skip:!connection,timeout:30000},async t=>{
    const beforeTier=process.env.BB_DEPLOYMENT_TIER,beforeChannel=process.env.BB_NON_PRODUCTION_TEST_CHANNEL;
    t.after(()=>{if(beforeTier===undefined)delete process.env.BB_DEPLOYMENT_TIER;else process.env.BB_DEPLOYMENT_TIER=beforeTier;
      if(beforeChannel===undefined)delete process.env.BB_NON_PRODUCTION_TEST_CHANNEL;else process.env.BB_NON_PRODUCTION_TEST_CHANNEL=beforeChannel;});
    process.env.BB_DEPLOYMENT_TIER='preprod';process.env.BB_NON_PRODUCTION_TEST_CHANNEL='enabled';
    const f=await context(true);t.after(f.close);await registerReviewEditorSnapshot(f.pool,f.lease,f.projectId,f.snapshot);await f.publish();
    assert.equal((await f.get()).statusCode,200);
    process.env.BB_NON_PRODUCTION_TEST_CHANNEL='disabled';assert.equal((await f.get()).statusCode,404);
    process.env.BB_NON_PRODUCTION_TEST_CHANNEL='enabled';assert.equal((await f.get()).statusCode,200);
    await f.pool.query("UPDATE bb_non_production_test_grants SET revoked_at=now(),revoked_by='synthetic',revoked_reason='synthetic boundary test' WHERE grant_id=$1",[f.grantId]);
    assert.equal((await f.get()).statusCode,404);
  });
