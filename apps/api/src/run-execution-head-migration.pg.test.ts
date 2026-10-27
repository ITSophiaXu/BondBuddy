// Synthetic migrated PostgreSQL only. Never disables executable-version policy.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {Pool} from 'pg';
import {uid} from './data.js';
import {inputManifestHash} from './production-rule-pin.js';
import {isolatedTestDatabase} from './test-database.js';
import {assertRunExecution} from './run-execution.js';

const connection=await isolatedTestDatabase(undefined,'run-execution-head-migration');
const migration=await readFile(new URL('../../../db/migrations/0132_run_execution_heads.sql',import.meta.url),'utf8');

test('active head migration preserves exact historical V1 origins and refuses incomplete backfill atomically',
  {skip:!connection,timeout:60000},async()=>{
  const pool=new Pool({connectionString:connection,max:1}),c=await pool.connect();
  try{
    const owner=uid(),projectId=uid(),runId=uid();
    await c.query('BEGIN');
    await c.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,`head_${uid().replaceAll('-','').slice(0,16)}`]);
    await c.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic historical head','update')",[projectId,owner]);
    for(const revision of [1,2,3]){
      const manifest={synthetic:true,revision};
      await c.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
        VALUES($1,$2,$3,1,$4,$5,'[]','[]')`,[projectId,revision,owner,inputManifestHash(manifest),manifest]);
    }
    const hash=inputManifestHash({synthetic:true,revision:2});
    await c.query('UPDATE bb_projects SET latest_input_revision=3 WHERE id=$1',[projectId]);
    await c.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage,created_at)
      VALUES($1,$2,$3,2,$4,$1,'update',$4,'paused','user_paused','2026-10-26T00:00:00.123456Z')`,[runId,owner,projectId,hash]);
    const run=(await c.query('SELECT * FROM bb_runs WHERE id=$1',[runId])).rows[0];
    // Flush valid origin FK events before removing the historical test scaffold.
    await c.query('SET CONSTRAINTS ALL IMMEDIATE');
    await c.query('DROP TRIGGER bb_run_initial_execution_head ON bb_run_execution_versions');
    await c.query('DROP TABLE bb_run_execution_heads');
    await c.query('DROP FUNCTION bb_check_initial_execution_head()');
    await c.query('DROP FUNCTION bb_create_initial_execution_head()');

    await c.query('SAVEPOINT incomplete_origin');
    await c.query('ALTER TABLE bb_run_execution_versions DISABLE TRIGGER bb_run_execution_immutable');
    await c.query('DELETE FROM bb_run_execution_versions WHERE run_id=$1',[runId]);
    await c.query('ALTER TABLE bb_run_execution_versions ENABLE TRIGGER bb_run_execution_immutable');
    await assert.rejects(c.query(migration),{code:'23514',constraint:'bb_initial_execution_head_origin'});
    await c.query('ROLLBACK TO SAVEPOINT incomplete_origin');
    assert.equal((await c.query("SELECT to_regclass('bb_run_execution_heads') AS name")).rows[0].name,null,
      'failed backfill leaves no partial head table');
    await c.query(migration);
    const head=(await c.query(`SELECT h.*,h.activated_at=e.created_at AS exact_time,to_char(h.activated_at,'US') AS micros
      FROM bb_run_execution_heads h JOIN bb_run_execution_versions e ON e.run_id=h.run_id AND e.execution_version=h.execution_version
      WHERE h.run_id=$1`,[runId])).rows[0];
    assert.equal(head.owner_user_id,owner);assert.equal(head.project_id,projectId);
    assert.equal(head.execution_version,1);assert.equal(head.input_revision,2);assert.equal(head.input_hash.trim(),hash);
    assert.equal(head.exact_time,true);assert.equal(head.micros,'123456');
    assert.deepEqual(await assertRunExecution(c,run),{executionVersion:1,inputRevision:2,inputHash:hash});
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM bb_runs r LEFT JOIN bb_run_execution_heads h
      ON h.owner_user_id=r.owner_user_id AND h.project_id=r.project_id AND h.run_id=r.id WHERE h.run_id IS NULL`)).rows[0].n,0);
  }finally{await c.query('ROLLBACK');c.release();await pool.end();}
});
