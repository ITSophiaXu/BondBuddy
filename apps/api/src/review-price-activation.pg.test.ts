// Approved prices with synthetic owners/documents; real PostgreSQL accounting, no customer charge.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { INITIAL_FIXED_PRICES, type ReviewReport, type ReviewEvidenceRef } from '@bondbuddy/contracts';
import { createServer } from './server.js';
import { isolatedTestDatabase } from './test-database.js';
import { digest, uid, transaction, type PrivateBlobs } from './data.js';
import { creditBalance, grantCredits, publishPrices } from './billing.js';
import { auditCredits } from './billing-ops.js';
import { claim, finish, promoteWordArtifact } from './queue.js';
import { syntheticReviewPair } from './review-delivery-test-fixture.js';
import { makeSyntheticDocxFixture } from './docx-fixtures.js';
import { inputManifestHash } from './production-rule-pin.js';
import { syntheticAuthoringBlobs } from './test-authoring-source.js';
const config=JSON.parse(readFileSync(new URL('../../../deploy/m1/config/review-prices-20261009.json',import.meta.url),'utf8'));
test('approved review catalog preserves authoring and leaves unpriced independent revisions unavailable',()=>{
 assert.equal(config.id,'review-20261009-v1');assert.equal(config.prices.full_review,13900);assert.equal(config.prices.differential_review,1200);
 assert.equal(config.prices.review_revision,undefined);
 for(const [key,points] of Object.entries(INITIAL_FIXED_PRICES))assert.equal(config.prices[key],points);
});
const connection=await isolatedTestDatabase(undefined,'approved-review');
test('approved review prices: zero/one-point start, concurrency, delivered settlement, differential cancel/failure, history and old trial', {skip:!connection},async()=>{
 const pool=new Pool({connectionString:connection}),owner=uid();let active=owner;
 const bytes=new Map<string,Buffer>();
 const blobs:PrivateBlobs={put:async(k,b)=>{bytes.set(k,Buffer.from(b));},get:async k=>{const b=bytes.get(k);assert.ok(b);return b;},getIfExists:async k=>bytes.get(k)??null,getIfExistsBounded:async(k,n)=>{const b=bytes.get(k);if(b&&b.length>n)throw Error('bound');return b??null;},exists:async k=>bytes.has(k),delete:async k=>{bytes.delete(k);}};
 let paid=false;
 // Replay the approved 2026-10-09 catalog and its original trial transition.
 const makeApp=()=>createServer({pool,blobs,historicalBillingFixture:true,enablePaidReview:paid,principal:async()=>({userId:active,csrfVerified:true}),allowedOrigin:'http://bondbuddy.test'});
 let app=makeApp();const send=(method:string,url:string,payload?:any)=>app.inject({method:method as any,url,payload,headers:{origin:'http://bondbuddy.test'}});
 const ok=(r:any)=>{assert.ok(r.statusCode>=200&&r.statusCode<300,r.body);return r.json();};
 try{
  await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'review_'+uid().slice(0,8)]);
  await publishPrices(pool,config);await publishPrices(pool,config);
  const p=ok(await send('POST','/api/v1/projects',{kind:'review',name:'Approved review synthetic',issuer_name:null,market:null,offering:null})),base=`/api/v1/projects/${p.project_id}`;
  const upload=uid(),material=uid(),sha=digest('synthetic');
  await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state) VALUES($1,$2,$3,'synthetic.pdf','application/pdf',16,$4,'historical',$5,now()+interval '1 hour','completed')`,[upload,owner,p.project_id,sha,`synthetic/${upload}`]);
  await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state) VALUES($1,1,$2,$3,$4,'historical','synthetic.pdf','application/pdf',16,$5,$6,'persisted')`,[material,owner,p.project_id,upload,sha,`synthetic/${material}`]);
  const pin={material_id:material,material_version:1,sha256:sha},input={source_material_ref:pin,material_versions:[pin],requirements:[],as_of:null};
  ok(await send('PUT',`${base}/review-draft`,{kind:'input',expected_version:0,input}));
  const request={execution_request_id:uid(),operation:'full_review',expected_input_version:1,source_report_id:null,expected_plan_version:null,finding_ids:[]};
  const trial=ok(await send('POST',`${base}/review-executions`,request));assert.equal(trial.billing_mode,'platform_trial');
  await pool.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1",[trial.run_id]);
  await app.close();paid=true;app=makeApp();assert.equal(ok(await send('POST',`${base}/review-executions`,request)).billing_mode,'platform_trial');
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_credit_reservations WHERE run_id=$1',[trial.run_id])).rows[0].n,0);
  const fresh={...request,execution_request_id:uid()},quote=ok(await send('POST',`${base}/review-executions/quote`,fresh));assert.equal(quote.quote.points,'13900');
  const fund=(points:number,key:string)=>transaction(pool,c=>grantCredits(c,{owner,source:'existing_grant',key,points,expiresAt:null,actor:'synthetic',reason:'isolated test'}));
  const body={...fresh,quote_id:quote.quote.quote_id};
  assert.equal((await send('POST',`${base}/review-executions`,body)).statusCode,402);assert.deepEqual(await creditBalance(pool,owner),{available:0,frozen:0});
  await fund(1,'one');const runs=await Promise.all([send('POST',`${base}/review-executions`,body),send('POST',`${base}/review-executions`,body)]),run=ok(runs[0]);assert.equal(ok(runs[1]).run_id,run.run_id);
  assert.deepEqual(await creditBalance(pool,owner),{available:1,frozen:0});
  await fund(13899,'remaining-price');
  const lease=await claim(pool);assert.ok(lease);assert.equal(lease.runId,run.run_id);
  const unfinished=await promoteWordArtifact(pool,lease,makeSyntheticDocxFixture({text:'Synthetic review report'}),blobs,'generated_pair_v1');
  await assert.rejects(()=>finish(pool,lease,'succeeded',{artifactId:unfinished.artifactId,artifactVersion:1,blobs}),/Delivered review report/);
  const artifact=await syntheticReviewPair(pool,lease,blobs);
  await finish(pool,lease,'succeeded',{artifactId:artifact.artifactId,artifactVersion:1,blobs});
  assert.deepEqual(await creditBalance(pool,owner),{available:0,frozen:0});assert.equal(ok(await send('GET',`/api/v1/runs/${run.run_id}/credit-charge`)).state,'settled');
  assert.equal(ok(await send('POST',`${base}/review-executions`,body)).run_id,run.run_id);
  const update={execution_request_id:uid(),source_run_id:run.run_id,requirements:'Independent revision'};
  assert.equal((await send('POST',`${base}/review-updates/quote`,update)).json().code,'BILLING_NOT_READY');
  const report:ReviewReport={report_id:uid(),project_id:p.project_id,run_id:run.run_id,input_revision:run.input_revision,version:1,source_material:pin,scope:{mode:'full_review',finding_ids:[]},findings:[],coverage:[],limitations:['synthetic'],created_at:new Date().toISOString()};
  const ref:ReviewEvidenceRef={material_id:material,material_version:1,material_sha256:sha,parse_snapshot_id:'synthetic',parse_response_sha256:digest('parse'),record_id:'synthetic',record_sha256:digest('record'),locator_type:'pdf_bbox',locator:{page:1},quote:'synthetic',extraction_method:'native_text',uncertainty:[]};
  report.findings=[{finding_id:'F1',report_id:report.report_id,dimension:'financial',conclusion:'error',severity:'P2',title:'Synthetic',description:'Synthetic',target_refs:[ref],evidence_refs:[ref],suggested_change:'Synthetic',limitations:[],repairability:{can_revise:true,reason:'Synthetic',allowed_record_ids:['synthetic']},origin_report_id:report.report_id,check_status:'rechecked'}];
  await pool.query('INSERT INTO bb_review_reports(id,owner_user_id,project_id,run_id,version,content_sha256,report) VALUES($1,$2,$3,$4,1,$5,$6)',[report.report_id,owner,p.project_id,run.run_id,inputManifestHash(report),report]);
  await fund(1200,'local-review');
  for(const state of ['cancelled','failed']){
   const next={...fresh,execution_request_id:uid(),operation:'differential_review',source_report_id:report.report_id,finding_ids:['F1']};
   const q=ok(await send('POST',`${base}/review-executions/quote`,next));assert.equal(q.quote.points,'1200');
   const nextRun=ok(await send('POST',`${base}/review-executions`,{...next,quote_id:q.quote.quote_id}));assert.deepEqual(await creditBalance(pool,owner),{available:1200,frozen:0});
   await pool.query('UPDATE bb_runs SET state=$2 WHERE id=$1',[nextRun.run_id,state]);assert.deepEqual(await creditBalance(pool,owner),{available:1200,frozen:0});
  }
  const history=ok(await send('GET','/api/v1/credits/consumption-history'));
  assert.equal(history.items.find((i:any)=>i.run_id===run.run_id).charged_points,'13900');
  assert.equal((await pool.query("SELECT sum(points)::int n FROM bb_credit_events WHERE run_id=$1 AND kind='settle'",[run.run_id])).rows[0].n,13900,'progress debits must total the locked quote exactly once');
  assert.equal((await auditCredits(pool)).consistent,true);
  active=uid();assert.equal((await send('GET',`/api/v1/runs/${run.run_id}/credit-charge`)).statusCode,404);
 }finally{await app.close();await pool.end();}
});

