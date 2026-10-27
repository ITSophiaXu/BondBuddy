import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync,readdirSync,readFileSync,writeFileSync,createWriteStream } from 'node:fs';
import { join,resolve } from 'node:path';
import { spawn } from 'node:child_process';
const mode=process.argv[2],database=process.argv[3];
const regression=['authoring-dynamic-balance.pg.test','authoring-progress.pg.test','review-dynamic-balance.pg.test',
 'm4-dynamic-balance.pg.test','billing.pg.test','review-billing.pg.test','m4-fixed-billing.pg.test','credit-history.test',
 'run-supplement-quote.pg.test','run-supplement-test-adoption.pg.test','run-supplement-execution.pg.test',
 'run-billing-segments.pg.test','run-billing-segments-sql.pg.test','billing-segment-compatibility.pg.test'];
const suites={api:['apps/api/dist/run-supplement-adoption.pg.test.js'],worker:['apps/worker/dist/run-supplement-production-execution.pg.test.js'],
 regression:regression.map(name=>`apps/api/dist/${name}.js`),contracts:['packages/contracts/dist/run-supplement-adoption.test.js'],
 workerRegression:['apps/worker/dist/run-supplement-execution.pg.test.js']};
assert.ok(suites[mode]&&database,'exact mode and migrated local template URL required');
const target=new URL(database);assert.equal(target.hostname,'127.0.0.1');assert.equal(target.port,'15542');
const out=resolve('.local/production-supplement-20261027',`${mode}-${new Date().toISOString().replaceAll(/[-:.]/g,'')}-${process.pid}`);
mkdirSync(out,{recursive:false});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const roots=['apps/api/src','apps/api/dist','apps/worker/src','apps/worker/dist','db/migrations',
 'packages/contracts/src','packages/contracts/dist','packages/domain/src','packages/domain/dist',
 'packages/rule-pack-registry/src','packages/rule-pack-registry/dist','packages/rule-applicability-context/src','packages/rule-applicability-context/dist'];
function manifest(){const paths=[];function walk(dir){for(const item of readdirSync(dir,{withFileTypes:true})){
 const path=join(dir,item.name);if(item.isDirectory())walk(path);else if(item.isFile())paths.push(path);}}
 roots.forEach(walk);return paths.sort().map(path=>{const bytes=readFileSync(path);return{path:path.replaceAll('\\','/'),bytes:bytes.length,sha256:sha(bytes)};});}
const before=manifest();writeFileSync(join(out,'sources-before.json'),JSON.stringify(before));
writeFileSync(join(out,'runner.mjs'),readFileSync(new URL(import.meta.url)));
const python='C:/Users/lezhai/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const args=['--test','--test-reporter=tap','--test-concurrency=1',...suites[mode]];
const stdout=createWriteStream(join(out,'stdout.log')),stderr=createWriteStream(join(out,'stderr.log'));
const startedAt=new Date().toISOString();
const child=spawn(process.execPath,args,{cwd:process.cwd(),windowsHide:true,env:{...process.env,BB_TEST_DATABASE_URL:database,
 BONDBUDDY_TEST_PYTHON:python,BONDBUDDY_WORD_PYTHON:python,BB_PYTHON_BIN:python},stdio:['ignore','pipe','pipe']});
child.stdout.pipe(stdout);child.stderr.pipe(stderr);
const [exitCode,signal]=await new Promise(resolveExit=>child.once('close',(code,signal)=>resolveExit([code,signal])));
await Promise.all([stdout,stderr].map(stream=>new Promise(resolveStream=>stream.writableFinished?resolveStream():stream.once('finish',resolveStream))));
const log=readFileSync(join(out,'stdout.log'),'utf8'),after=manifest();
writeFileSync(join(out,'sources-after.json'),JSON.stringify(after));
const totals=Object.fromEntries([...log.matchAll(/^# (tests|pass|fail|skipped|cancelled) (\d+)$/gm)].map(value=>[value[1],Number(value[2])]));
const summary={mode,startedAt,completedAt:new Date().toISOString(),args,template:target.pathname,exitCode,signal,totals,
 sourcesStable:JSON.stringify(before)===JSON.stringify(after),sourceEntries:before.length,
 stdout:{bytes:Buffer.byteLength(log),sha256:sha(Buffer.from(log))},stderr:{sha256:sha(readFileSync(join(out,'stderr.log')))}};
writeFileSync(join(out,'summary.json'),JSON.stringify(summary,null,2));
process.stdout.write(JSON.stringify({...summary,out})+'\n');process.exitCode=exitCode;
