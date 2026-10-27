import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require=createRequire(import.meta.url),{Client}=require('pg');
const client=new Client({connectionString:'postgresql://bb_successor_test@127.0.0.1:15542/postgres'});
await client.connect();
try{
  const state={observedAt:new Date().toISOString(),databases:(await client.query(`SELECT datname FROM pg_database
    WHERE datname LIKE 'bb\_%' ESCAPE '\\' ORDER BY datname`)).rows,
    activities:(await client.query(`SELECT pid,datname,state,wait_event_type,wait_event,xact_start,query_start,
      pg_blocking_pids(pid) AS blockers,left(query,500) AS query FROM pg_stat_activity
      WHERE datname LIKE 'bb\_%' ESCAPE '\\' ORDER BY pid`)).rows};
  writeFileSync('.local/supplement-b1-20261027/db-state.json',JSON.stringify(state,null,2));
  process.stdout.write(JSON.stringify(state,null,2)+'\n');
}finally{await client.end();}
