import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {AUTOMATIC_PRICE_VERSION,AUTOMATIC_TASK_TARIFF,OUTCOME_PRICE_VERSION,type ProjectFileCheckResult,type ProjectFileFinding,type WorkpaperEntry} from '@bondbuddy/contracts';
import {creditBalance,grantCredits} from './billing.js';
import {transaction,type PrivateBlobs} from './data.js';
import {makeSyntheticDocxFixture} from './docx-fixtures.js';
import {emptyM4Draft} from './m4-workspace.js';
import {advanceProjectFileUpdates} from './project-file-consistency.js';
import {advanceWorkpaperBatch} from './workpapers.js';
import {inputManifestHash} from './production-rule-pin.js';
import {checkpointStage,claim,finish,promoteWordArtifact} from './queue.js';
import {createServer} from './server.js';
import {isolatedTestDatabase} from './test-database.js';

// Real HTTP handlers, an isolated PostgreSQL clone and synthetic delivery evidence.
// No real customer materials, payment provider or model invocation is involved.
const database=await isolatedTestDatabase(undefined,'automatic-file-billing');
const sha='a'.repeat(64),media='application/vnd.openxmlformats-officedocument.wordprocessingml.document',origin='https://synthetic.invalid';
function memoryBlobs():PrivateBlobs{
  const values=new Map<string,Buffer>();
  return {put:async(k,b)=>{values.set(k,Buffer.from(b));},get:async k=>{const b=values.get(k);assert.ok(b);return b;},getIfExists:async k=>values.get(k)??null,
    getIfExistsBounded:async(k,n)=>{const b=values.get(k);if(b&&b.length>n)throw Error('Synthetic read exceeds bound');return b??null;},exists:async k=>values.has(k),delete:async k=>{values.delete(k);}};
}
async function material(pool:Pool,owner:string,project:string,name:string){
  const id=randomUUID(),upload=randomUUID();
  await pool.query("INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state) VALUES($1,$2,$3,$4,$5,1,$6,'other',$1,now()+interval '1 day','completed')",[upload,owner,project,name,media,sha]);
  await pool.query("INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state) VALUES($1,1,$2,$3,$4,'other',$5,$6,1,$7,$1,'persisted')",[id,owner,project,upload,name,media,sha]);
  return {kind:'material' as const,pin:{source_project_id:project,material_id:id,material_version:1,sha256:sha}};
}
async function fixture(pool:Pool){
  const owner=randomUUID(),project=randomUUID(),sourceVersion=randomUUID(),file=randomUUID(),version=randomUUID();
  await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'synthetic_auto_file_'+owner.slice(0,8)]);
  await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind,issuer_name,market,offering) VALUES($1,$2,'Synthetic automatic file project','generation','Synthetic issuer','sse','private')",[project,owner]);
  const source=await material(pool,owner,project,'Synthetic prospectus.docx'),target=await material(pool,owner,project,'Synthetic target.docx');
  await pool.query("INSERT INTO bb_prospectus_versions(id,owner_user_id,project_id,sequence,origin,filename,sha256,material_id,material_version) VALUES($1,$2,$3,1,'upload','Synthetic prospectus.docx',$4,$5,1)",[sourceVersion,owner,project,sha,source.pin.material_id]);
  await pool.query('INSERT INTO bb_prospectus_selection(owner_user_id,project_id,version_id,revision) VALUES($1,$2,$3,1)',[owner,project,sourceVersion]);
  await pool.query("INSERT INTO bb_project_files(id,owner_user_id,project_id,document_type) VALUES($1,$2,$3,'init')",[file,owner,project]);
  await pool.query("INSERT INTO bb_project_file_versions(id,owner_user_id,file_id,sequence,filename,asset,source_version_id) VALUES($1,$2,$3,1,'Synthetic target.docx',$4,$5)",[version,owner,file,target,sourceVersion]);
  await pool.query('UPDATE bb_project_files SET latest_version_id=$2 WHERE id=$1',[file,version]);
  return {owner,project,sourceVersion,source,file,version};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function server(pool:Pool,f:Fixture,automatic=true){
  return createServer({pool,enableSubscriptionBilling:automatic,enableOutcomePricing:true,allowedOrigin:origin,paymentProviders:[],principal:async()=>({userId:f.owner,csrfVerified:true})});
}
async function fund(pool:Pool,owner:string,points:number){
  await transaction(pool,c=>grantCredits(c,{owner,points,key:randomUUID(),source:'purchase',expiresAt:null,actor:'synthetic-test',reason:'Synthetic automatic-file billing test only'}));
}
async function counts(pool:Pool,owner:string){
  return (await pool.query(`SELECT
    (SELECT count(*)::int FROM bb_runs WHERE owner_user_id=$1) AS runs,
    (SELECT count(*)::int FROM bb_credit_reservations WHERE owner_user_id=$1) AS reservations,
    (SELECT count(*)::int FROM bb_project_file_update_batches WHERE owner_user_id=$1) AS updates,
    (SELECT count(*)::int FROM bb_workpaper_batches WHERE owner_user_id=$1) AS workpapers`,[owner])).rows[0];
}
async function deliverCheck(pool:Pool,runId:string,version:string){
  const finding:ProjectFileFinding={id:'synthetic-conflict',kind:'conflict',target_span_id:'target-1',original:'100',replacement:'120',source_span_id:'source-1',source_quote:'120',source_location:'Synthetic source page 1',target_location:'Synthetic target page 1',reason:'Synthetic amount changed',field:'Synthetic amount',period:'2026',unit:'CNY'};
  const result:ProjectFileCheckResult={version:'project-file-check-v1',files:[{file_version_id:version,status:'conflict',coverage:'Synthetic amount only',findings:[finding],links:[]}]},hash=inputManifestHash(result);
  await pool.query('UPDATE bb_project_file_operations SET result=$2,result_hash=$3 WHERE run_id=$1',[runId,result,hash]);
  // This API-only fixture supplies explicit synthetic host coverage; the worker
  // suite separately verifies real Word extraction and untrusted proposals.
  await pool.query(`INSERT INTO bb_project_file_check_evidence(owner_user_id,run_id,file_version_id,input_hash,source_sha256,target_sha256,checked_spans,total_spans)
    SELECT r.owner_user_id,r.id,$2,r.input_hash,o.manifest#>>'{source,asset,pin,sha256}',f#>>'{asset,pin,sha256}',1,1
    FROM bb_runs r JOIN bb_project_file_operations o ON o.run_id=r.id, jsonb_array_elements(o.manifest->'files') f
    WHERE r.id=$1 AND f->>'file_version_id'=$2`,[runId,version]);
  const lease=await claim(pool);assert.ok(lease);assert.equal(lease.runId,runId);
  const blobs=memoryBlobs(),report=await promoteWordArtifact(pool,lease,makeSyntheticDocxFixture({text:'Synthetic consistency report'}),blobs,'generated_review_v1');
  await finish(pool,lease,'succeeded',{artifactId:report.artifactId,artifactVersion:1,blobs});
  return hash;
}
async function deliverPatch(pool:Pool,f:Fixture,runId:string){
  const lease=await claim(pool);assert.ok(lease);assert.equal(lease.runId,runId);const blobs=memoryBlobs();
  const revision=await promoteWordArtifact(pool,lease,makeSyntheticDocxFixture({text:'Synthetic tracked correction: 100 to 120'}),blobs,'generated_pair_v1');
  const clean=await promoteWordArtifact(pool,lease,makeSyntheticDocxFixture({text:'Synthetic clean correction: 120'}),blobs,'generated_pair_v1');
  await checkpointStage(pool,lease,'word_delivery_pair',{revision_artifact_id:revision.artifactId,clean_artifact_id:clean.artifactId});
  const cleanRow=(await pool.query('SELECT sha256 FROM bb_artifact_versions WHERE id=$1 AND version=1',[clean.artifactId])).rows[0];
  const links={links:[],source_sha256:f.source.pin.sha256,target_sha256:cleanRow.sha256.trim(),warnings:['Synthetic delivery fixture only']};
  await pool.query('INSERT INTO bb_project_file_generation_links(run_id,owner_user_id,result,result_hash) VALUES($1,$2,$3,$4)',[runId,f.owner,links,inputManifestHash(links)]);
  await finish(pool,lease,'succeeded',{artifactId:revision.artifactId,artifactVersion:1,blobs});
  const version=(await pool.query('SELECT id FROM bb_project_file_versions WHERE owner_user_id=$1 AND run_id=$2',[f.owner,runId])).rows[0];
  assert.ok(version);assert.notEqual(version.id,f.version);
  assert.equal((await pool.query('SELECT latest_version_id FROM bb_project_files WHERE id=$1',[f.file])).rows[0].latest_version_id,version.id);
  return version.id as string;
}

