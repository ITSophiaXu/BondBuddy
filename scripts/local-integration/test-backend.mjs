import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {repo,runtime,templateURL,blobConnection,environment} from './config.mjs';
const env={...environment(),BB_TEST_DATABASE_URL:templateURL,BB_TEST_AZURITE_CONNECTION_STRING:blobConnection};
const groups={
  api:['authoring-dynamic-balance.pg.test','authoring-progress.pg.test','billing.pg.test','billing-classification.test','credit-history.test','review-billing.pg.test'],
  worker:['authoring-pause.pg.test','run-runtime.test','runtime-isolation.test','runtime-parse-slots.test','runtime-entry.test']
};
for(const [group,files] of Object.entries(groups)){
  if(process.argv[2]&&process.argv[2]!==group)continue;
  // Legacy synthetic runtime tests explicitly inject their queue and omit billable project fields.
  // Paid authoring is exercised separately by the API billing and dynamic-balance suites.
  const testEnv=group==='worker'?{...env,BB_PAID_AUTHORING_ENABLED:'0',BB_PAID_REVIEW_ENABLED:'0'}:env;
  const r=spawnSync(process.execPath,['--test','--test-concurrency=1',...files.map(n=>`apps/${group}/dist/${n}.js`)],{cwd:repo,env:testEnv,windowsHide:true,encoding:'utf8',maxBuffer:16*1024*1024});
  writeFileSync(join(runtime,`tests-${group}.log`),(r.stdout||'')+(r.stderr||''));
  console.log(`${group}: exit=${r.status}`);if(r.status!==0)process.exitCode=1;
}
