import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import {
  nafmiiMtnChapterTemplate,
  nafmiiMtnCoverageManifest,
  nafmiiMtnDraftRulePack,
  type RulePack,
} from '@bondbuddy/domain';
import {
  appendTestRulePackRelease,
  appendTestRulePackRollback,
  appendTestRulePackWithdrawal,
  getCurrentTestRulePack,
  type RulePackLedgerClient,
  type RulePackLedgerDependencies,
} from './rule-pack-release-ledger.js';
import { isolatedTestDatabase } from './test-database.js';

const testDatabaseUrl = await isolatedTestDatabase('RULE_PACK_LEDGER_TEST_DATABASE_URL');

const sourceId = 'synthetic-ledger-source';
const releaseTime = '2026-09-25T12:00:00Z';
let packCounter = 0;

function fixturePack(packId = `ledger-pack-${++packCounter}`, version = 'test.1', supersedes: string | null = null): RulePack {
  const draft = structuredClone(nafmiiMtnDraftRulePack) as RulePack;
  const baseRule = draft.rules[0]!;
  return {
    ...draft,
    pack_id: packId,
    version,
    supersedes_version: supersedes,
    sources: [{
      source_id: sourceId,
      kind: 'internal_method',
      authority: 'synthetic test fixture',
      document_title: 'Synthetic rule source',
      source_version: 'fixture.1',
      official_url: null,
      document_hash: 'a'.repeat(64),
      clause_locator: 'synthetic fixture only',
      exact_quote: 'Synthetic text used only by automated tests.',
      published_on: null,
      effective_from: '2020-01-01',
      effective_to: null,
      verified_by: 'synthetic-fixture-author',
      verified_at: '2026-09-25T11:00:00Z',
    }],
    rules: [{
      ...baseRule,
      rule_id: `${packId}-rule`,
      source_ref_ids: [sourceId],
      enabled: true,
      enforcement: 'soft_check',
      outputs: { ...baseRule.outputs, severity: 'warning' },
    }],
    sample_suite: {
      ...draft.sample_suite,
      suite_id: `${packId}-samples`,
      data_classification: 'synthetic',
      cases: draft.sample_suite.cases.map((item, index) => ({
        ...item,
        case_id: `${packId}-case-${index + 1}`,
        evidence_ref: 'synthetic:test-only',
        result: 'passed',
        reviewed_by: 'synthetic-fixture-author',
        reviewed_at: '2026-09-25T11:00:00Z',
      })),
    },
    reviews: [],
    release: null,
    withdrawal: null,
  };
}

function releaseInput(draft: RulePack, requestId = `request-${randomUUID()}`, occurredAt = releaseTime) {
  const template = structuredClone(nafmiiMtnChapterTemplate);
  template.rule_pack_id = draft.pack_id;
  template.template_id = `${draft.pack_id}-template`;
  template.version = draft.version;
  for (const chapter of template.chapters) chapter.source_ref_ids = [sourceId];
  const coverage = structuredClone(nafmiiMtnCoverageManifest);
  coverage.rule_pack_id = draft.pack_id;
  coverage.manifest_id = `${draft.pack_id}-coverage`;
  coverage.version = draft.version;
  coverage.items = coverage.items.map((item) => ({ ...item, disposition: 'covered', source_ref_ids: [sourceId], rationale: 'Synthetic test fixture.' }));
  coverage.open_blockers = [];
  return {
    draft, template, coverage, requestId, occurredAt, reason: 'synthetic automated test only', actorId: 'synthetic-test-operator',
    reviews: [
      { reviewer_id: 'synthetic-industry-reviewer', reviewer_role: 'industry_reviewer' as const, reviewed_at: '2026-09-25T11:00:00Z', source_verified: true, scope_verified: true, samples_verified: true, notes: 'Synthetic fixture; not a professional attestation.' },
      { reviewer_id: 'synthetic-technical-reviewer', reviewer_role: 'technical_reviewer' as const, reviewed_at: '2026-09-25T11:00:00Z', source_verified: true, scope_verified: true, samples_verified: true, notes: 'Synthetic fixture; not a professional attestation.' },
    ],
  };
}

