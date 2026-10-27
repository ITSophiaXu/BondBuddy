import { createHash } from 'node:crypto';
import { mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const database='postgresql://bb_successor_test@127.0.0.1:15542/bb_b1_template_20261027';
const out=resolve('.local/supplement-b1-20261027',`regression-${new Date().toISOString().replaceAll(/[-:.]/g,'')}`);
mkdirSync(out,{recursive:false});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const suites=['run-supplement-draft.pg.test','run-supplement-preparation.pg.test',
  'run-supplement-file-preparation.pg.test','billing.pg.test','review-billing.pg.test','m4-fixed-billing.pg.test'];
const bound=['apps/api/src/run-supplement-processing-plan.ts','apps/api/dist/run-supplement-processing-plan.js',
  'apps/api/src/run-supplement-quote.ts','apps/api/dist/run-supplement-quote.js','apps/api/src/server.ts','apps/api/dist/server.js',
  'db/migrations/0137_run_supplement_quotes.sql','packages/contracts/src/run-supplement-quote.ts','packages/contracts/dist/run-supplement-quote.js',
  ...suites.flatMap(name=>[`apps/api/src/${name}.ts`,`apps/api/dist/${name}.js`])];
const manifest=()=>bound.map(path=>({path,sha256:sha(readFileSync(path))}));
const summary={startedAt:new Date().toISOString(),template:new URL(database).pathname,invocations:[],before:manifest(),success:false};
function run(name,args){
  const started=Date.now(),result=spawnSync(process.execPath,args,{cwd:process.cwd(),windowsHide:true,
    env:{...process.env,BB_TEST_DATABASE_URL:database},encoding:'utf8',maxBuffer:64*1024*1024});
  writeFileSync(`${out}/${name}.stdout.log`,result.stdout??'');writeFileSync(`${out}/${name}.stderr.log`,result.stderr??'');
  const totals=Object.fromEntries([...(result.stdout??'').matchAll(/^# (tests|pass|fail|skipped) (\d+)$/gm)].map(value=>[value[1],Number(value[2])]));
  const row={name,args,exitCode:result.status,signal:result.signal,error:result.error?String(result.error):null,durationMs:Date.now()-started,totals};
  summary.invocations.push(row);writeFileSync(`${out}/summary.json`,JSON.stringify(summary,null,2));
  process.stdout.write(JSON.stringify(row)+'\n');return result.status===0;
}
const pure=run('classification',['--test','apps/api/dist/billing-classification.test.js']);
const pg=run('pg',['--test','--test-concurrency=1',...suites.map(name=>`apps/api/dist/${name}.js`)]);
summary.after=manifest();summary.sourcesStable=JSON.stringify(summary.before)===JSON.stringify(summary.after);
summary.completedAt=new Date().toISOString();summary.success=pure&&pg&&summary.sourcesStable;
writeFileSync(`${out}/summary.json`,JSON.stringify(summary,null,2));process.stdout.write(`${out}\n`);
if(!summary.success)process.exitCode=1;
