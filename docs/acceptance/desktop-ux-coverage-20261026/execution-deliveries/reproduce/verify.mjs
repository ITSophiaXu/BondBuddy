import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,openSync,closeSync,readFileSync,readdirSync,realpathSync,writeFileSync} from 'node:fs';
import {join,relative,resolve} from 'node:path';
import {Pool} from 'pg';

const root=process.cwd(),local=resolve(root,'.local/execution-deliveries-20261027');
mkdirSync(local,{recursive:true});
const template='postgresql://bb_delivery_test@127.0.0.1:15528/bb_execution_delivery_template_20261027d';
const cluster=resolve(root,'.local/delivery-postgres/data');
const pgCtl='C:/Users/lezhai/Downloads/Bondbuddy/.m3-test-tools/node_modules/@embedded-postgres/windows-x64/native/bin/pg_ctl.exe';
const env={...process.env};
for(const key of Object.keys(env))if(/^(BB_|DATABASE_URL$|PGOPTIONS$|AZURE_|DEEPSEEK_|OPENAI_|CODEX_HOME$)/i.test(key))delete env[key];
Object.assign(env,{BB_TEST_DATABASE_URL:template,
  BONDBUDDY_TEST_PYTHON:'C:/Users/lezhai/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe',
  BONDBUDDY_WORD_PYTHON:'C:/Users/lezhai/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'});
