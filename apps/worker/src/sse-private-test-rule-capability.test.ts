import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { AUTHORIZED_SAMPLE_CASE_FILES, AUTHORIZED_SAMPLE_MANIFEST_SHA256 } from './authorized-sample-membership.generated.js';
import { createSsePrivateTestRuleCapabilityLoader } from './sse-private-test-rule-capability.js';
import { SSE_PRIVATE_CANDIDATE_ASSET_PIN as pin } from './sse-private-candidate-assets.js';
import { workerRuntimeOptionsFromEnv } from './runtime.js';

type Fixture = ReturnType<typeof fixture>;

function fixture(withReviewPin = true, investorScope = 'professional') {
  const owner = `synthetic-owner-${randomUUID()}`, project = `synthetic-project-${randomUUID()}`;
  const files = AUTHORIZED_SAMPLE_CASE_FILES.filter(file => file.caseId === 'rq-202509');
  const selected = [files.find(file => file.uploadRole === 'historical')!, files.find(file => file.uploadRole === 'interimFinancial')!];
  const materials: Array<{ material_id: string; material_version: number; role: string; sha256: string }> = selected.map(file => ({ material_id: `synthetic-material-${randomUUID()}`, material_version: 1,
    role: file.uploadRole, sha256: file.sha256 }));
  const manifest = {
    kind: 'update', draft_revision: 1, market: 'sse', offering: 'private', materials,
    issuer_identity: { status: 'verified', record_id: 'synthetic-identity', version: 1, content_hash: 'd'.repeat(64),
      entity_id: 'synthetic-entity', issuer_display_name: 'Synthetic issuer', material_id: materials[0]!.material_id,
      material_version: 1, source_snapshot_id: 'synthetic-snapshot', source_record_id: 'synthetic-record',
      source_record_sha256: 'e'.repeat(64), source_content_sha256: materials[0]!.sha256,
      reviewed_by: 'synthetic-reviewer', reviewed_at: '2026-09-27T00:00:00.000Z' },
    target_confirmation: { status: 'confirmed', confirmed_by: owner, market: 'sse', offering: 'private',
      document_purpose: 'issuance', as_of: '2026-09-27' },
    ...(withReviewPin ? { test_rule_applicability_ref: { context_id: 'synthetic-context', version: 1, content_hash: 'f'.repeat(64),
      source_input_revision: 1, source_input_hash: 'a'.repeat(64) } } : {}),
  };
  const inputHash = inputManifestHash(manifest);
  const input = { input_hash: inputHash, draft_revision: 1, material_versions: materials.map(({ material_id, material_version }) => ({ material_id, material_version })),
    manifest, rule_pack_version: null, template_version: null };
  const grant: { user_id: string; project_id: string; input_revision: number; input_hash: string;
    sample_manifest_sha256: string; taxonomy_hash: string; rule_pack_hash: string; expires_at: Date; revoked_at: Date | null } = {
    user_id: owner, project_id: project, input_revision: 2, input_hash: inputHash,
    sample_manifest_sha256: AUTHORIZED_SAMPLE_MANIFEST_SHA256, taxonomy_hash: pin.taxonomy.contentSha256,
    rule_pack_hash: pin.rulePack.contentSha256, expires_at: new Date(Date.now() + 60_000), revoked_at: null };
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes('FROM bb_non_production_test_grants')) return { rows: [grant] };
      throw new Error(`unexpected pool query: ${sql}`);
    },
    connect: async () => {
      let phase = 'begin';
      const client = {
        query: async (sql: string) => {
          queries.push(sql);
          if (sql.startsWith('BEGIN')) return { rows: [] };
          if (sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          if (sql.includes('FROM bb_input_revisions')) {
            phase = 'materials';
            return { rows: [{ input_hash: inputHash, manifest, material_versions: input.material_versions }] };
          }
          if (sql.includes('FROM bb_material_versions')) {
            assert.equal(phase, 'materials');
            return { rows: materials.map(item => ({ owner_user_id: owner, project_id: project, id: item.material_id,
              version: item.material_version, role: item.role, sha256: item.sha256, state: 'ready' })) };
          }
          throw new Error(`unexpected client query: ${sql}`);
        }, release: () => undefined,
      };
      return client as unknown as PoolClient;
    },
  } as unknown as Pool;
  const run = { id: 'synthetic-run', owner_user_id: owner, project_id: project, input_revision: 2,
    input_hash: inputHash, task_kind: 'update', channel: 'non_production_test' as const, test_grant_id: 'synthetic-grant' };
  let reviewCalls = 0;
  const loader = createSsePrivateTestRuleCapabilityLoader(pool, { reviewedContextLoader: async (_db, args) => {
    reviewCalls++;
    assert.equal(args.ownerUserId, owner);
    assert.equal(args.projectId, project);
    assert.equal(args.contextId, 'synthetic-context');
    assert.equal(args.contentHash, 'f'.repeat(64));
    assert.equal(args.expectedSourceInputRevision, 1);
    assert.equal(args.mode, 'non_production_test');
    assert.deepEqual(args.currentMaterialVersions.map(item => item.materialId).sort(), materials.map(item => item.material_id).sort());
    return { request: { market: 'sse', offering: 'private', instrument: 'ordinary-company-bond',
      documentStage: 'issuance', issuerScope: 'domestic-company', investorScope, industry: 'industry-synthetic',
      specialFeatures: [], asOf: '2026-09-27' }, contextPin: {} };
  } });
  return { owner, project, materials, manifest, input, inputHash, grant, pool, run, loader, reviewCalls: () => reviewCalls, queries };
}

