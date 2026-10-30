import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {runtime,apiURL,baseURL} from './config.mjs';
const state=JSON.parse(readFileSync(join(runtime,'state.json'),'utf8'));
let status;
try{status=await(await fetch(apiURL+'/__billing-test/status',{signal:AbortSignal.timeout(1500)})).json();}
catch{console.log('Functional test server is already stopped; database and files remain.');process.exit(0);}
if(status.launch_id!==state.launchId)throw Error('Refusing to stop an unowned server');
const response=await fetch(apiURL+'/__billing-test/control/stop',{method:'POST',headers:{origin:baseURL,'content-type':'application/json','x-local-control':state.stopToken},body:'{}'});
if(!response.ok)throw Error('Stop request rejected: '+response.status);
for(let attempt=0;attempt<40;attempt++){try{await fetch(apiURL+'/__billing-test/status',{signal:AbortSignal.timeout(500)});}catch{console.log('Stopped only this functional server. PostgreSQL, isolated database, balances and synthetic files are retained.');process.exit(0);}await new Promise(resolve=>setTimeout(resolve,250));}
throw Error('Graceful shutdown is still pending; no forced process termination was attempted');
