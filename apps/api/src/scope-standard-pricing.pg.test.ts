import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {OUTCOME_PRICE_VERSION,emptyUpdateDetails,type OutcomeWorkPlan,type OutcomePricingItem,type GoalOutcomePriceKey} from '@bondbuddy/contracts';
import {transaction,digest,type PrivateBlobs} from './data.js';
import {grantCredits,quoteCredits,reserveCredits} from './billing.js';
import {requestScope,publishScopeQuote,publishStandardScopeQuote,assertScopeQuote,workScopeHash} from './scope-quotations.js';
import {readOwnedCommerceCoverage} from './commerce-coverage.js';
import {checkpointStage,claim,enqueue,finish,promoteWordArtifact,recordPotentialCall,type Lease} from './queue.js';
import {saveSnapshotRef} from './observability.js';
import {persistProviderResultObject,recordProviderCallObservation,readCheckpointedProviderResult,type ProviderCallObservation} from './provider-results.js';
import {inputManifestHash} from './production-rule-pin.js';
import {makeSyntheticDocxFixture} from './docx-fixtures.js';
import {isolatedTestDatabase} from './test-database.js';

// Every input, operator classification, account and delivered Word below is synthetic.
// Prior coverage is earned through the real quote/reserve/delivery services, never injected as client credit.
const database=await isolatedTestDatabase(undefined,'scope-standard-pricing');
const evidence=['synthetic:运营已核对本发行人、业务目标、财务快照与约定成果'];
const goal=(price_key:GoalOutcomePriceKey,coverage_key='synthetic-goal'):OutcomeWorkPlan=>({scope_status:'confirmed',items:[{key:'target',coverage_key,evidence,family:'goal_upgrade',price_key}]});
const financial=(main_period_keys:string[],coverage_key='synthetic-financial-snapshot'):OutcomeWorkPlan=>({scope_status:'confirmed',items:[{key:'financial',coverage_key,evidence,family:'financial_group',main_period_keys,annual_main_periods:3,interim_main_periods:1,necessary_restatement:true}]});
const code=(expected:string)=>(error:unknown)=>(error as {code?:string}).code===expected;
function memoryBlobs():PrivateBlobs{
 const values=new Map<string,Buffer>();return {put:async(k,b)=>{values.set(k,Buffer.from(b));},get:async k=>{const b=values.get(k);assert.ok(b);return b;},getIfExists:async k=>values.get(k)??null,
  getIfExistsBounded:async(k,n)=>{const b=values.get(k);if(b&&b.length>n)throw Error('bounded');return b??null;},exists:async k=>values.has(k),delete:async k=>{values.delete(k);}};
}
async function setup(pool:Pool){
 const owner=randomUUID(),project=randomUUID();
 await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'synthetic_standard_'+owner.slice(0,8)]);
 await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic standard-priced project','update')",[project,owner]);
 await transaction(pool,c=>grantCredits(c,{owner,points:1000000,source:'purchase',key:randomUUID(),expiresAt:null,actor:'synthetic-test',reason:'Synthetic isolated fixture only'}));
 return {owner,project};
}
async function stage(pool:Pool,owner:string,project:string){
 const draftRevision=Number((await pool.query('SELECT draft_revision FROM bb_projects WHERE owner_user_id=$1 AND id=$2',[owner,project])).rows[0].draft_revision);
 const runId=randomUUID(),manifest={draft_revision:draftRevision,issuer_name:'Synthetic issuer',market:'sse',offering:'private',materials:[],
  update_details:{...emptyUpdateDetails(),reporting_cutoff:'2026-09-30',supplementary_notes:'Synthetic input revision '+runId},
  authoring:{version:'unified_v1',source_prospectuses:[],requirements:[],knowledge:[],knowledge_status:'authoring_reference_not_compliance_approval'}};
 const hash=inputManifestHash(manifest),revision=Number((await pool.query('SELECT coalesce(max(revision),0)+1 n FROM bb_input_revisions WHERE project_id=$1',[project])).rows[0].n);
 await pool.query("INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,$2,$3,$4,$5,$6,'[]','[]')",[project,revision,owner,draftRevision,hash,manifest]);
 await pool.query('UPDATE bb_projects SET latest_input_revision=$2 WHERE id=$1',[project,revision]);
 const run=(await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,$4,$5,$1,'update',$5,'queued') RETURNING *",[runId,owner,project,revision,hash])).rows[0];
 return {run,input:{revision,manifest,input_hash:hash},hash};
}
async function classified(pool:Pool,owner:string,project:string,work_plan:OutcomeWorkPlan){
 const staged=await stage(pool,owner,project),pending=await quoteCredits(pool,owner,project,staged.input.revision,staged.hash,true);
 assert.equal(pending.quote.quote_status,'pending_scope');assert.equal(pending.quote.points,0);
 const scope=await publishStandardScopeQuote(pool,{id:pending.quote.scope_quote_id!,expected_input_hash:staged.hash,work_plan,actor:'synthetic-business-reviewer',reason:'Synthetic explicit business-target classification'});
 const executable=await quoteCredits(pool,owner,project,staged.input.revision,staged.hash,true);
 assert.equal(executable.quote.quote_status,'ready');assert.equal(executable.quote.points,scope.amount_fen);
 return {...staged,scope,quote:executable.quote};
}
async function deliver(pool:Pool,blobs:PrivateBlobs,owner:string,project:string,work_plan:OutcomeWorkPlan){
 const sale=await classified(pool,owner,project,work_plan);
 await transaction(pool,async c=>{const p=(await c.query('SELECT * FROM bb_projects WHERE id=$1',[project])).rows[0];await reserveCredits(c,owner,sale.run,sale.quote.quote_id,sale.input,p,undefined,true);await enqueue(c,sale.run);});
 const lease=await claim(pool);assert.ok(lease);assert.equal(lease.runId,sale.run.id);
 const revised=await promoteWordArtifact(pool,lease,makeSyntheticDocxFixture({text:'Synthetic standard-priced revision'}),blobs,'generated_pair_v1');
 if(sale.scope.amount_fen===0)await assert.rejects(finish(pool,lease,'succeeded',{artifactId:revised.artifactId,artifactVersion:1,blobs}),code('DELIVERY_FAILED'));
 const clean=await promoteWordArtifact(pool,lease,makeSyntheticDocxFixture({text:'Synthetic standard-priced clean copy'}),blobs,'generated_pair_v1');
 await checkpointStage(pool,lease,'word_delivery_pair',{revision_artifact_id:revised.artifactId,clean_artifact_id:clean.artifactId});
 await finish(pool,lease,'succeeded',{artifactId:revised.artifactId,artifactVersion:1,blobs});
 return sale;
}

