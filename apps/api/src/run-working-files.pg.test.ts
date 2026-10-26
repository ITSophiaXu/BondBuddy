// Real PostgreSQL claims, frozen inputs, model-attempt bindings and lock races.
// Private Blob IO is synthetic; no provider, worker process or external service runs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { digest, Problem, run, transaction, uid, type PrivateBlobs } from './data.js';
import { grantCredits } from './billing.js';
import { isolatedTestDatabase } from './test-database.js';
import { inputManifestHash } from './production-rule-pin.js';
import { saveSnapshotRef } from './observability.js';
import { action, checkpointStage, claim, pauseAtCheckpoint, recordPotentialCall, type Lease } from './queue.js';
import { persistProviderResultObject, recordProviderCallObservation, type ProviderCallIntent } from './provider-results.js';
import { captureRunSupplementWork } from './run-supplement-work.js';
import { listCapturedSupplementFiles, readCapturedSupplementFile } from './run-supplement-files.js';
import { purgeLogContent } from './log-ops.js';
import { inventoryWorkingFilesForContent, purgeRunWorkingFiles, writeRunWorkingFile, type RunWorkingFileSource } from './run-working-files.js';

const connection=await isolatedTestDatabase(undefined,'run-working-files');
const DOCX='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const schema='codex-file-word-v1',future=new Date('2126-10-26T00:00:00Z');
const conflict=(error:unknown)=>error instanceof Problem&&error.status===409&&error.code==='INPUT_REVISION_CONFLICT';
type Write=Parameters<typeof writeRunWorkingFile>[0];
type Tracked<T>=Promise<{ok:true;value:T}|{ok:false;error:unknown}>;
function barrier(){let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return {promise,resolve};}
function tracked<T>(promise:Promise<T>):Tracked<T>{return promise.then(value=>({ok:true as const,value}),error=>({ok:false as const,error}));}
async function bounded<T>(promise:Promise<T>,message:string):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error(message)),5000);})]);}
  finally{if(timer)clearTimeout(timer);}
}

