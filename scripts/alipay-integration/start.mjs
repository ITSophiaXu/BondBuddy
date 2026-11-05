import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {existsSync,readFileSync,openSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {ensureDatabase} from './database.mjs';
import {runtime,repo,directory,ports,baseURL,apiURL,cleanEnvironment,atomicJson,username} from './config.mjs';

const statePath=join(runtime,'state.json');
async function status(){try{const r=await fetch(apiURL+'/__alipay-test/status',{signal:AbortSignal.timeout(1500)});return r.ok?await r.json():null;}catch{return null;}}
const current=await status();
if(current){
  const saved=existsSync(statePath)?JSON.parse(readFileSync(statePath,'utf8')):null;
  if(saved?.launchId!==current.launch_id||current.sandbox!==true)throw Error('An unowned process occupies the local API');
  if(!current.ready)throw Error('Local server is still starting');
  console.log(JSON.stringify({ready:true,reused:true,url:baseURL+'/#/account',username}));
}else{
  // AJV compiles the full product route tree on startup. A second launcher must
  // not race that still-loading process merely because it has not bound a port.
  if(existsSync(statePath)){
    const previous=JSON.parse(readFileSync(statePath,'utf8'));
    if(Number.isSafeInteger(previous.pid)&&previous.pid>0){
      let alive=false;try{process.kill(previous.pid,0);alive=true;}catch(error){if(error.code!=='ESRCH')throw error;}
      if(alive)throw Error('The recorded local process is still running or starting; check its status/log before starting another instance');
    }
  }
  for(const port of [ports.api,ports.web])await new Promise((resolve,reject)=>{const s=createServer();s.once('error',()=>reject(Error('Port '+port+' is occupied; no process was replaced')));s.listen(port,'127.0.0.1',()=>s.close(resolve));});
  const saved=await ensureDatabase(),launchId=randomBytes(24).toString('hex'),stopToken=randomBytes(32).toString('hex');
  const out=openSync(join(runtime,'server.log'),'a'),err=openSync(join(runtime,'server-error.log'),'a');let child;
  try{child=spawn(process.execPath,[join(directory,'serve.mjs')],{cwd:repo,env:{...cleanEnvironment(),BB_LOCAL_ALIPAY_LAUNCH:launchId,BB_LOCAL_ALIPAY_STOP:stopToken},detached:true,windowsHide:true,stdio:['ignore',out,err]});}
  finally{closeSync(out);closeSync(err);}
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  atomicJson(statePath,{version:1,pid:child.pid,launchId,stopToken,instanceId:saved.id,startedAt:new Date().toISOString(),url:baseURL});child.unref();
  let ready=false;
  for(let n=0;n<300;n++){const result=await status();if(result?.launch_id===launchId&&result.ready){ready=true;break;}await new Promise(resolve=>setTimeout(resolve,400));}
  if(!ready)throw Error('Startup did not become ready; inspect .local/alipay-integration/server-error.log. No unrelated process was stopped.');
  console.log(JSON.stringify({ready:true,url:baseURL+'/#/account',username,sandbox:true,realProductApi:true,realPostgres:true,modelWorker:false}));
}