test('trusted requestScope calculates a standard plan immediately while an unknown zero placeholder cannot execute',{skip:!database,timeout:120000},async()=>{
 const pool=new Pool({connectionString:database});
 try{
  const {owner,project}=await setup(pool),snapshot={synthetic:'pinned but not classified'},hash=workScopeHash(snapshot);
  const pending=await transaction(pool,c=>requestScope(c,owner,project,'authoring',hash,snapshot));
  assert.equal(pending.quote_status,'pending_scope');assert.equal(pending.amount_fen,0);assert.deepEqual(pending.scope_lines,[]);
  await assert.rejects(transaction(pool,c=>assertScopeQuote(c,pending.scope_quote_id,owner,project,'authoring',hash,0)),code('QUOTE_CHANGED'));
  const ready=await transaction(pool,c=>requestScope(c,owner,project,'authoring',hash,snapshot,goal('check')));
  assert.equal(ready.scope_quote_id,pending.scope_quote_id);assert.equal(ready.quote_status,'ready');assert.equal(ready.amount_fen,990);assert.equal(ready.price_version,OUTCOME_PRICE_VERSION);
  assert.equal(ready.scope_lines[0].pricing?.due_fen,990);
  const stored=(await pool.query('SELECT work_plan,pricing_items FROM bb_scope_quotations WHERE id=$1',[ready.scope_quote_id])).rows[0];
  assert.deepEqual(stored.work_plan,goal('check'));assert.deepEqual(stored.pricing_items[0].owned_coverage_ids,[]);
  await assert.rejects(publishScopeQuote(pool,{id:ready.scope_quote_id,expected_input_hash:hash,actor:'synthetic-operator',reason:'Cannot replace standard arithmetic',lines:[{key:'override',label:'Synthetic override',quantity:1,unit:'项',unit_price_fen:1,amount_fen:1,evidence}]}),code('QUOTE_CHANGED'));
 }finally{await pool.end();}
});

