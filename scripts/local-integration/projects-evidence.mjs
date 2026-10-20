import { Pool } from 'pg';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { databaseURL,runtime,instance } from './config.mjs';
if(instance!=='projects-20261020')throw Error('Use the isolated projects instance');
const db=new Pool({connectionString:databaseURL});
try{
  const owner=(await db.query("SELECT id FROM bb_users WHERE username='integration_user'")).rows[0].id;
  const projects=(await db.query('SELECT id,name,kind FROM bb_projects WHERE owner_user_id=$1 AND deleted_at IS NULL ORDER BY created_at',[owner])).rows;
  const runs=(await db.query('SELECT id,project_id,task_kind,state,stage,artifact_id FROM bb_runs WHERE owner_user_id=$1 ORDER BY created_at',[owner])).rows;
  const calls=(await db.query('SELECT a.id,j.run_id,a.status,a.usage_status FROM bb_model_call_attempts a JOIN bb_jobs j ON j.owner_user_id=a.owner_user_id AND j.id=a.job_id WHERE a.owner_user_id=$1',[owner])).rows;
  const files=(await db.query("SELECT a.id,a.version,a.run_id,a.sha256,a.delivery_status FROM bb_artifact_versions a JOIN bb_runs r ON r.owner_user_id=a.owner_user_id AND r.id=a.run_id WHERE a.owner_user_id=$1 AND r.state='succeeded' AND a.delivery_status='available'",[owner])).rows;
  const evidence={checkedAt:new Date().toISOString(),data:'synthetic input; real PostgreSQL, Azurite, worker and model',projects,runs,calls,files};
  mkdirSync(runtime,{recursive:true});writeFileSync(join(runtime,'projects-evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
}finally{await db.end();}
