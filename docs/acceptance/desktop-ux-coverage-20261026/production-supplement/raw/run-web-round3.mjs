import {mkdir,readFile,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {resolve,join} from 'node:path';

const root=process.cwd(),kind=process.argv[2];
if(!['mock','real'].includes(kind))throw Error('Use mock or real');
const evidence=resolve(root,'.local/production-supplement-20261027',`web-${kind}-round3`);
await mkdir(evidence,{recursive:true});
const paths=JSON.parse(await readFile(resolve(root,'.local/production-supplement-20261027/web-real-round2/source-before.json'),'utf8')).map(row=>row.path);
async function manifest(){return Promise.all(paths.map(async path=>{const absolute=resolve(root,path),[bytes,info]=await Promise.all([readFile(absolute),stat(absolute)]);return {path,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,mtimeUtc:info.mtime.toISOString()};}));}
const before=await manifest();await writeFile(join(evidence,'source-before.json'),JSON.stringify(before,null,2));
const python='C:/Users/lezhai/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const taskEnv={BB_E2E_BROWSER_CHANNEL:'msedge',BB_E2E_BASE_URL:`http://127.0.0.1:${kind==='mock'?'5187':'5199'}`,
  BB_TEST_DATABASE_URL:'postgresql://bb_successor_test@127.0.0.1:15542/bb_prod_supplement02_20261027',
  BONDBUDDY_TEST_PYTHON:python,BONDBUDDY_WORD_PYTHON:python,BB_PYTHON_BIN:python,
  PLAYWRIGHT_JSON_OUTPUT_FILE:join(evidence,'results.json'),
  BB_SUPPLEMENT_PRODUCTION_BROWSER_EVIDENCE_DIR:evidence,
  BB_SUPPLEMENT_ADOPTION_EVIDENCE_DIR:join(evidence,'screenshots'),BB_SUPPLEMENT_EVIDENCE_DIR:join(evidence,'screenshots')};
const env={...process.env,...taskEnv};
const specs=kind==='mock'?['tests/run-supplement-adoption.spec.ts','tests/run-supplement-draft.spec.ts','tests/run-supplement-adoption-resume.spec.ts']:['tests/run-supplement-production-real-main.spec.ts'];
const args=['../../node_modules/@playwright/test/cli.js','test',...specs,'--reporter=line,json',`--output=${join(evidence,'test-results')}`];
await writeFile(join(evidence,'invocation.json'),JSON.stringify({command:process.execPath,args,cwd:join(root,'apps/web'),env:taskEnv},null,2));
let raw='';const child=spawn(process.execPath,args,{cwd:join(root,'apps/web'),env,stdio:['ignore','pipe','pipe'],windowsHide:true});
for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{raw+=bytes.toString();process.stdout.write(bytes);});
const exit=await new Promise((resolveExit,reject)=>{child.on('error',reject);child.on('close',(code,signal)=>resolveExit({code,signal}));});
await writeFile(join(evidence,'raw.log'),raw);await writeFile(join(evidence,'exit.txt'),String(exit.code));
const after=await manifest();await writeFile(join(evidence,'source-after.json'),JSON.stringify(after,null,2));
const stable=JSON.stringify(before)===JSON.stringify(after);
await writeFile(join(evidence,'source-stability.json'),JSON.stringify({stable,files:paths.length,exit},null,2));
process.stdout.write(`\nSOURCE_STABLE=${stable} EVIDENCE=${evidence}\n`);
process.exitCode=exit.code??1;
