// Dedicated, explicitly configured local fixtures. Never infer a database from production env.
import {spawnSync} from 'node:child_process';
const url=new URL(process.env.BB_TEST_DATABASE_URL??'http://missing');
if(!['postgres:','postgresql:'].includes(url.protocol)||!['localhost','127.0.0.1'].includes(url.hostname)||!url.pathname.includes('template'))throw Error('Explicit local test template database required');
const blob=process.env.BB_TEST_AZURITE_CONNECTION_STRING??'';
if(!blob.includes('AccountName=devstoreaccount1;')||!/BlobEndpoint=http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(blob))throw Error('Explicit local Azurite connection required');
if(!process.env.BONDBUDDY_TEST_PYTHON)throw Error('Explicit document test Python required');
const files=['apps/worker/dist/integrity-browser.test.js','apps/worker/dist/integrity-evidence.test.js','apps/worker/dist/integrity-e2e.pg.test.js','apps/worker/dist/integrity-pricing.pg.test.js','apps/api/dist/credit-history.test.js','apps/api/dist/billing.pg.test.js'];
const result=spawnSync(process.execPath,['--test','--test-concurrency=1',...files],{stdio:'inherit',windowsHide:true,env:{...process.env,BB_TEST_INTEGRITY_BROWSER:'1'}});
process.exitCode=result.status??1;
