import { emptyUpdateDetails } from '@bondbuddy/contracts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import { createServer } from '@bondbuddy/api';
import { azureBlobs, uid } from '@bondbuddy/api/data';
import { saveSnapshotRef, observeUsage, usageTotals } from '@bondbuddy/api/observability';
import { claim, finish, recordPotentialCall, jobSnapshot } from '@bondbuddy/api/queue';
import { reconcilePausedProviderCall, recordProviderCallObservation, persistProviderResultObject, type PrivateBlobs } from '@bondbuddy/api/provider-results';
import { DurableProbeJournal } from './durable-probe-journal.js';
import { runDeepSeekProbe, type ProbeInput, type ProbeJournal, type ProbeObservation } from './deepseek-probe.js';
import { runOnce } from './index.js';
import { reuseProviderCallOrSend } from './provider-reconciliation.js';
import { makeWorkerDocxFixture } from './docx-test-fixture.js';
import { uploadSyntheticReference,uploadSyntheticAudit } from '@bondbuddy/api/test-authoring-source';
import { isolatedTestDatabase } from './test-database.js';

const testDatabaseUrl = await isolatedTestDatabase();

const connection=testDatabaseUrl;
const blobConnection=process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const validResult=(value:unknown)=>typeof value==='object'&&value!==null&&(value as {ok?:unknown}).ok===true;
const measuredUsage={status:'measured' as const,input_tokens:11,cached_input_tokens:2,output_tokens:4,reasoning_tokens:1,total_tokens:15};
const completeBody=(content='{"ok":true}',usage:Record<string,unknown>|null={prompt_tokens:11,prompt_cache_hit_tokens:2,completion_tokens:4,completion_tokens_details:{reasoning_tokens:1},total_tokens:15})=>({id:'chatcmpl-synthetic',choices:[{message:{content},finish_reason:'stop'}],...(usage?{usage}:{})});
const syntheticFetch=(counter:{value:number},body:unknown,status=200):typeof fetch=>(async(_url:unknown,options:RequestInit)=>{
  counter.value++;
  assert.equal(options.method,'POST');
  assert.equal(JSON.parse(String(options.body)).tools,undefined,'synthetic probe sends no tools');
  return new Response(JSON.stringify(body),{status,headers:{'x-request-id':'synthetic-request-1'}});
}) as typeof fetch;

