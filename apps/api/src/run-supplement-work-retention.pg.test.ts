// Real PostgreSQL advisory-lock races with synthetic in-memory private bytes.
// No provider, browser, worker process or external Blob service is used.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { isolatedTestDatabase } from './test-database.js';
import { digest, Problem, run, transaction, uid, type PrivateBlobs } from './data.js';
import { grantCredits } from './billing.js';
import { inputManifestHash } from './production-rule-pin.js';
import { action, checkpointStage, pauseAtCheckpoint, recordPotentialCall, type Lease } from './queue.js';
import { persistProviderResultObject, recordProviderCallObservation, type ProviderCallIntent } from './provider-results.js';
import { captureRunSupplementWork, readCapturedSupplementResult } from './run-supplement-work.js';
import { purgeLogContent } from './log-ops.js';

const connection=await isolatedTestDatabase(undefined,'run-supplement-work-retention');
const schema='synthetic-supplement-retention-v1';
const retentionNow=new Date('2126-10-26T00:00:00Z');
const conflict=(error:unknown)=>error instanceof Problem&&error.status===409&&error.code==='INPUT_REVISION_CONFLICT';
function barrier(){
  let resolve!:()=>void;
  const promise=new Promise<void>(yes=>{resolve=yes;});
  return {promise,resolve};
}
type Tracked<T>=Promise<{ok:true;value:T}|{ok:false;error:unknown}>;
function tracked<T>(promise:Promise<T>):Tracked<T>{
  return promise.then(value=>({ok:true as const,value}),error=>({ok:false as const,error}));
}
async function bounded<T>(promise:Promise<T>,message:string):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([promise,new Promise<never>((_,reject)=>{
    timer=setTimeout(()=>reject(new Error(message)),5000);
  })]);}finally{if(timer)clearTimeout(timer);}
}

