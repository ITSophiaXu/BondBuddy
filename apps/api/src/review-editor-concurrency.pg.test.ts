// Synthetic input/editor bodies; real PostgreSQL deadlocks and the real trusted
// registration transaction. The disposable local acceptance role is superuser
// so these tests can set session deadlock_timeout deterministically.
import assert from 'node:assert/strict';
import test from 'node:test';
import {Pool} from 'pg';
import type {ReviewEditorSnapshot} from '@bondbuddy/contracts';
import {digest,Problem,uid} from './data.js';
import {inputManifestHash} from './production-rule-pin.js';
import type {Lease} from './queue.js';
import {registerReviewEditorSnapshot} from './review-editor.js';
import {isolatedTestDatabase} from './test-database.js';

const connection=await isolatedTestDatabase(undefined,'review-editor-concurrency');
type Outcome<T>={ok:true;value:T}|{ok:false;error:unknown};
const observe=<T>(promise:Promise<T>):Promise<Outcome<T>>=>promise.then<Outcome<T>,Outcome<T>>(value=>({ok:true,value}),error=>({ok:false,error}));
const code=(error:unknown)=>(error as {code?:string})?.code;
const conflict=(error:unknown)=>error instanceof Problem&&error.status===409&&error.code==='INPUT_REVISION_CONFLICT';

