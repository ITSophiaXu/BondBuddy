import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import type { CreditFacilitySupplementRequest } from '@bondbuddy/contracts';
import { createServer } from './server.js';
import { isolatedTestDatabase } from './test-database.js';

const origin = 'http://bondbuddy.test';
const testDatabaseUrl = await isolatedTestDatabase('CREDIT_FACILITY_SUPPLEMENT_API_TEST_DATABASE_URL');

test('structured credit supplement API persists owner-scoped immutable user assertions and exact revisions on PostgreSQL 16', {
  skip: !testDatabaseUrl && 'set CREDIT_FACILITY_SUPPLEMENT_API_TEST_DATABASE_URL to a migrated PostgreSQL 16 template',
}, async () => {
  const pool = new Pool({ connectionString: testDatabaseUrl });
  const suffix = randomUUID().replaceAll('-', '');
  const ownerA = `credit-api-owner-${suffix}`;
  const ownerB = `credit-api-owner-b-${suffix}`;
  let activeOwner = ownerA;
  const app = createServer({ pool, principal: async () => ({ userId: activeOwner, csrfVerified: true }), allowedOrigin: origin });
  const send = (method: string, url: string, payload?: unknown): Promise<any> => app.inject({
    method: method as any, url, headers: { origin }, ...(payload === undefined ? {} : { payload: payload as any }),
  });
  const createProject = async (name: string) => {
    const response = await send('POST', '/api/v1/projects', { name, kind: 'update', issuer_name: null, market: null, offering: null });
    assert.equal(response.statusCode, 201, response.body);
    return response.json().project_id as string;
  };
  const amount = (sourceId: string, value: string | null, overrides: Partial<CreditFacilitySupplementRequest['amounts']['total']> = {}) => ({
    bank: '示例银行', as_of: '2025-02-28', currency: 'CNY', unit: '万元', basis: '授信额度', scope: 'consolidated',
    amount: value, source_id: sourceId, statement_date: '2025-03-01', ...overrides,
  });
  const body = (requestId: string, total: string | null, used: string | null, unused: string | null,
    supersedes: CreditFacilitySupplementRequest['supersedes'] = null): CreditFacilitySupplementRequest => ({
    request_id: requestId,
    amounts: {
      total: amount(`${requestId}-total`, total),
      used: amount(`${requestId}-used`, used),
      unused: amount(`${requestId}-unused`, unused),
    },
    supersedes,
  });
  try {
    const openapi = await send('GET', '/openapi.json');
    assert.equal(openapi.statusCode, 200);
    const path = '/api/v1/projects/{project_id}/credit-facility-supplements';
    assert.ok(openapi.json().paths[path].post);
    assert.ok(openapi.json().paths['/api/v1/projects/{project_id}/credit-facility-supplements/{supplement_id}/versions/{version}'].get);
    const requestSchema = openapi.json().components.schemas.CreditFacilitySupplementRequest;
    assert.deepEqual(requestSchema.required, ['request_id', 'amounts', 'supersedes']);
    assert.equal(requestSchema.properties.amounts.properties.total.properties.statement_date.type, 'string');

    const projectA = await createProject(`Credit assertion A ${suffix}`);
    const projectB = await createProject(`Credit assertion B ${suffix}`);
    const firstRequest = body(`create-${suffix}`, '100', '80', '20');
    const firstResponse = await send('POST', `/api/v1/projects/${projectA}/credit-facility-supplements`, firstRequest);
    assert.equal(firstResponse.statusCode, 201, firstResponse.body);
    const first = firstResponse.json();
    assert.equal(first.status, 'user_asserted');
    assert.equal(first.eligible_for_manuscript, false);
    assert.equal(first.version, 1);
    assert.equal(first.supersedes, null);
    assert.equal(first.calculated_total, '100');
    assert.equal(first.amounts.total.source_id, firstRequest.amounts.total.source_id);
    assert.equal(first.amounts.total.statement_date, '2025-03-01');

    const replay = await send('POST', `/api/v1/projects/${projectA}/credit-facility-supplements`, firstRequest);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().replayed, true);
    assert.equal(replay.json().supplement_id, first.supplement_id);
    const idempotencyConflict = await send('POST', `/api/v1/projects/${projectA}/credit-facility-supplements`, body(`create-${suffix}`, '100', '80', '40'));
    assert.equal(idempotencyConflict.statusCode, 409, idempotencyConflict.body);
    assert.equal(idempotencyConflict.json().code, 'IDEMPOTENCY_CONFLICT');

    const exactFirst = await send('GET', `/api/v1/projects/${projectA}/credit-facility-supplements/${first.supplement_id}/versions/1`);
    assert.equal(exactFirst.statusCode, 200, exactFirst.body);
    assert.equal(exactFirst.json().request_id, firstRequest.request_id);
    assert.ok(openapi.json().paths[path].post.responses['200'], 'OpenAPI documents the idempotent replay response');
    const otherProjectRead = await send('GET', `/api/v1/projects/${projectB}/credit-facility-supplements/${first.supplement_id}/versions/1`);
    assert.equal(otherProjectRead.statusCode, 404, 'same owner cannot read a supplement through another project scope');
    const otherProjectRevision = await send('POST', `/api/v1/projects/${projectB}/credit-facility-supplements`, body(
      `other-project-revision-${suffix}`, '100', '80', '20', { supplement_id: first.supplement_id, version: 1 }));
    assert.equal(otherProjectRevision.statusCode, 404, 'same owner cannot revise a supplement through another project scope');

    const revisionRequest = body(`revision-${suffix}`, '100', '80', '20', { supplement_id: first.supplement_id, version: 1 });
    revisionRequest.amounts.used.statement_date = '2025-03-05';
    const revisedResponse = await send('POST', `/api/v1/projects/${projectA}/credit-facility-supplements`, revisionRequest);
    assert.equal(revisedResponse.statusCode, 201, revisedResponse.body);
    const revised = revisedResponse.json();
    assert.equal(revised.version, 2);
    assert.deepEqual(revised.supersedes, { supplement_id: first.supplement_id, version: 1 });
    assert.equal(revised.amounts.used.statement_date, '2025-03-05');
    const exactRevision = await send('GET', `/api/v1/projects/${projectA}/credit-facility-supplements/${revised.supplement_id}/versions/2`);
    assert.equal(exactRevision.statusCode, 200, exactRevision.body);
    const oldStillReadable = await send('GET', `/api/v1/projects/${projectA}/credit-facility-supplements/${first.supplement_id}/versions/1`);
    assert.equal(oldStillReadable.statusCode, 200);
    assert.equal(oldStillReadable.json().amounts.used.statement_date, '2025-03-01');
    const forkAttempt = await send('POST', `/api/v1/projects/${projectA}/credit-facility-supplements`, body(
      `fork-${suffix}`, '100', '80', '20', { supplement_id: first.supplement_id, version: 1 }));
    assert.equal(forkAttempt.statusCode, 409, forkAttempt.body);
    assert.equal(forkAttempt.json().code, 'INPUT_REVISION_CONFLICT');

    const missingDate = body(`missing-date-${suffix}`, '100', '80', '20');
    for (const value of Object.values(missingDate.amounts)) value.statement_date = '';
    const missingDateResponse = await send('POST', `/api/v1/projects/${projectA}/credit-facility-supplements`, missingDate);
    assert.equal(missingDateResponse.statusCode, 201, missingDateResponse.body);
    assert.equal(missingDateResponse.json().status, 'needs_confirmation');
    assert.equal(missingDateResponse.json().reason, 'invalid_statement_date');
    assert.equal(missingDateResponse.json().amounts.total.statement_date, '');

    const invalidDate = body(`invalid-date-${suffix}`, '100', '80', '20');
    invalidDate.amounts.total.statement_date = '2025-99-45';
    const invalidDateResponse = await send('POST', `/api/v1/projects/${projectA}/credit-facility-supplements`, invalidDate);
    assert.equal(invalidDateResponse.statusCode, 201, invalidDateResponse.body);
    assert.equal(invalidDateResponse.json().status, 'needs_confirmation');
    assert.equal(invalidDateResponse.json().amounts.total.statement_date, '2025-99-45');

    const missingUnit = body(`missing-unit-${suffix}`, '100', '80', '20');
    for (const value of Object.values(missingUnit.amounts)) value.unit = '';
    const missingUnitResponse = await send('POST', `/api/v1/projects/${projectA}/credit-facility-supplements`, missingUnit);
    assert.equal(missingUnitResponse.statusCode, 201, missingUnitResponse.body);
    assert.equal(missingUnitResponse.json().status, 'needs_confirmation');
    assert.equal(missingUnitResponse.json().reason, 'missing_context');

    const conflictRequest = body(`conflict-${suffix}`, '100', '80', '40');
    const conflictResponse = await send('POST', `/api/v1/projects/${projectA}/credit-facility-supplements`, conflictRequest);
    assert.equal(conflictResponse.statusCode, 201, conflictResponse.body);
    assert.equal(conflictResponse.json().status, 'conflicted');
    assert.equal(conflictResponse.json().calculated_total, '120');
    assert.equal(conflictResponse.json().amounts.unused.amount, '40');
    assert.equal(conflictResponse.json().eligible_for_manuscript, false);

    const ownerAndProjectLeak = await send('GET', `/api/v1/projects/${projectA}/credit-facility-supplements/${first.supplement_id}/versions/1`);
    activeOwner = ownerB;
    assert.equal((await send('GET', `/api/v1/projects/${projectA}/credit-facility-supplements/${first.supplement_id}/versions/1`)).statusCode, 404);
    const foreignCreate = await send('POST', `/api/v1/projects/${projectA}/credit-facility-supplements`, body(`foreign-${suffix}`, '1', '1', '0'));
    assert.equal(foreignCreate.statusCode, 404);
    assert.equal(foreignCreate.json().code, 'NOT_FOUND');
    assert.equal(ownerAndProjectLeak.statusCode, 200);

    const callerOwner = await send('POST', `/api/v1/projects/${projectB}/credit-facility-supplements`, {
      ...body(`caller-owner-${suffix}`, '1', '1', '0'), owner_user_id: ownerA,
    });
    assert.equal(callerOwner.statusCode, 422);

    const rows = await pool.query('SELECT count(*)::int AS count FROM bb_credit_facility_supplements WHERE owner_user_id=$1 AND project_id=$2', [ownerA, projectA]);
    assert.equal(rows.rows[0]!.count, 6);
    const outbox = await pool.query(`SELECT count(*)::int AS count FROM bb_outbox WHERE owner_user_id=$1 AND aggregate_type='credit_facility_supplement' AND event_type='credit.facility_supplement.appended' AND payload->>'project_id'=$2`, [ownerA, projectA]);
    assert.equal(outbox.rows[0]!.count, 6, 'replay and rejected fork do not duplicate outbox events');
    const legacyDefault = await pool.query(
      `INSERT INTO bb_credit_facility_supplements
        (id, owner_user_id, project_id, request_id, request_hash, status, total_source_id, total_statement_date,
         used_source_id, used_statement_date, unused_source_id, unused_statement_date, supplement)
       VALUES ($1,$2,$3,$4,$5,'user_asserted',$6,NULL,$7,NULL,$8,NULL,$9::jsonb)
       RETURNING supplement_version`,
      [`legacy-${suffix}`, ownerA, projectA, `legacy-request-${suffix}`, 'a'.repeat(64), 'legacy-total', 'legacy-used', 'legacy-unused', JSON.stringify({
        status: 'user_asserted', eligibleForManuscript: false,
        amounts: { total: { sourceId: 'legacy-total' }, used: { sourceId: 'legacy-used' }, unused: { sourceId: 'legacy-unused' } },
      })]);
    assert.equal(legacyDefault.rows[0]!.supplement_version, 1, 'rows created by the pre-version table shape inherit version 1');
    await assert.rejects(pool.query('UPDATE bb_credit_facility_supplements SET status=$1 WHERE id=$2', ['conflicted', first.supplement_id]),
      /credit facility supplements are immutable/);
    await assert.rejects(pool.query('DELETE FROM bb_credit_facility_supplements WHERE id=$1', [first.supplement_id]),
      /credit facility supplements are immutable/);
  } finally {
    await app.close();
    await pool.end();
  }
});
