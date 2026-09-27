import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Pool } from 'pg';
import { isolatedTestDatabase } from './test-database.js';

const databaseUrl = await isolatedTestDatabase();
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : undefined;

after(async () => {
  if (!pool) return;
  try {
    assert.equal((await pool.query('SELECT 1 AS value')).rows[0].value, 1);
  } finally {
    await pool.end();
  }
});

test('test database remains available through the file teardown', { skip: !pool }, async () => {
  assert.equal((await pool!.query('SELECT 1 AS value')).rows[0].value, 1);
});
