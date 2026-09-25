import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import {
  appendCreditFacilitySupplement,
  getCreditFacilitySupplement,
  type CreditFacilitySupplementClient,
  type CreditFacilitySupplementDependencies,
  type CreditFacilitySupplementInput,
  type TrustedCreditFacilitySupplementContext,
} from './credit-facility-supplement-repository.js';
import { isolatedTestDatabase } from './test-database.js';

const testDatabaseUrl = await isolatedTestDatabase('CREDIT_FACILITY_SUPPLEMENT_TEST_DATABASE_URL');

const context: TrustedCreditFacilitySupplementContext = {
  ownerUserId: 'credit-owner-a', projectId: 'credit-project-a', requestId: 'credit-request-a',
};

function amount(sourceId: string, statementDate = '2025-03-01', value: string | null = '100'): CreditFacilitySupplementInput['total'] {
  return { bank: '示例银行', asOf: '2025-02-28', currency: 'CNY', unit: '万元', basis: '授信额度', scope: 'consolidated',
    amount: value, sourceId, statementDate };
}

function input(overrides: Partial<CreditFacilitySupplementInput> = {}): CreditFacilitySupplementInput {
  return {
    total: amount('statement-total'),
    used: amount('statement-used', '2025-03-02', '60'),
    unused: amount('statement-unused', '2025-03-03', '40'),
    ...overrides,
  };
}

class TransactionMock implements CreditFacilitySupplementClient {
  readonly calls: Array<{ sql: string; values: unknown[] }> = [];
  readonly rows: Record<string, unknown>[] = [];
  readonly outbox: Record<string, unknown>[] = [];
  activeProject = true;
  failOutbox = false;
  released = false;
  private before: { rows: Record<string, unknown>[]; outbox: Record<string, unknown>[] } | null = null;

