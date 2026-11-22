import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import {
  appendCreditFacilitySupplement,
  type CreditFacilitySupplementInput,
} from './credit-facility-supplement-repository.js';
import { loadCreditFacilitySupplementUncertainty } from './credit-facility-supplement-input-loader.js';
import { isolatedTestDatabase } from './test-database.js';

const databaseUrl = await isolatedTestDatabase(
  'CREDIT_FACILITY_SUPPLEMENT_INPUT_TEST_DATABASE_URL',
);

async function addInputRevision(
  pool: Pool,
  project: string,
  owner: string,
  revision: number,
  manifest: Record<string, unknown>,
  storedHash = inputManifestHash(manifest),
): Promise<string> {
  await pool.query(
    `INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids)
    VALUES($1,$2,$3,$2,$4,$5::jsonb,'[]','[]')`,
    [project, revision, owner, storedHash, JSON.stringify(manifest)],
  );
  return storedHash;
}

function amount(
  sourceId: string,
  date: string,
  value: string,
): CreditFacilitySupplementInput['total'] {
  return {
    bank: '合成银行',
    asOf: '2025-02-28',
    currency: 'CNY',
    unit: '万元',
    basis: '授信额度',
    scope: 'consolidated',
    amount: value,
    sourceId,
    statementDate: date,
  };
}

function input(suffix: string, values = ['100', '60', '40']): CreditFacilitySupplementInput {
  return {
    total: amount(`source-total-${suffix}`, '2025-03-01', values[0]!),
    used: amount(`source-used-${suffix}`, '2025-03-02', values[1]!),
    unused: amount(`source-unused-${suffix}`, '2025-03-03', values[2]!),
  };
}

