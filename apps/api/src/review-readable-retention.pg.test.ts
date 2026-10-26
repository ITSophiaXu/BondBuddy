// Real PostgreSQL locks and visibility with synthetic private bytes. The seeded
// delivery evidence is test setup, not Word quality or real provider acceptance.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { digest, uid, type PrivateBlobs } from './data.js';
import { inputManifestHash } from './production-rule-pin.js';
import { makeSyntheticDocxFixture } from './docx-fixtures.js';
import { isolatedTestDatabase } from './test-database.js';
import { readReviewMarkdown } from './review-readable.js';
import { purgeRunWorkingFiles } from './run-working-files.js';

const connection=await isolatedTestDatabase(undefined,'review-readable-retention');
const DOCX='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
function barrier(){let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return {promise,resolve};}
async function bounded<T>(promise:Promise<T>,message:string):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),5000);})]);}
  finally{if(timer)clearTimeout(timer);}
}

async function context(){
  const suffix=uid(),readerName=`readable-reader-${suffix}`,cleanerName=`readable-cleaner-${suffix}`;
  const pool=new Pool({connectionString:connection,max:3});
  const readerPool=new Pool({connectionString:connection,max:1,application_name:readerName,statement_timeout:10000});
  const cleanerPool=new Pool({connectionString:connection,max:1,application_name:cleanerName,statement_timeout:10000});
  const owner=uid(),projectId=uid(),runId=uid(),jobId=uid(),callId=uid(),promptId=uid(),resultId=uid();
  const objects=new Map<string,Buffer>(),reads:string[]=[],deletes:string[]=[];
  let beforeRead:((key:string)=>Promise<void>)|undefined;
  const blobs:PrivateBlobs={
    put:async(key,bytes)=>{objects.set(key,Buffer.from(bytes));},
    get:async key=>{const bytes=objects.get(key);assert.ok(bytes);return Buffer.from(bytes);},
    getIfExists:async key=>objects.get(key)??null,
    getIfExistsBounded:async(key,max)=>{reads.push(key);await beforeRead?.(key);const bytes=objects.get(key);assert.ok(!bytes||bytes.length<=max);return bytes?Buffer.from(bytes):null;},
    exists:async key=>objects.has(key),delete:async key=>{deletes.push(key);objects.delete(key);},
  };
  const close=async()=>{await Promise.all([readerPool.end(),cleanerPool.end(),pool.end()]);};
  try{
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,`readable_${uid().replaceAll('-','').slice(0,16)}`]);
    await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic readable lifecycle','review')",[projectId,owner]);
    const reviewInput={source_material_ref:null,material_versions:[],requirements:['Read only the exact delivered report'],as_of:null};
    const reviewOrigin={version:'review-execution-origin-v1',entrypoint:'quick_action',accepted_proposal:null,context_report_ref:null};
    const manifest={synthetic:true,project_kind:'review',materials:[],review:{version:'review_v1',operation:'full_review',
      report_id:uid(),version_number:1,source_report_id:null,source_report_sha256:null,input:reviewInput,origin:reviewOrigin,finding_ids:[]}},
      inputHash=inputManifestHash(manifest);
    await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,1,$2,1,$3,$4,'[]','[]')`,[projectId,owner,inputHash,manifest]);
    await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage)
      VALUES($1,$2,$3,1,$4,$1,'review',$4,'running','model_generation')`,[runId,owner,projectId,inputHash]);
    await pool.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage)
      VALUES($1,$2,$3,'review','synthetic-readable','running','model_generation')`,[jobId,owner,runId]);
    await pool.query(`INSERT INTO bb_review_executions(run_id,owner_user_id,project_id,version,operation,snapshot)
      VALUES($1,$2,$3,1,'full_review',$4)`,[runId,owner,projectId,{input:reviewInput,origin:reviewOrigin,finding_ids:[]}]);
    const promptKey=`users/${owner}/projects/${projectId}/snapshots/${promptId}`,prompt=Buffer.from('Synthetic exact review prompt');
    objects.set(promptKey,prompt);
    await pool.query(`INSERT INTO bb_snapshot_refs(id,owner_user_id,project_id,run_id,snapshot_kind,version,object_key,content_sha256,redaction_version,input_revision,input_hash)
      VALUES($1,$2,$3,$4,'model_request',1,$5,$6,'synthetic-v1',1,$7)`,[promptId,owner,projectId,runId,promptKey,digest(prompt),inputHash]);
    await pool.query(`INSERT INTO bb_model_call_attempts(id,owner_user_id,job_id,logical_call_id,attempt_no,status,usage_status,model_id,prompt_snapshot_id)
      VALUES($1,$2,$3,'review-file-v1',1,'completed','unknown','synthetic-model',$4)`,[callId,owner,jobId,promptId]);
    const markdown=Buffer.from('# 合成复核报告\n准确私有文件。'),reportHash=digest(markdown);
    const reportKey=`owners/${owner}/projects/${projectId}/runs/${runId}/review-files/${callId}/${reportHash}/report.md`;
    objects.set(reportKey,markdown);
    const rawWord=makeSyntheticDocxFixture(),rawWordHash=digest(rawWord);
    const rawWordKey=`owners/${owner}/projects/${projectId}/runs/${runId}/review-files/${callId}/${rawWordHash}/report.docx`;
    objects.set(rawWordKey,rawWord);
    const result=Buffer.from(JSON.stringify({version:'codex-review-file-v1',input_hash:inputHash,
      files:{'report.md':{key:reportKey,sha256:reportHash,byte_size:markdown.length},
        'report.docx':{key:rawWordKey,sha256:rawWordHash,byte_size:rawWord.length}}}));
    const resultHash=digest(result),resultKey=`users/${owner}/projects/${projectId}/provider-results/${callId}-${resultHash}.json`;
    objects.set(resultKey,result);
    await pool.query(`INSERT INTO bb_provider_result_refs(id,owner_user_id,project_id,job_id,run_id,attempt_id,logical_call_id,attempt_no,call_id,trace_id,
      model_id,model_config_version,prompt_snapshot_ref,result_ref,result_sha256,result_schema_version,byte_size,media_type)
      VALUES($1,$2,$3,$4,$5,$6,'review-file-v1',1,$6,$5,'synthetic-model','synthetic-v1',$7,$8,$9,'codex-review-file-v1',$10,'application/json')`,
    [resultId,owner,projectId,jobId,runId,callId,promptId,resultKey,resultHash,result.length]);
    const artifactId=uid(),evidenceId=uid(),word=makeSyntheticDocxFixture(),wordHash=digest(word),artifactKey=`users/${owner}/runs/${runId}/artifacts/${artifactId}/v1.docx`;
    objects.set(artifactKey,word);
    await pool.query(`INSERT INTO bb_word_delivery_evidence(id,owner_user_id,run_id,artifact_id,artifact_version,candidate_sha256,byte_size,validator_version,
      quality_status,delivery_status,delivery_code,readback_sha256,readback_byte_size,quality_evidence)
      VALUES($1,$2,$3,$4,1,$5,$6,'synthetic-validator','passed','available','readback_verified',$5,$6,$7)`,
    [evidenceId,owner,runId,artifactId,wordHash,word.length,{sha256:wordHash,byte_size:word.length,validator_version:'synthetic-validator',quality_status:'passed'}]);
    await pool.query(`INSERT INTO bb_artifact_versions(id,version,owner_user_id,run_id,media_type,sha256,object_key,quality_status,delivery_status,word_delivery_evidence_id)
      VALUES($1,1,$2,$3,$4,$5,$6,'passed','available',$7)`,[artifactId,owner,runId,DOCX,wordHash,artifactKey,evidenceId]);
    await pool.query(`INSERT INTO bb_review_artifacts(owner_user_id,project_id,run_id,artifact_id,artifact_version,kind,filename)
      VALUES($1,$2,$3,$4,1,'report','synthetic-report.docx')`,[owner,projectId,runId,artifactId]);
    await pool.query("UPDATE bb_runs SET state='succeeded',artifact_id=$2,artifact_version=1 WHERE id=$1",[runId,artifactId]);
    await pool.query("UPDATE bb_jobs SET state='succeeded' WHERE id=$1",[jobId]);
    const row={id:resultId,prompt_snapshot_ref:promptId,owner_user_id:owner,project_id:projectId,run_id:runId,input_hash:inputHash,
      call_id:callId,result_ref:resultKey,result_sha256:resultHash,byte_size:result.length};
    const read=()=>readReviewMarkdown(readerPool,blobs,row);
    const register=async()=>{
      await pool.query(`INSERT INTO bb_run_working_objects(object_key,owner_user_id,project_id,run_id,filename,sha256,byte_size,media_type)
        VALUES($1,$2,$3,$4,'report.md',$5,$6,'text/markdown')`,[reportKey,owner,projectId,runId,reportHash,markdown.length]);
      await pool.query('INSERT INTO bb_run_working_object_state(object_key,stored_at) VALUES($1,now())',[reportKey]);
      await pool.query(`INSERT INTO bb_run_working_sources(object_key,owner_user_id,project_id,run_id,job_id,execution_version,input_revision,input_hash,
        source_kind,attempt_id,result_schema_version) VALUES($1,$2,$3,$4,$5,1,1,$6,'provider',$7,'codex-review-file-v1')`,
      [reportKey,owner,projectId,runId,jobId,inputHash,callId]);
    };
    const waitForLock=async(waiter:'reader'|'cleaner',blocker:'reader'|'cleaner')=>{
      const names={reader:readerName,cleaner:cleanerName},deadline=Date.now()+5000;
      while(Date.now()<deadline){
        const waiting=(await pool.query(`SELECT 1 FROM pg_stat_activity w WHERE w.datname=current_database() AND w.application_name=$1
          AND w.wait_event_type='Lock' AND w.query LIKE '%pg_advisory_xact_lock%'
          AND EXISTS(SELECT 1 FROM pg_stat_activity b WHERE b.pid=ANY(pg_blocking_pids(w.pid)) AND b.application_name=$2)`,[names[waiter],names[blocker]])).rowCount;
        if(waiting)return;
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      assert.fail(`${waiter} never waited for ${blocker}'s PostgreSQL advisory lock`);
    };
    return {pool,cleanerPool,owner,projectId,runId,row,objects,reads,deletes,reportKey,resultKey,promptKey,read,register,waitForLock,close,
      setBeforeRead:(callback:(key:string)=>Promise<void>)=>{beforeRead=callback;},
      purge:()=>purgeRunWorkingFiles(cleanerPool,blobs,{contentRetentionDays:1,now:()=>new Date('2126-10-26T00:00:00Z'),ownerScope:[owner]})};
  }catch(error){await close();throw error;}
}

