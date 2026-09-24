import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createServer } from '../apps/api/dist/server.js';
import { azureBlobs, digest } from '../apps/api/dist/data.js';
import { inspectDocx } from '../apps/api/dist/docx-inspector.js';
import { runStorageLifecycle, storageLifecyclePolicyFromEnv } from '../apps/api/dist/storage-lifecycle.js';

let stage = 'configuration';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function databaseIdentity(connectionString) {
  const url = new URL(connectionString);
  return `${url.protocol}//${url.hostname}:${url.port || '5432'}/${decodeURIComponent(url.pathname.slice(1))}`;
}

async function referencedMaterials(pool, owner) {
  const revisions = await pool.query('SELECT project_id,material_versions,manifest FROM bb_input_revisions WHERE owner_user_id=$1 ORDER BY project_id,revision', [owner]);
  const refs = new Map();
  for (const revision of revisions.rows) {
    const values = [
      ...(Array.isArray(revision.material_versions) ? revision.material_versions : []),
      ...(Array.isArray(revision.manifest?.materials) ? revision.manifest.materials : [])
    ];
    for (const ref of values) {
      if (typeof ref?.material_id !== 'string' || !Number.isInteger(ref.material_version)) continue;
      refs.set(`${revision.project_id}\u0000${ref.material_id}\u0000${ref.material_version}`, {
        projectId: revision.project_id, materialId: ref.material_id, version: ref.material_version
      });
    }
  }
  const materials = [];
  for (const ref of refs.values()) {
    const result = await pool.query(`SELECT id,version,owner_user_id,project_id,object_key,sha256,deleted_at
      FROM bb_material_versions WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=$4`,
    [owner, ref.projectId, ref.materialId, ref.version]);
    assert.equal(result.rowCount, 1);
    materials.push(result.rows[0]);
  }
  return materials;
}

async function verifyHashes(blobs, materials) {
  for (const material of materials) {
    const bytes = await blobs.getIfExists(material.object_key);
    assert.ok(bytes, 'a referenced Blob is present');
    assert.equal(digest(bytes), material.sha256.trim(), 'a referenced Blob hash matches PostgreSQL');
  }
}

async function verifyWordDelivery(pool, blobs, owner) {
  const rows=await pool.query(`SELECT e.*,a.object_key,a.sha256 AS artifact_sha256,a.delivery_status AS artifact_delivery_status
    FROM bb_word_delivery_evidence e JOIN bb_artifact_versions a
      ON a.owner_user_id=e.owner_user_id AND a.run_id=e.run_id AND a.id=e.artifact_id AND a.version=e.artifact_version AND a.word_delivery_evidence_id=e.id
    WHERE e.owner_user_id=$1 AND e.delivery_status='available' ORDER BY e.created_at,e.id`,[owner]);
  assert.ok(rows.rowCount>0,'the restore fixture includes available Word delivery evidence');
  for(const evidence of rows.rows){
    const bytes=await blobs.getIfExistsBounded(evidence.object_key,64*1024*1024);
    assert.ok(bytes,'a verified Word Blob is present after restore');
    assert.equal(bytes.length,Number(evidence.byte_size),'restored Word byte size');
    assert.equal(digest(bytes),evidence.candidate_sha256.trim(),'restored Word candidate hash');
    assert.equal(evidence.readback_sha256.trim(),evidence.candidate_sha256.trim(),'restored Word readback hash');
    assert.equal(evidence.artifact_sha256.trim(),evidence.candidate_sha256.trim(),'restored artifact hash');
    const inspection=inspectDocx(bytes);
    assert.equal(inspection.quality_status,'passed','restored Word bytes pass the pinned validator');
    assert.equal(inspection.validator_version,evidence.validator_version);
    assert.equal(inspection.sha256,evidence.candidate_sha256.trim());
    assert.equal(evidence.quality_evidence.quality_status,'passed');
    await assert.rejects(pool.query('UPDATE bb_word_delivery_evidence SET byte_size=byte_size+1 WHERE id=$1',[evidence.id]),error=>error.code==='23514');
    await assert.rejects(pool.query('DELETE FROM bb_word_delivery_evidence WHERE id=$1',[evidence.id]),error=>error.code==='23514');
  }
  return rows.rows;
}

