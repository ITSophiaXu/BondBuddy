// Synthetic resolver tests exercise real assertions with read-only database seams.
// They do not activate an execution, call a provider or change a credit ledger.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { assertRunExecutionTestGrant, type RunExecutionTestGrantScope } from './run-execution-test-grant.js';

const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;

async function preprod(work: () => Promise<void>) {
  const keys = ['BB_DEPLOYMENT_TIER', 'BB_NON_PRODUCTION_TEST_CHANNEL'] as const;
  const before = keys.map(key => process.env[key]);
  process.env.BB_DEPLOYMENT_TIER = 'preprod'; process.env.BB_NON_PRODUCTION_TEST_CHANNEL = 'enabled';
  try { await work(); } finally {
    keys.forEach((key, index) => { if (before[index] === undefined) delete process.env[key]; else process.env[key] = before[index]; });
  }
}

function fixture(version: 1 | 2 = 1) {
  const rawRun = { id: 'synthetic-run', owner_user_id: 'synthetic-owner', project_id: 'synthetic-project',
    input_revision: 3, input_hash: 'a'.repeat(64), channel: 'non_production_test', test_grant_id: 'original-grant' };
  const scope: RunExecutionTestGrantScope = { owner: rawRun.owner_user_id, projectId: rawRun.project_id, runId: rawRun.id,
    executionVersion: version, inputRevision: version === 1 ? 3 : 8, inputHash: (version === 1 ? 'a' : 'b').repeat(64) };
  const execution = { execution_version: scope.executionVersion, input_revision: scope.inputRevision,
    input_hash: scope.inputHash, channel: rawRun.channel, successor_authorization_id: version === 2 ? 'successor-receipt' : null };
  const receipts: Array<{ id: string; test_grant_id: string }> = [{ id: 'successor-receipt', test_grant_id: 'successor-grant' }];
  const grant = { user_id: rawRun.owner_user_id, project_id: rawRun.project_id, input_revision: scope.inputRevision,
    input_hash: scope.inputHash, sample_manifest_sha256: 'c'.repeat(64), taxonomy_hash: 'd'.repeat(64), rule_pack_hash: 'e'.repeat(64),
    granted_by: 'synthetic-operator', reason: 'Synthetic test only.', expires_at: new Date(Date.now() + 3600000), revoked_at: null as Date | null };
  const queries: Array<{ sql: string; args: unknown[] }> = [];
  const db = { query: async (sql: string, args: unknown[] = []) => {
    assert.match(sql, /^SELECT /, 'authorization resolution must not mutate state');
    queries.push({ sql, args });
    if (sql.includes('SELECT r.* FROM bb_runs r')) {
      assert.deepEqual(args, [scope.owner, scope.runId]); return { rows: [rawRun] };
    }
    if (sql.includes('FROM bb_run_execution_versions e')) return { rows: [execution] };
    if (sql.includes('FROM bb_run_test_successor_authorizations a')) {
      assert.deepEqual(args, [scope.owner, scope.projectId, scope.runId, scope.executionVersion, scope.inputRevision,
        scope.inputHash, rawRun.input_revision, rawRun.input_hash]);
      return { rows: receipts };
    }
    if (sql.includes('FROM bb_non_production_test_grants')) {
      assert.deepEqual(args, [version === 1 ? 'original-grant' : receipts[0]?.test_grant_id]); return { rows: [grant] };
    }
    throw new Error(`Unexpected resolver query: ${sql}`);
  } } as unknown as Pool;
  return { rawRun, scope, execution, receipts, grant, queries, db };
}

test('V1 resolves only the persisted original grant and ignores a caller grant lookalike', async () => preprod(async () => {
  const f = fixture(), before = structuredClone(f.rawRun);
  const caller = { ...f.scope, grantId: 'caller-selected-grant', authorizationId: 'caller-selected-receipt' };
  const result = await assertRunExecutionTestGrant(f.db, caller);
  assert.equal(result.grantId, 'original-grant'); assert.equal(result.authorizationId, null);
  assert.equal(result.grant, f.grant); assert.deepEqual(f.rawRun, before);
  assert.equal(f.queries.filter(q => q.sql.startsWith('SELECT a.id,a.test_grant_id FROM bb_run_test_successor_authorizations a')).length, 0);
}));

