import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { referencesSql } from './cos-reference-audit.mjs';

test('reference query runs against the migrated PostgreSQL schema', { skip: !process.env.BB_TEST_DATABASE_URL }, async () => {
  const pool = new pg.Pool({ connectionString: process.env.BB_TEST_DATABASE_URL, max: 1 });
  try {
    await pool.query('BEGIN READ ONLY');
    const result = await pool.query(referencesSql);
    assert.ok(Array.isArray(result.rows));
    await pool.query('ROLLBACK');
  } finally { await pool.end(); }
});
