import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {existsSync,readFileSync,openSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {ensureDatabase} from './database.mjs';
import {runtime,repo,directory,ports,baseURL,apiURL,cleanEnvironment,atomicJson} from './config.mjs';

const statePath=join(runtime,'state.json');
async function status(){try{const response=await fetch(apiURL+'/__billing-test/status',{signal:AbortSignal.timeout(1500)});return response.ok?await response.json():null;}catch{return null;}}
const current=await status();
if(current){
  const old=existsSync(statePath)?JSON.parse(readFileSync(statePath,'utf8')):null;
  if(old?.launchId!==current.launch_id)throw Error('An unowned process occupies the functional API');
  if(!current.ready)throw Error('This functional server is still starting; retry after it reports ready');
  console.log(JSON.stringify({ready:true,reused:true,url:baseURL+'/__billing-test',account:baseURL+'/#/account'}));
}else{
  for(const port of Object.values(ports))await new Promise((resolve,reject)=>{const server=createServer();server.once('error',()=>reject(Error('Port '+port+' is occupied; no process was replaced')));server.listen(port,'127.0.0.1',()=>server.close(resolve));});
  const saved=await ensureDatabase(),launchId=randomBytes(24).toString('hex'),stopToken=randomBytes(32).toString('hex');
  const stdout=openSync(join(runtime,'server.log'),'a'),stderr=openSync(join(runtime,'server-error.log'),'a');
  let child;
  try{child=spawn(process.execPath,[join(directory,'serve.mjs')],{cwd:repo,env:{...cleanEnvironment(),BB_FUNCTIONAL_LAUNCH:launchId,BB_FUNCTIONAL_STOP:stopToken},detached:true,windowsHide:true,stdio:['ignore',stdout,stderr]});}
  finally{closeSync(stdout);closeSync(stderr);}
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  atomicJson(statePath,{version:1,pid:child.pid,launchId,stopToken,instanceId:saved.id,database:saved.database,startedAt:new Date().toISOString(),url:baseURL});child.unref();
  let ready=false;
  for(let attempt=0;attempt<80;attempt++){const response=await status();if(response?.launch_id===launchId&&response.ready){ready=true;break;}await new Promise(resolve=>setTimeout(resolve,500));}
  if(!ready)throw Error('Startup did not become ready; inspect scripts/billing-functional/.runtime/server-error.log. No unrelated process was terminated.');
  console.log(JSON.stringify({ready:true,url:baseURL+'/__billing-test',account:baseURL+'/#/account',username:'billing_tester',initialPointsOnFirstRegistration:0,synthetic:true}));
}
