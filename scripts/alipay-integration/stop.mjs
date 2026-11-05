import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {runtime,apiURL,baseURL} from './config.mjs';
const state=JSON.parse(readFileSync(join(runtime,'state.json'),'utf8'));
let status;try{status=await(await fetch(apiURL+'/__alipay-test/status',{signal:AbortSignal.timeout(1500)})).json();}
catch{console.log('Local Alipay server is stopped. Database and orders are retained.');process.exit(0);}
if(status.launch_id!==state.launchId||status.sandbox!==true)throw Error('Refusing to stop an unowned server');
const r=await fetch(apiURL+'/__alipay-test/control/stop',{method:'POST',headers:{origin:baseURL,'content-type':'application/json','x-local-control':state.stopToken},body:'{}'});
if(!r.ok)throw Error('Stop request rejected');
for(let n=0;n<80;n++){try{await fetch(apiURL+'/__alipay-test/status',{signal:AbortSignal.timeout(500)});}catch{console.log('Stopped this local Web/API. Database and orders retained.');process.exit(0);}await new Promise(resolve=>setTimeout(resolve,250));}
throw Error('Graceful shutdown is pending; no forced termination attempted');
