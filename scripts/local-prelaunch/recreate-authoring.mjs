import assert from 'node:assert/strict';
import {copyFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {delegate,readConfig,root,stateDir} from './config.mjs';
import {compose,digest,docker,lock,ownership,validateCompose,verifyBuild,writeReceipt} from './runtime.mjs';
import {actualSecurityProfiles,seccompSources} from './seccomp.mjs';
import {inspectStatus} from './status.mjs';

delegate(fileURLToPath(import.meta.url));
const config=readConfig(),unlock=await lock('recreate-authoring-seccomp');
const startedAt=new Date().toISOString(),receiptName=`authoring-seccomp-${startedAt.replace(/[:.]/g,'-')}`;
const result={instanceId:config.instanceId,startedAt,productionUnchanged:true,realModelCalls:0};
try {
  await verifyBuild(config);await validateCompose(config);
  const before=await ownership(config);assert.ok(before.some(item=>item.Config.Labels['com.docker.compose.service']==='worker'));
  result.beforeSecurityProfiles=actualSecurityProfiles(before);result.derivation=seccompSources().proof;
  result.permissionHelper={file:'apps/worker/src/codex-file-permissions.ts',sha256:await digest(path.join(root,'apps/worker/src/codex-file-permissions.ts'))};
  result.redEvidence=[];
  for(const name of ['file-sandbox-diagnostic.json','file-sandbox-diagnostic.log','real-model-probe.json','real-model-probe.log']) {
    const source=path.join(stateDir,'receipts',name),target=path.join(stateDir,'receipts',`${receiptName}-red-${name}`);
    if(!existsSync(source))continue;copyFileSync(source,target);result.redEvidence.push({source,preservedAs:target,sha256:await digest(target)});
  }
  const idle=await docker(['exec',`${config.projectName}-api-1`,'node','/app/scripts/local-prelaunch/probe.mjs','authoring-idle'],{allowFailure:true});
  result.beforeWorkload=JSON.parse(idle.stdout.trim());assert.equal(idle.code,0,'Authoring jobs/runs/leases or diagnostics are active; no services changed');
  writeReceipt(receiptName,result);
  result.recreateLog=path.join(stateDir,'receipts',`${receiptName}.log`);
  await compose(config,['up','-d','--no-deps','--no-build','--force-recreate','worker'],{log:result.recreateLog});
  let status;
  for(let attempt=0;attempt<30;attempt++) {
    status=await inspectStatus(config,{record:false});if(status.ready)break;
    if(attempt%10===0)console.log('Waiting for recreated authoring heartbeat; all other services retained.');
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  const after=await ownership(config);
  result.services=before.map(item=>{
    const service=item.Config.Labels['com.docker.compose.service'],current=after.find(value=>value.Config.Labels['com.docker.compose.service']===service);
    assert.ok(current,`Owned service disappeared: ${service}`);
    if(service!=='worker')assert.equal(current.Id,item.Id,`Non-authoring service changed: ${service}`);
    return {service,beforeId:item.Id,afterId:current.Id,changed:item.Id!==current.Id};
  });
  result.afterSecurityProfiles=status.securityProfiles;result.ready=status.ready;assert.equal(status.ready,true,'Stack not ready after authoring recreation');
  assert.equal(await digest(path.join(root,result.permissionHelper.file)),result.permissionHelper.sha256,'Permission helper changed');
  result.completedAt=new Date().toISOString();result.success=true;writeReceipt(receiptName,result);
  await inspectStatus(config);console.log(JSON.stringify({receipt:receiptName,ready:true,onlyAuthoringRecreated:true,derivation:result.derivation}));
}catch(error) {
  result.completedAt=new Date().toISOString();result.success=false;result.error=error.message;writeReceipt(receiptName,result);throw error;
}finally{await unlock();}