test('readable report keeps valid legacy files readable and accepts exact live registry metadata',{skip:!connection,timeout:30000},async()=>{
  const c=await context();try{
    assert.equal((await c.read())?.markdown,'# 合成复核报告\n准确私有文件。');
    await c.register();assert.equal((await c.read())?.content_sha256,digest(c.objects.get(c.reportKey)!));
    assert.deepEqual(c.deletes,[]);
  }finally{await c.close();}
});

test('readable report rechecks parent tombstones after waiting, before any private Blob read',{skip:!connection,timeout:40000},async t=>{
  for(const kind of ['prompt_snapshot','provider_result'] as const)await t.test(kind,async()=>{
    const c=await context(),holder=await c.cleanerPool.connect();let reading:ReturnType<typeof c.read>|undefined;
    try{
      await holder.query('BEGIN');await holder.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',[kind,kind==='prompt_snapshot'?c.row.prompt_snapshot_ref:c.row.id]);
      reading=c.read();void reading.catch(()=>undefined);await c.waitForLock('reader','cleaner');
      await holder.query(`INSERT INTO bb_log_content_tombstones(id,owner_user_id,content_kind,content_id,object_key,reason,policy_version)
        VALUES($1,$2,$3,$4,$5,'retention_expired','synthetic-readable-v1')`,
      [uid(),c.owner,kind,kind==='prompt_snapshot'?c.row.prompt_snapshot_ref:c.row.id,kind==='prompt_snapshot'?c.promptKey:c.resultKey]);
      await holder.query('COMMIT');assert.equal(await bounded(reading,'read did not resume after parent tombstone'),null);
      assert.deepEqual(c.reads,[]);assert.equal(c.objects.has(c.resultKey),true);assert.equal(c.objects.has(c.reportKey),true);
    }finally{await holder.query('ROLLBACK');holder.release();await Promise.allSettled(reading?[reading]:[]);await c.close();}
  });
});