for(const legacy of [false,true])test(legacy
  ?'HTTP automatic billing preserves the 1000-point revision upgrade for a settled old 990-point check'
  :'HTTP automatic billing includes same-scope revision in a settled new check without another hold',
  {skip:!database,timeout:120000},async()=>{
    const pool=new Pool({connectionString:database}),f=await fixture(pool);let app=server(pool,f,!legacy);
    const base=`/api/v1/projects/${f.project}/project-files`,checkPoints=legacy?990:AUTOMATIC_TASK_TARIFF.check.points,upgradePoints=legacy?1000:0;
    try{
      await fund(pool,f.owner,20000);
      const request={request_id:randomUUID(),expected_source_version_id:f.sourceVersion,file_version_ids:[f.version]};
      const quoted=await app.inject({method:'POST',url:base+'/checks/quote',headers:{origin},payload:request});
      assert.equal(quoted.statusCode,200,quoted.body);assert.equal(quoted.json().points,checkPoints);assert.equal(quoted.json().quote_status,'ready');
      assert.equal(quoted.json().price_version,legacy?OUTCOME_PRICE_VERSION:AUTOMATIC_PRICE_VERSION);
      const started=await app.inject({method:'POST',url:base+'/checks',headers:{origin},payload:{...request,expected_points:checkPoints,price_version:quoted.json().price_version,scope_quote_id:quoted.json().scope_quote_id}});
      assert.equal(started.statusCode,200,started.body);const check=started.json().run_id,checkHash=await deliverCheck(pool,check,f.version);
      assert.deepEqual(await creditBalance(pool,f.owner),{available:20000-checkPoints,frozen:0});
      const paid=(await pool.query('SELECT state,charged_points FROM bb_credit_reservations WHERE run_id=$1',[check])).rows[0];
      assert.equal(paid.state,'settled');assert.equal(Number(paid.charged_points),checkPoints);
      if(legacy){await app.close();app=server(pool,f,true);}

      const updateRequest={expected_check_sha256:checkHash,files:[{file_version_id:f.version}]},url=base+'/checks/'+check+'/updates';
      const upgrade=await app.inject({method:'POST',url:url+'/quote',headers:{origin},payload:updateRequest});
      assert.equal(upgrade.statusCode,200,upgrade.body);const q=upgrade.json();
      assert.equal(q.quote_status,'ready');assert.equal(q.price_version,AUTOMATIC_PRICE_VERSION);assert.equal(q.points,upgradePoints);
      const scopeId=q.items[0].scope_quote_id,scope=(await pool.query('SELECT * FROM bb_scope_quotations WHERE id=$1',[scopeId])).rows[0];
      assert.equal(scope.snapshot.paid_check.run_id,check);assert.equal(Number(scope.snapshot.paid_check.points),checkPoints);
      assert.equal(scope.snapshot.paid_check.price_version,legacy?OUTCOME_PRICE_VERSION:AUTOMATIC_PRICE_VERSION);
      const acceptedRequest={...updateRequest,request_id:randomUUID(),price_version:AUTOMATIC_PRICE_VERSION,expected_points:upgradePoints,files:[{file_version_id:f.version,scope_quote_id:scopeId}]};
      const accepted=await app.inject({method:'POST',url,headers:{origin},payload:acceptedRequest});
      assert.equal(accepted.statusCode,200,accepted.body);
      const duplicate=await app.inject({method:'POST',url,headers:{origin},payload:acceptedRequest});
      assert.equal(duplicate.statusCode,200,duplicate.body);assert.equal(duplicate.json().batch_id,accepted.json().batch_id);
      await advanceProjectFileUpdates(pool);
      const batch=(await pool.query('SELECT * FROM bb_project_file_update_batches WHERE id=$1',[accepted.json().batch_id])).rows[0],item=batch.items[0];
      assert.equal(batch.state,'running',item.error??'Expected queued upgrade to start');assert.ok(item.run_id);assert.equal(item.points,upgradePoints);
      const revision=(await pool.query('SELECT * FROM bb_project_file_update_quotes WHERE run_id=$1',[item.run_id])).rows[0];
      assert.equal(revision.price_version,AUTOMATIC_PRICE_VERSION);assert.equal(Number(revision.points),upgradePoints);assert.equal(revision.scope_quote_id,scopeId);
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_credit_reservations WHERE run_id=$1',[item.run_id])).rows[0].n,legacy?1:0);
      assert.deepEqual(await creditBalance(pool,f.owner),{available:20000-checkPoints-upgradePoints,frozen:upgradePoints});
      assert.equal((await pool.query('SELECT count(*)::int n FROM bb_automatic_scope_runs WHERE run_id=$1',[item.run_id])).rows[0].n,1);
      if(legacy){
        // A failed legacy upgrade releases its real hold without returning the delivered check's charge.
        await pool.query("UPDATE bb_runs SET state='failed' WHERE id=$1",[item.run_id]);
      }else{
        // The delivered repair creates V2. Revalidating that platform-produced descendant stays included.
        const repairedVersion=await deliverPatch(pool,f,item.run_id),beforeRecheck=await counts(pool,f.owner);
        const recheckRequest={request_id:randomUUID(),expected_source_version_id:f.sourceVersion,file_version_ids:[repairedVersion]};
        const recheck=await app.inject({method:'POST',url:base+'/checks/quote',headers:{origin},payload:recheckRequest});
        assert.equal(recheck.statusCode,200,recheck.body);assert.equal(recheck.json().points,0);assert.equal(recheck.json().price_version,AUTOMATIC_PRICE_VERSION);
        const rechecked=await app.inject({method:'POST',url:base+'/checks',headers:{origin},payload:{...recheckRequest,expected_points:0,price_version:AUTOMATIC_PRICE_VERSION,scope_quote_id:recheck.json().scope_quote_id}});
        assert.equal(rechecked.statusCode,200,rechecked.body);await deliverCheck(pool,rechecked.json().run_id,repairedVersion);
        assert.equal((await counts(pool,f.owner)).reservations,beforeRecheck.reservations);
        assert.deepEqual(await creditBalance(pool,f.owner),{available:20000-checkPoints,frozen:0});
        const recheckQuote=(await pool.query('SELECT points,charged_file_versions FROM bb_project_file_check_quotes WHERE run_id=$1',[rechecked.json().run_id])).rows[0];
        assert.equal(Number(recheckQuote.points),0);assert.deepEqual(recheckQuote.charged_file_versions,[]);
        // A user upload has no paid repair lineage and must create a new paid check scope.
        const uploaded=await material(pool,f.owner,f.project,'Synthetic new user revision.docx');
        const imported=await app.inject({method:'POST',url:base+'/imports',headers:{origin},payload:{request_id:randomUUID(),document_type:'init',material:uploaded.pin,expected_latest_version_id:repairedVersion}});
        assert.equal(imported.statusCode,200,imported.body);const uploadedVersion=imported.json().files.find((file:any)=>file.latest).version_id;
        const newCheck=await app.inject({method:'POST',url:base+'/checks/quote',headers:{origin},payload:{request_id:randomUUID(),expected_source_version_id:f.sourceVersion,file_version_ids:[uploadedVersion]}});
        assert.equal(newCheck.statusCode,200,newCheck.body);assert.equal(newCheck.json().points,checkPoints);
      }
      await pool.query("UPDATE bb_project_file_update_batches SET state='cancelled' WHERE id=$1",[batch.id]);
      assert.deepEqual(await creditBalance(pool,f.owner),{available:20000-checkPoints,frozen:0});
    }finally{await app.close();await pool.end();}
  });

