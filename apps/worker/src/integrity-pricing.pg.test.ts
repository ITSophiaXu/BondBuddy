import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID as uid} from 'node:crypto';
import {setTimeout} from 'node:timers/promises';
import Fastify from 'fastify';
import {PNG} from 'pngjs';
import {Pool} from 'pg';
import {AUTOMATIC_TASK_SKUS,PREVIOUS_AUTOMATIC_PRICE_VERSION,LEGACY_AUTOMATIC_PRICE_VERSION,INTEGRITY_PRICE,integritySelectableSitesForSubjects,integrityPricingScope,integrityScopeMeasurement,integrityRoundPoints,integrityObservedTimeValid,type IntegrityInput,type IntegrityDraft} from '@bondbuddy/contracts';
import {Problem,publicProblem,transaction,type PrivateBlobs} from '@bondbuddy/api/data';
import {registerIntegrity} from '../../api/dist/integrity.js';
import {grantCredits,creditBalance} from '../../api/dist/billing.js';
import {configureAutomaticBilling,withAutomaticBilling} from '../../api/dist/automatic-billing-context.js';
import {publishScopeQuote,publishStandardScopeQuote,requestScope,workScopeHash} from '../../api/dist/scope-quotations.js';
import {createBillingCostVersion,createBillingPriceDraft,validateBillingPriceDraft,publishBillingPriceVersion} from '../../api/dist/billing-price-admin.js';
import {grantBillingPermission} from '../../api/dist/billing-permissions.js';
import {auditCredits} from '../../api/dist/billing-audit.js';
import {taskRefundEligibility} from '../../api/dist/task-refunds.js';
import {action} from '@bondbuddy/api/queue';
import {integrityQueryEvidenceReady} from '@bondbuddy/api/integrity-billing-evidence';
import {inputManifestHash} from '@bondbuddy/api/production-rule-pin';
import {isolatedTestDatabase} from './test-database.js';
import {integrityInputGate,integrityPriceValid,loadIntegrityInput} from './integrity-input.js';
import {inputLockStage,materialsReadyStage,runPipelineOnce,type RunStage} from './run-pipeline.js';
import {integrityModelStage,integrityDeliveryStage} from './integrity-stage.js';
import {integrityRecords} from './integrity-evidence.js';

