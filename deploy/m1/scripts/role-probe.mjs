// Read-only checks from the actual application container. Never log URLs or connection errors.
import { Pool } from 'pg';
import { readdirSync } from 'node:fs';
const [role, mode] = process.argv.slice(2);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000,
  statement_timeout: 10000, max: 1, options: '-c default_transaction_read_only=on' });
try {
  if (!['main', 'execution'].includes(role) || !['connect', 'schema', 'idle'].includes(mode)) throw new Error('arguments');
  const url = new URL(process.env.DATABASE_URL);
  if (role === 'execution' && (url.hostname !== 'pg-tunnel' || url.port && url.port !== '5432')) throw new Error('execution_database_target');
  if (role === 'main' && url.hostname !== 'postgres') throw new Error('main_database_target');
  await pool.query('SELECT 1');
  if (mode === 'schema') {
    const applied = new Set((await pool.query('SELECT filename FROM bb_schema_migrations')).rows.map(r => r.filename));
    if (readdirSync('db/migrations').filter(n => /^\d+.*\.sql$/.test(n)).some(n => !applied.has(n))) throw new Error('schema_incomplete');
  }
  if (mode === 'idle') {
    // Include parse jobs and the legacy review-message queue, not only authoring runs. An expired
    // lease is also unsafe: a provider call may still be executing after a lost connection.
    const jobs = Number((await pool.query("SELECT count(*) n FROM bb_jobs WHERE state='running'")).rows[0].n);
    const messages = Number((await pool.query('SELECT count(*) n FROM bb_review_messages WHERE lease_token IS NOT NULL')).rows[0].n);
    const confirmations = Number((await pool.query("SELECT count(*) n FROM bb_outbox WHERE event_type='upload.complete_requested' AND lease_token IS NOT NULL AND delivered_at IS NULL")).rows[0].n);
    if (jobs || messages || confirmations) { console.error(`role gate: ${jobs} running jobs, ${messages} leased messages, ${confirmations} leased confirmations; nothing switched`); process.exitCode = 76; }
  }
  if (!process.exitCode) console.log(`role ${role}: ${mode} ok`);
} catch {
  console.error(`role ${role}: ${mode} failed; verify protected connectivity, database target and schema (connection details withheld)`);
  process.exitCode = 77;
} finally { await pool.end(); }