test('HTTP project file batch carries automatic tariff metadata and accepts the matching executable quote',{skip:!database,timeout:120000},async()=>{
  const pool=new Pool({connectionString:database}),f=await fixture(pool),app=server(pool,f),base=`/api/v1/projects/${f.project}/project-files`;
  const send=(method:'GET'|'POST'|'PUT',url:string,payload?:Record<string,unknown>)=>app.inject({method,url,headers:{origin},payload});
  try{
    const prepared=await send('POST',base+'/workspace',{request_id:randomUUID()});assert.equal(prepared.statusCode,200,prepared.body);
    const topic=prepared.json().workspace.topic.topic_id,templateMaterial=await material(pool,f.owner,f.project,'Synthetic summary template.docx');
    const templateResponse=await send('POST','/api/v1/m4/templates',{creation_request_id:randomUUID(),name:'Synthetic summary template',broker:'Synthetic broker',document_type:'private_summary',market:'sse',offering:'private',material:templateMaterial.pin});
    assert.equal(templateResponse.statusCode,200,templateResponse.body);const template=templateResponse.json().template;
    const saved=await send('PUT',`/api/v1/m4/topics/${topic}/drafts/private_summary`,{expected_version:0,input:{...emptyM4Draft('private_summary'),source_material:f.source.pin,materials:[],template:{template_id:template.template_id,template_version:template.template_version,sha256:template.sha256},
      project_file:{project_id:f.project,source_version_id:f.sourceVersion,source_selection_revision:1},fields:{issuer_name:'Synthetic issuer',market:'sse',offering:'private',broker:'Synthetic broker'}}});
    assert.equal(saved.statusCode,200,saved.body);
    const request={request_id:randomUUID(),source_version_id:f.sourceVersion,expected_selection_revision:1,documents:[{document_type:'private_summary',draft_version:saved.json().draft.version}]};
    const quoted=await send('POST',base+'/batches/quote',request);assert.equal(quoted.statusCode,200,quoted.body);const q=quoted.json();
    assert.equal(q.quote_status,'ready');assert.equal(q.price_version,AUTOMATIC_PRICE_VERSION);assert.equal(q.auto_charge,true);
    assert.equal(q.points,AUTOMATIC_TASK_TARIFF.related.points);assert.equal(q.documents[0].price_version,AUTOMATIC_PRICE_VERSION);assert.equal(q.documents[0].auto_charge,true);
    const internalQuote=(await pool.query('SELECT expires_at FROM bb_m4_quotes WHERE owner_user_id=$1 AND scope_quote_id=$2 ORDER BY created_at DESC LIMIT 1',[f.owner,q.documents[0].scope_quote_id])).rows[0];
    assert.ok(new Date(internalQuote.expires_at).getTime()>Date.now()+6*86400000,'automatic quote retains its locked scope during a payment return, instead of expiring after five minutes');
    await fund(pool,f.owner,q.points);
    const accepted=await send('POST',base+'/batches',{...request,price_version:q.price_version,expected_points:q.points,documents:[{...request.documents[0],scope_quote_id:q.documents[0].scope_quote_id}]});
    assert.equal(accepted.statusCode,200,accepted.body);assert.equal(accepted.json().state,'queued');
    assert.equal(accepted.json().items[0].price_version,AUTOMATIC_PRICE_VERSION);assert.equal(accepted.json().items[0].auto_charge,true);
    const batch=(await pool.query('SELECT * FROM bb_project_file_batches WHERE id=$1',[accepted.json().batch_id])).rows[0];
    assert.equal(batch.items[0].points,q.points);assert.ok(batch.items[0].scope_acceptance_id);
    await pool.query("UPDATE bb_project_file_batches SET state='cancelled' WHERE id=$1",[batch.id]);
  }finally{await app.close();await pool.end();}
});

