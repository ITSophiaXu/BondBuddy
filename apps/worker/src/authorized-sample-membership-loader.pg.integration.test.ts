import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { AUTHORIZED_SAMPLE_CASE_FILES } from './authorized-sample-membership.generated.js';
import { loadAuthorizedSampleMembershipFromLockedInput } from './authorized-sample-membership-loader.js';
import { isolatedTestDatabase } from './test-database.js';

const optedIn = process.env.BB_RUN_AUTHORIZED_SAMPLE_MEMBERSHIP_PG_TESTS === '1';
const testDatabaseUrl = optedIn
  ? await isolatedTestDatabase('AUTHORIZED_SAMPLE_MEMBERSHIP_TEST_DATABASE_URL')
  : undefined;

test(
  'locked authorized-sample membership uses exact owner/project/revision/hash and live material rows in PostgreSQL 16',
  {
    skip: !optedIn
      ? 'set BB_RUN_AUTHORIZED_SAMPLE_MEMBERSHIP_PG_TESTS=1 to run the PostgreSQL 16 membership integration'
      : !testDatabaseUrl
        ? 'set AUTHORIZED_SAMPLE_MEMBERSHIP_TEST_DATABASE_URL or BB_TEST_DATABASE_URL to a disposable migrated PostgreSQL 16 template'
        : false,
  },
  async () => {
    assert.ok(testDatabaseUrl);
    const pool = new Pool({ connectionString: testDatabaseUrl });
    const owner = `synthetic-owner-${randomUUID()}`;
    const project = `synthetic-project-${randomUUID()}`;
    const revision = 1;
    const sampleFiles = AUTHORIZED_SAMPLE_CASE_FILES.filter((file) => file.caseId === 'rq-202509');
    const selectedFiles = [
      sampleFiles.find((file) => file.uploadRole === 'historical')!,
      sampleFiles.find((file) => file.uploadRole === 'interimFinancial')!,
    ];
    const makeSelected = (
      inputRevision: number,
      secondRole: string = selectedFiles[1]!.uploadRole,
      secondHash: string = selectedFiles[1]!.sha256,
    ) =>
      selectedFiles.map((file, index) => ({
        material_id: `synthetic-material-${inputRevision}-${index}-${randomUUID()}`,
        material_version: 1,
        role: index === 1 ? secondRole : file.uploadRole,
        sha256: index === 1 ? secondHash : file.sha256,
      }));

    async function insertRevision(
      manifestMaterials: Array<{
        material_id: string;
        material_version: number;
        role: string;
        sha256: string;
      }>,
      refs: Array<{ material_id: string; material_version: number }> = manifestMaterials.map(
        ({ material_id, material_version }) => ({ material_id, material_version }),
      ),
      projectId = project,
      ownerId = owner,
      inputRevision = revision,
    ) {
      const manifest = { kind: 'update', materials: manifestMaterials };
      const inputHash = inputManifestHash(manifest);
      await pool.query(
        'INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,$3,$4) ON CONFLICT(owner_user_id,id) DO NOTHING',
        [projectId, ownerId, 'Synthetic membership fixture', 'update'],
      );
      const existingUploads = new Set<string>();
      for (const material of manifestMaterials) {
        if (existingUploads.has(material.material_id)) continue;
        existingUploads.add(material.material_id);
        const uploadId = `synthetic-upload-${randomUUID()}`;
        await pool.query(
          `INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state)
        VALUES($1,$2,$3,'synthetic.bin','application/octet-stream',1,$4,$5,$6,now()+interval '1 day','completed')`,
          [
            uploadId,
            ownerId,
            projectId,
            material.sha256,
            material.role,
            `synthetic/${randomUUID()}`,
          ],
        );
        await pool.query(
          `INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state)
        VALUES($1,$2,$3,$4,$5,$6,'synthetic.bin','application/octet-stream',1,$7,$8,'ready')`,
          [
            material.material_id,
            material.material_version,
            ownerId,
            projectId,
            uploadId,
            material.role,
            material.sha256,
            `users/${ownerId}/projects/${projectId}/materials/${randomUUID()}`,
          ],
        );
      }
      await pool.query(
        `INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids,rule_pack_version,template_version)
      VALUES($1,$2,$3,1,$4,$5,$6,'[]',NULL,NULL)`,
        [projectId, inputRevision, ownerId, inputHash, manifest, JSON.stringify(refs)],
      );
      return { ownerUserId: ownerId, projectId, inputRevision, inputHash };
    }

    try {
      const version = await pool.query<{ server_version_num: string }>(
        "SELECT current_setting('server_version_num') AS server_version_num",
      );
      assert.ok(
        Number(version.rows[0]!.server_version_num) >= 160000,
        'integration database must be PostgreSQL 16 or newer',
      );

      const selected = makeSelected(1);
      const exactRef = await insertRevision(selected);
      await pool.query(
        `UPDATE bb_material_versions SET state=CASE id
        WHEN $3 THEN 'failed' ELSE 'prechecking' END
      WHERE owner_user_id=$1 AND project_id=$2 AND id=ANY($4::text[])`,
        [
          owner,
          project,
          selected[0]!.material_id,
          selected.map((material) => material.material_id),
        ],
      );
      assert.deepEqual(await loadAuthorizedSampleMembershipFromLockedInput(pool, exactRef), {
        accepted: true,
        caseId: 'rq-202509',
        gaps: [
          {
            fileId: 'rq-202509-03',
            role: 'notes',
            reason: 'authorized_sample_material_not_locked',
          },
        ],
      });

      assert.deepEqual(
        await loadAuthorizedSampleMembershipFromLockedInput(pool, {
          ...exactRef,
          inputHash: 'a'.repeat(64),
        }),
        {
          accepted: false,
          reason: 'locked_input_hash_mismatch',
        },
      );
      assert.deepEqual(
        await loadAuthorizedSampleMembershipFromLockedInput(pool, {
          ...exactRef,
          ownerUserId: `${owner}-other`,
        }),
        {
          accepted: false,
          reason: 'locked_input_not_found',
        },
      );
      assert.deepEqual(
        await loadAuthorizedSampleMembershipFromLockedInput(pool, {
          ...exactRef,
          projectId: `${project}-other`,
        }),
        {
          accepted: false,
          reason: 'locked_input_not_found',
        },
      );

      const concurrentSelected = makeSelected(10);
      const concurrentRef = await insertRevision(concurrentSelected, undefined, project, owner, 10);
      const concurrentPool = {
        connect: async () => {
          const client = await pool.connect();
          const query = client.query.bind(client);
          let mutated = false;
          const wrapped = {
            query: async (statement: string, values?: unknown[]) => {
              const result = await query(statement, values as never);
              if (!mutated && statement.includes('FROM bb_input_revisions')) {
                mutated = true;
                await pool.query(
                  'UPDATE bb_material_versions SET role=$4 WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=1',
                  [owner, project, concurrentSelected[1]!.material_id, 'notes'],
                );
              }
              return result;
            },
            release: () => client.release(),
          } as unknown as PoolClient;
          return wrapped;
        },
      } as unknown as Pool;
      assert.deepEqual(
        await loadAuthorizedSampleMembershipFromLockedInput(concurrentPool, concurrentRef),
        {
          accepted: false,
          reason: 'locked_material_concurrent_change',
        },
      );

      const roleSelected = makeSelected(2);
      const roleDriftRef = await insertRevision(roleSelected, undefined, project, owner, 2);
      await pool.query(
        'UPDATE bb_material_versions SET role=$4 WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=1',
        [owner, project, roleSelected[1]!.material_id, 'notes'],
      );
      assert.deepEqual(await loadAuthorizedSampleMembershipFromLockedInput(pool, roleDriftRef), {
        accepted: false,
        reason: 'material_role_mismatch',
      });

      const hashSelected = makeSelected(3);
      const hashDriftRef = await insertRevision(hashSelected, undefined, project, owner, 3);
      await pool.query(
        'UPDATE bb_material_versions SET sha256=$4 WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=1',
        [owner, project, hashSelected[1]!.material_id, 'a'.repeat(64)],
      );
      assert.deepEqual(await loadAuthorizedSampleMembershipFromLockedInput(pool, hashDriftRef), {
        accepted: false,
        reason: 'material_hash_mismatch',
      });

      const deletedSelected = makeSelected(4);
      const deletedRef = await insertRevision(deletedSelected, undefined, project, owner, 4);
      await pool.query(
        'UPDATE bb_material_versions SET deleted_at=now() WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=1',
        [owner, project, deletedSelected[1]!.material_id],
      );
      assert.deepEqual(await loadAuthorizedSampleMembershipFromLockedInput(pool, deletedRef), {
        accepted: false,
        reason: 'locked_material_deleted_or_missing',
      });

      const versionSelected = makeSelected(5);
      const driftedVersion = versionSelected.map((material, index) =>
        index === 1 ? { ...material, material_version: 2 } : material,
      );
      const versionDriftRef = await insertRevision(driftedVersion, undefined, project, owner, 5);
      await pool.query(
        'UPDATE bb_material_versions SET version=1 WHERE owner_user_id=$1 AND project_id=$2 AND id=$3 AND version=2',
        [owner, project, versionSelected[1]!.material_id],
      );
      assert.deepEqual(await loadAuthorizedSampleMembershipFromLockedInput(pool, versionDriftRef), {
        accepted: false,
        reason: 'locked_material_deleted_or_missing',
      });

      const extraSelected = makeSelected(6);
      const extraRef = await insertRevision(
        extraSelected,
        [
          ...extraSelected.map(({ material_id, material_version }) => ({
            material_id,
            material_version,
          })),
          { material_id: 'synthetic-extra-reference', material_version: 1 },
        ],
        project,
        owner,
        6,
      );
      assert.deepEqual(await loadAuthorizedSampleMembershipFromLockedInput(pool, extraRef), {
        accepted: false,
        reason: 'locked_material_reference_set_mismatch',
      });

      const missingSelected = makeSelected(7);
      const missingRef = await insertRevision(
        missingSelected,
        [
          {
            material_id: missingSelected[0]!.material_id,
            material_version: missingSelected[0]!.material_version,
          },
        ],
        project,
        owner,
        7,
      );
      assert.deepEqual(await loadAuthorizedSampleMembershipFromLockedInput(pool, missingRef), {
        accepted: false,
        reason: 'locked_material_reference_set_mismatch',
      });

      const duplicateSelected = makeSelected(8);
      const duplicateRef = await insertRevision(
        [duplicateSelected[0]!, duplicateSelected[0]!],
        undefined,
        project,
        owner,
        8,
      );
      assert.deepEqual(await loadAuthorizedSampleMembershipFromLockedInput(pool, duplicateRef), {
        accepted: false,
        reason: 'locked_material_reference_set_mismatch',
      });

      const tamperedSelected = makeSelected(9, selectedFiles[1]!.uploadRole, 'b'.repeat(64));
      const tampered = tamperedSelected;
      const tamperedRef = await insertRevision(tampered, undefined, project, owner, 9);
      assert.deepEqual(await loadAuthorizedSampleMembershipFromLockedInput(pool, tamperedRef), {
        accepted: false,
        reason: 'sample_material_hash_mismatch',
      });
    } finally {
      await pool.end();
    }
  },
);