// Real Fastify route handling, PostgreSQL, worker gates, Python Word generation, artifact readback and wallet.
// Only website responses are synthetic. No external website, model or payment service is contacted.
const database=process.env.BB_TEST_DATABASE_URL,python=process.env.BONDBUDDY_TEST_PYTHON;
type Mode='legacy'|'reviewed'|'automatic'|'automatic-v2'|'automatic-v3'|'managed'|'coverage';
const failure={kind:'fail',code:'INPUT_REVISION_CONFLICT'};
async function setup(mode:Mode,splitFunding=false){
 const pool=new Pool({connectionString:await isolatedTestDatabase(undefined,'integrity-pricing-'+uid())}),owner=uid(),project=uid();
 const automatic=['automatic','automatic-v2','automatic-v3','managed'].includes(mode);configureAutomaticBilling(pool,automatic);
 await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'synthetic_integrity_'+owner.slice(0,8)]);
 await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic integrity pricing','generation')",[project,owner]);
 await transaction(pool,async c=>{if(splitFunding)await grantCredits(c,{owner,points:1000,key:uid(),source:'existing_grant',expiresAt:null,actor:'synthetic-test',reason:'Synthetic noncash scope allocation'});await grantCredits(c,{owner,points:splitFunding?199000:200000,key:uid(),source:'purchase',expiresAt:null,actor:'synthetic-test',reason:'Isolated pricing regression'});});
 const values=new Map<string,Buffer>();
 const blobs:PrivateBlobs={put:async(k,b)=>{values.set(k,Buffer.from(b));},get:async k=>{const b=values.get(k);assert.ok(b);return b;},getIfExists:async k=>values.get(k)??null,
  getIfExistsBounded:async(k,n)=>{const b=values.get(k);if(b&&b.length>n)throw Error('bounded');return b??null;},exists:async k=>values.has(k),delete:async k=>{values.delete(k);}};
 const app=Fastify();app.setErrorHandler((e,r,reply)=>e instanceof Problem?reply.code(e.status).send(publicProblem(e,r.id)):reply.code(500).send({message:e instanceof Error?e.message:String(e)}));
 registerIntegrity(app,()=>pool,async()=>owner,()=>blobs,mode!=='legacy');
 const base=`/api/v1/projects/${project}/integrity`;
 const post=async(path:string,payload:unknown)=>{const r=await app.inject({method:'POST',url:base+path,payload:payload as any});assert.equal(r.statusCode,200,r.body);return r.json();};
 const draft:IntegrityDraft={subjects:[{id:'issuer',kind:'company',name:'Synthetic integrity issuer',identifier:'',role:'issuer',province:'山东',city:'东营'}],
  site_ids:mode==='automatic'?integritySelectableSitesForSubjects([{name:'Synthetic integrity issuer',kind:'company',province:'山东',city:'东营'}]).map(s=>s.id):['bankruptcy'],notes:'Synthetic website responses only'};
 await post('/draft',{expected_revision:0,draft});
 let roundId=uid();
 async function publishManaged(){
  for(const permission of ['price_draft','price_publish'] as const)await grantBillingPermission(pool,{requestId:uid(),userId:owner,permission,actor:'synthetic-test',reason:'Synthetic isolated price test'});
  const {cost_version:cost}=await createBillingCostVersion(pool,owner,{request_id:uid(),rows:AUTOMATIC_TASK_SKUS.map(sku=>({sku,planned_cost_cny:'1.000000000001',source:'Synthetic test cost only'})),change_reason:'Synthetic complete costs'});
  const {version:v}=await createBillingPriceDraft(pool,owner,{request_id:uid(),base_cost_version:cost.id,multiplier_bps:'17000',change_reason:'Synthetic future price'});
  await validateBillingPriceDraft(pool,owner,v.id,{expected_checksum:v.checksum});
  const effective=new Date(Date.now()+1200);
  await publishBillingPriceVersion(pool,owner,v.id,{expected_checksum:v.checksum,effective_at:effective.toISOString()});
  await setTimeout(Math.max(0,effective.getTime()-Date.now()+50));return v.id;
 }
 if(mode==='managed')await publishManaged();
 async function quote(){
  if(mode==='automatic-v2'||mode==='automatic-v3'){const scope=integrityPricingScope(draft,roundId,integrityScopeMeasurement(draft));await transaction(pool,c=>withAutomaticBilling(c,true,()=>requestScope(c,owner,project,'integrity_round',workScopeHash(scope),scope),mode==='automatic-v2'?LEGACY_AUTOMATIC_PRICE_VERSION:PREVIOUS_AUTOMATIC_PRICE_VERSION));}
  let q=await post('/quote',{expected_revision:1,round_id:roundId});
  if(q.quote_status==='pending_scope'){
   const s=(await pool.query('SELECT * FROM bb_scope_quotations WHERE id=$1',[q.scope_quote_id])).rows[0];
   if(mode==='coverage')await publishStandardScopeQuote(pool,{id:s.id,expected_input_hash:s.input_hash.trim(),actor:'synthetic-reviewer',reason:'Synthetic contracted target',work_plan:{scope_status:'confirmed',items:[{key:'integrity',coverage_key:'synthetic-integrity-'+project,family:'goal_upgrade',price_key:'fact_revision',evidence:['synthetic:approved scope']}]}});
   else await publishScopeQuote(pool,{id:s.id,expected_input_hash:s.input_hash.trim(),actor:'synthetic-reviewer',reason:'Synthetic reviewed scope',lines:[{key:'integrity',label:'Synthetic integrity scope',quantity:1,unit:'round',unit_price_fen:5321,amount_fen:5321,evidence:['synthetic:approved scope']}]});
   q=await post('/quote',{expected_revision:1,round_id:roundId});
  }return q;
 }
 async function start(){roundId=uid();const q=await quote(),body={request_id:uid(),round_id:roundId,expected_revision:1,expected_points:q.points,price_version:q.price_version,...(q.scope_quote_id?{scope_quote_id:q.scope_quote_id}:{})};
  const started=await post('/runs',body);assert.equal((await post('/runs',body)).run_id,started.run_id);return{...started,points:Number(q.points)};}
 async function startHistoricalScope(){
  const q=await transaction(pool,c=>withAutomaticBilling(c,true,()=>requestScope(c,owner,project,'integrity_round',workScopeHash({draft}),{draft}),PREVIOUS_AUTOMATIC_PRICE_VERSION));
  return post('/runs',{request_id:uid(),expected_revision:1,expected_points:q.amount_fen,price_version:q.price_version,scope_quote_id:q.scope_quote_id});
 }
 let collections=0,unavailable=false,pauseNext=false;const failedSites=new Set<string>();
 const image=PNG.sync.write(new PNG({width:8,height:8}));
 const actual=integrityModelStage({collector:async site=>{
  const failed=unavailable||failedSites.has(site.id);collections++;return {query:'Synthetic issuer query',search_performed:true,outcome:failed?'failed':'no_results',scope:'Synthetic site',limitation:'Synthetic regression only',reason:'Synthetic website response',captures:failed?[]:[{kind:'result',url:site.links[0].url,title:'Synthetic zero-result response',captured_at:new Date().toISOString(),page:1,text:'Synthetic official query returned zero records',screenshot:image}]};
 }});
 const guarded:RunStage={...actual,run:async ctx=>{
  assert.equal(await ctx.validateBeforeModelCall!(),null,'provider gate preserves the accepted price');
  await loadIntegrityInput(ctx);
  if(pauseNext){pauseNext=false;return{kind:'pause',stage:'capability_not_ready',reason:'synthetic_checkpoint_pause'};}
  return actual.run(ctx);
 }};
 return{pool,owner,project,blobs,draft,post,start,startHistoricalScope,quote,publishManaged,failSites:(ids:string[])=>{for(const id of ids)failedSites.add(id);},get collections(){return collections;},set unavailable(v:boolean){unavailable=v;},set pauseNext(v:boolean){pauseNext=v;},
  read:async(id:string)=>{const run=(await pool.query('SELECT * FROM bb_runs WHERE id=$1',[id])).rows[0];const input=(await pool.query('SELECT * FROM bb_input_revisions WHERE project_id=$1 AND revision=$2',[project,run.input_revision])).rows[0];return{run,input};},
  execute:()=>runPipelineOnce({pool,blobs,runKinds:['generation'],stages:[inputLockStage,materialsReadyStage,guarded,integrityDeliveryStage()],onUnexpectedError:e=>assert.fail(JSON.stringify(e))}),
  close:async()=>{await app.close();await pool.end();}};
}

