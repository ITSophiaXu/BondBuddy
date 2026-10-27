import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url), { Client } = require('pg');
const out = resolve('.local/production-supplement-20261027');
const name = 'bb_prod_supplement01_20261027';
const base = 'postgresql://bb_successor_test@127.0.0.1:15542/';
const client = new Client({ connectionString: `${base}postgres` });
const summary = { startedAt: new Date().toISOString(), database:name, source:'template0', success:false };
await client.connect();
try {
  const identity = (await client.query(`SELECT current_user,inet_server_addr()::text AS address,inet_server_port() AS port,
    current_setting('data_directory') AS data_directory`)).rows[0];
  if (identity.current_user !== 'bb_successor_test' || identity.port !== 15542
    || !identity.data_directory.replaceAll('\\','/').endsWith('/ux-coverage-20261026/.local/test-successor-postgres/data'))
    throw Error('Unexpected test cluster identity');
  summary.clusterIdentity = identity;
  if ((await client.query('SELECT 1 FROM pg_database WHERE datname=$1',[name])).rowCount) throw Error('Template already exists; preserve and inspect');
  await client.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
} finally { await client.end(); }
summary.migrationsBefore = readdirSync('db/migrations').filter(value=>/^\d+.*\.sql$/.test(value)).sort()
  .map(path=>({path,sha256:createHash('sha256').update(readFileSync(`db/migrations/${path}`)).digest('hex')}));
const run = spawnSync(process.execPath,['db/migrate.mjs'],{cwd:process.cwd(),windowsHide:true,
  env:{...process.env,DATABASE_URL:`${base}${name}`},encoding:'utf8',maxBuffer:32*1024*1024});
writeFileSync(`${out}/migrate01.stdout.log`,run.stdout??'');
writeFileSync(`${out}/migrate01.stderr.log`,run.stderr??'');
summary.exitCode=run.status; summary.error=run.error?String(run.error):null;
if (run.status===0) {
  const audit = new Client({connectionString:`${base}${name}`}); await audit.connect();
  try { summary.audit=(await audit.query(`SELECT current_database(),
    (SELECT count(*)::int FROM bb_schema_migrations) AS migration_count,
    (SELECT max(filename) FROM bb_schema_migrations) AS latest,
    (SELECT count(*)::int FROM bb_runs) AS runs,
    (SELECT count(*)::int FROM bb_run_supplement_quotes) AS quotes`)).rows[0]; }
  finally {await audit.end();}
}
summary.migrationsAfter = summary.migrationsBefore.map(({path})=>({path,
  sha256:createHash('sha256').update(readFileSync(`db/migrations/${path}`)).digest('hex')}));
summary.sourcesStable=JSON.stringify(summary.migrationsBefore)===JSON.stringify(summary.migrationsAfter);
summary.completedAt=new Date().toISOString();summary.success=run.status===0&&summary.sourcesStable;
writeFileSync(`${out}/migrate01-result.json`,JSON.stringify(summary,null,2));
process.stdout.write(JSON.stringify({success:summary.success,exitCode:summary.exitCode,audit:summary.audit,sourcesStable:summary.sourcesStable})+'\n');
if(!summary.success) process.exitCode=1;



