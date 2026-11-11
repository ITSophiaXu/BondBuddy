import {fileURLToPath} from 'node:url';
import {delegate,readConfig} from './config.mjs';
import {docker,ownership,pendingImageUpgrade,runtimeSourceHashes,verifyBuild,writeReceipt} from './runtime.mjs';
import {actualSecurityProfiles,seccompSources} from './seccomp.mjs';
const isMain=fileURLToPath(import.meta.url)===process.argv[1];
if(isMain)delegate(fileURLToPath(import.meta.url));
export const requiredServices=['postgres','azurite','api','worker','worker-review','worker-parse','ops','egress','web'];
export async function inspectStatus(config,{record=true}={}) {
  const receipt=await verifyBuild(config),items=await ownership(config);
  const services=items.map(item=>({name:item.Config.Labels['com.docker.compose.service'],id:item.Id,image:item.Image,state:item.State.Status,health:item.State.Health?.Status??null}));
  let ready=requiredServices.every(service=>services.some(item=>item.name===service&&item.state==='running'&&(!item.health||item.health==='healthy')));
  const securityProfiles=actualSecurityProfiles(items),seccompDerivation=seccompSources().proof;
  ready=ready&&securityProfiles.every(item=>item.source&&item.noNewPrivileges)&&
    securityProfiles.some(item=>item.service==='worker'&&item.source?.kind==='local-derived');
  const pendingUpgrade=pendingImageUpgrade(receipt,items);
  if(pendingUpgrade)ready=false;
  let checks=null;
  if(services.some(item=>item.name==='api'&&item.state==='running')) {
    const probe=await docker(['exec',`${config.projectName}-api-1`,'node','/app/scripts/local-prelaunch/probe.mjs','status'],{allowFailure:true});
    try{checks=JSON.parse(probe.stdout.trim());}catch{checks={ready:false,probeExit:probe.code};}
    ready=ready&&probe.code===0&&checks.ready===true;
  }else ready=false;
  const status={instanceId:config.instanceId,database:config.database,projectName:config.projectName,origin:config.origin,releaseSha:receipt.releaseSha,ready,
    services,checks,securityProfiles,seccompDerivation,pendingUpgrade,checkedAt:new Date().toISOString(),syntheticPayment:true,realWorker:true,legacyPricingRetired:true};
  if(record)status.runtimeSourceHashes=await runtimeSourceHashes(items,receipt.releaseSha);
  if(record)writeReceipt('status',status);
  return status;
}
if(isMain) {
  const status=await inspectStatus(readConfig());console.log(JSON.stringify(status,null,2));if(!status.ready)process.exitCode=75;
}