for(const mode of ['legacy','reviewed','automatic','automatic-v2','automatic-v3','managed','coverage'] as const)test(`integrity ${mode}: accepted quote reaches actual Word delivery, settles once, and exports free`,{skip:!database||!python,timeout:120000},async()=>{
 const h=await setup(mode);
 try{
  const started=await h.start(),expected={legacy:5000,reviewed:5321,automatic:integrityRoundPoints(h.draft.site_ids.length),'automatic-v2':22738,'automatic-v3':22738,managed:3606,coverage:3900}[mode];assert.equal(started.points,expected);
  const {run,input}=await h.read(started.run_id),m=input.manifest as IntegrityInput;
  assert.equal(await integrityInputGate(h.pool,run,input),null,'API-created quote must pass worker input lock');
  assert.deepEqual(await creditBalance(h.pool,h.owner),{available:200000-expected,frozen:expected});
  assert.deepEqual(await integrityInputGate(h.pool,{...run,owner_user_id:uid()},input),failure);
  assert.deepEqual(await integrityInputGate(h.pool,run,{...input,manifest:{...m,points:1}}),failure);
  for(const changed of [{...m,points:expected+1},{...m,price_version:mode==='legacy'?'outcome-cny-20261028-v1':INTEGRITY_PRICE.version},{...m,scope_quote_id:uid()}] as IntegrityInput[])
   assert.equal(await integrityPriceValid(h.pool,run,changed),false,'amount, price version and scope identity are pinned');
  if(mode!=='legacy'){
   assert.equal(await integrityPriceValid(h.pool,run,{...m,draft:{...m.draft,notes:'Changed scope'}}),false);
   h.pauseNext=true;assert.equal(await h.execute(),'paused');assert.equal(h.collections,0);
   await h.pool.query("UPDATE bb_scope_quotations SET status='expired',closed_at=clock_timestamp(),closure_reason='Synthetic expiry after acceptance' WHERE id=$1",[m.scope_quote_id]);
   if(mode==='automatic')await h.publishManaged(); // Newly published prices must not reprice the accepted scope.
   await action(h.pool,h.owner,started.run_id,'resume',uid());
  }
  assert.equal(await h.execute(),'succeeded');assert.ok(h.collections>0);
  const completed=(await h.pool.query('SELECT r.*,i.result FROM bb_runs r JOIN bb_integrity_runs i ON i.run_id=r.id WHERE r.id=$1',[run.id])).rows[0];
  assert.ok(completed.artifact_id);assert.equal(completed.result.records.length,h.draft.site_ids.length);
  assert.deepEqual(await creditBalance(h.pool,h.owner),{available:200000-expected,frozen:0});
  const reservation=(await h.pool.query('SELECT * FROM bb_credit_reservations WHERE run_id=$1',[run.id])).rows[0];
  assert.equal(reservation.state,'settled');assert.equal(Number(reservation.charged_points),expected);
  assert.equal((await h.pool.query("SELECT count(*)::int n FROM bb_credit_events WHERE run_id=$1 AND kind='settle'",[run.id])).rows[0].n,1);
  const calls=h.collections;assert.equal(await h.execute(),'idle');assert.equal(h.collections,calls);
  const exported=await h.post(`/runs/${run.id}/exports`,{request_id:uid(),expected_evidence_ids:[]});
  assert.equal(await h.execute(),'succeeded');assert.equal(h.collections,calls,'free export never repeats a website query');
  assert.equal((await h.pool.query('SELECT count(*)::int n FROM bb_credit_reservations WHERE run_id=$1',[exported.run_id])).rows[0].n,0);
  assert.equal((await h.pool.query('SELECT count(*)::int n FROM bb_credit_events WHERE run_id=$1',[exported.run_id])).rows[0].n,0);
  assert.deepEqual(await creditBalance(h.pool,h.owner),{available:200000-expected,frozen:0});
  if(mode==='automatic'){
   const next=await h.start();assert.notEqual(next.run_id,run.id,'the exact same saved draft can deliberately start a new round');
   const nextInput=(await h.read(next.run_id)).input.manifest as IntegrityInput;
   assert.deepEqual(nextInput.draft,m.draft);assert.notEqual(nextInput.scope_quote_id,m.scope_quote_id);assert.notEqual(nextInput.scope_round_id,m.scope_round_id);
   await action(h.pool,h.owner,next.run_id,'cancel',uid());
   assert.deepEqual(await creditBalance(h.pool,h.owner),{available:200000-expected,frozen:0});
  }
 }finally{await h.close();}
});

