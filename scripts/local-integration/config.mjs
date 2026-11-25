import {fileURLToPath} from 'node:url';
import {resolve, join} from 'node:path';
import {existsSync,readFileSync} from 'node:fs';

export const repo=resolve(fileURLToPath(new URL('../..',import.meta.url)));
export const root=resolve(repo,'..');
export const instance=process.env.BB_LOCAL_INSTANCE||'20261012';
if(!['20261012','update-20261020','review-20261020','projects-20261020','files-20261021','integrity-20261021','qa-20261021','direct-20261125'].includes(instance))throw Error('Unknown isolated local instance');
const update=instance==='update-20261020';
export const workerImage=`bondbuddy-local-worker:${instance}`;
export const runtime=join(root,`work/local-integration-runtime-${instance}`);
export const binaries=join(root,'work/local-ux-runtime/node_modules');
export const pgBin=join(binaries,'@embedded-postgres/windows-x64/native/bin');
export const ports=instance==='direct-20261125'?{web:5203,api:3033,postgres:15453,blob:10033}:instance==='qa-20261021'?{web:5197,api:3027,postgres:15447,blob:10027}:instance==='integrity-20261021'?{web:5195,api:3025,postgres:15445,blob:10025}:instance==='files-20261021'?{web:5194,api:3024,postgres:15444,blob:10024}:instance==='projects-20261020'?{web:5193,api:3023,postgres:15443,blob:10023}:instance==='review-20261020'?{web:5191,api:3021,postgres:15441,blob:10021}:update?{web:5190,api:3020,postgres:55440,blob:10020}:{web:5178,api:3018,postgres:55438,blob:10018};
export const baseURL=`http://localhost:${ports.web}`;
export const databaseURL=`postgresql://bondbuddy_integration@127.0.0.1:${ports.postgres}/bb_integration_${instance.replaceAll('-','_')}`;
export const templateURL=databaseURL.replace('/bb_integration_','/bb_integration_template_');
export const terms=`local-integration-${instance}`;
export const blobConnection='DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10018/devstoreaccount1;'.replace(':10018/',`:${ports.blob}/`);
export function environment(){
  // Inherit host executable locations, never an ambient production connection or model credential.
  const e={...process.env};
  for(const k of Object.keys(e)) if(/^(BB_|DATABASE_URL$|AZURE_|DEEPSEEK_|OPENAI_|CODEX_HOME$)/i.test(k)) delete e[k];
  const accountFile=join(runtime,'test-accounts.json');
  const directPilot=instance==='direct-20261125'&&existsSync(accountFile)
    ? JSON.parse(readFileSync(accountFile,'utf8')).accounts?.find(account=>account.username==='integration_user')?.owner:null;
  return {...e,BB_LOCAL_INSTANCE:instance,NODE_ENV:'development',DATABASE_URL:databaseURL,AZURE_STORAGE_CONNECTION_STRING:blobConnection,
    HOST:'127.0.0.1',PORT:String(ports.api),BB_ALLOWED_ORIGIN:baseURL,BB_TERMS_VERSION:terms,
    BB_API_PROXY_TARGET:`http://127.0.0.1:${ports.api}`,BB_RUN_RUNTIME_ENABLED:'1',BB_PAID_AUTHORING_ENABLED:'1',BB_PAID_REVIEW_ENABLED:'1',
    BB_DEPLOYMENT_TIER:'local',BB_TRIAL_GUARD:'off',BB_WORKER_GROUP:'local-integration',BB_WORKER_CONCURRENCY:'1',BB_WORKER_PARSE_SLOTS:'1',
    ...(directPilot?{BB_DIRECT_DOCX_ENABLED:'1',BB_DIRECT_DOCX_ALLOW_USERS:directPilot,BB_DIRECT_DOCX_WORKER_GROUP:'local-integration-linux'}:{}),
    BB_PARSE_CACHE_OCR_VERSION:'local-ocr-disabled-v1',BB_PARSE_CACHE_BASIS_VERSION:'local-native-v1',
    BB_REPO_ROOT:repo,BB_PYTHON:join(process.env.USERPROFILE,'/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'),
    BB_PYTHON_BIN:join(process.env.USERPROFILE,'/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'),
    BB_PARSE_STAGING_DIR:join(runtime,'data/parse'),BB_CODEX_WORK_ROOT:join(runtime,'data/model'),
    BB_UPLOAD_SPOOL_DIR:join(runtime,'data/spool'),BB_LOG_NDJSON_PATH:join(runtime,'worker-events.ndjson'),
    BB_CODEX_AUTHORING_TIMEOUT_MS:'18000000'};
}