class MemoryClient implements RulePackLedgerClient {
  readonly calls: Array<{ sql: string; values: unknown[] }> = [];
  readonly events: Array<Record<string, unknown>> = [];
  readonly outbox: Array<Record<string, unknown>> = [];
  private snapshot: { events: Record<string, unknown>[]; outbox: Record<string, unknown>[] } | null = null;
  private nextId = 0;
  failOutbox = false;

  async query(sql: string, values: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    this.calls.push({ sql, values });
    if (sql === 'BEGIN') { this.snapshot = { events: structuredClone(this.events), outbox: structuredClone(this.outbox) }; return { rows: [] }; }
    if (sql === 'COMMIT') { this.snapshot = null; return { rows: [] }; }
    if (sql === 'ROLLBACK') {
      if (this.snapshot) {
        this.events.splice(0, this.events.length, ...this.snapshot.events);
        this.outbox.splice(0, this.outbox.length, ...this.snapshot.outbox);
      }
      this.snapshot = null;
      return { rows: [] };
    }
    if (sql.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('FROM bb_rule_pack_release_events')) {
      const found = this.events.filter((row) => row.pack_id === values[0] &&
        (values.length === 1 || (sql.includes('request_id = $2') ? row.request_id === values[1] : row.id === values[1])));
      if (sql.includes('ORDER BY sequence DESC')) found.sort((a, b) => Number(b.sequence) - Number(a.sequence));
      return { rows: sql.includes('LIMIT 1') ? found.slice(0, 1) : found };
    }
    if (sql.startsWith('INSERT INTO bb_rule_pack_release_events')) {
      const row = {
        id: values[0], pack_id: values[1], request_id: values[2], request_hash: values[3], sequence: values[4],
        action: values[5], release_hash: values[6], target_event_id: values[7], pack_snapshot: JSON.parse(String(values[8])),
        actor_id: values[9], reason: values[10], occurred_at: values[11],
      };
      this.events.push(row);
      return { rows: [row] };
    }
    if (sql.startsWith('INSERT INTO bb_outbox')) {
      if (this.failOutbox) throw new Error('synthetic outbox failure');
      this.outbox.push({ id: values[0], aggregate_id: values[1], event_type: values[2], payload: JSON.parse(String(values[3])) });
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }

  release(): void {}
}

function dependencies(client: MemoryClient): RulePackLedgerDependencies {
  let sequence = 0;
  return { pool: { connect: async () => client, query: (sql, values = []) => client.query(sql, values) }, newId: () => `event-${++sequence}` };
}

test('persists test-only release snapshots and transactionally emits an outbox event', async () => {
  const client = new MemoryClient();
  const deps = dependencies(client);
  const input = releaseInput(fixturePack());
  const first = await appendTestRulePackRelease(deps, input);
  assert.equal(first.action, 'test_release');
  assert.equal(first.pack.status, 'published');
  assert.equal(first.pack.release?.channel, 'test');
  assert.equal(first.pack.sample_suite.data_classification, 'synthetic');
  assert.equal(client.events.length, 1);
  assert.equal(client.outbox.length, 1);
  assert.equal(client.outbox[0]!.event_type, 'rule_pack.test_release');
  assert.equal(client.calls.some(({ sql }) => /production/i.test(sql)), false);

  const replay = await appendTestRulePackRelease(deps, input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.eventId, first.eventId);
  assert.equal(client.events.length, 1);
  await assert.rejects(appendTestRulePackRelease(deps, { ...input, reason: 'changed request body' }), /IDEMPOTENCY_MISMATCH/);
});

test('withdrawal deactivates the current selection and test rollback restores only a date-valid immutable target', async () => {
  const client = new MemoryClient();
  const deps = dependencies(client);
  const packId = 'ledger-rollback-pack';
  const first = await appendTestRulePackRelease(deps, releaseInput(fixturePack(packId, 'test.1')));
  const secondDraft = fixturePack(packId, 'test.2', 'test.1');
  const second = await appendTestRulePackRelease(deps, releaseInput(secondDraft, `request-${randomUUID()}`, '2026-09-25T12:30:00Z'));
  await assert.rejects(appendTestRulePackRollback(deps, packId, first.eventId, {
    actorId: 'synthetic-test-operator', requestId: `expired-${randomUUID()}`, occurredAt: '2019-01-01T00:00:00Z', reason: 'must revalidate date',
  }), /ROLLBACK_TARGET_NOT_EFFECTIVE/);
  const rollback = await appendTestRulePackRollback(deps, packId, first.eventId, {
    actorId: 'synthetic-test-operator', requestId: `rollback-${randomUUID()}`, occurredAt: '2026-09-25T13:00:00Z', reason: 'synthetic rollback test',
  });
  assert.equal(rollback.action, 'test_rollback');
  assert.equal(rollback.targetEventId, first.eventId);
  assert.equal(rollback.releaseHash, first.releaseHash);
  assert.equal(rollback.sequence, second.sequence + 1);
  assert.equal((await getCurrentTestRulePack(deps.pool, packId))?.pack.version, 'test.1');
  const withdrawn = await appendTestRulePackWithdrawal(deps, packId, {
    actorId: 'synthetic-test-operator', requestId: `withdraw-${randomUUID()}`, occurredAt: '2026-09-25T13:10:00Z', reason: 'synthetic withdrawal test',
  });
  assert.equal(withdrawn.pack.status, 'withdrawn');
  assert.equal((await getCurrentTestRulePack(deps.pool, packId))?.active, false);
  await assert.rejects(appendTestRulePackRollback(deps, packId, first.eventId, {
    actorId: 'synthetic-test-operator', requestId: `withdrawn-current-${randomUUID()}`, occurredAt: '2026-09-25T13:20:00Z', reason: 'withdrawal must remain inactive',
  }), /RULE_PACK_TEST_RELEASE_NOT_ACTIVE/);
});

test('outbox failure rolls back the release event and incomplete bundles are rejected', async () => {
  const failed = new MemoryClient();
  failed.failOutbox = true;
  await assert.rejects(appendTestRulePackRelease(dependencies(failed), releaseInput(fixturePack())), /synthetic outbox failure/);
  assert.equal(failed.events.length, 0);
  assert.equal(failed.outbox.length, 0);
  assert.equal(failed.calls.at(-1)?.sql, 'ROLLBACK');

  const incomplete = releaseInput(fixturePack());
  incomplete.coverage.open_blockers.push({ blocker_id: 'synthetic-open', description: 'Synthetic blocker.', required_evidence: 'Synthetic fixture.' });
  await assert.rejects(appendTestRulePackRelease(dependencies(new MemoryClient()), incomplete), /RULE_PACK_COVERAGE_INCOMPLETE/);
});

test('accepts UTC timestamps with and without fractional seconds and rejects normalized impossible dates', async () => {
  const client = new MemoryClient();
  const deps = dependencies(client);
  const first = await appendTestRulePackRelease(deps, releaseInput(fixturePack()));
  const withdrawal = await appendTestRulePackWithdrawal(deps, first.pack.pack_id, {
    actorId: 'synthetic-test-operator', requestId: `fractional-${randomUUID()}`,
    occurredAt: '2026-09-25T12:30:00.125Z', reason: 'fractional timestamp fixture',
  });
  assert.equal(withdrawal.pack.status, 'withdrawn');
  await assert.rejects(appendTestRulePackWithdrawal(deps, first.pack.pack_id, {
    actorId: 'synthetic-test-operator', requestId: `impossible-${randomUUID()}`,
    occurredAt: '2026-02-30T12:30:00Z', reason: 'impossible calendar date',
  }), /INVALID_RULE_PACK_LEDGER_CONTEXT/);
});

test('live PostgreSQL 16 stores test release, rollback and withdrawal as immutable rows', {
  skip: !testDatabaseUrl && 'set RULE_PACK_LEDGER_TEST_DATABASE_URL after migration 0018 is applied',
}, async () => {
  const pool = new Pool({ connectionString: testDatabaseUrl });
  const outer = await pool.connect();
  await outer.query('BEGIN');
  let savepoint = 0;
  const transactionalPool = {
    connect: async () => ({
      query: async (sql: string, values?: unknown[]) => {
        if (sql === 'BEGIN') { await outer.query(`SAVEPOINT ledger_${++savepoint}`); return { rows: [] }; }
        if (sql === 'COMMIT') { await outer.query(`RELEASE SAVEPOINT ledger_${savepoint}`); return { rows: [] }; }
        if (sql === 'ROLLBACK') { await outer.query(`ROLLBACK TO SAVEPOINT ledger_${savepoint}`); await outer.query(`RELEASE SAVEPOINT ledger_${savepoint}`); return { rows: [] }; }
        return outer.query(sql, values);
      },
      release: () => undefined,
    }),
    query: (sql: string, values?: unknown[]) => outer.query(sql, values),
  };
  const deps: RulePackLedgerDependencies = { pool: transactionalPool, newId: () => randomUUID() };
  const id = `ledger-live-${randomUUID().replaceAll('-', '').slice(0, 18)}`;
  const packId = id;
  try {
    const invalidRows = [
      { suffix: 'missing_release', snapshot: { pack_id: packId, status: 'published' }, hash: 'a'.repeat(64) },
      { suffix: 'production_channel', snapshot: { pack_id: packId, status: 'published', release: { channel: 'production', content_hash: 'b'.repeat(64) } }, hash: 'b'.repeat(64) },
    ];
    for (const invalid of invalidRows) {
      await outer.query('SAVEPOINT invalid_rule_snapshot');
      await assert.rejects(outer.query(
        `INSERT INTO bb_rule_pack_release_events
          (id,pack_id,request_id,request_hash,sequence,action,release_hash,target_event_id,pack_snapshot,actor_id,reason,occurred_at)
         VALUES ($1,$2,$3,$4,1,'test_release',$5,NULL,$6::jsonb,'synthetic-test-operator','negative database constraint test',$7)`,
        [`${id}-${invalid.suffix}`, packId, `bad-${invalid.suffix}`, 'c'.repeat(64), invalid.hash,
          JSON.stringify(invalid.snapshot), releaseTime],
      ), /check constraint/);
      await outer.query('ROLLBACK TO SAVEPOINT invalid_rule_snapshot');
      await outer.query('RELEASE SAVEPOINT invalid_rule_snapshot');
    }
    const one = await appendTestRulePackRelease(deps, releaseInput(fixturePack(packId, 'test.1')));
    const two = await appendTestRulePackRelease(deps, releaseInput(fixturePack(packId, 'test.2', 'test.1'), `request-${randomUUID()}`, '2026-09-25T12:30:00Z'));
    const reverted = await appendTestRulePackRollback(deps, packId, one.eventId, {
      actorId: 'synthetic-test-operator', requestId: `rollback-${randomUUID()}`, occurredAt: '2026-09-25T13:00:00Z', reason: 'synthetic live rollback',
    });
    assert.equal(reverted.releaseHash, one.releaseHash);
    assert.equal((await getCurrentTestRulePack(transactionalPool, packId))?.pack.version, 'test.1');
    const withdrawn = await appendTestRulePackWithdrawal(deps, packId, {
      actorId: 'synthetic-test-operator', requestId: `withdraw-${randomUUID()}`, occurredAt: '2026-09-25T13:10:00Z', reason: 'synthetic live withdrawal',
    });
    assert.equal(withdrawn.pack.status, 'withdrawn');
    assert.equal((await outer.query(`SELECT count(*)::int AS n FROM bb_outbox WHERE aggregate_type='rule_pack' AND aggregate_id=$1`, [packId])).rows[0]!.n, 4);
    await outer.query('SAVEPOINT immutable_probe');
    await assert.rejects(outer.query(`UPDATE bb_rule_pack_release_events SET reason='tampered' WHERE id=$1`, [one.eventId]), /append-only/);
    await outer.query('ROLLBACK TO SAVEPOINT immutable_probe');
    await outer.query('RELEASE SAVEPOINT immutable_probe');
    assert.equal((await outer.query(`SELECT count(*)::int AS n FROM bb_rule_pack_release_events WHERE pack_id=$1`, [packId])).rows[0]!.n, 4);
    assert.equal(two.action, 'test_release');
  } finally {
    await outer.query('ROLLBACK');
    outer.release();
    await pool.end();
  }
});
