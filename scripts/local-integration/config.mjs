import {fileURLToPath} from 'node:url';
import {resolve, join} from 'node:path';

export const repo=resolve(fileURLToPath(new URL('../..',import.meta.url)));
export const root=resolve(repo,'..');
export const runtime=join(root,'work/local-integration-runtime-20261012');
export const binaries=join(root,'work/local-ux-runtime/node_modules');
export const pgBin=join(binaries,'@embedded-postgres/windows-x64/native/bin');
export const ports={web:5178,api:3018,postgres:55438,blob:10018};
export const baseURL='http://localhost:5178';
export const databaseURL='postgresql://bondbuddy_integration@127.0.0.1:55438/bb_integration_20261012';
export const templateURL='postgresql://bondbuddy_integration@127.0.0.1:55438/bb_integration_template_20261012';
export const terms='local-integration-20261012';
export const blobConnection='DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10018/devstoreaccount1;';
export function environment(){
  // Inherit host executable locations, never an ambient production connection or model credential.
  const e={...process.env};
  for(const k of Object.keys(e)) if(/^(BB_|DATABASE_URL$|AZURE_|DEEPSEEK_|OPENAI_|CODEX_HOME$)/i.test(k)) delete e[k];
  return {...e,NODE_ENV:'development',DATABASE_URL:databaseURL,AZURE_STORAGE_CONNECTION_STRING:blobConnection,
    HOST:'127.0.0.1',PORT:String(ports.api),BB_ALLOWED_ORIGIN:baseURL,BB_TERMS_VERSION:terms,
    BB_API_PROXY_TARGET:`http://127.0.0.1:${ports.api}`,BB_RUN_RUNTIME_ENABLED:'1',BB_PAID_AUTHORING_ENABLED:'1',BB_PAID_REVIEW_ENABLED:'1',
    BB_DEPLOYMENT_TIER:'local',BB_TRIAL_GUARD:'off',BB_WORKER_GROUP:'local-integration',BB_WORKER_CONCURRENCY:'1',BB_WORKER_PARSE_SLOTS:'1',
    BB_PARSE_CACHE_OCR_VERSION:'local-ocr-disabled-v1',BB_PARSE_CACHE_BASIS_VERSION:'local-native-v1',
    BB_REPO_ROOT:repo,BB_PYTHON:join(process.env.USERPROFILE,'/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'),
    BB_PYTHON_BIN:join(process.env.USERPROFILE,'/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'),
    BB_PARSE_STAGING_DIR:join(runtime,'data/parse'),BB_CODEX_WORK_ROOT:join(runtime,'data/model'),
    BB_UPLOAD_SPOOL_DIR:join(runtime,'data/spool'),BB_LOG_NDJSON_PATH:join(runtime,'worker-events.ndjson'),
    BB_CODEX_AUTHORING_TIMEOUT_MS:'18000000'};
}
