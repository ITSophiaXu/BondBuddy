import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {OUTCOME_PRICE_VERSION,OUTCOME_PRICING_MODE,INITIAL_FIXED_PRICES,emptyUpdateDetails,type M4DocumentManifest,type ProjectFileOperation,type QaInput} from '@bondbuddy/contracts';
import {activePrice,creditBalance,grantCredits,publishPrices,quoteCredits,reserveCredits} from './billing.js';
import {debitAuthoringCredits} from './authoring-credit-debit.js';
import {quoteM4,reserveM4,settleM4Metering} from './m4-billing.js';
import {fileCheckPrice,fileUpdatePrice,reserveFileCheck,reserveFileUpdate} from './project-file-billing.js';
import {qaAnswerScope,reserveQaCredits,validateIncludedQaFollowup} from './project-qa.js';
import {publishScopeQuote,requestScope} from './scope-quotations.js';
import {correctSettlement,auditCredits} from './billing-ops.js';
import {checkpointStage,claim,enqueue,finish,promoteWordArtifact} from './queue.js';
import {transaction,type PrivateBlobs} from './data.js';
import {inputManifestHash} from './production-rule-pin.js';
import {makeSyntheticDocxFixture} from './docx-fixtures.js';
import {isolatedTestDatabase} from './test-database.js';
import {createServer} from './server.js';
import {syntheticReviewPair} from './review-delivery-test-fixture.js';
import {emptyM4Draft,registerM4Artifacts} from './m4-workspace.js';
import {advanceProjectFileBatch} from './project-file-workspace.js';

const database=await isolatedTestDatabase(undefined,'outcome-billing');
const h='a'.repeat(64);
const authoring=()=>({draft_revision:1,issuer_name:'Synthetic issuer',market:'sse',offering:'private',materials:[],
 update_details:{...emptyUpdateDetails(),reporting_cutoff:'2026-09-30'},
 authoring:{version:'unified_v1',source_prospectuses:[],requirements:[],knowledge:[],knowledge_status:'authoring_reference_not_compliance_approval'}});
const source=(project:string):Extract<ProjectFileOperation,{operation:'check'}>['source']=>({project_id:project,version_id:'synthetic-source-v1',selection_revision:1,filename:'source.docx',sequence:1,
 asset:{kind:'material',pin:{source_project_id:project,material_id:'synthetic-source',material_version:1,sha256:h}}});

function memoryBlobs():PrivateBlobs{
 const bytes=new Map<string,Buffer>();return {put:async(k,b)=>{bytes.set(k,Buffer.from(b));},get:async k=>{const b=bytes.get(k);assert.ok(b);return b;},
 getIfExists:async k=>bytes.get(k)??null,getIfExistsBounded:async(k,n)=>{const b=bytes.get(k);if(b&&b.length>n)throw Error('bounded');return b??null;},exists:async k=>bytes.has(k),delete:async k=>{bytes.delete(k);}};
}
async function setup(pool:Pool){const owner=randomUUID();await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'synthetic_outcome_'+owner.slice(0,8)]);return owner;}
async function fund(pool:Pool,owner:string,points:number){await transaction(pool,c=>grantCredits(c,{owner,points,key:randomUUID(),source:'purchase',expiresAt:null,actor:'synthetic-test',reason:'synthetic-only'}));}
async function approve(pool:Pool,id:string,inputHash:string,amount:number){return publishScopeQuote(pool,{id,expected_input_hash:inputHash,lines:[{key:'synthetic-confirmed-scope',label:'Synthetic reviewed financial period and affected sections',quantity:1,unit:'confirmed scope',unit_price_fen:amount,amount_fen:amount,evidence:['immutable input:'+inputHash]}],actor:'synthetic-scope-reviewer',reason:'Synthetic explicit review of actual pinned work scope'});}
async function seed(pool:Pool,owner:string,manifest:any,projectId?:string,task='generation'){
 const project=projectId??randomUUID(),id=randomUUID(),hash=inputManifestHash(manifest);
 if(!projectId)await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic outcome project',$3)",[project,owner,task==='update'?'update':'generation']);
 const revision=Number((await pool.query('SELECT coalesce(max(revision),0)+1 n FROM bb_input_revisions WHERE project_id=$1',[project])).rows[0].n);
 await pool.query("INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,$2,$3,1,$4,$5,'[]','[]')",[project,revision,owner,hash,manifest]);
 await pool.query('UPDATE bb_projects SET latest_input_revision=$2 WHERE id=$1',[project,revision]);
 const run=(await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,$4,$5,$1,$6,$5,'queued') RETURNING *",[id,owner,project,revision,hash,task])).rows[0];
 return {project,run,input:{revision,manifest,input_hash:hash},hash};
}
async function reserveAuthoring(pool:Pool,owner:string,s:Awaited<ReturnType<typeof seed>>,quote:string){
 return transaction(pool,async c=>{const p=(await c.query('SELECT * FROM bb_projects WHERE id=$1',[s.project])).rows[0];await reserveCredits(c,owner,s.run,quote,s.input,p,undefined,false);});
}

