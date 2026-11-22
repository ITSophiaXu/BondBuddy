import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {delegate,readConfig,stateDir} from './config.mjs';
import {compose,docker,lock,ownership,writeReceipt} from './runtime.mjs';
delegate(fileURLToPath(import.meta.url));
const drainActive=process.argv.slice(2).includes('--drain-active');
if(process.argv.slice(2).some(arg=>arg!=='--drain-active'))throw Error('Unknown stop option');
const config=readConfig(),unlock=await lock('stop');
try {
  const items=await ownership(config),running=items.filter(item=>item.State.Running);
  let before=null,afterDrain=null;
  if(running.length) {
    if(!running.some(item=>item.Config.Labels['com.docker.compose.service']==='api'))throw Error('API is unavailable; cannot verify in-flight work. Stop refused.');
    const idle=await docker(['exec',`${config.projectName}-api-1`,'node','/app/scripts/local-prelaunch/probe.mjs','idle'],{allowFailure:true});
    try{before=JSON.parse(idle.stdout.trim());}catch{throw Error('Cannot verify workload before local stop.');}
    if(!before.identity||![0,76].includes(idle.code))throw Error('Local workload identity is unverifiable; stop refused.');
    if(idle.code!==0&&!drainActive)throw Error('Queued/running work or leased messages exist; stop refused. Use --drain-active to test graceful interruption and recovery.');
    if(drainActive) {
      console.log('Draining the three product workers using their production grace periods; persisted jobs and inputs are retained.');
      await compose(config,['stop','worker','worker-review','worker-parse'],{log:path.join(stateDir,'receipts/stop-workers.log')});
      const after=await docker(['exec',`${config.projectName}-api-1`,'node','/app/scripts/local-prelaunch/probe.mjs','idle'],{allowFailure:true});
      try{afterDrain=JSON.parse(after.stdout.trim());}catch{afterDrain={probeExit:after.code};}
    }
    await compose(config,['stop'],{log:path.join(stateDir,'receipts/stop.log')});
  }
  const remaining=await ownership(config);
  if(remaining.some(item=>item.State.Running))throw Error('Some owned containers are still running; data retained.');
  writeReceipt('stop',{instanceId:config.instanceId,stoppedAt:new Date().toISOString(),stopped:true,drainActive,before,afterDrain,volumesPreserved:true,containers:remaining.map(item=>({id:item.Id,state:item.State.Status}))});
  console.log('Local environment stopped. PostgreSQL, Blob, ledger and all named volumes retained.');
}finally{await unlock();}
