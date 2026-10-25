import {spawnSync} from 'node:child_process';
import {existsSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {repo,runtime,templateURL,blobConnection,workerImage,instance} from './config.mjs';

if(instance!=='review-20261020')throw Error('Use the isolated review instance');
const seccomp=join(runtime,'local-worker-seccomp.json');
if(!existsSync(seccomp))throw Error('Start the isolated review worker once to prepare its restricted sandbox profile');
// No model credential, application database, or production volume is mounted.
// Use the worker's Python/Codex toolchain with current compiled sources, all read-only.
const paths=['apps/api/dist','apps/worker/dist','apps/worker/test-fixtures','python'];
for(const p of ['contracts','domain','rule-pack-registry','rule-applicability-context'])paths.push(`packages/${p}/dist`);
const env={BB_TEST_DATABASE_URL:templateURL.replace('127.0.0.1','host.docker.internal'),
  BB_TEST_AZURITE_CONNECTION_STRING:blobConnection.replace('127.0.0.1','host.docker.internal'),
  BB_PAID_AUTHORING_ENABLED:'0',BB_PAID_REVIEW_ENABLED:'0',BONDBUDDY_TEST_PYTHON:'/opt/venv/bin/python',
  BB_CODEX_PATH:'/usr/local/bin/codex',PYTHONDONTWRITEBYTECODE:'1'};
const args=['run','--rm','--name',`bb-review-tests-${instance}`,'--read-only','--cap-drop','ALL',
  '--security-opt','no-new-privileges:true','--security-opt',`seccomp=${seccomp}`,
  '--memory','2g','--cpus','2','--pids-limit','256','--tmpfs','/tmp:rw,nosuid,nodev,size=512m,mode=1777',
  ...paths.flatMap(p=>['--mount',`type=bind,source=${join(repo,p)},target=/app/${p},readonly`]),
  ...Object.entries(env).flatMap(([k,v])=>['-e',`${k}=${v}`]),workerImage,
  'node','--test','--test-concurrency=1','apps/worker/dist/review-file-delivery.pg.test.js',
  'apps/worker/dist/review-file-stage.test.js','apps/worker/dist/review-project-e2e.pg.test.js'];
const result=spawnSync('C:/Program Files/Docker/Docker/resources/bin/docker.exe',args,{cwd:repo,windowsHide:true,encoding:'utf8',maxBuffer:16*1024*1024});
writeFileSync(join(runtime,'review-linux-tests.log'),(result.stdout??'')+(result.stderr??''));
console.log(result.stdout??'',result.stderr??'');process.exitCode=result.status??1;