test('V2 resolves its exact receipt grant while retaining original run identity and grant metadata', async () => preprod(async () => {
  const f = fixture(2), before = structuredClone(f.rawRun);
  const result = await assertRunExecutionTestGrant(f.db, f.scope);
  assert.equal(result.grantId, 'successor-grant'); assert.equal(result.authorizationId, 'successor-receipt');
  assert.equal(result.grant.input_revision, 8); assert.equal(result.grant.input_hash, 'b'.repeat(64));
  assert.deepEqual(f.rawRun, before);
  assert.equal(f.queries.filter(q => q.sql.includes('FROM bb_non_production_test_grants')).length, 1);
}));

test('missing, duplicate or wrong-input successor permission cannot reuse the original grant', async () => preprod(async () => {
  for (const kind of ['missing', 'duplicate', 'origin-grant'] as const) {
    const f = fixture(2);
    if (kind === 'missing') f.receipts.length = 0;
    if (kind === 'duplicate') f.receipts.push({ ...f.receipts[0]! });
    if (kind === 'origin-grant') {
      f.receipts[0]!.test_grant_id = f.rawRun.test_grant_id;
      f.grant.input_revision = f.rawRun.input_revision; f.grant.input_hash = f.rawRun.input_hash;
    }
    await assert.rejects(assertRunExecutionTestGrant(f.db, f.scope), code('TEST_GRANT_MISMATCH'), kind);
  }
}));

test('foreign project, stale active identity and production runs fail before grant consumption', async () => preprod(async () => {
  for (const kind of ['project', 'stale-input', 'production', 'missing-receipt'] as const) {
    const f = fixture(2);
    if (kind === 'project') f.rawRun.project_id = 'other-project';
    if (kind === 'stale-input') f.execution.input_revision++;
    if (kind === 'production') f.rawRun.channel = 'production';
    if (kind === 'missing-receipt') f.execution.successor_authorization_id = null;
    await assert.rejects(assertRunExecutionTestGrant(f.db, f.scope), error =>
      ['TEST_GRANT_MISMATCH', 'INPUT_REVISION_CONFLICT'].includes((error as { code: string }).code), kind);
    assert.equal(f.queries.filter(q => q.sql.includes('FROM bb_non_production_test_grants')).length, 0, kind);
  }
}));

test('every invocation rechecks active grant revocation, expiry and exact input scope', async () => preprod(async () => {
  for (const kind of ['revoked', 'expired', 'scope'] as const) {
    const f = fixture(2);
    await assertRunExecutionTestGrant(f.db, f.scope);
    if (kind === 'revoked') f.grant.revoked_at = new Date();
    if (kind === 'expired') f.grant.expires_at = new Date(0);
    if (kind === 'scope') f.grant.input_hash = 'f'.repeat(64);
    await assert.rejects(assertRunExecutionTestGrant(f.db, f.scope), code(kind === 'revoked'
      ? 'TEST_GRANT_REVOKED' : kind === 'expired' ? 'TEST_GRANT_EXPIRED' : 'TEST_GRANT_MISMATCH'));
  }
}));

test('disabled test channel and malformed scope perform no authorization reads', async () => preprod(async () => {
  const f = fixture(2);
  for (const changed of [{ executionVersion: 3 }, { inputRevision: 0 }, { inputHash: 'invalid' }, { owner: '' }])
    await assert.rejects(assertRunExecutionTestGrant(f.db, { ...f.scope, ...changed }), code('TEST_GRANT_MISMATCH'));
  process.env.BB_DEPLOYMENT_TIER = 'production';
  await assert.rejects(assertRunExecutionTestGrant(f.db, f.scope), code('TEST_CHANNEL_DISABLED'));
  assert.equal(f.queries.length, 0);
}));