test('readable report rechecks file state and account/project visibility after the file lock wait',{skip:!connection,timeout:60000},async t=>{
  for(const change of ['purged_file','closed_account','deleted_project'] as const)await t.test(change,async()=>{
    const c=await context(),holder=await c.cleanerPool.connect();let reading:ReturnType<typeof c.read>|undefined;
    try{
      await c.register();
      await holder.query('BEGIN');await holder.query("SELECT pg_advisory_xact_lock(hashtext('run_file_object'),hashtext($1))",[c.reportKey]);
      reading=c.read();void reading.catch(()=>undefined);await c.waitForLock('reader','cleaner');
      if(change==='purged_file')await holder.query(`UPDATE bb_run_working_object_state SET purge_started_at=now(),purged_at=now(),
        purge_reason='retention_expired',policy_version='synthetic-readable-v1' WHERE object_key=$1`,[c.reportKey]);
      else if(change==='closed_account')await holder.query("UPDATE bb_users SET status='closed',closed_at=now() WHERE id=$1",[c.owner]);
      else await holder.query('UPDATE bb_projects SET deleted_at=now() WHERE id=$1',[c.projectId]);
      await holder.query('COMMIT');assert.equal(await bounded(reading,'read did not resume after visibility/state change'),null);
      assert.deepEqual(c.reads,[c.resultKey]);assert.equal(c.objects.has(c.reportKey),true,'residual bytes do not override state');
    }finally{await holder.query('ROLLBACK');holder.release();await Promise.allSettled(reading?[reading]:[]);await c.close();}
  });
});

