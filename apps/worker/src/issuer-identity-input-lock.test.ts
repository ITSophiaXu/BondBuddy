import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { createServer } from '@bondbuddy/api';
import type { IssuerIdentitySourcePool } from '@bondbuddy/api/issuer-identity-source';
import {
  appendIssuerIdentitySourceRecord,
  authorizeIssuerIdentityReviewer,
  reviewIssuerIdentitySourceRecord,
} from '@bondbuddy/api/issuer-identity-source';
import { codexModelStage, inputLockStage, type StageContext } from './run-pipeline.js';
import { inputManifestHash, lockProductionRulePack, verifyRuleApplicabilitySourceLock,
  type ReviewedContextLoader } from '@bondbuddy/api/production-rule-pin';
import { loadReviewedRuleApplicabilityContext } from '@bondbuddy/rule-applicability-context';
import type { ProductionRulePackRequest } from '@bondbuddy/rule-pack-registry';

const databaseUrl = process.env.BB_TEST_DATABASE_URL;
const origin = 'http://bondbuddy.test';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const ownerLoaderContract: ReviewedContextLoader = loadReviewedRuleApplicabilityContext;
void ownerLoaderContract;

test('a resumed model stage rechecks the identity gate before constructing a prompt', async () => {
  let promptBuilt = false;
  const pause = { kind: 'pause', stage: 'capability_not_ready', reason: 'historical_issuer_identity_stale' } as const;
  const stage = codexModelStage({ name: 'model_generation', logicalCallId: 'synthetic-identity-gate',
    config: {} as never, schema: {}, validate: () => true, resultSchemaVersion: 'synthetic-v1',
    buildPrompt: async () => { promptBuilt = true; return 'must not be built'; } });
  const ctx = { checkpoint: { model_generation: { logical_call_id: 'synthetic-identity-gate' } },
    validateBeforeModelCall: async () => pause } as unknown as StageContext;
  assert.equal(stage.replay, true);
  assert.deepEqual(await stage.run(ctx), pause);
  assert.equal(promptBuilt, false);
});

function savepointPool(connection: PoolClient): Pool {
  let next = 0;
  const sourcePool: IssuerIdentitySourcePool = {
    query: (sql, values) => connection.query(sql, values),
    connect: async () => {
      const name = `issuer_identity_worker_${++next}`;
      let active = false;
      return {
        release: () => undefined,
        query: async (sql, values) => {
          if (sql === 'BEGIN') { await connection.query(`SAVEPOINT ${name}`); active = true; return { rows: [] }; }
          if (sql === 'COMMIT') { if (active) await connection.query(`RELEASE SAVEPOINT ${name}`); active = false; return { rows: [] }; }
          if (sql === 'ROLLBACK') {
            if (active) { await connection.query(`ROLLBACK TO SAVEPOINT ${name}`); await connection.query(`RELEASE SAVEPOINT ${name}`); }
            active = false; return { rows: [] };
          }
          return connection.query(sql, values);
        },
      };
    },
  };
  return sourcePool as unknown as Pool;
}

