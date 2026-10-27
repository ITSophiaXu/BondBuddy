import test from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {INITIAL_FIXED_PRICES} from '@bondbuddy/contracts';
import {createServer} from './server.js';
import {isolatedTestDatabase} from './test-database.js';
import {creditBalance,grantCredits,publishPrices} from './billing.js';
import {auditCredits} from './billing-ops.js';
import {claim,renew,checkpointStage,pauseAtCheckpoint,resumePausedRun,recordReviewAction,finish,promoteWordArtifact} from './queue.js';
import {digest,uid,transaction,type PrivateBlobs} from './data.js';
import {makeSyntheticDocxFixture} from './docx-fixtures.js';
import {syntheticReviewPair} from './review-delivery-test-fixture.js';
import {attachInitialLegacyCreditPolicy} from './legacy-credit-policy-test-fixture.js';

const connection=await isolatedTestDatabase(undefined,'review-dynamic-balance');
test('review dynamic balance: zero guard, one-point start, real debit, pause/resume, preserved delivery, cancellation and refund',{skip:!connection,timeout:120000},async()=>{
  const pool=new Pool({connectionString:connection}),owner='review-dynamic-'+uid();let actor=owner;
  const files=new Map<string,Buffer>();
  const blobs:PrivateBlobs={put:async(k,b)=>{files.set(k,Buffer.from(b));},get:async k=>files.get(k)!,getIfExists:async k=>files.get(k)??null,getIfExistsBounded:async k=>files.get(k)??null,exists:async k=>files.has(k),delete:async k=>{files.delete(k);}};
  const app=createServer({pool,blobs,enablePaidReview:true,enableSyntheticQueue:true,principal:async()=>({userId:actor,csrfVerified:true}),allowedOrigin:'http://bondbuddy.test'});
  const legacyApp=createServer({pool,blobs,enablePaidReview:false,enableSyntheticQueue:true,principal:async()=>({userId:actor,csrfVerified:true}),allowedOrigin:'http://bondbuddy.test'});
  const send=(method:string,url:string,payload?:any)=>app.inject({method:method as any,url,payload,headers:{origin:'http://bondbuddy.test'}});
  const ok=(r:any)=>{assert.ok(r.statusCode>=200&&r.statusCode<300,r.body);return r.json();};
  const fund=(points:number)=>transaction(pool,c=>grantCredits(c,{owner,source:'existing_grant',key:uid(),points,expiresAt:null,actor:'synthetic',reason:'isolated test'}));
  const charge=async(id:string)=>ok(await send('GET',`/api/v1/runs/${id}/credit-charge`));
  const act=(id:string,action:string)=>send('POST',`/api/v1/runs/${id}/${action}`,{reason:'synthetic-test'});
  const age=(id:string)=>pool.query("UPDATE bb_authoring_progress SET clock_at=now()-interval '60 seconds',lease_until=now()+interval '30 seconds' WHERE run_id=$1",[id]);
  const prepare=async()=>{
    const project=ok(await send('POST','/api/v1/projects',{kind:'review',name:'Synthetic dynamic review',issuer_name:null,market:null,offering:null})),base=`/api/v1/projects/${project.project_id}`;
    const upload=uid(),material=uid(),sha=digest('synthetic review input');
    await pool.query("INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state) VALUES($1,$2,$3,'synthetic.pdf','application/pdf',16,$4,'historical',$5,now()+interval '1 hour','completed')",[upload,owner,project.project_id,sha,`synthetic/${upload}`]);
    await pool.query("INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state) VALUES($1,1,$2,$3,$4,'historical','synthetic.pdf','application/pdf',16,$5,$6,'persisted')",[material,owner,project.project_id,upload,sha,`synthetic/${material}`]);
    const pin={material_id:material,material_version:1,sha256:sha};
    ok(await send('PUT',`${base}/review-draft`,{kind:'input',expected_version:0,input:{source_material_ref:pin,material_versions:[pin],requirements:['Synthetic requirement'],as_of:null}}));
    const request={execution_request_id:uid(),operation:'full_review',expected_input_version:1,source_report_id:null,expected_plan_version:null,finding_ids:[]};
    const quote=ok(await send('POST',`${base}/review-executions/quote`,request));
    return {project,quote,start:()=>send('POST',`${base}/review-executions`,{...request,quote_id:quote.quote.quote_id}),
      startLegacy:async(lotId:string)=>{
        const run=ok(await legacyApp.inject({method:'POST',url:`${base}/review-executions`,headers:{origin:'http://bondbuddy.test'},payload:{...request,quote_id:quote.quote.quote_id}}));
        return attachInitialLegacyCreditPolicy(pool,{owner,runId:run.run_id,quoteId:quote.quote.quote_id,policy:'on_delivery',lotId});
      }};
  };
  try{
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'review_dynamic']);
    await publishPrices(pool,{id:'synthetic-review-dynamic',prices:{...INITIAL_FIXED_PRICES,full_review:10000,differential_review:1000,review_revision:200},effectiveAt:'2026-01-01T00:00:00Z',actor:'synthetic',reason:'isolated test prices'});
    const prepared=await prepare();assert.equal((await prepared.start()).statusCode,402);
    await fund(1);const concurrent=await Promise.all([prepared.start(),prepared.start()]);const run=ok(concurrent[0]);assert.equal(ok(concurrent[1]).run_id,run.run_id);
    assert.deepEqual(await creditBalance(pool,owner),{available:1,frozen:0});
    assert.equal((await charge(run.run_id)).progress.policy,'authoring_balance_v2');assert.equal((await charge(run.run_id)).progress.charged_points,0);
    const lease=await claim(pool);assert.ok(lease);assert.equal(lease.runId,run.run_id);
    await checkpointStage(pool,lease,'input_lock',{saved:true});assert.equal((await creditBalance(pool,owner)).available,0);
    assert.equal((await charge(run.run_id)).progress.charged_points,1);assert.equal(await pauseAtCheckpoint(pool,lease),true);
    ok(await act(run.run_id,'pause'));await fund(20);assert.equal(await resumePausedRun(pool,owner,run.run_id,'credits_recharged'),false,'topup cannot override manual pause');
    ok(await act(run.run_id,'resume'));const resumed=await claim(pool);assert.ok(resumed);assert.equal((resumed.checkpoint.stages as any).input_lock.saved,true);
    ok(await act(run.run_id,'pause'));const frozen=(await charge(run.run_id)).progress.charged_points;
    await renew(pool,resumed);assert.equal((await charge(run.run_id)).progress.charged_points,frozen);assert.equal(await pauseAtCheckpoint(pool,resumed),true);
    ok(await act(run.run_id,'resume'));const saving=await claim(pool);assert.ok(saving);
    const report=await syntheticReviewPair(pool,saving,blobs);
    await checkpointStage(pool,saving,'review_saved_report',{artifact:report.artifactId});
    assert.equal((await finish(pool,saving,'succeeded',{artifactId:report.artifactId,artifactVersion:1,blobs})).state,'paused');
    await fund(20000);assert.equal(await resumePausedRun(pool,owner,run.run_id,'credits_recharged'),true);
    const delivery=await claim(pool);assert.ok(delivery);assert.equal((delivery.checkpoint.stages as any).review_saved_report.artifact,report.artifactId);
    await finish(pool,delivery,'succeeded',{artifactId:report.artifactId,artifactVersion:1,blobs});
    assert.equal((await charge(run.run_id)).progress.charged_points,10000);assert.equal((await act(run.run_id,'cancel')).statusCode,409);
    assert.equal((await pool.query("SELECT sum(points)::int n FROM bb_credit_events WHERE run_id=$1 AND kind='settle'",[run.run_id])).rows[0].n,10000);
    const next=await prepare(),cancelled=ok(await next.start()),work=await claim(pool);assert.ok(work);
    await age(cancelled.run_id);await renew(pool,work);
    await recordReviewAction(pool,work,{version:'review-action-v1',action_id:digest('actual synthetic check'),code:'check_financial',state:'started'});
    const consumed=(await charge(cancelled.run_id)).progress.charged_points;assert.ok(consumed>0);
    assert.ok((await charge(cancelled.run_id)).progress.last_activity_at);
    ok(await act(cancelled.run_id,'cancel'));assert.ok((await charge(cancelled.run_id)).progress.charged_points>=consumed);
    const beforeFailure=await creditBalance(pool,owner),failed=ok(await (await prepare()).start()),failing=await claim(pool);assert.ok(failing);
    await age(failed.run_id);await renew(pool,failing);assert.ok((await creditBalance(pool,owner)).available<beforeFailure.available);
    await finish(pool,failing,'failed',{errorCode:'DATA_UNAVAILABLE'});assert.deepEqual(await creditBalance(pool,owner),beforeFailure);assert.equal((await charge(failed.run_id)).progress.charged_points,0);
    // Reconstruct pre-change paid review reservations in this isolated database only.
    // New code must neither debit these incrementally nor change their release policy.
    for(const outcome of ['succeeded','cancelled','failed'] as const){
      const lot=await fund(10000),legacy=await prepare(),old=await legacy.startLegacy(lot);
      const before=await creditBalance(pool,owner),oldLease=await claim(pool);assert.ok(oldLease);assert.equal(oldLease.runId,old.run_id);
      await checkpointStage(pool,oldLease,'materials_ready',{});await age(old.run_id);await renew(pool,oldLease);
      assert.deepEqual(await creditBalance(pool,owner),before);assert.equal((await charge(old.run_id)).progress.policy,'on_delivery');
      if(outcome==='succeeded'){
        const artifact=await syntheticReviewPair(pool,oldLease,blobs);
        await finish(pool,oldLease,outcome,{artifactId:artifact.artifactId,artifactVersion:1,blobs});
      }else if(outcome==='cancelled')ok(await act(old.run_id,'cancel'));
      else await finish(pool,oldLease,outcome,{errorCode:'DATA_UNAVAILABLE'});
      assert.deepEqual(await creditBalance(pool,owner),{available:before.available+(outcome==='succeeded'?0:10000),frozen:before.frozen-10000});
      assert.equal((await charge(old.run_id)).progress.charged_points,outcome==='succeeded'?10000:0);
    }
    actor='foreign-'+uid();assert.equal((await send('GET',`/api/v1/runs/${run.run_id}/credit-charge`)).statusCode,404);actor=owner;
    assert.equal((await auditCredits(pool)).consistent,true);
  }finally{await legacyApp.close();await app.close();await pool.end();}
});