async function context(manifestOverride?:Record<string,unknown>){
  const suffix=uid(),writerName=`work-writer-${suffix}`,purgerName=`work-purger-${suffix}`,readerName=`work-reader-${suffix}`;
  // claim() selects across the real queue. Keep deliberately expired leases in
  // their own database so later contexts cannot reclaim another test's run.
  const contextConnection=await isolatedTestDatabase(undefined,`run-working-files-${suffix}`);
  assert.ok(contextConnection);
  const pool=new Pool({connectionString:contextConnection,max:4});
  const writerPool=new Pool({connectionString:contextConnection,max:1,application_name:writerName,statement_timeout:10000});
  const purgePool=new Pool({connectionString:contextConnection,max:1,application_name:purgerName,statement_timeout:10000});
  const readerPool=new Pool({connectionString:contextConnection,max:1,application_name:readerName,statement_timeout:10000});
  const owner=`working-files-${uid()}`,projectId=uid(),runId=uid(),jobId=uid();
  const objects=new Map<string,Buffer>(),puts:string[]=[],reads:Array<{key:string;limit:number}>=[],deletes:string[]=[];
  let beforePut:((key:string)=>Promise<void>)|undefined,beforeRead:((key:string)=>Promise<void>)|undefined;
  let beforeDelete:((key:string)=>Promise<void>)|undefined,corruptRead:string|undefined;
  const blobs:PrivateBlobs={
    put:async(key,bytes)=>{puts.push(key);await beforePut?.(key);objects.set(key,Buffer.from(bytes));},
    get:async key=>{const bytes=objects.get(key);assert.ok(bytes);return Buffer.from(bytes);},
    getIfExists:async key=>{const bytes=objects.get(key);return bytes?Buffer.from(bytes):null;},
    getIfExistsBounded:async(key,limit)=>{
      reads.push({key,limit});await beforeRead?.(key);const bytes=objects.get(key);
      assert.ok(!bytes||bytes.length<=limit,'bounded reads must use the exact registered byte count');
      return bytes?(key===corruptRead?Buffer.alloc(bytes.length,0):Buffer.from(bytes)):null;
    },
    exists:async key=>objects.has(key),
    delete:async key=>{await beforeDelete?.(key);deletes.push(key);objects.delete(key);},
  };
  const close=async()=>{await Promise.all([writerPool.end(),purgePool.end(),readerPool.end(),pool.end()]);};
  try{
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,`working_${uid().replaceAll('-','').slice(0,20)}`]);
    await transaction(pool,db=>grantCredits(db,{owner,points:5000,key:uid(),source:'existing_grant',expiresAt:null,
      actor:'synthetic-test',reason:'Nonempty billing evidence before working-file IO and retention'}));
    const manifest=manifestOverride??{draft_revision:1,issuer_name:'Synthetic frozen issuer',market:'sse',offering:'private',
      update_details:{reporting_cutoff:'2026-09-30'},goals:['Frozen goal'],requirements:['Frozen requirement'],materials:[],
      rule_pack_version:'frozen-rules',template_version:'frozen-template',reference_release:'frozen-reference'};
    const taskKind=manifest.project_kind==='review'?'review':'update';
    await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind,issuer_name) VALUES($1,$2,'Synthetic working files',$3,'Synthetic frozen issuer')",[projectId,owner,taskKind]);
    const inputHash=inputManifestHash(manifest);
    await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,
      material_versions,requirement_message_ids,rule_pack_version,template_version,reference_release)
      VALUES($1,1,$2,1,$3,$4,'[]','[]','frozen-rules','frozen-template','frozen-reference')`,[projectId,owner,inputHash,manifest]);
    await pool.query('UPDATE bb_projects SET latest_input_revision=1 WHERE id=$1',[projectId]);
    await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage)
      VALUES($1,$2,$3,1,$4,$5,$7,$6,'queued','queued')`,[runId,owner,projectId,inputHash,uid(),digest(uid()),taskKind]);
    await pool.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage)
      VALUES($1,$2,$3,$4,'default','queued','queued')`,[jobId,owner,runId,taskKind]);
    if(taskKind==='review'){
      const review=manifest.review as any;
      await pool.query(`INSERT INTO bb_review_executions(run_id,owner_user_id,project_id,version,operation,snapshot)
        VALUES($1,$2,$3,$4,$5,$6)`,[runId,owner,projectId,review.version_number,review.operation,{input:review.input,origin:review.origin}]);
    }
    const lease=await claim(pool,300,{runKinds:[taskKind]});assert.ok(lease);assert.equal(lease.runId,runId);assert.equal(lease.jobId,jobId);
    const promptBytes=Buffer.from(JSON.stringify({version:'synthetic-working-file-prompt-v1',input_hash:inputHash}));
    const promptKey=`users/${owner}/projects/${projectId}/snapshots/${uid()}`;
    await blobs.put(promptKey,promptBytes,'application/json');
    const promptId=await saveSnapshotRef(pool,{owner,projectId,runId,kind:'model_request',version:1,objectKey:promptKey,
      sha256:digest(promptBytes),redactionVersion:'synthetic_v1',inputRevision:1,inputHash,blobs});
    await checkpointStage(pool,lease,'working_file_prompt',{snapshot_id:promptId});
    let attempt=0,promptVersion=1;
    const addAttempt=async(newPromptAt?:Date)=>{
      const number=++attempt;
      let attemptPrompt=promptId;
      if(newPromptAt){
        // Explicit dated INSERTs model the passage of time without updating
        // immutable history. The bytes and subsequent binding remain real.
        attemptPrompt=uid();const key=`users/${owner}/projects/${projectId}/snapshots/${uid()}`;
        const bytes=Buffer.from(JSON.stringify({version:'synthetic-working-file-prompt-v1',input_hash:inputHash,attempt:number}));
        await blobs.put(key,bytes,'application/json');
        await pool.query(`INSERT INTO bb_snapshot_refs(id,owner_user_id,project_id,run_id,snapshot_kind,version,object_key,
          content_sha256,redaction_version,input_revision,input_hash,created_at)
          VALUES($1,$2,$3,$4,'model_request',$5,$6,$7,'synthetic_v1',1,$8,$9)`,
        [attemptPrompt,owner,projectId,runId,++promptVersion,key,digest(bytes),inputHash,newPromptAt]);
      }
      const intent:ProviderCallIntent={owner_user_id:owner,project_id:projectId,run_id:runId,trace_id:runId,job_id:jobId,
        logical_call_id:`working-file-${number}`,call_id:uid(),attempt_no:1,model_id:'synthetic-model',model_config_version:'synthetic-v1',prompt_snapshot_ref:attemptPrompt};
      await recordPotentialCall(pool,lease,intent.logical_call_id,1,{callId:intent.call_id,modelId:intent.model_id,promptSnapshotId:attemptPrompt});
      return intent;
    };
    const intent=await addAttempt();
    const file=(name='tracked.docx',bytes=Buffer.from(`Synthetic private ${name} for ${runId}`),
      source:RunWorkingFileSource={kind:'provider',attemptId:intent.call_id,resultSchemaVersion:schema},directory?:string):Write=>{
      const folder=directory??(source.kind==='provider'?`file-authoring/${source.attemptId}`:source.kind==='local_qa'?'qa':'review-files/correction');
      return {pool,blobs,lease,projectId,source,name,key:`owners/${owner}/projects/${projectId}/runs/${runId}/${folder}/${digest(bytes)}/${name}`,
        bytes,mediaType:name.endsWith('.docx')?DOCX:name.endsWith('.json')?'application/json':'text/markdown'};
    };
    const observe=async(value:unknown,call=intent,resultSchemaVersion=schema,createdAt?:Date)=>{
      const validate=(candidate:unknown)=>inputManifestHash(candidate)===inputManifestHash(value);
      const ref=await persistProviderResultObject({blobs,intent:call,bytes:Buffer.from(JSON.stringify(value)),resultSchemaVersion,validate});
      if(createdAt)await pool.query(`INSERT INTO bb_provider_result_refs(id,owner_user_id,project_id,job_id,run_id,attempt_id,
        logical_call_id,attempt_no,call_id,trace_id,model_id,model_config_version,prompt_snapshot_ref,result_ref,result_sha256,
        result_schema_version,byte_size,media_type,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$6,$5,$9,$10,$11,$12,$13,$14,$15,'application/json',$16)`,
      [uid(),owner,projectId,jobId,runId,call.call_id,call.logical_call_id,call.attempt_no,call.model_id,call.model_config_version,
        call.prompt_snapshot_ref,ref.result_ref,ref.result_sha256,resultSchemaVersion,ref.result_byte_size,createdAt]);
      await recordProviderCallObservation(pool,blobs,{...call,...ref,provider_request_id:null,finish_reason:'stop',outcome:'completed',error_code:null,
        usage:{status:'measured',input_tokens:3,cached_input_tokens:0,output_tokens:2,reasoning_tokens:0,total_tokens:5}},validate,{lease,source:'provider'});
      return (await pool.query('SELECT * FROM bb_provider_result_refs WHERE attempt_id=$1 AND result_sha256=$2',[call.call_id,ref.result_sha256])).rows[0];
    };
    const envelope=(files:Write[])=>({version:schema,input_hash:inputHash,
      files:Object.fromEntries(files.map(f=>[f.name,{key:f.key,sha256:digest(f.bytes),byte_size:f.bytes.length}])),summary:{authoring_summary:['Synthetic saved work']}});
    const state=async(key:string)=>(await pool.query('SELECT * FROM bb_run_working_object_state WHERE object_key=$1',[key])).rows[0];
    const history=async()=>{
      const result:Record<string,any[]>={};
      for(const table of ['bb_runs','bb_jobs','bb_run_events','bb_input_revisions','bb_run_execution_versions','bb_snapshot_refs',
        'bb_model_call_attempts','bb_model_call_execution_bindings','bb_provider_result_refs','bb_provider_call_observations',
        'bb_usage_observations','bb_run_supplement_drafts','bb_run_supplement_saved_work','bb_run_supplement_saved_results',
        'bb_credit_accounts','bb_credit_lots','bb_credit_reservations','bb_credit_events','bb_run_working_objects','bb_run_working_sources'])
        result[table]=(await pool.query(`SELECT * FROM ${table} WHERE owner_user_id=$1 ORDER BY to_jsonb(${table})::text`,[owner])).rows;
      return result;
    };
    const assertHistoryPreserved=async(before:Awaited<ReturnType<typeof history>>,message='cleanup preserves immutable input, provider and billing history')=>{
      const after=await history();
      for(const table of ['bb_run_working_objects','bb_run_working_sources']){
        const actual=new Set(after[table].map(row=>JSON.stringify(row)));
        for(const row of before[table])assert.ok(actual.has(JSON.stringify(row)),`${table}: an original immutable row changed or disappeared`);
      }
      const originals=new Set(before.bb_run_working_sources.map(row=>JSON.stringify(row)));
      for(const claim of after.bb_run_working_sources.filter(row=>!originals.has(JSON.stringify(row)))){
        const result=before.bb_provider_result_refs.find(row=>row.id===claim.discovered_result_id);assert.ok(result,'every appended source names an actual existing immutable result');
        assert.equal(claim.source_kind,'provider');assert.equal(claim.execution_version,1);assert.equal(claim.input_revision,lease.inputRevision);
        assert.equal(claim.input_hash.trim(),lease.inputHash);
        for(const [sourceField,resultField] of [['owner_user_id','owner_user_id'],['project_id','project_id'],['run_id','run_id'],
          ['job_id','job_id'],['attempt_id','attempt_id'],['result_schema_version','result_schema_version']] as const)
          assert.equal(claim[sourceField],result[resultField]);
        assert.equal(+new Date(claim.created_at),+new Date(result.created_at));
      }
      const oldHistory={...before},newHistory={...after};
      for(const table of ['bb_run_working_objects','bb_run_working_sources']){delete oldHistory[table];delete newHistory[table];}
      assert.deepEqual(newHistory,oldHistory,message);return after;
    };
    const capture=async()=>{
      await action(pool,owner,runId,'pause');assert.equal(await pauseAtCheckpoint(pool,lease),true);
      await transaction(pool,async db=>{
        const row=await run(db,owner,runId,true),job=(await db.query('SELECT * FROM bb_jobs WHERE id=$1 FOR UPDATE',[jobId])).rows[0];
        await db.query(`INSERT INTO bb_run_supplement_drafts(owner_user_id,project_id,run_id,revision,request_id,request_hash,
          base_input_revision,base_input_hash,changes) VALUES($1,$2,$3,1,$4,$5,1,$6,'[]')`,[owner,projectId,runId,uid(),digest(uid()),inputHash]);
        await captureRunSupplementWork(db,row,job,1);
      });
    };
    const policy={contentRetentionDays:1,ownerScope:[owner],now:()=>future,batchSize:20,runId};
    const purge=()=>purgeRunWorkingFiles(purgePool,blobs,policy);
    const waitForLock=async(waiter:'writer'|'reader'|'purger',blocker:'writer'|'reader'|'purger')=>{
      const names={writer:writerName,reader:readerName,purger:purgerName},deadline=Date.now()+5000;
      while(Date.now()<deadline){
        const row=(await pool.query(`SELECT w.pid,w.query,w.wait_event FROM pg_stat_activity w
          WHERE w.datname=current_database() AND w.application_name=$1 AND w.wait_event_type='Lock'
            AND EXISTS(SELECT 1 FROM pg_stat_activity b WHERE b.pid=ANY(pg_blocking_pids(w.pid)) AND b.application_name=$2)`,
        [names[waiter],names[blocker]])).rows[0];
        if(row)return row;
        // Poll observed PostgreSQL state; elapsed time is never the race assertion.
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      assert.fail(`${waiter} did not block on ${blocker}'s real PostgreSQL lock`);
    };
    return {pool,writerPool,readerPool,blobs,owner,projectId,runId,jobId,lease,promptId,promptKey,inputHash,intent,
      objects,puts,reads,deletes,file,envelope,observe,addAttempt,state,history,assertHistoryPreserved,capture,policy,purge,waitForLock,close,
      setBeforePut:(callback?:typeof beforePut)=>{beforePut=callback;},setBeforeRead:(callback?:typeof beforeRead)=>{beforeRead=callback;},
      setBeforeDelete:(callback?:typeof beforeDelete)=>{beforeDelete=callback;},setCorruptRead:(key?:string)=>{corruptRead=key;}};
  }catch(error){await close();throw error;}
}

