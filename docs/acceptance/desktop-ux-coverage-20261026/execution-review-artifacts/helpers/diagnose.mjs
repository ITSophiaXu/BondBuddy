import assert from 'node:assert/strict';
import {Pool} from 'pg';
const pool=new Pool({connectionString:'postgresql://bb_report_test@127.0.0.1:15540/postgres',max:1});
try{
  const identity=(await pool.query("SELECT current_setting('data_directory') AS path,current_setting('port') AS port")).rows[0];
  assert.equal(identity.path.replaceAll('\\','/').toLowerCase(),'c:/users/lezhai/downloads/bondbuddy/ux-coverage-20261026/.local/report-postgres/data');
  assert.equal(identity.port,'15540');
  console.log(JSON.stringify((await pool.query(`SELECT pid,datname,state,wait_event_type,wait_event,pg_blocking_pids(pid) AS blockers,left(query,350) AS query
    FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid() ORDER BY datname,pid`)).rows,null,2));
}finally{await pool.end();}
