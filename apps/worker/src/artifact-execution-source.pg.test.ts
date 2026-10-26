// Synthetic material/Word bytes; real PostgreSQL provenance and Worker input gate.
// Deliberate missing provenance exists only in a transaction on a private clone.
// No Azurite, parser, model call or service process is required.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Pool } from 'pg';
import { emptyUpdateDetails, reportingWindow } from '@bondbuddy/contracts';
import { digest, uid, type PrivateBlobs } from '@bondbuddy/api/data';
import { finish, promoteWordArtifact, type Lease } from '@bondbuddy/api/queue';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { makeWorkerDocxFixture } from './docx-test-fixture.js';
import { isolatedTestDatabase } from './test-database.js';
import { unifiedInputGate, type UnifiedManifest } from './unified-input.js';
import type { InputRevisionRow, RunRow } from './run-pipeline.js';

const connection = await isolatedTestDatabase(undefined, 'artifact-execution-source');
const wordType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

test('Worker unifiedInputGate consumes previous_output only with its complete exact artifact execution binding',
  { skip: !connection, timeout: 30000 }, async t => {
    const pool = new Pool({ connectionString: connection }); t.after(() => pool.end());
    const owner = uid(), projectId = uid(), sourceRunId = uid(), sourceJobId = uid(), targetRunId = uid(), token = uid();
    const objects = new Map<string, Buffer>();
    const blobs: PrivateBlobs = {
      put: async (key, bytes) => { objects.set(key, Buffer.from(bytes)); },
      get: async key => { const bytes = objects.get(key); assert.ok(bytes); return Buffer.from(bytes); },
      getIfExists: async key => objects.has(key) ? Buffer.from(objects.get(key)!) : null,
      getIfExistsBounded: async (key, max) => {
        const bytes = objects.get(key); assert(!bytes || bytes.length <= max); return bytes ? Buffer.from(bytes) : null;
      },
      exists: async key => objects.has(key), delete: async key => { objects.delete(key); },
    };
    await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [owner, `artifact_source_${uid().replaceAll('-', '').slice(0, 16)}`]);
    await pool.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind,issuer_name,market,offering)
      VALUES($1,$2,'Synthetic previous output provenance','update','Synthetic issuer','sse','private')`, [projectId, owner]);
    const materialId = uid(), uploadId = uid(), bytes = makeWorkerDocxFixture({ externalLink: false }), sha = digest(bytes);
    const materialKey = `users/${owner}/projects/${projectId}/synthetic/${materialId}.docx`;
    await blobs.put(materialKey, bytes, wordType);
    await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
      VALUES($1,$2,$3,'synthetic-source.docx',$4,$5,$6,'historical',$7,now()+interval '1 hour','completed')`,
    [uploadId, owner, projectId, wordType, bytes.length, sha, materialKey]);
    await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
      VALUES($1,1,$2,$3,$4,'historical','synthetic-source.docx',$5,$6,$7,$8,'persisted')`,
    [materialId, owner, projectId, uploadId, wordType, bytes.length, sha, materialKey]);
    const insertInput = async (revision: number, manifest: Record<string, unknown>) => {
      const hash = inputManifestHash(manifest);
      await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
        VALUES($1,$2,$3,1,$4,$5,$6,'[]')`, [projectId, revision, owner, hash, manifest, JSON.stringify(manifest.materials ?? [])]);
      return hash;
    };
    await insertInput(1, { synthetic: true, revision: 1 });
    const sourceHash = await insertInput(2, { synthetic: true, revision: 2 });
    await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage)
      VALUES($1,$2,$3,2,$4,$5,'update',$6,'running','word_delivery')`, [sourceRunId, owner, projectId, sourceHash, uid(), digest(uid())]);
    await pool.query(`INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage,lease_token,lease_until,attempts)
      VALUES($1,$2,$3,'update','default','running','word_delivery',$4,now()+interval '10 minutes',1)`, [sourceJobId, owner, sourceRunId, token]);
    const lease: Lease = { owner, runId: sourceRunId, jobId: sourceJobId, token, checkpoint: {}, attempts: 1,
      executionVersion: 1, inputRevision: 2, inputHash: sourceHash };
    const promoted = await promoteWordArtifact(pool, lease, bytes, blobs, 'generated_pair_v1');
    assert.equal(promoted.status, 'available');
    assert.equal((await finish(pool, lease, 'succeeded', { artifactId: promoted.artifactId, artifactVersion: promoted.artifactVersion, blobs })).state, 'succeeded');
    const knowledge = '# Synthetic authoring reference\nRetain source identity and disclose uncertainty.';
    const manifest: UnifiedManifest = {
      issuer_name: 'Synthetic issuer', market: 'sse', offering: 'private',
      update_details: { ...emptyUpdateDetails(), authoring_mode: 'unified_v1', target_reporting_periods: reportingWindow('sse', 'private', '2025-12-31') },
      materials: [{ material_id: materialId, material_version: 1, role: 'historical', sha256: sha }],
      authoring: { version: 'unified_v1', source_prospectuses: [], requirements: [],
        knowledge: [{ path: 'synthetic-reference.md', markdown: knowledge, sha256: digest(knowledge) }],
        knowledge_status: 'authoring_reference_not_compliance_approval',
        previous_output: { artifact_id: promoted.artifactId, version: promoted.artifactVersion, sha256: promoted.sha256,
          run_id: sourceRunId, input_revision: 2 } },
    };
    const targetHash = await insertInput(3, manifest);
    await pool.query('UPDATE bb_projects SET latest_input_revision=3 WHERE id=$1', [projectId]);
    await pool.query(`INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage)
      VALUES($1,$2,$3,3,$4,$5,'update',$6,'queued','queued')`, [targetRunId, owner, projectId, targetHash, uid(), digest(uid())]);
    const run = (await pool.query('SELECT * FROM bb_runs WHERE id=$1', [targetRunId])).rows[0] as RunRow;
    const input = (await pool.query('SELECT * FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 AND revision=3', [owner, projectId])).rows[0] as InputRevisionRow;
    const binding = (await pool.query('SELECT * FROM bb_artifact_execution_bindings WHERE artifact_id=$1 AND artifact_version=$2',
      [promoted.artifactId, promoted.artifactVersion])).rows[0];
    assert.equal(binding.owner_user_id, owner); assert.equal(binding.project_id, projectId); assert.equal(binding.run_id, sourceRunId);
    assert.equal(binding.execution_version, 1); assert.equal(binding.input_revision, 2); assert.equal(binding.input_hash.trim(), sourceHash);
    assert.equal(await unifiedInputGate(pool, run, input), null, 'the exact earlier output remains usable after saving a newer input');
    const tables = ['bb_runs', 'bb_jobs', 'bb_input_revisions', 'bb_run_execution_versions', 'bb_artifact_versions',
      'bb_artifact_execution_bindings', 'bb_word_delivery_evidence', 'bb_run_events', 'bb_outbox',
      'bb_model_call_attempts', 'bb_credit_reservations', 'bb_credit_events'] as const;
    const evidence = async (db: Pick<Pool, 'query'>) => {
      const rows: Record<string, unknown> = {};
      // Fault injection holds one PoolClient; read its evidence sequentially.
      for (const table of tables) rows[table] = (await db.query(
        `SELECT to_jsonb(t) AS row FROM ${table} t WHERE owner_user_id=$1 ORDER BY to_jsonb(t)::text`, [owner])).rows;
      return rows;
    };
    const before = await evidence(pool), blobHashes = [...objects].map(([key, value]) => [key, digest(value)]).sort();
    const fail = { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' };
    // Recompute the candidate input hash so these cases reach previous_output's
    // database lookup rather than failing the outer manifest hash check.
    for (const change of [{ artifact_id: uid() }, { version: promoted.artifactVersion + 1 }, { sha256: 'f'.repeat(64) },
      { run_id: uid() }, { input_revision: 1 }]) {
      const changed = structuredClone(manifest);
      changed.authoring.previous_output = { ...changed.authoring.previous_output!, ...change };
      const hash = inputManifestHash(changed);
      assert.deepEqual(await unifiedInputGate(pool, { ...run, input_hash: hash }, { ...input, manifest: changed, input_hash: hash }), fail);
    }
    assert.deepEqual(await evidence(pool), before, 'rejected source pins cannot mutate history or credits');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE bb_artifact_execution_bindings DISABLE TRIGGER bb_artifact_execution_immutable');
      await client.query('DELETE FROM bb_artifact_execution_bindings WHERE artifact_id=$1 AND artifact_version=$2', [promoted.artifactId, promoted.artifactVersion]);
      await client.query('ALTER TABLE bb_artifact_execution_bindings ENABLE TRIGGER bb_artifact_execution_immutable');
      const db = client as unknown as Pool;
      const missing = await evidence(db);
      assert.deepEqual(missing.bb_artifact_versions, before.bb_artifact_versions);
      assert.deepEqual(missing.bb_runs, before.bb_runs);
      assert.equal((await client.query('SELECT 1 FROM bb_execution_artifact_versions WHERE id=$1 AND version=$2', [promoted.artifactId, promoted.artifactVersion])).rowCount, 0);
      assert.deepEqual(await unifiedInputGate(db, run, input), fail, 'an otherwise available successful output cannot fall back to its legacy artifact/run');
      assert.deepEqual(await evidence(db), missing, 'the real gate cannot repair or change missing provenance');
    } finally { await client.query('ROLLBACK'); client.release(); }
    assert.deepEqual(await evidence(pool), before, 'rollback restores the exact original binding and all prior history');
    assert.equal(await unifiedInputGate(pool, run, input), null);
    assert.deepEqual(await evidence(pool), before, 'a successful source check also leaves history and credits unchanged');
    assert.deepEqual([...objects].map(([key, value]) => [key, digest(value)]).sort(), blobHashes);
  });