test('working-file intent commits before Blob IO; failed writes/readback leave cleanup evidence without a provider result',
  {skip:!connection,timeout:30000},async t=>{
  for(const fault of ['put','readback'] as const)await t.test(fault,async()=>{
    const c=await context(),file=c.file(),before=await c.history();
    try{
      c.setBeforePut(async key=>{
        if(key!==file.key)return;
        const stored=await c.state(key);assert.ok(stored,'a separate DB connection sees the committed intent before put');
        assert.equal(stored.stored_at,null);assert.equal(stored.purge_started_at,null);
        const sources=(await c.pool.query('SELECT * FROM bb_run_working_sources WHERE object_key=$1',[key])).rows;
        assert.equal(sources.length,1);assert.equal(sources[0].attempt_id,c.intent.call_id);assert.equal(sources[0].input_hash.trim(),c.inputHash);
        if(fault==='put'){c.objects.set(key,Buffer.from(file.bytes));throw Error('SYNTHETIC_WRITE_LOST_ACK');}
      });
      if(fault==='readback')c.setCorruptRead(file.key);
      await assert.rejects(writeRunWorkingFile(file));
      assert.equal((await c.state(file.key)).stored_at,null);assert.ok(c.objects.has(file.key));
      assert.equal((await c.pool.query('SELECT count(*)::int n FROM bb_provider_result_refs WHERE run_id=$1',[c.runId])).rows[0].n,0);
      const after=await c.history();delete after.bb_run_working_objects;delete after.bb_run_working_sources;
      const unchanged={...before};delete unchanged.bb_run_working_objects;delete unchanged.bb_run_working_sources;assert.deepEqual(after,unchanged);
      c.setBeforePut();c.setCorruptRead();await action(c.pool,c.owner,c.runId,'cancel');
      const terminal=await c.history(),result=await c.purge();assert.equal(result.purged,1);assert.equal(result.failed,0);
      assert.equal(c.objects.has(file.key),false);assert.ok((await c.state(file.key)).purged_at);
      await c.assertHistoryPreserved(terminal,'orphan cleanup preserves frozen input, usage, billing and immutable metadata');
    }finally{await c.close();}
  });
});

