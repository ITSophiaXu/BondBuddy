import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  issueProductionReviewGrant,
  parseProductionReviewGrantScope,
  revokeProductionReviewGrant,
  type ProductionReviewGrantClient,
  type ProductionReviewGrantPool,
} from './production-review-grants-cli.js';

const hash = 'a'.repeat(64);
const validScope = {
  instruments: ['mtn', 'sustainable_mtn'],
  document_stages: ['issuance', 'registration'],
  issuer_scopes: { mode: 'explicit_codes', codes: ['company', 'state_owned'], dictionary_version: 'issuer-v1' },
  investor_scopes: { mode: 'reviewed_unrestricted', evidence_id: 'issuer-review', evidence_version: 2, evidence_sha256: hash },
  industry_codes: { mode: 'needs_review', reason_code: 'scope_pending', reason: '尚未确认行业边界' },
  special_feature_scope: { mode: 'explicit_codes', codes: ['green'], dictionary_version: 'features-v1' },
} as const;

class FakeClient implements ProductionReviewGrantClient {
  readonly calls: { sql: string; values: unknown[] }[] = [];
  failOn?: string;
  async query(sql: string, values: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    const normalized = sql.trim().replace(/\s+/g, ' ');
    this.calls.push({ sql: normalized, values });
    if (this.failOn && normalized.includes(this.failOn)) throw new Error('synthetic database error');
    if (normalized === 'SELECT now()::text AS granted_at') return { rows: [{ granted_at: '2026-09-28 00:00:00.000000+00' }] };
    if (normalized.includes("FROM pg_class c")) return { rows: [{ '?column?': 1 }] };
    if (normalized.includes("FROM bb_users") && normalized.includes('ANY($1::text[])')) {
      return { rows: [{ id: 'operator-1' }, { id: 'reviewer-1' }] };
    }
    if (normalized.includes("FROM bb_users") && normalized.includes("status='active' FOR SHARE")) return { rows: [{ id: 'actor-1' }] };
    if (normalized.includes('FROM bb_rule_pack_production_reviewer_grants g')) {
      return { rows: [{ id: 'grant-1', user_id: 'reviewer-1', role: 'rule_pack_industry_reviewer',
        market: 'nafmii', offering: 'mtn', granted_by: 'operator-1', scope_hash: hash, revoked_at: null }] };
    }
    if (normalized.includes('FROM bb_production_review_attestation_events')) {
      return { rows: [{ manifest_id: 'manifest-1', manifest_version: 3, content_sha256: hash }] };
    }
    if (normalized.includes('FROM bb_rule_pack_production_release_events')) {
      return { rows: [{ event_id: 'release-1', pack_id: 'pack-1', sequence: 4, action: 'production_release' }] };
    }
    if (normalized.includes('UPDATE bb_rule_pack_production_reviewer_grants')) return { rows: [{ id: 'grant-1' }] };
    return { rows: [] };
  }
  release(): void {}
}

class FakePool implements ProductionReviewGrantPool {
  readonly client = new FakeClient();
  async connect(): Promise<ProductionReviewGrantClient> { return this.client; }
  async query(): Promise<{ rows: Record<string, unknown>[] }> { return { rows: [] }; }
}

test('scope parser requires reviewedDimension shapes and canonical sorted unique arrays', () => {
  assert.deepEqual(parseProductionReviewGrantScope(validScope), validScope);
  assert.throws(() => parseProductionReviewGrantScope({ ...validScope, instruments: ['sustainable_mtn', 'mtn'] }), /INVALID_PRODUCTION_REVIEW_GRANT_SCOPE/);
  assert.throws(() => parseProductionReviewGrantScope({ ...validScope, document_stages: ['registration', 'issuance'] }), /INVALID_PRODUCTION_REVIEW_GRANT_SCOPE/);
  assert.throws(() => parseProductionReviewGrantScope({ ...validScope, investor_scopes: { mode: 'reviewed_unrestricted', evidence_id: 'x', evidence_version: 1, evidence_sha256: 'bad' } }), /INVALID_PRODUCTION_REVIEW_GRANT_SCOPE/);
  assert.throws(() => parseProductionReviewGrantScope({ ...validScope, industry_codes: { mode: 'explicit_codes', codes: ['all'], dictionary_version: 'v1' } }), /INVALID_PRODUCTION_REVIEW_GRANT_SCOPE/);
});

