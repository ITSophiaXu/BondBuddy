import {spawn} from 'node:child_process';
import {accessSync,constants,createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {composeArgs,root,stateDir} from './config.mjs';
import {localSeccompFile,seccompSources} from './seccomp.mjs';

export async function command(binary,args,{input,archive,log,allowFailure=false,env}={}) {
  return await new Promise((resolve,reject)=>{
    const child=spawn(binary,args,{cwd:root,stdio:['pipe','pipe','pipe'],...(env?{env}:{})});
    let stdout='',stderr='';const stream=log?createWriteStream(log,{mode:0o600}):undefined;
    child.stdout.on('data',chunk=>{stdout+=chunk;stream?.write(chunk);});
    child.stderr.on('data',chunk=>{stderr+=chunk;stream?.write(chunk);});
    // A failed Docker invocation may close stdin before its source archive finishes streaming.
    child.stdin.on('error',error=>{if(error.code!=='EPIPE')reject(error);});
    child.once('error',error=>{stream?.end();reject(error);});
    child.once('close',code=>{stream?.end();if(code!==0&&!allowFailure)reject(Error(`${binary} ${args[0]??''} failed (exit ${code}); see protected local receipt logs.`));else resolve({code,stdout,stderr});});
    if(archive)createReadStream(archive).pipe(child.stdin);else child.stdin.end(input);
  });
}
export const docker=(args,options)=>command('docker',args,options);
export function composeEnvironment(receipt,environment=process.env) {
  if(!/^local-prelaunch-[a-f0-9-]+$/.test(receipt.tag??''))throw Error('Invalid published local image tag');
  // Process values take precedence over both generated and operator env files.
  // One atomically published receipt controls inspection and actual startup.
  return {...environment,BB_IMAGE_TAG:receipt.tag};
}
export const compose=(config,args,options={})=>docker([...composeArgs(config),...args],
  {...options,env:composeEnvironment(readBuildReceipt(config),options.env??process.env)});
export function pendingImageUpgrade(receipt,items) {
  const changes=[];
  for(const item of items) {
    const service=item.Config.Labels['com.docker.compose.service'];
    if(service==='api-legacy'){
      if(item.State.Running)changes.push({service,containerId:item.Id,state:item.State.Status,actualImage:item.Image,
        actualReleaseSha:item.Config.Labels['org.opencontainers.image.revision']??null,expectedImage:null,targetReleaseSha:receipt.releaseSha,action:'stop-retired-service'});
      continue;
    }
    const target=['api','migrate','local-state-init'].includes(service)?'api':service.startsWith('worker')||service==='ops'?'worker':service;
    const expected=receipt.images.find(image=>image.target===target);
    if(expected&&item.Image!==expected.id)changes.push({service,containerId:item.Id,state:item.State.Status,actualImage:item.Image,
      actualReleaseSha:item.Config.Labels['org.opencontainers.image.revision']??null,expectedImage:expected.id,targetReleaseSha:receipt.releaseSha});
  }
  return changes.length?{state:'pending-upgrade',targetReleaseSha:receipt.releaseSha,services:changes,
    message:'Owned containers use previous images. Start will verify idle work before replacing them; stopped stacks can resume retained work.'}:null;
}

export function ownedStartAction(status,items) {
  if(status.ready)return 'reuse';
  if(items.some(item=>item.Config.Labels['com.docker.compose.service']==='api'&&item.State.Running))return 'verify-idle';
  // A stopped stack can resume queued/released work after a deliberate drain.
  // A partial outage cannot authorize replacement of still-running workers.
  if(items.some(item=>item.State.Running&&(item.Config.Labels['com.docker.compose.service'].startsWith('worker')||
    item.Config.Labels['com.docker.compose.service']==='api-legacy')))
    throw Error('Existing workers or legacy API are running, but the main API cannot verify in-flight work; start refused. No containers changed.');
  return 'start';
}

export function assertIdleWorkload(probe) {
  let workload;try{workload=JSON.parse(probe.stdout.trim());}catch{}
  const empty=['queuedOrRunningJobs','leasedJobs','leasedMessages','activeRuns','pendingFormatDiagnostics'].every(name=>workload?.[name]===0);
  if(probe.code!==0||workload?.identity!==true||workload?.idle!==true||!empty)
    throw Error('Existing local work is active or unverifiable; refusing to recreate containers.');
  return workload;
}
// Compose no longer knows the retired API. Stop owned orphan writers before
// stopping the main API/database, which are needed to prove an idle restart.
export async function stopOwnedStack(items,{stopContainer,stopCompose}) {
  for(const item of items)if(item.State.Running&&item.Config.Labels['com.docker.compose.service']==='api-legacy')
    await stopContainer(item.Id);
  await stopCompose();
}
export function validateLocalAuthHelperBinds(services) {
  for(const [name,service] of Object.entries(services??{})) {
    if(service.environment?.BB_CODEX_AUTH_MODE!=='copilot_enterprise')continue;
    for(const volume of service.volumes??[]) {
      if(volume.type!=='bind'||volume.target!=='/usr/local/bin/bb-copilot-token')continue;
      if(volume.read_only!==true)throw Error(`Local auth helper bind for ${name} must be read-only.`);
      try {
        if(typeof volume.source!=='string'||!statSync(volume.source).isFile())throw Error('not a regular file');
        accessSync(volume.source,constants.R_OK|constants.X_OK);
      }catch {
        throw Error(`Local auth helper bind for ${name} must be an existing readable executable file; fix the public helper source permissions before starting workers.`);
      }
    }
  }
}
export async function validateCompose(config) {
  seccompSources();
  // Inspect expanded secrets in process memory only; report no rendered configuration.
  const parsed=JSON.parse((await compose(config,['config','--format','json'])).stdout);
  validateLocalAuthHelperBinds(parsed.services);
  for(const service of Object.values(parsed.services??{})) {
    if(service.labels?.['io.bondbuddy.local-prelaunch.instance']!==config.instanceId)throw Error('Compose instance label drift');
    if(service.environment?.DATABASE_URL) {
      const target=new URL(service.environment.DATABASE_URL);
      if(target.hostname!=='postgres'||target.port!=='5432'||target.pathname!=='/'+config.database)throw Error('Compose database target drift');
    }
  }
  const api=parsed.services.api;
  if(parsed.name!==config.projectName||parsed.services.postgres.environment.POSTGRES_DB!==config.database||api.environment.BB_LOCAL_PRELAUNCH_INSTANCE!==config.instanceId||
    api.environment.BB_LOCAL_PRELAUNCH_DATABASE!==config.database||api.environment.BB_ALLOWED_ORIGIN!==config.origin||api.environment.BB_DEPLOYMENT_TIER!=='local')throw Error('Compose local boundary drift');
  if(parsed.services['api-legacy']||api.environment.BB_SUBSCRIPTION_BILLING_ENABLED!=='1')throw Error('Compose retired billing policy drift');
  const ports=parsed.services.web.ports??[];
  if(ports.length!==1||ports[0].host_ip!=='127.0.0.1'||String(ports[0].published)!==String(config.port)||
    parsed.services.postgres.ports?.length||parsed.services.azurite.ports?.length)throw Error('Compose host port boundary drift');
  if(parsed.networks.backend.internal!==true||parsed.networks.backend.ipam.config[0].subnet!==config.subnet)throw Error('Compose private network drift');
  if(parsed.services.web.networks.backend.ipv4_address!==config.webIp||api.environment.BB_TRUSTED_PROXY_CIDR!==`${config.webIp}/32`)throw Error('Compose web proxy address drift');
  const security=parsed.services.worker.security_opt??[];
  if(!security.includes('no-new-privileges:true')||security.some(value=>value.startsWith('apparmor='))||
    !security.some(value=>value.startsWith('seccomp=')&&path.resolve(root,'deploy/m1',value.slice(8))===localSeccompFile))throw Error('Compose local authoring seccomp boundary drift');
  if(parsed.services.worker.environment.BB_WORKER_JOB_KINDS!=='run'||parsed.services.worker.environment.BB_WORKER_RUN_KINDS!=='update,generation,qa'||
    parsed.services.worker.environment.BB_WORKER_GROUP!=='authoring')throw Error('Compose authoring maintenance scheduling boundary drift');
  return true;
}
export function gitCommand(args) {
  // A Codex Windows worktree's .git file contains a Windows gitdir. Do not rewrite its metadata.
  const marker=path.join(root,'.git');
  if(process.platform!=='win32'&&existsSync(marker)&&/^gitdir: [A-Za-z]:[\\/]/.test(readFileSync(marker,'utf8'))) {
    const binary='/mnt/c/Program Files/Git/cmd/git.exe';
    if(!existsSync(binary))throw Error('Windows-managed worktree needs its existing Windows Git runtime.');
    const windowsRoot=root.replace(/^\/mnt\/([a-z])\//,(_,drive)=>`${drive.toUpperCase()}:/`);
    // Windows Git archive otherwise applies core.autocrlf and corrupts Linux shebang bytes.
    return {binary,args:['-c','core.autocrlf=false','-c','core.eol=lf','-C',windowsRoot,...args]};
  }
  return {binary:'git',args};
}
export const git=args=>{const request=gitCommand(args);return command(request.binary,request.args);};
export function atomicWriteJson(file,value) {
  const contents=JSON.stringify(value,null,2)+'\n',temporary=`${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary,contents,{mode:0o600,flag:'wx'});
    renameSync(temporary,file);
  }finally{if(existsSync(temporary))rmSync(temporary);}
}
export function writeReceipt(name,value) {
  const folder=path.join(stateDir,'receipts');mkdirSync(folder,{recursive:true,mode:0o700});
  const file=path.join(folder,`${name}.json`);atomicWriteJson(file,value);return file;
}
export async function digest(file) {
  const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');
}
export async function containers(config) {
  const result=await docker(['ps','-a','--filter',`label=com.docker.compose.project=${config.projectName}`,'--format','{{.ID}}']);
  const ids=result.stdout.trim().split(/\s+/).filter(Boolean);if(!ids.length)return [];
  return JSON.parse((await docker(['inspect',...ids])).stdout);
}
export async function ownership(config) {
  const items=await containers(config);
  for(const item of items)if(item.Config.Labels?.['io.bondbuddy.local-prelaunch.instance']!==config.instanceId)
    throw Error('A same-name Docker container is not owned by this local instance.');
  for(const kind of ['volume','network']) {
    const listed=await docker([kind,'ls','--filter',`label=com.docker.compose.project=${config.projectName}`,'--format',kind==='volume'?'{{.Name}}':'{{.ID}}']);
    const ids=listed.stdout.trim().split(/\s+/).filter(Boolean);if(!ids.length)continue;
    for(const item of JSON.parse((await docker([kind,'inspect',...ids])).stdout))if(item.Labels?.['io.bondbuddy.local-prelaunch.instance']!==config.instanceId)
      throw Error(`A same-name Docker ${kind} is not owned by this local instance.`);
  }
  return items;
}
export async function sql(config,query) {
  return (await docker(['exec','-i',`${config.projectName}-postgres-1`,'psql','-U','bondbuddy','-d',config.database,'-X','-A','-t','-v','ON_ERROR_STOP=1'],{input:query})).stdout.trim();
}
function readBuildReceipt(config) {
  const file=path.join(stateDir,'receipts/build.json');if(!existsSync(file))throw Error('No immutable local build receipt; run build.mjs.');
  const receipt=JSON.parse(readFileSync(file,'utf8'));
  if(receipt.instanceId!==config.instanceId)throw Error('Build instance drift');
  composeEnvironment(receipt,{});
  return receipt;
}
export async function verifyBuild(config) {
  const receipt=readBuildReceipt(config);
  for(const expected of receipt.images) {
    const [image]=JSON.parse((await docker(['image','inspect',expected.tag])).stdout);
    if(image.Id!==expected.id||image.Config.Labels?.['org.opencontainers.image.revision']!==receipt.releaseSha||
      image.Config.Labels?.['io.bondbuddy.local-prelaunch.instance']!==config.instanceId)throw Error('Local immutable image receipt mismatch');
  }
  return receipt;
}
export async function runtimeSourceHashes(items,releaseSha) {
  const hashes={};
  for(const item of items)for(const mount of item.Mounts??[]) {
    if(!['/app/scripts/local-prelaunch','/app/scripts/billing-functional','/local-prelaunch','/local-model-probe.mjs','/usr/local/bin/bb-copilot-token','/etc/nginx/conf.d/default.conf'].includes(mount.Destination)||!existsSync(mount.Source))continue;
    const files=statSync(mount.Source).isDirectory()?readdirSync(mount.Source).filter(name=>/\.(mjs|js|html|css)$/.test(name)).map(name=>path.join(mount.Source,name)):[mount.Source];
    for(const file of files)hashes[file]=await digest(file);
  }
  const tracked=(await git(['ls-tree','-r','--name-only',releaseSha,'apps/web/src'])).stdout.split(/\r?\n/).filter(file=>/billing[^/]*\.(ts|css)$/.test(file));
  for(const file of tracked)hashes[`image-source:${releaseSha}:${file}`]=createHash('sha256').update((await git(['show',`${releaseSha}:${file}`])).stdout).digest('hex');
  return hashes;
}
export async function lock(action) {
  const folder=path.join(stateDir,'operation.lock');
  try{mkdirSync(folder,{mode:0o700});}catch{throw Error('Another local lifecycle command holds operation.lock; check its process before removing a stale lock.');}
  writeFileSync(path.join(folder,'owner.json'),JSON.stringify({pid:process.pid,action,startedAt:new Date().toISOString()}));
  return async()=>{const {rm}=await import('node:fs/promises');await rm(folder,{recursive:true});};
}
