import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {Pool} from 'pg';
import {runtime,databaseURL,baseURL,ports} from './config.mjs';
import {inspect,sameIdentity} from './processes.mjs';
import {configured,containerStatus,generationConfig} from './linux-worker.mjs';

const pool=new Pool({connectionString:databaseURL,connectionTimeoutMillis:5000});
const result={checkedAt:new Date().toISOString(),baseURL,services:existsSync(join(runtime,'services.json'))?JSON.parse(readFileSync(join(runtime,'services.json'),'utf8')):null};
try{
  const refs=result.services?.schemaVersion===2?result.services.processes:{};
  const snapshot=inspect(Object.values(refs).map(ref=>ref.pid));
  result.liveProcesses=Object.fromEntries(['postgres','blob','api','worker','web'].map(name=>{
    const ref=refs[name];return [name,!!ref&&sameIdentity(snapshot.identities[ref.pid],ref)];
  }));
  for(const [name,url] of [['web',baseURL],['apiReadiness',`http://127.0.0.1:${ports.api}/api/v1/ready`]]){
    try{
      const response=await fetch(url,{signal:AbortSignal.timeout(5000)});
      result[name]={status:response.status,...(name==='apiReadiness'?{body:await response.json()}:{})};
    }catch(error){result[name]={error:String(error)};}
  }
  if(!result.liveProcesses.postgres)throw Error('Recorded PostgreSQL is not alive; database query skipped');
  result.database={name:(await pool.query('SELECT current_database() AS name')).rows[0].name};
  result.counts=(await pool.query(`SELECT (SELECT count(*)::int FROM bb_projects) AS projects,
    (SELECT count(*)::int FROM bb_material_versions) AS materials,
    (SELECT count(*)::int FROM bb_runs) AS runs`)).rows[0];
  result.jobs=(await pool.query('SELECT job_type,state,error_code,count(*)::int AS count FROM bb_jobs GROUP BY job_type,state,error_code ORDER BY job_type,state')).rows;
}catch(error){result.error=String(error);}
finally{
  await pool.end();
  result.ready=Object.values(result.liveProcesses??{}).length===5&&Object.values(result.liveProcesses).every(Boolean)&&result.web?.status===200&&result.apiReadiness?.status===200&&!result.error;
  result.modelGeneration={configured:false,verified:false};
  if(configured())try{
    const config=JSON.parse(readFileSync(generationConfig,'utf8')),container=containerStatus();
    const live=!!container?.running&&container.image===config.imageId&&container.launchId===result.services?.processes.worker?.launchId;
    const e2ePath=join(runtime,'generation-e2e.json');
    const e2e=existsSync(e2ePath)?JSON.parse(readFileSync(e2ePath,'utf8')):null;
    result.modelGeneration={configured:true,workerRunning:live,model:config.model,imageId:config.imageId,
      verified:live&&config.preflight?.status==='completed',endToEndVerified:live&&e2e?.passed===true&&e2e.imageId===config.imageId,projectURL:e2e?.passed?e2e.projectURL:undefined};
    if(!live)result.ready=false;
  }catch(error){result.modelGeneration={configured:true,verified:false,error:String(error)};result.ready=false;}
  console.log(JSON.stringify(result,null,2));
  mkdirSync(runtime,{recursive:true});
  writeFileSync(join(runtime,'status.json'),JSON.stringify(result,null,2));
  if(!result.ready)process.exitCode=1;
}