test('working-file authority rejects wrong source, execution, owner, path and local lease before put',
  {skip:!connection,timeout:30000},async()=>{
  const c=await context(),file=c.file(),count=c.puts.length;
  try{
    const mutations:Partial<Write>[]=[
      {source:{kind:'provider',attemptId:uid(),resultSchemaVersion:schema}},
      {source:{kind:'provider',attemptId:c.intent.call_id,resultSchemaVersion:'codex-m4-document-v1'}},
      {source:{kind:'local_correction'}},{projectId:uid()},
      ...[{owner:uid()},{runId:uid()},{jobId:uid()},{executionVersion:2},{inputRevision:2},{inputHash:'0'.repeat(64)}]
        .map(change=>({lease:{...c.lease,...change} as Lease})),
      {key:file.key.replace(digest(file.bytes),'0'.repeat(64))},{key:file.key.replace(`/owners/`,`/other/`)+'-wrong'},
      {key:file.key.replace(`owners/${c.owner}/`,`owners/${uid()}/`)},{name:'delivery.md'},{mediaType:'text/plain'},
    ];
    for(const change of mutations)await assert.rejects(writeRunWorkingFile({...file,...change}));
    assert.equal(c.puts.length,count);assert.equal(await c.state(file.key),undefined);
    // A finished provider collector retains its bound attempt even if a successor lease replaced its token.
    await c.pool.query('UPDATE bb_jobs SET lease_token=$2,lease_until=now()-interval \'1 second\' WHERE id=$1',[c.jobId,uid()]);
    const before=await c.history();await writeRunWorkingFile(file);const after=await c.history();
    delete before.bb_run_working_objects;delete before.bb_run_working_sources;delete after.bb_run_working_objects;delete after.bb_run_working_sources;
    assert.deepEqual(after,before,'late provider collection cannot advance queue, input, usage or billing');
  }finally{await c.close();}
  const local=await context({version:'project-qa-v1'});
  try{
    const file=local.file('document.docx',Buffer.from('Synthetic local QA bytes'),{kind:'local_qa'}),count=local.puts.length;
    await assert.rejects(writeRunWorkingFile({...file,lease:{...local.lease,token:uid()}}),conflict);
    await local.pool.query('UPDATE bb_jobs SET lease_until=now()-interval \'1 second\' WHERE id=$1',[local.jobId]);
    await assert.rejects(writeRunWorkingFile(file),conflict);assert.equal(local.puts.length,count);
    assert.equal(await local.state(file.key),undefined);
  }finally{await local.close();}
});

test('shared correction objects keep both real attempt claims and every report hash is inventoried',
  {skip:!connection,timeout:30000},async()=>{
  const c=await context({review:{file_delivery:{version:'review-correction-v2'}}});
  try{
    const second=await c.addAttempt(),bytes=Buffer.from('Synthetic stable correction');
    const source=(attemptId:string):RunWorkingFileSource=>({kind:'provider',attemptId,resultSchemaVersion:'codex-review-file-v1'});
    const first=c.file('clean.docx',bytes,source(c.intent.call_id),'review-files/correction');
    await writeRunWorkingFile(first);await writeRunWorkingFile({...first,source:source(second.call_id)});
    const claims=(await c.pool.query('SELECT attempt_id FROM bb_run_working_sources WHERE object_key=$1 ORDER BY attempt_id',[first.key])).rows;
    assert.deepEqual(claims.map(row=>row.attempt_id).sort(),[c.intent.call_id,second.call_id].sort());
    assert.equal((await c.pool.query('SELECT count(*)::int n FROM bb_run_working_objects WHERE object_key=$1',[first.key])).rows[0].n,1);
    const reports=['Synthetic initial report','Synthetic canonical report'].map(text=>c.file('report.md',Buffer.from(text),source(c.intent.call_id),`review-files/${c.intent.call_id}`));
    for(const report of reports)await writeRunWorkingFile(report);
    const inventory=(await c.pool.query('SELECT object_key,sha256 FROM bb_run_working_objects WHERE run_id=$1 ORDER BY object_key',[c.runId])).rows;
    assert.equal(inventory.length,3);for(const report of reports)assert.ok(inventory.some(row=>row.object_key===report.key&&row.sha256.trim()===digest(report.bytes)));
  }finally{await c.close();}
});

