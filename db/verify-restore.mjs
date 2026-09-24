import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createServer } from '../apps/api/dist/server.js';
if (!process.env.DATABASE_URL || !process.env.RESTORE_DATABASE_URL) throw new Error('DATABASE_URL and RESTORE_DATABASE_URL required');
const source=new Pool({connectionString:process.env.DATABASE_URL});
const restored=new Pool({connectionString:process.env.RESTORE_DATABASE_URL});
try {
  for(const table of ['bb_schema_migrations','bb_projects','bb_uploads','bb_material_versions','bb_input_revisions','bb_runs','bb_run_events','bb_outbox','bb_artifact_versions','bb_artifact_download_grants']){
    const a=await source.query(`SELECT count(*)::int AS n FROM ${table}`),b=await restored.query(`SELECT count(*)::int AS n FROM ${table}`);
    assert.equal(b.rows[0].n,a.rows[0].n,`${table} count`);
  }
  const client=await restored.connect();
  try {
    await client.query('BEGIN');
    await assert.rejects(client.query("UPDATE bb_input_revisions SET input_hash=repeat('a',64) WHERE project_id=(SELECT project_id FROM bb_input_revisions LIMIT 1)"),error=>error.code==='23514');
    await client.query('ROLLBACK');
    await client.query('BEGIN');
    await assert.rejects(client.query('INSERT INTO bb_runs SELECT * FROM bb_runs LIMIT 1'),error=>error.code==='23505');
    await client.query('ROLLBACK');
  } finally {client.release();}
  const app=createServer({pool:restored,principal:async()=>({userId:'synthetic-alice',csrfVerified:true}),allowedOrigin:'http://bondbuddy.test',enableRunStaging:true});
  try {
    const project=(await restored.query("SELECT id FROM bb_projects WHERE owner_user_id='synthetic-alice' ORDER BY created_at LIMIT 1")).rows[0];
    const stale=await app.inject({method:'PATCH',url:`/api/v1/projects/${project.id}`,headers:{origin:'http://bondbuddy.test','if-match':'1'},payload:{name:'restore-conflict'}});
    assert.equal(stale.statusCode,409);assert.equal(stale.json().code,'INPUT_REVISION_CONFLICT');
    const run=(await restored.query("SELECT * FROM bb_runs WHERE owner_user_id='synthetic-alice' LIMIT 1")).rows[0];
    const key=await app.inject({method:'POST',url:'/api/v1/runs/execute',headers:{origin:'http://bondbuddy.test'},payload:{execution_request_id:run.execution_request_id,project_id:run.project_id,input_revision:run.input_revision,input_hash:run.input_hash.trim(),task_kind:run.task_kind,input_manifest_ref:'changed-after-restore',storage_origin:'cloud',workspace_id:'restore-check'}});
    assert.equal(key.statusCode,409);assert.equal(key.json().code,'IDEMPOTENCY_CONFLICT');
  } finally {await app.close();}
  process.stdout.write('Restore counts, snapshot/unique constraints, and stable 409 API codes verified\n');
} finally {await source.end();await restored.end();}