test('operator classification supplies business scope only, pins exact input and cannot override server money or ownership',{skip:!database,timeout:120000},async()=>{
 const pool=new Pool({connectionString:database});
 try{
  const {owner,project}=await setup(pool),snapshot={synthetic:'operator-classification'},hash=workScopeHash(snapshot),pending=await transaction(pool,c=>requestScope(c,owner,project,'authoring',hash,snapshot));
  const request={id:pending.scope_quote_id,expected_input_hash:hash,work_plan:goal('fact_revision'),actor:'synthetic-business-reviewer',reason:'Synthetic one confirmed factual change and necessary reply'};
  await assert.rejects(publishStandardScopeQuote(pool,{...request,expected_input_hash:'b'.repeat(64)}),code('INPUT_REVISION_CONFLICT'));
  await assert.rejects(publishStandardScopeQuote(pool,{...request,work_plan:{...request.work_plan,owned_coverage:[{id:'forged',coverage_key:'synthetic-goal',price_key:'argument_revision'}]}}),code('VALIDATION_FAILED'));
  await assert.rejects(publishStandardScopeQuote(pool,{...request,work_plan:{...request.work_plan,amount_fen:1}}),code('VALIDATION_FAILED'));
  await assert.rejects(publishStandardScopeQuote(pool,{...request,work_plan:{scope_status:'unknown',items:[]}}),code('VALIDATION_FAILED'));
  const ready=await publishStandardScopeQuote(pool,request);assert.equal(ready.amount_fen,3900);
  assert.deepEqual(await publishStandardScopeQuote(pool,request),ready);
  await assert.rejects(publishStandardScopeQuote(pool,{...request,work_plan:goal('argument_revision')}),code('IDEMPOTENCY_CONFLICT'));
  assert.equal((await transaction(pool,c=>assertScopeQuote(c,ready.scope_quote_id,owner,project,'authoring',hash,3900))).quote_status,'ready');
 }finally{await pool.end();}
});

test('server owned-coverage pricing upgrades 9.8 to 39 to 99, invalidates a stale quote and executes original scope for zero',{skip:!database,timeout:120000},async()=>{
 const pool=new Pool({connectionString:database}),blobs=memoryBlobs();
 try{
  const {owner,project}=await setup(pool);
  const first=await deliver(pool,blobs,owner,project,goal('fact_reply'));assert.equal(first.scope.amount_fen,980);
  const stale=await classified(pool,owner,project,goal('argument_revision'));assert.equal(stale.scope.amount_fen,8920);
  const second=await deliver(pool,blobs,owner,project,goal('fact_revision'));assert.equal(second.scope.amount_fen,2920);
  await assert.rejects(transaction(pool,c=>assertScopeQuote(c,stale.scope.scope_quote_id,owner,project,'authoring',stale.hash,8920)),code('QUOTE_CHANGED'));
  const third=await deliver(pool,blobs,owner,project,goal('argument_revision'));assert.equal(third.scope.amount_fen,6000);
  const repeated=await deliver(pool,blobs,owner,project,goal('argument_revision'));assert.equal(repeated.scope.amount_fen,0);assert.equal(repeated.scope.quote_status,'ready');
  assert.equal(repeated.scope.scope_lines[0].pricing?.owned_coverage_fen,9900);
  assert.equal((await pool.query('SELECT reservation_id FROM bb_runs WHERE id=$1',[repeated.run.id])).rows[0].reservation_id,null);
  const receipts=await transaction(pool,c=>readOwnedCommerceCoverage(c,owner,['synthetic-goal'])),highest=receipts.find(r=>r.price_key==='argument_revision');assert.ok(highest);
  const included:OutcomePricingItem={key:'correction',coverage_key:'synthetic-goal',family:'included',owned_coverage_id:highest.id,reason:'Synthetic original-scope evidence correction',evidence};
  const correction=await classified(pool,owner,project,{scope_status:'confirmed',items:[included]});assert.equal(correction.scope.amount_fen,0);
  assert.equal((await transaction(pool,c=>assertScopeQuote(c,correction.scope.scope_quote_id,owner,project,'authoring',correction.hash,0))).quote_status,'ready');
  const independent=await classified(pool,owner,project,goal('new_disclosure','different-independent-target'));assert.equal(independent.scope.amount_fen,9900);
  const other=await setup(pool),foreign=await classified(pool,other.owner,other.project,goal('argument_revision'));assert.equal(foreign.scope.amount_fen,9900);
 }finally{await pool.end();}
});

test('financial server quotes retain the same 499 cap across input changes and include necessary restatement',{skip:!database,timeout:120000},async()=>{
 const pool=new Pool({connectionString:database}),blobs=memoryBlobs();
 try{
  const {owner,project}=await setup(pool),amounts:number[]=[];
  for(const period of ['2024','2025','2026','2026Q3'])amounts.push((await deliver(pool,blobs,owner,project,financial([period]))).scope.amount_fen);
  assert.deepEqual(amounts,[24900,24900,100,0]);assert.equal(amounts.reduce((sum,n)=>sum+n,0),49900);
  const repeated=await classified(pool,owner,project,financial(['2024','2025','2026','2026Q3']));assert.equal(repeated.scope.amount_fen,0);
  const newer=await classified(pool,owner,project,financial(['2026Q3'],'genuinely-new-financial-snapshot'));assert.equal(newer.scope.amount_fen,24900);
  const plusIndependent=financial(['2026'],'another-new-financial-target');
  plusIndependent.items.push({key:'fund-use',coverage_key:'independent-funds-use-disclosure',family:'independent_output',price_key:'new_disclosure',evidence});
  assert.equal((await classified(pool,owner,project,plusIndependent)).scope.amount_fen,34800);
  const full=financial([],'complete-new-financial-target');(full.items[0] as Extract<OutcomePricingItem,{family:'financial_group'}>).requires_complete_group_build=true;
  assert.equal((await classified(pool,owner,project,full)).scope.amount_fen,49900);
 }finally{await pool.end();}
});

