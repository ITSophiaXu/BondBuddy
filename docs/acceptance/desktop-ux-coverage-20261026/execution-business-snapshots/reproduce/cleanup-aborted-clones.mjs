import assert from 'node:assert/strict';
import {readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {Pool} from 'pg';
const root=process.cwd(),local=resolve(root,'.local/execution-business-snapshots');
const started=new Date().toISOString(),start=JSON.parse(readFileSync(resolve(local,'pg-start-direct.json'),'utf8'));
const pool=new Pool({connectionString:'postgresql://bb_g03_test@127.0.0.1:15526/postgres',connectionTimeoutMillis:3000});
const report={started,expected_postmaster_pid:start.postmaster_pid,dropped:[]};
try {
  assert.equal((await pool.query('SHOW port')).rows[0].port,'15526');
  assert.equal(realpathSync((await pool.query('SHOW data_directory')).rows[0].data_directory),realpathSync(resolve(root,'.local/g03-postgres/data')));
  assert.equal(Number(readFileSync(resolve(root,'.local/g03-postgres/data/postmaster.pid'),'utf8').split(/\r?\n/)[0]),start.postmaster_pid);
  const clones=(await pool.query("SELECT datname,pg_get_userbyid(datdba) AS owner,datistemplate FROM pg_database WHERE datname LIKE 'bb_g03_template_20261026_t%' OR datname LIKE 'bb_execution_snapshots_template_20261026_t%' ORDER BY datname")).rows;
  const clients=(await pool.query("SELECT datname,application_name FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid() AND datname IS NOT NULL")).rows;
  assert.equal(clones.length,19); assert.deepEqual(clients,[]);
  for(const db of clones){assert.equal(db.owner,'bb_g03_test');assert.equal(db.datistemplate,false);assert.match(db.datname,/^bb_g03_template_20261026_t(?:37768|41052)_[a-f0-9]{8}$/);}
  report.before={clones,clients}; writeFileSync(resolve(local,'aborted-clone-cleanup.json'),JSON.stringify(report,null,2)+'\n');
  for(const db of clones){assert.equal((await pool.query('SELECT count(*)::int n FROM pg_stat_activity WHERE datname=$1',[db.datname])).rows[0].n,0);await pool.query('DROP DATABASE '+String.fromCharCode(34)+db.datname+String.fromCharCode(34));report.dropped.push(db.datname);writeFileSync(resolve(local,'aborted-clone-cleanup.json'),JSON.stringify(report,null,2)+'\n');}
  report.remaining=(await pool.query("SELECT datname FROM pg_database WHERE datname LIKE 'bb_g03_template_20261026_t%' OR datname LIKE 'bb_execution_snapshots_template_20261026_t%'")).rows;assert.deepEqual(report.remaining,[]);report.finished=new Date().toISOString();writeFileSync(resolve(local,'aborted-clone-cleanup.json'),JSON.stringify(report,null,2)+'\n');console.log('Removed '+report.dropped.length+' verified inactive, owned test clones; templates preserved.');
}finally{await pool.end();}