test('synthetic PostgreSQL: input_lock pauses on reviewer revocation and fails on stale material; non-update skips issuer gate',
  { skip: !databaseUrl }, async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const connection = await pool.connect();
    const scopedPool = savepointPool(connection);
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const owner = `issuer-lock-owner-${suffix}`, reviewerId = `issuer-lock-reviewer-${suffix}`, grantorId = `issuer-lock-grantor-${suffix}`;
    const projectId = `issuer-lock-project-${suffix}`, materialId = `issuer-lock-material-${suffix}`;
    const uploadId = `issuer-lock-upload-${suffix}`, snapshotId = `issuer-lock-snapshot-${suffix}`;
    const evidenceId = `issuer-lock-evidence-${suffix}`, grantId = `issuer-lock-grant-${suffix}`;
    const contentHash = sha(`synthetic material ${suffix}`);
    const app = createServer({ pool: scopedPool, allowedOrigin: origin,
      principal: async () => ({ userId: owner, csrfVerified: true }) });
    try {
      await connection.query('BEGIN');
      for (const [id, label] of [[owner, 'owner'], [reviewerId, 'reviewer'], [grantorId, 'grantor']] as const) {
        await connection.query('INSERT INTO bb_users(id,username) VALUES($1,$2)', [id, `identity${label}${suffix}`]);
      }
      await connection.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind,issuer_name,market,offering,update_details)
        VALUES($1,$2,'Synthetic issuer update','update','Untrusted browser label','sse','private','{}')`, [projectId, owner]);
      await connection.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,
        state,received_sha256,received_bytes) VALUES($1,$2,$3,'historical.pdf','application/pdf',10,$4,'historical',$5,now()+interval '1 hour','completed',$4,10)`,
      [uploadId, owner, projectId, contentHash, `synthetic/${uploadId}`]);
      await connection.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
        VALUES($1,1,$2,$3,$4,'historical','historical.pdf','application/pdf',10,$5,$6,'parsed')`,
        [materialId, owner, projectId, uploadId, contentHash, `users/${owner}/projects/${projectId}/materials/${materialId}`]);
      const meta = { schema_version: 'document-parse-response-v1', request_id: `parse-${suffix}`, status: 'parsed',
        parser_version: `parser-${suffix}`, material: { material_id: materialId, material_version: 1, media_type: 'application/pdf', sha256: contentHash },
        warnings: [], document: { page_count: 1 }, error: null };
      await connection.query(`INSERT INTO bb_parse_snapshots(id,owner_user_id,project_id,material_id,material_version,content_sha256,parser_version,request_hash,
        response_status,response_schema_version,response_sha256,record_count,response_meta)
        VALUES($1,$2,$3,$4,1,$5,$6,$7,'parsed','document-parse-response-v1',$8,1,$9::jsonb)`,
      [snapshotId, owner, projectId, materialId, contentHash, `parser-${suffix}`, sha(`request-${suffix}`), sha(`response-${suffix}`), JSON.stringify(meta)]);
      await connection.query(`INSERT INTO bb_parse_evidence(owner_user_id,project_id,material_id,material_version,snapshot_id,record_id,content_sha256,
        locator_type,locator,literal_quote,context,extraction_method,extractor_version,confidence,uncertainty,formatting,record_sha256,ordinal)
        VALUES($1,$2,$3,1,$4,$5,$6,'pdf_bbox',$7::jsonb,'合成发行人','synthetic evidence','native_text',$8,0.99,'[]','{}',$9,0)`,
      [owner, projectId, materialId, snapshotId, evidenceId, contentHash, JSON.stringify({ page: 1, bbox: [0, 0, 1, 1] }), `parser-${suffix}`, sha(evidenceId)]);

      const observation = await appendIssuerIdentitySourceRecord({ pool: scopedPool, newId: randomUUID }, {
        ownerUserId: owner, projectId, materialId, materialVersion: 1, requestId: `request-${suffix}`,
        sourceRecordId: evidenceId, issuerDisplayName: '合成发行人', entityId: 'entity-synthetic-reviewed',
      });
      await connection.query(`INSERT INTO bb_issuer_identity_reviewer_grants(id,user_id,role,granted_by,reason_code)
        VALUES($1,$2,'issuer_identity_reviewer',$3,'synthetic_test')`, [grantId, reviewerId, grantorId]);
      const reviewer = await authorizeIssuerIdentityReviewer(scopedPool, reviewerId);
      assert.ok(reviewer);
      await reviewIssuerIdentitySourceRecord({ pool: scopedPool, newId: randomUUID }, {
        ownerUserId: owner, projectId, materialId, materialVersion: 1, sourceRecordRowId: observation.id,
        reviewer, decision: 'verified', verifiedEntityId: 'entity:11111111-1111-4111-8111-111111111111',
        entityBasisKind: 'manual_attestation', entityBasisRef: 'synthetic issuer evidence', reasonCode: 'synthetic_identity_verified',
      });
      const response = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/input-revisions`, headers: { origin },
        payload: { draft_revision: 1, material_versions: [{ material_id: materialId, material_version: 1 }], requirement_message_ids: [] } });
      assert.equal(response.statusCode, 201, response.body);
      const input = response.json();
      const firstManifest = (await connection.query('SELECT manifest FROM bb_input_revisions WHERE project_id=$1 AND revision=$2',
        [projectId, input.input_revision])).rows[0].manifest;
      assert.equal(firstManifest.rule_pack_selection, 'blocked');
      assert.deepEqual(firstManifest.rule_pack_block_reasons, ['rule_applicability_reference_missing']);
      const reviewedContextPin = { schema_version: 'synthetic-loader-seam-only', source_input_revision: input.input_revision,
        source_input_hash: input.input_hash, fields: { instrument: { value: 'synthetic-corporate-bond', status: 'synthetic_only' } } };
      const contextRef = { context_id: `synthetic-context-${suffix}`, version: 1,
        content_hash: inputManifestHash(reviewedContextPin), source_input_revision: input.input_revision,
        source_input_hash: input.input_hash };
      const sourceLock = { draftRevision: 1, materials: firstManifest.materials as {
        material_id: string; material_version: number; role: string; sha256: string }[] };
      assert.equal(await verifyRuleApplicabilitySourceLock(connection, owner, projectId, contextRef, sourceLock), null);
      assert.equal(await verifyRuleApplicabilitySourceLock(connection, owner, projectId, contextRef,
        { ...sourceLock, draftRevision: 2 }), 'rule_applicability_source_draft_mismatch');
      assert.equal(await verifyRuleApplicabilitySourceLock(connection, owner, projectId, contextRef,
        { ...sourceLock, materials: [{ ...sourceLock.materials[0]!, sha256: 'f'.repeat(64) }] }),
      'rule_applicability_source_material_mismatch');
      const v2Upload = `synthetic-v2-upload-${suffix}`, v2Sha = sha(`synthetic material v2 ${suffix}`);
      await connection.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state,received_sha256,received_bytes)
        VALUES($1,$2,$3,'historical-v2.pdf','application/pdf',10,$4,'historical',$5,now()+interval '1 hour','completed',$4,10)`,
      [v2Upload, owner, projectId, v2Sha, `synthetic/${v2Upload}`]);
      await connection.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
        VALUES($1,2,$2,$3,$4,'historical','historical-v2.pdf','application/pdf',10,$5,$6,'parsed')`,
      [materialId, owner, projectId, v2Upload, v2Sha, `users/${owner}/projects/${projectId}/materials/${materialId}/2`]);
      const v2Lock = { ...sourceLock, materials: [{ ...sourceLock.materials[0]!, material_version: 2, sha256: v2Sha }] };
      assert.equal(await verifyRuleApplicabilitySourceLock(connection, owner, projectId, contextRef, v2Lock),
        'rule_applicability_source_material_mismatch');
      await connection.query('SAVEPOINT changed_rule_material_sha');
      await connection.query('UPDATE bb_material_versions SET sha256=$1 WHERE owner_user_id=$2 AND project_id=$3 AND id=$4 AND version=1',
        ['f'.repeat(64), owner, projectId, materialId]);
      assert.equal(await verifyRuleApplicabilitySourceLock(connection, owner, projectId, contextRef, sourceLock),
        'rule_applicability_source_material_stale');
      await connection.query('ROLLBACK TO SAVEPOINT changed_rule_material_sha');
      await connection.query('RELEASE SAVEPOINT changed_rule_material_sha');
      assert.equal(await verifyRuleApplicabilitySourceLock(connection, 'foreign-owner', projectId, contextRef, sourceLock),
        'rule_applicability_source_input_mismatch');
      const request: ProductionRulePackRequest = { market: 'sse', offering: 'private', instrument: 'synthetic-corporate-bond',
        documentStage: 'registration', issuerScope: 'synthetic-issuer-scope', investorScope: 'synthetic-investor-scope',
        industry: 'synthetic-industry', specialFeatures: [], asOf: '2026-09-25' };
      let staleLoaderCalled = false;
      assert.deepEqual(await lockProductionRulePack(connection,
        { owner_user_id: owner, id: projectId, market: 'sse', offering: 'private' }, v2Lock,
        firstManifest.issuer_identity, contextRef, async () => {
          staleLoaderCalled = true;
          return { request, contextPin: reviewedContextPin };
        }), { status: 'blocked', reasons: ['rule_applicability_source_material_mismatch'] });
      assert.equal(staleLoaderCalled, false, 'A(v2) never reaches the loader or selector');
      const reviewedApp = createServer({ pool: scopedPool, allowedOrigin: origin,
        principal: async () => ({ userId: owner, csrfVerified: true }),
        reviewedContextLoader: async (db, args) => {
          assert.ok(db !== pool, 'reviewed context and input revision use the transaction client');
          assert.equal(args.ownerUserId, owner); assert.equal(args.projectId, projectId);
          assert.equal(args.contextId, contextRef.context_id);
          assert.equal(args.expectedSourceInputRevision, input.input_revision);
          assert.equal(args.expectedSourceInputHash, input.input_hash);
          assert.equal(args.expectedIssuerBinding.entity_id, 'entity:11111111-1111-4111-8111-111111111111');
          assert.equal(args.currentDraftRevision, 1);
          assert.deepEqual(args.currentMaterialVersions, [{ materialId, materialVersion: 1, sha256: contentHash }]);
          return { request, contextPin: reviewedContextPin };
        } });
      try {
        const extraUpload = `synthetic-extra-upload-${suffix}`, extraMaterial = `synthetic-extra-material-${suffix}`;
        const extraSha = sha(`synthetic extra financial material ${suffix}`);
        await connection.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state,received_sha256,received_bytes)
          VALUES($1,$2,$3,'extra.pdf','application/pdf',10,$4,'financial',$5,now()+interval '1 hour','completed',$4,10)`,
        [extraUpload, owner, projectId, extraSha, `synthetic/${extraUpload}`]);
        await connection.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
          VALUES($1,1,$2,$3,$4,'financial','extra.pdf','application/pdf',10,$5,$6,'parsed')`,
        [extraMaterial, owner, projectId, extraUpload, extraSha, `synthetic/${extraMaterial}`]);
        const addedMaterial = await reviewedApp.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/input-revisions`,
          headers: { origin }, payload: { draft_revision: 1,
            material_versions: [{ material_id: materialId, material_version: 1 }, { material_id: extraMaterial, material_version: 1 }],
            requirement_message_ids: [], rule_applicability_context_ref: contextRef } });
        assert.equal(addedMaterial.statusCode, 201, addedMaterial.body);
        const addedManifest = (await connection.query('SELECT manifest FROM bb_input_revisions WHERE project_id=$1 AND revision=$2',
          [projectId, addedMaterial.json().input_revision])).rows[0].manifest;
        assert.deepEqual(addedManifest.rule_pack_block_reasons, ['rule_applicability_source_material_mismatch']);
        const noRegistry = await reviewedApp.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/input-revisions`,
          headers: { origin }, payload: { draft_revision: 1,
            material_versions: [{ material_id: materialId, material_version: 1 }], requirement_message_ids: [],
            rule_applicability_context_ref: contextRef } });
        assert.equal(noRegistry.statusCode, 201, noRegistry.body);
        const pinnedAttempt = (await connection.query('SELECT manifest,input_hash FROM bb_input_revisions WHERE project_id=$1 AND revision=$2',
          [projectId, noRegistry.json().input_revision])).rows[0];
        assert.deepEqual(pinnedAttempt.manifest.rule_pack_block_reasons, ['production_rule_pack_registry_empty']);
        assert.equal(inputManifestHash(pinnedAttempt.manifest), pinnedAttempt.input_hash.trim());
        assert.notEqual(noRegistry.json().input_hash, input.input_hash, 'exact context reference changes the canonical input hash');
        await connection.query('SAVEPOINT changed_rule_draft');
        await connection.query('UPDATE bb_projects SET draft_revision=2 WHERE owner_user_id=$1 AND id=$2', [owner, projectId]);
        const changedDraft = await reviewedApp.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/input-revisions`,
          headers: { origin }, payload: { draft_revision: 2,
            material_versions: [{ material_id: materialId, material_version: 1 }], requirement_message_ids: [],
            rule_applicability_context_ref: contextRef } });
        assert.equal(changedDraft.statusCode, 201, changedDraft.body);
        const changedManifest = (await connection.query('SELECT manifest FROM bb_input_revisions WHERE project_id=$1 AND revision=$2',
          [projectId, changedDraft.json().input_revision])).rows[0].manifest;
        assert.deepEqual(changedManifest.rule_pack_block_reasons, ['rule_applicability_source_draft_mismatch']);
        await connection.query('ROLLBACK TO SAVEPOINT changed_rule_draft');
        await connection.query('RELEASE SAVEPOINT changed_rule_draft');
      } finally { await reviewedApp.close(); }
      const noRelease = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/input-revisions`, headers: { origin },
        payload: { draft_revision: 1, material_versions: [{ material_id: materialId, material_version: 1 }], requirement_message_ids: [] } });
      assert.equal(noRelease.statusCode, 201, noRelease.body);
      assert.equal(noRelease.json().input_hash, input.input_hash, 'same blocked business input keeps the same canonical hash');
      const noReleaseManifest = (await connection.query('SELECT manifest FROM bb_input_revisions WHERE project_id=$1 AND revision=$2',
        [projectId, noRelease.json().input_revision])).rows[0].manifest;
      assert.deepEqual(noReleaseManifest.rule_pack_block_reasons, ['rule_applicability_reference_missing']);
      const preflight = await app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/preflight`, headers: { origin },
        payload: { input_revision: noRelease.json().input_revision, input_hash: noRelease.json().input_hash } });
      assert.equal(preflight.statusCode, 200, preflight.body);
      assert.equal(preflight.json().status, 'blocked');
      assert.ok(preflight.json().missing_inputs.includes('rule_pack:rule_applicability_reference_missing'));
      const run = { id: `run-${suffix}`, owner_user_id: owner, project_id: projectId, input_revision: input.input_revision,
        input_hash: input.input_hash, task_kind: 'update' };
      const ctx = { pool: scopedPool, blobs: {} as never, lease: {} as never, run, signal: new AbortController().signal,
        checkpoint: {}, values: new Map() } as StageContext;
      const trusted = await inputLockStage.run(ctx);
      assert.deepEqual(trusted, { kind: 'pause', stage: 'capability_not_ready', reason: 'rule_applicability_reference_missing' },
        'a current verified identity still needs independently reviewed rule applicability');

      await connection.query("UPDATE bb_issuer_identity_reviewer_grants SET revoked_at=now(),revoked_by=$2,revocation_reason_code='synthetic_test',revocation_basis='synthetic test' WHERE id=$1", [grantId, grantorId]);
      const revoked = await inputLockStage.run(ctx);
      assert.deepEqual(revoked, { kind: 'pause', stage: 'capability_not_ready', reason: 'historical_issuer_identity_stale' },
        'the run cannot reach later stages after reviewer grant revocation');

      await connection.query('UPDATE bb_material_versions SET deleted_at=now() WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=1',
        [owner, projectId, materialId]);
      const deleted = await inputLockStage.run(ctx);
      assert.deepEqual(deleted, { kind: 'fail', code: 'INPUT_REVISION_CONFLICT' }, 'a deleted historical version cannot reach model generation');

      const otherTask = await inputLockStage.run({ ...ctx, run: { ...run, task_kind: 'review' } });
      assert.deepEqual(otherTask, { kind: 'pause', stage: 'capability_not_ready', reason: 'rule_applicability_reference_missing' },
        'non-update task kinds retain their existing input-lock path');
    } finally {
      await app.close();
      await connection.query('ROLLBACK');
      connection.release();
      await pool.end();
    }
  });
