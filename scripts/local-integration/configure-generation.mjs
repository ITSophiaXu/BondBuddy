import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {repo,runtime} from './config.mjs';
import {docker,dockerCommand,refreshLocalCredential,workerArgs,generationConfig,ensureLocalVolume} from './linux-worker.mjs';
import {restartWorker} from './lifecycle.mjs';
const imageId=dockerCommand(['image','inspect','--format','{{.Id}}','bondbuddy-local-worker:20261012']);
const credentialFile=refreshLocalCredential();
const config={imageId,credentialFile,model:'gpt-6-sol',provider:'copilot_enterprise',configuredAt:new Date().toISOString()};
ensureLocalVolume();
const result=spawnSync(docker,['run','--rm','--name','bb-local-model-preflight-20261012','--label','com.bondbuddy.local-preflight=20261012',...workerArgs(config),
 '--mount',`type=bind,source=${join(repo,'scripts/local-integration/model-preflight.mjs')},target=/preflight.mjs,readonly`,
 imageId,'node','/preflight.mjs'],{encoding:'utf8',windowsHide:true,timeout:240000,maxBuffer:1024*1024});
writeFileSync(join(runtime,'model-preflight.log'),(result.stdout??'')+(result.stderr??''));
if(result.error?.code==='ETIMEDOUT'){
 const probe=JSON.parse(dockerCommand(['inspect','--format','{{json .}}','bb-local-model-preflight-20261012']));
 if(probe.Config.Labels?.['com.bondbuddy.local-preflight']==='20261012'&&probe.Image===imageId)dockerCommand(['stop','--time','10',probe.Id]);
}
console.log(result.stdout??'',result.stderr??'');
if(result.status!==0)throw Error('Real model/file-sandbox preflight failed; existing worker was not changed');
const receipt=JSON.parse(result.stdout.split(/\r?\n/).find(line=>line.includes('"phase":"real_model_result"')));
config.preflight={verifiedAt:new Date().toISOString(),status:receipt.status,files:receipt.value.files};
writeFileSync(generationConfig,JSON.stringify(config,null,2));
await restartWorker();
console.log(JSON.stringify({configured:true,worker:'linux',model:config.model,imageId}));
