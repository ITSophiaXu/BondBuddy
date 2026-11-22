import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { balanceBand, probeProviderBalance } from './provider-balance-probe.js';
import { isolatedTestDatabase } from './test-database.js';

const database = await isolatedTestDatabase('BB_TEST_PROVIDER_BALANCE_DATABASE_URL');

test('balance bands and alerts keep only availability and a numeric range', async () => {
  assert.equal(balanceBand('-0.1', 1), 'negative');
  assert.equal(balanceBand('0', 1), 'zero');
  assert.equal(balanceBand('0.5', 1), 'below_threshold');
  assert.equal(balanceBand('2', 1), 'healthy');
  const calls: { sql: string; args: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, args: unknown[] = []) => {
      calls.push({ sql, args });
      return sql.startsWith('INSERT') ? { rows: [{ id: 'synthetic-alert' }] } : { rows: [] };
    },
  } as any;
  const fetcher = async (_url: unknown, init: RequestInit) => {
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer synthetic-key');
    return new Response(
      JSON.stringify({
        is_available: false,
        balance_infos: [{ currency: 'USD', total_balance: '-0.5', topped_up_balance: 'private' }],
      }),
      { status: 200 },
    );
  };
  const result = await probeProviderBalance(pool, {
    key: 'synthetic-key',
    threshold: 1,
    fetcher: fetcher as typeof fetch,
  });
  assert.deepEqual(result, { status: 'critical', is_available: false, balance_band: 'negative' });
  assert.equal((calls[0].args[4] as { balance_band: string }).balance_band, 'negative');
  assert.ok(!JSON.stringify(calls).includes('synthetic-key'));
  assert.ok(!JSON.stringify(calls).includes('-0.5'));
  calls.length = 0;
  const failed = await probeProviderBalance(pool, {
    key: 'synthetic-key',
    threshold: 1,
    fetcher: (async () => {
      throw Error('private');
    }) as typeof fetch,
  });
  assert.equal(failed.status, 'warning');
  assert.equal(calls[0].args[1], 'scheduled_task_failed');
  assert.equal(
    (calls[0].args[4] as { reason_code: string }).reason_code,
    'provider_balance_probe_failed',
  );
});

test(
  'balance probe writes critical and warning alerts through the existing schema',
  { skip: !database },
  async () => {
    const pool = new Pool({ connectionString: database });
    try {
      const fetcher = (async () =>
        new Response(JSON.stringify({ is_available: false, balance_infos: [] }), {
          status: 200,
        })) as typeof fetch;
      await probeProviderBalance(pool, { key: 'synthetic-key', threshold: 1, fetcher });
      await probeProviderBalance(pool, {
        key: 'synthetic-key',
        threshold: 1,
        fetcher: (async () => {
          throw Error('synthetic');
        }) as typeof fetch,
      });
      const rows = (
        await pool.query(
          "SELECT kind,severity,detail->>'reason_code' reason FROM bb_ops_alerts WHERE detail->>'task'='provider_balance' ORDER BY severity",
        )
      ).rows;
      assert.deepEqual(rows, [
        { kind: 'scheduled_task_failed', severity: 'critical', reason: 'provider_balance_low' },
        {
          kind: 'scheduled_task_failed',
          severity: 'warning',
          reason: 'provider_balance_probe_failed',
        },
      ]);
    } finally {
      await pool.end();
    }
  },
);