test('integrity automatic failures and cancellation release exactly once; a released hold cannot pass the worker gate',{skip:!database||!python,timeout:120000},async()=>{
 const h=await setup('automatic');
 try{
  const first=await h.start();h.unavailable=true;assert.equal(await h.execute(),'failed');
  assert.deepEqual(await creditBalance(h.pool,h.owner),{available:200000,frozen:0});
  const prior=await h.read(first.run_id);assert.deepEqual(await integrityInputGate(h.pool,prior.run,prior.input),failure);
  assert.equal((await h.pool.query('SELECT error_code FROM bb_jobs WHERE run_id=$1',[first.run_id])).rows[0].error_code,'DATA_UNAVAILABLE','unavailable-site failure uses the existing public error mapping');
  const result=(await h.pool.query('SELECT result FROM bb_integrity_runs WHERE run_id=$1',[first.run_id])).rows[0].result;
  assert.equal(result.records.length,h.draft.site_ids.length);assert.ok(result.records.every((r:any)=>r.search_performed&&r.browser.outcome==='failed'),'attempted requests cannot make failed searches billable');
  const retry=await h.start();await action(h.pool,h.owner,retry.run_id,'cancel',uid());
  assert.deepEqual(await creditBalance(h.pool,h.owner),{available:200000,frozen:0});
  const cancelled=await h.read(retry.run_id);assert.deepEqual(await integrityInputGate(h.pool,cancelled.run,cancelled.input),failure);
  const final=await h.start();h.unavailable=false;assert.equal(await h.execute(),'succeeded');
  assert.deepEqual(await creditBalance(h.pool,h.owner),{available:200000-integrityRoundPoints(h.draft.site_ids.length),frozen:0});
  assert.equal((await h.pool.query("SELECT count(*)::int n FROM bb_credit_events WHERE owner_user_id=$1 AND kind='settle'",[h.owner])).rows[0].n,1);
 }finally{await h.close();}
});