async function context(promptCreatedAt='2020-01-01T00:00:00Z'){
  const suffix=uid(),readerName=`supp-ret-reader-${suffix}`,purgerName=`supp-ret-purger-${suffix}`;
  const pool=new Pool({connectionString:connection,max:3});
  const readerPool=new Pool({connectionString:connection,max:1,application_name:readerName,statement_timeout:10000});
  const purgePool=new Pool({connectionString:connection,max:1,application_name:purgerName,statement_timeout:10000});
  const owner=`supplement-retention-${uid()}`,projectId=uid(),runId=uid(),jobId=uid(),token=uid();
  const objects=new Map<string,Buffer>(),boundedReads:string[]=[],deleted:string[]=[],deleteEntered:string[]=[];
  let beforeDelete:((key:string)=>Promise<void>)|undefined;
  const blobs:PrivateBlobs={
    put:async(key,bytes)=>{objects.set(key,Buffer.from(bytes));},
    get:async key=>{const bytes=objects.get(key);assert.ok(bytes);return Buffer.from(bytes);},
    getIfExists:async key=>{const bytes=objects.get(key);return bytes?Buffer.from(bytes):null;},
    getIfExistsBounded:async(key,max)=>{
      boundedReads.push(key);const bytes=objects.get(key);assert.ok(!bytes||bytes.length<=max);return bytes?Buffer.from(bytes):null;
    },
    exists:async key=>objects.has(key),delete:async key=>{
      deleteEntered.push(key);await beforeDelete?.(key);objects.delete(key);deleted.push(key);
    },
  };
  const close=async()=>{await Promise.all([readerPool.end(),purgePool.end(),pool.end()]);};
  try{
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,`retention_${uid().replaceAll('-','').slice(0,16)}`]);
    await transaction(pool,db=>grantCredits(db,{owner,points:5000,key:uid(),source:'existing_grant',expiresAt:null,
      actor:'synthetic-test',reason:'Nonempty ledger before read and retention concurrency regression'}));
    await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic captured-result retention','update')",[projectId,owner]);
    const manifest={synthetic:true,projectId,requirements:['Exact original input']},inputHash=inputManifestHash(manifest);
    await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,1,$2,1,$3,$4,'[]','[]')`,[projectId,owner,inputHash,manifest]);
    await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage)
      VALUES($1,$2,$3,1,$4,$1,'update',$4,'running','model_generation')`,[runId,owner,projectId,inputHash]);
    await pool.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage,lease_token,lease_until,attempts)
      VALUES($1,$2,$3,'update','synthetic','running','model_generation',$4,now()+interval '10 minutes',1)`,[jobId,owner,runId,token]);
    const promptId=uid(),promptKey=`users/${owner}/projects/${projectId}/snapshots/${promptId}`;
    const promptBytes=Buffer.from(`Synthetic immutable request ${inputHash}`);objects.set(promptKey,promptBytes);
    await pool.query(`INSERT INTO bb_snapshot_refs(id,owner_user_id,project_id,run_id,snapshot_kind,version,object_key,content_sha256,
      redaction_version,input_revision,input_hash,created_at) VALUES($1,$2,$3,$4,'model_request',1,$5,$6,'synthetic-v1',1,$7,$8)`,
    [promptId,owner,projectId,runId,promptKey,digest(promptBytes),inputHash,promptCreatedAt]);
    const lease:Lease={owner,runId,jobId,token,checkpoint:{},attempts:1,executionVersion:1,inputRevision:1,inputHash};
    await checkpointStage(pool,lease,'synthetic_prompt',{snapshot_id:promptId});
    const intent:ProviderCallIntent={owner_user_id:owner,project_id:projectId,job_id:jobId,run_id:runId,trace_id:runId,
      logical_call_id:'synthetic-retained-work',call_id:uid(),attempt_no:1,model_id:'synthetic-model',
      model_config_version:'synthetic-v1',prompt_snapshot_ref:promptId};
    await recordPotentialCall(pool,lease,intent.logical_call_id,1,{callId:intent.call_id,modelId:intent.model_id,promptSnapshotId:promptId});
    const value={version:schema,input_hash:inputHash,marker:uid(),text:'Synthetic private captured result'};
    const validate=(candidate:unknown)=>!!candidate&&typeof candidate==='object'&&JSON.stringify(candidate)===JSON.stringify(value);
    const resultRef=await persistProviderResultObject({blobs,intent,bytes:Buffer.from(JSON.stringify(value)),resultSchemaVersion:schema,validate});
    await recordProviderCallObservation(pool,blobs,{...intent,...resultRef,provider_request_id:null,finish_reason:'stop',outcome:'completed',
      error_code:null,usage:{status:'measured',input_tokens:3,cached_input_tokens:0,output_tokens:2,reasoning_tokens:0,total_tokens:5}},
    validate,{lease,source:'provider'});
    const result=(await pool.query('SELECT * FROM bb_provider_result_refs WHERE attempt_id=$1',[intent.call_id])).rows[0];assert.ok(result);
    await checkpointStage(pool,lease,'synthetic_saved_work',{result_id:result.id});
    await action(pool,owner,runId,'pause');assert.equal(await pauseAtCheckpoint(pool,lease),true);
    await transaction(pool,async db=>{
      const r=await run(db,owner,runId,true);
      const job=(await db.query('SELECT * FROM bb_jobs WHERE owner_user_id=$1 AND run_id=$2 FOR UPDATE',[owner,runId])).rows[0];
      await db.query(`INSERT INTO bb_run_supplement_drafts(owner_user_id,project_id,run_id,revision,request_id,request_hash,
        base_input_revision,base_input_hash,changes) VALUES($1,$2,$3,1,$4,$5,1,$6,'[]')`,[owner,projectId,runId,uid(),digest(uid()),inputHash]);
      await captureRunSupplementWork(db,r,job,1);
    });
    // Retention eligibility follows the real terminal transition. Captured metadata
    // stays immutable and does not extend the private-content retention window.
    await action(pool,owner,runId,'cancel');
    const read=(validator:(candidate:unknown)=>boolean|Promise<boolean>=validate)=>readCapturedSupplementResult({
      db:readerPool,blobs,owner,projectId,runId,revision:1,resultId:result.id,resultSchemaVersion:schema,validate:validator});
    const purge=()=>purgeLogContent(purgePool,blobs,{contentRetentionDays:1,now:()=>retentionNow,ownerScope:[owner],batchSize:10});
    const history=async()=>{
      const rows:Record<string,unknown>={};
      for(const table of ['bb_runs','bb_jobs','bb_run_events','bb_input_revisions','bb_run_execution_versions','bb_snapshot_refs',
        'bb_model_call_attempts','bb_model_call_execution_bindings','bb_provider_result_refs','bb_provider_call_observations',
        'bb_usage_observations','bb_run_supplement_drafts','bb_run_supplement_saved_work','bb_run_supplement_saved_results',
        'bb_credit_accounts','bb_credit_lots','bb_credit_reservations','bb_credit_events']){
        rows[table]=(await pool.query(`SELECT * FROM ${table} WHERE owner_user_id=$1 ORDER BY to_jsonb(${table})::text`,[owner])).rows;
      }
      return rows;
    };
    const tombstones=async()=>(await pool.query(`SELECT content_kind,content_id FROM bb_log_content_tombstones
      WHERE owner_user_id=$1 ORDER BY content_kind`,[owner])).rows;
    const waitForLock=async(waiter:'reader'|'purger',blocker:'reader'|'purger')=>{
      const waiterName=waiter==='reader'?readerName:purgerName,blockerName=blocker==='reader'?readerName:purgerName;
      const deadline=Date.now()+5000;
      while(Date.now()<deadline){
        const row=(await pool.query(`SELECT w.pid,w.query,w.wait_event FROM pg_stat_activity w
          WHERE w.datname=current_database() AND w.application_name=$1 AND w.wait_event_type='Lock'
            AND w.query LIKE '%pg_advisory_xact_lock%'
            AND EXISTS(SELECT 1 FROM pg_stat_activity b WHERE b.pid=ANY(pg_blocking_pids(w.pid)) AND b.application_name=$2)`,
        [waiterName,blockerName])).rows[0];
        if(row)return row;
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      assert.fail(`${waiter} did not wait on ${blocker}'s real PostgreSQL advisory lock`);
    };
    return {pool,objects,boundedReads,deleted,deleteEntered,promptId,promptKey,result,value,validate,read,purge,history,tombstones,waitForLock,
      setBeforeDelete:(callback:(key:string)=>Promise<void>)=>{beforeDelete=callback;},close};
  }catch(error){await close();throw error;}
}