async function fixture(){
  const pool=new Pool({connectionString:connection,statement_timeout:10000});
  const owner=uid(),projectId=uid(),runId=uid(),jobId=uid(),materialId=uid(),uploadId=uid(),token=uid();
  await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,`editor_race_${uid().replaceAll('-','').slice(0,16)}`]);
  await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic editor concurrency','review')",[projectId,owner]);
  const bytes=Buffer.from('Synthetic concurrency PDF registration'),sourceHash=digest(bytes);
  await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
    VALUES($1,$2,$3,'synthetic-concurrency.pdf','application/pdf',$4,$5,'other',$6,now()+interval '1 hour','completed')`,
  [uploadId,owner,projectId,bytes.length,sourceHash,`users/${owner}/uploads/${uploadId}`]);
  await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
    VALUES($1,1,$2,$3,$4,'other','synthetic-concurrency.pdf','application/pdf',$5,$6,$7,'persisted')`,
  [materialId,owner,projectId,uploadId,bytes.length,sourceHash,`users/${owner}/projects/${projectId}/materials/${materialId}`]);
  const pin={material_id:materialId,material_version:1,sha256:sourceHash};
  const input={source_material_ref:pin,material_versions:[pin],requirements:['Synthetic concurrency requirement'],as_of:null};
  const origin={version:'review-execution-origin-v1',entrypoint:'quick_action',accepted_proposal:null,context_report_ref:null};
  const manifest={draft_revision:1,project_kind:'review',materials:[{...pin,role:'other'}],review:{version:'review_v1',
    operation:'full_review',version_number:1,report_id:uid(),source_report_id:null,source_report_sha256:null,finding_ids:[],input,origin,
    file_delivery:{version:'review-correction-v2',knowledge:[]}}};
  const hash=inputManifestHash(manifest);
  await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
    VALUES($1,1,$2,1,$3,$4,$5,'[]')`,[projectId,owner,hash,manifest,JSON.stringify(manifest.materials)]);
  await pool.query('UPDATE bb_projects SET latest_input_revision=1 WHERE id=$1',[projectId]);
  await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage)
    VALUES($1,$2,$3,1,$4,$5,'review',$4,'running','word_delivery')`,[runId,owner,projectId,hash,uid()]);
  await pool.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage,lease_token,lease_until,attempts)
    VALUES($1,$2,$3,'review','default','running','word_delivery',$4,now()+interval '10 minutes',1)`,[jobId,owner,runId,token]);
  await pool.query(`INSERT INTO bb_review_executions(run_id,owner_user_id,project_id,version,operation,snapshot)
    VALUES($1,$2,$3,1,'full_review',$4)`,[runId,owner,projectId,{input,origin,finding_ids:[],input_version:1}]);
  const lease:Lease={owner,runId,jobId,token,checkpoint:{},attempts:1,executionVersion:1,inputRevision:1,inputHash:hash};
  const snapshot:ReviewEditorSnapshot={version:'review-editor-v1',source_filename:'synthetic-concurrency.pdf',source_sha256:sourceHash,
    source_format:'pdf',warnings:['Synthetic concurrency only.'],paragraphs:[],issues:[]};
  return {pool,owner,projectId,runId,jobId,lease,snapshot};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;

async function waitFor(pool:Pool,description:string,ready:()=>Promise<boolean>){
  const deadline=Date.now()+5000;
  while(Date.now()<deadline){
    if(await ready())return;
    await new Promise(resolve=>setTimeout(resolve,15));
  }
  const activity=(await pool.query(`SELECT pid,application_name,state,wait_event_type,wait_event,query,pg_blocking_pids(pid) AS blockers
    FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()`)).rows;
  assert.fail(`${description}: ${JSON.stringify(activity)}`);
}
async function blockedBy(pool:Pool,waiter:number,blocker:number,event?:string){
  return !!(await pool.query(`SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'
    AND $2::integer=ANY(pg_blocking_pids(pid)) AND ($3::text IS NULL OR wait_event=$3)`,[waiter,blocker,event??null])).rowCount;
}
async function exactRows(f:Fixture){
  return (await f.pool.query(`SELECT e.*,l.snapshot AS legacy_snapshot,l.sha256 AS legacy_sha256,l.created_at AS legacy_created_at,
    e.snapshot=l.snapshot AND e.sha256=l.sha256 AND e.created_at=l.created_at AS mirror_exact
    FROM bb_review_execution_editors e JOIN bb_review_editors l USING(owner_user_id,project_id,run_id)
    WHERE e.run_id=$1`,[f.runId])).rows;
}

/** Pause only the new writer inside its canonical BEFORE INSERT. Parent/run/job
 * locks are already held, and the legacy writer never waits at this test seam. */
async function installBarrier(f:Fixture,writerName:string,key:number){
  const suffix=uid().replaceAll('-',''),fn=`bb_test_editor_gate_${suffix}`,trigger=`aa_test_editor_gate_${suffix}`;
  await f.pool.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF current_setting('application_name')='${writerName}' AND NEW.run_id='${f.runId}' THEN
      PERFORM pg_advisory_xact_lock(74291,${key});
    END IF; RETURN NEW; END; $$`);
  await f.pool.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON bb_review_execution_editors FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
  return async()=>{
    await f.pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON bb_review_execution_editors`);
    await f.pool.query(`DROP FUNCTION IF EXISTS ${fn}()`);
  };
}

async function race(expireBeforeRetry:boolean){
  const f=await fixture(),writerName=`editor-new-${uid()}`,oldName=`editor-old-${uid()}`;
  // A short new-writer detector and a long old-writer detector ensure the real
  // new registration is the deadlock victim for the retry/expiry assertion.
  const writerPool=new Pool({connectionString:connection,max:1,application_name:writerName,
    options:'-c deadlock_timeout=100ms',statement_timeout:10000});
  const control=await f.pool.connect(),legacy=await f.pool.connect();
  const key=Number.parseInt(uid().slice(0,8),16)%2147483647;
  let cleanupBarrier:(()=>Promise<void>)|undefined,newTask:Promise<Outcome<void>>|undefined,oldTask:Promise<Outcome<unknown>>|undefined;
  let newPid:number|undefined,oldPid:number|undefined,completed=false;
  try{
    cleanupBarrier=await installBarrier(f,writerName,key);
    const controlPid=Number((await control.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    newPid=Number((await writerPool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    oldPid=Number((await legacy.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    await legacy.query("SELECT set_config('application_name',$1,false)",[oldName]);
    await legacy.query('BEGIN');await legacy.query("SET LOCAL deadlock_timeout='5s'");
    await legacy.query("SET LOCAL statement_timeout='10s'");
    await control.query('SELECT pg_advisory_lock(74291,$1)',[key]);
    newTask=observe(registerReviewEditorSnapshot(writerPool,f.lease,f.projectId,f.snapshot));
    await waitFor(f.pool,'new registration reached its canonical barrier',()=>blockedBy(f.pool,newPid!,controlPid,'advisory'));
    // now() inside the real new transaction is precisely xact_start. Use its
    // textual value to retain microseconds that JavaScript Date would truncate.
    const createdAt=(await f.pool.query('SELECT xact_start::text AS created_at FROM pg_stat_activity WHERE pid=$1',[newPid])).rows[0].created_at as string;
    assert.ok(createdAt);
    oldTask=observe(legacy.query(`INSERT INTO bb_review_editors(owner_user_id,project_id,run_id,snapshot,sha256,created_at)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(run_id) DO NOTHING`,
    [f.owner,f.projectId,f.runId,f.snapshot,inputManifestHash(f.snapshot),createdAt]));
    await waitFor(f.pool,'legacy unique row is waiting on the new writer parent lock',()=>blockedBy(f.pool,oldPid!,newPid!));
    await control.query('SELECT pg_advisory_unlock(74291,$1)',[key]);
    const old=await oldTask;
    if(!old.ok){
      // Victim selection is asserted honestly. A platform scheduling anomaly
      // may abort the old writer; normal recovery explicitly replays it once.
      assert.equal(code(old.error),'40P01');
      await legacy.query('ROLLBACK');
      assert.equal(expireBeforeRetry,false,'expiry case must exercise a real rollback/retry of the new registration');
      const current=await newTask;
      if(!current.ok)throw current.error;
      const canonical=(await f.pool.query('SELECT created_at::text AS created_at FROM bb_review_execution_editors WHERE run_id=$1',[f.runId])).rows[0];
      await legacy.query(`INSERT INTO bb_review_editors(owner_user_id,project_id,run_id,snapshot,sha256,created_at)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(run_id) DO NOTHING`,
      [f.owner,f.projectId,f.runId,f.snapshot,inputManifestHash(f.snapshot),canonical.created_at]);
    }else{
      // The successful old INSERT proves the initial new transaction released
      // its parent locks. The real retry must now wait on old's FK KEY SHARE.
      await waitFor(f.pool,'new registration retried and is waiting on the old transaction',()=>blockedBy(f.pool,newPid!,oldPid!));
      const retriedAt=(await f.pool.query('SELECT xact_start::text AS created_at FROM pg_stat_activity WHERE pid=$1',[newPid])).rows[0].created_at;
      assert.notEqual(retriedAt,createdAt,'the registration retries the whole transaction after the real deadlock');
      if(expireBeforeRetry){
        await control.query("UPDATE bb_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[f.jobId]);
        await legacy.query('ROLLBACK');
      }else await legacy.query('COMMIT');
      const current=await newTask;
      if(expireBeforeRetry){
        assert.equal(current.ok,false,'a rolled-back registration must recheck its lease on retry');
        if(current.ok)assert.fail('Expired retry unexpectedly registered an editor');
        assert.ok(conflict(current.error),String(current.error));
      }else if(!current.ok)throw current.error;
    }
    if(expireBeforeRetry){
      for(const table of ['bb_review_execution_editors','bb_review_editors'])
        assert.equal((await f.pool.query(`SELECT 1 FROM ${table} WHERE run_id=$1`,[f.runId])).rowCount,0,'both aborted writes leave no partial editor');
    }else{
      const saved=await exactRows(f);assert.equal(saved.length,1);assert.equal(saved[0].mirror_exact,true);
      assert.equal(saved[0].owner_user_id,f.owner);assert.equal(saved[0].project_id,f.projectId);
      assert.equal(saved[0].execution_version,1);assert.equal(saved[0].input_revision,1);assert.equal(saved[0].input_hash.trim(),f.lease.inputHash);
      assert.deepEqual(saved[0].snapshot,f.snapshot);assert.equal(saved[0].sha256.trim(),inputManifestHash(f.snapshot));
      await assert.rejects(registerReviewEditorSnapshot(writerPool,{...f.lease,token:uid()},f.projectId,f.snapshot),conflict);
      await assert.rejects(registerReviewEditorSnapshot(writerPool,{...f.lease,owner:uid()},f.projectId,f.snapshot),
        error=>error instanceof Problem&&error.status===404);
      assert.deepEqual(await exactRows(f),saved,'deadlock recovery does not weaken owner or lease gates');
    }
    const job=(await f.pool.query('SELECT state,lease_token,lease_until FROM bb_jobs WHERE id=$1',[f.jobId])).rows[0];
    assert.equal(job.state,'running');assert.equal(job.lease_token,f.lease.token);
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM bb_run_execution_versions WHERE run_id=$1',[f.runId])).rows[0].n,1);
    assert.equal((await f.pool.query('SELECT count(*)::int n FROM bb_run_execution_deliveries WHERE run_id=$1',[f.runId])).rows[0].n,0,
      'registration and deadlock recovery do not publish a delivery');
    completed=true;
  }finally{
    await control.query('SELECT pg_advisory_unlock_all()').catch(()=>undefined);
    if(!completed){
      for(const pid of [newPid,oldPid])if(pid)await control.query('SELECT pg_cancel_backend($1)',[pid]).catch(()=>undefined);
    }
    await legacy.query('ROLLBACK').catch(()=>undefined);
    await Promise.allSettled([...(newTask?[newTask]:[]),...(oldTask?[oldTask]:[])]);
    try{await cleanupBarrier?.();}finally{
      control.release();legacy.release();
      await Promise.all([writerPool.end(),f.pool.end()]);
    }
  }
}

test('real legacy/new registration deadlock converges to one exact V1 mirror and preserves owner/lease gates',
  {skip:!connection,timeout:45000},async()=>race(false));
test('a real registration deadlock retry rechecks an expired lease and leaves neither editor table partially written',
  {skip:!connection,timeout:45000},async()=>race(true));
