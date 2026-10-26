// Synthetic PostgreSQL registration fences with in-memory private bytes only.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {Pool} from 'pg';
import {digest,transaction,type PrivateBlobs} from './data.js';
import {savePromptSnapshot} from './log-ops.js';
import {saveSnapshotRef} from './observability.js';
import {isolatedTestDatabase} from './test-database.js';

const connection=await isolatedTestDatabase('BB_TEST_PROMPT_EXECUTION_DATABASE_URL');
test('independent prompt registration requires the initial execution before Blob writes and intent locks',{skip:!connection,timeout:30000},async t=>{
  const applicationName=`synthetic-prompt-execution-${randomUUID()}`;
  const pool=new Pool({connectionString:connection,max:4,application_name:applicationName});
  const observer=new Pool({connectionString:connection,max:2});
  const objects=new Map<string,Buffer>();let writes=0;
  const blobs:PrivateBlobs={
    put:async(key,bytes)=>{writes++;objects.set(key,Buffer.from(bytes));},
    get:async key=>{const bytes=objects.get(key);if(!bytes)throw new Error('Synthetic object missing');return Buffer.from(bytes);},
    getIfExists:async key=>objects.get(key)??null,
    getIfExistsBounded:async(key,max)=>{const bytes=objects.get(key);return bytes&&bytes.length<=max?bytes:null;},
    exists:async key=>objects.has(key),delete:async key=>{objects.delete(key);},
  };
  async function fixture(owner=`synthetic-prompt-owner-${randomUUID()}`){
    const projectId=randomUUID(),runId=randomUUID(),inputHash=digest(randomUUID());
    await observer.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic prompt boundary','review')",[projectId,owner]);
    await observer.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
      VALUES($1,1,$2,1,$3,'{}','[]','[]')`,[projectId,owner,inputHash]);
    await observer.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state)
      VALUES($1,$2,$3,1,$4,$1,'review',$4,'running')`,[runId,owner,projectId,inputHash]);
    return {owner,projectId,runId,inputHash};
  }
  const prompt=(f:Awaited<ReturnType<typeof fixture>>,version=1)=>({owner:f.owner,projectId:f.projectId,runId:f.runId,
    kind:'model_request' as const,version,body:'Synthetic safe prompt',inputRevision:1,inputHash:f.inputHash});
  async function registered(f:Awaited<ReturnType<typeof fixture>>){
    return {refs:(await observer.query('SELECT id FROM bb_snapshot_refs WHERE run_id=$1',[f.runId])).rows,
      events:(await observer.query('SELECT id FROM bb_observability_events WHERE run_id=$1',[f.runId])).rows,
      outbox:(await observer.query('SELECT id FROM bb_outbox WHERE owner_user_id=$1',[f.owner])).rows};
  }
  async function corruptExecution(f:Awaited<ReturnType<typeof fixture>>,kind:'missing'|'wrong_hash'){
    // Deliberate damage is restricted to this file's private database clone.
    // Normal writers cannot bypass the immutable trigger.
    await transaction(observer,async client=>{
      await client.query('ALTER TABLE bb_run_execution_versions DISABLE TRIGGER bb_run_execution_immutable');
      if(kind==='missing')await client.query('DELETE FROM bb_run_execution_versions WHERE run_id=$1',[f.runId]);
      else await client.query('UPDATE bb_run_execution_versions SET input_hash=$2 WHERE run_id=$1',[f.runId,digest('different synthetic execution')]);
      await client.query('ALTER TABLE bb_run_execution_versions ENABLE TRIGGER bb_run_execution_immutable');
    });
  }
  async function waitForWriterLock(label='run'){
    const deadline=Date.now()+5000;
    while(Date.now()<deadline){
      if((await observer.query(`SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'
        AND cardinality(pg_blocking_pids(pid))>0`,[applicationName])).rowCount)return;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.fail(`prompt writer did not reach the held ${label} lock`);
  }
  try{
    await t.test('V1 registers with exact input pins and with legacy optional pins omitted',async()=>{
      const f=await fixture();
      const first=await savePromptSnapshot(pool,blobs,prompt(f));assert.ok(first);
      const {inputRevision:_revision,inputHash:_hash,...withoutPins}=prompt(f,2);
      const second=await savePromptSnapshot(pool,blobs,withoutPins);assert.ok(second);
      assert.equal((await registered(f)).refs.length,2);
      assert.equal((await observer.query('SELECT count(*)::int n FROM bb_prompt_blob_intents WHERE owner_user_id=$1 AND registered_at IS NOT NULL',[f.owner])).rows[0].n,2);
    });
    for(const kind of ['missing','wrong_hash'] as const)await t.test(`${kind} execution rejects both independent registration paths without new durable evidence`,async()=>{
      const f=await fixture();await corruptExecution(f,kind);
      const before=await registered(f),beforeWrites=writes;
      await assert.rejects(savePromptSnapshot(pool,blobs,prompt(f)),{status:409,code:'INPUT_REVISION_CONFLICT'});
      assert.equal(writes,beforeWrites,'execution validation precedes private Blob writes');
      const objectKey=`users/${f.owner}/projects/${f.projectId}/snapshots/${randomUUID()}`,bytes=Buffer.from('Existing synthetic bytes');objects.set(objectKey,bytes);
      await assert.rejects(saveSnapshotRef(pool,{...prompt(f),objectKey,sha256:digest(bytes),redactionVersion:'scrub_v1',blobs}),{status:409,code:'INPUT_REVISION_CONFLICT'});
      assert.deepEqual(await registered(f),before);
      const intent=(await observer.query('SELECT registered_at,cleared_at FROM bb_prompt_blob_intents WHERE owner_user_id=$1',[f.owner])).rows[0];
      assert.equal(intent.registered_at,null);assert.ok(intent.cleared_at,'the committed recovery address is still compensated');
    });
    await t.test('wrong owner, project, revision and hash retain their original not-found semantics',async()=>{
      const f=await fixture(),other=await fixture(),sameOwnerOther=await fixture(f.owner),beforeWrites=writes;
      for(const invalid of [{...prompt(f),owner:other.owner,projectId:other.projectId,inputHash:other.inputHash},
        {...prompt(f),projectId:sameOwnerOther.projectId,inputHash:sameOwnerOther.inputHash},
        {...prompt(f),inputRevision:2},{...prompt(f),inputHash:digest('wrong explicit input pin')}]){
        await assert.rejects(savePromptSnapshot(pool,blobs,invalid),{status:404,code:'NOT_FOUND'});
      }
      assert.equal(writes,beforeWrites);assert.equal((await registered(f)).refs.length,0);
    });
    await t.test('waiting for the run leaves its committed intent available to another transaction',async()=>{
      const f=await fixture(),holder=await observer.connect(),beforeWrites=writes;
      await holder.query('BEGIN');
      await holder.query("SET LOCAL statement_timeout='5s'");
      await holder.query('SELECT id FROM bb_runs WHERE id=$1 FOR UPDATE',[f.runId]);
      const writing=savePromptSnapshot(pool,blobs,prompt(f)).then(value=>({value,error:null}),error=>({value:null,error}));
      try{
        await waitForWriterLock();assert.equal(writes,beforeWrites);
        const intent=(await holder.query('SELECT id FROM bb_prompt_blob_intents WHERE owner_user_id=$1 FOR UPDATE NOWAIT',[f.owner])).rows[0];
        assert.ok(intent,'the intent is committed before Blob IO, but is not locked ahead of the run');
        await holder.query('COMMIT');
        const result=await writing;assert.equal(result.error,null);assert.ok(result.value);
        assert.equal(writes,beforeWrites+1);assert.equal((await registered(f)).refs.length,1);
      }finally{await holder.query('ROLLBACK');holder.release();await writing;}
    });
    await t.test('a project-first writer can lock the run while snapshot registration waits for the project',async()=>{
      const f=await fixture(),holder=await observer.connect(),beforeWrites=writes;
      const objectKey=`users/${f.owner}/projects/${f.projectId}/snapshots/${randomUUID()}`,bytes=Buffer.from('Existing synthetic project-lock bytes');
      objects.set(objectKey,bytes);
      await holder.query('BEGIN');
      await holder.query("SET LOCAL statement_timeout='5s'");
      await holder.query('SELECT id FROM bb_projects WHERE owner_user_id=$1 AND id=$2 FOR UPDATE',[f.owner,f.projectId]);
      // Use the direct registration path: savePromptSnapshot's initial intent
      // INSERT also needs the project FK and would mask the lock-order regression.
      const writing=saveSnapshotRef(pool,{...prompt(f),objectKey,sha256:digest(bytes),redactionVersion:'scrub_v1',blobs})
        .then(value=>({value,error:null}),error=>({value:null,error}));
      try{
        await waitForWriterLock('project');
        // This is the project -> run sequence used by review recovery/report
        // registration. The old run-first snapshot guard makes NOWAIT fail here.
        const run=(await holder.query('SELECT id FROM bb_runs WHERE id=$1 FOR UPDATE NOWAIT',[f.runId])).rows[0];
        assert.equal(run.id,f.runId,'a snapshot waiting for the project cannot hold its run');
        assert.equal((await holder.query('SELECT count(*)::int n FROM bb_snapshot_refs WHERE run_id=$1',[f.runId])).rows[0].n,0);
        await holder.query('COMMIT');
        const result=await writing;assert.equal(result.error,null);assert.ok(result.value);
        assert.equal(writes,beforeWrites,'direct registration does not write new private bytes');
        assert.equal((await registered(f)).refs.length,1);
        const ref=(await observer.query('SELECT project_id,input_revision,input_hash,object_key FROM bb_snapshot_refs WHERE id=$1',[result.value])).rows[0];
        assert.deepEqual(ref,{project_id:f.projectId,input_revision:1,input_hash:f.inputHash,object_key:objectKey});
      }finally{await holder.query('ROLLBACK');holder.release();await writing;}
    });
  }finally{await pool.end();await observer.end();}
});