test('integrity rejects mismatched reservation, missing scope binding and changed quote lines before collection',{skip:!database,timeout:60000},async()=>{
 const h=await setup('automatic');
 try{
  const started=await h.start(),{run,input}=await h.read(started.run_id),m=input.manifest as IntegrityInput;
  assert.equal(await integrityPriceValid(h.pool,run,m),true);
  // Corrupt read snapshots only: production/database immutability guards remain enabled.
  for(const change of [
   {reservation_points:'1'},{reservation_quote_id:uid()},{reservation_state:'released'},{billing_policy:'m4_balance_v2'},
   {points:'1'},{price_version:INTEGRITY_PRICE.version},{scope_lines:[]},{scope_work_hash:'f'.repeat(64)}
  ]){
   const view={query:async(sql:string,args:any[])=>{const result=await h.pool.query(sql,args);return {...result,rows:result.rows.map(row=>'reservation_state' in row?{...row,...change}:row)};}} as unknown as Pool;
   assert.equal(await integrityPriceValid(view,run,m),false,JSON.stringify(change));
  }
  for(const change of [{automatic_bound:false},{published_at:null},{amount_fen:'1'},{lines:[]},{snapshot:{draft:{...h.draft,notes:'unaccepted'}}}]){
   const view={query:async(sql:string,args:any[])=>{const result=await h.pool.query(sql,args);return {...result,rows:result.rows.map(row=>'automatic_bound' in row?{...row,...change}:row)};}} as unknown as Pool;
   assert.equal(await integrityPriceValid(view,run,m),false,JSON.stringify(change));
  }
  await assert.rejects(h.pool.query('UPDATE bb_integrity_quotes SET points=1 WHERE run_id=$1',[run.id]),{code:'23514'});
  assert.equal(h.collections,0);
  await action(h.pool,h.owner,run.id,'cancel',uid());
 }finally{await h.close();}
});