test('HTTP automatic workpaper generation returns 402 without creating a batch or hold when points are insufficient',{skip:!database,timeout:120000},async()=>{
  const pool=new Pool({connectionString:database}),f=await fixture(pool),app=server(pool,f),catalogue=randomUUID();
  try{
    const entry:WorkpaperEntry={id:'synthetic-workpaper',code:'1-1-1',title:'Synthetic issuer workpaper',folder:'Synthetic folder',instructions:'Synthetic fixture only',sheet:'Synthetic',row:1,kind:'file',path:'Synthetic folder/Synthetic workpaper.docx'};
    await pool.query("INSERT INTO bb_workpaper_catalogues(id,owner_user_id,project_id,request_id,request_hash,material,filename,entries,warnings,sha256) VALUES($1,$2,$3,$1,$4,$5,'Synthetic catalogue.xlsx',$6,'[]',$4)",[catalogue,f.owner,f.project,sha,f.source.pin,JSON.stringify([entry])]);
    const workspace=await app.inject({method:'GET',url:`/api/v1/projects/${f.project}/workpapers`,headers:{origin}});
    assert.equal(workspace.statusCode,200,workspace.body);assert.equal(workspace.json().price.version,AUTOMATIC_PRICE_VERSION);assert.equal(workspace.json().price.auto_charge,true);
    const points=AUTOMATIC_TASK_TARIFF.workpaper.points;await fund(pool,f.owner,points-1);const before=await counts(pool,f.owner);
    const response=await app.inject({method:'POST',url:`/api/v1/projects/${f.project}/workpapers/batches`,headers:{origin},payload:{request_id:randomUUID(),catalogue_id:catalogue,catalogue_sha256:sha,item_ids:[entry.id],source_version_id:f.sourceVersion,source_selection_revision:1,requirements:'Synthetic fixture only',start_mode:'direct',price_version:AUTOMATIC_PRICE_VERSION,expected_points:points}});
    assert.equal(response.statusCode,402,response.body);assert.equal(response.json().code,'CREDITS_INSUFFICIENT');
    assert.deepEqual(await counts(pool,f.owner),before);assert.deepEqual(await creditBalance(pool,f.owner),{available:points-1,frozen:0});
  }finally{await app.close();await pool.end();}
});

