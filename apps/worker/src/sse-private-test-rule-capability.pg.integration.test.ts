import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { AUTHORIZED_SAMPLE_CASE_FILES, AUTHORIZED_SAMPLE_MANIFEST_SHA256 } from './authorized-sample-membership.generated.js';
import { createSsePrivateTestRuleCapabilityLoader } from './sse-private-test-rule-capability.js';
import { SSE_PRIVATE_CANDIDATE_ASSET_PIN as pin } from './sse-private-candidate-assets.js';
import { isolatedTestDatabase } from './test-database.js';

const optedIn = process.env.BB_RUN_SSE_PRIVATE_TEST_CAPABILITY_PG_TESTS === '1';
const databaseUrl = optedIn ? await isolatedTestDatabase('SSE_PRIVATE_TEST_CAPABILITY_DATABASE_URL') : undefined;

test('candidate selector uses PostgreSQL grant, exact membership, candidate pins and a repeatable-read material snapshot', {
  skip: !optedIn ? 'set BB_RUN_SSE_PRIVATE_TEST_CAPABILITY_PG_TESTS=1 to run the PostgreSQL 16 candidate capability integration'
    : !databaseUrl ? 'set SSE_PRIVATE_TEST_CAPABILITY_DATABASE_URL or BB_TEST_DATABASE_URL to a disposable migrated PostgreSQL 16 template' : false,
}, async () => {
  assert.ok(databaseUrl);
  const previous = [process.env.BB_DEPLOYMENT_TIER, process.env.BB_NON_PRODUCTION_TEST_CHANNEL];
  process.env.BB_DEPLOYMENT_TIER = 'preprod'; process.env.BB_NON_PRODUCTION_TEST_CHANNEL = 'enabled';
  const pool = new Pool({ connectionString: databaseUrl });
  const owner = `sse-test-owner-${randomUUID()}`, project = `sse-test-project-${randomUUID()}`;
  const files = AUTHORIZED_SAMPLE_CASE_FILES.filter(file => file.caseId === 'rq-202509');
  const selected = [files.find(file => file.uploadRole === 'historical')!, files.find(file => file.uploadRole === 'interimFinancial')!];
  const materials = selected.map(file => ({ material_id: `sse-test-material-${randomUUID()}`, material_version: 1,
    role: file.uploadRole, sha256: file.sha256 }));
  const manifest = { kind: 'update', draft_revision: 1, market: 'sse', offering: 'private', materials,
    issuer_identity: { status: 'verified', record_id: 'synthetic-identity', version: 1, content_hash: 'd'.repeat(64),
      entity_id: 'synthetic-entity', issuer_display_name: 'Synthetic issuer', material_id: materials[0]!.material_id,
      material_version: 1, source_snapshot_id: 'synthetic-snapshot', source_record_id: 'synthetic-record',
      source_record_sha256: 'e'.repeat(64), source_content_sha256: materials[0]!.sha256,
      reviewed_by: 'synthetic-reviewer', reviewed_at: '2026-09-27T00:00:00.000Z' },
    target_confirmation: { status: 'confirmed', confirmed_by: owner, market: 'sse', offering: 'private',
      document_purpose: 'issuance', as_of: '2026-09-27' },
  };
  const inputHash = inputManifestHash(manifest);
  const runBase = { id: `sse-test-run-${randomUUID()}`, owner_user_id: owner, project_id: project, input_revision: 1,
    input_hash: inputHash, task_kind: 'update', channel: 'non_production_test' as const };
  const input = { input_hash: inputHash, draft_revision: 1, material_versions: materials.map(({ material_id, material_version }) => ({ material_id, material_version })),
    manifest, rule_pack_version: null, template_version: null };

  async function createGrant(label: string, taxonomyHash: string = pin.taxonomy.contentSha256,
    rulePackHash: string = pin.rulePack.contentSha256) {
    const grantId = `sse-test-grant-${label}-${randomUUID()}`;
    await pool.query(`INSERT INTO bb_non_production_test_grants
      (grant_id,user_id,project_id,input_revision,input_hash,sample_manifest_sha256,taxonomy_hash,rule_pack_hash,granted_by,reason,expires_at)
      VALUES($1,$2,$3,1,$4,$5,$6,$7,'synthetic-operator','integration fixture',now()+interval '1 hour')`,
    [grantId, owner, project, inputHash, AUTHORIZED_SAMPLE_MANIFEST_SHA256, taxonomyHash, rulePackHash]);
    return grantId;
  }

  try {
    const version = await pool.query<{ server_version_num: string }>("SELECT current_setting('server_version_num') AS server_version_num");
    assert.ok(Number(version.rows[0]!.server_version_num) >= 160000, 'integration database must be PostgreSQL 16 or newer');
    await pool.query(`INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic candidate membership','update')`, [project, owner]);
    for (const material of materials) {
      const uploadId = `sse-test-upload-${randomUUID()}`;
      await pool.query(`INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
        VALUES($1,$2,$3,'synthetic.bin','application/octet-stream',1,$4,$5,$6,now()+interval '1 day','completed')`,
      [uploadId, owner, project, material.sha256, material.role, `synthetic/${randomUUID()}`]);
      await pool.query(`INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
        VALUES($1,1,$2,$3,$4,$5,'synthetic.bin','application/octet-stream',1,$6,$7,'ready')`,
      [material.material_id, owner, project, uploadId, material.role, material.sha256,
        `users/${owner}/projects/${project}/materials/${randomUUID()}`]);
    }
    await pool.query(`INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids,rule_pack_version,template_version)
      VALUES($1,1,$2,1,$3,$4,$5,'[]',NULL,NULL)`,
    [project, owner, inputHash, manifest, JSON.stringify(input.material_versions)]);

    const activeGrant = await createGrant('active');
    const loader = createSsePrivateTestRuleCapabilityLoader(pool);
    const active = await loader({ ...runBase, test_grant_id: activeGrant }, input);
    assert.deepEqual(active, { status: 'not_ready', reason: 'test_reviewed_applicability_pin_missing' },
      'valid grant, membership and exact candidate bytes pass before the absent immutable review ref blocks selection');

    const wrongHashGrant = await createGrant('wrong-taxonomy', '0'.repeat(64));
    assert.deepEqual(await loader({ ...runBase, test_grant_id: wrongHashGrant }, input),
      { status: 'not_ready', reason: 'test_candidate_hash_mismatch' });

    const revokedGrant = await createGrant('revoked');
    await pool.query(`UPDATE bb_non_production_test_grants SET revoked_at=now(),revoked_by='synthetic-operator',revoked_reason='fixture'
      WHERE grant_id=$1`, [revokedGrant]);
    assert.deepEqual(await loader({ ...runBase, test_grant_id: revokedGrant }, input),
      { status: 'not_ready', reason: 'test_grant_inactive_or_scope_changed' });

    const concurrentPool = {
      query: pool.query.bind(pool),
      connect: async () => {
        const client = await pool.connect();
        const query = client.query.bind(client);
        let changed = false;
        return {
          query: async (sql: string, values?: unknown[]) => {
            const result = await query(sql, values as never);
            if (!changed && sql.includes('FROM bb_input_revisions')) {
              changed = true;
              await pool.query('UPDATE bb_material_versions SET role=$4 WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=1',
                [owner, project, materials[1]!.material_id, 'notes']);
            }
            return result;
          },
          release: () => client.release(),
        } as unknown as PoolClient;
      },
    } as unknown as Pool;
    assert.deepEqual(await createSsePrivateTestRuleCapabilityLoader(concurrentPool)({ ...runBase, test_grant_id: activeGrant }, input),
      { status: 'not_ready', reason: 'authorized_sample_locked_material_concurrent_change' });
  } finally {
    await pool.end();
    for (const [index, key] of ['BB_DEPLOYMENT_TIER', 'BB_NON_PRODUCTION_TEST_CHANNEL'].entries()) {
      if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
    }
  }
});
