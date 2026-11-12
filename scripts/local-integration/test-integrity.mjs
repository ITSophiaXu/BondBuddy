import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {environment,templateURL,blobConnection,repo,runtime,instance} from './config.mjs';
if(instance!=='integrity-20261021')throw Error('Use BB_LOCAL_INSTANCE=integrity-20261021 for the isolated integrity test environment');
const files=['apps/worker/dist/integrity-evidence.test.js','apps/worker/dist/integrity-e2e.pg.test.js','apps/worker/dist/integrity-pricing.pg.test.js',
 'apps/api/dist/credit-history.test.js','apps/api/dist/billing.pg.test.js',
 'apps/web/dist-test/project-collection-model.test.js'];
const result=spawnSync(process.execPath,['--test','--test-concurrency=1',...files],{cwd:repo,
 env:{...environment(),BB_TEST_DATABASE_URL:templateURL,BB_TEST_AZURITE_CONNECTION_STRING:blobConnection,
  BB_INTEGRITY_TEST_OUTPUT_DIRECTORY:runtime+'/evidence/synthetic-workpapers',
  BONDBUDDY_TEST_PYTHON:process.env.BONDBUDDY_TEST_PYTHON??process.env.USERPROFILE+'/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'},
 windowsHide:true,encoding:'utf8',maxBuffer:16*1024*1024});
writeFileSync(runtime+'/integrity-tests.log',(result.stdout??'')+(result.stderr??''));
console.log(result.stdout??'',result.stderr??'');process.exitCode=result.status??1;
// The legacy collection fixture deliberately starts unpriced authoring runs.
const collection=spawnSync(process.execPath,['--test','apps/api/dist/project-collection.pg.test.js'],{cwd:repo,
 env:{...environment(),BB_PAID_AUTHORING_ENABLED:'0',BB_PAID_REVIEW_ENABLED:'0',BB_TEST_DATABASE_URL:templateURL,BB_TEST_AZURITE_CONNECTION_STRING:blobConnection},
 windowsHide:true,encoding:'utf8',maxBuffer:4*1024*1024});
writeFileSync(runtime+'/integrity-collection-regression.log',(collection.stdout??'')+(collection.stderr??''));
console.log(collection.stdout??'',collection.stderr??'');if(collection.status!==0)process.exitCode=1;