test('asynchronous workpaper shortage resumes only the original batch once and never overrides a later manual pause',{skip:!database,timeout:120000},async()=>{
  const pool=new Pool({connectionString:database}),f=await fixture(pool),app=server(pool,f),catalogue=randomUUID(),batch=randomUUID();
  const base=`/api/v1/projects/${f.project}/workpapers`,send=(method:'GET'|'POST',path:string,payload?:any)=>app.inject({method,url:base+path,headers:{origin},payload});
  try{
    // A synthetic already-admitted batch with no remaining wallet balance models
    // competing spend between child admissions. No model or Word result is fabricated.
    const topicResponse=await app.inject({method:'POST',url:'/api/v1/m4/topics',headers:{origin},payload:{creation_request_id:randomUUID(),name:'Synthetic workpaper recovery',source_project_id:f.project}});
    assert.ok(topicResponse.statusCode<300,topicResponse.body);const topic=topicResponse.json().topic;
    const entry:WorkpaperEntry={id:'recovery-item',code:'1.1',title:'Synthetic recovery item',folder:'Synthetic',instructions:'Synthetic only',sheet:'Synthetic',row:1,kind:'file',path:'Synthetic recovery.docx'};
    const source={project_id:f.project,version_id:f.sourceVersion,selection_revision:1,sequence:1,filename:'Synthetic source.docx',asset:f.source};
    await pool.query("INSERT INTO bb_workpaper_catalogues(id,owner_user_id,project_id,request_id,request_hash,material,filename,entries,warnings,sha256) VALUES($1,$2,$3,$1,$4,$5,'Synthetic.xlsx',$6,'[]',$4)",[catalogue,f.owner,f.project,sha,f.source.pin,JSON.stringify([entry])]);
    const points=AUTOMATIC_TASK_TARIFF.workpaper.points;
    await pool.query("INSERT INTO bb_workpaper_batches(id,owner_user_id,project_id,topic_id,catalogue_id,request_id,request_hash,source,state,total_points,price_version,start_mode) VALUES($1,$2,$3,$4,$5,$1,$6,$7,'queued',$8,$9,'direct')",[batch,f.owner,f.project,topic.topic_id,catalogue,sha,source,points,AUTOMATIC_PRICE_VERSION]);
    const manifest={version:'m4-document-input-v1',kind:'document',topic_id:topic.topic_id,execution_scope_project_id:f.project,project_name:'Synthetic batch',draft_version:1,market:'sse',offering:'private',billing_task:'m4_workpaper',template_material:null,input:{document_type:'workpaper',workpaper:{batch_id:batch,catalogue_id:catalogue,entry,mode:'direct'},source_material:f.source.pin,materials:[],template:null,edit_base:null,scope:'whole',fields:{},requirements:[],supplemental_requirements:''}};
    await pool.query('INSERT INTO bb_workpaper_items(owner_user_id,batch_id,item_id,ordinal,manifest) VALUES($1,$2,$3,1,$4)',[f.owner,batch,entry.id,manifest]);
    const before=await counts(pool,f.owner);
    assert.equal(await advanceWorkpaperBatch(pool),true);
    const paused=(await send('GET','/batches/'+batch)).json();
    assert.equal(paused.state,'paused');assert.deepEqual(paused.billing_resume,{price_version:AUTOMATIC_PRICE_VERSION,required_points:points,available_points:0,shortage:points});
    assert.deepEqual(await counts(pool,f.owner),before,'failed child admission creates neither run nor reservation');
    const request={action:'resume',billing_resume:true,request_id:randomUUID(),expected_revision:paused.revision,price_version:AUTOMATIC_PRICE_VERSION,expected_points:points};
    const shortage=await send('POST','/batches/'+batch+'/actions',request);assert.equal(shortage.statusCode,402,shortage.body);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_workpaper_billing_resumes WHERE owner_user_id=$1',[f.owner])).rows[0].n,0);
    await fund(pool,f.owner,points);
    const results=await Promise.all([send('POST','/batches/'+batch+'/actions',request),send('POST','/batches/'+batch+'/actions',request)]);
    for(const response of results){assert.equal(response.statusCode,200,response.body);assert.equal(response.json().state,'queued');}
    const resumed=results[0].json();assert.equal(resumed.revision,paused.revision+1);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_workpaper_billing_resumes WHERE owner_user_id=$1',[f.owner])).rows[0].n,1);
    const changed=await send('POST','/batches/'+batch+'/actions',{...request,expected_points:points+1});assert.equal(changed.statusCode,409);assert.equal(changed.json().code,'IDEMPOTENCY_CONFLICT');
    const manuallyPaused=await send('POST','/batches/'+batch+'/actions',{action:'pause',expected_revision:resumed.revision});assert.equal(manuallyPaused.statusCode,200,manuallyPaused.body);assert.equal(manuallyPaused.json().billing_resume,undefined);
    const replay=await send('POST','/batches/'+batch+'/actions',request);assert.equal(replay.statusCode,200);assert.equal(replay.json().state,'paused','old payment return cannot undo a later manual pause');
    const forged=await send('POST','/batches/'+batch+'/actions',{...request,request_id:randomUUID(),expected_revision:manuallyPaused.json().revision});assert.equal(forged.statusCode,409);
    const continued=await send('POST','/batches/'+batch+'/actions',{action:'resume',expected_revision:manuallyPaused.json().revision});assert.equal(continued.statusCode,200,continued.body);
    assert.equal(await advanceWorkpaperBatch(pool),true);assert.equal(await advanceWorkpaperBatch(pool),false);
    const after=await counts(pool,f.owner);assert.equal(after.runs,before.runs+1);assert.equal(after.reservations,before.reservations+1);
    assert.deepEqual(await creditBalance(pool,f.owner),{available:0,frozen:points});
  }finally{await app.close();await pool.end();}
});