test('database guards preserve exact source identity, immutable inventory and monotonic lifecycle receipts',
  {skip:!connection,timeout:30000},async()=>{
  const c=await context(),file=c.file();
  const constrained=(error:unknown)=>['23514','23503'].includes((error as {code?:string}).code??'');
  try{
    await c.blobs.put(file.key,file.bytes,file.mediaType);
    assert.equal((await c.pool.query('SELECT count(*)::int n FROM bb_run_working_sources WHERE run_id=$1',[c.runId])).rows[0].n,0,
      'neither a migration nor an unregistered legacy Blob fabricates producer authority');
    await writeRunWorkingFile(file);
    const source=(await c.pool.query('SELECT * FROM bb_run_working_sources WHERE object_key=$1',[file.key])).rows[0];
    const columns=['object_key','owner_user_id','project_id','run_id','job_id','execution_version','input_revision','input_hash',
      'source_kind','attempt_id','result_schema_version','discovered_result_id'];
    for(const change of [{owner_user_id:uid()},{project_id:uid()},{run_id:uid()},{job_id:uid()},
      {execution_version:2},{input_revision:2},{input_hash:'0'.repeat(64)},{attempt_id:uid()},{discovered_result_id:uid()}]){
      const invalid={...source,...change};
      await assert.rejects(c.pool.query(`INSERT INTO bb_run_working_sources(${columns.join(',')})
        VALUES(${columns.map((_,i)=>`$${i+1}`).join(',')})`,columns.map(column=>invalid[column])),constrained);
    }
    for(const sql of ["UPDATE bb_run_working_objects SET filename='other.docx' WHERE object_key=$1",
      'DELETE FROM bb_run_working_objects WHERE object_key=$1',
      "UPDATE bb_run_working_sources SET result_schema_version='other-v1' WHERE object_key=$1",
      'DELETE FROM bb_run_working_sources WHERE object_key=$1',
      'UPDATE bb_run_working_object_state SET stored_at=NULL WHERE object_key=$1',
      'DELETE FROM bb_run_working_object_state WHERE object_key=$1'])
      await assert.rejects(c.pool.query(sql,[file.key]),constrained);
    const orphan=c.file('clean.docx');
    c.setBeforePut(async key=>{if(key===orphan.key)throw Error('SYNTHETIC_ORPHAN_INTENT');});
    await assert.rejects(writeRunWorkingFile(orphan));c.setBeforePut();
    await action(c.pool,c.owner,c.runId,'cancel');c.setBeforeDelete(async()=>{throw Error('SYNTHETIC_DELETE_FAILURE');});
    assert.equal((await c.purge()).failed,2);
    for(const sql of ['UPDATE bb_run_working_object_state SET purge_started_at=NULL,purge_reason=NULL,policy_version=NULL WHERE object_key=$1',
      "UPDATE bb_run_working_object_state SET policy_version='rewritten' WHERE object_key=$1"])
      await assert.rejects(c.pool.query(sql,[orphan.key]),constrained);
    await assert.rejects(c.pool.query('UPDATE bb_run_working_object_state SET stored_at=now() WHERE object_key=$1',[orphan.key]),constrained);
    await assert.rejects(c.pool.query(`INSERT INTO bb_run_working_sources(${columns.join(',')})
      VALUES(${columns.map((_,i)=>`$${i+1}`).join(',')})`,columns.map(column=>source[column])),constrained);
    c.setBeforeDelete();assert.equal((await c.purge()).purged,2);
    await assert.rejects(c.pool.query('UPDATE bb_run_working_object_state SET purged_at=NULL WHERE object_key=$1',[orphan.key]),constrained);
  }finally{await c.close();}
});

test('a newer exact attempt claim extends retention of a shared correction physical object',
  {skip:!connection,timeout:30000},async()=>{
  const c=await context({review:{file_delivery:{version:'review-correction-v2'}}});
  try{
    const second=await c.addAttempt(),file=c.file('clean.docx',Buffer.from('Synthetic correction shared across attempts'),
      {kind:'provider',attemptId:c.intent.call_id,resultSchemaVersion:'codex-review-file-v1'},'review-files/correction');
    await writeRunWorkingFile(file);
    const object=(await c.pool.query('SELECT created_at FROM bb_run_working_objects WHERE object_key=$1',[file.key])).rows[0];
    const start=+new Date(object.created_at),recent=new Date(start+2*86400000);
    // The attempt is real and exactly bound. Only its claim clock is advanced to exercise the two retention boundaries.
    await c.pool.query(`INSERT INTO bb_run_working_sources(object_key,owner_user_id,project_id,run_id,job_id,execution_version,
      input_revision,input_hash,source_kind,attempt_id,result_schema_version,created_at)
      VALUES($1,$2,$3,$4,$5,1,1,$6,'provider',$7,'codex-review-file-v1',$8)`,
    [file.key,c.owner,c.projectId,c.runId,c.jobId,c.inputHash,second.call_id,recent]);
    await action(c.pool,c.owner,c.runId,'cancel');
    assert.equal((await purgeRunWorkingFiles(c.pool,c.blobs,{...c.policy,now:()=>recent})).due,0);
    assert.ok(c.objects.has(file.key));
    assert.equal((await purgeRunWorkingFiles(c.pool,c.blobs,{...c.policy,now:()=>new Date(start+4*86400000)})).purged,1);
    assert.equal(c.objects.has(file.key),false);
  }finally{await c.close();}
});

test('old paused work is retained, terminal work is purged, and account/project deletion uses its own window',
  {skip:!connection,timeout:40000},async t=>{
  await t.test('paused and terminal',async()=>{
    const c=await context();
    try{
      const files=[c.file(),c.file('clean.docx')];for(const file of files)await writeRunWorkingFile(file);
      const result=await c.observe(c.envelope(files));await c.capture();
      await inventoryWorkingFilesForContent(c.pool,c.blobs,{kind:'provider_result',id:result.id});
      const claims=(await c.pool.query('SELECT discovered_result_id FROM bb_run_working_sources WHERE run_id=$1',[c.runId])).rows;
      assert.equal(claims.filter(row=>row.discovered_result_id===null).length,2,'original pre-write claims remain independent');
      assert.equal(claims.filter(row=>row.discovered_result_id===result.id).length,2,'each actual result adds its own retention claims');
      assert.equal((await c.purge()).due,0);for(const file of files)assert.ok(c.objects.has(file.key));
      await action(c.pool,c.owner,c.runId,'cancel');const before=await c.history();
      assert.equal((await c.purge()).purged,2);await c.assertHistoryPreserved(before);
    }finally{await c.close();}
  });
  for(const kind of ['closed','deleted'] as const)await t.test(kind,async()=>{
    const c=await context(),file=c.file();
    try{
      await writeRunWorkingFile(file);
      if(kind==='closed')await c.pool.query("UPDATE bb_users SET status='closed',closed_at=now() WHERE id=$1",[c.owner]);
      else{
        await c.pool.query('UPDATE bb_projects SET deleted_at=now() WHERE id=$1',[c.projectId]);
        assert.equal((await purgeRunWorkingFiles(c.pool,c.blobs,{...c.policy,now:()=>new Date(),deletedProjectPurgeDays:1})).due,0);
        assert.equal((await c.purge()).due,0,'omitting the project-deletion window retains active work');
      }
      const result=await purgeRunWorkingFiles(c.pool,c.blobs,{...c.policy,deletedProjectPurgeDays:kind==='deleted'?1:undefined});
      assert.equal(result.purged,1);assert.equal((await c.state(file.key)).purge_reason,'user_deleted');
      const count=c.puts.length;await assert.rejects(writeRunWorkingFile(file),conflict);assert.equal(c.puts.length,count);
    }finally{await c.close();}
  });
});

