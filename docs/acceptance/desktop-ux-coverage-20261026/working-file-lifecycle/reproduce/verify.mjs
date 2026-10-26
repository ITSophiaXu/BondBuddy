import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,readdirSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,relative,join} from 'node:path';
import {Pool} from 'pg';

const root=process.cwd(),local=resolve(root,'.local/working-file-lifecycle');
mkdirSync(local,{recursive:true});
const env={...process.env};
for(const name of Object.keys(env))if(/^(BB_|DATABASE_URL$|AZURE_|DEEPSEEK_|OPENAI_|CODEX_HOME$)/i.test(name))delete env[name];
const template='postgresql://bb_g03_test@127.0.0.1:15526/bb_g03_template_20261026';
Object.assign(env,{BB_TEST_DATABASE_URL:template,BB_RUN_RUNTIME_ENABLED:'1',BB_E2E_BASE_URL:'http://127.0.0.1:5198',BB_E2E_BROWSER_CHANNEL:'msedge',
 BONDBUDDY_TEST_PYTHON:'C:/Users/lezhai/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe',
 BONDBUDDY_WORD_PYTHON:'C:/Users/lezhai/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'});
const mode=process.argv[2],sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const write=(name,value)=>writeFileSync(join(local,name),typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');
const apiTests=['run-working-files.pg.test','review-readable-retention.pg.test','review-readable.test','storage-inventory.test','zz_log_ops.test','deletion-lifecycle.test','run-file-reference.test','run-supplement-files.pg.test','run-supplement-work-retention.pg.test','model-call-execution.test','model-call-execution.pg.integration.test','run-supplement-work.pg.test','provider-result-validation.test','provider-runtime-locks.pg.integration.test','queue.test','run-execution-input.test','run-supplement-input.test','run-supplement-draft.pg.test','run-execution.pg.integration.test','run-origin-immutability.pg.test'];
const workerTests=['project-qa-e2e.pg.test','integrity-e2e.pg.test','integrity-browser.test','integrity-evidence.test','project-file-evidence.test','m4-stages.test','m4-case-templates.pg.test','project-files-e2e.pg.test','review-project-e2e.pg.test','review-revision-cli-stage.test','review-revision-cli-native.test','review-input-execution.test','unified-execution-input.test','m4-input.test','unified-input.test','review-assistant-linked.test','review-rule-context.test',
 'run-execution-consumers.pg.test','execution-input-loaders.pg.test','review-file-stage.test','unified-authoring.pg.test','authoring-pause.pg.test','m4-pipeline.pg.test','worker-runtime-pipeline-seams.pg.integration.test'];
if(mode==='source-before'||mode==='source-after'){
 const entries=[];const walk=dir=>{for(const item of readdirSync(dir,{withFileTypes:true})){const file=join(dir,item.name);if(item.isDirectory())walk(file);else if(item.isFile())entries.push({path:relative(root,file).replaceAll('\\','/'),sha256:sha(readFileSync(file))});}};
 for(const dir of ['apps/api/src','apps/api/dist','apps/worker/src','apps/worker/dist','apps/web/src','apps/web/dist','apps/web/tests','packages/contracts/src','packages/contracts/dist','db/migrations'])walk(resolve(root,dir));
 entries.sort((a,b)=>a.path.localeCompare(b.path));
 if(mode==='source-before'&&existsSync(join(local,'source-before.json'))){let n=1;while(existsSync(join(local,`source-before-${n}.json`)))n++;write(`source-before-${n}.json`,readFileSync(join(local,'source-before.json'),'utf8'));if(existsSync(join(local,'verification-freeze.json')))write(`verification-freeze-${n}.json`,readFileSync(join(local,'verification-freeze.json'),'utf8'));}
 write(`${mode}.json`,entries);
 if(mode==='source-before')write('verification-freeze.json',{created_at:new Date().toISOString(),source_before_sha256:sha(readFileSync(join(local,'source-before.json'))),files:entries.length});
 if(mode==='source-after')assert.deepEqual(entries,JSON.parse(readFileSync(join(local,'source-before.json'),'utf8')),'Source/build changed during verification');
 console.log(`${mode}: ${entries.length} source/build files hashed`);
}else if(mode==='database-final'){
 const pool=new Pool({connectionString:template});try{
  const result={server_version:(await pool.query('SHOW server_version')).rows[0].server_version,
   schema:(await pool.query('SELECT filename FROM bb_schema_migrations ORDER BY filename DESC LIMIT 2')).rows,
   runs:(await pool.query('SELECT count(*)::int n FROM bb_runs')).rows[0].n,
   executions:(await pool.query('SELECT count(*)::int n FROM bb_run_execution_versions')).rows[0].n,
   clones:(await pool.query("SELECT datname FROM pg_database WHERE datname LIKE 'bb_g03_template_20261026_t%' ORDER BY datname")).rows};
  write('database-final.json',result);assert.equal(result.runs,0);assert.equal(result.executions,0);assert.equal(result.clones.length,0);console.log(JSON.stringify(result,null,2));
 }finally{await pool.end();}
}else{
 let number=0;while(existsSync(join(local,`${mode}${number?'-'+number:''}.log`)))number++;
 const suffix=number?'-'+number:'';let args,cwd=root,vite;
 if(mode==='migrate'){env.DATABASE_URL=template;args=['db/migrate.mjs'];}
 else if(mode==='contracts-build'||mode==='api-build'||mode==='worker-build')args=[resolve(root,'node_modules/typescript/bin/tsc'),'-p',mode==='contracts-build'?'packages/contracts/tsconfig.json':`apps/${mode.split('-')[0]}/tsconfig.json`];
 else if(mode==='web-tsc')args=[resolve(root,'node_modules/typescript/bin/tsc'),'--noEmit','-p','apps/web/tsconfig.json'];
 else if(mode==='web-build'){cwd=resolve(root,'apps/web');args=[resolve(root,'node_modules/vite/bin/vite.js'),'build'];}
 else if(mode==='contracts-check')args=['packages/contracts/dist/check-examples.js'];
 else if(mode==='api-test'||mode==='worker-test')args=['--test','--test-concurrency=1',...(mode==='api-test'?['--test-skip-pattern=^#79 (?:NDJSON sink cannot be split by log injection|file sink repeat and concurrent processes retain one durable line per key|replay of a complete pre-existing line still acknowledges only after file sync|size cap fails closed for new keys but permits replay of a full segment|replay also detects a key in a legacy rotated segment)$']:[]),...(mode==='api-test'?apiTests:workerTests).map(name=>`apps/${mode.split('-')[0]}/dist/${name}.js`)];
 else if(mode==='working-files-test')args=['--test','apps/api/dist/run-working-files.pg.test.js'];
 else if(mode==='readable-retention-test')args=['--test','apps/api/dist/review-readable-retention.pg.test.js'];
 else if(mode==='saved-work-test')args=['--test','apps/api/dist/run-supplement-work.pg.test.js'];
 else if(mode==='retention-test')args=['--test','apps/api/dist/run-supplement-work-retention.pg.test.js'];
 else if(mode==='loader-pg-test')args=['--test','apps/worker/dist/execution-input-loaders.pg.test.js'];
 else if(['browser-real','browser-ui','inflight-test'].includes(mode)){
  cwd=resolve(root,'apps/web');
  if(mode==='browser-ui'){
   env.BB_E2E_BASE_URL='http://127.0.0.1:5199';
   vite=spawn(process.execPath,[resolve(root,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port','5199','--strictPort'],{cwd,env,stdio:'ignore',windowsHide:true});
   let ready=false;
   for(let attempt=0;attempt<80;attempt++){
    if(vite.exitCode!==null)throw new Error('Dedicated Vite exited before testing');
    try{const response=await fetch(env.BB_E2E_BASE_URL);if(response.ok){ready=true;break;}}catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
   }
   if(!ready){vite.kill();throw new Error('Dedicated Vite did not start');}
  }
  env.BB_SUPPLEMENT_REAL_EVIDENCE_DIR=join(local,`${mode}-evidence${suffix}`);
  env.BB_SUPPLEMENT_EVIDENCE_DIR=join(local,`${mode}-evidence${suffix}`);
  env.PLAYWRIGHT_JSON_OUTPUT_FILE=join(local,`${mode}-report${suffix}.json`);
  const spec=mode==='browser-real'?'run-supplement-real-main.spec.ts':mode==='browser-ui'?'run-supplement-draft.spec.ts':'run-supplement-inflight-main.spec.ts';
  args=[resolve(root,'node_modules/@playwright/test/cli.js'),'test','--config','playwright.config.ts',spec,'--workers','1','--output',join(local,`${mode}-results${suffix}`),'--reporter=line,json'];
 }else throw new Error('Unknown mode');
 const started=new Date().toISOString();let result;
 try{result=spawnSync(process.execPath,args,{cwd,env,encoding:'utf8',windowsHide:true,maxBuffer:64*1024*1024});}finally{vite?.kill();}
 const output=(result.stdout??'')+(result.stderr??'');write(`${mode}${suffix}.log`,output);write(`${mode}${suffix}.json`,{started,finished:new Date().toISOString(),args,cwd,status:result.status,error:result.error?.message});
 process.stdout.write(output);if(result.error)throw result.error;process.exitCode=result.status??1;
}