test('grant validates target/actor, role and market-offering; grant and immutable scope share one timestamp and transaction', async () => {
  const pool = new FakePool();
  const result = await issueProductionReviewGrant(pool, {
    userId: 'reviewer-1', grantorUserId: 'operator-1', role: 'rule_pack_operator',
    market: 'nafmii', offering: 'mtn', reason: 'Authorized controlled M1 reviewer/operator access', scope: validScope,
  });
  assert.equal(result.scope_hash.length, 64);
  const calls = pool.client.calls;
  assert.deepEqual(calls.filter((call) => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(call.sql)).map((call) => call.sql), ['BEGIN', 'COMMIT']);
  const grant = calls.find((call) => call.sql.includes('INSERT INTO bb_rule_pack_production_reviewer_grants'))!;
  const scope = calls.find((call) => call.sql.includes('INSERT INTO bb_rule_pack_production_grant_scopes'))!;
  assert.equal(grant.values[6], scope.values[8], 'granted_at and created_at use the same database timestamp');
  assert.equal(grant.values[1], 'reviewer-1');
  assert.ok(calls.findIndex((call) => call.sql.includes('INSERT INTO bb_rule_pack_production_reviewer_grants'))
    < calls.findIndex((call) => call.sql.includes('INSERT INTO bb_rule_pack_production_grant_scopes')));
  assert.ok(calls.some((call) => call.sql.includes("'rule_pack_grant_granted'")));
  await assert.rejects(issueProductionReviewGrant(new FakePool(), {
    userId: 'reviewer-1', grantorUserId: 'operator-1', role: 'invented_role', market: 'nafmii',
    offering: 'mtn', reason: 'Reason', scope: validScope,
  }), /INVALID_PRODUCTION_REVIEW_GRANT_ARGUMENTS/);
  await assert.rejects(issueProductionReviewGrant(new FakePool(), {
    userId: 'reviewer-1', grantorUserId: 'operator-1', role: 'rule_pack_operator', market: 'sse',
    offering: 'mtn', reason: 'Reason', scope: validScope,
  }), /INVALID_PRODUCTION_REVIEW_GRANT_ARGUMENTS/);
});

test('revoke locks one grant, writes actor-owned outbox references, and never withdraws releases', async () => {
  const pool = new FakePool();
  const result = await revokeProductionReviewGrant(pool, {
    grantId: 'grant-1', actorUserId: 'actor-1', reason: 'Access removed after controlled review assignment ended',
  });
  assert.deepEqual(result, {
    grant_id: 'grant-1', revoked: true,
    manifest_refs: [{ manifest_id: 'manifest-1', manifest_version: 3, content_sha256: hash }],
    release_refs: [{ event_id: 'release-1', pack_id: 'pack-1', sequence: 4, action: 'production_release' }],
  });
  const calls = pool.client.calls;
  const lock = calls.findIndex((call) => call.sql.includes('WHERE g.id=$1 FOR UPDATE OF g'));
  const manifests = calls.findIndex((call) => call.sql.includes('FROM bb_production_review_attestation_events'));
  const releases = calls.findIndex((call) => call.sql.includes('FROM bb_rule_pack_production_release_events'));
  const update = calls.findIndex((call) => call.sql.includes('UPDATE bb_rule_pack_production_reviewer_grants'));
  const outbox = calls.find((call) => call.sql.includes("'rule_pack_grant_revoked'"))!;
  assert.ok(lock >= 0 && lock < manifests && manifests < releases && releases < update);
  assert.equal(outbox.values[1], 'actor-1', 'the outbox owner is the authenticated/controlled revoker');
  const payload = JSON.parse(String(outbox.values[3])) as Record<string, unknown>;
  assert.deepEqual(payload.affected_manifests, result.manifest_refs);
  assert.deepEqual(payload.affected_releases, result.release_refs);
  assert.equal(payload.automatic_release_withdrawal, false);
  assert.equal(calls.some((call) => call.sql.includes("'production_withdrawal'")), false);
  assert.deepEqual(calls.filter((call) => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(call.sql)).map((call) => call.sql), ['BEGIN', 'COMMIT']);
});

test('grant transaction rolls back if scope insertion fails', async () => {
  const pool = new FakePool();
  pool.client.failOn = 'INSERT INTO bb_rule_pack_production_grant_scopes';
  await assert.rejects(issueProductionReviewGrant(pool, {
    userId: 'reviewer-1', grantorUserId: 'operator-1', role: 'rule_pack_industry_reviewer',
    market: 'nafmii', offering: 'mtn', reason: 'Authorized controlled M1 reviewer access', scope: validScope,
  }), /synthetic database error/);
  assert.deepEqual(pool.client.calls.filter((call) => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(call.sql)).map((call) => call.sql), ['BEGIN', 'ROLLBACK']);
});