test('durable purge marker rejects late writes through delete/receipt failures; retry removes orphan bytes',
  {skip:!connection,timeout:30000},async t=>{
  for(const fault of ['delete','receipt'] as const)await t.test(fault,async()=>{
    const c=await context(),file=c.file();
    try{
      await writeRunWorkingFile(file);
      const parent=await c.observe({...c.envelope([file]),error:'WORD_QUALITY_REJECTED'});
      await action(c.pool,c.owner,c.runId,'cancel');const before=await c.history();
      if(fault==='delete')c.setBeforeDelete(async()=>{throw Error('SYNTHETIC_DELETE_FAILURE');});
      const result=await purgeRunWorkingFiles(c.pool,c.blobs,{...c.policy,
        ...(fault==='receipt'?{afterBlobDelete:async()=>{throw Error('SYNTHETIC_CRASH_BEFORE_RECEIPT');}}:{})});
      assert.equal(result.failed,1);const state=await c.state(file.key);assert.ok(state.purge_started_at);assert.equal(state.purged_at,null);
      assert.equal(c.objects.has(file.key),fault==='delete');const count=c.puts.length;
      await assert.rejects(writeRunWorkingFile(file),conflict);assert.equal(c.puts.length,count);
      c.setBeforeDelete();
      c.objects.delete(parent.result_ref);
      // Once marked, cleanup remains pending even if a later policy's clock/window changes.
      // Retry must not attempt another inventory from its now-missing parent.
      const retry=await purgeRunWorkingFiles(c.pool,c.blobs,{...c.policy,now:()=>new Date(),contentRetentionDays:3650});
      assert.equal(retry.purged,1);assert.equal(retry.pending,false);assert.ok((await c.state(file.key)).purged_at);
      assert.equal(c.objects.has(file.key),false);await c.assertHistoryPreserved(before);
      assert.equal(c.deletes.filter(key=>key===file.key).length,fault==='receipt'?2:1,'Blob delete is idempotent across a lost DB receipt');
    }finally{await c.close();}
  });
});

test('legacy collector children are inventoried before parent purge; child failure blocks parent, corrupt known schemas fail closed',
  {skip:!connection,timeout:40000},async t=>{
  for(const fault of ['delete','unknown-envelope','wrong-hash'] as const)await t.test(fault,async()=>{
    const c=await context(),files=[c.file(),c.file('clean.docx')];
    try{
      // Historical collectors predate the registry. Only their exact durable JSON supplies this inventory.
      for(const file of files)await c.blobs.put(file.key,file.bytes,file.mediaType);
      const value=c.envelope(files),result=await c.observe(fault==='unknown-envelope'?{...value,version:'unknown-collector-v1'}:value);
      if(fault==='wrong-hash')c.objects.set(result.result_ref,Buffer.from('Corrupt synthetic parent JSON'));
      await action(c.pool,c.owner,c.runId,'cancel');const before=await c.history();
      if(fault==='delete')c.setBeforeDelete(async key=>{if(files.some(file=>file.key===key))throw Error('SYNTHETIC_CHILD_DELETE_FAILURE');});
      const purged=await purgeLogContent(c.pool,c.blobs,c.policy);assert.ok(purged.failed>0);
      assert.ok(c.objects.has(c.promptKey));assert.ok(c.objects.has(result.result_ref));
      assert.equal((await c.pool.query('SELECT count(*)::int n FROM bb_log_content_tombstones WHERE owner_user_id=$1',[c.owner])).rows[0].n,0);
      if(fault==='delete'){
        for(const file of files){
          assert.ok((await c.state(file.key)).purge_started_at);
          const claim=(await c.pool.query('SELECT discovered_result_id FROM bb_run_working_sources WHERE object_key=$1',[file.key])).rows[0];
          assert.equal(claim.discovered_result_id,result.id);
        }
        c.setBeforeDelete();const retry=await purgeLogContent(c.pool,c.blobs,c.policy);assert.equal(retry.failed,0);assert.equal(retry.purged,2);
        const childPositions=files.map(file=>c.deletes.indexOf(file.key));
        for(const parent of [c.promptKey,result.result_ref])assert.ok(childPositions.every(index=>index>=0&&index<c.deletes.indexOf(parent)));
      }
      await c.assertHistoryPreserved(before);
    }finally{await c.close();}
  });
});