test('captured-result locks cover the async validator while real prompt and provider-result retention wait',
  {skip:!connection,timeout:40000},async t=>{
  for(const kind of ['prompt_snapshot','provider_result'] as const)await t.test(kind,async()=>{
    // In the result-only case the prompt is not yet due. This proves the result
    // namespace itself is serialized instead of passing only via the prompt lock.
    const c=await context(kind==='provider_result'?retentionNow.toISOString():undefined),entered=barrier(),release=barrier();
    let purging:Tracked<Awaited<ReturnType<typeof c.purge>>>|undefined;
    const before=await c.history();
    const reading=tracked(c.read(async value=>{entered.resolve();await release.promise;return c.validate(value);}));
    try{
      await bounded(entered.promise,'captured-result validator did not start');
      assert.deepEqual(c.boundedReads,[c.result.result_ref]);
      purging=tracked(c.purge());
      await c.waitForLock('purger','reader');
      assert.deepEqual(c.deleteEntered,[],'retention must not begin Blob deletion while the reader validates');
      assert.deepEqual(await c.tombstones(),[]);assert.deepEqual(await c.history(),before);
      release.resolve();
      const readResult=await bounded(reading,'captured result did not finish after validator release');
      assert.equal(readResult.ok,true);if(readResult.ok)assert.deepEqual(readResult.value,c.value);
      const purgeResult=await bounded(purging,'retention did not finish after reader commit');
      assert.equal(purgeResult.ok,true);
      if(purgeResult.ok){assert.equal(purgeResult.value.failed,0);assert.equal(purgeResult.value.purged,kind==='prompt_snapshot'?2:1);}
      assert.equal(c.objects.has(c.result.result_ref),false);
      if(kind==='prompt_snapshot')assert.deepEqual(c.deleted,[c.promptKey,c.result.result_ref]);
      else assert.deepEqual(c.deleted,[c.result.result_ref]);
      const reads=c.boundedReads.length;await assert.rejects(c.read(),conflict);
      assert.equal(c.boundedReads.length,reads,'a committed purge receipt denies the next read before Blob access');
      assert.deepEqual(await c.history(),before,'read and purge preserve run, call, capture and billing history');
    }finally{
      release.resolve();await reading;if(purging)await purging;await c.close();
    }
  });
});

test('a real purge holding the prompt lock makes the captured-result reader wait, then reject without reading result bytes',
  {skip:!connection,timeout:20000},async()=>{
  const c=await context(),deleteEntered=barrier(),releaseDelete=barrier();
  c.setBeforeDelete(async key=>{if(key===c.promptKey){deleteEntered.resolve();await releaseDelete.promise;}});
  const before=await c.history(),purging=tracked(c.purge());
  let reading:Tracked<unknown>|undefined;
  try{
    await bounded(deleteEntered.promise,'real retention did not enter the held prompt Blob deletion');
    assert.deepEqual(c.deleteEntered,[c.promptKey]);assert.deepEqual(await c.tombstones(),[]);
    const reads=c.boundedReads.length;reading=tracked(c.read());
    await c.waitForLock('reader','purger');
    assert.equal(c.boundedReads.length,reads,'reader cannot reach provider-result Blob while purge holds the prompt lock');
    releaseDelete.resolve();
    const [purgeResult,readResult]=await bounded(Promise.all([purging,reading]),'reader or retention did not complete after prompt purge');
    assert.equal(purgeResult.ok,true);if(purgeResult.ok){assert.equal(purgeResult.value.purged,2);assert.equal(purgeResult.value.failed,0);}
    assert.equal(readResult.ok,false);if(!readResult.ok)assert.ok(conflict(readResult.error));
    assert.equal(c.boundedReads.length,reads,'visibility is rechecked after acquiring the lock; no stale private bytes are read');
    assert.deepEqual(await c.tombstones(),[
      {content_kind:'prompt_snapshot',content_id:c.promptId},{content_kind:'provider_result',content_id:c.result.id},
    ]);
    assert.deepEqual(c.deleted,[c.promptKey,c.result.result_ref]);assert.deepEqual(await c.history(),before);
  }finally{
    releaseDelete.resolve();await purging;if(reading)await reading;await c.close();
  }
});
