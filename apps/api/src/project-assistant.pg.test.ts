import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createServer } from './server.js';
import { isolatedTestDatabase } from './test-database.js';
import { completeM4Qa,emptyM4Context,emptyM4View,emptyM4Draft } from './m4-workspace.js';
import { grantCredits,creditBalance } from './billing.js';
import { transaction, type PrivateBlobs } from './data.js';
import { checkpointStage, claim, finish, promoteWordArtifact } from './queue.js';
import { makeSyntheticDocxFixture } from './docx-fixtures.js';
import { emptyUpdateDetails,reportingWindow } from '@bondbuddy/contracts';
import { classifyFixedPrice } from './billing-classification.js';

test('explicit completed baseline uses the existing content-update tier, not the original first-authoring tier',()=>{
  const periods=reportingWindow('sse','private','2025-09-30');
  const manifest={issuer_name:'Synthetic issuer',market:'sse',offering:'private',materials:[],update_details:{...emptyUpdateDetails(),target_reporting_periods:periods},
    authoring:{version:'unified_v1',source_prospectuses:[],previous_output:{sha256:'a'.repeat(64)},edit_baseline:{market:'sse',offering:'private',reporting_periods:periods}}};
  assert.equal(classifyFixedPrice(manifest).task,'interim');
  assert.equal(classifyFixedPrice({...manifest,authoring:{...manifest.authoring,edit_baseline:undefined}}).task,'new_authoring');
});