test('current review requires its actual quote with either paid flag and creates no unquoted trial', {skip:!connection},async()=>{
 const pool=new Pool({connectionString:connection}),origin='http://bondbuddy.test';
 try{
  for(const paid of [false,true]){
   const owner=uid(),blobs=syntheticAuthoringBlobs();
   const app=createServer({pool,blobs,enableSyntheticQueue:true,enablePaidReview:paid,paymentProviders:[],
    principal:async()=>({userId:owner,csrfVerified:true}),allowedOrigin:origin});
   const send=(method:string,url:string,payload?:any,headers:Record<string,string>={})=>
    app.inject({method:method as any,url,payload,headers:{origin,...headers}});
   try{
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'current_review_'+owner.slice(0,8)]);
    const created=await send('POST','/api/v1/projects',{kind:'review',name:'Synthetic current review',issuer_name:null,market:null,offering:null});
    assert.equal(created.statusCode,201,created.body);
    const project=created.json().project_id,base=`/api/v1/projects/${project}`;
    const source=makeSyntheticDocxFixture({text:'Synthetic current reviewed source'}),fields={byte_size:source.length,sha256:digest(source)};
    const upload=await send('POST',`${base}/materials/uploads`,{...fields,filename:'synthetic-review.docx',
     media_type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',role:'historical'});
    assert.equal(upload.statusCode,201,upload.body);
    assert.equal((await send('PUT',upload.json().upload_url,source,{'content-type':'application/octet-stream'})).statusCode,204);
    const completed=await send('POST',`${base}/materials/uploads/${upload.json().upload_id}/complete`,fields);
    assert.equal(completed.statusCode,200,completed.body);
    const pin={material_id:completed.json().material_id,material_version:1,sha256:fields.sha256};
    const drafted=await send('PUT',`${base}/review-draft`,{kind:'input',expected_version:0,
     input:{source_material_ref:pin,material_versions:[pin],requirements:[],as_of:null}});
    assert.equal(drafted.statusCode,200,drafted.body);
    const request={execution_request_id:uid(),operation:'full_review',expected_input_version:1,
     source_report_id:null,expected_plan_version:null,finding_ids:[]};
    const unquoted=await send('POST',`${base}/review-executions`,request);
    assert.equal(unquoted.statusCode,409,unquoted.body);
    assert.equal(unquoted.json().code,'QUOTE_REQUIRED');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE project_id=$1',[project])).rows[0].n,0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_credit_events WHERE owner_user_id=$1',[owner])).rows[0].n,0);
    const quoted=await send('POST',`${base}/review-executions/quote`,request);
    assert.equal(quoted.statusCode,200,quoted.body);
    const {quote,shortage}=quoted.json();
    assert.equal(quote.quote_status,'ready');assert.equal(quote.auto_charge,true);
    assert.ok(quote.quote_id&&quote.scope_quote_id);
    assert.match(shortage,/^\d+$/);assert.ok(BigInt(shortage)>0n);
    // Use the server's actual current shortage, never a hard-coded tariff.
    await transaction(pool,c=>grantCredits(c,{owner,source:'purchase',key:uid(),points:shortage,expiresAt:null,
     actor:'synthetic-current-review',reason:'Synthetic funds for current review admission only'}));
    const accepted=await send('POST',`${base}/review-executions`,{...request,quote_id:quote.quote_id});
    assert.equal(accepted.statusCode,200,accepted.body);
    assert.equal(accepted.json().billing_mode,'fixed_credits');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_runs WHERE project_id=$1',[project])).rows[0].n,1);
    const charge=await send('GET',`/api/v1/runs/${accepted.json().run_id}/credit-charge`);
    assert.equal(charge.statusCode,200,charge.body);assert.equal(charge.json().state,'held');
    assert.equal(charge.json().quote.quote_id,quote.quote_id);
    assert.equal(charge.json().quote.points,quote.points);
   }finally{await app.close();}
  }
 }finally{await pool.end();}
});