const mode=process.argv[2],sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const write=(name,value)=>writeFileSync(join(local,name),typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');
const freshName=name=>{let i=0;while(existsSync(join(local,`${name}${i?'-'+i:''}.json`)))i++;return `${name}${i?'-'+i:''}`;};
if(mode==='database-create'){
  const maintenance=new URL(template);maintenance.pathname='/postgres';
  const pool=new Pool({connectionString:maintenance.toString(),connectionTimeoutMillis:5000});
  try{
    const directory=(await pool.query('SHOW data_directory')).rows[0].data_directory;assert.equal(realpathSync(directory),realpathSync(cluster));
    assert.equal((await pool.query('SELECT 1 FROM pg_database WHERE datname=$1',['bb_execution_delivery_template_20261027d'])).rowCount,0,'Never overwrite an existing template');
    await pool.query('CREATE DATABASE bb_execution_delivery_template_20261027d');
    write(`${freshName(mode)}.json`,{created_at:new Date().toISOString(),database:'bb_execution_delivery_template_20261027d',cluster});
  }finally{await pool.end();}
  console.log('Created a fresh empty dedicated template for final migration replay');
}else if(mode==='pg-start-direct'){
  const before=spawnSync(pgCtl,['-D',cluster,'status'],{env,encoding:'utf8',windowsHide:true});assert.equal(before.status,3);assert.equal(existsSync(join(cluster,'postmaster.pid')),false);
  const stdout=openSync(join(local,'postgres-direct-stdout.log'),'a'),stderr=openSync(join(local,'postgres-direct-stderr.log'),'a');
  const started=new Date().toISOString(),child=spawn(pgCtl.replace(/pg_ctl\.exe$/,'postgres.exe'),['-D',cluster,'-h','127.0.0.1','-p','15528'],{cwd:root,env,windowsHide:true,detached:true,stdio:['ignore',stdout,stderr]});
  child.unref();closeSync(stdout);closeSync(stderr);
  let ready=false;
  for(let n=0;n<100;n++){
    if(child.exitCode!==null)throw Error(`PostgreSQL exited ${child.exitCode}`);
    const readiness=new URL(template);readiness.pathname='/postgres';const pool=new Pool({connectionString:readiness.toString(),connectionTimeoutMillis:300});
    try{const directory=(await pool.query('SHOW data_directory')).rows[0].data_directory;assert.equal(realpathSync(directory),realpathSync(cluster));ready=true;break;}catch{}finally{await pool.end();}
    await new Promise(done=>setTimeout(done,100));
  }
  assert(ready);const postmasterPid=Number(readFileSync(join(cluster,'postmaster.pid'),'utf8').split(/\r?\n/)[0]);assert.equal(postmasterPid,child.pid);
  write(`${freshName(mode)}.json`,{started,ready_at:new Date().toISOString(),pid:child.pid,postmaster_pid:postmasterPid,cluster});console.log(`Dedicated PostgreSQL ready, PID ${child.pid}`);
}else if(mode==='source-before'||mode==='source-after'){
  const entries=[];
  const walk=dir=>{for(const item of readdirSync(dir,{withFileTypes:true})){const file=join(dir,item.name);if(item.isDirectory())walk(file);else if(item.isFile())entries.push({path:relative(root,file).replaceAll('\\','/'),sha256:sha(readFileSync(file))});}};
  for(const dir of ['apps/api/src','apps/api/dist','apps/worker/src','apps/worker/dist','packages/contracts/src','packages/contracts/dist','db/migrations'])walk(resolve(root,dir));
  for(const file of ['apps/api/package.json','apps/worker/package.json'])entries.push({path:file,sha256:sha(readFileSync(resolve(root,file)))});
  entries.sort((a,b)=>a.path.localeCompare(b.path));
  const name=freshName(mode);
  write(`${name}.json`,entries);
  if(mode==='source-before')write('current-freeze.json',{name,created_at:new Date().toISOString(),sha256:sha(readFileSync(join(local,`${name}.json`))),files:entries.length});
  else {const freeze=JSON.parse(readFileSync(join(local,'current-freeze.json'),'utf8'));assert.deepEqual(entries,JSON.parse(readFileSync(join(local,`${freeze.name}.json`),'utf8')));}
  console.log(`${name}: ${entries.length} source/build files hashed`);
}else if(mode==='database-audit'||mode==='pg-stop'){
  const pool=new Pool({connectionString:template});let audit;
  const sibling_templates=[];
  for(const suffix of ['', 'b', 'c']){
    const name='bb_execution_delivery_template_20261027'+suffix, sibling=new Pool({connectionString:'postgresql://bb_delivery_test@127.0.0.1:15528/'+name});
    try{const counts=(await sibling.query('SELECT (SELECT count(*)::int FROM bb_runs) AS runs,(SELECT count(*)::int FROM bb_artifact_versions) AS artifacts,(SELECT count(*)::int FROM bb_run_execution_deliveries) AS deliveries,(SELECT count(*)::int FROM bb_run_execution_delivery_artifacts) AS members')).rows[0];for(const value of Object.values(counts))assert.equal(value,0,name);sibling_templates.push({database:name,...counts});}finally{await sibling.end();}
  }
  try{
    audit={sibling_templates,server_version:(await pool.query('SHOW server_version')).rows[0].server_version,server_port:(await pool.query('SHOW port')).rows[0].port,data_directory:(await pool.query('SHOW data_directory')).rows[0].data_directory,
      schema:(await pool.query('SELECT filename FROM bb_schema_migrations ORDER BY filename DESC LIMIT 3')).rows,
      runs:(await pool.query('SELECT count(*)::int n FROM bb_runs')).rows[0].n,
      executions:(await pool.query('SELECT count(*)::int n FROM bb_run_execution_versions')).rows[0].n,
      reviews:(await pool.query('SELECT count(*)::int n FROM bb_review_execution_snapshots')).rows[0].n,
      m4:(await pool.query('SELECT count(*)::int n FROM bb_m4_execution_snapshots')).rows[0].n,artifacts:(await pool.query('SELECT count(*)::int n FROM bb_artifact_versions')).rows[0].n,artifact_bindings:(await pool.query('SELECT count(*)::int n FROM bb_artifact_execution_bindings')).rows[0].n,deliveries:(await pool.query('SELECT count(*)::int n FROM bb_run_execution_deliveries')).rows[0].n,delivery_members:(await pool.query('SELECT count(*)::int n FROM bb_run_execution_delivery_artifacts')).rows[0].n,
      clones:(await pool.query("SELECT datname FROM pg_database WHERE datname LIKE 'bb_execution_delivery_template_20261027%_t%' ORDER BY datname")).rows,
      other_clients:(await pool.query("SELECT datname,application_name FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid() AND datname IS NOT NULL")).rows,
      postmaster_pid:Number(readFileSync(join(cluster,'postmaster.pid'),'utf8').split(/\r?\n/)[0])};
    assert.equal(realpathSync(audit.data_directory),realpathSync(cluster));assert.equal(audit.server_port,'15528');assert.equal(audit.postmaster_pid,JSON.parse(readFileSync(join(local,'pg-start-direct.json'),'utf8')).postmaster_pid);
    for(const key of ['runs','executions','reviews','m4','artifacts','artifact_bindings','deliveries','delivery_members'])assert.equal(audit[key],0,key);
    assert.equal(audit.clones.length,0);assert.equal(audit.other_clients.length,0);
  }finally{await pool.end();}
  write(`${freshName(mode)}.json`,audit);console.log(JSON.stringify(audit,null,2));
  if(mode==='pg-stop'){
    const stopped=spawnSync(pgCtl,['-D',cluster,'-w','stop','-m','fast'],{env,encoding:'utf8',windowsHide:true});
    write('pg-stop-command.json',{status:stopped.status,stdout:stopped.stdout,stderr:stopped.stderr});assert.equal(stopped.status,0);
    const status=spawnSync(pgCtl,['-D',cluster,'status'],{env,encoding:'utf8',windowsHide:true});
    write('pg-stopped-status.json',{status:status.status,stdout:status.stdout,stderr:status.stderr});assert.equal(status.status,3);
    assert.equal(existsSync(join(cluster,'postmaster.pid')),false);
  }
}else{
  const name=freshName(mode);let exe=process.execPath,args;
  if(mode==='initdb'){exe=pgCtl.replace(/pg_ctl\.exe$/,'initdb.exe');args=['-D',cluster,'--username=bb_delivery_test','--auth=trust','--encoding=UTF8','--locale=C'];}
  else if(mode==='pg-start'){
    const before=spawnSync(pgCtl,['-D',cluster,'status'],{env,encoding:'utf8',windowsHide:true});assert.equal(before.status,3);assert.equal(existsSync(join(cluster,'postmaster.pid')),false);
    exe=pgCtl;args=['-D',cluster,'-l',join(local,'postgres-server.log'),'-w','start'];
  }else if(mode==='migrate'){env.DATABASE_URL=template;args=['db/migrate.mjs'];}
  else if(['contracts-build','api-build','worker-build'].includes(mode))args=[resolve(root,'node_modules/typescript/bin/tsc'),'-p',mode==='contracts-build'?'packages/contracts/tsconfig.json':`apps/${mode.split('-')[0]}/tsconfig.json`];
  else if(mode==='contracts-check')args=['packages/contracts/dist/check-examples.js'];
  else if(mode==='api-history-jit-diagnostic'){env.PGOPTIONS='-c jit=off';args=['--test','apps/api/dist/artifact-history.test.js'];}
  else if(mode==='api-focused')args=['--test','--test-concurrency=1','apps/api/dist/run-execution-delivery.pg.test.js','apps/api/dist/artifact-filename.test.js','apps/api/dist/artifact-execution.test.js','apps/api/dist/artifact-execution.pg.test.js','apps/api/dist/run-execution-input.test.js','apps/api/dist/run-execution.pg.integration.test.js'];
  else if(mode==='api-consumers')args=["--test","--test-concurrency=1","apps/api/dist/artifact-history.test.js","apps/api/dist/project-assistant.pg.test.js","apps/api/dist/project-collection.pg.test.js","apps/api/dist/project-list.test.js","apps/api/dist/project-file-update-history.test.js","apps/api/dist/project-file-check-history.test.js","apps/api/dist/project-file-batch-recovery.test.js","apps/api/dist/review-workspace.test.js","apps/api/dist/review-linked-workspace.test.js","apps/api/dist/review-readable.test.js","apps/api/dist/review-readable-retention.pg.test.js","apps/api/dist/m4-workspace.pg.test.js","apps/api/dist/m4-case-templates.test.js","apps/api/dist/unified-authoring.test.js","apps/api/dist/update-project.test.js","apps/api/dist/project-kind-conversion.pg.test.js"];
  else if(mode==='api-delivery')args=["--test","--test-concurrency=1","apps/api/dist/word-delivery-artifact.test.js","apps/api/dist/generated-word-delivery.test.js","apps/api/dist/queue.test.js","apps/api/dist/non-production-test.test.js","apps/api/dist/review-billing.pg.test.js","apps/api/dist/review-dynamic-balance.pg.test.js","apps/api/dist/m4-dynamic-balance.pg.test.js","apps/api/dist/m4-fixed-billing.pg.test.js","apps/api/dist/review-price-activation.pg.test.js"];
  else if(mode==='api-upload-timeout')args=["--test","--test-timeout=240000","--test-name-pattern=^(?:upload inspection rejects encryption, corrupt structures, active content, and bounded archive abuse|signed PDF risk controls remain fail-closed on both inspection paths|multipage signatures retain bytes and reject active, ambiguous or incomplete inputs|upload inspection is single-flight: extra work queues, and a bounded wait fails with a stable 503)$","apps/api/dist/upload-safety.test.js"];
  else if(mode==='api-revision-range')args=['--test','apps/api/dist/revision-range.test.js'];
  else if(mode==='api-corrective')args=['--test','--test-concurrency=1','apps/api/dist/project-assistant.pg.test.js','apps/api/dist/m4-knowledge.test.js','apps/api/dist/revision-range.test.js','apps/api/dist/working-draft-parse-admission.test.js'];
  else if(mode==='api-execution-key')args=['--test','apps/api/dist/execution-key.test.js'];
  else if(mode==='api-config-regression')args=['--test','--test-concurrency=1','apps/api/dist/execution-key.test.js','apps/api/dist/logical-job.test.js','apps/api/dist/non-production-test.test.js','apps/api/dist/preflight-difficulty.test.js'];
  else if(mode==='api-assistant-config')args=['--test','apps/api/dist/project-assistant.pg.test.js'];
  else if(mode==='api-all-stream')args=['--test','--test-timeout=60000','--test-concurrency=1','--test-skip-pattern=^#79 (?:NDJSON sink cannot be split by log injection|file sink repeat and concurrent processes retain one durable line per key|replay of a complete pre-existing line still acknowledges only after file sync|size cap fails closed for new keys but permits replay of a full segment|replay also detects a key in a legacy rotated segment)$',...readdirSync(resolve(root,'apps/api/dist')).filter(name=>name.endsWith('.test.js')).sort().map(name=>`apps/api/dist/${name}`)];
  else if(mode==='api-regression')args=['--test','--test-concurrency=1',...['run-supplement-draft.pg.test','run-supplement-input.test','run-supplement-files.pg.test','run-supplement-work.pg.test','run-working-files.pg.test','review-workspace.test','review-editor.test','review-result-lineage.test','review-readable-retention.pg.test','m4-workspace.test','m4-billing.test'].filter(name=>existsSync(resolve(root,`apps/api/dist/${name}.js`))).map(name=>`apps/api/dist/${name}.js`)];
  else if(mode==='worker-source')args=['--test','apps/worker/dist/artifact-execution-source.pg.test.js'];
  else if(mode==='worker-unit')args=['--test','--test-concurrency=1',...['review-input-execution.test','m4-input.test','m4-stages.test','unified-execution-input.test','review-file-stage.test','unified-input.test'].map(name=>`apps/worker/dist/${name}.js`)];
  else if(mode==='worker-pg')args=['--test','--test-concurrency=1',...['artifact-execution-source.pg.test','execution-input-loaders.pg.test','run-execution-consumers.pg.test','m3-review-pipeline.pg.integration.test','m4-pipeline.pg.test','unified-authoring.pg.test','authoring-pause.pg.test','review-project-e2e.pg.test','review-reassembly.test','review-word-registration.pg.integration.test'].map(name=>`apps/worker/dist/${name}.js`)];
  else throw Error(`Unknown mode ${mode}`);
  const started=new Date().toISOString(),descriptor=openSync(join(local,`${name}.log`),'wx');
  write(`${name}.json`,{started,exe,args,cwd:root,environment:{BB_RUN_RUNTIME_ENABLED:env.BB_RUN_RUNTIME_ENABLED??null,PGOPTIONS:env.PGOPTIONS??null,BB_TEST_DATABASE_URL:env.BB_TEST_DATABASE_URL},status:null,phase:'running'});
  const result=await new Promise((done,reject)=>{
    const running=spawn(exe,args,{cwd:root,env,windowsHide:true,stdio:['ignore',descriptor,descriptor]});
    closeSync(descriptor);running.once('error',reject);running.once('exit',(status,signal)=>done({status,signal,pid:running.pid}));
  });
  write(`${name}.json`,{started,finished:new Date().toISOString(),exe,args,cwd:root,environment:{BB_RUN_RUNTIME_ENABLED:env.BB_RUN_RUNTIME_ENABLED??null,PGOPTIONS:env.PGOPTIONS??null,BB_TEST_DATABASE_URL:env.BB_TEST_DATABASE_URL},...result});
  process.stdout.write(readFileSync(join(local,`${name}.log`),'utf8'));process.exitCode=result.status??1;
}
