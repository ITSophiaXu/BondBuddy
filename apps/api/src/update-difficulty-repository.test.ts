import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  createUpdateDifficultySnapshotWithClient,
  type UpdateDifficultyClient,
  type TrustedUpdateDifficultyInput,
} from './update-difficulty-repository.js';

const input: TrustedUpdateDifficultyInput = {
  ownerUserId: 'api-difficulty-owner',
  projectId: 'api-difficulty-project',
  source: { materialId: 'api-historical-material', materialVersion: 1, profileVersion: 1 },
  targetRevision: 4,
  financialMaterialVersions: [{ materialId: 'api-financial-material', materialVersion: 1 }],
  targetReportingPeriods: [],
  replacements: [],
  restatements: [],
  requestId: 'api-difficulty-request',
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function requestHash(value: TrustedUpdateDifficultyInput): string {
  const financialMaterialVersions = [...value.financialMaterialVersions]
    .map(item => ({ materialId: item.materialId, materialVersion: item.materialVersion }))
    .sort((left, right) => left.materialId.localeCompare(right.materialId) || left.materialVersion - right.materialVersion);
  return createHash('sha256').update(canonical({ ...value, financialMaterialVersions }), 'utf8').digest('hex');
}

test('API transaction-client entry point replays idempotently without owning transaction or connection', async () => {
  const hash = requestHash(input);
  const prior = {
    id: 'difficulty-snapshot-existing', owner_user_id: input.ownerUserId, project_id: input.projectId,
    request_id: input.requestId, request_hash: hash, source_material_id: input.source.materialId,
    source_material_version: input.source.materialVersion, source_profile_version: input.source.profileVersion,
    target_revision: input.targetRevision, source_market: null, source_offering: null,
    target_market: 'sse', target_offering: 'private', input_revision: null, input_hash: null,
    financial_material_versions: [{ materialId: 'api-financial-material', materialVersion: 1 }],
    comparison_input: { targetReportingPeriods: [], replacements: [], restatements: [] },
    old_profile_completeness: 'undetermined',
    estimate: { status: 'needs_confirmation', estimatedN: null, structureAdaptationRequired: null, confirmationReasons: [] },
    created_at: '2026-09-26T00:00:00.000Z',
  };
  const calls: { sql: string; values: unknown[] }[] = [];
  let released = false;
  const client: UpdateDifficultyClient = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.includes('FROM bb_projects') && sql.includes('FOR UPDATE')) return { rows: [{ id: input.projectId }] };
      if (sql.includes('FROM bb_update_difficulty_snapshots') && sql.includes('request_id=$3')) return { rows: [prior] };
      throw new Error(`unexpected SQL: ${sql}`);
    },
    release() { released = true; },
  };

  const result = await createUpdateDifficultySnapshotWithClient(client, input);

  assert.equal(result.id, prior.id);
  assert.equal(result.replayed, true);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.sql !== 'BEGIN' && call.sql !== 'COMMIT' && call.sql !== 'ROLLBACK'));
  assert.equal(calls[0]!.values[0], input.ownerUserId);
  assert.equal(calls[0]!.values[1], input.projectId);
  assert.equal(released, false);
});