test(
  'PG16 reads only exact locked supplements and preserves prior revisions as uncertainty',
  {
    skip:
      !databaseUrl &&
      'set CREDIT_FACILITY_SUPPLEMENT_INPUT_TEST_DATABASE_URL to a migrated disposable PostgreSQL 16 template',
  },
  async () => {
    const pool = new Pool({ connectionString: databaseUrl });
    const suffix = randomUUID().replaceAll('-', '').slice(0, 18);
    const owner = `supplement-input-owner-${suffix}`;
    const foreignOwner = `supplement-input-foreign-${suffix}`;
    const project = `supplement-input-project-${suffix}`;
    const foreignProject = `supplement-input-foreign-project-${suffix}`;
    const badRequestHash = 'a'.repeat(64);
    try {
      await pool.query('INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,$3,$4)', [
        project,
        owner,
        'Synthetic supplement input',
        'update',
      ]);
      await pool.query('INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,$3,$4)', [
        foreignProject,
        foreignOwner,
        'Synthetic foreign supplement input',
        'update',
      ]);
      const first = await appendCreditFacilitySupplement(
        { pool },
        { ownerUserId: owner, projectId: project, requestId: `first-${suffix}` },
        input(suffix),
      );
      const firstRef = {
        supplement_id: first.supplementId,
        version: first.version,
        request_hash: first.requestHash,
        status: first.result.status,
        eligible_for_manuscript: false,
      };
      const firstManifest = {
        manifest_schema: 'production_rule_pin_v1',
        credit_facility_supplements: [firstRef],
      };
      const inputHash1 = await addInputRevision(pool, project, owner, 1, firstManifest);

      const firstRead = await loadCreditFacilitySupplementUncertainty(pool, {
        ownerUserId: owner,
        projectId: project,
        inputRevision: 1,
        inputHash: inputHash1,
      });
      assert.equal(
        firstRead.status,
        'loaded',
        firstRead.status === 'needs_review' ? firstRead.reason : undefined,
      );
      if (firstRead.status !== 'loaded') return;
      assert.equal(firstRead.projection.length, 1);
      assert.equal(firstRead.projection[0]!.status, 'user_asserted');
      assert.equal(firstRead.projection[0]!.eligibleForManuscript, false);
      assert.deepEqual(firstRead.projection[0]!.amounts.total, {
        bank: '合成银行',
        asOf: '2025-02-28',
        amount: '100',
        currency: 'CNY',
        unit: '万元',
        basis: '授信额度',
        scope: 'consolidated',
        sourceId: `source-total-${suffix}`,
        statementDate: '2025-03-01',
      });

      const second = await appendCreditFacilitySupplement(
        { pool },
        { ownerUserId: owner, projectId: project, requestId: `second-${suffix}` },
        {
          ...input(`${suffix}-v2`, ['120', '70', '50']),
          supersedes: { supplementId: first.supplementId, version: first.version },
        },
      );
      const secondRef = {
        supplement_id: second.supplementId,
        version: second.version,
        request_hash: second.requestHash,
        status: second.result.status,
        eligible_for_manuscript: false,
      };
      const inputHash2 = await addInputRevision(pool, project, owner, 2, {
        manifest_schema: 'production_rule_pin_v1',
        credit_facility_supplements: [secondRef],
      });
      const oldRead = await loadCreditFacilitySupplementUncertainty(pool, {
        ownerUserId: owner,
        projectId: project,
        inputRevision: 1,
        inputHash: inputHash1,
      });
      assert.equal(oldRead.status, 'loaded');
      if (oldRead.status === 'loaded')
        assert.equal(oldRead.projection[0]!.amounts.total.amount, '100');
      const newRead = await loadCreditFacilitySupplementUncertainty(pool, {
        ownerUserId: owner,
        projectId: project,
        inputRevision: 2,
        inputHash: inputHash2,
      });
      assert.equal(newRead.status, 'loaded');
      if (newRead.status === 'loaded')
        assert.equal(newRead.projection[0]!.amounts.total.amount, '120');

      assert.deepEqual(
        await loadCreditFacilitySupplementUncertainty(pool, {
          ownerUserId: owner,
          projectId: project,
          inputRevision: 1,
          inputHash: 'f'.repeat(64),
        }),
        { status: 'needs_review', reason: 'input_revision_lock_mismatch', projection: [] },
      );
      assert.deepEqual(
        await loadCreditFacilitySupplementUncertainty(pool, {
          ownerUserId: foreignOwner,
          projectId: project,
          inputRevision: 1,
          inputHash: inputHash1,
        }),
        { status: 'needs_review', reason: 'input_revision_missing_or_foreign', projection: [] },
      );

      const mismatchedHashRef = { ...firstRef, request_hash: badRequestHash };
      const badHash = await addInputRevision(pool, project, owner, 3, {
        manifest_schema: 'production_rule_pin_v1',
        credit_facility_supplements: [mismatchedHashRef],
      });
      const changedHash = await loadCreditFacilitySupplementUncertainty(pool, {
        ownerUserId: owner,
        projectId: project,
        inputRevision: 3,
        inputHash: badHash,
      });
      assert.deepEqual(changedHash, {
        status: 'needs_review',
        reason: 'supplement_lock_mismatch',
        projection: [],
      });

      const changedStatusRef = { ...firstRef, status: 'conflicted' };
      const changedStatusHash = await addInputRevision(pool, project, owner, 4, {
        manifest_schema: 'production_rule_pin_v1',
        credit_facility_supplements: [changedStatusRef],
      });
      const changedStatus = await loadCreditFacilitySupplementUncertainty(pool, {
        ownerUserId: owner,
        projectId: project,
        inputRevision: 4,
        inputHash: changedStatusHash,
      });
      assert.deepEqual(changedStatus, {
        status: 'needs_review',
        reason: 'supplement_status_or_shape_changed',
        projection: [],
      });

      const missingRef = { ...firstRef, supplement_id: `missing-${suffix}` };
      const missingHash = await addInputRevision(pool, project, owner, 5, {
        manifest_schema: 'production_rule_pin_v1',
        credit_facility_supplements: [missingRef],
      });
      const missing = await loadCreditFacilitySupplementUncertainty(pool, {
        ownerUserId: owner,
        projectId: project,
        inputRevision: 5,
        inputHash: missingHash,
      });
      assert.deepEqual(missing, {
        status: 'needs_review',
        reason: 'supplement_missing_or_foreign',
        projection: [],
      });

      const foreignRow = await appendCreditFacilitySupplement(
        { pool },
        { ownerUserId: foreignOwner, projectId: foreignProject, requestId: `foreign-${suffix}` },
        input(`foreign-${suffix}`),
      );
      const foreignRef = {
        supplement_id: foreignRow.supplementId,
        version: foreignRow.version,
        request_hash: foreignRow.requestHash,
        status: foreignRow.result.status,
        eligible_for_manuscript: false,
      };
      const foreignHash = await addInputRevision(pool, project, owner, 6, {
        manifest_schema: 'production_rule_pin_v1',
        credit_facility_supplements: [foreignRef],
      });
      const foreignSupplement = await loadCreditFacilitySupplementUncertainty(pool, {
        ownerUserId: owner,
        projectId: project,
        inputRevision: 6,
        inputHash: foreignHash,
      });
      assert.deepEqual(foreignSupplement, {
        status: 'needs_review',
        reason: 'supplement_missing_or_foreign',
        projection: [],
      });

      const tamperedManifest = { ...firstManifest, unexpected: 'changed-after-lock' };
      await addInputRevision(pool, project, owner, 7, tamperedManifest, inputHash1);
      const tampered = await loadCreditFacilitySupplementUncertainty(pool, {
        ownerUserId: owner,
        projectId: project,
        inputRevision: 7,
        inputHash: inputHash1,
      });
      assert.deepEqual(tampered, {
        status: 'needs_review',
        reason: 'input_manifest_hash_mismatch',
        projection: [],
      });

      await pool.query('UPDATE bb_projects SET deleted_at=now() WHERE owner_user_id=$1 AND id=$2', [
        owner,
        project,
      ]);
      const deletedProjectRead = await loadCreditFacilitySupplementUncertainty(pool, {
        ownerUserId: owner,
        projectId: project,
        inputRevision: 1,
        inputHash: inputHash1,
      });
      assert.deepEqual(
        deletedProjectRead,
        { status: 'needs_review', reason: 'input_revision_missing_or_foreign', projection: [] },
        'soft-deleted projects are outside the worker read scope; historical revisions remain readable while the project is active',
      );
    } finally {
      await pool.end();
    }
  },
);
