import {fileURLToPath} from 'node:url';
import {createWriteStream,existsSync,mkdirSync,readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {finished} from 'node:stream/promises';
import path from 'node:path';
import {delegate,readConfig,stateDir,root} from './config.mjs';
import {command,digest,docker,git,gitCommand,lock,writeReceipt} from './runtime.mjs';
delegate(fileURLToPath(import.meta.url));
const config=readConfig({create:true}),unlock=await lock('build');
const buildRunId=new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8);
try {
  // Keep the previous receipt and all its source/log paths valid. A subsequent
  // build gets separate files even when tracked HEAD and Docker tags are equal.
  const previousFile=path.join(stateDir,'receipts/build.json');
  if(existsSync(previousFile)) {
    const previous=JSON.parse(readFileSync(previousFile,'utf8'));
    if(previous.instanceId!==config.instanceId)throw Error('Previous build receipt belongs to another local instance');
    writeReceipt(`build-before-${buildRunId}`,previous);
  }
  await docker(['buildx','version']);
  const releaseSha=(await git(['rev-parse','HEAD'])).stdout.trim();
  const tree=(await git(['rev-parse','HEAD^{tree}'])).stdout.trim();
  if(!/^[a-f0-9]{40}$/.test(releaseSha))throw Error('Invalid release commit');
  const sourceDir=path.join(stateDir,'source');mkdirSync(sourceDir,{recursive:true,mode:0o700});
  const archive=path.join(sourceDir,`${releaseSha}-${buildRunId}.tar`);
  async function makeArchive(ref,file) {await new Promise((resolve,reject)=>{
    const request=gitCommand(['archive','--format=tar',ref]);
    const archiveChild=spawn(request.binary,request.args,{cwd:root,stdio:['ignore','pipe','pipe']});
    const output=createWriteStream(file,{mode:0o600});archiveChild.stdout.pipe(output);
    const written=finished(output);
    archiveChild.once('error',reject);archiveChild.once('close',code=>code===0?written.then(resolve,reject):reject(Error('Tracked source archive failed')));
  });}
  await makeArchive(releaseSha,archive);
  const verifiedRuntimeSources=[];
  for(const file of ['deploy/m1/scripts/verify-ocr-runtime.sh','deploy/m1/scripts/copilot-token.mjs','deploy/m1/egress/entrypoint.sh']) {
    const archived=(await command('tar',['-xOf',archive,file])).stdout;
    const tracked=(await git(['show',`${releaseSha}:${file}`])).stdout;
    if(archived!==tracked||archived.includes('\r\n'))throw Error('Tracked Linux runtime script changed in source archive; build refused.');
    const {createHash}=await import('node:crypto');
    verifiedRuntimeSources.push({file,sha256:createHash('sha256').update(archived).digest('hex'),matchesTrackedBlob:true,lfOnly:true});
  }
  // A failed rebuild must not retag images referenced by the last good receipt.
  const sourceHash=await digest(archive),tag=`local-prelaunch-${config.instanceId.slice(0,8)}-${releaseSha.slice(0,12)}-${buildRunId.slice(-8)}`;
  const receipts=path.join(stateDir,'receipts');mkdirSync(receipts,{recursive:true,mode:0o700});
  const images=[],steps=[];
  for(const target of ['api','worker','web','egress']) {
    const imageTag=`bondbuddy-m1-${target}:${tag}`,log=path.join(receipts,`build-${buildRunId}-${target}.log`);
    const args=['build','--progress=plain','--label',`org.opencontainers.image.revision=${releaseSha}`,'--label',`io.bondbuddy.local-prelaunch.instance=${config.instanceId}`,
      '--build-arg',`BB_RELEASE_SHA=${releaseSha}`,'-t',imageTag,'-f',target==='egress'?'deploy/m1/egress/Dockerfile':'deploy/m1/Dockerfile'];
    if(target!=='egress')args.push('--target',target);args.push('-');
    console.log(`Building current production ${target} from ${releaseSha.slice(0,12)}; log ${path.relative(root,log)}`);
    const startedAt=new Date().toISOString();
    // Egress expects its directory context, streamed from a separate tracked source archive.
    let result;
    if(target==='egress') {
      const egressArchive=path.join(sourceDir,`${releaseSha}-${buildRunId}-egress.tar`);
      await makeArchive(`${releaseSha}:deploy/m1/egress`,egressArchive);
      args[args.indexOf('-f')+1]='Dockerfile';result=await docker(args,{archive:egressArchive,log});
    }else result=await docker(args,{archive,log});
    const [built]=JSON.parse((await docker(['image','inspect',imageTag])).stdout);
    images.push({target,tag:imageTag,id:built.Id,revision:built.Config.Labels?.['org.opencontainers.image.revision']});
    steps.push({target,command:['docker',...args],startedAt,finishedAt:new Date().toISOString(),exitCode:result.code,log});
  }
  const receipt={instanceId:config.instanceId,buildRunId,releaseSha,tree,sourceHash,archive,verifiedRuntimeSources,tag,images,steps,syntheticPayment:true,createdAt:new Date().toISOString()};
  // Publishing this atomic alias is the only activation step. Compose resolves
  // its image tag from this same receipt, never a separately updated env file.
  writeReceipt(`build-${buildRunId}`,receipt);writeReceipt('build',receipt);
  console.log(`Build verified: ${images.length} current production images; local API/payment boot is mounted separately.`);
}finally{await unlock();}
