import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { M4AssistantReply, M4MaterialPin, M4DraftInput, M4HandoffBindRequest } from '@bondbuddy/contracts';
import { M4_BILLING_TASKS } from '@bondbuddy/contracts';
import { createServer } from './server.js';
import { digest, transaction, type PrivateBlobs } from './data.js';
import { grantCredits, creditBalance } from './billing.js';
import { isolatedTestDatabase } from './test-database.js';
import { emptyM4Context, emptyM4Draft, emptyM4View, completeM4Qa, registerM4Artifacts, classifyM4Qa,m4UnavailableDocument,m4UnavailableLocalScope,m4UnavailableResearch } from './m4-workspace.js';
import { publishM4BillingConfig, settleM4Metering, type M4BillingConfig } from './m4-billing.js';
import { inputManifestHash } from './production-rule-pin.js';
import { claim, finish, finishM4Qa, promoteWordArtifact, recordPotentialCall, pausedRuns, resumePausedRun } from './queue.js';
import { saveSnapshotRef, observeUsage } from './observability.js';
import { persistProviderResultObject,recordProviderCallObservation,readCheckpointedProviderResult,type ProviderCallObservation } from './provider-results.js';
import { makeSyntheticDocxFixture } from './docx-fixtures.js';

const connection=await isolatedTestDatabase(undefined,'m4-workspace');
const handoffConnection=await isolatedTestDatabase(undefined,'m4-handoff');
test('synthetic M4 handoff: explicit owner binding, canonical execution mutex and immutable lineage',{skip:!handoffConnection,timeout:180000},async()=>{
  const pool=new Pool({connectionString:handoffConnection}),user=`m4-handoff-${randomUUID()}`,other=`m4-handoff-${randomUUID()}`;let actor=user;
  const bytes=new Map<string,Buffer>(),blobs:PrivateBlobs={put:async(k,b)=>{bytes.set(k,Buffer.from(b));},get:async k=>{const b=bytes.get(k);assert.ok(b);return b;},
    getIfExists:async k=>bytes.get(k)??null,getIfExistsBounded:async(k,n)=>{const b=bytes.get(k);if(b&&b.length>n)throw Error('bounded');return b??null;},exists:async k=>bytes.has(k),delete:async k=>{bytes.delete(k);}};
  const app=createServer({pool,blobs,allowedOrigin:'http://bondbuddy.test',principal:async()=>({userId:actor,csrfVerified:true}),enableSyntheticQueue:true});
  const send=(method:string,url:string,payload?:unknown)=>app.inject({method:method as any,url,payload:payload as any,headers:{origin:'http://bondbuddy.test'}});
  const ok=async(method:string,url:string,payload?:unknown)=>{const r=await send(method,url,payload);assert.equal(r.statusCode,200,r.body);return r.json();};
  const seedProject=async(kind:string,owner=user)=>{const id=randomUUID();await pool.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind,issuer_name,market,offering)
    VALUES($1,$2,'Synthetic handoff target',$3,'Synthetic issuer','sse','private')`,[id,owner,kind]);return id;};
  const seedMaterial=async(projectId:string,version=1,id:string=randomUUID()):Promise<M4MaterialPin>=>{const body=makeSyntheticDocxFixture({text:`Synthetic handoff source version ${version}`}),upload=randomUUID(),key=`users/${user}/projects/${projectId}/materials/${upload}`;bytes.set(key,body);
    await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
      VALUES($1,$2,$3,'synthetic-handoff.docx',$4,$5,$6,'historical',$7,now()+interval '1 hour','completed')`,[upload,user,projectId,'application/vnd.openxmlformats-officedocument.wordprocessingml.document',body.length,digest(body),key]);
    await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES($1,$2,$3,$4,$5,'historical','synthetic-handoff.docx',$6,$7,$8,$9,'persisted')`,[id,version,user,projectId,upload,'application/vnd.openxmlformats-officedocument.wordprocessingml.document',body.length,digest(body),key]);
    return {source_project_id:projectId,material_id:id,material_version:version,sha256:digest(body)};};
  const createTopic=async(source?:string)=>(await ok('POST','/api/v1/m4/topics',{creation_request_id:randomUUID(),name:'Synthetic handoff origin',...(source?{source_project_id:source}:{})})).topic;
  const postMessage=async(topic:any,pin:M4MaterialPin|null)=>(await ok('POST',`/api/v1/m4/topics/${topic.topic_id}/messages`,{submission_request_id:randomUUID(),content:'请更新募集说明书',context:{...emptyM4Context(),source_material:pin}})).message;
  const bind=(topic:any,message:any,target:string,pin:M4MaterialPin):M4HandoffBindRequest=>({message_id:message.message_id,message_version:message.version,target_project_id:target,source_material:pin});
  const bindPath=(topic:any)=>`/api/v1/m4/topics/${topic.topic_id}/handoffs/bind`;
  const insertRun=async(projectId:string,kind:string,state='queued')=>transaction(pool,async c=>{
    const p=(await c.query('SELECT * FROM bb_projects WHERE owner_user_id=$1 AND id=$2 FOR UPDATE',[user,projectId])).rows[0],rev=Number((await c.query('SELECT COALESCE(max(revision),0)+1 next FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2',[user,projectId])).rows[0].next),manifest={kind,draft_revision:p.draft_revision,synthetic:true},hash=inputManifestHash(manifest),id=randomUUID();
    await c.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,$2,$3,$4,$5,$6,'[]','[]')`,[projectId,rev,user,p.draft_revision,hash,manifest]);
    await c.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,user,projectId,rev,hash,randomUUID(),kind,digest('synthetic-handoff-run'),state]);return id;});
  try{
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2),($3,$4)',[user,'synthetic_handoff_owner',other,'synthetic_handoff_other']);
    const topic=await createTopic(),oldPin=await seedMaterial(topic.project_id),pin=await seedMaterial(topic.project_id,2,oldPin.material_id),message=await postMessage(topic,pin);
    const targetUpdate=await seedProject('update'),targetReview=await seedProject('review'),foreign=await seedProject('review',other),invalidKind=await seedProject('generation');
    const body=bind(topic,message,targetUpdate,pin),path=bindPath(topic);
    actor=other;assert.equal((await send('POST',path,body)).statusCode,404);actor=user;
    for(const input of [{...body,target_project_id:foreign},{...body,target_project_id:randomUUID()},{...body,message_id:randomUUID()}])assert.equal((await send('POST',path,input)).statusCode,404);
    for(const input of [{...body,message_version:message.version+1},{...body,source_material:oldPin},{...body,source_material:{...pin,sha256:'0'.repeat(64)}}])assert.equal((await send('POST',path,input)).json().code,'INPUT_REVISION_CONFLICT');
    assert.equal((await send('POST',path,{...body,execution_scope_project_id:randomUUID()})).statusCode,422);
    assert.equal((await send('POST',path,{...body,target_project_id:invalidKind})).statusCode,422);
    const assistantId=randomUUID();await pool.query(`INSERT INTO bb_m4_messages(id,owner_user_id,topic_id,role,content,context,reply_to,reply_status)
      VALUES($1,$2,$3,'assistant','Synthetic reply',$4,$5,'completed')`,[assistantId,user,topic.topic_id,emptyM4Context(),message.message_id]);
    assert.equal((await send('POST',path,{...body,message_id:assistantId})).statusCode,404);
    const unpinned=await postMessage(topic,null);assert.equal((await send('POST',path,{...body,message_id:unpinned.message_id})).json().code,'INPUT_REQUIRED');
    const removedSource=await seedProject('update'),removedPin=await seedMaterial(removedSource),removedMessage=await postMessage(topic,removedPin);
    await pool.query('UPDATE bb_material_versions SET deleted_at=now() WHERE owner_user_id=$1 AND id=$2',[user,removedPin.material_id]);
    assert.equal((await send('POST',path,bind(topic,removedMessage,targetUpdate,removedPin))).statusCode,404);
    await pool.query('UPDATE bb_projects SET deleted_at=now() WHERE owner_user_id=$1 AND id=$2',[user,removedSource]);
    assert.equal((await send('POST',path,bind(topic,removedMessage,targetUpdate,removedPin))).statusCode,404);
    // Real source generation is already executing; adoption remains free and changes only the new target scope.
    await ok('PUT',`/api/v1/m4/topics/${topic.topic_id}/drafts/private_summary`,{expected_version:0,input:{...emptyM4Draft('private_summary'),source_material:pin,materials:[pin],fields:{issuer_name:'Synthetic issuer',market:'sse'}}});
    const config:M4BillingConfig={model_id:'synthetic-codex',rates:{'synthetic-codex':{input_microyuan_per_million:1000000,cached_microyuan_per_million:1000000,output_microyuan_per_million:2000000}},
      budgets:Object.fromEntries(Object.keys(M4_BILLING_TASKS).map(k=>[k,{input_tokens:1000000,output_tokens:1000000,reserve_factor:1.2}])) as M4BillingConfig['budgets']};
    await publishM4BillingConfig(pool,{id:`synthetic-handoff-${randomUUID()}`,config,effective_at:'2026-01-01T00:00:00Z',actor:'synthetic-test',reason:'synthetic-only'});
    await transaction(pool,c=>grantCredits(c,{owner:user,points:10000,key:'synthetic-handoff-fund',source:'purchase',expiresAt:null,actor:'synthetic-test',reason:'synthetic-only'}));
    const quote=(await ok('POST',`/api/v1/m4/topics/${topic.topic_id}/quote`,{kind:'document',document_type:'private_summary',expected_draft_version:1})).quote;
    const sourceRun=(await ok('POST',`/api/v1/m4/topics/${topic.topic_id}/execute`,{execution_request_id:randomUUID(),document_type:'private_summary',expected_draft_version:1,quote_id:quote.quote_id,entrypoint:'workspace'})).run;
    const sourceLease=await claim(pool,30,{runKinds:['generation']});assert.ok(sourceLease);assert.equal(sourceLease.runId,sourceRun.run_id);
    assert.equal((await pool.query('SELECT state FROM bb_runs WHERE id=$1',[sourceRun.run_id])).rows[0].state,'running');
    const before=(await pool.query(`SELECT (SELECT count(*) FROM bb_runs WHERE owner_user_id=$1)::int runs,
      (SELECT count(*) FROM bb_material_versions WHERE owner_user_id=$1)::int materials,(SELECT count(*) FROM bb_credit_reservations WHERE owner_user_id=$1)::int reservations`,[user])).rows[0],wallet=await creditBalance(pool,user);
    const revision=Number((await pool.query('SELECT draft_revision FROM bb_projects WHERE id=$1',[targetUpdate])).rows[0].draft_revision);
    for(const target of [targetUpdate,targetReview]){
      const accepted=await ok('POST',path,bind(topic,message,target,pin));assert.equal(accepted.binding.execution_scope_project_id,topic.project_id);
      assert.deepEqual(accepted.binding.source_material,pin);assert.equal(accepted.binding.message_version,message.version);
      assert.deepEqual(await ok('POST',path,bind(topic,message,target,pin)),accepted);
      assert.equal((await pool.query("SELECT count(*)::int n FROM bb_outbox WHERE aggregate_id=$1 AND event_type='project.m4_handoff_bound'",[target])).rows[0].n,1);
    }
    assert.equal(Number((await pool.query('SELECT draft_revision FROM bb_projects WHERE id=$1',[targetUpdate])).rows[0].draft_revision),revision+1);
    assert.deepEqual((await pool.query(`SELECT (SELECT count(*) FROM bb_runs WHERE owner_user_id=$1)::int runs,
      (SELECT count(*) FROM bb_material_versions WHERE owner_user_id=$1)::int materials,(SELECT count(*) FROM bb_credit_reservations WHERE owner_user_id=$1)::int reservations`,[user])).rows[0],before);
    assert.deepEqual(await creditBalance(pool,user),wallet);
    await assert.rejects(()=>insertRun(targetUpdate,'update'),/Project already has an active business run/);
    await assert.rejects(()=>insertRun(targetReview,'review'),/Project already has an active business run/);
    // The legacy update API also checks the adopted canonical before creating a task.
    const lockedUpdate=await send('POST',`/api/v1/projects/${targetUpdate}/input-revisions`,{draft_revision:revision+1,material_versions:[],requirement_message_ids:[]});
    assert.equal(lockedUpdate.statusCode,201,lockedUpdate.body);const updateInput=lockedUpdate.json();
    const updateResponse=await send('POST','/api/v1/runs/execute',{execution_request_id:randomUUID(),project_id:targetUpdate,input_revision:updateInput.input_revision,
      input_hash:updateInput.input_hash,task_kind:'update',input_manifest_ref:'synthetic-handoff',storage_origin:'cloud',workspace_id:'synthetic-handoff'});
    assert.equal(updateResponse.statusCode,409,updateResponse.body);assert.equal(updateResponse.json().code,'PROJECT_RUN_ACTIVE');
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_runs WHERE project_id=$1 AND task_kind='update'",[targetUpdate])).rows[0].n,0);
    const parallelQa=await insertRun(targetReview,'qa');assert.ok(parallelQa); // Actual QA may continue alongside generation.
    await pool.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1",[parallelQa]);
    // The real review route is also prevented from creating a task on the adopted canonical source.
    const reviewMaterial=await seedMaterial(targetReview),reviewPin={material_id:reviewMaterial.material_id,material_version:1,sha256:reviewMaterial.sha256};
    await ok('PUT',`/api/v1/projects/${targetReview}/review-draft`,{kind:'input',expected_version:0,input:{source_material_ref:reviewPin,material_versions:[reviewPin],requirements:[],as_of:'2026-10-01'}});
    const reviewRequest={execution_request_id:randomUUID(),operation:'full_review',expected_input_version:1,source_report_id:null,expected_plan_version:null,finding_ids:[]};
    const reviewResponse=await send('POST',`/api/v1/projects/${targetReview}/review-executions`,reviewRequest);assert.equal(reviewResponse.statusCode,409,reviewResponse.body);assert.equal(reviewResponse.json().code,'PROJECT_RUN_ACTIVE');
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_runs WHERE project_id=$1 AND task_kind='review'",[targetReview])).rows[0].n,0);
    // Existing non-QA history and a different canonical binding cannot be relabelled.
    const used=await seedProject('update');await insertRun(used,'update','failed');assert.equal((await send('POST',path,{...body,target_project_id:used})).json().code,'INPUT_REVISION_CONFLICT');
    const otherSource=await seedProject('update'),otherPin=await seedMaterial(otherSource),otherTopic=await createTopic(otherSource),otherMessage=await postMessage(otherTopic,otherPin);
    assert.equal((await send('POST',bindPath(otherTopic),bind(otherTopic,otherMessage,targetUpdate,otherPin))).json().code,'INPUT_REVISION_CONFLICT');
    assert.equal((await send('POST',bindPath(otherTopic),bind(otherTopic,otherMessage,topic.project_id,otherPin))).statusCode,422);
    // A source project already used as canonical cannot itself be adopted into a different lineage.
    const originalRoot=await seedProject('update'),rootPin=await seedMaterial(originalRoot),rootTopic=await createTopic(originalRoot),rootMessage=await postMessage(rootTopic,rootPin),rootTarget=await seedProject('review');
    assert.equal((await ok('POST',bindPath(rootTopic),bind(rootTopic,rootMessage,rootTarget,rootPin))).binding.execution_scope_project_id,originalRoot);
    assert.equal((await send('POST',bindPath(otherTopic),bind(otherTopic,otherMessage,originalRoot,otherPin))).json().code,'INPUT_REVISION_CONFLICT');
    // NOWAIT fails promptly while a concurrent executor holds the target, without deadlocking.
    const racingTarget=await seedProject('review'),locker=await pool.connect();
    try{await locker.query('BEGIN');await locker.query('SELECT 1 FROM bb_projects WHERE id=$1 FOR UPDATE',[racingTarget]);
      assert.equal((await send('POST',path,{...body,target_project_id:racingTarget})).json().code,'INPUT_REVISION_CONFLICT');
    }finally{await locker.query('ROLLBACK');locker.release();}
    await ok('POST',path,{...body,target_project_id:racingTarget});
    await pool.query("UPDATE bb_jobs SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE run_id=$1",[sourceRun.run_id]);await pool.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1",[sourceRun.run_id]);
    const updateRun=await insertRun(targetUpdate,'update');assert.ok(updateRun);
    assert.deepEqual((await ok('POST',path,body)).binding.source_material,pin); // Same-scope retry after a run is read-only.
    await assert.rejects(()=>insertRun(targetReview,'review'),/Project already has an active business run/);
    await pool.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1",[updateRun]);
    // Choosing a new document source cannot split an already adopted canonical group.
    await ok('PUT',`/api/v1/m4/topics/${topic.topic_id}/drafts/private_summary`,{expected_version:1,input:{...emptyM4Draft('private_summary'),source_material:otherPin,materials:[otherPin],fields:{issuer_name:'Synthetic issuer',market:'sse'}}});
    const movedQuote=(await ok('POST',`/api/v1/m4/topics/${topic.topic_id}/quote`,{kind:'document',document_type:'private_summary',expected_draft_version:2})).quote;
    const moved=await send('POST',`/api/v1/m4/topics/${topic.topic_id}/execute`,{execution_request_id:randomUUID(),document_type:'private_summary',expected_draft_version:2,quote_id:movedQuote.quote_id,entrypoint:'workspace'});
    assert.equal(moved.json().code,'INPUT_REVISION_CONFLICT');assert.match(moved.json().message,/新建话题/);
    assert.equal((await pool.query('SELECT execution_scope_project_id FROM bb_projects WHERE id=$1',[topic.project_id])).rows[0].execution_scope_project_id,topic.project_id);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_credit_reservations WHERE quote_id=$1',[movedQuote.quote_id])).rows[0].n,0);
  }finally{await app.close();await pool.end();}
});
test('M4 free task preparation and unavailable capabilities do not turn basic QA into free help',()=>{
  const context=emptyM4Context(),selected={...context,document_type:'init' as const,draft_version:1};
  for(const content of ['请生成法律意见书','请编制主承销商核查意见','请生成推荐函','请实时查询公开信息','请检索最新法规并判断法规适用性','请做深度研究','请只修改这一段','请更新募集说明书','请把偿债能力作为重点，保留财务表格，不要新增风险承诺'])
    assert.equal(classifyM4Qa(content,context),'m4_task_assistance',content);
  for(const content of ['立项报告是什么','解释法律意见书的概念','法规效力是什么意思','深度研究是什么'])assert.equal(classifyM4Qa(content,context),'m4_Q01',content);
  assert.equal(classifyM4Qa('解释偿债能力概念',selected),'m4_Q01');
  assert.equal(classifyM4Qa('请计算资产负债率，保留财务表格',selected),'m4_Q03');
  assert.equal(classifyM4Qa('比较两期资产负债率',selected),'m4_Q04');
  assert.equal(classifyM4Qa('对比两年流动比率，并计算差额',context),'m4_Q04');
  assert.equal(classifyM4Qa('计算本期资产负债率',context),'m4_Q03');
  assert.equal(classifyM4Qa('请对比两期偿债能力，保留财务表格',selected),'m4_Q04');
  assert.equal(classifyM4Qa('解读该材料的偿债能力',{...context,source_material:{source_project_id:'synthetic-project',material_id:'synthetic-material',material_version:1,sha256:'0'.repeat(64)}}),'m4_Q02');
  assert.equal(m4UnavailableDocument('请生成立项报告，不要生成法律意见书'),false);
  assert.equal(m4UnavailableLocalScope('请生成完整立项报告，不要只修改某个段落'),false);
  assert.equal(m4UnavailableResearch('不要联网，解释资产的概念'),false);
});
test('synthetic M4 API: exact pins, topics, independent drafts, recovery, mutual exclusion, QA text and real wallet capped metering',{skip:!connection,timeout:180000},async()=>{
  const pool=new Pool({connectionString:connection}),user=`m4-${randomUUID()}`,other=`m4-${randomUUID()}`;let actor=user;
  const bytes=new Map<string,Buffer>();
  const blobs:PrivateBlobs={put:async(k,b)=>{bytes.set(k,Buffer.from(b));},get:async k=>{const b=bytes.get(k);assert.ok(b);return b;},
    getIfExists:async k=>bytes.get(k)??null,getIfExistsBounded:async(k,n)=>{const b=bytes.get(k);if(b&&b.length>n)throw Error('bounded');return b??null;},exists:async k=>bytes.has(k),delete:async k=>{bytes.delete(k);}};
  const app=createServer({pool,blobs,allowedOrigin:'http://bondbuddy.test',principal:async()=>({userId:actor,csrfVerified:true}),enableSyntheticQueue:true});
  const send=(method:string,url:string,payload?:unknown)=>app.inject({method:method as any,url,payload:payload as any,headers:{origin:'http://bondbuddy.test'}});
  const ok=async(method:string,url:string,payload?:unknown)=>{const r=await send(method,url,payload);assert.equal(r.statusCode,200,r.body);return r.json();};
  const seedProject=async(name:string)=>{const id=randomUUID();await pool.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind,issuer_name,market,offering) VALUES($1,$2,$3,'update','Synthetic issuer','sse','private')`,[id,user,name]);return id;};
  const seedMaterial=async(projectId:string,name:string,version=1,id:string=randomUUID()):Promise<M4MaterialPin>=>{const body=makeSyntheticDocxFixture({text:`Synthetic ${name} v${version}`}),upload=randomUUID(),key=`users/${user}/projects/${projectId}/materials/${upload}`;bytes.set(key,body);
    await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state) VALUES($1,$2,$3,$4,$5,$6,$7,'other',$8,now()+interval '1 hour','completed')`,[upload,user,projectId,name,'application/vnd.openxmlformats-officedocument.wordprocessingml.document',body.length,digest(body),key]);
    await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state) VALUES($1,$2,$3,$4,$5,'other',$6,$7,$8,$9,$10,'parsed')`,[id,version,user,projectId,upload,name,'application/vnd.openxmlformats-officedocument.wordprocessingml.document',body.length,digest(body),key]);
    return {source_project_id:projectId,material_id:id,material_version:version,sha256:digest(body)};};
  const createTopic=async(source?:string)=>{const b={creation_request_id:randomUUID(),name:'Synthetic combined workspace',...(source?{source_project_id:source}:{})};const t=(await ok('POST','/api/v1/m4/topics',b)).topic;
    assert.equal((await ok('POST','/api/v1/m4/topics',b)).topic.topic_id,t.topic_id);return t;};
  const path=(t:any,suffix:string)=>`/api/v1/m4/topics/${t.topic_id}/${suffix}`;
  const save=async(t:any,input:M4DraftInput,expected=0)=>(await ok('PUT',path(t,`drafts/${input.document_type}`),{expected_version:expected,input})).draft;
  const context=emptyM4Context();
  const reply:M4AssistantReply={content:'Synthetic answer. 公开检索未执行。',citations:[],requirements:[],fields:{},intent:'answer',document_type:null,target_business:null,retrieval:'not_performed'};
  try{
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2),($3,$4)',[user,'synthetic_m4_owner',other,'synthetic_m4_other']);
    const source=await seedProject('Synthetic original project'),different=await seedProject('Synthetic independent source'),pin=await seedMaterial(source,'synthetic.docx');
    const newer=await seedMaterial(source,'synthetic-new.docx',2,pin.material_id),templatePin=await seedMaterial(source,'synthetic-template.docx');
    const t=await createTopic(source),t2=await createTopic(source),t3=await createTopic();
    const input={...emptyM4Draft('private_summary'),source_material:pin,materials:[pin],fields:{issuer_name:'Synthetic issuer',market:'sse'}};
    const d1=await save(t,input);assert.equal(d1.version,1);
    assert.equal((await send('PUT',path(t,'drafts/private_summary'),{expected_version:0,input})).statusCode,409);
    assert.equal((await send('PUT',path(t,'drafts/private_summary'),{expected_version:1,input:{...input,source_material:{...pin,sha256:'0'.repeat(64)}}})).statusCode,404);
    await save(t2,input);await save(t3,input); // Source is selected after topic creation; it must share the canonical execution lock.
    const template=(await ok('POST','/api/v1/m4/templates',{creation_request_id:randomUUID(),name:'Synthetic broker template',broker:'Synthetic broker',document_type:'init',material:templatePin})).template;
    const init=await save(t,{...emptyM4Draft('init'),materials:[pin],template:{template_id:template.template_id,template_version:template.template_version,sha256:template.sha256},fields:{issuer_name:'Synthetic issuer',market:'sse',broker:'Synthetic broker',reporting_cutoff:'2026-09-30'}});
    let ws=await ok('GET',path(t,'workspace'));assert.equal(ws.drafts.private_summary.version,1);assert.equal(ws.drafts.init.version,init.version);assert.equal(ws.material_details[0].filename,'synthetic.docx');
    const view={...emptyM4View(),selected_document_type:'private_summary',unsent_content:'Synthetic unsent request',unsent_context:{...context,document_type:'private_summary',draft_version:1,source_material:pin,citations:[{kind:'material',ref:pin,locator:'paragraph 1'}]},workspace_tab:'input',tab_scroll:{input:240}};
    await ok('PUT',path(t,'view'),{expected_version:0,view});ws=await ok('GET',path(t,'workspace'));assert.equal(ws.view.unsent_content,view.unsent_content);assert.equal(ws.view.tab_scroll.input,240);
    actor=other;assert.equal((await send('GET',path(t,'workspace'))).statusCode,404);assert.equal((await ok('GET','/api/v1/m4/templates')).templates.length,0);actor=user;
    assert.equal((await send('POST',path(t,'quote'),{kind:'document',document_type:'private_summary',expected_draft_version:1})).json().code,'BILLING_NOT_READY');
    const config:M4BillingConfig={model_id:'synthetic-codex',rates:{'synthetic-codex':{input_microyuan_per_million:1000000,cached_microyuan_per_million:1000000,output_microyuan_per_million:2000000}},
      budgets:Object.fromEntries(Object.keys(M4_BILLING_TASKS).map(k=>[k,{input_tokens:1000000,output_tokens:1000000,reserve_factor:1.2}])) as M4BillingConfig['budgets']};
    await publishM4BillingConfig(pool,{id:'synthetic-m4-rates-v1',config,effective_at:'2026-01-01T00:00:00Z',actor:'synthetic-test',reason:'synthetic-only'});
    const comparisonQuote=await ok('POST',path(t,'quote'),{kind:'qa',content:'比较两期资产负债率',context});assert.equal(comparisonQuote.quote.task_type,'m4_Q04');assert.equal(comparisonQuote.quote.multiplier,4);
    const calculationQuote=await ok('POST',path(t,'quote'),{kind:'qa',content:'计算本期资产负债率',context});assert.equal(calculationQuote.quote.task_type,'m4_Q03');assert.equal(calculationQuote.quote.multiplier,3);
    const q=await ok('POST',path(t,'quote'),{kind:'document',document_type:'private_summary',expected_draft_version:1});assert.equal(q.quote.amount_semantics,'reservation_cap');assert.equal(q.quote.multiplier,6);assert.ok(q.shortage>0);
    const exec={execution_request_id:randomUUID(),document_type:'private_summary',expected_draft_version:1,quote_id:q.quote.quote_id,entrypoint:'workspace'};
    assert.equal((await send('POST',path(t,'execute'),exec)).json().code,'CREDITS_INSUFFICIENT');
    await transaction(pool,c=>grantCredits(c,{owner:user,points:10000,key:'synthetic-fund',source:'purchase',expiresAt:null,actor:'synthetic-test',reason:'synthetic-only'}));
    const run=(await ok('POST',path(t,'execute'),exec)).run;assert.equal(run.billing_mode,'metered_credits');assert.equal((await ok('POST',path(t,'execute'),exec)).run.run_id,run.run_id);
    const quote2=await ok('POST',path(t2,'quote'),{kind:'document',document_type:'private_summary',expected_draft_version:1});
    assert.equal((await send('POST',path(t2,'execute'),{...exec,execution_request_id:randomUUID(),quote_id:quote2.quote.quote_id})).json().code,'PROJECT_RUN_ACTIVE');
    const quote3=await ok('POST',path(t3,'quote'),{kind:'document',document_type:'private_summary',expected_draft_version:1});
    assert.equal((await send('POST',path(t3,'execute'),{...exec,execution_request_id:randomUUID(),quote_id:quote3.quote.quote_id})).json().code,'PROJECT_RUN_ACTIVE');
    await save(t,{...input,source_material:newer,materials:[newer]},1);
    const pinned=(await pool.query('SELECT manifest,input_hash FROM bb_m4_executions WHERE run_id=$1',[run.run_id])).rows[0];assert.equal(pinned.manifest.input.source_material.material_version,1);assert.equal(inputManifestHash(pinned.manifest),pinned.input_hash.trim());
    // Ordinary product help continues during document execution and produces a real text result.
    const help={submission_request_id:randomUUID(),content:'如何使用材料生成？',context};
    const free=(await ok('POST',path(t,'messages'),help));assert.equal(free.run.billing_mode,'platform_trial');assert.equal((await ok('POST',path(t,'messages'),help)).run.run_id,free.run.run_id);
    const lease=await claim(pool,30,{runKinds:['qa']});assert.ok(lease);assert.equal(lease.runId,free.run.run_id);const done=await finishM4Qa(pool,lease,reply);assert.equal(done.state,'succeeded');
    ws=await ok('GET',path(t,'workspace'));const qa=ws.artifacts.find((a:any)=>a.kind==='qa_text');assert.ok(qa);const exported=await send('GET',`/api/v1/m4/artifacts/${qa.artifact_id}/versions/1/bytes`);assert.equal(exported.statusCode,200,exported.body);assert.equal(exported.headers['content-type'],'text/plain');assert.match(exported.body,/Synthetic answer/);
    // Failed document releases its complete real reservation exactly once.
    await pool.query("UPDATE bb_jobs SET state='failed',lease_token=NULL,lease_until=NULL WHERE run_id=$1",[run.run_id]);await pool.query("UPDATE bb_runs SET state='failed' WHERE id=$1",[run.run_id]);assert.equal((await creditBalance(pool,user)).frozen,0);
    // New source in a previously unbound topic changes execution scope according to the exact chosen pin.
    const independent=await seedMaterial(different,'synthetic-independent.docx');await save(t3,{...input,source_material:independent,materials:[independent]},1);
    const q4=await ok('POST',path(t3,'quote'),{kind:'document',document_type:'private_summary',expected_draft_version:2});
    const r4=(await ok('POST',path(t3,'execute'),{...exec,execution_request_id:randomUUID(),expected_draft_version:2,quote_id:q4.quote.quote_id})).run;
    assert.equal((await pool.query('SELECT execution_scope_project_id FROM bb_projects WHERE id=$1',[t3.project_id])).rows[0].execution_scope_project_id,different);
    await pool.query("UPDATE bb_jobs SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE run_id=$1",[r4.run_id]);await pool.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1",[r4.run_id]);
    // Paid QA uses A=ceil(real cost*100*K), capped by B. Unknown usage is never written as zero.
    const paidRequest={submission_request_id:randomUUID(),content:'解释资产的概念',context};const pq=await ok('POST',path(t,'quote'),{kind:'qa',content:paidRequest.content,context});
    const paid=(await ok('POST',path(t,'messages'),{...paidRequest,quote_id:pq.quote.quote_id})).run;assert.equal(paid.billing_mode,'metered_credits');
    assert.deepEqual(await settleM4Metering(pool,user,paid.run_id),{ready:false,charged_points:null});
    const job=(await pool.query('SELECT id FROM bb_jobs WHERE run_id=$1',[paid.run_id])).rows[0].id,attempt=randomUUID();
    await pool.query(`INSERT INTO bb_model_call_attempts(id,owner_user_id,job_id,logical_call_id,attempt_no,status,usage_status,model_id) VALUES($1,$2,$3,'synthetic-logical-call',1,'completed','measured','synthetic-codex')`,[attempt,user,job]);
    await pool.query(`INSERT INTO bb_usage_observations(id,owner_user_id,attempt_id,source,source_event_id,usage_status,input_tokens,output_tokens,cached_input_tokens) VALUES($1,$2,$3,'provider','synthetic-usage','measured',1000,100,0)`,[randomUUID(),user,attempt]);
    const metered=await settleM4Metering(pool,user,paid.run_id);assert.deepEqual(metered,{ready:true,charged_points:1});assert.ok(pq.quote.points>1);
    await transaction(pool,async c=>{const artifact=await completeM4Qa(c,user,paid.run_id,reply);await c.query("UPDATE bb_jobs SET state='succeeded',lease_token=NULL,lease_until=NULL WHERE run_id=$1",[paid.run_id]);await c.query("UPDATE bb_runs SET artifact_id=$2,artifact_version=$3,state='succeeded' WHERE id=$1",[paid.run_id,artifact.artifactId,artifact.artifactVersion]);});
    const reservation=(await pool.query('SELECT state,points,charged_points FROM bb_credit_reservations WHERE run_id=$1',[paid.run_id])).rows[0];assert.equal(reservation.state,'settled');assert.equal(Number(reservation.charged_points),1);assert.equal((await creditBalance(pool,user)).frozen,0);
    const events=(await pool.query('SELECT kind,points FROM bb_credit_events WHERE run_id=$1 ORDER BY kind',[paid.run_id])).rows;assert.equal(events.filter(e=>e.kind==='settle').length,1);assert.equal(Number(events.find(e=>e.kind==='release').points),pq.quote.points-1);
    actor=other;assert.equal((await send('GET',`/api/v1/m4/artifacts/${qa.artifact_id}/versions/1/bytes`)).statusCode,404);actor=user;
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_m4_executions WHERE owner_user_id=$1',[user])).rows[0].n,4);
    // Unsupported requests receive free capability feedback without a selected document or a paid QA fallback.
    for(const content of ['请生成法律意见书','请实时查询公开信息','请检索最新法规并判断法规适用性']){
      const capability=(await ok('POST',path(t,'messages'),{submission_request_id:randomUUID(),content,context})).run;
      assert.equal(capability.billing_mode,'platform_trial');const capabilityLease=await claim(pool,30,{runKinds:['qa']});assert.ok(capabilityLease);assert.equal(capabilityLease.runId,capability.run_id);
      await finishM4Qa(pool,capabilityLease,{...reply,content:'Synthetic capability feedback: 此项 M4 尚未开放，没有执行。',intent:'clarify'});
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_credit_reservations WHERE run_id=$1',[capability.run_id])).rows[0].n,0);
    }
    // Preparing requirements before choosing a document is also free and persists pending requirements.
    const preparation=(await ok('POST',path(t2,'messages'),{submission_request_id:randomUUID(),content:'请把偿债能力作为重点，保留财务表格，不要新增风险承诺',context})).run;
    assert.equal(preparation.billing_mode,'platform_trial');const preparationLease=await claim(pool,30,{runKinds:['qa']});assert.ok(preparationLease);assert.equal(preparationLease.runId,preparation.run_id);
    await finishM4Qa(pool,preparationLease,{...reply,intent:'draft',requirements:['以偿债能力为重点','保留财务表格','不要新增风险承诺']});
    assert.equal((await ok('GET',path(t2,'workspace'))).pending_requirements.length,3);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_credit_reservations WHERE run_id=$1',[preparation.run_id])).rows[0].n,0);
    // Minimal clarifications and saved task requirements are free; assistant adoption never starts a document.
    const taskContext={...context,document_type:'private_summary' as const,draft_version:2,source_material:newer};
    const clarification=(await ok('POST',path(t,'messages'),{submission_request_id:randomUUID(),content:'券商是Synthetic broker，保留待核事项。',context:taskContext})).run;
    assert.equal(clarification.billing_mode,'platform_trial');let taskLease=await claim(pool,30,{runKinds:['qa']});assert.ok(taskLease);
    await finishM4Qa(pool,taskLease,{...reply,intent:'draft',document_type:'private_summary',fields:{broker:'Synthetic broker',reporting_period:'2026-09-30'},requirements:['保留待核事项']});
    ws=await ok('GET',path(t,'workspace'));assert.equal(ws.drafts.private_summary.version,3);assert.equal(ws.drafts.private_summary.fields.broker,'Synthetic broker');
    assert.equal(ws.drafts.private_summary.fields.reporting_cutoff,'2026-09-30');assert.equal(ws.drafts.private_summary.fields.reporting_period,undefined);
    assert.equal(ws.tasks.filter((x:any)=>x.manifest.kind==='document').length,1);
    // Unbound requirements are consumed exactly once into the first selected document draft.
    const unbound=(await ok('POST',path(t,'messages'),{submission_request_id:randomUUID(),content:'任务要求保存：不要生成签署页。',context})).run;
    taskLease=await claim(pool,30,{runKinds:['qa']});assert.ok(taskLease);assert.equal(taskLease.runId,unbound.run_id);
    await finishM4Qa(pool,taskLease,{...reply,intent:'draft',requirements:['不要生成签署页']});ws=await ok('GET',path(t,'workspace'));assert.equal(ws.pending_requirements.length,1);
    const {version:_v,sha256:_h,updated_at:_u,...initInput}=ws.drafts.init;
    await save(t,initInput,1);ws=await ok('GET',path(t,'workspace'));assert.equal(ws.pending_requirements.length,0);assert.equal(ws.drafts.init.requirements[0].text,'不要生成签署页');
    assert.equal(ws.drafts.private_summary.requirements.some((r:any)=>r.text==='不要生成签署页'),false);
    // A natural language primary action is understood through the pinned CLI result, then host quote checks execute once.
    const iq=await ok('POST',path(t,'quote'),{kind:'document',document_type:'init',expected_draft_version:2});
    const intentMessage={submission_request_id:randomUUID(),content:'请生成完整立项报告，不要只修改某个段落；按已保存的发行人、券商和报告期执行，不要生成签署页。',context:{...context,document_type:'init',draft_version:2},execute:true,quote_id:iq.quote.quote_id};
    const intentRun=(await ok('POST',path(t,'messages'),intentMessage)).run;assert.equal(intentRun.billing_mode,'platform_trial');
    taskLease=await claim(pool,30,{runKinds:['qa']});assert.ok(taskLease);assert.equal(taskLease.runId,intentRun.run_id);
    await finishM4Qa(pool,taskLease,{...reply,intent:'execute',document_type:'init',requirements:['不要生成签署页'],fields:{issuer_name:'Synthetic issuer',market:'sse',broker:'Synthetic broker',reporting_period:'2026-09-30'}});
    ws=await ok('GET',path(t,'workspace'));const doc=ws.tasks.find((x:any)=>x.manifest.kind==='document'&&x.run.state==='queued');assert.ok(doc);assert.equal(doc.manifest.input.document_type,'init');assert.equal(doc.manifest.input.requirements[0].text,'不要生成签署页');
    assert.equal(ws.drafts.init.version,2);assert.equal(doc.manifest.input.scope,'whole');assert.equal(doc.manifest.input.fields.reporting_cutoff,'2026-09-30');
    const repeated=(await ok('POST',path(t,'messages'),intentMessage)).run;assert.equal(repeated.run_id,intentRun.run_id);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_credit_reservations WHERE quote_id=$1',[iq.quote.quote_id])).rows[0].n,1);
    await pool.query("UPDATE bb_jobs SET state='failed',lease_token=NULL,lease_until=NULL WHERE run_id=$1",[doc.run.run_id]);await pool.query("UPDATE bb_runs SET state='failed' WHERE id=$1",[doc.run.run_id]);
    // A genuinely new requirement changes the input and cannot spend the earlier displayed quote automatically.
    const newRequirementQuote=await ok('POST',path(t,'quote'),{kind:'document',document_type:'init',expected_draft_version:2});
    const newRequirementRun=(await ok('POST',path(t,'messages'),{submission_request_id:randomUUID(),content:'请生成立项报告，并新增要求：金额使用万元。',context:{...context,document_type:'init',draft_version:2},execute:true,quote_id:newRequirementQuote.quote.quote_id})).run;
    taskLease=await claim(pool,30,{runKinds:['qa']});assert.ok(taskLease);assert.equal(taskLease.runId,newRequirementRun.run_id);
    await finishM4Qa(pool,taskLease,{...reply,intent:'execute',document_type:'init',requirements:['不要生成签署页','金额使用万元']});
    ws=await ok('GET',path(t,'workspace'));assert.equal(ws.drafts.init.version,3);assert.ok(ws.drafts.init.requirements.some((r:any)=>r.text==='金额使用万元'));
    assert.equal(ws.tasks.some((x:any)=>x.manifest.kind==='document'&&x.run.state==='queued'),false);
    assert.match(ws.messages.find((m:any)=>m.reply_to&&m.run_id===newRequirementRun.run_id).error,/输入或要求已更新/);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_credit_reservations WHERE quote_id=$1',[newRequirementQuote.quote.quote_id])).rows[0].n,0);
    // Even a no-op semantic reply consumes real pending requirements once, invalidating the old input quote.
    const pendingRun=(await ok('POST',path(t,'messages'),{submission_request_id:randomUUID(),content:'任务要求保存：保留财务表格。',context})).run;
    taskLease=await claim(pool,30,{runKinds:['qa']});assert.ok(taskLease);assert.equal(taskLease.runId,pendingRun.run_id);
    await finishM4Qa(pool,taskLease,{...reply,intent:'draft',requirements:['保留财务表格']});
    const pendingQuote=await ok('POST',path(t,'quote'),{kind:'document',document_type:'init',expected_draft_version:3});
    const pendingIntentRun=(await ok('POST',path(t,'messages'),{submission_request_id:randomUUID(),content:'请生成完整立项报告，不要只修改某个段落。',context:{...context,document_type:'init',draft_version:3},execute:true,quote_id:pendingQuote.quote.quote_id})).run;
    taskLease=await claim(pool,30,{runKinds:['qa']});assert.ok(taskLease);assert.equal(taskLease.runId,pendingIntentRun.run_id);
    await finishM4Qa(pool,taskLease,{...reply,intent:'execute',document_type:'init',requirements:['不要生成签署页','金额使用万元'],fields:{issuer_name:'Synthetic issuer',market:'sse',broker:'Synthetic broker',reporting_period:'2026-09-30'}});
    ws=await ok('GET',path(t,'workspace'));assert.equal(ws.drafts.init.version,4);assert.equal(ws.pending_requirements.length,0);assert.ok(ws.drafts.init.requirements.some((r:any)=>r.text==='保留财务表格'));
    assert.equal(ws.tasks.some((x:any)=>x.manifest.kind==='document'&&x.run.state==='queued'),false);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_credit_reservations WHERE quote_id=$1',[pendingQuote.quote.quote_id])).rows[0].n,0);
    assert.equal((await send('POST',path(t,'execute'),{...exec,execution_request_id:randomUUID(),document_type:'init',expected_draft_version:3,quote_id:pendingQuote.quote.quote_id})).json().code,'INPUT_REVISION_CONFLICT');
    // Usage-only pending delivers the known text and pauses settlement. Recovery never dispatches a new supplier call.
    const uq=await ok('POST',path(t,'quote'),{kind:'qa',content:'解释负债的概念',context});
    const unknown=(await ok('POST',path(t,'messages'),{submission_request_id:randomUUID(),content:'解释负债的概念',context,quote_id:uq.quote.quote_id})).run;
    const unknownLease=await claim(pool,30,{runKinds:['qa']});assert.ok(unknownLease);assert.equal(unknownLease.runId,unknown.run_id);
    const prompt=Buffer.from('Synthetic M4 unknown usage prompt'),objectKey=`users/${user}/projects/${t.project_id}/snapshots/synthetic-m4-prompt`;
    await blobs.put(objectKey,prompt,'text/plain');const promptRef=await saveSnapshotRef(pool,{owner:user,projectId:t.project_id,runId:unknown.run_id,kind:'model_request',version:1,objectKey,sha256:digest(prompt),redactionVersion:'synthetic_v1',inputRevision:unknown.input_revision,inputHash:unknown.input_hash,blobs});
    const callId=await recordPotentialCall(pool,unknownLease,'synthetic-m4-pending-call',1,{modelId:'synthetic-codex',promptSnapshotId:promptRef});
    const intent={owner_user_id:user,project_id:t.project_id,run_id:unknown.run_id,job_id:unknownLease.jobId,trace_id:unknown.run_id,logical_call_id:'synthetic-m4-pending-call',call_id:callId,attempt_no:1,model_id:'synthetic-codex',model_config_version:'synthetic-v1',prompt_snapshot_ref:promptRef};
    const validate=(value:unknown)=>!!value&&(value as any).synthetic===true;
    const result=await persistProviderResultObject({blobs,intent,bytes:Buffer.from('{"synthetic":true}'),resultSchemaVersion:'synthetic-v1',validate});
    const observation:ProviderCallObservation={...intent,...result,provider_request_id:null,finish_reason:'stop',outcome:'pending_reconcile',error_code:'MODEL_USAGE_PENDING',usage:{status:'unknown',input_tokens:null,cached_input_tokens:null,output_tokens:null,reasoning_tokens:null,total_tokens:null}};
    assert.equal((await recordProviderCallObservation(pool,blobs,observation,validate,{lease:unknownLease,source:'provider'})).attempt_status,'completed');
    assert.deepEqual((await readCheckpointedProviderResult({pool,blobs,lease:unknownLease,logicalCallId:intent.logical_call_id,attemptNo:1,validateResult:validate}))!.value,{synthetic:true});
    assert.equal((await finishM4Qa(pool,unknownLease,reply)).state,'settlement_pending');assert.equal((await pausedRuns(pool,'provider_reconcile',20,['qa'])).some(x=>x.run_id===unknown.run_id),true);
    assert.equal(await resumePausedRun(pool,user,unknown.run_id,'provider_reconciled'),false);
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_credit_events WHERE run_id=$1 AND kind='settle'",[unknown.run_id])).rows[0].n,0);
    ws=await ok('GET',path(t,'workspace'));const pendingText=ws.artifacts.find((a:any)=>a.run_id===unknown.run_id&&a.kind==='qa_text');assert.ok(pendingText);
    assert.match((await ok('GET',`/api/v1/m4/artifacts/${pendingText.artifact_id}/versions/1/preview`)).content,/Synthetic answer/);
    const pendingDownload=await send('GET',`/api/v1/m4/artifacts/${pendingText.artifact_id}/versions/1/bytes`);assert.equal(pendingDownload.statusCode,200);assert.equal(digest(pendingDownload.rawPayload),pendingText.sha256);
    const pendingReservation=(await pool.query('SELECT state,charged_points FROM bb_credit_reservations WHERE run_id=$1',[unknown.run_id])).rows[0];assert.equal(pendingReservation.state,'held');assert.equal(pendingReservation.charged_points,null);
    const pendingPin={source_project_id:pendingText.source_project_id,artifact_id:pendingText.artifact_id,artifact_version:pendingText.artifact_version,sha256:pendingText.sha256};
    const pendingContext={...context,reading_artifact:pendingPin,citations:[{kind:'artifact' as const,ref:pendingPin,locator:'line 1'}]};
    const pendingDiscussion=(await ok('POST',path(t,'messages'),{submission_request_id:randomUUID(),content:'根据这版结果整理当前任务要求。',context:pendingContext})).run;
    assert.equal(pendingDiscussion.billing_mode,'platform_trial');const discussionLease=await claim(pool,30,{runKinds:['qa']});assert.ok(discussionLease);assert.equal(discussionLease.runId,pendingDiscussion.run_id);
    await finishM4Qa(pool,discussionLease,{...reply,citations:pendingContext.citations});
    assert.equal((await send('POST',path(t,'messages'),{submission_request_id:randomUUID(),content:'根据这版结果整理当前任务要求。',context:{...pendingContext,reading_artifact:{...pendingPin,sha256:'0'.repeat(64)}}})).statusCode,404);
    await observeUsage(pool,{owner:user,attemptId:callId,source:'provider',sourceEventId:'synthetic-late-m4-usage',status:'measured',inputTokens:1000,outputTokens:100,cachedInputTokens:0});
    assert.equal(await resumePausedRun(pool,user,unknown.run_id,'provider_reconciled'),true);const resumed=await claim(pool,30,{runKinds:['qa']});assert.ok(resumed);assert.equal(resumed.runId,unknown.run_id);
    assert.equal((await finishM4Qa(pool,resumed,reply)).state,'succeeded');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE job_id=$1',[unknownLease.jobId])).rows[0].n,1);
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_credit_events WHERE run_id=$1 AND kind='settle'",[unknown.run_id])).rows[0].n,1);
    // DOCX body and independent preparation note are both required before M4 settlement.
    const executeDoc=async(version:number)=>{const quote=await ok('POST',path(t,'quote'),{kind:'document',document_type:'init',expected_draft_version:version});
      return (await ok('POST',path(t,'execute'),{...exec,execution_request_id:randomUUID(),document_type:'init',expected_draft_version:version,quote_id:quote.quote.quote_id})).run;};
    const makePair=async(r:any,number:number)=>{const docLease=await claim(pool,30,{runKinds:['generation']});assert.ok(docLease);assert.equal(docLease.runId,r.run_id);
      const docBytes=makeSyntheticDocxFixture({text:`Synthetic M4 document draft ${number}`}),noteBytes=makeSyntheticDocxFixture({text:`Synthetic M4 preparation note draft ${number}`});
      const document=await promoteWordArtifact(pool,docLease,docBytes,blobs,'generated_pair_v1');
      await transaction(pool,c=>registerM4Artifacts(c,user,r.run_id,[{kind:'document',artifact_id:document.artifactId,artifact_version:1,filename:'document.docx',byte_size:docBytes.length,preview_content:`Synthetic body ${number}`} ]));
      const note=await promoteWordArtifact(pool,docLease,noteBytes,blobs,'generated_pair_v1');
      const meteringJob=(await pool.query('SELECT id FROM bb_jobs WHERE run_id=$1',[r.run_id])).rows[0].id,measurementId=randomUUID();
      await pool.query(`INSERT INTO bb_model_call_attempts(id,owner_user_id,job_id,logical_call_id,attempt_no,status,usage_status,model_id) VALUES($1,$2,$3,'synthetic-doc-cost',1,'completed','measured','synthetic-codex')`,[measurementId,user,meteringJob]);
      await pool.query(`INSERT INTO bb_usage_observations(id,owner_user_id,attempt_id,source,source_event_id,usage_status,input_tokens,output_tokens,cached_input_tokens) VALUES($1,$2,$3,'provider','synthetic-doc-usage','measured',1000,100,0)`,[randomUUID(),user,measurementId]);
      await settleM4Metering(pool,user,r.run_id);
      // Exercise database delivery guards independently of supplier reconciliation (the cost is explicitly synthetic).
      await assert.rejects(()=>transaction(pool,async c=>{await c.query("UPDATE bb_runs SET artifact_id=$2,artifact_version=1,state='succeeded' WHERE id=$1",[r.run_id,document.artifactId]);}),/document and preparation note must be delivered/);
      await transaction(pool,c=>registerM4Artifacts(c,user,r.run_id,[{kind:'preparation_note',artifact_id:note.artifactId,artifact_version:1,filename:'preparation-note.docx',byte_size:noteBytes.length,preview_content:`Synthetic notes ${number}`} ]));
      await transaction(pool,async c=>{await c.query("UPDATE bb_jobs SET state='succeeded',lease_token=NULL,lease_until=NULL WHERE run_id=$1",[r.run_id]);await c.query("UPDATE bb_runs SET artifact_id=$2,artifact_version=1,state='succeeded' WHERE id=$1",[r.run_id,document.artifactId]);});
      const delivered=(await ok('GET',path(t,'workspace'))).artifacts.filter((a:any)=>a.run_id===r.run_id);assert.equal(delivered.length,2);
      for(const a of delivered){assert.equal(a.revision_number,number);assert.match(a.filename,new RegExp(`第${number}稿`));const download=await send('GET',`/api/v1/m4/artifacts/${a.artifact_id}/versions/1/bytes`);assert.equal(download.statusCode,200,download.body);assert.equal(digest(download.rawPayload),a.sha256);}
      return delivered.find((a:any)=>a.kind==='document');};
    const doc1=await makePair(await executeDoc(4),1);
    ws=await ok('GET',path(t,'workspace'));const {version:_iv,sha256:_ih,updated_at:_it,...currentInit}=ws.drafts.init;
    await save(t,{...currentInit,edit_base:{source_project_id:doc1.source_project_id,artifact_id:doc1.artifact_id,artifact_version:doc1.artifact_version,sha256:doc1.sha256}},4);
    const doc2=await makePair(await executeDoc(5),2);assert.equal(doc2.base_artifact.artifact_id,doc1.artifact_id);assert.notEqual(doc2.artifact_id,doc1.artifact_id);assert.equal(doc2.artifact_version,1);
  }finally{await app.close();await pool.end();}
});
