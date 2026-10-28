import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createServer } from './server.js';
import { isolatedTestDatabase } from './test-database.js';
import { completeM4Qa,emptyM4Context,emptyM4View,emptyM4Draft } from './m4-workspace.js';
import { grantCredits,creditBalance } from './billing.js';
import { transaction } from './data.js';
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
    const message={submission_request_id:randomUUID(),content:'BondBuddy怎么使用？',context:emptyM4Context()};
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
    const cardRequest={card_id:randomUUID(),operation:'generation',project_id:t.project_id,execution_request_id:randomUUID(),quote_id:quote.quote.quote_id,document_type:'private_summary',expected_draft_version:1};
    const card=await ok('POST',`/api/v1/assistant/topics/${t.topic_id}/cards`,cardRequest);assert.equal(card.card.quote.points,4500);assert.equal(card.card.run,null);
    assert.equal((await ok('POST',`/api/v1/assistant/topics/${t.topic_id}/cards`,cardRequest)).card.card_id,card.card.card_id);
    assert.equal((await send('POST',`/api/v1/assistant/topics/${t.topic_id}/cards`,{...cardRequest,input_hash:'c'.repeat(64)})).statusCode,409);
    const execution={execution_request_id:cardRequest.execution_request_id,document_type:'private_summary',expected_draft_version:1,quote_id:quote.quote.quote_id,entrypoint:'assistant'};
    assert.equal((await send('POST',`/api/v1/m4/topics/${t.topic_id}/execute`,execution)).statusCode,402);
    await transaction(pool,c=>grantCredits(c,{owner:user,source:'existing_grant',key:'synthetic-assistant',points:10000,expiresAt:null,actor:'synthetic-test',reason:'Synthetic integration'}));
    const executed=await ok('POST',`/api/v1/m4/topics/${t.topic_id}/execute`,execution);
    assert.equal((await ok('POST',`/api/v1/m4/topics/${t.topic_id}/execute`,execution)).run.run_id,executed.run.run_id);
    assert.equal((await ok('GET',`/api/v1/assistant/topics/${t.topic_id}/cards`)).cards[0].run.run_id,executed.run.run_id);
    // New authoring requests debit actual progress; accepting the card does not freeze its ceiling.
    assert.deepEqual(await creditBalance(pool,user),{available:10000,frozen:0});
    const reservation=(await pool.query('SELECT billing_policy,points,charged_points FROM bb_credit_reservations WHERE owner_user_id=$1 AND run_id=$2',[user,executed.run.run_id])).rows[0];
    assert.equal(reservation.billing_policy,'authoring_balance_v2');
    assert.equal(Number(reservation.points),4500);
    assert.equal(Number(reservation.charged_points),0);
    actor=other;
    for(const path of [`/m4/topics/${t.topic_id}/workspace`,`/assistant/topics/${t.topic_id}/cards`,`/assistant/projects/${p.project_id}`])assert.equal((await send('GET',`/api/v1${path}`)).statusCode,404);
    const foreign=(await ok('POST','/api/v1/m4/topics',{creation_request_id:randomUUID(),name:'Other',surface:'assistant'})).topic;
    assert.equal((await send('PUT',`/api/v1/m4/topics/${foreign.topic_id}/view`,{expected_version:0,view})).statusCode,404);
  }finally{await app.close();await pool.end();}
});