test('real working-file purge waits for readable report validation and denies the next raw read',{skip:!connection,timeout:40000},async()=>{
  const c=await context(),entered=barrier(),release=barrier();
  let reading:ReturnType<typeof c.read>|undefined,purging:ReturnType<typeof c.purge>|undefined;
  try{
    await c.register();c.setBeforeRead(async key=>{if(key===c.reportKey){entered.resolve();await release.promise;}});
    reading=c.read();void reading.catch(()=>undefined);
    await bounded(Promise.race([entered.promise,reading.then(()=>{throw new Error('read completed before held file validation');})]),'report did not reach held private file read');
    purging=c.purge();void purging.catch(()=>undefined);
    await c.waitForLock('cleaner','reader');assert.deepEqual(c.deletes,[]);
    release.resolve();assert.ok(await bounded(reading,'report validation did not finish'));
    const purged=await bounded(purging,'working-file purge did not resume');assert.equal(purged.failed,0);assert.equal(purged.purged,1);
    const before=c.reads.length;assert.equal(await c.read(),null);assert.deepEqual(c.reads.slice(before),[c.resultKey]);
    assert.equal(c.objects.has(c.reportKey),false);
    assert.equal(purged.pending,true,'the legacy Word discovered after the bounded initial selection remains queued');
    const rest=await c.purge();assert.equal(rest.failed,0);assert.equal(rest.purged,1);assert.equal(rest.pending,false);
  }finally{release.resolve();await Promise.allSettled([...(reading?[reading]:[]),...(purging?[purging]:[])]);await c.close();}
});
