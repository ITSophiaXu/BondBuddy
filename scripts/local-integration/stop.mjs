import {readFileSync,existsSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {Pool} from 'pg';
import {runtime,pgBin,databaseURL} from './config.mjs';
const stateFile=join(runtime,'services.json');
if(!existsSync(stateFile)){console.log('No local integration process record.');process.exit(0);}
const state=JSON.parse(readFileSync(stateFile,'utf8'));
const pool=new Pool({connectionString:databaseURL,connectionTimeoutMillis:10000});
try{if(state.processes.api){const active=await pool.query("SELECT count(*)::int AS n FROM bb_runs WHERE state NOT IN ('succeeded','test_completed','failed','cancelled','rejected','paused')");if(active.rows[0].n>0)throw Error('Active local tasks exist; pause or end them in the local UI before stopping.');}}
catch(e){if(!['3D000','42P01','ECONNREFUSED'].includes(e.code))throw e;}finally{await pool.end();}
for(const name of ['worker','api']){
  const pid=state.processes[name],readyFile=join(runtime,`${name}.ready.json`);
  if(!pid||!existsSync(readyFile))continue;
  if(JSON.parse(readFileSync(readyFile,'utf8')).pid!==pid)throw Error(`Mismatched ${name} process record`);
  writeFileSync(join(runtime,`${name}.${pid}.stop`),'graceful local shutdown');
  for(let i=0;i<80;i++){try{process.kill(pid,0);}catch{break;}await new Promise(r=>setTimeout(r,500));}
  try{process.kill(pid,0);throw Error(`${name} still running; preserving database`);}catch(e){if(e.code!=='ESRCH')throw e;}
}
// Verify exact executable command lines before stopping non-business local helpers.
for(const name of ['web','blob']){
  const pid=state.processes[name];if(!pid)continue;
  const result=spawnSync('powershell.exe',['-NoProfile','-Command',`(Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid)}").CommandLine`],{encoding:'utf8',windowsHide:true});
  const command=result.stdout||'';
  const expected=name==='web'?'BondBuddy-local-integration-20261012':'local-integration-runtime-20261012';
  if(command&&(!command.includes(expected)||!command.includes(name==='web'?'vite':'azurite')))throw Error(`Refusing to stop unrelated PID ${pid}`);
  if(command)process.kill(pid);
}
const data=resolve(runtime,'data/postgres'),postmaster=join(data,'postmaster.pid');
if(!data.startsWith(resolve(runtime)+'\\'))throw Error('Unexpected data path');
if(existsSync(postmaster)){
  const pid=Number(readFileSync(postmaster,'utf8').split(/\r?\n/)[0]);
  if(pid!==state.processes.postgres)throw Error('PostgreSQL PID differs from our local record');
  const r=spawnSync(join(pgBin,'pg_ctl.exe'),['-D',data,'stop','-m','fast','-w'],{windowsHide:true,encoding:'utf8'});
  if(r.status!==0)throw Error(r.stderr||'PostgreSQL stop failed');
}
state.ready=false;state.stoppedAt=new Date().toISOString();writeFileSync(stateFile,JSON.stringify(state,null,2));console.log('Local integration services stopped; all data retained.');