test('outcome quote pins full delivery price, ignores progress debit, releases failures, settles delivered pair once and supports idempotent correction', {skip:!database,timeout:120000},async()=>{
 const pool=new Pool({connectionString:database}),blobs=memoryBlobs();
 try{
  const owner=await setup(pool),s=await seed(pool,owner,authoring(),undefined,'update');
  await publishPrices(pool,{id:'synthetic-legacy-outcome-test',prices:INITIAL_FIXED_PRICES,effectiveAt:'2026-01-01T00:00:00Z',actor:'synthetic-test',reason:'synthetic-only'});
  assert.equal((await transaction(pool,c=>activePrice(c))).pricing_mode,'legacy_credit');
  const pending=await quoteCredits(pool,owner,s.project,s.input.revision,s.hash,true);assert.equal(pending.quote.quote_status,'pending_scope');assert.equal(pending.quote.points,0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_credit_quotes WHERE project_id=$1',[s.project])).rows[0].n,0);
  await assert.rejects(reserveAuthoring(pool,owner,s,pending.quote.quote_id),e=>(e as {code:string}).code==='QUOTE_CHANGED');
  await approve(pool,pending.quote.scope_quote_id!,s.hash,42731);
  const quoted=await quoteCredits(pool,owner,s.project,s.input.revision,s.hash,true),q=quoted.quote,P=q.points;
  assert.equal(P,42731);assert.equal(q.currency,'CNY');assert.equal(q.amount_fen,P);assert.equal(q.pricing_mode,OUTCOME_PRICING_MODE);assert.equal(q.quote_status,'ready');
  const different=await seed(pool,owner,{...authoring(),update_details:{...authoring().update_details,reporting_cutoff:'2028-12-31'}},undefined,'update');
  const dp=await quoteCredits(pool,owner,different.project,different.input.revision,different.hash,true);await approve(pool,dp.quote.scope_quote_id!,different.hash,83815);
  const differentQuote=(await quoteCredits(pool,owner,different.project,different.input.revision,different.hash,true)).quote;
  assert.equal(differentQuote.points,83815);assert.notEqual(differentQuote.points,P,'the same authoring task can have a different approved actual scope');
  await fund(pool,owner,P-1);
  await assert.rejects(reserveAuthoring(pool,owner,s,q.quote_id),e=>(e as {code:string}).code==='CREDITS_INSUFFICIENT');
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_credit_reservations WHERE run_id=$1',[s.run.id])).rows[0].n,0);
  await fund(pool,owner,1);await reserveAuthoring(pool,owner,s,q.quote_id);
  assert.deepEqual(await creditBalance(pool,owner),{available:0,frozen:P});
  const held=(await pool.query('SELECT * FROM bb_credit_reservations WHERE run_id=$1',[s.run.id])).rows[0];assert.equal(held.billing_policy,'on_delivery');
  assert.equal(await transaction(pool,c=>debitAuthoringCredits(c,s.run,Number.MAX_SAFE_INTEGER)),null);
  assert.deepEqual(await creditBalance(pool,owner),{available:0,frozen:P});
  await assert.rejects(pool.query('UPDATE bb_credit_quotes SET points=1 WHERE id=$1',[q.quote_id]),/append only/);
  await pool.query("UPDATE bb_runs SET state='failed' WHERE id=$1",[s.run.id]);await pool.query("UPDATE bb_runs SET state='failed' WHERE id=$1",[s.run.id]);
  assert.deepEqual(await creditBalance(pool,owner),{available:P,frozen:0});
  const delivery=await seed(pool,owner,authoring(),undefined,'update'),pendingDelivery=(await quoteCredits(pool,owner,delivery.project,delivery.input.revision,delivery.hash,true)).quote;
  await approve(pool,pendingDelivery.scope_quote_id!,delivery.hash,P);const dq=(await quoteCredits(pool,owner,delivery.project,delivery.input.revision,delivery.hash,true)).quote;
  await reserveAuthoring(pool,owner,delivery,dq.quote_id);
  await transaction(pool,c=>enqueue(c,delivery.run));const lease=await claim(pool);assert.ok(lease);assert.equal(lease.runId,delivery.run.id);
  const revised=await promoteWordArtifact(pool,lease,makeSyntheticDocxFixture({text:'Synthetic outcome revision'}),blobs,'generated_pair_v1');
  await assert.rejects(finish(pool,lease,'succeeded',{artifactId:revised.artifactId,artifactVersion:1,blobs}),/Both generated Word/);
  assert.deepEqual(await creditBalance(pool,owner),{available:0,frozen:P});
  const clean=await promoteWordArtifact(pool,lease,makeSyntheticDocxFixture({text:'Synthetic outcome clean'}),blobs,'generated_pair_v1');
  await checkpointStage(pool,lease,'word_delivery_pair',{revision_artifact_id:revised.artifactId,clean_artifact_id:clean.artifactId});
  await finish(pool,lease,'succeeded',{artifactId:revised.artifactId,artifactVersion:1,blobs});
  await pool.query("UPDATE bb_runs SET state='succeeded' WHERE id=$1",[delivery.run.id]);
  assert.deepEqual(await creditBalance(pool,owner),{available:0,frozen:0});
  const events=(await pool.query("SELECT points FROM bb_credit_events WHERE run_id=$1 AND kind='settle'",[delivery.run.id])).rows;assert.deepEqual(events.map(r=>Number(r.points)),[P]);
  const corrected=await correctSettlement(pool,{runId:delivery.run.id,actor:'synthetic-operator',reason:'verified platform correction'});
  assert.deepEqual(await correctSettlement(pool,{runId:delivery.run.id,actor:'synthetic-operator',reason:'verified platform correction'}),corrected);
  assert.deepEqual(await creditBalance(pool,owner),{available:P,frozen:0});
  assert.equal((await auditCredits(pool)).consistent,true);
 }finally{await pool.end();}
});

test('outcome M4 needs no metering rate, freezes complete pinned price and releases a cancelled task', {skip:!database,timeout:120000},async()=>{
 const pool=new Pool({connectionString:database});
 try{
  const owner=await setup(pool),s=await seed(pool,owner,{}),topic=randomUUID();
  await pool.query("INSERT INTO bb_m4_topics(id,owner_user_id,project_id,name,creation_request_id,request_hash) VALUES($1,$2,$3,'Synthetic outcome topic',$1,$4)",[topic,owner,s.project,h]);
  const pendingDoc=await transaction(pool,c=>quoteM4(c,owner,topic,'m4_G02',s.hash,{},true));assert.equal(pendingDoc.quote.quote_status,'pending_scope');
  const pendingQa=await transaction(pool,c=>quoteM4(c,owner,topic,'m4_Q01',s.hash,{},true));assert.equal(pendingQa.quote.quote_status,'pending_scope');
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_m4_quotes WHERE owner_user_id=$1',[owner])).rows[0].n,0);
  await approve(pool,pendingDoc.quote.scope_quote_id!,s.hash,13757);await approve(pool,pendingQa.quote.scope_quote_id!,s.hash,1831);
  const doc=await transaction(pool,c=>quoteM4(c,owner,topic,'m4_G02',s.hash,{},true));
  const qa=await transaction(pool,c=>quoteM4(c,owner,topic,'m4_Q01',s.hash,{},true));
  assert.equal(doc.quote.points,13757);assert.equal(qa.quote.points,1831);
  assert.equal(doc.quote.billing_policy,'on_delivery');assert.equal(doc.quote.currency,'CNY');assert.equal(doc.quote.price_version,OUTCOME_PRICE_VERSION);
  const P=doc.quote.points;await fund(pool,owner,P-1);
  await assert.rejects(transaction(pool,c=>reserveM4(c,owner,s.run,doc.quote.quote_id,topic,s.hash)),e=>(e as {code:string}).code==='CREDITS_INSUFFICIENT');
  await fund(pool,owner,1);await transaction(pool,c=>reserveM4(c,owner,s.run,doc.quote.quote_id,topic,s.hash));
  assert.deepEqual(await creditBalance(pool,owner),{available:0,frozen:P});
  assert.equal(await transaction(pool,c=>debitAuthoringCredits(c,s.run,P)),null);
  assert.deepEqual(await settleM4Metering(pool,owner,s.run.id),{ready:true,charged_points:P});
  await pool.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1",[s.run.id]);
  assert.deepEqual(await creditBalance(pool,owner),{available:P,frozen:0});
 }finally{await pool.end();}
});

test('durable file batch preserves a different approved amount per document and never charges a completed predecessor again', {skip:!database,timeout:120000},async()=>{
 const pool=new Pool({connectionString:database}),blobs=memoryBlobs();
 try{
  const owner=await setup(pool),s=await seed(pool,owner,{}),topic=randomUUID(),batch=randomUUID();
  await pool.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1",[s.run.id]);
  await pool.query("INSERT INTO bb_m4_topics(id,owner_user_id,project_id,name,creation_request_id,request_hash) VALUES($1,$2,$3,'Synthetic scoped batch',$1,$4)",[topic,owner,s.project,h]);
  const items=[];
  for(const [type,amount] of [['init',2381],['underwriter',8291]] as const){
   const manifest:M4DocumentManifest={version:'m4-document-input-v1',kind:'document',topic_id:topic,execution_scope_project_id:s.project,draft_version:1,market:'sse',offering:'private',billing_task:type==='init'?'m4_G01':'m4_G03',template_material:null,
    input:{...emptyM4Draft(type),source_material:{source_project_id:s.project,material_id:'synthetic-source',material_version:1,sha256:h},fields:{market:'sse',offering:'private',issuer_name:'Synthetic issuer'}}};
   const hash=inputManifestHash(manifest),scope=await transaction(pool,c=>requestScope(c,owner,s.project,'m4_document',hash,manifest));
   const approved=await approve(pool,scope.scope_quote_id,hash,amount);
   items.push({manifest,run_id:null,attempt:1,error:null,pricing_mode:OUTCOME_PRICING_MODE,scope_quote_id:scope.scope_quote_id,points:amount,scope_lines:approved.scope_lines});
  }
  await pool.query("INSERT INTO bb_project_file_batches(id,owner_user_id,project_id,topic_id,request_id,request_hash,items,state) VALUES($1,$2,$3,$4,$1,$5,$6,'queued')",[batch,owner,s.project,topic,h,JSON.stringify(items)]);
  await fund(pool,owner,20000);
  assert.equal(await advanceProjectFileBatch(pool),true);
  const first=(await pool.query('SELECT items FROM bb_project_file_batches WHERE id=$1',[batch])).rows[0].items[0].run_id;
  assert.deepEqual(await creditBalance(pool,owner),{available:20000-2381,frozen:2381});
  const lease=await claim(pool);assert.ok(lease);assert.equal(lease.runId,first);
  const docBytes=makeSyntheticDocxFixture({text:'Synthetic scoped batch document'}),noteBytes=makeSyntheticDocxFixture({text:'Synthetic scoped batch preparation note'});
  const doc=await promoteWordArtifact(pool,lease,docBytes,blobs,'generated_pair_v1'),note=await promoteWordArtifact(pool,lease,noteBytes,blobs,'generated_pair_v1');
  await transaction(pool,c=>registerM4Artifacts(c,owner,first,[{kind:'document',artifact_id:doc.artifactId,artifact_version:1,filename:'document.docx',byte_size:docBytes.length}]));
  await assert.rejects(finish(pool,lease,'succeeded',{artifactId:doc.artifactId,artifactVersion:1,blobs}),/preparation note/);
  await transaction(pool,c=>registerM4Artifacts(c,owner,first,[{kind:'preparation_note',artifact_id:note.artifactId,artifact_version:1,filename:'note.docx',byte_size:noteBytes.length}]));
  await finish(pool,lease,'succeeded',{artifactId:doc.artifactId,artifactVersion:1,blobs});
  assert.deepEqual(await creditBalance(pool,owner),{available:20000-2381,frozen:0});
  await correctSettlement(pool,{runId:first,actor:'synthetic-operator',reason:'verified original-scope platform correction'});await correctSettlement(pool,{runId:first,actor:'synthetic-operator',reason:'verified original-scope platform correction'});
  assert.deepEqual(await creditBalance(pool,owner),{available:20000,frozen:0});
  assert.equal(await advanceProjectFileBatch(pool),true);
  const stored=(await pool.query('SELECT items FROM bb_project_file_batches WHERE id=$1',[batch])).rows[0].items,second=stored[1].run_id;
  assert.notEqual(first,second);assert.equal(stored[0].run_id,first);assert.deepEqual(stored.map((i:any)=>i.points),[2381,8291]);
  assert.deepEqual(await creditBalance(pool,owner),{available:20000-8291,frozen:8291});
  await pool.query("UPDATE bb_runs SET state='failed' WHERE id=$1",[second]);assert.equal(await advanceProjectFileBatch(pool),true);
  assert.deepEqual(await creditBalance(pool,owner),{available:20000,frozen:0});
  assert.equal((await pool.query("SELECT count(*)::int n FROM bb_credit_events WHERE run_id=$1 AND kind='settle'",[first])).rows[0].n,1);
 }finally{await pool.end();}
});

test('paid file checks settle only complete report and new update scope includes settled same-version evidence', {skip:!database,timeout:120000},async()=>{
 const pool=new Pool({connectionString:database}),blobs=memoryBlobs();
 try{
  const owner=await setup(pool),initial=await seed(pool,owner,{}),file=randomUUID(),version=randomUUID();
  await pool.query("INSERT INTO bb_project_files(id,owner_user_id,project_id,document_type) VALUES($1,$2,$3,'init')",[file,owner,initial.project]);
  const asset={kind:'material' as const,pin:{source_project_id:initial.project,material_id:'synthetic-target',material_version:1,sha256:h}};
  await pool.query("INSERT INTO bb_project_file_versions(id,owner_user_id,file_id,sequence,filename,asset) VALUES($1,$2,$3,1,'target.docx',$4)",[version,owner,file,asset]);
  const input:Extract<ProjectFileOperation,{operation:'check'}>={version:'project-file-operation-v1',operation:'check',source:source(initial.project),files:[{file_id:file,file_version_id:version,filename:'target.docx',sequence:1,asset,links:[]}]};
  const s=await seed(pool,owner,input,initial.project);
  await pool.query("INSERT INTO bb_project_file_operations(run_id,owner_user_id,project_id,operation,manifest,input_hash) VALUES($1,$2,$3,'check',$4,$5)",[s.run.id,owner,s.project,input,s.hash]);
  const pendingPrice=await transaction(pool,c=>fileCheckPrice(c,owner,input));assert.equal(pendingPrice.quote_status,'pending_scope');
  await approve(pool,pendingPrice.scope_quote_id!,pendingPrice.scope_hash,1739);const price=await transaction(pool,c=>fileCheckPrice(c,owner,input));
  await fund(pool,owner,10000);await transaction(pool,c=>reserveFileCheck(c,owner,s.run,input,price.points,price.scope_quote_id));
  await transaction(pool,c=>enqueue(c,s.run,'project_file_v1'));const lease=await claim(pool);assert.ok(lease);assert.equal(lease.runId,s.run.id);
  const report=await promoteWordArtifact(pool,lease,makeSyntheticDocxFixture({text:'Synthetic file consistency report'}),blobs,'generated_review_v1');
  await assert.rejects(finish(pool,lease,'succeeded',{artifactId:report.artifactId,artifactVersion:1,blobs}),/Delivered immutable consistency report/);
  const result={version:'project-file-check-v1',files:[{file_version_id:version,status:'conflict',coverage:'Synthetic coverage',findings:[],links:[]}]};
  await pool.query('UPDATE bb_project_file_operations SET result=$2,result_hash=$3 WHERE run_id=$1',[s.run.id,result,inputManifestHash(result)]);
  await finish(pool,lease,'succeeded',{artifactId:report.artifactId,artifactVersion:1,blobs});await pool.query("UPDATE bb_runs SET state='succeeded' WHERE id=$1",[s.run.id]);
  assert.deepEqual(await creditBalance(pool,owner),{available:10000-price.points,frozen:0});
  const reused=await transaction(pool,c=>fileCheckPrice(c,owner,{...input,source:{...input.source,selection_revision:2}}));assert.equal(reused.points,0);
  const changed=await transaction(pool,c=>fileCheckPrice(c,owner,{...input,source:{...input.source,version_id:'source-v2'}}));assert.equal(changed.quote_status,'pending_scope');assert.equal(changed.charged_file_versions.length,1);
  const patch:Extract<ProjectFileOperation,{operation:'patch'}>={version:'project-file-operation-v1',operation:'patch',source:input.source,check_run_id:s.run.id,check_sha256:inputManifestHash(result),file_id:file,file_version_id:version,expected_current_version_id:version,filename:'target.docx',asset,findings:[]};
  const pendingUpgrade=await transaction(pool,c=>fileUpdatePrice(c,owner,patch,true));assert.ok('scope_hash' in pendingUpgrade);assert.equal(pendingUpgrade.quote_status,'pending_scope');
  await approve(pool,pendingUpgrade.scope_quote_id!,pendingUpgrade.scope_hash,1273);const upgrade=await transaction(pool,c=>fileUpdatePrice(c,owner,patch,true));assert.ok('scope_hash' in upgrade);
  const p=await seed(pool,owner,patch,s.project);await pool.query("INSERT INTO bb_project_file_operations(run_id,owner_user_id,project_id,operation,manifest,input_hash) VALUES($1,$2,$3,'patch',$4,$5)",[p.run.id,owner,p.project,patch,p.hash]);
  await transaction(pool,c=>reserveFileUpdate(c,owner,p.run,patch,true,upgrade.points,upgrade.scope_quote_id));
  assert.deepEqual(await creditBalance(pool,owner),{available:10000-price.points-upgrade.points,frozen:upgrade.points});
  await pool.query("UPDATE bb_runs SET state='failed' WHERE id=$1",[p.run.id]);
  assert.deepEqual(await creditBalance(pool,owner),{available:10000-price.points,frozen:0});
  const other=await seed(pool,owner,{...patch,source:{...input.source,version_id:'source-v2'}},s.project);
  await pool.query("INSERT INTO bb_project_file_operations(run_id,owner_user_id,project_id,operation,manifest,input_hash) VALUES($1,$2,$3,'check',$4,$5)",[other.run.id,owner,other.project,{...input,source:{...input.source,version_id:'source-v2'}},other.hash]);
  const forged=await seed(pool,owner,{...patch,check_run_id:other.run.id},s.project);
  await pool.query("INSERT INTO bb_project_file_operations(run_id,owner_user_id,project_id,operation,manifest,input_hash) VALUES($1,$2,$3,'patch',$4,$5)",[forged.run.id,owner,forged.project,{...patch,check_run_id:other.run.id},forged.hash]);
  await assert.rejects(pool.query('INSERT INTO bb_project_file_update_quotes(id,owner_user_id,project_id,run_id,check_run_id,file_version_id,input_hash,points,price_version,scope_quote_id,scope_lines,scope_work_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[randomUUID(),owner,s.project,forged.run.id,other.run.id,version,forged.hash,upgrade.points,OUTCOME_PRICE_VERSION,upgrade.scope_quote_id,JSON.stringify(upgrade.scope_lines),forged.hash]),/scope/i);
 }finally{await pool.end();}
});

test('review API exposes pending scope without a charge and executes only the approved input-bound amount', {skip:!database,timeout:120000},async()=>{
 const pool=new Pool({connectionString:database}),blobs=memoryBlobs(),owner=await setup(pool);
 const app=createServer({pool,blobs,enableOutcomePricing:true,principal:async()=>({userId:owner,csrfVerified:true}),allowedOrigin:'http://bondbuddy.test'});
 const send=(method:string,url:string,payload?:any)=>app.inject({method:method as any,url,payload,headers:{origin:'http://bondbuddy.test'}});
 const ok=(r:any)=>{assert.ok(r.statusCode>=200&&r.statusCode<300,r.body);return r.json();};
 try{
  const p=ok(await send('POST','/api/v1/projects',{kind:'review',name:'Synthetic scope-priced review',issuer_name:null,market:null,offering:null})),base=`/api/v1/projects/${p.project_id}`;
  const upload=randomUUID(),material=randomUUID();
  await pool.query("INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state) VALUES($1,$2,$3,'synthetic.pdf','application/pdf',16,$4,'historical',$5,now()+interval '1 hour','completed')",[upload,owner,p.project_id,h,'synthetic/'+upload]);
  await pool.query("INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state) VALUES($1,1,$2,$3,$4,'historical','synthetic.pdf','application/pdf',16,$5,$6,'persisted')",[material,owner,p.project_id,upload,h,'synthetic/'+material]);
  const pin={material_id:material,material_version:1,sha256:h};
  ok(await send('PUT',base+'/review-draft',{kind:'input',expected_version:0,input:{source_material_ref:pin,material_versions:[pin],requirements:[],as_of:null}}));
  const request={execution_request_id:randomUUID(),operation:'full_review',expected_input_version:1,source_report_id:null,expected_plan_version:null,finding_ids:[]};
  const pending=ok(await send('POST',base+'/review-executions/quote',request));assert.equal(pending.quote.quote_status,'pending_scope');assert.equal(pending.quote.points,0);
  const pendingAttempt=await send('POST',base+'/review-executions',{...request,quote_id:pending.quote.quote_id});assert.equal(pendingAttempt.statusCode,409,pendingAttempt.body);
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE project_id=$1',[p.project_id])).rows[0].n,0);
  await approve(pool,pending.quote.scope_quote_id,pending.quote.input_hash,64213);
  const quoted=ok(await send('POST',base+'/review-executions/quote',request));assert.equal(quoted.quote.points,64213);assert.equal(quoted.quote.quote_status,'ready');
  await fund(pool,owner,64212);assert.equal((await send('POST',base+'/review-executions',{...request,quote_id:quoted.quote.quote_id})).statusCode,402);
  await fund(pool,owner,1);const run=ok(await send('POST',base+'/review-executions',{...request,quote_id:quoted.quote.quote_id}));
  assert.deepEqual(await creditBalance(pool,owner),{available:0,frozen:64213});
  const lease=await claim(pool);assert.ok(lease);assert.equal(lease.runId,run.run_id);
  const artifact=await syntheticReviewPair(pool,lease,blobs);await finish(pool,lease,'succeeded',{artifactId:artifact.artifactId,artifactVersion:1,blobs});
  assert.deepEqual(await creditBalance(pool,owner),{available:0,frozen:0});
  assert.equal(Number((await pool.query('SELECT charged_points FROM bb_credit_reservations WHERE run_id=$1',[run.run_id])).rows[0].charged_points),64213);
 }finally{await app.close();await pool.end();}
});

test('QA original-scope evidence followup requires owned settled original and cannot introduce new questions or changed requirements', {skip:!database,timeout:120000},async()=>{
 const pool=new Pool({connectionString:database}),blobs=memoryBlobs();
 try{
  const owner=await setup(pool),questions=[{id:'q0',start:0,end:0,question:'Synthetic reviewer question'}];
  const p=await seed(pool,owner,{}),input:QaInput={version:'project-qa-v1',operation:'answer',project_name:'Synthetic QA',source:{filename:'questions.docx',asset:source(p.project).asset},preparation_id:null,questions,materials:[],requirements:'Use evidenced facts',cases:[],price_version:OUTCOME_PRICE_VERSION,points:0};
  const scopeHash=inputManifestHash(qaAnswerScope(input)),scope=await transaction(pool,c=>requestScope(c,owner,p.project,'project_qa_answer',scopeHash,qaAnswerScope(input)));
  await approve(pool,scope.scope_quote_id,scopeHash,2671);input.points=2671;input.scope_quote_id=scope.scope_quote_id;
  const s=await seed(pool,owner,input,p.project);
  await pool.query("INSERT INTO bb_project_qa_runs(run_id,owner_user_id,project_id,sequence,operation,manifest,input_hash) VALUES($1,$2,$3,1,'answer',$4,$5)",[s.run.id,owner,s.project,input,s.hash]);
  await fund(pool,owner,input.points);await transaction(pool,c=>reserveQaCredits(c,owner,s.run,input));
  await assert.rejects(validateIncludedQaFollowup(pool,owner,s.project,s.run.id,questions,input.requirements,input.source),e=>(e as {code:string}).code==='INPUT_REVISION_CONFLICT');
  await transaction(pool,c=>enqueue(c,s.run,'project_qa_v1'));const lease=await claim(pool);assert.ok(lease);assert.equal(lease.runId,s.run.id);
  const doc=await promoteWordArtifact(pool,lease,makeSyntheticDocxFixture({text:'Synthetic QA reply'}),blobs,'generated_pair_v1');
  const sha=(await pool.query('SELECT sha256 FROM bb_artifact_versions WHERE id=$1',[doc.artifactId])).rows[0].sha256.trim();
  const result={version:'project-qa-result-v1',answers:[{question_id:'q0'}],document:{sha256:sha}};
  await pool.query('UPDATE bb_project_qa_runs SET result=$2,result_hash=$3 WHERE run_id=$1',[s.run.id,result,inputManifestHash(result)]);
  await finish(pool,lease,'succeeded',{artifactId:doc.artifactId,artifactVersion:1,blobs});
  assert.deepEqual(await creditBalance(pool,owner),{available:0,frozen:0});
  await validateIncludedQaFollowup(pool,owner,s.project,s.run.id,questions,input.requirements,input.source);
  for(const [qs,requirements,actor,projectId] of [[[{...questions[0],question:'New question'}],input.requirements,owner,s.project],[questions,'Changed requirements',owner,s.project],[questions,input.requirements,await setup(pool),s.project],[questions,input.requirements,owner,randomUUID()]] as const){
   await assert.rejects(validateIncludedQaFollowup(pool,actor,projectId,s.run.id,[...qs],requirements,input.source),e=>(e as {code:string}).code==='INPUT_REVISION_CONFLICT');
  }
  const followup:QaInput={...input,points:0,included_followup_of:s.run.id,materials:[{filename:'Added original-scope evidence.docx',asset:{kind:'material',pin:{source_project_id:s.project,material_id:'synthetic-evidence',material_version:1,sha256:'b'.repeat(64)}}}]};
  const child=await seed(pool,owner,followup,s.project);
  await pool.query("INSERT INTO bb_project_qa_runs(run_id,owner_user_id,project_id,sequence,operation,manifest,input_hash) VALUES($1,$2,$3,2,'answer',$4,$5)",[child.run.id,owner,child.project,followup,child.hash]);
  await transaction(pool,c=>reserveQaCredits(c,owner,child.run,followup));
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_credit_reservations WHERE run_id=$1',[child.run.id])).rows[0].n,0);
  assert.deepEqual(await creditBalance(pool,owner),{available:0,frozen:0});
  const bad:QaInput={...followup,questions:[{...questions[0],question:'Unpurchased scope'}]},forged=await seed(pool,owner,bad,s.project);
  await pool.query("INSERT INTO bb_project_qa_runs(run_id,owner_user_id,project_id,sequence,operation,manifest,input_hash) VALUES($1,$2,$3,3,'answer',$4,$5)",[forged.run.id,owner,forged.project,bad,forged.hash]);
  await assert.rejects(transaction(pool,c=>reserveQaCredits(c,owner,forged.run,bad)),/Owned settled original-scope QA task/);
 }finally{await pool.end();}
});
