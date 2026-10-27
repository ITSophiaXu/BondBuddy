import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require=createRequire(import.meta.url),{Client}=require('pg');
const base='postgresql://bb_successor_test@127.0.0.1:15542/';
const template='bb_b1_template_20261027',orphan='bb_b1_template_20261027_t49352_36fc6ec8';
const client=new Client({connectionString:`${base}postgres`});await client.connect();
const audit={observedAt:new Date().toISOString(),template,orphanFromInterruptedSqlSuite:orphan};
try{
  audit.cluster=(await client.query(`SELECT current_user,inet_server_port() AS port,current_setting('data_directory') AS data`)).rows[0];
  assert.equal(audit.cluster.current_user,'bb_successor_test');assert.equal(audit.cluster.port,15542);
  assert.ok(audit.cluster.data.replaceAll('\\','/').endsWith('/ux-coverage-20261026/.local/test-successor-postgres/data'));
  audit.clientsBefore=(await client.query(`SELECT pid,datname,state FROM pg_stat_activity WHERE datname LIKE 'bb%' ORDER BY pid`)).rows;
  assert.equal(audit.clientsBefore.length,0,'Preserve every live test client; no cleanup during execution');
  audit.databasesBefore=(await client.query(`SELECT datname FROM pg_database WHERE datname LIKE 'bb%' ORDER BY datname`)).rows;
  const unexpected=audit.databasesBefore.filter(value=>value.datname.startsWith(`${template}_t`)&&value.datname!==orphan);
  assert.equal(unexpected.length,0,'Unexpected test clone must be inspected separately');
  if(audit.databasesBefore.some(value=>value.datname===orphan))await client.query(`DROP DATABASE "${orphan}"`);
  audit.databasesAfter=(await client.query(`SELECT datname FROM pg_database WHERE datname LIKE 'bb%' ORDER BY datname`)).rows;
  audit.clientsAfter=(await client.query(`SELECT pid,datname,state FROM pg_stat_activity WHERE datname LIKE 'bb%' ORDER BY pid`)).rows;
}finally{await client.end();}
const inspect=new Client({connectionString:`${base}${template}`});await inspect.connect();
try{audit.templateState=(await inspect.query(`SELECT
  (SELECT count(*)::int FROM bb_schema_migrations) AS migrations,
  (SELECT max(filename) FROM bb_schema_migrations) AS latest,
  (SELECT count(*)::int FROM bb_runs) AS runs,(SELECT count(*)::int FROM bb_jobs) AS jobs,
  (SELECT count(*)::int FROM bb_run_supplement_quotes) AS quotes,
  (SELECT count(*)::int FROM bb_run_supplement_quote_confirmations) AS confirmations`)).rows[0];
  assert.equal(audit.templateState.migrations,136);assert.equal(audit.templateState.runs,0);assert.equal(audit.templateState.quotes,0);
}finally{await inspect.end();}
audit.completedAt=new Date().toISOString();audit.success=true;
writeFileSync('.local/supplement-b1-20261027/db-final.json',JSON.stringify(audit,null,2));
process.stdout.write(JSON.stringify(audit,null,2)+'\n');
