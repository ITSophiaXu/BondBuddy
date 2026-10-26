import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { isolatedTestDatabase } from './test-database.js';
import { createServer } from './server.js';
import { checkpoint, claim, finish, jobSnapshot, pauseRun, promoteWordArtifact, reconcilePausedCall, recordPotentialCall } from './queue.js';
import { azureBlobs, transaction, type PrivateBlobs } from './data.js';
import { makeSyntheticDocxFixture } from './docx-fixtures.js';
import { Ajv } from 'ajv';
import { schemas } from '@bondbuddy/contracts';

const connection=process.env.BB_TEST_DATABASE_URL;
const isolatedConnection=await isolatedTestDatabase();
const blobConnection=process.env.BB_TEST_AZURITE_CONNECTION_STRING;
test('unchanged issuer source gate rejects repeated resumes without queue churn; clearable pauses resume', {skip:!connection},async()=>{
  const database=await isolatedTestDatabase('BB_TEST_DATABASE_URL','issuer-resume-gate');
  const pool=new Pool({connectionString:database});
  let owner=`resume-owner-${randomUUID()}`;
  const origin='http://bondbuddy.test';
  const app=createServer({pool,allowedOrigin:origin,principal:async()=>({userId:owner,csrfVerified:true}),enableSyntheticQueue:true});
  const send=(method:string,url:string,payload?:unknown)=>app.inject({method:method as any,url,headers:{origin},payload:payload as any});
  try{
    const project=(await send('POST','/api/v1/projects',{name:'Synthetic resume gate',kind:'update',issuer_name:null,market:'sse',offering:'private'})).json().project_id;
    const material=randomUUID(),upload=randomUUID(),sha='a'.repeat(64);
    await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
      VALUES($1,$2,$3,'synthetic.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',10,$4,'historical',$5,now()+interval '1 hour','completed')`,
    [upload,owner,project,sha,`synthetic/${upload}`]);
    await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES($1,1,$2,$3,$4,'historical','synthetic.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document',10,$5,$6,'parsed')`,
    [material,owner,project,upload,sha,`synthetic/${material}`]);
    const input=(await send('POST',`/api/v1/projects/${project}/input-revisions`,{draft_revision:1,material_versions:[{material_id:material,material_version:1}],requirement_message_ids:[]})).json();
    const manifest=(await pool.query('SELECT manifest FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=$3',[owner,project,input.input_revision])).rows[0].manifest;
    assert.equal(manifest.issuer_identity.reason,'issuer_identity_source_missing_unreviewed_or_conflicting');
    const request={execution_request_id:randomUUID(),project_id:project,input_revision:input.input_revision,input_hash:input.input_hash,
      task_kind:'update',input_manifest_ref:'synthetic',storage_origin:'cloud',workspace_id:'synthetic'};
    const submitted=await send('POST','/api/v1/runs/execute',request);
    assert.equal(submitted.statusCode,202,submitted.body);
    const id=submitted.json().run_id;
    const lease=await claim(pool,30);assert.ok(lease);assert.equal(lease.runId,id);
    await pauseRun(pool,lease,'capability_not_ready','issuer_identity_source_missing_unreviewed_or_conflicting');
    const before=await pool.query('SELECT event_cursor FROM bb_runs WHERE id=$1',[id]);
    for(let click=0;click<5;click++){
      const response=await send('POST',`/api/v1/runs/${id}/resume`,{reason:'synthetic'});
      assert.equal(response.statusCode,409,response.body);
      assert.equal(response.json().code,'CAPABILITY_NOT_READY');
      assert.match(response.json().message,/issuer identity source/i);
    }
    assert.equal((await pool.query('SELECT event_cursor FROM bb_runs WHERE id=$1',[id])).rows[0].event_cursor,before.rows[0].event_cursor);
    assert.deepEqual((await pool.query('SELECT state,stage,attempts FROM bb_jobs WHERE run_id=$1',[id])).rows[0],
      {state:'paused',stage:'capability_not_ready',attempts:1});
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE job_id=$1',[lease.jobId])).rows[0].n,0);
    assert.equal(await claim(pool),null);
    assert.equal((await send('POST','/api/v1/runs/execute',request)).json().run_id,id);
    owner=`foreign-${randomUUID()}`;
    assert.equal((await send('POST',`/api/v1/runs/${id}/resume`,{reason:'synthetic'})).statusCode,404);
    owner=(await pool.query('SELECT owner_user_id FROM bb_runs WHERE id=$1',[id])).rows[0].owner_user_id;
    // Seed a legacy inconsistent origin at INSERT. Established run origins are
    // immutable; the resume guard must still refuse pre-existing corrupt rows.
    const mismatchedId=randomUUID(),mismatchedJob=randomUUID();
    await transaction(pool,async client=>{
      await client.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage,event_cursor)
        SELECT $2,owner_user_id,project_id,input_revision,$3,$4,task_kind,request_hash,state,stage,event_cursor FROM bb_runs WHERE id=$1`,
        [id,mismatchedId,'f'.repeat(64),randomUUID()]);
      await client.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage,attempts)
        SELECT $2,owner_user_id,$3,job_type,subtype,state,stage,attempts FROM bb_jobs WHERE id=$1`,[lease.jobId,mismatchedJob,mismatchedId]);
      const history=(await client.query('SELECT * FROM bb_run_events WHERE run_id=$1 ORDER BY seq',[id])).rows;
      for(const saved of history){
        const eventId=randomUUID();
        await client.query(`INSERT INTO bb_run_events(id,owner_user_id,run_id,seq,trace_id,type,state,stage,payload)
          VALUES($1,$2,$3,$4,$3,$5,$6,$7,$8)`,[eventId,owner,mismatchedId,saved.seq,saved.type,saved.state,saved.stage,saved.payload]);
        await client.query(`INSERT INTO bb_outbox(id,owner_user_id,aggregate_type,aggregate_id,event_type,payload)
          VALUES($1,$2,'run',$3,$4,$5)`,[randomUUID(),owner,mismatchedId,saved.type,{...saved.payload,run_id:mismatchedId,event_id:eventId,seq:saved.seq,state:saved.state,stage:saved.stage}]);
      }
    });
    const mismatchCursor=(await pool.query('SELECT event_cursor FROM bb_runs WHERE id=$1',[mismatchedId])).rows[0].event_cursor;
    const invalid=await send('POST',`/api/v1/runs/${mismatchedId}/resume`,{reason:'synthetic'});
    assert.equal(invalid.statusCode,409,invalid.body);
    assert.equal(invalid.json().code,'INPUT_REVISION_CONFLICT');
    assert.equal((await pool.query('SELECT event_cursor FROM bb_runs WHERE id=$1',[mismatchedId])).rows[0].event_cursor,mismatchCursor);
    assert.deepEqual((await pool.query('SELECT state,stage,attempts FROM bb_jobs WHERE run_id=$1',[mismatchedId])).rows[0],
      {state:'paused',stage:'capability_not_ready',attempts:1});
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts WHERE job_id=$1',[mismatchedJob])).rows[0].n,0);
    const clearable=await send('POST','/api/v1/runs/execute',{...request,execution_request_id:randomUUID()});
    assert.equal(clearable.statusCode,202,clearable.body);
    const clearableId=clearable.json().run_id;
    const clearableLease=await claim(pool,30);assert.ok(clearableLease);assert.equal(clearableLease.runId,clearableId);
    await pauseRun(pool,clearableLease,'awaiting_materials','material_parse_pending');
    const cleared=await send('POST',`/api/v1/runs/${clearableId}/resume`,{reason:'synthetic'});
    assert.equal(cleared.statusCode,200,cleared.body);
    assert.equal((await claim(pool,30))?.runId,clearableId);
  }finally{await app.close();await pool.end();}
});
test('synthetic PostgreSQL queue: idempotency, rollback, restart, reconciliation, cancellation and owner cursor', {skip:!connection||!blobConnection},async()=>{
  const pool=new Pool({connectionString:isolatedConnection});
  let owner='synthetic-queue-a';
  const blobs=azureBlobs(blobConnection!);
  const settings={pool,blobs,allowedOrigin:'http://bondbuddy.test',principal:async()=>({userId:owner,csrfVerified:true}),enableSyntheticQueue:true};
  const app=createServer(settings);
  const send=(method:string,url:string,payload?:unknown)=>app.inject({method:method as any,url,headers:{origin:'http://bondbuddy.test'},payload:payload as any});
  try {
    const p=await send('POST','/api/v1/projects',{name:'Synthetic queue',kind:'update',issuer_name:null,market:null,offering:null});
    assert.equal(p.statusCode,201,p.body);
    const projectId=p.json().project_id;
    const input=await send('POST',`/api/v1/projects/${projectId}/input-revisions`,{draft_revision:1,material_versions:[],requirement_message_ids:[]});
    assert.equal(input.statusCode,201,input.body);
    const request={execution_request_id:'synthetic-queue-idempotency',project_id:projectId,input_revision:1,input_hash:input.json().input_hash,task_kind:'update',input_manifest_ref:'synthetic-manifest',storage_origin:'cloud',workspace_id:'synthetic-workspace'};
    const responses=await Promise.all(Array.from({length:10},()=>send('POST','/api/v1/runs/execute',request)));
    assert.ok(responses.every(r=>r.statusCode===202),responses.map(r=>r.body).join('\n'));
    const id=responses[0].json().run_id;
    assert.ok(responses.every(r=>r.json().run_id===id));
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_jobs WHERE run_id=$1',[id])).rows[0].n,1);
    const collision=await send('POST','/api/v1/runs/execute',{...request,input_manifest_ref:'different'});
    assert.equal(collision.statusCode,409);assert.equal(collision.json().code,'IDEMPOTENCY_CONFLICT');
    owner='synthetic-queue-b';assert.equal((await send('GET',`/api/v1/runs/${id}`)).statusCode,404);assert.equal((await send('GET',`/api/v1/runs/${id}/events`)).statusCode,404);
    owner='synthetic-queue-a';
    let lease=await claim(pool,1);assert.ok(lease);assert.equal(lease.runId,id);
    await checkpoint(pool,lease,'parsed',{phase:'parsed',page:2});
    assert.equal((await jobSnapshot(pool,owner,id)).checkpoint.phase,'parsed');
    await pool.query("UPDATE bb_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[lease.jobId]);
    const restarted=await claim(pool,30);assert.ok(restarted);assert.equal(restarted.runId,id);assert.equal(restarted.checkpoint.phase,'parsed');
    await assert.rejects(checkpoint(pool,lease,'stale',{}),/Lease is no longer active/);
    await recordPotentialCall(pool,restarted,'synthetic-call',1);
    await pool.query("UPDATE bb_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[restarted.jobId]);
    assert.equal(await claim(pool),null,'unknown provider call pauses instead of resending');
    assert.equal((await jobSnapshot(pool,owner,id)).state,'paused');
    const resume=await send('POST',`/api/v1/runs/${id}/resume`,{reason:'synthetic'});
    assert.equal(resume.statusCode,409);assert.equal(resume.json().code,'CAPABILITY_NOT_READY');
    await assert.rejects(reconcilePausedCall(pool,owner,id,'synthetic-call',1,'completed','synthetic-provider-request'),/durable result/);
    assert.equal((await jobSnapshot(pool,owner,id)).state,'paused');
    assert.equal((await send('POST',`/api/v1/runs/${id}/resume`,{reason:'synthetic'})).json().code,'CAPABILITY_NOT_READY');
    assert.equal((await pool.query("SELECT status FROM bb_model_call_attempts WHERE logical_call_id='synthetic-call'")).rows[0].status,'pending_reconcile');
    await pool.query("UPDATE bb_model_call_attempts SET status='completed' WHERE logical_call_id='synthetic-call'");
    assert.equal((await send('POST',`/api/v1/runs/${id}/resume`,{reason:'synthetic'})).json().code,'CAPABILITY_NOT_READY','even a recorded completion cannot replay without a reusable result');
    await pool.query("UPDATE bb_model_call_attempts SET status='pending_reconcile' WHERE logical_call_id='synthetic-call'");
    await reconcilePausedCall(pool,owner,id,'synthetic-call',1,'confirmed_not_sent');
    assert.equal((await send('POST',`/api/v1/runs/${id}/resume`,{reason:'synthetic'})).statusCode,200);
    const third=await claim(pool,30);assert.ok(third);assert.equal(third.runId,id);
    const cancel=await send('POST',`/api/v1/runs/${id}/cancel`,{reason:'synthetic'});assert.equal(cancel.statusCode,200,cancel.body);
    assert.equal(cancel.json().state,'cancelled');
    const actions=(await pool.query("SELECT operation_kind FROM bb_operations WHERE owner_user_id=$1 AND run_id=$2 AND operation_kind IN ('run_resume','run_cancel')",[owner,id])).rows.map((row:any)=>row.operation_kind);
    assert.ok(actions.includes('run_resume')&&actions.includes('run_cancel'),'committed run actions are searchable');
    await assert.rejects(finish(pool,restarted,'failed'),/Lease is no longer active/);
    assert.equal((await send('POST',`/api/v1/runs/${id}/resume`,{reason:'synthetic'})).json().code,'ALREADY_TERMINAL');
    const fresh=createServer(settings);
    try {const restored=await fresh.inject(`/api/v1/runs/${id}`);assert.equal(restored.json().state,'cancelled');}
    finally {await fresh.close();}
    const events=(await send('GET',`/api/v1/runs/${id}/events`)).json().items;
    assert.deepEqual(events.map((e:any)=>e.seq),events.map((_:any,i:number)=>i+1));
    assert.ok(events.every((e:any)=>e.trace_id===id));
    assert.ok(events.every((e:any)=>!Object.hasOwn(e.payload,'channel')),'polling DTO excludes the worker-only channel discriminator');
    assert.ok(events.every((e:any)=>new Ajv().validate(schemas.RunEvent,e)), 'polling events conform to the shared RunEvent DTO');
    assert.equal(events.at(-1).state,'cancelled');
    const stream=await send('GET',`/api/v1/runs/${id}/stream`);
    assert.equal(stream.statusCode,200,stream.body);
    const streamData=stream.body.split('\n').filter((line:string)=>line.startsWith('data: '))
      .map((line:string)=>JSON.parse(line.slice('data: '.length)));
    const streamedEvents=streamData.filter((item:any)=>item.run_id===id&&Number.isSafeInteger(item.seq));
    assert.deepEqual(streamedEvents.map((event:any)=>event.seq),events.map((event:any)=>event.seq),
      'SSE streams all persisted event types in cursor order, including run.progress');
    assert.ok(streamedEvents.every((event:any)=>!Object.hasOwn(event.payload,'channel')),'SSE DTO excludes the worker-only channel discriminator');
    assert.ok(streamedEvents.every((event:any)=>new Ajv().validate(schemas.RunEvent,event)), 'SSE events conform to the shared RunEvent DTO');
    assert.equal(streamData.find((item:any)=>item.run_id===id)?.channel,'production','snapshot retains the separate RunResponse channel field');
    const outbox=await pool.query("SELECT count(*)::int n FROM bb_outbox WHERE aggregate_type='run' AND aggregate_id=$1",[id]);
    assert.equal(outbox.rows[0].n,events.length);
    await pool.query("CREATE FUNCTION bb_queue_fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='run.state_changed' THEN RAISE EXCEPTION 'synthetic rollback'; END IF; RETURN NEW; END $$");
    await pool.query('CREATE TRIGGER bb_queue_fail_outbox BEFORE INSERT ON bb_outbox FOR EACH ROW EXECUTE FUNCTION bb_queue_fail_outbox()');
    const bad=await send('POST','/api/v1/runs/execute',{...request,execution_request_id:'synthetic-rollback'});assert.equal(bad.statusCode,500);
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_runs WHERE execution_request_id='synthetic-rollback'")).rows[0].n,0);
    await pool.query('DROP TRIGGER bb_queue_fail_outbox ON bb_outbox');await pool.query('DROP FUNCTION bb_queue_fail_outbox()');
    const retried=await send('POST','/api/v1/runs/execute',{...request,execution_request_id:'synthetic-rollback'});assert.equal(retried.statusCode,202);
    lease=await claim(pool,30);assert.ok(lease);
    await assert.rejects(finish(pool,lease,'succeeded'),/Verified Word artifact required/);
    let invalidBlobPuts=0;
    const invalidCandidateBlobs:PrivateBlobs={...blobs,put:async(key,bytes,mediaType)=>{invalidBlobPuts++;await blobs.put(key,bytes,mediaType);}};
    const rejected=await promoteWordArtifact(pool,lease,Buffer.from('not a DOCX ZIP package'),invalidCandidateBlobs);
    assert.equal(rejected.status,'rejected');assert.equal(rejected.failureCode,'WORD_QUALITY_REJECTED');assert.equal(rejected.deliveryCode,'not_attempted');
    assert.equal(invalidBlobPuts,0,'invalid DOCX bytes are never written to private Blob storage');
    assert.equal(await blobs.getIfExists(rejected.objectKey),null);
    assert.equal((await pool.query('SELECT quality_status,delivery_status FROM bb_artifact_versions WHERE id=$1',[rejected.artifactId])).rows[0].quality_status,'failed');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_word_delivery_evidence WHERE owner_user_id=$1 AND run_id=$2 AND artifact_id=$3',[owner,lease.runId,rejected.artifactId])).rows[0].n,1,'quality rejection evidence is durable and owner/run bound');
    await assert.rejects(pool.query("UPDATE bb_artifact_versions SET quality_status='passed',delivery_status='available' WHERE id=$1 AND version=1",[rejected.artifactId]),(error:any)=>error.code==='23514','database refuses availability without passed readback evidence');
    await assert.rejects(pool.query("UPDATE bb_runs SET state='succeeded',artifact_id=$2,artifact_version=1 WHERE id=$1",[lease.runId,rejected.artifactId]),(error:any)=>error.code==='23514','database refuses success without a matching verified Word artifact');
    await assert.rejects(finish(pool,lease,'succeeded',{artifactId:rejected.artifactId,artifactVersion:rejected.artifactVersion,blobs}),/Passed Word artifact unavailable/);
    assert.equal((await send('GET',`/api/v1/runs/${lease.runId}`)).json().state,'running');
    await finish(pool,lease,'failed',{errorCode:'WORD_QUALITY_REJECTED'});
    assert.equal((await send('GET',`/api/v1/runs/${lease.runId}`)).json().state,'failed');

    const wordCandidate=makeSyntheticDocxFixture();
    const wordRun=await send('POST','/api/v1/runs/execute',{...request,execution_request_id:'synthetic-word-success'});assert.equal(wordRun.statusCode,202,wordRun.body);
    const wordLease=await claim(pool,30);assert.ok(wordLease);assert.equal(wordLease.runId,wordRun.json().run_id);
    const firstPromotion=await promoteWordArtifact(pool,wordLease,wordCandidate,blobs);
    assert.equal(firstPromotion.status,'available');assert.equal(firstPromotion.deliveryCode,'readback_verified');
    assert.equal((await send('GET',`/api/v1/artifacts/${firstPromotion.artifactId}`)).statusCode,404,'verified bytes stay private until the whole run succeeds');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_artifact_download_grants WHERE artifact_id=$1',[firstPromotion.artifactId])).rows[0].n,0,'an unfinished run receives no download grant');
    const firstEvidenceCount=(await pool.query('SELECT count(*)::int n FROM bb_word_delivery_evidence WHERE owner_user_id=$1 AND run_id=$2',[owner,wordLease.runId])).rows[0].n;
    assert.equal(firstEvidenceCount,1);
    const duplicatePromotion=await promoteWordArtifact(pool,wordLease,wordCandidate,blobs);
    assert.equal(duplicatePromotion.artifactId,firstPromotion.artifactId);assert.equal(duplicatePromotion.evidenceId,firstPromotion.evidenceId);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_word_delivery_evidence WHERE owner_user_id=$1 AND run_id=$2',[owner,wordLease.runId])).rows[0].n,firstEvidenceCount,'duplicate promotion is idempotent');
    await pool.query("UPDATE bb_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[wordLease.jobId]);
    const wordRestart=await claim(pool,30);assert.ok(wordRestart);assert.equal(wordRestart.runId,wordLease.runId);assert.deepEqual(wordRestart.checkpoint,wordLease.checkpoint);
    const restartPromotion=await promoteWordArtifact(pool,wordRestart,wordCandidate,blobs);
    assert.equal(restartPromotion.evidenceId,firstPromotion.evidenceId,'evidence survives worker lease recovery');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_word_delivery_evidence WHERE owner_user_id=$1 AND run_id=$2',[owner,wordLease.runId])).rows[0].n,firstEvidenceCount);
    await assert.rejects(finish(pool,{...wordRestart,owner:'synthetic-queue-b'},'succeeded',{artifactId:firstPromotion.artifactId,artifactVersion:firstPromotion.artifactVersion,blobs}),/Passed Word artifact unavailable/);
    const wordSuccess=await finish(pool,wordRestart,'succeeded',{artifactId:firstPromotion.artifactId,artifactVersion:firstPromotion.artifactVersion,blobs});
    assert.equal(wordSuccess.state,'succeeded');assert.equal(wordSuccess.artifact_id,firstPromotion.artifactId);
    let boundedArtifactReads=0;
    const boundedOnlyBlobs:PrivateBlobs={...blobs,get:async()=>{throw new Error('Word artifact retrieval must use a bounded Blob read');},getIfExistsBounded:async(key,maxBytes)=>{boundedArtifactReads++;return blobs.getIfExistsBounded(key,maxBytes);}};
    const deliveryApp=createServer({...settings,blobs:boundedOnlyBlobs});
    const deliverySend=(url:string)=>deliveryApp.inject({method:'GET',url,headers:{origin:'http://bondbuddy.test'}});
    let meta:any,download:any;
    try{
      meta=await deliverySend(`/api/v1/artifacts/${firstPromotion.artifactId}`);assert.equal(meta.statusCode,200,meta.body);
      download=await deliverySend(meta.json().download_url);assert.equal(download.statusCode,200,download.body);
    }finally{await deliveryApp.close();}
    assert.equal(boundedArtifactReads,2,'metadata and download use evidence-sized Blob reads');
    assert.deepEqual(download.rawPayload,wordCandidate,'owned artifact download returns the hash-verified Word bytes');
    const deliveryKinds=(await pool.query("SELECT operation_kind FROM bb_operations WHERE owner_user_id=$1 AND run_id=$2 AND operation_kind IN ('artifact_download_grant','artifact_download')",[owner,wordRun.json().run_id])).rows.map((row:any)=>row.operation_kind);
    assert.ok(deliveryKinds.includes('artifact_download_grant')&&deliveryKinds.includes('artifact_download'),'grant and verified download are searchable');
    owner='synthetic-queue-b';assert.equal((await send('GET',`/api/v1/artifacts/${firstPromotion.artifactId}`)).statusCode,404);assert.equal((await send('GET',meta.json().download_url)).statusCode,404);
    owner='synthetic-queue-a';

    // Exercise integrity failures only after creating a genuinely downloadable result.
    // Use equal-length corruption so the hash check, not just the byte count, is covered.
    const corruptedWord=Buffer.from(wordCandidate);corruptedWord[corruptedWord.length-1]^=1;
    await blobs.put(firstPromotion.objectKey,corruptedWord,'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    const grantsBeforeCorruption=(await pool.query('SELECT count(*)::int n FROM bb_artifact_download_grants WHERE artifact_id=$1',[firstPromotion.artifactId])).rows[0].n;
    const corruptMeta=await send('GET',`/api/v1/artifacts/${firstPromotion.artifactId}`);
    assert.equal(corruptMeta.statusCode,503,'a changed Blob from a successful run cannot receive a fresh download grant');
    assert.equal(corruptMeta.json().code,'DATA_UNAVAILABLE');
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_artifact_download_grants WHERE artifact_id=$1',[firstPromotion.artifactId])).rows[0].n,grantsBeforeCorruption,'integrity failure issues no additional grants');
    const corruptDownload=await send('GET',meta.json().download_url);
    assert.equal(corruptDownload.statusCode,503,'an existing grant cannot bypass the fresh integrity check');
    assert.equal(corruptDownload.json().code,'DATA_UNAVAILABLE');
    owner='synthetic-queue-b';
    assert.equal((await send('GET',`/api/v1/artifacts/${firstPromotion.artifactId}`)).statusCode,404,'integrity failures disclose nothing to another owner');
    assert.equal((await send('GET',meta.json().download_url)).statusCode,404);
    owner='synthetic-queue-a';
    await blobs.put(firstPromotion.objectKey,wordCandidate,'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.deepEqual((await send('GET',meta.json().download_url)).rawPayload,wordCandidate,'restoring the verified bytes restores the existing download without a new run');

    const missingReadbackRun=await send('POST','/api/v1/runs/execute',{...request,execution_request_id:'synthetic-word-missing-readback'});assert.equal(missingReadbackRun.statusCode,202,missingReadbackRun.body);
    const missingReadbackLease=await claim(pool,30);assert.ok(missingReadbackLease);assert.equal(missingReadbackLease.runId,missingReadbackRun.json().run_id);
    const missingReadbackBlobs:PrivateBlobs={...blobs,getIfExistsBounded:async()=>null};
    const missingReadback=await promoteWordArtifact(pool,missingReadbackLease,wordCandidate,missingReadbackBlobs);
    assert.equal(missingReadback.status,'unavailable');assert.equal(missingReadback.deliveryCode,'blob_missing');
    await assert.rejects(finish(pool,missingReadbackLease,'succeeded',{artifactId:missingReadback.artifactId,artifactVersion:1,blobs}),/Passed Word artifact unavailable/);
    assert.equal((await pool.query("SELECT delivery_status FROM bb_artifact_versions WHERE id=$1",[missingReadback.artifactId])).rows[0].delivery_status,'revoked');
    await finish(pool,missingReadbackLease,'failed',{errorCode:'WORD_DELIVERY_UNAVAILABLE'});
    await blobs.delete(missingReadback.objectKey);

    const mismatchedReadbackRun=await send('POST','/api/v1/runs/execute',{...request,execution_request_id:'synthetic-word-mismatched-readback'});assert.equal(mismatchedReadbackRun.statusCode,202,mismatchedReadbackRun.body);
    const mismatchedReadbackLease=await claim(pool,30);assert.ok(mismatchedReadbackLease);assert.equal(mismatchedReadbackLease.runId,mismatchedReadbackRun.json().run_id);
    const mismatchedReadbackBlobs:PrivateBlobs={...blobs,getIfExistsBounded:async(key,maxBytes)=>{
      const bytes=await blobs.getIfExistsBounded(key,maxBytes);
      return bytes&&Buffer.concat([bytes,Buffer.from('synthetic readback mutation')]);
    }};
    const mismatchedReadback=await promoteWordArtifact(pool,mismatchedReadbackLease,wordCandidate,mismatchedReadbackBlobs);
    assert.equal(mismatchedReadback.status,'unavailable');assert.equal(mismatchedReadback.deliveryCode,'blob_hash_mismatch');
    const mismatchEvidence=(await pool.query('SELECT readback_sha256,readback_byte_size,delivery_status FROM bb_word_delivery_evidence WHERE id=$1',[mismatchedReadback.evidenceId])).rows[0];
    assert.equal(mismatchEvidence.delivery_status,'unavailable');assert.notEqual(mismatchEvidence.readback_sha256.trim(),mismatchedReadback.sha256);
    await assert.rejects(finish(pool,mismatchedReadbackLease,'succeeded',{artifactId:mismatchedReadback.artifactId,artifactVersion:1,blobs}),/Passed Word artifact unavailable/);
    assert.equal((await send('GET',`/api/v1/runs/${mismatchedReadbackLease.runId}`)).json().state,'running','a mismatched initial Blob readback cannot produce run success');
    await finish(pool,mismatchedReadbackLease,'failed',{errorCode:'WORD_DELIVERY_UNAVAILABLE'});
    await blobs.delete(mismatchedReadback.objectKey);

    const tamperedRun=await send('POST','/api/v1/runs/execute',{...request,execution_request_id:'synthetic-word-tampered'});assert.equal(tamperedRun.statusCode,202,tamperedRun.body);
    const tamperedLease=await claim(pool,30);assert.ok(tamperedLease);assert.equal(tamperedLease.runId,tamperedRun.json().run_id);
    const tampered=await promoteWordArtifact(pool,tamperedLease,wordCandidate,blobs);assert.equal(tampered.status,'available');
    await blobs.put(tampered.objectKey,Buffer.from('corrupt after validated readback'),'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.equal((await send('GET',`/api/v1/artifacts/${tampered.artifactId}`)).statusCode,404,'an unfinished run remains private even when its Blob is corrupt');
    await assert.rejects(finish(pool,tamperedLease,'succeeded',{artifactId:tampered.artifactId,artifactVersion:1,blobs}),/Word artifact hash mismatch/);
    assert.equal((await send('GET',`/api/v1/runs/${tamperedLease.runId}`)).json().state,'running','a changed Blob cannot produce run success');
    assert.equal((await pool.query('SELECT delivery_status FROM bb_artifact_versions WHERE id=$1',[tampered.artifactId])).rows[0].delivery_status,'revoked','a finish-time mismatch revokes the previously available row');
    assert.equal((await pool.query("SELECT count(*)::int n FROM bb_word_delivery_evidence WHERE artifact_id=$1 AND delivery_code='blob_hash_mismatch' AND delivery_status='unavailable'",[tampered.artifactId])).rows[0].n,1,'finish-time mismatch adds immutable unavailable evidence');
    assert.equal((await send('GET',`/api/v1/artifacts/${tampered.artifactId}`)).statusCode,404,'a revoked artifact cannot receive a new download grant');
    await finish(pool,tamperedLease,'failed',{errorCode:'WORD_DELIVERY_UNAVAILABLE'});

    const raceRun=await send('POST','/api/v1/runs/execute',{...request,execution_request_id:'synthetic-terminal-race'});assert.equal(raceRun.statusCode,202);
    const raceLease=await claim(pool,30);assert.ok(raceLease);
    const race=await Promise.allSettled([send('POST',`/api/v1/runs/${raceLease.runId}/cancel`,{reason:'synthetic race'}),finish(pool,raceLease,'failed',{errorCode:'DATA_UNAVAILABLE'})]);
    const raceState=(await send('GET',`/api/v1/runs/${raceLease.runId}`)).json().state;
    assert.ok(['cancelled','failed'].includes(raceState));
    const raceEvents=(await send('GET',`/api/v1/runs/${raceLease.runId}/events`)).json().items;
    assert.equal(raceEvents.filter((e:any)=>['cancelled','failed'].includes(e.state)).length,1);
    assert.ok(race[0].status==='fulfilled' || race[1].status==='fulfilled');
  } finally {
    await pool.query('DROP TRIGGER IF EXISTS bb_queue_fail_outbox ON bb_outbox');await pool.query('DROP FUNCTION IF EXISTS bb_queue_fail_outbox()');
    await app.close();await pool.end();
  }
});