test('retired source-diff route remains replayable while automatic workpaper checks use independent paid files',{skip:!database,timeout:120000},async()=>{
  const pool=new Pool({connectionString:database}),f=await fixture(pool),app=server(pool,f),batch=randomUUID();
  const base=`/api/v1/projects/${f.project}/workpapers`,body={request_id:randomUUID(),source_version_id:f.sourceVersion,source_selection_revision:1};
  const send=(payload:{request_id:string;source_version_id:string;source_selection_revision:number})=>app.inject({method:'POST',url:base+'/batches/'+batch+'/checks',headers:{origin},payload});
  try{
    await fund(pool,f.owner,50000);const before=await counts(pool,f.owner);
    const library=await app.inject({method:'GET',url:base+'/library',headers:{origin}});assert.equal(library.statusCode,200,library.body);assert.equal(library.json().check_capability.enabled,true);assert.equal(library.json().check_capability.mode,'per_file');
    for(const input of [body,{...body,request_id:randomUUID(),source_version_id:'new-unconnected-source'}]){
      const response=await send(input);assert.equal(response.statusCode,409,response.body);assert.equal(response.json().code,'BILLING_NOT_READY');
    }
    assert.deepEqual(await counts(pool,f.owner),before);assert.deepEqual(await creditBalance(pool,f.owner),{available:50000,frozen:0});
    // An immutable pre-existing failed task is a replay fixture, not a successful
    // result or a new free admission under automatic billing.
    const old=randomUUID(),requestHash=inputManifestHash({id:f.project,batch,...body});
    await pool.query("INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,1,$2,1,$3,'{}','[]','[]')",[f.project,f.owner,sha]);
    await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,1,$4,$5,'generation',$6,'failed')",[old,f.owner,f.project,sha,'workpaper-change:'+body.request_id,requestHash]);
    const replay=await send(body);assert.equal(replay.statusCode,200,replay.body);assert.deepEqual(replay.json(),{run_id:old});
    const changed=await send({...body,source_version_id:'another-source'});assert.equal(changed.statusCode,409);assert.equal(changed.json().code,'IDEMPOTENCY_CONFLICT');
    const after=await counts(pool,f.owner);assert.equal(after.runs,before.runs+1);assert.equal(after.reservations,before.reservations);
  }finally{await app.close();await pool.end();}
});