test('legacy shared correction files retain every newer exact result claim across prompts, attempts and conflicting candidates',
  {skip:!connection,timeout:90000},async t=>{
  for(const lineage of ['separate-attempt-and-prompt','same-attempt-candidates'] as const)
   for(const entry of ['working-file','parent-content'] as const)await t.test(`${lineage}: ${entry}`,async()=>{
    const pin={material_id:uid(),material_version:1,sha256:digest('Synthetic fixed source material')};
    const input={source_material_ref:pin,material_versions:[pin],requirements:['Synthetic immutable review requirement'],as_of:'2026-09-30'};
    const c=await context({draft_revision:1,project_kind:'review',materials:[{...pin,role:'other'}],
      review:{version:'review_v1',operation:'full_review',version_number:1,input,origin:null,finding_ids:[],
        file_delivery:{version:'review-correction-v2',knowledge:[]}}});
    try{
      const start=new Date(),recent=new Date(+start+2*86400000),expired=new Date(+start+4*86400000);
      const resultSchema='codex-review-file-v1';
      const source=(attemptId:string):RunWorkingFileSource=>({kind:'provider',attemptId,resultSchemaVersion:resultSchema});
      const names=['revision.docx','clean.docx','baseline.docx','report.docx','report.md','editor.json'];
      const oldFiles=names.map(name=>c.file(name,Buffer.from(`Synthetic stable legacy ${name}`),source(c.intent.call_id),'review-files/correction'));
      const envelope=(files:Write[])=>({version:resultSchema,input_hash:c.inputHash,
        files:Object.fromEntries(files.map(file=>[file.name,{key:file.key,sha256:digest(file.bytes),byte_size:file.bytes.length}]))});
      for(const file of oldFiles)await c.blobs.put(file.key,file.bytes,file.mediaType);
      const old=await c.observe(envelope(oldFiles),c.intent,resultSchema,start);
      const newer=lineage==='separate-attempt-and-prompt'?await c.addAttempt(recent):c.intent;
      const newFiles=oldFiles.map(file=>file.name==='report.md'
        ?c.file(file.name,Buffer.from('Synthetic later legacy report'),source(newer.call_id),'review-files/correction')
        :{...file,source:source(newer.call_id)});
      for(const file of newFiles)await c.blobs.put(file.key,file.bytes,file.mediaType);
      const latest=await c.observe(envelope(newFiles),newer,resultSchema,recent);
      assert.notEqual(latest.id,old.id);
      if(lineage==='separate-attempt-and-prompt'){
        assert.notEqual(latest.prompt_snapshot_ref,old.prompt_snapshot_ref);
        await c.capture();
      }else{
        assert.equal(latest.attempt_id,old.attempt_id);
        assert.equal((await c.pool.query('SELECT state FROM bb_runs WHERE id=$1',[c.runId])).rows[0].state,'paused',
          'the real observation helper retains conflicting immutable candidates and pauses');
      }
      await action(c.pool,c.owner,c.runId,'cancel');const before=await c.history();
      // Seed only the old parent's discovered inventory. The later reference is
      // still unregistered, just as at the migration boundary.
      await inventoryWorkingFilesForContent(c.pool,c.blobs,{kind:'provider_result',id:old.id});
      const shared=oldFiles.find(file=>file.name==='clean.docx')!;
      assert.equal((await c.pool.query('SELECT count(*)::int n FROM bb_run_working_sources WHERE object_key=$1',[shared.key])).rows[0].n,1);
      const policy={...c.policy,now:()=>recent};
      const first=entry==='working-file'?await purgeRunWorkingFiles(c.pool,c.blobs,policy):await purgeLogContent(c.pool,c.blobs,policy);
      assert.equal(first.failed,0);assert.ok(c.objects.has(shared.key));
      assert.equal((await c.state(shared.key)).purge_started_at,null);
      assert.ok((await c.state(shared.key)).stored_at,'bounded legacy read records an observation made now');
      const claims=(await c.pool.query('SELECT discovered_result_id,created_at FROM bb_run_working_sources WHERE object_key=$1 ORDER BY created_at',[shared.key])).rows;
      assert.deepEqual(claims.map(row=>row.discovered_result_id),[old.id,latest.id]);
      assert.deepEqual(claims.map(row=>+new Date(row.created_at)),[+start,+recent]);
      if(lineage==='separate-attempt-and-prompt'){
        const readInput={db:c.pool,blobs:c.blobs,owner:c.owner,projectId:c.projectId,runId:c.runId,revision:1,
          source:{kind:'provider_result' as const,resultId:latest.id,resultSchemaVersion:resultSchema}};
        const captured=(await listCapturedSupplementFiles(readInput)).find(file=>file.name==='clean.docx')!;assert.ok(captured);
        assert.deepEqual(await readCapturedSupplementFile({...readInput,pin:captured}),shared.bytes,
          'discovering a still-retained valid legacy file preserves the exact newer reader');
      }
      await c.assertHistoryPreserved(before,'discovery only appends file inventory, preserving all immutable execution and billing history');
      const last=await purgeLogContent(c.pool,c.blobs,{...c.policy,now:()=>expired});assert.equal(last.failed,0);
      assert.equal(c.objects.has(shared.key),false);assert.ok((await c.state(shared.key)).purged_at);
      await c.assertHistoryPreserved(before);
    }finally{await c.close();}
   });
});

test('legacy observation records only verified bytes and keeps missing or corrupt raw addresses unavailable for cleanup',
  {skip:!connection,timeout:40000},async t=>{
  for(const fault of ['missing','corrupt'] as const)await t.test(fault,async()=>{
    const c=await context(),files=[c.file(),c.file('clean.docx')];
    try{
      for(const file of files)await c.blobs.put(file.key,file.bytes,file.mediaType);
      const result=await c.observe(c.envelope(files));await c.capture();
      if(fault==='missing')c.objects.delete(files[0].key);else c.objects.set(files[0].key,Buffer.alloc(files[0].bytes.length,0));
      await inventoryWorkingFilesForContent(c.pool,c.blobs,{kind:'provider_result',id:result.id});
      assert.equal((await c.state(files[0].key)).stored_at,null);
      assert.ok((await c.state(files[1].key)).stored_at);
      const input={db:c.pool,blobs:c.blobs,owner:c.owner,projectId:c.projectId,runId:c.runId,revision:1,
        source:{kind:'provider_result' as const,resultId:result.id,resultSchemaVersion:schema}};
      const captured=(await listCapturedSupplementFiles(input)).find(pin=>pin.name==='tracked.docx')!;assert.ok(captured);
      await assert.rejects(readCapturedSupplementFile({...input,pin:captured}),conflict);
      await action(c.pool,c.owner,c.runId,'cancel');assert.equal((await c.purge()).purged,2);
      for(const file of files){assert.equal(c.objects.has(file.key),false);assert.ok((await c.state(file.key)).purged_at);}
    }finally{await c.close();}
  });
});