async function run() {
  const sourceUrl = required('DATABASE_URL');
  const restoredUrl = required('RESTORE_DATABASE_URL');
  assert.notEqual(databaseIdentity(sourceUrl), databaseIdentity(restoredUrl), 'restore database must be isolated');
  const connectionString = required('AZURE_STORAGE_CONNECTION_STRING');
  const restoreConnectionString = process.env.BB_STORAGE_RESTORE_CONNECTION_STRING || connectionString;
  const sourceContainerName = required('BB_STORAGE_CONTAINER');
  const restoredContainerName = required('BB_STORAGE_RESTORE_CONTAINER');
  assert.notEqual(sourceContainerName, restoredContainerName, 'restore Blob container name must be distinct');
  const owner = required('BB_STORAGE_VERIFY_OWNER');
  const expectedTombstoneId = required('BB_STORAGE_EXPECTED_TOMBSTONE_ID');
  const policy = storageLifecyclePolicyFromEnv();
  assert.ok(policy, 'explicit storage purge gate and policy values are required');

  const source = new Pool({ connectionString: sourceUrl });
  const restored = new Pool({ connectionString: restoredUrl });
  const sourceBlobs = azureBlobs(connectionString, sourceContainerName);
  const restoredBlobs = azureBlobs(restoreConnectionString, restoredContainerName);
  try {
    stage = 'PostgreSQL tombstone row comparison';
    const sourceTombstones = await source.query('SELECT count(*)::int AS n FROM bb_storage_tombstones');
    const restoredTombstones = await restored.query('SELECT count(*)::int AS n FROM bb_storage_tombstones');
    assert.equal(restoredTombstones.rows[0].n, sourceTombstones.rows[0].n, 'tombstones survived PostgreSQL restore');

    stage = 'source and restored referenced Blob hashes';
    const sourceReferences = await referencedMaterials(source, owner);
    const restoredReferences = await referencedMaterials(restored, owner);
    assert.ok(restoredReferences.length > 0, 'the fixture includes an immutable material reference');
    assert.equal(restoredReferences.length, sourceReferences.length);
    await verifyHashes(sourceBlobs, sourceReferences);
    await verifyHashes(restoredBlobs, restoredReferences);

    stage = 'immutable Word delivery evidence and Blob restore';
    const sourceWordEvidence=await verifyWordDelivery(source,sourceBlobs,owner);
    const restoredWordEvidence=await verifyWordDelivery(restored,restoredBlobs,owner);
    assert.deepEqual(restoredWordEvidence.map(row=>[row.id,row.artifact_id,row.candidate_sha256.trim()]),sourceWordEvidence.map(row=>[row.id,row.artifact_id,row.candidate_sha256.trim()]));

    stage = 'pre-replay tombstone and Blob verification';
    const markerBefore = await restored.query(`SELECT * FROM bb_storage_tombstones
      WHERE id=$1 AND owner_user_id=$2 AND object_kind='material'`, [expectedTombstoneId, owner]);
    assert.equal(markerBefore.rowCount, 1);
    assert.notEqual(markerBefore.rows[0].state, 'purged', 'the dump contains a replayable deletion tombstone');
    const deletedBytes = await restoredBlobs.getIfExists(markerBefore.rows[0].object_key);
    assert.ok(deletedBytes, 'the copied Blob exists before tombstone replay');
    assert.equal(digest(deletedBytes), markerBefore.rows[0].sha256.trim());

    stage = 'durable tombstone replay';
    const runResult = await runStorageLifecycle(restored, restoredBlobs, { ...policy, ownerScope: owner });
    const markerAfter = await restored.query('SELECT state,purged_at,object_key,material_id,project_id FROM bb_storage_tombstones WHERE id=$1', [expectedTombstoneId]);
    if (markerAfter.rows[0]?.state !== 'purged') {
      stage = `durable tombstone replay (claimed=${runResult.claimed},purged=${runResult.purged},failed=${runResult.failed},state=${String(markerAfter.rows[0]?.state)})`;
      throw new Error('Expected replay did not reach the purged state');
    }
    assert.ok(markerAfter.rows[0].purged_at);
    assert.equal(await restoredBlobs.getIfExists(markerAfter.rows[0].object_key), null, 'deleted Blob is absent after replay');

    stage = 'post-replay pin and Blob verification';
    const referencedPurges = await restored.query(`SELECT t.id FROM bb_storage_tombstones t
      WHERE t.owner_user_id=$1 AND t.object_kind='material' AND t.state='purged'
        AND EXISTS (
          SELECT 1 FROM bb_input_revisions i WHERE i.owner_user_id=t.owner_user_id AND i.project_id=t.project_id
            AND (i.material_versions @> jsonb_build_array(jsonb_build_object('material_id',t.material_id,'material_version',t.material_version))
                 OR i.manifest->'materials' @> jsonb_build_array(jsonb_build_object('material_id',t.material_id,'material_version',t.material_version)))
        )`, [owner]);
    assert.equal(referencedPurges.rowCount, 0, 'no immutable material reference was purged during replay');
    await verifyHashes(restoredBlobs, restoredReferences);

    stage = 'owner-scoped API access verification';
    const app = createServer({ pool: restored, blobs: restoredBlobs,
      principal: async () => ({ userId: owner, csrfVerified: true }), allowedOrigin: 'http://bondbuddy.test' });
    try {
      const deleted = await app.inject(`/api/v1/projects/${markerAfter.rows[0].project_id}/materials/${markerAfter.rows[0].material_id}`);
      assert.equal(deleted.statusCode, 404);
      const activeReference = restoredReferences.find(material => material.deleted_at === null);
      assert.ok(activeReference, 'the restore fixture includes a still-accessible pinned version');
      const download = await app.inject(`/api/v1/projects/${activeReference.project_id}/materials/${activeReference.id}/download`);
      assert.equal(download.statusCode, 200);
      assert.equal(digest(download.rawPayload), activeReference.sha256.trim());
      for(const word of restoredWordEvidence){
        const metadata=await app.inject(`/api/v1/artifacts/${word.artifact_id}`);
        assert.equal(metadata.statusCode,200,'restored owner can resolve its available Word artifact');
        const artifactDownload=await app.inject(metadata.json().download_url);
        assert.equal(artifactDownload.statusCode,200,'restored owner can retrieve its Word artifact');
        assert.equal(digest(artifactDownload.rawPayload),word.candidate_sha256.trim());
      }
    } finally {
      await app.close();
    }
    process.stdout.write(`Storage restore verified: referenced hashes=${restoredReferences.length}, Word delivery evidence=${restoredWordEvidence.length}, tombstone replayed=1, purge count=${runResult.purged}\n`);
  } finally {
    await source.end();
    await restored.end();
  }
}

run().catch(() => {
  process.stderr.write(`Storage restore verification failed during ${stage}; no credentials or object data were emitted\n`);
  process.exitCode = 1;
});