const connection=await isolatedTestDatabase(undefined,'global-assistant');
test('assistant baseline choices retain exact delivered names, pair and time after current run/job projections change',{skip:!connection},async()=>{
  const pool=new Pool({connectionString:connection}),owner=randomUUID(),contents=new Map<string,Buffer>();
  const blobs:PrivateBlobs={put:async(key,bytes)=>{contents.set(key,bytes);},get:async key=>{const bytes=contents.get(key);assert.ok(bytes);return bytes;},
    getIfExists:async key=>contents.get(key)??null,getIfExistsBounded:async(key,max)=>{const bytes=contents.get(key);return bytes&&bytes.length<=max?bytes:null;},
    exists:async key=>contents.has(key),delete:async key=>{contents.delete(key);}};
  const origin='http://bondbuddy.test';
  const app=createServer({pool,blobs,allowedOrigin:origin,principal:async()=>({userId:owner,csrfVerified:true}),enableSyntheticQueue:true});
  const ok=async(method:string,url:string,payload?:unknown)=>{const r=await app.inject({method:method as any,url,payload:payload as any,headers:{origin}});assert.ok(r.statusCode<300,r.body);return r.json();};
  try{
    const p=await ok('POST','/api/v1/projects',{name:'Synthetic assistant result',kind:'update',issuer_name:'Synthetic issuer',market:'sse',offering:'private'});
    const input=await ok('POST',`/api/v1/projects/${p.project_id}/input-revisions`,{draft_revision:1,material_versions:[],requirement_message_ids:[]});
    const run=await ok('POST','/api/v1/runs/execute',{execution_request_id:randomUUID(),project_id:p.project_id,input_revision:1,input_hash:input.input_hash,
      task_kind:'update',input_manifest_ref:'synthetic',storage_origin:'cloud',workspace_id:'synthetic'});
    const lease=await claim(pool,30);assert.ok(lease);assert.equal(lease.runId,run.run_id);
    const promote=(text:string)=>promoteWordArtifact(pool,lease,makeSyntheticDocxFixture({text}),blobs,'generated_pair_v1');
    const revision=await promote('Synthetic revision for assistant'),clean=await promote('Synthetic clean for assistant'),orphan=await promote('Synthetic unused assistant candidate');
    assert.equal(revision.status,'available');assert.equal(clean.status,'available');assert.equal(orphan.status,'available');
    await checkpointStage(pool,lease,'word_delivery_pair',{revision_artifact_id:revision.artifactId,clean_artifact_id:clean.artifactId});
    const results=async()=> (await ok('GET',`/api/v1/assistant/projects/${p.project_id}`)).results;
    assert.deepEqual(await results(),[]);
    await finish(pool,lease,'succeeded',{artifactId:revision.artifactId,artifactVersion:revision.artifactVersion,blobs});
    const delivered=await results();assert.equal(delivered.length,1);assert.equal(delivered[0].pin.artifact_id,clean.artifactId);
    assert.match(delivered[0].filename,/清洁版/);
    const receipt=(await pool.query("SELECT delivered_at FROM bb_run_execution_deliveries WHERE run_id=$1 AND delivery_phase='final'",[run.run_id])).rows[0];
    assert.equal(delivered[0].created_at,receipt.delivered_at.toISOString());
    await pool.query("UPDATE bb_jobs SET checkpoint=jsonb_set(checkpoint,'{stages,word_delivery_pair}',jsonb_build_object('revision_artifact_id',$2::text,'clean_artifact_id',$2::text)) WHERE run_id=$1",[run.run_id,orphan.artifactId]);
    await pool.query("UPDATE bb_runs SET state='paused',artifact_id=$2,artifact_version=$3,created_at=created_at-interval '20 days',updated_at=now() WHERE id=$1",[run.run_id,orphan.artifactId,orphan.artifactVersion]);
    assert.deepEqual(await results(),delivered,'receipt identity, naming and completion time survive current projections');
  }finally{await app.close();await pool.end();}
});
test('global assistant persistence, owner isolation, no implicit execution and create retries',{skip:!connection,timeout:90000},async()=>{
  const pool=new Pool({connectionString:connection}),user=randomUUID(),other=randomUUID();let actor=user;
  const app=createServer({pool,principal:async()=>({userId:actor,csrfVerified:true}),enableSyntheticQueue:true,allowedOrigin:'http://bondbuddy.test'});
  const send=(method:string,url:string,payload?:unknown)=>app.inject({method:method as any,url,payload:payload as any,headers:{origin:'http://bondbuddy.test'}});
  const ok=async(method:string,url:string,payload?:unknown)=>{const r=await send(method,url,payload);assert.ok(r.statusCode<300,r.body);return r.json();};
  try{
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2),($3,$4)',[user,`s${user.replaceAll('-','').slice(0,12)}`,other,`s${other.replaceAll('-','').slice(0,12)}`]);
    const input={creation_request_id:randomUUID(),name:'Synthetic assistant project',kind:'update',issuer_name:'Synthetic issuer',market:'sse',offering:'private',
      update_details:{...emptyUpdateDetails(),authoring_mode:'unified_v1',reporting_cutoff:'2025-09-30',target_reporting_periods:reportingWindow('sse','private','2025-09-30')}};
    const p=await ok('POST','/api/v1/projects',input);
    assert.equal((await ok('POST','/api/v1/projects',input)).project_id,p.project_id);
    assert.equal((await send('POST','/api/v1/projects',{...input,name:'Changed input'})).statusCode,409);
    const t=(await ok('POST','/api/v1/m4/topics',{creation_request_id:randomUUID(),name:'Synthetic conversation',surface:'assistant',source_project_id:p.project_id})).topic;
    let w=await ok('GET',`/api/v1/m4/topics/${t.topic_id}/workspace`);assert.equal(w.project.kind,'qa');
    const listed=await ok('GET','/api/v1/projects');assert.ok(!listed.items.some((p:any)=>p.project_id===t.project_id));
    const view={...emptyM4View(),assistant:{project_id:p.project_id,action:null},unsent_content:'未发送的合成草稿'};
    await ok('PUT',`/api/v1/m4/topics/${t.topic_id}/view`,{expected_version:0,view});
    assert.equal((await ok('GET',`/api/v1/m4/topics/${t.topic_id}/workspace`)).view.unsent_content,view.unsent_content);
    assert.equal((await send('PUT',`/api/v1/m4/topics/${t.topic_id}/view`,{expected_version:0,view})).statusCode,409);
    const message={submission_request_id:randomUUID(),content:'如何使用项目助手',context:emptyM4Context()};
    const first=await ok('POST',`/api/v1/m4/topics/${t.topic_id}/messages`,message);
    assert.equal((await ok('POST',`/api/v1/m4/topics/${t.topic_id}/messages`,message)).run.run_id,first.run.run_id);
    const manifest=(await pool.query('SELECT manifest FROM bb_m4_executions WHERE run_id=$1',[first.run.run_id])).rows[0].manifest;
    assert.equal(manifest.assistant_context.project_id,p.project_id);
    assert.equal(manifest.assistant_context.issuer_name,'Synthetic issuer');
    await transaction(pool,c=>completeM4Qa(c,user,first.run.run_id,{content:'合成回复：可以在确认卡核对任务。',intent:'clarify',fields:{},requirements:[],document_type:null,target_business:null,citations:[],retrieval:'not_performed',
      assistant_action:{business:'update',requirements:'只调整措辞，保留全部数字',fields:{}}}));
    w=await ok('GET',`/api/v1/m4/topics/${t.topic_id}/workspace`);
    assert.equal(w.messages.at(-1).reply.assistant_action.business,'update');
    assert.equal(Number((await pool.query("SELECT count(*) FROM bb_runs WHERE owner_user_id=$1 AND task_kind<>'qa'",[user])).rows[0].count),0);
    assert.equal((await send('POST',`/api/v1/m4/topics/${t.topic_id}/messages`,{...message,submission_request_id:randomUUID(),execute:true})).statusCode,422);
    const lock={draft_revision:p.draft_revision,material_versions:[],requirement_message_ids:[],edit_base:{artifact_id:'not-owned',artifact_version:1,sha256:'a'.repeat(64)}};
    assert.equal((await send('POST',`/api/v1/projects/${p.project_id}/input-revisions`,lock)).statusCode,409);
    const material=randomUUID(),upload=randomUUID(),sha='b'.repeat(64);
    await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
      VALUES($1,$2,$3,'synthetic.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',12,$4,'historical','synthetic-only',now()+interval '1 hour','completed')`,[upload,user,t.project_id,sha]);
    await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES($1,1,$2,$3,$4,'historical','synthetic.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',12,$5,'synthetic-only','persisted')`,[material,user,t.project_id,upload,sha]);
    const source={source_project_id:t.project_id,material_id:material,material_version:1,sha256:sha};
    const draft={...emptyM4Draft('private_summary'),fields:{market:'sse'},source_material:source,materials:[source],supplemental_requirements:'合成测试：保留所有数字'};
    await ok('PUT',`/api/v1/m4/topics/${t.topic_id}/drafts/private_summary`,{expected_version:0,input:draft});
    const quote=await ok('POST',`/api/v1/m4/topics/${t.topic_id}/quote`,{kind:'document',document_type:'private_summary',expected_draft_version:1});
    assert.equal(quote.quote.billing_policy,'authoring_balance_v2');
    const cardRequest={card_id:randomUUID(),operation:'generation',project_id:t.project_id,execution_request_id:randomUUID(),quote_id:quote.quote.quote_id,document_type:'private_summary',expected_draft_version:1};
    const card=await ok('POST',`/api/v1/assistant/topics/${t.topic_id}/cards`,cardRequest);assert.equal(card.card.quote.points,4500);assert.equal(card.card.run,null);
    assert.equal((await ok('POST',`/api/v1/assistant/topics/${t.topic_id}/cards`,cardRequest)).card.card_id,card.card.card_id);
    assert.equal((await send('POST',`/api/v1/assistant/topics/${t.topic_id}/cards`,{...cardRequest,input_hash:'c'.repeat(64)})).statusCode,409);
    const execution={execution_request_id:cardRequest.execution_request_id,document_type:'private_summary',expected_draft_version:1,quote_id:quote.quote.quote_id,entrypoint:'assistant'};
    assert.equal((await send('POST',`/api/v1/m4/topics/${t.topic_id}/execute`,execution)).statusCode,402);
    await transaction(pool,c=>grantCredits(c,{owner:user,source:'existing_grant',key:'synthetic-assistant',points:10000,expiresAt:null,actor:'synthetic-test',reason:'Synthetic integration'}));
    const executed=await ok('POST',`/api/v1/m4/topics/${t.topic_id}/execute`,execution);
    assert.deepEqual(await creditBalance(pool,user),{available:10000,frozen:0},'queued dynamic authoring neither freezes nor debits the locked price');
    assert.equal((await ok('POST',`/api/v1/m4/topics/${t.topic_id}/execute`,execution)).run.run_id,executed.run.run_id);
    assert.equal((await ok('GET',`/api/v1/assistant/topics/${t.topic_id}/cards`)).cards[0].run.run_id,executed.run.run_id);
    assert.deepEqual(await creditBalance(pool,user),{available:10000,frozen:0},'execute retries do not freeze or debit credits');
    assert.deepEqual((await pool.query(`SELECT run_id,points::int AS points,billing_policy,charged_points::int AS charged_points,state FROM bb_credit_reservations
      WHERE owner_user_id=$1 AND quote_id=$2`,[user,quote.quote.quote_id])).rows,
      [{run_id:executed.run.run_id,points:4500,billing_policy:'authoring_balance_v2',charged_points:0,state:'held'}]);
    assert.equal(Number((await pool.query(`SELECT count(*) FROM bb_credit_allocations a JOIN bb_credit_reservations r ON r.id=a.reservation_id
      WHERE r.owner_user_id=$1 AND r.quote_id=$2`,[user,quote.quote.quote_id])).rows[0].count),0);
    assert.equal(Number((await pool.query('SELECT count(*) FROM bb_credit_events WHERE owner_user_id=$1 AND run_id=$2',[user,executed.run.run_id])).rows[0].count),0);
    actor=other;
    for(const path of [`/m4/topics/${t.topic_id}/workspace`,`/assistant/topics/${t.topic_id}/cards`,`/assistant/projects/${p.project_id}`])assert.equal((await send('GET',`/api/v1${path}`)).statusCode,404);
    const foreign=(await ok('POST','/api/v1/m4/topics',{creation_request_id:randomUUID(),name:'Other',surface:'assistant'})).topic;
    assert.equal((await send('PUT',`/api/v1/m4/topics/${foreign.topic_id}/view`,{expected_version:0,view})).statusCode,404);
  }finally{await app.close();await pool.end();}
});