test('synthetic PostgreSQL/Azurite provider result reconciliation is restart-safe and owner-bound',{skip:!connection||!blobConnection},async()=>{
  const pool=new Pool({connectionString:connection});
  const blobs=azureBlobs(blobConnection!,'bondbuddy-m1-12-result');
  let activeOwner='synthetic-reconcile-owner';
  const app=createServer({pool,blobs,allowedOrigin:'http://bondbuddy.test',principal:async()=>({userId:activeOwner,csrfVerified:true}),enableSyntheticQueue:true,historicalBillingFixture:true});
  const send=(method:string,url:string,payload?:unknown)=>app.inject({method:method as any,url,headers:{origin:'http://bondbuddy.test'},payload:payload as any});
  async function fixture(label:string) {
    const p=await send('POST','/api/v1/projects',{name:`Synthetic reconciliation ${label}`,kind:'update',issuer_name:'Synthetic issuer',market:'sse',offering:'private',update_details:{...emptyUpdateDetails(),authoring_mode:'unified_v1'}});
    assert.equal(p.statusCode,201,p.body);
    const projectId=p.json().project_id;
    const source=await uploadSyntheticReference(app,projectId),audit=await uploadSyntheticAudit(app,projectId);
    const input=await send('POST',`/api/v1/projects/${projectId}/input-revisions`,{...source,material_versions:[...source.material_versions,audit]});
    assert.equal(input.statusCode,201,input.body);
    const request={execution_request_id:`synthetic-reconcile-${label}-${uid()}`,project_id:projectId,input_revision:1,input_hash:input.json().input_hash,task_kind:'update',input_manifest_ref:'synthetic-manifest',storage_origin:'cloud',workspace_id:'synthetic-worker'};
    const submitted=await send('POST','/api/v1/runs/execute',request);
    assert.equal(submitted.statusCode,202,submitted.body);
    const runId=submitted.json().run_id;
    const job=(await pool.query('SELECT id FROM bb_jobs WHERE run_id=$1',[runId])).rows[0];
    assert.ok(job);
    const prompt=Buffer.from(`synthetic prompt ${label}`);
    const objectKey=`users/${activeOwner}/projects/${projectId}/snapshots/prompt-${runId}`;
    await blobs.put(objectKey,prompt,'text/plain');
    const promptRef=await saveSnapshotRef(pool,{owner:activeOwner,projectId,runId,kind:'model_request',version:1,objectKey,sha256:createHash('sha256').update(prompt).digest('hex'),redactionVersion:'synthetic_redaction_v1',inputRevision:1,inputHash:input.json().input_hash,blobs});
    return {owner:activeOwner,projectId,runId,jobId:job.id,promptRef,inputHash:input.json().input_hash};
  }
  function inputFor(f:any,callId=uid(),attemptNo=1):ProbeInput {
    return {owner_user_id:f.owner,project_id:f.projectId,job_id:f.jobId,run_id:f.runId,trace_id:f.runId,logical_call_id:'synthetic-update-call',call_id:callId,attempt_no:attemptNo,model_id:'deepseek-flash',model_config_version:'synthetic-model-config-v1',prompt_snapshot_ref:f.promptRef,result_schema_version:'synthetic-update-result-v1',apiKey:'synthetic-only',messages:[{role:'user',content:'synthetic prompt reference only'}],stream:false,validate:validResult};
  }
  async function runProbe(f:any,lease:any,body:unknown,counter:{value:number}) {
    const input=inputFor(f);
    const journal=new DurableProbeJournal({pool,blobs,lease,validateResult:validResult});
    const observation=await runDeepSeekProbe(input,journal,syntheticFetch(counter,body));
    return {observation,input};
  }
  try {
    const activeJobs=await pool.query("SELECT count(*)::int AS count FROM bb_jobs WHERE state IN ('queued','running') AND run_id IS NOT NULL"); // Run-less parse jobs are never claimed by the run queue.
    assert.equal(activeJobs.rows[0].count,0,'provider reconciliation integration test requires a dedicated database without queued or running jobs');
    // Worker 1 durably records the returned result and then crashes before its processor
    // advances. Worker 2 must load the checkpointed bytes and must not call the supplier.
    const completed=await fixture('restart');
    let firstLease:any=null,completedObservation:ProbeObservation|undefined;
    const providerCalls={value:0};
    await assert.rejects(runOnce(pool,async lease=>{
      firstLease=lease;
      const input=inputFor(completed);
      const journal=new DurableProbeJournal({pool,blobs,lease,validateResult:validResult});
      completedObservation=await runDeepSeekProbe(input,journal,syntheticFetch(providerCalls,completeBody()));
      assert.equal(completedObservation.outcome,'completed');
      throw new Error('SYNTHETIC_CRASH');
    }),/SYNTHETIC_CRASH/);
    assert.equal(providerCalls.value,1,'worker 1 makes one explicit synthetic provider send');
    const firstCounts=await pool.query('SELECT (SELECT count(*) FROM bb_provider_call_observations WHERE attempt_id=$1)::int observations,(SELECT count(*) FROM bb_outbox)::int outbox',[completedObservation!.call_id]);
    const reorderedDuplicate={...completedObservation!,usage:{total_tokens:15,reasoning_tokens:1,output_tokens:4,cached_input_tokens:2,input_tokens:11,status:'measured' as const}};
    const duplicate=await recordProviderCallObservation(pool,blobs,reorderedDuplicate,validResult,{lease:firstLease,source:'provider'});
    assert.equal(duplicate.idempotent,true);
    const duplicateCounts=await pool.query('SELECT (SELECT count(*) FROM bb_provider_call_observations WHERE attempt_id=$1)::int observations,(SELECT count(*) FROM bb_outbox)::int outbox',[completedObservation!.call_id]);
    assert.deepEqual(duplicateCounts.rows[0],firstCounts.rows[0],'duplicate completed observation adds no event/outbox/usage evidence');
    await pool.query("UPDATE bb_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[completed.jobId]);
    let replayed=false;
    assert.equal(await runOnce(pool,async lease=>{
      const replay=await reuseProviderCallOrSend({pool,blobs,lease,logicalCallId:'synthetic-update-call',attemptNo:1,validateResult:validResult,send:async()=>{providerCalls.value++;return {ok:true,unexpectedSend:true};}});
      replayed=replay.reused;
      assert.deepEqual(replay.value,{ok:true});
      assert.equal(replay.resultSha256,completedObservation!.result_sha256);
      await assert.rejects(finish(pool,lease,'succeeded'),/Verified Word artifact required/);
    }),true);
    assert.equal(replayed,true);
    assert.equal(providerCalls.value,1,'restarted worker reuses result without a second external send');
    assert.equal((await send('GET',`/api/v1/runs/${completed.runId}`)).json().state,'failed','synthetic worker cannot publish success without Word delivery');

    // Missing usage stores a checked candidate but leaves the call pending; exact retry is
    // idempotent, conflicting result bytes are retained as a second candidate and block reuse.
    const pending=await fixture('pending-usage');
    const pendingLease=await claim(pool,30);assert.ok(pendingLease);assert.equal(pendingLease.runId,pending.runId);
    let foreignReplaySend=false;
    await assert.rejects(reuseProviderCallOrSend({pool,blobs,lease:{...pendingLease,owner:'synthetic-foreign-owner'},logicalCallId:'synthetic-update-call',attemptNo:1,validateResult:validResult,send:async()=>{foreignReplaySend=true;return null;}}),/active worker lease/);
    assert.equal(foreignReplaySend,false,'foreign owner cannot reuse or send through a victim job lease');
    const pendingCalls={value:0};
    const pendingResult=await runProbe(pending,pendingLease,completeBody('{"ok":true}',null),pendingCalls);
    assert.equal(pendingCalls.value,1);assert.equal(pendingResult.observation.outcome,'pending_reconcile');assert.equal(pendingResult.observation.usage.status,'pending');assert.ok(pendingResult.observation.result_ref);
    assert.equal((await jobSnapshot(pool,pending.owner,pending.runId)).state,'paused');
    const beforeDuplicate=await pool.query('SELECT (SELECT count(*) FROM bb_provider_call_observations WHERE attempt_id=$1)::int observations,(SELECT count(*) FROM bb_outbox)::int outbox',[pendingResult.observation.call_id]);
    const duplicatePending=await reconcilePausedProviderCall(pool,blobs,pendingResult.observation,validResult);
    assert.equal(duplicatePending.idempotent,true);
    const afterDuplicate=await pool.query('SELECT (SELECT count(*) FROM bb_provider_call_observations WHERE attempt_id=$1)::int observations,(SELECT count(*) FROM bb_outbox)::int outbox',[pendingResult.observation.call_id]);
    assert.deepEqual(afterDuplicate.rows[0],beforeDuplicate.rows[0]);
    const secondBytes=Buffer.from('{"ok":true,"candidate":2}');
    const secondRef=await persistProviderResultObject({blobs,intent:pendingResult.input,bytes:secondBytes,resultSchemaVersion:'synthetic-update-result-v1',validate:validResult});
    const wrongProjectRef=await persistProviderResultObject({blobs,intent:{...pendingResult.input,project_id:'synthetic-other-project'},bytes:Buffer.from('{"ok":true,"candidate":3}'),resultSchemaVersion:'synthetic-update-result-v1',validate:validResult});
    const wrongProject={...pendingResult.observation,project_id:'synthetic-other-project',...wrongProjectRef};
    let unauthorizedBlobReads=0;
    const guardedBlobs:PrivateBlobs={put:(key,bytes,mediaType)=>blobs.put(key,bytes,mediaType),get:async key=>{unauthorizedBlobReads++;return blobs.get(key);},getIfExists:async key=>{unauthorizedBlobReads++;return blobs.getIfExists(key);},getIfExistsBounded:async(key,maxBytes)=>{unauthorizedBlobReads++;return blobs.getIfExistsBounded(key,maxBytes);},exists:async key=>{unauthorizedBlobReads++;return blobs.exists(key);},delete:key=>blobs.delete(key)};
    await assert.rejects(reconcilePausedProviderCall(pool,guardedBlobs,wrongProject,validResult),/NOT_FOUND|Resource does not exist/);
    const foreignRef=await persistProviderResultObject({blobs,intent:{...pendingResult.input,owner_user_id:'synthetic-foreign-owner'},bytes:Buffer.from('{"ok":true,"candidate":4}'),resultSchemaVersion:'synthetic-update-result-v1',validate:validResult});
    const foreign={...pendingResult.observation,owner_user_id:'synthetic-foreign-owner',...foreignRef};
    await assert.rejects(reconcilePausedProviderCall(pool,guardedBlobs,foreign,validResult),/NOT_FOUND|Resource does not exist/);
    assert.equal(unauthorizedBlobReads,0,'foreign or wrong-project observations are denied before Blob read');
    let foreignNetworkCalls={value:0};
    const foreignLease={...pendingLease,owner:'synthetic-foreign-owner'};
    const foreignProbeInput={...inputFor({...pending,owner:'synthetic-foreign-owner'}),call_id:uid()};
    const foreignJournal=new DurableProbeJournal({pool,blobs,lease:foreignLease,validateResult:validResult});
    await assert.rejects(runDeepSeekProbe(foreignProbeInput,foreignJournal,syntheticFetch(foreignNetworkCalls,completeBody())),/NOT_FOUND|Resource does not exist/);
    assert.equal(foreignNetworkCalls.value,0,'owner mismatch fails before the synthetic external send');
    const conflictingResult={...pendingResult.observation,outcome:'completed' as const,error_code:null,finish_reason:'stop',usage:measuredUsage,...secondRef};
    const conflict=await reconcilePausedProviderCall(pool,blobs,conflictingResult,validResult);
    assert.equal(conflict.attempt_status,'pending_reconcile');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_provider_result_refs WHERE attempt_id=$1',[pendingResult.observation.call_id])).rows[0].n,2,'both immutable result candidates are retained');
    assert.equal((await pool.query('SELECT status FROM bb_model_call_attempts WHERE id=$1',[pendingResult.observation.call_id])).rows[0].status,'pending_reconcile');
    let pendingResend=false;
    await assert.rejects(reuseProviderCallOrSend({pool,blobs,lease:pendingLease,logicalCallId:'synthetic-update-call',attemptNo:1,validateResult:validResult,send:async()=>{pendingResend=true;return null;}}),/no reusable checkpoint|pending|active worker lease/);
    assert.equal(pendingResend,false);
    activeOwner=pending.owner;
    const pendingResume=await send('POST',`/api/v1/runs/${pending.runId}/resume`,{reason:'synthetic'});
    assert.equal(pendingResume.statusCode,409);assert.equal(pendingResume.json().code,'CAPABILITY_NOT_READY');

    // A syntactically completed supplier response without a valid model result is durable
    // attempt evidence only. It cannot produce a result ref, checkpoint, resume or resend.
    const invalid=await fixture('invalid-result');
    const invalidLease=await claim(pool,30);assert.ok(invalidLease);assert.equal(invalidLease.runId,invalid.runId);
    const invalidCalls={value:0};
    const invalidBody=completeBody('{broken json');
    const invalidProbe=await runProbe(invalid,invalidLease,invalidBody,invalidCalls);
    assert.equal(invalidCalls.value,1);assert.equal(invalidProbe.observation.outcome,'pending_reconcile');assert.equal(invalidProbe.observation.error_code,'INVALID_MODEL_JSON');assert.equal(invalidProbe.observation.result_ref,null);
    assert.equal((await jobSnapshot(pool,invalid.owner,invalid.runId)).state,'paused');
    assert.equal((await send('POST',`/api/v1/runs/${invalid.runId}/resume`,{reason:'synthetic'})).json().code,'CAPABILITY_NOT_READY');

    // A new framework usage report that disagrees with the provider remains #79 conflict;
    // after lease recovery the queue pauses again and the worker helper cannot send.
    const conflicted=await fixture('usage-conflict');
    const conflictLease=await claim(pool,30);assert.ok(conflictLease);assert.equal(conflictLease.runId,conflicted.runId);
    const measuredCalls={value:0};
    const measuredProbe=await runProbe(conflicted,conflictLease,completeBody(),measuredCalls);
    assert.equal(measuredProbe.observation.outcome,'completed');
    await observeUsage(pool,{owner:conflicted.owner,attemptId:measuredProbe.observation.call_id,source:'framework',sourceEventId:'synthetic-conflicting-framework-report',status:'measured',inputTokens:99,outputTokens:1});
    const totals=await usageTotals(pool,conflicted.owner,conflicted.jobId,'synthetic-operator');
    assert.equal(totals.conflicted_attempts,1);assert.equal(totals.input_tokens,null);
    await pool.query("UPDATE bb_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[conflicted.jobId]);
    assert.equal(await claim(pool),null);
    assert.equal((await jobSnapshot(pool,conflicted.owner,conflicted.runId)).state,'paused');
    let conflictResend=false;
    await assert.rejects(reuseProviderCallOrSend({pool,blobs,lease:conflictLease,logicalCallId:'synthetic-update-call',attemptNo:1,validateResult:validResult,send:async()=>{conflictResend=true;return null;}}),/not reconciled|pending|active worker lease/);
    assert.equal(conflictResend,false);
    assert.equal((await send('POST',`/api/v1/runs/${conflicted.runId}/resume`,{reason:'synthetic'})).json().code,'CAPABILITY_NOT_READY');

    // A DB/outbox failure cannot publish the measured result, erase the original attempt,
    // or mark the run successful. The same observation can be retried after the sink recovers.
    const rollback=await fixture('outbox-rollback');
    const rollbackLease=await claim(pool,30);assert.ok(rollbackLease);assert.equal(rollbackLease.runId,rollback.runId);
    const rollbackCalls={value:0};
    const rollbackProbe=await runProbe(rollback,rollbackLease,completeBody('{"ok":true}',null),rollbackCalls);
    assert.equal((await jobSnapshot(pool,rollback.owner,rollback.runId)).state,'paused');
    const retryObservation={...rollbackProbe.observation,outcome:'completed' as const,error_code:null,finish_reason:'stop',usage:measuredUsage};
    const beforeFailure=await pool.query('SELECT (SELECT count(*) FROM bb_provider_call_observations WHERE attempt_id=$1)::int observations,(SELECT count(*) FROM bb_usage_observations WHERE attempt_id=$1)::int usage_rows,(SELECT count(*) FROM bb_outbox)::int outbox',[retryObservation.call_id]);
    await pool.query("CREATE FUNCTION bb_test_fail_provider_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic provider outbox failure'; END $$");
    await pool.query('CREATE TRIGGER bb_test_fail_provider_outbox BEFORE INSERT ON bb_outbox FOR EACH ROW EXECUTE FUNCTION bb_test_fail_provider_outbox()');
    try { await assert.rejects(reconcilePausedProviderCall(pool,blobs,retryObservation,validResult),/synthetic provider outbox failure/); }
    finally { await pool.query('DROP TRIGGER IF EXISTS bb_test_fail_provider_outbox ON bb_outbox');await pool.query('DROP FUNCTION IF EXISTS bb_test_fail_provider_outbox()'); }
    const afterFailure=await pool.query('SELECT (SELECT count(*) FROM bb_provider_call_observations WHERE attempt_id=$1)::int observations,(SELECT count(*) FROM bb_usage_observations WHERE attempt_id=$1)::int usage_rows,(SELECT count(*) FROM bb_outbox)::int outbox',[retryObservation.call_id]);
    assert.deepEqual(afterFailure.rows[0],beforeFailure.rows[0]);
    assert.equal((await pool.query('SELECT status FROM bb_model_call_attempts WHERE id=$1',[retryObservation.call_id])).rows[0].status,'pending_reconcile');
    assert.equal((await jobSnapshot(pool,rollback.owner,rollback.runId)).state,'paused');
    assert.equal((await send('GET',`/api/v1/runs/${rollback.runId}`)).json().state,'paused');
    const reconciled=await reconcilePausedProviderCall(pool,blobs,retryObservation,validResult);
    assert.equal(reconciled.attempt_status,'completed');
    const rollbackResume=await send('POST',`/api/v1/runs/${rollback.runId}/resume`,{reason:'synthetic'});
    assert.equal(rollbackResume.statusCode,200);
    let rollbackResumed=false;
    assert.equal(await runOnce(pool,async lease=>{
      const replay=await reuseProviderCallOrSend({pool,blobs,lease,logicalCallId:'synthetic-update-call',attemptNo:1,validateResult:validResult,send:async()=>{rollbackCalls.value++;return null;}});
      assert.equal(replay.reused,true);rollbackResumed=true;
    }),true);
    assert.equal(rollbackResumed,true);assert.equal(rollbackCalls.value,1,'manual reconciliation and restart never repeat the completed send');

    // Only an explicit confirmed_not_sent permits retry, and it must allocate attempt 2.
    const notSent=await fixture('not-sent');
    const notSentLease=await claim(pool,30);assert.ok(notSentLease);assert.equal(notSentLease.runId,notSent.runId);
    const abortController=new AbortController();
    const durable=new DurableProbeJournal({pool,blobs,lease:notSentLease,validateResult:validResult});
    const abortingJournal:ProbeJournal={recordIntent:async intent=>{await durable.recordIntent(intent);abortController.abort();},storeResult:(intent,bytes,schema)=>durable.storeResult(intent,bytes,schema),recordObservation:observation=>durable.recordObservation(observation)};
    const noSend={value:0};
    const notSentObservation=await runDeepSeekProbe({...inputFor(notSent),signal:abortController.signal},abortingJournal,syntheticFetch(noSend,completeBody()));
    assert.equal(notSentObservation.outcome,'confirmed_not_sent');assert.equal(noSend.value,0);
    assert.equal((await jobSnapshot(pool,notSent.owner,notSent.runId)).state,'paused');
    await assert.rejects(reconcilePausedProviderCall(pool,blobs,{...notSentObservation,usage:measuredUsage},validResult),/Not-sent observation cannot have supplier response or usage evidence/);
    const notSentResume=await send('POST',`/api/v1/runs/${notSent.runId}/resume`,{reason:'synthetic'});
    assert.equal(notSentResume.statusCode,200);
    const notSentRetryLease=await claim(pool,30);assert.ok(notSentRetryLease);assert.equal(notSentRetryLease.runId,notSent.runId);
    const secondCallId=uid();
    assert.equal(await recordPotentialCall(pool,notSentRetryLease,'synthetic-update-call',2,{callId:secondCallId,modelId:'deepseek-flash',promptSnapshotId:notSent.promptRef}),secondCallId);
    assert.equal((await pool.query('SELECT array_agg(attempt_no ORDER BY attempt_no) attempts FROM bb_model_call_attempts WHERE job_id=$1 AND logical_call_id=$2',[notSent.jobId,'synthetic-update-call'])).rows[0].attempts.join(','),'1,2');

    // A definitively failed supplier response with measured usage fails the run; it is never
    // automatically retried. Unknown usage would instead remain paused, as above.
    const failed=await fixture('supplier-failed');
    const failedLease=await claim(pool,30);assert.ok(failedLease);assert.equal(failedLease.runId,failed.runId);
    const failedCallId=uid();
    await recordPotentialCall(pool,failedLease,'synthetic-update-call',1,{callId:failedCallId,modelId:'deepseek-flash',promptSnapshotId:failed.promptRef});
    const failedObservation:ProbeObservation={...inputFor(failed,failedCallId),provider_request_id:'synthetic-request-failed',finish_reason:null,outcome:'failed',usage:measuredUsage,error_code:'PROVIDER_HTTP_503',result_ref:null,result_sha256:null,result_schema_version:null,result_byte_size:null};
    const failedResult=await recordProviderCallObservation(pool,blobs,failedObservation,validResult,{lease:failedLease,source:'provider'});
    assert.equal(failedResult.attempt_status,'failed');
    assert.equal((await send('GET',`/api/v1/runs/${failed.runId}`)).json().state,'failed');
    assert.equal((await pool.query('SELECT status FROM bb_model_call_attempts WHERE id=$1',[failedCallId])).rows[0].status,'failed');
    assert.equal((await send('POST',`/api/v1/runs/${failed.runId}/resume`,{reason:'synthetic'})).json().code,'ALREADY_TERMINAL');

    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_provider_result_refs')).rows[0].n>0,true);

    // The installed worker seam can publish only an explicit candidate after the shared
    // Word validator and Blob readback succeed; the fixture remains synthetic.
    const word=await fixture('word-delivery');
    const candidate=makeWorkerDocxFixture();
    assert.equal(await runOnce(pool,async()=>({kind:'word_candidate',bytes:candidate}),30,blobs),true);
    const deliveredRun=(await send('GET',`/api/v1/runs/${word.runId}`)).json();
    assert.equal(deliveredRun.state,'succeeded');assert.ok(deliveredRun.artifact_id);
    const artifactMeta=await send('GET',`/api/v1/artifacts/${deliveredRun.artifact_id}`);
    assert.equal(artifactMeta.statusCode,200,artifactMeta.body);
    const artifactDownload=await send('GET',artifactMeta.json().download_url);
    assert.equal(artifactDownload.statusCode,200,artifactDownload.body);
    assert.deepEqual(artifactDownload.rawPayload,candidate,'the successful worker run has an owned fetchable Word artifact');
  } finally {
    await pool.query('DROP TRIGGER IF EXISTS bb_test_fail_provider_outbox ON bb_outbox');
    await pool.query('DROP FUNCTION IF EXISTS bb_test_fail_provider_outbox()');
    await app.close();
    await pool.end();
  }
});
