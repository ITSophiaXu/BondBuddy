import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdirSync,existsSync,writeFileSync,readFileSync,renameSync,appendFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {Pool} from 'pg';
import {repo,runtime,pgBin,binaries,ports,baseURL,databaseURL,templateURL,environment} from './config.mjs';
import {windowsProcess,identity,sameIdentity,inspect,terminate,withLifecycleLock} from './processes.mjs';
import {modelReady} from './linux-worker.mjs';

const stateFile=join(runtime,'services.json'),receipts=join(runtime,'launch-receipts');
const data=join(runtime,'data/postgres'),env=environment();
const definitions={
  postgres:{exe:join(pgBin,'postgres.exe'),args:['-D',data,'-h','127.0.0.1','-p',String(ports.postgres)],cwd:repo},
  blob:{exe:process.execPath,args:[join(binaries,'azurite/dist/src/blob/main.js'),'--blobHost','127.0.0.1','--blobPort',String(ports.blob),'--location',join(runtime,'data/blob'),'--silent','--skipApiVersionCheck'],cwd:repo},
  api:{exe:process.execPath,args:[join(repo,'scripts/local-integration/service.mjs'),'api'],cwd:repo},
  worker:{exe:process.execPath,args:[join(repo,'scripts/local-integration/service.mjs'),'worker'],cwd:repo},
  web:{exe:process.execPath,args:[join(repo,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port',String(ports.web),'--strictPort'],cwd:join(repo,'apps/web')},
};
const order=Object.keys(definitions),canonical=p=>resolve(p).toLowerCase();
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function save(state){
  const temp=stateFile+'.'+randomUUID()+'.tmp';
  writeFileSync(temp,JSON.stringify(state,null,2));renameSync(temp,stateFile);
}
function command(exe,args,extra={}){
  const result=spawnSync(exe,args,{cwd:repo,env,encoding:'utf8',windowsHide:true,timeout:120000,...extra});
  if(result.status!==0)throw Error(result.stderr||result.error?.message||result.stdout||`${exe} failed`);
  return result.stdout;
}
function validate(name,ref){
  const expected=definitions[name];
  if(!expected||!ref||!Number.isInteger(ref.pid)||!/^\d+$/.test(ref.createdTicks)||
     canonical(ref.exe)!==canonical(expected.exe)||canonical(ref.cwd)!==canonical(expected.cwd)||
     JSON.stringify(ref.args)!==JSON.stringify(expected.args)||!/^[a-f0-9-]{36}$/.test(ref.launchId))
    throw Error(`Invalid ${name} launch receipt; refusing to adopt or stop it`);
}
function recoverPending(state){
  for(const [name,pending] of Object.entries(state.pending)){
    if(!/^[a-f0-9-]{36}$/.test(pending.launchId))throw Error('Invalid pending launch ID');
    const receipt=join(receipts,pending.launchId+'.json');
    if(existsSync(receipt)){
      const ref=JSON.parse(readFileSync(receipt,'utf8'));validate(name,ref);
      if(ref.launchId!==pending.launchId)throw Error('Pending launch receipt mismatch');
      if(state.processes[name]&&state.processes[name].launchId!==ref.launchId)throw Error('Conflicting service receipts');
      state.processes[name]=ref;
    }
    delete state.pending[name];
  }
}
function reconcile(state){
  recoverPending(state);
  for(const [name,ref] of Object.entries(state.processes)){
    validate(name,ref);
    const current=identity(ref.pid);
    if(!current){delete state.processes[name];state.ready=false;}
    else if(!sameIdentity(current,ref))throw Error(`PID ${ref.pid} (${name}) belongs to a different process generation; refusing to touch it`);
  }
}
function load(){
  mkdirSync(receipts,{recursive:true});mkdirSync(join(runtime,'data'),{recursive:true});
  let state=existsSync(stateFile)?JSON.parse(readFileSync(stateFile,'utf8')):null;
  if(state&&state.schemaVersion!==2){
    if(!state.stoppedAt||state.ready)throw Error('Legacy state has no verified stop; inspect its processes before migration');
    writeFileSync(join(runtime,'services-legacy-'+randomUUID()+'.json'),JSON.stringify(state,null,2));state=null;
  }
  state??={schemaVersion:2,productCommit:'6cd5d2cb254a25963b79f44313440a64c6c38660',baseURL,phase:'stopped',ready:false,modelReady:false,processes:{},pending:{}};
  reconcile(state);return state;
}
function checkPorts(state){
  const snapshot=inspect(Object.values(state.processes).map(p=>p.pid));
  for(const [name,port] of Object.entries(ports)){
    const ref=state.processes[name];
    if(ref&&!sameIdentity(snapshot.identities[ref.pid],ref))throw Error(`${name} exited or changed during port inspection`);
    for(const listener of snapshot.listeners.filter(l=>l.port===port))
      if(!ref||listener.pid!==ref.pid)throw Error(`Port ${port} (${name}) is occupied by unowned PID ${listener.pid}; preserving it`);
  }
}
async function waitFor(check,label,timeout=60000){
  const end=Date.now()+timeout;
  while(Date.now()<end){if(await check())return;await delay(300);}
  throw Error(`${label} did not become ready; inspect ${runtime}`);
}
function requireAlive(state,name){
  const ref=state.processes[name];
  if(!ref||!sameIdentity(identity(ref.pid),ref))throw Error(`${name} exited before readiness`);
}
function launch(state,name,launched){
  if(state.processes[name])return false;
  // Recheck immediately before each launch, including a recovered partial start.
  checkPorts(state);
  const launchId=randomUUID(),receipt=join(receipts,launchId+'.json');
  state.pending[name]={launchId};save(state);
  try{
    state.processes[name]=windowsProcess({action:'launch',...definitions[name],launchId,receipt,
      stdout:join(runtime,`${name}.stdout.log`),stderr:join(runtime,`${name}.stderr.log`)});
  }finally{
    // Even a lost helper response must remain owned and eligible for rollback.
    recoverPending(state);
    if(state.processes[name]?.launchId===launchId)launched.push(name);
    save(state);
  }
  return true;
}
async function postgresReady(state){
  const pool=new Pool({connectionString:databaseURL.replace(/\/[^/]+$/,'/postgres'),connectionTimeoutMillis:1500,query_timeout:3000});
  pool.on('error',()=>{});
  try{await waitFor(async()=>{requireAlive(state,'postgres');try{await pool.query('SELECT 1');return true;}catch{return false;}},'PostgreSQL');}
  finally{await pool.end();}
}
async function setupDatabases(){
  const admin=new Pool({connectionString:databaseURL.replace(/\/[^/]+$/,'/postgres'),connectionTimeoutMillis:5000,query_timeout:5000});
  try{
    for(const name of ['bb_integration_20261012','bb_integration_template_20261012'])
      if(!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[name])).rowCount)await admin.query(`CREATE DATABASE ${name}`);
  }finally{await admin.end();}
  for(const [name,url] of [['app',databaseURL],['template',templateURL]])
    appendFileSync(join(runtime,`migrations-${name}.log`),command(process.execPath,['db/migrate.mjs'],{env:{...env,DATABASE_URL:url}}));
}
async function httpOK(url){try{return(await fetch(url,{signal:AbortSignal.timeout(4000)})).ok;}catch{return false;}}
async function serviceReady(state,name){
  await waitFor(async()=>{
    requireAlive(state,name);
    if(name==='worker'||name==='api'){
      const file=join(runtime,`${name}.ready.json`);
      if(!existsSync(file))return false;
      try{const ready=JSON.parse(readFileSync(file,'utf8'));return ready.pid===state.processes[name].pid&&ready.launchId===state.processes[name].launchId;}catch{return false;}
    }
    if(name==='web')return httpOK(baseURL);
    return inspect([]).listeners.some(l=>l.port===ports[name]&&l.pid===state.processes[name].pid);
  },name);
}
async function assertIdle(state){
  if(!state.processes.postgres)return;
  await postgresReady(state);
  const pool=new Pool({connectionString:databaseURL,connectionTimeoutMillis:5000,query_timeout:5000});
  try{
    const tests=await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname LIKE 'bb_integration_template_20261012_t%'");
    if(tests.rows[0].n)throw Error('Local regression databases have connected clients; leave them running');
    const active=await pool.query("SELECT count(*)::int AS n FROM bb_runs WHERE state NOT IN ('succeeded','test_completed','failed','cancelled','rejected','paused')");
    if(active.rows[0].n)throw Error('Active local tasks exist; pause or end them in the local UI before stopping');
  }catch(error){if(!['3D000','42P01'].includes(error.code))throw error;}
  finally{await pool.end();}
}
async function stopOne(state,name){
  const ref=state.processes[name];if(!ref)return;
  validate(name,ref);
  const current=identity(ref.pid);
  if(current&&!sameIdentity(current,ref))throw Error(`Refusing to stop different process generation ${ref.pid}`);
  if(current){
    if(name==='postgres'){
      const postmaster=join(data,'postmaster.pid');
      if(!existsSync(postmaster))throw Error('Live PostgreSQL has no postmaster.pid; preserving it');
      const lines=readFileSync(postmaster,'utf8').split(/\r?\n/);
      if(Number(lines[0])!==ref.pid||canonical(lines[1])!==canonical(data))throw Error('PostgreSQL data directory/PID mismatch');
      command(join(pgBin,'pg_ctl.exe'),['-D',data,'stop','-m','fast','-w','-t','30'],{timeout:35000});
    }else if(name==='api'||name==='worker'){
      writeFileSync(join(runtime,`${name}.${ref.launchId}.stop`),'graceful local shutdown');
    }else terminate(ref);
    await waitFor(()=>{const now=identity(ref.pid);if(now&&!sameIdentity(now,ref))throw Error('PID reused during shutdown; preserving replacement');return !now;},`${name} shutdown`,40000);
  }
  delete state.processes[name];state.ready=false;if(name==='worker')state.modelReady=false;save(state);
}

export async function startServices({databaseOnly=false,afterStart=async()=>{}}={}){
  return withLifecycleLock(runtime,async()=>{
    const state=load();checkPorts(state);const launched=[];
    state.harnessCommit=command('git',['rev-parse','HEAD']).trim();
    state.ready=false;state.phase='starting';delete state.error;delete state.cleanupErrors;save(state);
    try{
      if(!existsSync(join(data,'PG_VERSION')))appendFileSync(join(runtime,'initdb.log'),command(join(pgBin,'initdb.exe'),['-D',data,'-U','bondbuddy_integration','-A','trust','--encoding=UTF8','--locale=C']));
      const newPG=launch(state,'postgres',launched);await postgresReady(state);
      if(newPG)await afterStart('postgres',state);
      if(!databaseOnly){
        if(!state.processes.api&&!state.processes.worker)await setupDatabases();
        for(const name of order.filter(n=>n!=='postgres')){
          const started=launch(state,name,launched);await serviceReady(state,name);
          if(started)await afterStart(name,state);
        }
        await waitFor(()=>{for(const name of order)requireAlive(state,name);return httpOK(`http://127.0.0.1:${ports.api}/api/v1/ready`);},'API readiness');
        state.ready=true;
      }
      checkPorts(state);state.modelReady=modelReady();state.phase=state.ready?'running':'database-only';state.startedAt=new Date().toISOString();delete state.stoppedAt;save(state);
      return state;
    }catch(error){
      state.ready=false;state.phase='failed';state.error=String(error);state.cleanupErrors=[];save(state);
      // Preserve pre-existing services. Stop at the first unsafe cleanup so dependencies survive.
      for(const name of [...launched].reverse()){
        try{if(name==='postgres')await assertIdle(state);await stopOne(state,name);}
        catch(cleanup){state.cleanupErrors.push(String(cleanup));break;}
      }
      save(state);throw error;
    }
  });
}

export async function stopServices(){
  return withLifecycleLock(runtime,async()=>{
    const state=load();checkPorts(state);await assertIdle(state);
    state.ready=false;state.phase='stopping';save(state);
    try{
      for(const name of [...order].reverse())await stopOne(state,name);
      state.phase='stopped';state.stoppedAt=new Date().toISOString();delete state.error;save(state);return state;
    }catch(error){state.phase='failed';state.error=String(error);save(state);throw error;}
  });
}

// Replace only this batch's idle worker. The user's API, uploads and database stay live.
export async function restartWorker(){
  return withLifecycleLock(runtime,async()=>{
    const state=load();checkPorts(state);await assertIdle(state);
    await stopOne(state,'worker');
    const launched=[];
    try{launch(state,'worker',launched);await serviceReady(state,'worker');
      state.phase='running';state.ready=true;state.modelReady=modelReady();save(state);return state;
    }catch(error){if(launched.includes('worker'))await stopOne(state,'worker');state.phase='failed';state.error=String(error);save(state);throw error;}
  });
}
