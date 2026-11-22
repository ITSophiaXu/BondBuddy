import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';

export const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export const stateDir=path.join(root,'.local/local-prelaunch');
export const configFile=path.join(stateDir,'config.json');
export const envFile=path.join(stateDir,'runtime.env');
export const modelEnvFile=path.join(stateDir,'model.env');
export const composeFiles=[path.join(root,'deploy/m1/compose.yaml'),path.join(root,'deploy/local-prelaunch/compose.yaml')];
const linuxPath=p=>p.replace(/^([A-Za-z]):[\\/]/,(_,drive)=>`/mnt/${drive.toLowerCase()}/`).replaceAll('\\','/');

// Every Windows entry point pins WSL's working directory to this checkout.
export function delegate(entry) {
  if(process.platform!=='win32')return;
  ensureHostKeeper();
  const script=path.relative(root,entry).replaceAll('\\','/');
  const result=spawnSync('wsl.exe',['-d',process.env.BB_LOCAL_WSL_DISTRO??'BondBuddyM3','--cd',linuxPath(root),'--','node',script,...process.argv.slice(2)],{stdio:'inherit'});
  if(result.error)console.error('WSL entry point unavailable; start the configured local distribution.');
  process.exit(result.status??1);
}

function ensureHostKeeper() {
  mkdirSync(stateDir,{recursive:true,mode:0o700});
  const savedFile=path.join(stateDir,'host-wsl.json'),liveFile=path.join(stateDir,'host-keeper-live.json');
  if(existsSync(savedFile)&&existsSync(liveFile)) {
    try {
      const saved=JSON.parse(readFileSync(savedFile,'utf8')),live=JSON.parse(readFileSync(liveFile,'utf8'));
      process.kill(saved.windowsPid,0);
      if(saved.root===root&&saved.hostId===live.hostId&&Date.now()-Date.parse(live.heartbeatAt)<20000)return;
    }catch { /* a stale owned receipt never authorizes terminating another process */ }
  }
  const hostId=randomUUID(),distro=process.env.BB_LOCAL_WSL_DISTRO??'BondBuddyM3';
  const keeper=spawn('wsl.exe',['-d',distro,'--cd',linuxPath(root),'--','node','scripts/local-prelaunch/host-keeper.mjs',hostId],
    {stdio:'ignore',detached:true,windowsHide:true});
  keeper.on('error',()=>console.error('Local WSL keeper could not start.'));
  keeper.unref();
  writeFileSync(savedFile,JSON.stringify({hostId,root,distro,windowsPid:keeper.pid,startedAt:new Date().toISOString()},null,2)+'\n',{mode:0o600});
}