  async query(sql: string, values: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    this.calls.push({ sql, values });
    if (sql === 'BEGIN') { this.before = { rows: structuredClone(this.rows), outbox: structuredClone(this.outbox) }; return { rows: [] }; }
    if (sql === 'COMMIT') { this.before = null; return { rows: [] }; }
    if (sql === 'ROLLBACK') {
      if (this.before) {
        this.rows.splice(0, this.rows.length, ...this.before.rows);
        this.outbox.splice(0, this.outbox.length, ...this.before.outbox);
      }
      this.before = null;
      return { rows: [] };
    }
    if (sql.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('FROM bb_projects')) return { rows: this.activeProject && values[0] === context.ownerUserId && values[1] === context.projectId ? [{ id: context.projectId }] : [] };
    if (sql.includes('FROM bb_credit_facility_supplements')) {
      return { rows: this.rows.filter((row) => row.owner_user_id === values[0] && row.project_id === values[1] && row.request_id === values[2]) };
    }
    if (sql.startsWith('INSERT INTO bb_credit_facility_supplements')) {
      const result = JSON.parse(String(values[12])) as unknown;
      const row = {
        id: values[0], owner_user_id: values[1], project_id: values[2], request_id: values[3], request_hash: values[4],
        status: values[5], total_source_id: values[6], used_source_id: values[8], unused_source_id: values[10],
        supplement: result, created_at: new Date('2025-03-04T10:00:00Z'),
      };
      this.rows.push(row);
      return { rows: [row] };
    }
    if (sql.startsWith('INSERT INTO bb_outbox')) {
      if (this.failOutbox) throw new Error('synthetic outbox failure');
      this.outbox.push({ id: values[0], owner_user_id: values[1], aggregate_id: values[2], payload: JSON.parse(String(values[3])) });
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }

  release(): void { this.released = true; }
}

function dependencies(client: TransactionMock): CreditFacilitySupplementDependencies {
  let id = 0;
  return {
    pool: {
      connect: async () => client,
      query: async (sql, values = []) => client.query(sql, values),
    },
    newId: () => `credit-generated-${++id}`,
  };
}

test('stores each user assertion and domain status without manuscript promotion', async () => {
  const client = new TransactionMock();
  const saved = await appendCreditFacilitySupplement(dependencies(client), context, input());
  assert.equal(saved.result.status, 'user_asserted');
  assert.equal(saved.result.eligibleForManuscript, false);
  assert.equal(saved.result.amounts.total.sourceId, 'statement-total');
  assert.equal(saved.result.amounts.used.statementDate, '2025-03-02');
  assert.equal(client.rows.length, 1);
  assert.equal(client.outbox.length, 1);
  assert.equal(client.outbox[0]!.aggregate_id, saved.supplementId);
  assert.match(client.calls.find((call) => call.sql.includes('FROM bb_projects'))!.sql, /owner_user_id=\$1 AND id=\$2 AND deleted_at IS NULL FOR UPDATE/);
  assert.equal(client.released, true);
});

test('persists incomplete/conflicted statements, preserving invalid source/date values verbatim', async () => {
  const incomplete = input({ total: amount('', 'not-a-date') });
  const incompleteStore = new TransactionMock();
  const needsConfirmation = await appendCreditFacilitySupplement(dependencies(incompleteStore), context, incomplete);
  assert.equal(needsConfirmation.result.status, 'needs_confirmation');
  assert.equal(needsConfirmation.result.reason, 'missing_source');
  assert.equal(needsConfirmation.result.amounts.total.sourceId, '');
  assert.equal(needsConfirmation.result.amounts.total.statementDate, 'not-a-date');

  const mismatch = input({ unused: amount('statement-unused', '2025-03-03', '50') });
  const conflictStore = new TransactionMock();
  const conflicted = await appendCreditFacilitySupplement(dependencies(conflictStore), context, mismatch);
  assert.equal(conflicted.result.status, 'conflicted');
  assert.equal(conflicted.result.eligibleForManuscript, false);
});

test('same owner/project/request replays exact payload; changed payload conflicts without a second event', async () => {
  const client = new TransactionMock();
  const deps = dependencies(client);
  const first = await appendCreditFacilitySupplement(deps, context, input());
  const replay = await appendCreditFacilitySupplement(deps, context, input());
  assert.equal(replay.replayed, true);
  assert.equal(replay.supplementId, first.supplementId);
  assert.equal(client.rows.length, 1);
  assert.equal(client.outbox.length, 1);
  await assert.rejects(appendCreditFacilitySupplement(deps, context, input({ total: amount('different-source') })),
    /CREDIT_SUPPLEMENT_IDEMPOTENCY_MISMATCH/);
  assert.equal(client.rows.length, 1);
  assert.equal(client.outbox.length, 1);
});

test('requires an active project and rolls the supplement back if outbox append fails', async () => {
  const deleted = new TransactionMock();
  deleted.activeProject = false;
  await assert.rejects(appendCreditFacilitySupplement(dependencies(deleted), context, input()), /CREDIT_SUPPLEMENT_PROJECT_NOT_FOUND/);
  assert.equal(deleted.rows.length, 0);

  const outboxFailure = new TransactionMock();
  outboxFailure.failOutbox = true;
  await assert.rejects(appendCreditFacilitySupplement(dependencies(outboxFailure), context, input()), /synthetic outbox failure/);
  assert.equal(outboxFailure.rows.length, 0);
  assert.equal(outboxFailure.outbox.length, 0);
  assert.equal(outboxFailure.calls.at(-1)?.sql, 'ROLLBACK');
  assert.equal(outboxFailure.released, true);
});

test('owner-scoped read never returns a foreign project record', async () => {
  const client = new TransactionMock();
  const deps = dependencies(client);
  await appendCreditFacilitySupplement(deps, context, input());
  const read = await getCreditFacilitySupplement(deps, context);
  assert.equal(read?.result.amounts.total.sourceId, 'statement-total');
  const foreign = await getCreditFacilitySupplement(deps, { ...context, ownerUserId: 'other-owner' });
  assert.equal(foreign, null);
  assert.match(client.calls.at(-1)!.sql, /s\.owner_user_id=\$1 AND s\.project_id=\$2/);
});

test('live PostgreSQL persists immutable supplements with atomic outbox and owner isolation', {
  skip: !testDatabaseUrl && 'set CREDIT_FACILITY_SUPPLEMENT_TEST_DATABASE_URL for migrated PostgreSQL 16',
}, async () => {
  const pool = new Pool({ connectionString: testDatabaseUrl });
  const suffix = randomUUID();
  const owner = `credit-owner-${suffix}`;
  const project = `credit-project-${suffix}`;
  const foreignOwner = `credit-foreign-owner-${suffix}`;
  const foreignProject = `credit-foreign-project-${suffix}`;
  const liveContext: TrustedCreditFacilitySupplementContext = { ownerUserId: owner, projectId: project, requestId: `credit-request-${suffix}` };
  const liveInput = input({
    total: amount(`synthetic-total-${suffix}`),
    used: amount(`synthetic-used-${suffix}`, '2025-03-02', '60'),
    unused: amount(`synthetic-unused-${suffix}`, '2025-03-03', '40'),
  });
  const sqlSuffix = suffix.replaceAll('-', '').slice(0, 16);
  try {
    await pool.query('INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES ($1,$2,$3,$4)', [project, owner, 'Synthetic credit supplement test', 'update']);
    await pool.query('INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES ($1,$2,$3,$4)', [foreignProject, foreignOwner, 'Synthetic foreign test', 'update']);
    const deps: CreditFacilitySupplementDependencies = { pool, newId: () => `credit-event-${randomUUID()}` };
    const saved = await appendCreditFacilitySupplement(deps, liveContext, liveInput);
    const replay = await appendCreditFacilitySupplement(deps, liveContext, liveInput);
    assert.equal(saved.result.status, 'user_asserted');
    assert.equal(replay.replayed, true);
    assert.equal(replay.supplementId, saved.supplementId);
    await assert.rejects(appendCreditFacilitySupplement(deps, liveContext, input({
      ...liveInput, total: amount(`synthetic-total-changed-${suffix}`),
    })), /CREDIT_SUPPLEMENT_IDEMPOTENCY_MISMATCH/);
    assert.equal(await getCreditFacilitySupplement(deps, { ...liveContext, ownerUserId: foreignOwner, projectId: foreignProject }), null);

    const counts = await pool.query(`SELECT count(*)::int AS supplements FROM bb_credit_facility_supplements WHERE owner_user_id=$1 AND project_id=$2`, [owner, project]);
    assert.equal(counts.rows[0]!.supplements, 1);
    const outbox = await pool.query(`SELECT count(*)::int AS events FROM bb_outbox WHERE owner_user_id=$1 AND aggregate_id=$2 AND event_type='credit.facility_supplement.appended'`, [owner, saved.supplementId]);
    assert.equal(outbox.rows[0]!.events, 1);
    const incomplete = await appendCreditFacilitySupplement(deps,
      { ...liveContext, requestId: `incomplete-${suffix}` },
      input({ total: amount('', 'not-a-date') }));
    assert.equal(incomplete.result.status, 'needs_confirmation');
    const incompleteRow = await pool.query(
      'SELECT total_source_id, total_statement_date, supplement FROM bb_credit_facility_supplements WHERE id=$1',
      [incomplete.supplementId],
    );
    assert.equal(incompleteRow.rows[0]!.total_source_id, '');
    assert.equal(incompleteRow.rows[0]!.total_statement_date, null);
    assert.equal(incompleteRow.rows[0]!.supplement.amounts.total.statementDate, 'not-a-date');
    await assert.rejects(pool.query('UPDATE bb_credit_facility_supplements SET status=$1 WHERE id=$2', ['conflicted', saved.supplementId]),
      /credit facility supplements are immutable/);
    await assert.rejects(pool.query('DELETE FROM bb_credit_facility_supplements WHERE id=$1', [saved.supplementId]),
      /credit facility supplements are immutable/);

    await pool.query(`CREATE FUNCTION bb_test_fail_credit_outbox_${sqlSuffix}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event_type='credit.facility_supplement.appended' THEN RAISE EXCEPTION 'synthetic credit outbox failure'; END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER bb_test_fail_credit_outbox_${sqlSuffix} BEFORE INSERT ON bb_outbox
      FOR EACH ROW EXECUTE FUNCTION bb_test_fail_credit_outbox_${sqlSuffix}()`);
    try {
      await assert.rejects(appendCreditFacilitySupplement(deps, { ...liveContext, requestId: `rollback-${suffix}` }, liveInput), /synthetic credit outbox failure/);
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS bb_test_fail_credit_outbox_${sqlSuffix} ON bb_outbox`);
      await pool.query(`DROP FUNCTION IF EXISTS bb_test_fail_credit_outbox_${sqlSuffix}()`);
    }
    const afterRollback = await pool.query('SELECT count(*)::int AS count FROM bb_credit_facility_supplements WHERE owner_user_id=$1 AND project_id=$2', [owner, project]);
    assert.equal(afterRollback.rows[0]!.count, 2);
    assert.ok(await pool.query('SELECT id FROM bb_projects WHERE id=$1', [foreignProject]));
  } finally {
    // Append-only supplement fixtures intentionally remain in the disposable test database.
    await pool.end();
  }
});
