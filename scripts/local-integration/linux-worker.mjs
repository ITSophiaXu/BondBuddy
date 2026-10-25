import {spawn,spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {repo,runtime,databaseURL,blobConnection,instance} from './config.mjs';
export const docker='C:/Program Files/Docker/Docker/resources/bin/docker.exe';
export const containerName=`bb-local-integration-worker-${instance}`;
export const generationConfig=join(runtime,'linux-worker.json');
const label='com.bondbuddy.local-integration',volume=`bb-local-integration-parse-${instance}`;
export function dockerCommand(args,options={}){
  const r=spawnSync(docker,args,{encoding:'utf8',windowsHide:true,timeout:45000,...options});
  if(r.status!==0)throw Error(r.stderr||r.error?.message||'Local Docker command failed');
  return r.stdout.trim();
}
export function configured(){return existsSync(generationConfig);}
export function ensureLocalVolume(){
  const r=spawnSync(docker,['volume','inspect',volume],{encoding:'utf8',windowsHide:true});
  if(r.status===0){if(JSON.parse(r.stdout)[0].Labels?.[label]!==instance)throw Error('Unowned local parse volume; preserving it');}
  else dockerCommand(['volume','create','--label',`${label}=${instance}`,volume]);
}
export function modelReady(){
  if(!configured())return false;
  const config=JSON.parse(readFileSync(generationConfig,'utf8')),c=containerStatus();
  return !!c?.running&&c.image===config.imageId&&config.preflight?.status==='completed';
}
export function containerStatus(){
  const r=spawnSync(docker,['inspect','--format','{{json .}}',containerName],{encoding:'utf8',windowsHide:true,timeout:10000});
  if(r.status!==0)return null;
  const c=JSON.parse(r.stdout);
  if(c.Config.Labels?.[label]!==instance||c.Config.Labels?.['com.bondbuddy.workspace']!==repo)throw Error('Unowned local worker container; preserving it');
  return {id:c.Id,running:c.State.Running,image:c.Image,launchId:c.Config.Labels['com.bondbuddy.launch-id']};
}
export function workerArgs(config){
  // CLI 0.154 mounts fresh procfs after applying deny masks. Docker Desktop has
  // no AppArmor; deny the bundled bwrap proc mount flags (NOSUID|NODEV|NOEXEC).
  // Its official no-proc fallback then preserves the existing /proc deny mask.
  // This only narrows the product seccomp profile; all other rules stay intact.
  const profile=JSON.parse(readFileSync(join(repo,'deploy/m1/security/codex-seccomp.json'),'utf8'));
  profile.syscalls=profile.syscalls.flatMap(rule=>{
    if(!rule.names.includes('mount')||rule.action!=='SCMP_ACT_ALLOW')return [rule];
    const {names,...rest}=rule;
    return [{...rest,names:names.filter(n=>n!=='mount')},{...rest,names:['mount'],args:[...(rule.args??[]),{index:3,value:14,op:'SCMP_CMP_NE'}]}];
  });
  const seccomp=join(runtime,'local-worker-seccomp.json');writeFileSync(seccomp,JSON.stringify(profile));
  const env={BB_LOCAL_INSTANCE:instance,DATABASE_URL:databaseURL.replace('127.0.0.1','host.docker.internal'),
    AZURE_STORAGE_CONNECTION_STRING:blobConnection.replace('127.0.0.1','host.docker.internal'),
    BB_RUN_RUNTIME_ENABLED:'1',BB_PAID_AUTHORING_ENABLED:'1',BB_PAID_REVIEW_ENABLED:'1',
    BB_DEPLOYMENT_TIER:'local',BB_TRIAL_GUARD:'off',BB_WORKER_GROUP:'local-integration-linux',
    BB_WORKER_CONCURRENCY:'1',BB_WORKER_PARSE_SLOTS:'1',BB_PARSE_CACHE_OCR_VERSION:'tesseract-5.3.0-eng-chi_sim-osd-v1',
    BB_PARSE_CACHE_BASIS_VERSION:'local-linux-v1',BB_PARSE_STAGING_DIR:'/var/lib/bondbuddy/parse-staging',
    BB_CODEX_WORK_ROOT:'/tmp/bb-codex',BB_CODEX_AUTH_MODE:'copilot_enterprise',
    BB_COPILOT_OAUTH_FILE:'/run/secrets/bb-copilot-oauth',BB_CODEX_MODEL:'gpt-6-sol',
    BB_CODEX_PROVIDER:'copilot_enterprise',BB_CODEX_BASE_URL:'https://api.enterprise.githubcopilot.com',
    BB_CODEX_REASONING_EFFORT:'max',BB_CODEX_CONFIG_VERSION:'local-copilot-direct-20261012',
    BB_CODEX_TIMEOUT_MS:'120000',BB_CODEX_AUTHORING_TIMEOUT_MS:'18000000',BB_PYTHON_BIN:'/opt/venv/bin/python',
    BB_PYTHON:'/opt/venv/bin/python',BB_REPO_ROOT:'/app'};
  return ['--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true',
    '--security-opt',`seccomp=${seccomp}`,
    '--memory','2g','--cpus','2','--pids-limit','256','--tmpfs','/tmp:rw,nosuid,nodev,size=512m,mode=1777',
    '--mount',`type=volume,source=${volume},target=/var/lib/bondbuddy/parse-staging`,
    '--mount',`type=bind,source=${config.credentialFile},target=/run/secrets/bb-copilot-oauth,readonly`,
    ...Object.entries(env).flatMap(([k,v])=>['-e',`${k}=${v}`])];
}
export function refreshLocalCredential(){
  // Store outside OneDrive and every repository; stdout from gh never enters logs.
  const dir=join(process.env.LOCALAPPDATA,`BondBuddy/local-integration-${instance}`);mkdirSync(dir,{recursive:true});
  const credentialFile=join(dir,'model-token');
  const r=spawnSync('gh',['auth','token','--hostname','github.com'],{encoding:'utf8',windowsHide:true});
  if(r.status!==0||!r.stdout.trim()||/\s/.test(r.stdout.trim()))throw Error('Existing GitHub model credential unavailable');
  const acl=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',
    '$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; & icacls.exe $env:BB_LOCAL_CREDENTIAL_DIR /inheritance:r /grant:r "*${sid}:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" | Out-Null; if($LASTEXITCODE -ne 0){exit 1}'],
    {env:{...process.env,BB_LOCAL_CREDENTIAL_DIR:dir},encoding:'utf8',windowsHide:true});
  if(acl.status!==0)throw Error('Could not restrict local credential directory');
  writeFileSync(credentialFile,r.stdout.trim(),{mode:0o600});
  return credentialFile;
}
export async function startLinuxWorker(launchId){
  const config=JSON.parse(readFileSync(generationConfig,'utf8'));
  if(!/^sha256:[a-f0-9]{64}$/.test(config.imageId))throw Error('Pinned local worker image required');
  if(config.credentialFile!==refreshLocalCredential())throw Error('Unexpected local credential path');
  const existing=containerStatus();
  if(existing?.running)throw Error('A local worker container is already running; preserve it and inspect its launch receipt');
  if(existing)dockerCommand(['rm',existing.id]);
  ensureLocalVolume();
  const id=dockerCommand(['create','--name',containerName,'--label',`${label}=${instance}`,
    '--label',`com.bondbuddy.workspace=${repo}`,'--label',`com.bondbuddy.launch-id=${launchId}`,
    ...workerArgs(config),config.imageId]);
  const child=spawn(docker,['start','--attach',id],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stopped=false,buffer='';
  const stop=async()=>{if(stopped)return;stopped=true;const current=containerStatus();
    if(current?.id!==id)throw Error('Worker container identity changed; refusing to stop it');
    dockerCommand(['stop','--time','30',id]);};
  try{
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('Linux worker readiness timed out')),45000);
      child.stdout.on('data',b=>{process.stdout.write(b);buffer=(buffer+b).slice(-8192);
        if(buffer.includes('"service":"linux-worker","ready":true')){clearTimeout(timer);resolve();}});
      child.stderr.on('data',b=>process.stderr.write(b));
      child.once('error',e=>{clearTimeout(timer);reject(e);});
      child.once('exit',code=>{clearTimeout(timer);if(!stopped)reject(Error(`Linux worker exited (${code})`));});
    });
  }catch(error){await stop();throw error;}
  child.on('exit',code=>{if(!stopped){console.error('Linux worker exited unexpectedly',code);process.exit(1);}});
  return {stop,id};
}
