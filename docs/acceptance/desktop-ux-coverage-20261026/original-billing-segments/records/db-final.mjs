import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require=createRequire(import.meta.url),{Client}=require('pg');
const base='postgresql://bb_successor_test@127.0.0.1:15542/';
const template='bb_segments_final02_20261027',intermediates=['bb_segments_template_20261027','bb_segments_final_20261027'];
const maintenance=new Client({connectionString:`${base}postgres`});await maintenance.connect();
const audit={observedAt:new Date().toISOString(),template,intermediates};
try{
  audit.cluster=(await maintenance.query(`SELECT current_user,inet_server_port() AS port,current_setting('data_directory') AS data`)).rows[0];
  assert.equal(audit.cluster.current_user,'bb_successor_test');assert.equal(audit.cluster.port,15542);
  assert.ok(audit.cluster.data.replaceAll('\\','/').endsWith('/ux-coverage-20261026/.local/test-successor-postgres/data'));
  audit.clientsBefore=(await maintenance.query(`SELECT pid,datname,state FROM pg_stat_activity WHERE datname LIKE 'bb%' ORDER BY pid`)).rows;
  assert.equal(audit.clientsBefore.length,0,'Preserve every live test client');
  audit.databasesBefore=(await maintenance.query(`SELECT datname,pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname LIKE 'bb%' ORDER BY datname`)).rows;
  assert.equal(audit.databasesBefore.filter(value=>value.datname.startsWith(`${template}_t`)).length,0,'Unexpected leftover clone requires inspection');
  audit.removed=[];
  for(const name of intermediates){
    const meta=audit.databasesBefore.find(value=>value.datname===name);if(!meta)continue;
    assert.equal(meta.owner,'bb_successor_test');
    const inspect=new Client({connectionString:`${base}${name}`});await inspect.connect();
    try{assert.equal((await inspect.query('SELECT count(*)::int AS n FROM bb_runs')).rows[0].n,0,'Preserve nonempty intermediate');}
    finally{await inspect.end();}
    await maintenance.query(`DROP DATABASE "${name}"`);audit.removed.push(name);
  }
  audit.clientsAfter=(await maintenance.query(`SELECT pid,datname,state FROM pg_stat_activity WHERE datname LIKE 'bb%' ORDER BY pid`)).rows;
  assert.equal(audit.clientsAfter.length,0);
  audit.databasesAfter=(await maintenance.query(`SELECT datname FROM pg_database WHERE datname LIKE 'bb%' ORDER BY datname`)).rows;
}finally{await maintenance.end();}
const inspect=new Client({connectionString:`${base}${template}`});await inspect.connect();
try{audit.templateState=(await inspect.query(`SELECT
  (SELECT count(*)::int FROM bb_schema_migrations) AS migrations,(SELECT max(filename) FROM bb_schema_migrations) AS latest,
  (SELECT count(*)::int FROM bb_runs) AS runs,(SELECT count(*)::int FROM bb_credit_reservations) AS reservations,
  (SELECT count(*)::int FROM bb_run_billing_segments) AS segments,
  (SELECT count(*)::int FROM bb_run_execution_billing_bindings) AS bindings,
  (SELECT count(*)::int FROM bb_run_billing_progress) AS meters`)).rows[0];
  assert.equal(audit.templateState.migrations,137);for(const field of ['runs','reservations','segments','bindings','meters'])assert.equal(audit.templateState[field],0);
}finally{await inspect.end();}
audit.completedAt=new Date().toISOString();audit.success=true;
writeFileSync('.local/billing-segments-20261027/db-final.json',JSON.stringify(audit,null,2));
process.stdout.write(JSON.stringify(audit,null,2)+'\n');