export function readConfig({create=false}={}) {
  if(!existsSync(configFile)) {
    if(!create)throw Error('Local environment has not been initialized; run start.mjs or build.mjs.');
    mkdirSync(stateDir,{recursive:true,mode:0o700});
    const instanceId=randomUUID(),suffix=createHash('sha256').update(instanceId).digest('hex').slice(0,16);
    const config={version:1,instanceId,database:`bb_billing_functional_${suffix}`,projectName:`bb-prelaunch-${suffix.slice(0,12)}`,
      origin:'http://localhost:18087',terms:'local-prelaunch-20261107',subnet:'10.238.87.0/24',webIp:'10.238.87.240',port:18087,
      root,createdAt:new Date().toISOString(),syntheticPayment:true,realWorker:true};
    writeFileSync(configFile,JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});
    const storageKey=randomBytes(48).toString('base64');
    const env={COMPOSE_PROJECT_NAME:config.projectName,COMPOSE_PROFILES:'staging-blob',
      POSTGRES_PASSWORD:randomBytes(24).toString('hex'),BB_LOCAL_PRELAUNCH_DATABASE:config.database,BB_LOCAL_PRELAUNCH_INSTANCE:instanceId,
      BB_LOCAL_PRELAUNCH_ROOT:root,BB_LOCAL_PRELAUNCH_STATE_DIR:'/var/lib/bondbuddy/local-prelaunch',
      AZURITE_ACCOUNTS:`prelaunch:${storageKey}`,AZURE_STORAGE_CONNECTION_STRING:`DefaultEndpointsProtocol=http;AccountName=prelaunch;AccountKey=${storageKey};BlobEndpoint=http://azurite:10000/prelaunch;`,
      BB_PUBLIC_ORIGIN:config.origin,BB_TERMS_VERSION:config.terms,BB_BIND_ADDR:'127.0.0.1',BB_HTTP_PORT:String(config.port),
      BB_BACKEND_SUBNET:config.subnet,BB_WEB_IP:config.webIp,BB_DEPLOYMENT_TIER:'local',BB_NON_PRODUCTION_TEST_CHANNEL:'disabled',
      BB_TRIAL_SOURCE_SALT:randomBytes(24).toString('hex'),BB_TRIAL_GUARD:'on',BB_STORAGE_PURGE_ENABLED:'false',
      BB_PARSE_CACHE_OCR_VERSION:'bondbuddy-ocr-1.0.1',BB_PARSE_CACHE_BASIS_VERSION:'evidence-basis-v1',
      BB_SUBSCRIPTION_BILLING_ENABLED:'1',BB_PAID_AUTHORING_ENABLED:'1',BB_PAID_REVIEW_ENABLED:'1',BB_OUTCOME_PRICING_ENABLED:'1',
      BB_OPS_PROVIDER_BALANCE:'off',BB_OPS_LIBRARY_SYNC:'off',BB_LOG_ARCHIVE_ENABLED:'0',
      BB_EGRESS_ALLOW:'api.deepseek.com',BB_PAYMENT_SECRETS_DIR:path.join(stateDir,'empty-payment-secrets'),BB_COPILOT_OAUTH_HOST_FILE:'/dev/null'};
    mkdirSync(env.BB_PAYMENT_SECRETS_DIR,{mode:0o700});
    writeFileSync(envFile,serializeEnv(env),{mode:0o600,flag:'wx'});
    // Operator-managed credentials/transport settings are separate from generated local identity.
    if(!existsSync(modelEnvFile))writeFileSync(modelEnvFile,'# Local model transport; never commit or print this file.\n',{mode:0o600,flag:'wx'});
  }
  const config=JSON.parse(readFileSync(configFile,'utf8'));
  const suffix=createHash('sha256').update(config.instanceId??'').digest('hex').slice(0,16);
  if(config.version!==1||!/^[-a-f0-9]{36}$/.test(config.instanceId)||!/^bb_billing_functional_[a-f0-9]{16}$/.test(config.database)||
    !/^bb-prelaunch-[a-f0-9]{12}$/.test(config.projectName)||config.root!==root||config.origin!==`http://localhost:${config.port}`||
    config.subnet!=='10.238.87.0/24'||config.webIp!=='10.238.87.240'||config.port!==18087||config.database!==`bb_billing_functional_${suffix}`||
    config.projectName!==`bb-prelaunch-${suffix.slice(0,12)}`)throw Error('Local configuration identity drift; refusing to touch Docker resources.');
  if(!existsSync(envFile)||!existsSync(modelEnvFile))throw Error('Protected local environment files are missing.');
  return config;
}

export function serializeEnv(values) {
  return Object.entries(values).map(([key,value])=>{
    if(!/^[A-Z][A-Z0-9_]*$/.test(key)||/[\r\n']/.test(String(value)))throw Error('Invalid protected environment value');
    return `${key}='${value}'`;
  }).join('\n')+'\n';
}
export function composeArgs(config) {
  const modelCompose=path.join(stateDir,'model.compose.yaml');
  const files=existsSync(modelCompose)?[...composeFiles,modelCompose]:composeFiles;
  return ['compose','--project-name',config.projectName,'--project-directory',path.join(root,'deploy/m1'),'--env-file',envFile,'--env-file',modelEnvFile,
    ...files.flatMap(file=>['-f',file]),'--profile','staging-blob','--profile','legacy-billing'];
}
