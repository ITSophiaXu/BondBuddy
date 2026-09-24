import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const dir = resolve('db/migrations');
try {
  await pool.query('CREATE TABLE IF NOT EXISTS bb_schema_migrations(filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  for (const filename of readdirSync(dir).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
    const existing = await pool.query('SELECT 1 FROM bb_schema_migrations WHERE filename=$1',[filename]);
    if (existing.rowCount) continue;
    const client=await pool.connect();
    try { await client.query('BEGIN'); await client.query(readFileSync(resolve(dir,filename),'utf8')); await client.query('INSERT INTO bb_schema_migrations(filename) VALUES($1)',[filename]); await client.query('COMMIT'); process.stdout.write(`Applied ${filename}\n`); }
    catch(error){await client.query('ROLLBACK');throw error;} finally{client.release();}
  }
} finally { await pool.end(); }