test('age purge fails closed when a different recent known result has corrupt provenance',
  {skip:!connection,timeout:30000},async()=>{
  const c=await context();
  try{
    const start=new Date(),recent=new Date(+start+2*86400000),files=[c.file(),c.file('clean.docx')];
    for(const file of files)await c.blobs.put(file.key,file.bytes,file.mediaType);
    const old=await c.observe(c.envelope(files),c.intent,schema,start);
    const newer=await c.addAttempt(recent),source:RunWorkingFileSource={kind:'provider',attemptId:newer.call_id,resultSchemaVersion:schema};
    const newFiles=['tracked.docx','clean.docx'].map(name=>c.file(name,Buffer.from(`Synthetic newer ${name}`),source));
    for(const file of newFiles)await c.blobs.put(file.key,file.bytes,file.mediaType);
    const latest=await c.observe(c.envelope(newFiles),newer,schema,recent),original=c.objects.get(latest.result_ref)!;
    await action(c.pool,c.owner,c.runId,'cancel');
    await inventoryWorkingFilesForContent(c.pool,c.blobs,{kind:'provider_result',id:old.id});
    c.objects.set(latest.result_ref,Buffer.from('Corrupt recent known result'));
    const policy={...c.policy,now:()=>recent},failed=await purgeRunWorkingFiles(c.pool,c.blobs,policy);
    assert.ok(failed.failed>0);assert.equal(failed.pending,true);
    for(const file of files){assert.ok(c.objects.has(file.key));assert.equal((await c.state(file.key)).purge_started_at,null);}
    c.objects.set(latest.result_ref,original);
    const retry=await purgeRunWorkingFiles(c.pool,c.blobs,policy);assert.equal(retry.failed,0);assert.equal(retry.purged,2);
    for(const file of newFiles)assert.ok(c.objects.has(file.key));
  }finally{await c.close();}
});

test('real PG writer/purger serialization preserves intent then denies writes after purge starts',
  {skip:!connection,timeout:40000},async t=>{
  for(const first of ['writer','purger'] as const)await t.test(first,async()=>{
    const c=await context(),file=c.file(),entered=barrier(),release=barrier();
    let writing:Tracked<void>|undefined,purging:Tracked<Awaited<ReturnType<typeof c.purge>>>|undefined;
    try{
      await writeRunWorkingFile(file);await action(c.pool,c.owner,c.runId,'cancel');const before=await c.history();
      if(first==='writer'){
        c.setBeforePut(async key=>{if(key===file.key){entered.resolve();await release.promise;}});
        writing=tracked(writeRunWorkingFile({...file,pool:c.writerPool}));await bounded(entered.promise,'writer did not enter Blob put');
        purging=tracked(c.purge());await c.waitForLock('purger','writer');
        assert.equal(c.deletes.length,0);assert.equal((await c.state(file.key)).purge_started_at,null);
      }else{
        c.setBeforeDelete(async key=>{if(key===file.key){entered.resolve();await release.promise;}});
        purging=tracked(c.purge());await bounded(entered.promise,'purger did not enter Blob delete');
        assert.ok((await c.state(file.key)).purge_started_at);
        writing=tracked(writeRunWorkingFile({...file,pool:c.writerPool}));await c.waitForLock('writer','purger');
      }
      const count=c.puts.length;release.resolve();const write=await bounded(writing,'writer remained blocked'),purge=await bounded(purging,'purger remained blocked');
      assert.equal(purge.ok,true);if(purge.ok)assert.equal(purge.value.purged,1);
      assert.equal(write.ok,first==='writer');if(!write.ok)assert.ok(conflict(write.error));
      assert.equal(c.puts.length,count);assert.equal(c.objects.has(file.key),false);await c.assertHistoryPreserved(before);
    }finally{
      release.resolve();await Promise.all([writing,purging]);await c.close();
    }
  });
});

test('captured-file read holds its parent and file locks through readback while real PG purge waits',
  {skip:!connection,timeout:30000},async()=>{
  const c=await context(),files=[c.file(),c.file('clean.docx')],entered=barrier(),release=barrier();
  let reading:Tracked<Buffer>|undefined,purging:Tracked<Awaited<ReturnType<typeof c.purge>>>|undefined;
  try{
    for(const file of files)await writeRunWorkingFile(file);
    const result=await c.observe(c.envelope(files));await c.capture();await action(c.pool,c.owner,c.runId,'cancel');
    const source={kind:'provider_result' as const,resultId:result.id,resultSchemaVersion:schema};
    const input={db:c.readerPool,blobs:c.blobs,owner:c.owner,projectId:c.projectId,runId:c.runId,revision:1,source};
    const pin=(await listCapturedSupplementFiles(input)).find(file=>file.name==='tracked.docx')!;assert.ok(pin);
    const before=await c.history();
    c.setBeforeRead(async key=>{if(key===pin.key){entered.resolve();await release.promise;}});
    reading=tracked(readCapturedSupplementFile({...input,pin}));await bounded(entered.promise,'captured file did not enter readback');
    purging=tracked(c.purge());await c.waitForLock('purger','reader');assert.ok(c.objects.has(pin.key));assert.ok(!c.deletes.includes(pin.key));
    release.resolve();const read=await bounded(reading,'reader remained blocked'),purge=await bounded(purging,'purge remained blocked');
    assert.equal(read.ok,true);if(read.ok)assert.deepEqual(read.value,files[0].bytes);
    assert.equal(purge.ok,true);if(purge.ok)assert.equal(purge.value.purged,2);
    await assert.rejects(readCapturedSupplementFile({...input,pin}),conflict);
    const after=await c.assertHistoryPreserved(before);
    assert.equal(after.bb_run_working_sources.filter(row=>row.discovered_result_id===result.id).length,2,
      'the purge appends one exact result claim per captured file while retaining the original pre-write rows');
  }finally{release.resolve();await Promise.all([reading,purging]);await c.close();}
});
