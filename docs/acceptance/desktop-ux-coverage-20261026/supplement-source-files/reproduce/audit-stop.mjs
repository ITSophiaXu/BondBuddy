import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,realpathSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {Pool} from 'pg';
const root=process.cwd(),local=resolve(root,'.local/supplement-source-files');
const cluster=realpathSync(resolve(root,'.local/g03-postgres/data'));
assert.equal(cluster.toLowerCase(),resolve(root,'.local/g03-postgres/data').toLowerCase());
const pgctl=resolve(root,'../.m3-test-tools/node_modules/@embedded-postgres/windows-x64/native/bin/pg_ctl.exe');
const pool=new Pool({connectionString:'postgresql://bb_g03_test@127.0.0.1:15526/bb_g03_template_20261026'});
let audit;
try{
 const client=await pool.connect();
 try{
  const directory=(await client.query('SHOW data_directory')).rows[0].data_directory;
  const port=(await client.query('SHOW port')).rows[0].port;
  assert.equal(realpathSync(directory).toLowerCase(),cluster.toLowerCase());assert.equal(port,'15526');
  audit={cluster,port,server_version:(await client.query('SHOW server_version')).rows[0].server_version,
   postmaster_pid:Number(readFileSync(join(cluster,'postmaster.pid'),'utf8').split(/\r?\n/)[0]),
   databases:(await client.query("SELECT datname FROM pg_database WHERE datname LIKE 'bb_g03_%' ORDER BY datname")).rows,
   other_client_sessions:(await client.query("SELECT datname,pid,state FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid() ORDER BY pid")).rows,
   template_runs:(await client.query('SELECT count(*)::int n FROM bb_runs')).rows[0].n,
   template_executions:(await client.query('SELECT count(*)::int n FROM bb_run_execution_versions')).rows[0].n,
   checked_at:new Date().toISOString()};
  assert.deepEqual(audit.databases,[{datname:'bb_g03_template_20261026'}]);assert.deepEqual(audit.other_client_sessions,[]);
  assert.equal(audit.template_runs,0);assert.equal(audit.template_executions,0);
 }finally{client.release();}
}finally{await pool.end();}
writeFileSync(join(local,'database-cleanup-audit.json'),JSON.stringify(audit,null,2)+'\n');
const run=args=>{const r=spawnSync(pgctl,['-D',cluster,...args],{encoding:'utf8',windowsHide:true});return {args,status:r.status,stdout:r.stdout,stderr:r.stderr,error:r.error?.message};};
const status_before=run(['status']);assert.equal(status_before.status,0);
const stop=run(['-w','stop']);
const status_after=run(['status']);
writeFileSync(join(local,'postgres-stop.json'),JSON.stringify({cluster,pgctl,postmaster_pid:audit.postmaster_pid,status_before,stop,status_after,finished:new Date().toISOString()},null,2)+'\n');
assert.equal(stop.status,0);assert.equal(status_after.status,3);
console.log(JSON.stringify({database_audit:audit,stop:stop.status,status_after:status_after.status},null,2));