test('historical zero-source web searches require matching durable provider actions, never model claims',{skip:!database,timeout:60000},async()=>{
 const h=await setup('legacy');
 try{
  const started=await h.start(),subject=h.draft.subjects[0],query=subject.name+' site:pccz.court.gov.cn',events=[{observed_at:new Date().toISOString(),item:{type:'web_search',id:'actual-query',status:'completed',action:{type:'search',query},results:[]}}];
  const records=integrityRecords(subject,['bankruptcy'],null,events,new Date().toISOString());assert.equal(records[0].status,'needs_manual');assert.equal(records[0].sources.length,0);
  assert.equal(await integrityQueryEvidenceReady(h.pool,h.owner,started.run_id,records),false,'a claimed search alone cannot settle');
  const sqlReady=async()=>(await h.pool.query('SELECT bb_integrity_query_evidence_ready($1,$2,$3::jsonb) ready',[h.owner,started.run_id,JSON.stringify(records)])).rows[0].ready;
  assert.equal(await sqlReady(),false);
  const job=(await h.pool.query('SELECT id FROM bb_jobs WHERE run_id=$1',[started.run_id])).rows[0].id;
  for(const time of ['0001-01-01T00:00:00Z','2000-02-29T23:59:59.123456Z','2024-02-29T00:00:00.1Z','2026-11-11T00:00:00.000Z','9999-12-31T23:59:59Z',null,'','0000-01-01T00:00:00Z','1900-02-29T00:00:00Z','2026-02-31T00:00:00Z','2026-13-01T00:00:00Z','2026-00-01T00:00:00Z','2026-01-00T00:00:00Z','2026-01-01T24:00:00Z','2026-01-01T00:60:00Z','2026-01-01T00:00:60Z','2026-11-11 00:00:00Z','2026-11-11','2026-11-11T00:00:00+00:00','2026-11-11T00:00:00.1234567Z','2026-11-11T00:00:00Z\n'])assert.equal((await h.pool.query('SELECT bb_integrity_observed_time_valid($1) valid',[time])).rows[0].valid,integrityObservedTimeValid(time),String(time));
  const save=async(status:'failed'|'completed',corrupt=false,override?:unknown[])=>{const call=uid(),logical='synthetic-'+status+'-'+uid(),observed=override??events.map(e=>({...e,item:{...e.item,status}}));
   await h.pool.query("INSERT INTO bb_model_call_attempts(id,owner_user_id,job_id,logical_call_id,attempt_no,status) VALUES($1,$2,$3,$4,1,$5)",[call,h.owner,job,logical,status]);
   await h.pool.query('INSERT INTO bb_model_web_search_evidence(call_id,owner_user_id,project_id,run_id,job_id,logical_call_id,content_sha256,events) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[call,h.owner,h.project,started.run_id,job,logical,corrupt?'0'.repeat(64):inputManifestHash(observed),JSON.stringify(observed)]);
  };
  await save('failed');assert.equal(await integrityQueryEvidenceReady(h.pool,h.owner,started.run_id,records),false);assert.equal(await sqlReady(),false);
  const event=events[0];
  for(const invalid of [{...event,item:{...event.item,id:''}},{...event,item:{...event.item,status:null}},{...event,item:{...event.item,action:{...event.item.action,type:null}}},{...event,observed_at:'2026-02-31T00:00:00Z'},{...event,observed_at:'2026-11-11 00:00:00Z'}]){
   await save('completed',false,[invalid]);assert.equal(await integrityQueryEvidenceReady(h.pool,h.owner,started.run_id,records),false);assert.equal(await sqlReady(),false,'JS and SQL reject malformed journal events');
  }
  for(const scope of ['pccz.court.gov.cn:443','user@pccz.court.gov.cn']){
   const scopedQuery=subject.name+' site:'+scope,scopedRecords=records.map(record=>({...record,query:scopedQuery}));
   await save('completed',false,[{...event,item:{...event.item,action:{type:'search',query:scopedQuery}}}]);
   assert.equal(await integrityQueryEvidenceReady(h.pool,h.owner,started.run_id,scopedRecords),false);
   assert.equal((await h.pool.query('SELECT bb_integrity_query_evidence_ready($1,$2,$3::jsonb) ready',[h.owner,started.run_id,JSON.stringify(scopedRecords)])).rows[0].ready,false,'raw official scopes reject ports and credentials equally');
  }
  await save('completed',true);assert.equal(await integrityQueryEvidenceReady(h.pool,h.owner,started.run_id,records),false);assert.equal(await sqlReady(),false,'a row with a mismatched content hash is never evidence');
  await save('completed',false,[{observed_at:event.observed_at,item:{type:event.item.type,id:event.item.id,action:{query}}}]);assert.equal(await integrityQueryEvidenceReady(h.pool,h.owner,started.run_id,records),true);assert.equal(await sqlReady(),true,'missing optional status and action type are historically valid');
  await save('completed');assert.equal(await integrityQueryEvidenceReady(h.pool,h.owner,started.run_id,records),true);assert.equal(await sqlReady(),true,'an authentic search can legitimately return zero sources');
  const unmatched=records.map(r=>({...r,query:'Another company site:pccz.court.gov.cn'}));assert.equal(await integrityQueryEvidenceReady(h.pool,h.owner,started.run_id,unmatched),false);
  await action(h.pool,h.owner,started.run_id,'cancel',uid());
 }finally{await h.close();}
});

test('v4 partial delivery settles only verified distinct pairs and preserves actual lot/refund caps',{skip:!database||!python,timeout:120000},async()=>{
 const h=await setup('automatic',true);
 try{
  h.failSites(h.draft.site_ids.slice(2));const started=await h.start(),reserved=integrityRoundPoints(h.draft.site_ids.length),charged=integrityRoundPoints(2);
  assert.equal(started.points,reserved);assert.equal(await h.execute(),'succeeded');
  const reservation=(await h.pool.query('SELECT * FROM bb_credit_reservations WHERE run_id=$1',[started.run_id])).rows[0];
  assert.equal(reservation.state,'settled');assert.equal(Number(reservation.charged_points),charged);assert.equal(charged,2170);
  const allocations=(await h.pool.query('SELECT l.source,a.charged_points FROM bb_credit_allocations a JOIN bb_credit_lots l ON l.id=a.lot_id WHERE a.reservation_id=$1',[reservation.id])).rows;
  assert.equal(allocations.reduce((n,a)=>n+Number(a.charged_points),0),charged);assert.equal(Number(allocations.find(a=>a.source==='existing_grant')?.charged_points),1000);
  const events=(await h.pool.query('SELECT kind,sum(points)::int points FROM bb_credit_events WHERE reservation_id=$1 AND kind IN (\'settle\',\'release\') GROUP BY kind',[reservation.id])).rows;
  assert.equal(events.find(e=>e.kind==='settle')?.points,charged);assert.equal(events.find(e=>e.kind==='release')?.points,reserved-charged);
  assert.deepEqual(await creditBalance(h.pool,h.owner),{available:200000-charged,frozen:0});
  const result=(await h.pool.query('SELECT result FROM bb_integrity_runs WHERE run_id=$1',[started.run_id])).rows[0].result;
  assert.equal(result.measurement.verified_successful_pairs,2);
  const successful=result.records.find((record:any)=>record.browser?.outcome==='no_results');assert.ok(successful);
  for(const invalid of [{...successful,search_performed:'true'},{...successful,browser:null},{...successful,browser:{...successful.browser,diagnostic:null}}]){
   assert.equal(await integrityQueryEvidenceReady(h.pool,h.owner,started.run_id,[invalid]),false);
   assert.equal((await h.pool.query('SELECT bb_integrity_query_evidence_ready($1,$2,$3::jsonb) ready',[h.owner,started.run_id,JSON.stringify([invalid])])).rows[0].ready,false,'browser boolean/null boundaries agree in JS and SQL');
  }
  const duplicateRecords=[...result.records,...result.records];
  assert.equal((await h.pool.query('SELECT bb_integrity_verified_query_pair_count($1,$2,$3::jsonb) n',[h.owner,started.run_id,JSON.stringify(duplicateRecords)])).rows[0].n,2);
  assert.equal((await auditCredits(h.pool,h.owner)).consistent,true);
  const eligibility=await taskRefundEligibility(h.pool,h.owner,started.run_id);
  assert.equal(eligibility.charged_points,String(charged));assert.equal(eligibility.units.reduce((n,u)=>n+Number(u.available_points),0),charged);
  assert.deepEqual(eligibility.units.map(u=>Number(u.charged_points)),[2000,170]);
 }finally{await h.close();}
});

test('a valid historical v3 draft-only quote remains executable under the new global v4 standard',{skip:!database||!python,timeout:120000},async()=>{
 const h=await setup('automatic-v3');
 try{
  const started=await h.startHistoricalScope(),{run,input}=await h.read(started.run_id),manifest=input.manifest as IntegrityInput;
  assert.equal(manifest.price_version,PREVIOUS_AUTOMATIC_PRICE_VERSION);assert.equal(manifest.points,22738);assert.equal(manifest.scope_round_id,undefined);
  assert.equal(await integrityInputGate(h.pool,run,input),null);assert.equal(await h.execute(),'succeeded');
  const reservation=(await h.pool.query('SELECT charged_points FROM bb_credit_reservations WHERE run_id=$1',[run.id])).rows[0];assert.equal(Number(reservation.charged_points),22738);
 }finally{await h.close();}
});
