import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {repo,runtime,templateURL,blobConnection,environment,instance} from './config.mjs';
if(instance!=='review-20261020')throw Error('Use the isolated review instance');
const env={...environment(),BB_TEST_DATABASE_URL:templateURL,BB_TEST_AZURITE_CONNECTION_STRING:blobConnection,BB_PAID_AUTHORING_ENABLED:'0',BB_PAID_REVIEW_ENABLED:'0',BONDBUDDY_TEST_PYTHON:'python'};
const files=process.argv.slice(2);
const r=spawnSync(process.execPath,['--test','--test-concurrency=1',...(files.length?files:['apps/worker/dist/review-project-e2e.pg.test.js'])],{cwd:repo,env,windowsHide:true,encoding:'utf8',maxBuffer:16*1024*1024});
writeFileSync(join(runtime,'review-backend-tests.log'),(r.stdout??'')+(r.stderr??''));console.log(r.stdout??'',r.stderr??'');process.exitCode=r.status??1;