test('bound zero outcomes reuse a durable result with pending usage while ordinary trials still require reconciliation',{skip:!database,timeout:120000},async()=>{
 const pool=new Pool({connectionString:database}),blobs=memoryBlobs(),valid=(value:unknown)=>typeof value==='object'&&value!==null&&(value as {ok?:unknown}).ok===true;
 async function pendingUsage(lease:Lease,project:string,inputHash:string,inputRevision:number){
  const prompt=Buffer.from('Synthetic covered-zero prompt'),objectKey=`users/${lease.owner}/projects/${project}/snapshots/${randomUUID()}`;
  await blobs.put(objectKey,prompt,'text/plain');
  const promptRef=await saveSnapshotRef(pool,{owner:lease.owner,projectId:project,runId:lease.runId,kind:'model_request',version:1,objectKey,sha256:digest(prompt),redactionVersion:'synthetic_redaction_v1',inputRevision,inputHash,blobs});
  const intent={owner_user_id:lease.owner,project_id:project,job_id:lease.jobId,run_id:lease.runId,trace_id:lease.runId,logical_call_id:'synthetic-covered-zero',call_id:randomUUID(),attempt_no:1,model_id:'synthetic-model',model_config_version:'synthetic-model-v1',prompt_snapshot_ref:promptRef};
  await recordPotentialCall(pool,lease,intent.logical_call_id,1,{callId:intent.call_id,modelId:intent.model_id,promptSnapshotId:promptRef});
  const result=await persistProviderResultObject({blobs,intent,bytes:Buffer.from('{"ok":true}'),resultSchemaVersion:'synthetic-covered-zero-v1',validate:valid});
  const observation:ProviderCallObservation={...intent,...result,provider_request_id:'synthetic-local-only',outcome:'pending_reconcile',finish_reason:'stop',error_code:'MODEL_USAGE_PENDING',usage:{status:'pending',input_tokens:null,cached_input_tokens:null,output_tokens:null,reasoning_tokens:null,total_tokens:null}};
  return recordProviderCallObservation(pool,blobs,observation,valid,{lease,source:'provider'});
 }
 try{
  const {owner,project}=await setup(pool),work=goal('argument_revision','synthetic-zero-usage');
  await deliver(pool,blobs,owner,project,work);
  const covered=await classified(pool,owner,project,work);assert.equal(covered.scope.amount_fen,0);
  await transaction(pool,async c=>{const p=(await c.query('SELECT * FROM bb_projects WHERE id=$1',[project])).rows[0];await reserveCredits(c,owner,covered.run,covered.quote.quote_id,covered.input,p,undefined,true);await enqueue(c,covered.run);});
  const lease=await claim(pool);assert.ok(lease);assert.equal(lease.runId,covered.run.id);
  assert.deepEqual((await pool.query('SELECT billing_mode,reservation_id FROM bb_runs WHERE id=$1',[covered.run.id])).rows[0],{billing_mode:'platform_trial',reservation_id:null});
  const observation=await pendingUsage(lease,project,covered.hash,covered.input.revision);assert.equal(observation.attempt_status,'completed');assert.notEqual(observation.usage_status,'measured');
  const replay=await readCheckpointedProviderResult({pool,blobs,lease,logicalCallId:'synthetic-covered-zero',attemptNo:1,validateResult:valid});assert.deepEqual(replay?.value,{ok:true});
  await pool.query("UPDATE bb_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[lease.jobId]);
  const restarted=await claim(pool);assert.ok(restarted);assert.equal(restarted.runId,covered.run.id);
  assert.deepEqual((await readCheckpointedProviderResult({pool,blobs,lease:restarted,logicalCallId:'synthetic-covered-zero',attemptNo:1,validateResult:valid}))?.value,{ok:true});
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE job_id=$1',[lease.jobId])).rows[0].n,1);
  await finish(pool,restarted,'failed');
  const trialOwner=await setup(pool),trial=await stage(pool,trialOwner.owner,trialOwner.project);
  await transaction(pool,c=>enqueue(c,trial.run));const trialLease=await claim(pool);assert.ok(trialLease);assert.equal(trialLease.runId,trial.run.id);
  const pending=await pendingUsage(trialLease,trialOwner.project,trial.hash,trial.input.revision);assert.equal(pending.attempt_status,'pending_reconcile');
  assert.equal((await pool.query('SELECT state FROM bb_jobs WHERE id=$1',[trialLease.jobId])).rows[0].state,'paused');assert.equal(await claim(pool),null);
 }finally{await pool.end();}
});
