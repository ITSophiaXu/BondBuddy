import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {Pool} from 'pg';
import {runtime,databaseURL,baseURL,ports} from './config.mjs';

const pool=new Pool({connectionString:databaseURL,connectionTimeoutMillis:5000});
const result={checkedAt:new Date().toISOString(),baseURL,services:existsSync(join(runtime,'services.json'))?JSON.parse(readFileSync(join(runtime,'services.json'),'utf8')):null};
try{
  for(const [name,url] of [['web',baseURL],['apiReadiness',`http://127.0.0.1:${ports.api}/api/v1/ready`]]){
    const response=await fetch(url,{signal:AbortSignal.timeout(5000)});
    result[name]={status:response.status,...(name==='apiReadiness'?{body:await response.json()}:{})};
  }
  result.database={name:(await pool.query('SELECT current_database() AS name')).rows[0].name};
  result.counts=(await pool.query(`SELECT (SELECT count(*)::int FROM bb_projects) AS projects,
    (SELECT count(*)::int FROM bb_material_versions) AS materials,
    (SELECT count(*)::int FROM bb_runs) AS runs`)).rows[0];
  result.jobs=(await pool.query('SELECT job_type,state,error_code,count(*)::int AS count FROM bb_jobs GROUP BY job_type,state,error_code ORDER BY job_type,state')).rows;
  result.modelGeneration={configured:false,verified:false};
  console.log(JSON.stringify(result,null,2));
  mkdirSync(runtime,{recursive:true});
  writeFileSync(join(runtime,'status.json'),JSON.stringify(result,null,2));
}finally{await pool.end();}
