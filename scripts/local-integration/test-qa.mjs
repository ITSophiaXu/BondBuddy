import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {environment,templateURL,blobConnection,repo,runtime,instance} from './config.mjs';
if(instance!=='qa-20261021')throw Error('Use the isolated qa-20261021 instance');
const result=spawnSync(process.execPath,['--test','--test-concurrency=1','apps/worker/dist/project-qa-e2e.pg.test.js'],{cwd:repo,env:{...environment(),BB_TEST_DATABASE_URL:templateURL,BB_TEST_AZURITE_CONNECTION_STRING:blobConnection,BB_QA_TEST_OUTPUT_DIRECTORY:runtime+'/evidence/synthetic-documents',BONDBUDDY_TEST_PYTHON:process.env.USERPROFILE+'/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'},windowsHide:true,encoding:'utf8',maxBuffer:8*1024*1024});
writeFileSync(runtime+'/qa-tests.log',(result.stdout??'')+(result.stderr??''));console.log(result.stdout??'',result.stderr??'');process.exitCode=result.status??1;
