import {fileURLToPath} from 'node:url';
import net from 'node:net';
import path from 'node:path';
import {delegate,readConfig,root,stateDir} from './config.mjs';
import {assertIdleWorkload,compose,docker,lock,ownedStartAction,ownership,runtimeSourceHashes,validateCompose,verifyBuild,writeReceipt} from './runtime.mjs';
import {inspectStatus} from './status.mjs';
delegate(fileURLToPath(import.meta.url));
const config=readConfig({create:true});await verifyBuild(config);const unlock=await lock('start');
try {
  const items=await ownership(config);
  for(const item of items)if(item.Config.Labels['com.docker.compose.service']!=='web'&&Object.values(item.NetworkSettings.Networks??{}).some(network=>network.IPAddress===config.webIp))throw Error('The reserved local web IP is already assigned; no resources changed.');
  if(items.length) {
    const current=await inspectStatus(config);
    const action=ownedStartAction(current,items);
    if(action==='reuse'){console.log(`Local environment already ready: ${config.origin}; existing data retained.`);process.exitCode=0;}
    else {
      if(current.pendingUpgrade)console.log(`Pending local image upgrade to ${current.pendingUpgrade.targetReleaseSha.slice(0,12)}: ${current.pendingUpgrade.services.map(item=>item.service).join(', ')}.`);
      if(action==='verify-idle') {
        const idle=await docker(['exec',`${config.projectName}-api-1`,'node','/app/scripts/local-prelaunch/probe.mjs','idle'],{allowFailure:true});
        assertIdleWorkload(idle);
      }
      await start();
    }
  }else await start();
}finally{await unlock();}

function range(cidr) {
  const [address,prefix]=cidr.split('/');const parts=address.split('.').map(Number),bits=Number(prefix);
  if(parts.length!==4||parts.some(value=>!Number.isInteger(value)||value<0||value>255)||!Number.isInteger(bits)||bits<0||bits>32)return null;
  const value=parts.reduce((total,item)=>total*256+item,0),size=2**(32-bits),first=Math.floor(value/size)*size;return [first,first+size-1];
}
async function start() {
  const networks=(await docker(['network','ls','--format','{{.ID}}'])).stdout.trim().split(/\s+/).filter(Boolean);
  if(networks.length)for(const network of JSON.parse((await docker(['network','inspect',...networks])).stdout)) {
    if(network.Labels?.['io.bondbuddy.local-prelaunch.instance']===config.instanceId)continue;
    const wanted=range(config.subnet);
    for(const entry of network.IPAM?.Config??[]) {const existing=range(entry.Subnet??'');if(existing&&wanted[0]<=existing[1]&&existing[0]<=wanted[1])throw Error('Local subnet overlaps another Docker network; no resources changed.');}
  }
  const items=await ownership(config);
  const webOwned=items.some(item=>item.Config.Labels['com.docker.compose.service']==='web'&&item.State.Running);
  if(!webOwned)await new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',()=>reject(Error('Local browser port is occupied; no resources changed.')));server.listen(config.port,'127.0.0.1',()=>server.close(resolve));});
  const log=path.join(stateDir,'receipts/start.log');
  await validateCompose(config);
  // ownedStartAction required the current API's idle proof before reaching this
  // point with a running legacy service. Retain its container and private data.
  for(const item of items)if(item.State.Running&&item.Config.Labels['com.docker.compose.service']==='api-legacy')
    await docker(['stop',item.Id]);
  console.log('Starting dedicated PostgreSQL, Blob, current production API, three worker groups and web.');
  await compose(config,['up','-d','--no-build'],{log});
  let status;
  for(let attempt=0;attempt<60;attempt++) {
    status=await inspectStatus(config,{record:false});
    if(status.ready)break;
    if(attempt%6===0)console.log('Waiting for actual schema, Blob and three worker heartbeats.');
    await new Promise(resolve=>setTimeout(resolve,2000));
  }
  writeReceipt('start',{...status,log,sourceRoot:root,runtimeSourceHashes:await runtimeSourceHashes(await ownership(config),status.releaseSha)});
  if(!status.ready)throw Error('Local full stack did not become ready; see protected start and container logs. Data retained.');
  console.log(`Local full stack ready: ${config.origin} (${config.projectName}); payment synthetic, product worker real.`);
}