async function preprod(action: () => Promise<void>) {
  const previous = [process.env.BB_DEPLOYMENT_TIER, process.env.BB_NON_PRODUCTION_TEST_CHANNEL];
  process.env.BB_DEPLOYMENT_TIER = 'preprod'; process.env.BB_NON_PRODUCTION_TEST_CHANNEL = 'enabled';
  try { await action(); } finally {
    for (const [index, key] of ['BB_DEPLOYMENT_TIER', 'BB_NON_PRODUCTION_TEST_CHANNEL'].entries()) {
      if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
    }
  }
}

test('candidate capability validates the live grant, exact sample subset, assets and reviewed scope then projects coverage-only gaps', async () => preprod(async () => {
  const f = fixture();
  const result = await f.loader(f.run, f.input);
  assert.equal(result.status, 'ready');
  if (result.status !== 'ready') return;
  assert.equal(result.sampleManifestSha256, AUTHORIZED_SAMPLE_MANIFEST_SHA256);
  assert.equal(result.taxonomyHash, pin.taxonomy.contentSha256);
  assert.equal(result.rulePackHash, pin.rulePack.contentSha256);
  assert.equal(result.uncoveredItems.length, 31);
  assert.ok(result.uncoveredItems.every(item => item.kind === 'coverage_gap' && !('rule_id' in item)));
  assert.ok(result.uncoveredItems.every(item => item.kind !== 'coverage_gap' || item.disposition === 'uncovered'));
  assert.equal(new Set(result.uncoveredItems.map(item => item.kind === 'coverage_gap' ? item.item_id : item.rule_id)).size, 31);
  assert.equal(f.reviewCalls(), 1);
  assert.ok(f.queries.some(sql => sql.includes('FOR SHARE')));
  assert.equal(f.queries.filter(sql => sql.includes('FROM bb_non_production_test_grants')).length, 1);
}));

test('candidate capability fails closed before applicability when grant, membership, candidate hash or exact context is wrong', async () => preprod(async () => {
  const cases: Array<[string, (f: Fixture) => void, string]> = [
    ['grant expiry', f => { f.grant.expires_at = new Date(0); }, 'test_grant_inactive_or_scope_changed'],
    ['candidate taxonomy', f => { f.grant.taxonomy_hash = '0'.repeat(64); }, 'test_candidate_hash_mismatch'],
    ['input material manifest changed without a matching input hash', f => { f.materials[1]!.sha256 = 'b'.repeat(64); }, 'test_input_pin_mismatch'],
  ];
  for (const [label, mutate, reason] of cases) {
    const f = fixture(); mutate(f);
    const result = await f.loader(f.run, f.input);
    assert.deepEqual(result, { status: 'not_ready', reason }, label);
    assert.equal(f.reviewCalls(), 0, `${label} must fail before reviewing applicability`);
  }
  const withoutPin = fixture(false);
  assert.deepEqual(await withoutPin.loader(withoutPin.run, withoutPin.input),
    { status: 'not_ready', reason: 'test_reviewed_applicability_pin_missing' });
  assert.equal(withoutPin.reviewCalls(), 0);
}));

test('candidate capability does not treat a reviewed non-professional investor scope as the ordinary private-bond candidate', async () => preprod(async () => {
  const f = fixture(true, 'other');
  assert.deepEqual(await f.loader(f.run, f.input),
    { status: 'not_ready', reason: 'test_reviewed_applicability_scope_mismatch' });
  assert.equal(f.reviewCalls(), 1);
}));

test('WorkerRuntime installs the candidate selector only for the explicit preproduction channel', () => {
  const pool = {} as Pool, blobs = {} as Parameters<typeof workerRuntimeOptionsFromEnv>[1];
  assert.equal(workerRuntimeOptionsFromEnv(pool, blobs, { BB_WORKER_JOB_KINDS: 'run' }).testRuleCapabilityLoader, undefined);
  assert.equal(workerRuntimeOptionsFromEnv(pool, blobs, { BB_WORKER_JOB_KINDS: 'run', BB_DEPLOYMENT_TIER: 'production',
    BB_NON_PRODUCTION_TEST_CHANNEL: 'enabled' }).testRuleCapabilityLoader, undefined);
  assert.equal(typeof workerRuntimeOptionsFromEnv(pool, blobs, { BB_WORKER_JOB_KINDS: 'run', BB_DEPLOYMENT_TIER: 'preprod',
    BB_NON_PRODUCTION_TEST_CHANNEL: 'enabled' }).testRuleCapabilityLoader, 'function');
});
