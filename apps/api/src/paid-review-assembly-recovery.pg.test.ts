import assert from 'node:assert/strict';
import test from 'node:test';
import {Pool} from 'pg';
import {createServer} from './server.js';
import {uid,digest,transaction,type PrivateBlobs} from './data.js';
import {grantCredits,creditBalanceExact} from './billing.js';
import {auditCredits} from './billing-audit.js';
import {claim,finish,checkpointStage,recordPotentialCall,requeueFailedReviewAssembly} from './queue.js';
import {savePromptSnapshot} from './log-ops.js';
import {persistProviderResultObject,recordProviderCallObservation,type ProviderCallIntent} from './provider-results.js';
import {syntheticReviewPair} from './review-delivery-test-fixture.js';
import {isolatedTestDatabase} from './test-database.js';

const connection=await isolatedTestDatabase(undefined,'paid-review-assembly-recovery');
const actor='synthetic-paid-review-repair';
async function fixture(pool:Pool){
  const owner=uid(),origin='https://synthetic.invalid',objects=new Map<string,Buffer>();
  const blobs:PrivateBlobs={put:async(k,b)=>{objects.set(k,Buffer.from(b));},get:async k=>{const b=objects.get(k);assert.ok(b);return Buffer.from(b);},
    getIfExists:async k=>objects.get(k)??null,getIfExistsBounded:async(k,n)=>{const b=objects.get(k);if(b&&b.length>n)throw Error('bound');return b??null;},exists:async k=>objects.has(k),delete:async k=>{objects.delete(k);}};
  const app=createServer({pool,blobs,enablePaidReview:true,enableSubscriptionBilling:true,enableRunRuntime:true,paymentProviders:[],allowedOrigin:origin,principal:async()=>({userId:owner,csrfVerified:true})});
  const send=(method:string,url:string,payload?:any)=>app.inject({method:method as any,url,payload,headers:{origin}});
  const good=(r:any)=>{assert.ok(r.statusCode>=200&&r.statusCode<300,r.body);return r.json();};
  try{
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'paid_reassembly_'+owner.slice(0,8)]);
    const project=good(await send('POST','/api/v1/projects',{kind:'review',name:'Synthetic paid assembly repair',issuer_name:null,market:null,offering:null})).project_id;
    const upload=uid(),material=uid(),sha=digest('synthetic source'),base='/api/v1/projects/'+project;
    await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
      VALUES($1,$2,$3,'synthetic.pdf','application/pdf',16,$4,'historical',$5,now()+interval '1 hour','completed')`,[upload,owner,project,sha,'synthetic/'+upload]);
    await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES($1,1,$2,$3,$4,'historical','synthetic.pdf','application/pdf',16,$5,$6,'persisted')`,[material,owner,project,upload,sha,'synthetic/'+material]);
    const pin={material_id:material,material_version:1,sha256:sha};
    good(await send('PUT',base+'/review-draft',{kind:'input',expected_version:0,input:{source_material_ref:pin,material_versions:[pin],requirements:[],as_of:null,evidence_links:[]}}));
    await transaction(pool,c=>grantCredits(c,{owner,source:'purchase',key:'synthetic:'+uid(),points:100000,expiresAt:null,actor,reason:'Synthetic credit fixture; no real payment'}));
    const intent={execution_request_id:uid(),operation:'full_review',expected_input_version:1,source_report_id:null,expected_plan_version:null,finding_ids:[]};
    const quote=good(await send('POST',base+'/review-executions/quote',intent)).quote;assert.equal(quote.points,'27195');
    const runId=good(await send('POST',base+'/review-executions',{...intent,quote_id:quote.quote_id})).run_id,lease=await claim(pool,120);assert.ok(lease);assert.equal(lease.runId,runId);
    assert.deepEqual(await creditBalanceExact(pool,owner),{available:72805n,frozen:27195n});
    const r=(await pool.query('SELECT * FROM bb_runs WHERE id=$1',[runId])).rows[0],prompt='Synthetic original review result '+runId,key=digest(prompt).slice(0,24),logical='review-cli-v3-'+key;
    const snapshot=await savePromptSnapshot(pool,blobs,{owner,projectId:project,runId,kind:'model_request',version:1,body:prompt,inputRevision:r.input_revision,inputHash:r.input_hash.trim(),templateVersion:'synthetic-paid-review'});
    await checkpointStage(pool,lease,'review_cli_v3_'+key+'_prompt',{snapshot_id:snapshot});
    const call:ProviderCallIntent={owner_user_id:owner,project_id:project,run_id:runId,trace_id:runId,job_id:lease.jobId,logical_call_id:logical,call_id:uid(),attempt_no:1,
      model_id:'synthetic-model',model_config_version:'synthetic-v1',prompt_snapshot_ref:snapshot};
    await recordPotentialCall(pool,lease,logical,1,{callId:call.call_id,modelId:call.model_id,promptSnapshotId:snapshot});
    const bytes=Buffer.from(JSON.stringify({synthetic:true,run:runId})),validate=(v:unknown):v is {synthetic:true;run:string}=>!!v&&typeof v==='object'&&(v as any).synthetic===true&&(v as any).run===runId;
    const result=await persistProviderResultObject({blobs,intent:call,bytes,resultSchemaVersion:'review-cli-v3',validate});
    await recordProviderCallObservation(pool,blobs,{...call,...result,provider_request_id:null,finish_reason:'stop',outcome:'completed',error_code:null,
      usage:{status:'measured',input_tokens:123,cached_input_tokens:12,output_tokens:17,reasoning_tokens:0,total_tokens:140}},validate,{lease,source:'provider'});
    await finish(pool,lease,'failed',{errorCode:'VALIDATION_FAILED',failedStage:'model_generation'});
    assert.deepEqual(await creditBalanceExact(pool,owner),{available:100000n,frozen:0n});
    return{owner,project,runId,lease,blobs,objects,call,result,bytes,recover:()=>requeueFailedReviewAssembly(pool,blobs,{runId,attemptId:call.call_id,resultSha256:result.result_sha256,actor})};
  }finally{await app.close();}
}
async function ledger(pool:Pool,owner:string){return{
  lots:(await pool.query('SELECT * FROM bb_credit_lots WHERE owner_user_id=$1 ORDER BY id',[owner])).rows,
  reservations:(await pool.query('SELECT * FROM bb_credit_reservations WHERE owner_user_id=$1 ORDER BY id',[owner])).rows,
  events:(await pool.query('SELECT * FROM bb_credit_events WHERE owner_user_id=$1 ORDER BY id',[owner])).rows,
  attempts:(await pool.query('SELECT * FROM bb_model_call_attempts WHERE owner_user_id=$1 ORDER BY id',[owner])).rows,
  results:(await pool.query('SELECT * FROM bb_provider_result_refs WHERE owner_user_id=$1 ORDER BY id',[owner])).rows,
};}
test('paid full-review platform assembly repair preserves original release and forbids another model call',{skip:!connection,timeout:120000},async t=>{
  const pool=new Pool({connectionString:connection});
  try{
    await t.test('trusted exact result reaches delivered success once without another credit event or attempt',async()=>{
      const f=await fixture(pool),before=await ledger(pool,f.owner);assert.equal(before.reservations[0].state,'released');assert.equal(before.reservations[0].charged_points,'0');
      assert.equal((await f.recover()).idempotent,false);assert.equal((await f.recover()).idempotent,true);
      assert.equal((await pool.query('SELECT bb_review_assembly_recovery_credit_ready(r) ready FROM bb_runs r WHERE id=$1',[f.runId])).rows[0].ready,true);
      const lease=await claim(pool,120);assert.ok(lease);assert.equal(lease.runId,f.runId);
      await assert.rejects(recordPotentialCall(pool,lease,'another-review-call',1),/reuse-only/);
      await assert.rejects(finish(pool,lease,'succeeded'),{code:'DELIVERY_FAILED'});assert.deepEqual(await ledger(pool,f.owner),before);
      assert.deepEqual(await f.blobs.get(f.result.result_ref),f.bytes);
      const artifact=await syntheticReviewPair(pool,lease,f.blobs);await finish(pool,lease,'succeeded',{artifactId:artifact.artifactId,artifactVersion:artifact.artifactVersion,blobs:f.blobs});
      assert.equal((await pool.query('SELECT state FROM bb_runs WHERE id=$1',[f.runId])).rows[0].state,'succeeded');
      await assert.rejects(finish(pool,lease,'succeeded',{artifactId:artifact.artifactId,artifactVersion:artifact.artifactVersion,blobs:f.blobs}),{code:'ALREADY_TERMINAL'});
      assert.deepEqual(await ledger(pool,f.owner),before);assert.equal((await auditCredits(pool,f.owner)).consistent,true);
    });
    await t.test('a bare flag and an unmatched result cannot authorize a released reservation',async()=>{
      const f=await fixture(pool),before=await ledger(pool,f.owner);
      await pool.query(`UPDATE bb_jobs SET checkpoint=jsonb_set(checkpoint,'{review_assembly_recovery}','{"policy":"review_assembly_v1","reuse_only":true}') WHERE id=$1`,[f.lease.jobId]);
      assert.equal((await pool.query('SELECT bb_review_assembly_recovery_credit_ready(r) ready FROM bb_runs r WHERE id=$1',[f.runId])).rows[0].ready,false);
      await assert.rejects(pool.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1",[f.runId]),(e:any)=>e.code==='23514'&&/already finalized/.test(e.message));
      await pool.query("UPDATE bb_jobs SET checkpoint=checkpoint-'review_assembly_recovery' WHERE id=$1",[f.lease.jobId]);
      await f.recover();const valid=(await pool.query('SELECT checkpoint FROM bb_jobs WHERE id=$1',[f.lease.jobId])).rows[0].checkpoint;
      await pool.query("UPDATE bb_jobs SET checkpoint=jsonb_set(checkpoint,'{review_assembly_recovery,result_sha256}',to_jsonb($2::text)) WHERE id=$1",[f.lease.jobId,'f'.repeat(64)]);
      await assert.rejects(pool.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1",[f.runId]),(e:any)=>e.code==='23514');
      await pool.query('UPDATE bb_jobs SET checkpoint=$2 WHERE id=$1',[f.lease.jobId,valid]);
      const narrow=(await pool.query(`SELECT bb_review_assembly_recovery_credit_ready(jsonb_populate_record(NULL::bb_runs,to_jsonb(r)||'{"task_kind":"update"}')) ready FROM bb_runs r WHERE id=$1`,[f.runId])).rows[0];assert.equal(narrow.ready,false);
      const lease=await claim(pool,120);assert.ok(lease);assert.equal(lease.runId,f.runId);await finish(pool,lease,'failed',{errorCode:'VALIDATION_FAILED',failedStage:'synthetic_retry'});
      assert.deepEqual(await ledger(pool,f.owner),before);assert.equal((await auditCredits(pool,f.owner)).consistent,true);
    });
  }finally{await pool.end();}
});
