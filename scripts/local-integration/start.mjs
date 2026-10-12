import {spawn,spawnSync} from 'node:child_process';
import {mkdirSync,existsSync,openSync,writeFileSync,readFileSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {createConnection} from 'node:net';
import {Pool} from 'pg';
import {repo,runtime,pgBin,binaries,ports,baseURL,templateURL,environment} from './config.mjs';
const env=environment(),stateFile=join(runtime,'services.json');
mkdirSync(runtime,{recursive:true});mkdirSync(join(runtime,'data'),{recursive:true});
const state={productCommit:'6cd5d2cb254a25963b79f44313440a64c6c38660',harnessCommit:spawnSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8',windowsHide:true}).stdout.trim(),baseURL,startedAt:new Date().toISOString(),processes:{},ready:false,modelReady:false};
const save=()=>writeFileSync(stateFile,JSON.stringify(state,null,2));
const listening=port=>new Promise(resolve=>{const s=createConnection({host:'127.0.0.1',port});s.setTimeout(300);s.once('connect',()=>{s.destroy();resolve(true)});s.once('error',()=>resolve(false));s.once('timeout',()=>{s.destroy();resolve(false)});});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(check,label){for(let i=0;i<120;i++){if(await check())return;await delay(500)}throw Error(`${label} failed to start; inspect ${runtime}`);}
function command(exe,args,extra={}){const r=spawnSync(exe,args,{cwd:repo,env,windowsHide:true,encoding:'utf8',...extra});if(r.status!==0)throw Error(`${exe} failed: ${r.stderr||r.error||r.stdout}`);return r.stdout;}
function launch(name,exe,args,cwd=repo){const out=openSync(join(runtime,`${name}.stdout.log`),'a'),err=openSync(join(runtime,`${name}.stderr.log`),'a');const c=spawn(exe,args,{cwd,env,detached:true,windowsHide:true,stdio:['ignore',out,err]});c.unref();closeSync(out);closeSync(err);state.processes[name]=c.pid;save();return c.pid;}
try{
  if(existsSync(stateFile)){const old=JSON.parse(readFileSync(stateFile,'utf8'));if(old.ready&&await listening(ports.web)&&await listening(ports.api)){console.log(`Already running: ${baseURL}`);process.exit(0);}}
  for(const [name,port] of Object.entries(ports))if(await listening(port))throw Error(`Port ${port} (${name}) is occupied; refusing to replace an existing service`);
  if(!existsSync(join(runtime,'data/postgres/PG_VERSION')))writeFileSync(join(runtime,'initdb.log'),command(join(pgBin,'initdb.exe'),['-D',join(runtime,'data/postgres'),'-U','bondbuddy_integration','-A','trust','--encoding=UTF8','--locale=C']));
  launch('postgres',join(pgBin,'postgres.exe'),['-D',join(runtime,'data/postgres'),'-h','127.0.0.1','-p',String(ports.postgres)]);
  const admin=new Pool({connectionString:'postgresql://bondbuddy_integration@127.0.0.1:55438/postgres',connectionTimeoutMillis:10000});
  await waitFor(async()=>{try{await admin.query('SELECT 1');return true;}catch{return false;}},'PostgreSQL');
  for(const name of ['bb_integration_20261012','bb_integration_template_20261012'])if(!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[name])).rowCount)await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  for(const [name,url] of [['app',env.DATABASE_URL],['template',templateURL]])writeFileSync(join(runtime,`migrations-${name}.log`),command(process.execPath,['db/migrate.mjs'],{env:{...env,DATABASE_URL:url}}),{flag:'a'});
  launch('blob',process.execPath,[join(binaries,'azurite/dist/src/blob/main.js'),'--blobHost','127.0.0.1','--blobPort',String(ports.blob),'--location',join(runtime,'data/blob'),'--silent','--skipApiVersionCheck']);
  await waitFor(()=>listening(ports.blob),'Azurite');
  launch('api',process.execPath,['scripts/local-integration/service.mjs','api']);await waitFor(()=>listening(ports.api),'API');
  const workerPid=launch('worker',process.execPath,['scripts/local-integration/service.mjs','worker']);
  await waitFor(()=>existsSync(join(runtime,'worker.ready.json'))&&JSON.parse(readFileSync(join(runtime,'worker.ready.json'),'utf8')).pid===workerPid,'Worker');
  launch('web',process.execPath,[join(repo,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port',String(ports.web)],join(repo,'apps/web'));
  await waitFor(()=>listening(ports.web),'Web');
  state.ready=true;save();console.log(`Local web/API/worker ready at ${baseURL}; real model generation is not configured.`);
}catch(e){state.error=String(e);if(Object.keys(state.processes).length)save();console.error(e);process.exitCode=1;}
