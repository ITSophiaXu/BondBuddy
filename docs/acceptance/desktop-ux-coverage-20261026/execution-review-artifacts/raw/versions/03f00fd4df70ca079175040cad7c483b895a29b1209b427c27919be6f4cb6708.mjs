import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync, writeSync} from 'node:fs';
import {createServer} from 'node:net';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// Run from any cwd: node <this file> <mode> [source-before run id].
// Every invocation and command gets new, exclusively-created evidence files.
const local=dirname(fileURLToPath(import.meta.url)), root=resolve(local,'../..');
const cluster=resolve(root,'.local/report-postgres/data');
const bin=resolve(root,'../.m3-test-tools/node_modules/@embedded-postgres/windows-x64/native/bin');
const port=15540, user='bb_report_test', database='bb_execution_report_template_20261027';
const template=`postgresql://${user}@127.0.0.1:${port}/${database}`;
const maintenance=`postgresql://${user}@127.0.0.1:${port}/postgres`;
const modes=['initdb','pg-start-direct','pg-recover-direct','database-create','database-reset','migrate','build','contracts-build','api-build','worker-build','web-typecheck','web-test-build','contracts-check','web-cache','browser-editor','api-editor-migration','api-registry','api-report','api-artifact-probe','api-regression','worker-report','worker-regression','source-before','source-after','database-audit','pg-stop'];
const mode=process.argv[2];
assert(modes.includes(mode),`Choose: ${modes.join(', ')}`);
assert.equal(resolve(local),resolve(root,'.local/execution-review-artifacts-20261027'));

const env={...process.env};
const scrub=/^(BB_|AZURE_|BONDBUDDY_|PG|DATABASE_URL$|CODEX_HOME$|NODE_OPTIONS$|DOTENV_CONFIG_|OPENAI_|DEEPSEEK_|ANTHROPIC_|GEMINI_|GOOGLE_|AWS_|COHERE_|MISTRAL_|OLLAMA_)|PROVIDER|API_KEY|ACCESS_TOKEN|SECRET|PASSWORD|CREDENTIAL|MODEL|ENDPOINT|BASE_URL|CONNECTION_STRING/i;
for(const key of Object.keys(env))if(scrub.test(key)){delete env[key];delete process.env[key];}
const python='C:/Users/lezhai/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
Object.assign(env,{BB_TEST_DATABASE_URL:template,BONDBUDDY_TEST_PYTHON:python,BONDBUDDY_WORD_PYTHON:python});
// Import after cleaning the current process too: pg can consult process.env.
const {Pool}=await import('pg');
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const id=`${stamp}-${mode}-${process.pid}-${randomUUID().slice(0,8)}`;
const runs=join(local,'runs'), run=join(runs,id);
mkdirSync(run,{recursive:true});
const browserOrigin='http://127.0.0.1:15541',browserEvidence=join(run,'browser-editor');
if(mode==='browser-editor'){
  Object.assign(env,{BB_E2E_BASE_URL:browserOrigin,BB_EDITOR_BROWSER_EVIDENCE_DIR:browserEvidence});
  delete env.BB_TEST_DATABASE_URL;
}
const logPath=join(run,'run.log'), log=openSync(logPath,'wx');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const scriptBytes=readFileSync(fileURLToPath(import.meta.url)),scriptSha=sha(scriptBytes);
const versions=join(local,'versions'),versionPath=join(versions,scriptSha+'.mjs');
mkdirSync(versions,{recursive:true});
if(existsSync(versionPath))assert(readFileSync(versionPath).equals(scriptBytes),'Preserved verifier version changed');
else writeFileSync(versionPath,scriptBytes,{flag:'wx'});
const save=(name,value)=>writeFileSync(join(run,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const canonical=path=>realpathSync(path).replaceAll('\\','/').toLowerCase();
const note=value=>writeSync(log,`${typeof value==='string'?value:JSON.stringify(value)}\n`);
const safeEnvironment={BB_TEST_DATABASE_URL:mode==='browser-editor'?null:template,BONDBUDDY_TEST_PYTHON:python,BONDBUDDY_WORD_PYTHON:python,PGOPTIONS:null,BB_RUN_RUNTIME_ENABLED:null,
  ...(mode==='browser-editor'?{BB_E2E_BASE_URL:browserOrigin,BB_EDITOR_BROWSER_EVIDENCE_DIR:browserEvidence}: {})};
save('start.json',{id,mode,started:new Date().toISOString(),cwd:root,cluster,port,user,database,script_sha256:scriptSha,script_version:relative(local,versionPath).replaceAll('\\','/'),environment:safeEnvironment});
let commandNumber=0;

async function command(exe,args,{check=true}={}){
  const number=++commandNumber, started=new Date().toISOString();
  save(`command-${number}-start.json`,{started,exe,args,cwd:root});
  const result=await new Promise((done,reject)=>{
    const child=spawn(exe,args,{cwd:root,env,windowsHide:true,stdio:['ignore',log,log]});
    child.once('error',reject);
    child.once('close',(status,signal)=>done({status,signal,pid:child.pid??null}));
  });
  save(`command-${number}-result.json`,{started,finished:new Date().toISOString(),exe,args,...result});
  if(check)assert.equal(result.status,0,`${exe} exited ${result.status}; see ${logPath}`);
  return result;
}

function previous(wanted,status=0){
  const wantedModes=Array.isArray(wanted)?wanted:[wanted];
  for(const name of readdirSync(runs).sort().reverse()){
    if(name===id)continue;
    const directory=join(runs,name), resultPath=join(directory,'result.json');
    if(!existsSync(resultPath))continue;
    const result=JSON.parse(readFileSync(resultPath,'utf8'));
    if(wantedModes.includes(result.mode)&&result.status===status)return {name,directory,result};
  }
  throw Error(`No ${wantedModes.join('/')} invocation with status ${status} in this new evidence directory`);
}

function directPid(expectedPid){
  assert(Number.isInteger(expectedPid)&&expectedPid>0,'Recorded direct child PID is invalid');
  const pidFile=readFileSync(join(cluster,'postmaster.pid'),'utf8').split(/\r?\n/);
  const pid=Number(pidFile[0]);
  assert.equal(canonical(pidFile[1]),canonical(cluster),'PID file belongs to another data directory');
  assert.equal(Number(pidFile[3]),port,'PID file belongs to another port');
  assert.equal(pid,expectedPid,'Postmaster PID does not match recorded direct child');
  return pid;
}

async function identity(pool,expectedPid){
  const info=(await pool.query(`SELECT current_setting('data_directory') AS data_directory,
    current_setting('port')::int AS port,current_setting('server_version') AS server_version,
    current_user AS server_user,pg_postmaster_start_time() AS server_started_at`)).rows[0];
  assert.equal(canonical(info.data_directory),canonical(cluster),'Wrong PostgreSQL data directory');
  assert.equal(info.port,port,'Wrong PostgreSQL port');assert.equal(info.server_user,user,'Wrong PostgreSQL user');
  assert.match(info.server_version,/^16\./,'Requires dedicated PostgreSQL 16');
  const pid=directPid(expectedPid);
  return {...info,server_started_at:info.server_started_at.toISOString(),pid};
}

async function withServer(work,url=maintenance){
  const started=previous(['pg-start-direct','pg-recover-direct']).result.server;
  const pool=new Pool({connectionString:url,connectionTimeoutMillis:5000,max:1});
  try{
    const server=await identity(pool,started.pid);
    assert.equal(server.server_started_at,started.server_started_at,'Postmaster restarted since recorded launch');
    return await work(pool,server);
  }finally{await pool.end();}
}

async function audit(){
  return withServer(async(pool,server)=>{
    const tables=['bb_users','bb_projects','bb_input_revisions','bb_platform_principals','bb_runs','bb_jobs','bb_run_events','bb_run_execution_versions',
      'bb_review_execution_artifacts','bb_review_artifacts','bb_review_execution_snapshots','bb_m4_execution_snapshots','bb_artifact_versions',
      'bb_artifact_execution_bindings','bb_word_delivery_evidence','bb_run_execution_deliveries',
      'bb_run_execution_delivery_artifacts','bb_review_executions','bb_review_editors','bb_review_execution_editors','bb_review_reports','bb_review_execution_reports'];
    const counts={};
    for(const table of tables)counts[table]=(await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
    const migrations=(await pool.query('SELECT filename FROM bb_schema_migrations ORDER BY filename')).rows.map(row=>row.filename);
    const expectedMigrations=readdirSync(join(root,'db/migrations')).filter(name=>/^\d+.*\.sql$/.test(name)).sort();
    const clones=(await pool.query("SELECT datname FROM pg_database WHERE datname NOT IN ('postgres','template0','template1',$1) ORDER BY datname",[database])).rows;
    const other_clients=(await pool.query("SELECT pid,datname,application_name FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid() ORDER BY pid")).rows;
    const seedMigration='db/migrations/0027_m1_platform_probe.sql';
    const platform_seed={migration:seedMigration,migration_sha256:sha(readFileSync(resolve(root,seedMigration))),
      applied_at:(await pool.query('SELECT applied_at FROM bb_schema_migrations WHERE filename=$1',['0027_m1_platform_probe.sql'])).rows[0]?.applied_at?.toISOString(),rows:{}};
    for(const table of ['bb_users','bb_projects','bb_input_revisions','bb_platform_principals']){
      platform_seed.rows[table]=(await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t`)).rows.map(entry=>entry.row);
    }
    const result={server,database,counts,migrations,clones,other_clients,platform_seed};
    save('database-audit.json',result);
    assert.deepEqual(migrations,expectedMigrations,'Migration replay incomplete');
    assert.equal(platform_seed.migration_sha256,'1cfd11c047e3dbee3328ba9caabd5fca7e55f208cb278c6ce85f8d1126e772d0','Only the original 0027 migration seed is allowed');
    const expectedSeed={
      bb_users:{id:'bb-platform-probe',username:'bb_platform_probe',status:'disabled',phone_e164:null,closed_at:null},
      bb_projects:{id:'bb-platform-probe-project',owner_user_id:'bb-platform-probe',name:'Platform model probe (synthetic)',kind:'platform_probe',
        issuer_name:null,market:null,offering:null,draft_revision:1,latest_input_revision:1,deleted_at:null,event_cursor:0,
        update_details:{},archived_at:null,execution_scope_project_id:null},
      bb_input_revisions:{project_id:'bb-platform-probe-project',revision:1,owner_user_id:'bb-platform-probe',draft_revision:1,
        input_hash:'b25e3c7c3362dd95e7d063b8d7ad0a53ab00d3452de0127d06a0422761ab8cab',
        manifest:{synthetic:true,purpose:'platform_probe',user_data:false},material_versions:[],requirement_message_ids:[],
        rule_pack_version:null,template_version:null,reference_release:null},
      bb_platform_principals:{user_id:'bb-platform-probe',purpose:'platform_probe',project_id:'bb-platform-probe-project',input_revision:1},
    };
    assert(Number.isFinite(Date.parse(platform_seed.applied_at)),'Original seed migration timestamp missing');
    for(const [table,expected] of Object.entries(expectedSeed)){
      assert.equal(platform_seed.rows[table].length,1,`${table} must contain exactly its migration seed`);
      const row={...platform_seed.rows[table][0]};
      for(const key of ['created_at',...(table==='bb_projects'?['updated_at']:[])]){
        assert.equal(Date.parse(row[key]),Date.parse(platform_seed.applied_at),`${table}.${key} must equal the 0027 migration transaction time`);delete row[key];
      }
      assert.deepEqual(row,expected,`${table} must exactly match the original migration seed`);
    }
    for(const [table,count] of Object.entries(counts))assert.equal(count,table in expectedSeed?1:0,`${table}: no user-test business rows may remain`);
    assert.equal(clones.length,0,'Unexpected test clone or database remains');
    assert.equal(other_clients.length,0,'Other database clients remain');
    return result;
  },template);
}

async function main(){
  if(mode==='initdb'){
    assert(!existsSync(cluster),'Never initialize or overwrite an existing cluster');
    mkdirSync(dirname(cluster),{recursive:true});
    await command(join(bin,'initdb.exe'),['-D',cluster,`--username=${user}`,'--auth=trust','--encoding=UTF8','--locale=C']);
    return {cluster};
  }
  if(mode==='pg-start-direct'){
    assert(existsSync(join(cluster,'PG_VERSION')),'Initialize this dedicated cluster first');
    assert(!existsSync(join(cluster,'postmaster.pid')),'Refuse to touch a running cluster');
    assert.equal((await command(join(bin,'pg_ctl.exe'),['-D',cluster,'status'],{check:false})).status,3);
    await new Promise((done,reject)=>{
      const probe=createServer();probe.once('error',reject);probe.listen(port,'127.0.0.1',()=>probe.close(error=>error?reject(error):done()));
    });
    const out=openSync(join(run,'postgres-stdout.log'),'wx'), err=openSync(join(run,'postgres-stderr.log'),'wx');
    let child;
    try{
      child=spawn(join(bin,'postgres.exe'),['-D',cluster,'-h','127.0.0.1','-p',String(port)],{cwd:root,env,windowsHide:true,detached:true,stdio:['ignore',out,err]});
      await new Promise((done,reject)=>{child.once('spawn',done);child.once('error',reject);});
      save('direct-child.json',{pid:child.pid,cluster,port,spawned_at:new Date().toISOString()});
      child.unref();
    }finally{closeSync(out);closeSync(err);}
    for(let attempt=0;attempt<10;attempt++){
      assert.equal(child.exitCode,null,`PostgreSQL exited ${child.exitCode}`);
      const pool=new Pool({connectionString:maintenance,connectionTimeoutMillis:5000,max:1});
      try{
        try{await pool.query('SELECT 1');}catch(error){if(attempt===9)throw error;continue;}
        const server=await identity(pool,child.pid);note(server);return {server};
      }finally{await pool.end();await new Promise(done=>setTimeout(done,100));}
    }
    throw Error('Dedicated PostgreSQL readiness timeout; direct-child.json records its exact PID');
  }
  if(mode==='pg-recover-direct'){
    const failed=previous('pg-start-direct',1);
    const childBytes=readFileSync(join(failed.directory,'direct-child.json'));
    const child=JSON.parse(childBytes);
    assert.equal(canonical(child.cluster),canonical(cluster),'Failed launch recorded a different cluster');
    assert.equal(child.port,port,'Failed launch recorded a different port');
    directPid(child.pid);
    save('recovery-source.json',{failed_run:failed.name,direct_child_sha256:sha(childBytes),pid:child.pid,cluster,port});
    const pool=new Pool({connectionString:maintenance,connectionTimeoutMillis:10000,max:1});
    try{
      await pool.query('SELECT 1');
      const server=await identity(pool,child.pid);
      note(server);return {server,recovered_from:failed.name};
    }finally{await pool.end();}
  }
  if(mode==='database-create')return withServer(async pool=>{
    assert.equal((await pool.query('SELECT 1 FROM pg_database WHERE datname=$1',[database])).rowCount,0,'Never overwrite a database');
    await pool.query(`CREATE DATABASE ${database}`);return {database,created:true};
  });
  if(mode==='database-reset'){
    // Only this verifier's original, seed-only disposable template may be rebuilt.
    const original=previous('database-create');
    assert.equal(original.result.database,database);
    const database_audit=await audit();
    return withServer(async pool=>{
      await pool.query(`DROP DATABASE ${database}`);
      await pool.query(`CREATE DATABASE ${database}`);
      return {database,reset:true,original_creation:original.name,database_audit};
    });
  }
  if(mode==='source-before'||mode==='source-after'){
    const entries=[];
    function walk(directory){
      assert(existsSync(directory),`Required source directory missing: ${directory}`);
      for(const item of readdirSync(directory,{withFileTypes:true})){
        const path=join(directory,item.name);
        assert(!item.isSymbolicLink(),`Source freeze cannot skip symlink: ${path}`);
        if(item.isDirectory()&&item.name==='__pycache__')continue;
        if(item.isDirectory())walk(path);
        else if(item.isFile()){const bytes=readFileSync(path);entries.push({path:relative(root,path).replaceAll('\\','/'),bytes:bytes.length,sha256:sha(bytes)});}
      }
    }
    const roots=['apps/api/src','apps/api/dist','apps/worker/src','apps/worker/dist','apps/web/src','apps/web/tests',
      'packages/contracts/src','packages/contracts/dist','packages/contracts/examples','apps/web/dist-test','db/migrations','python'];
    for(const directory of roots)walk(resolve(root,directory));
    for(const file of ['package.json','package-lock.json','apps/api/package.json','apps/api/tsconfig.json',
      'apps/worker/package.json','apps/worker/tsconfig.json','apps/web/package.json','apps/web/tsconfig.json','apps/web/tsconfig.test.json',
      'packages/contracts/package.json','packages/contracts/tsconfig.json','db/migrate.mjs',
      '.local/execution-review-artifacts-20261027/verify.mjs','.local/execution-review-artifacts-20261027/playwright.config.mjs']){
      const bytes=readFileSync(resolve(root,file));entries.push({path:file,bytes:bytes.length,sha256:sha(bytes)});
    }
    entries.sort((a,b)=>a.path.localeCompare(b.path));save('snapshot.json',entries);
    const snapshot={files:entries.length,sha256:sha(readFileSync(join(run,'snapshot.json'))),roots};
    if(mode==='source-after'){
      const requested=process.argv[3];
      if(requested)assert.match(requested,/^[A-Za-z0-9-]+$/,'Use a source-before run id only');
      const before=requested?{name:requested,directory:join(runs,requested)}:previous('source-before');
      const receipt=JSON.parse(readFileSync(join(before.directory,'result.json'),'utf8'));
      assert.equal(receipt.mode,'source-before');assert.equal(receipt.status,0);
      const bytes=readFileSync(join(before.directory,'snapshot.json'));
      assert.equal(sha(bytes),receipt.snapshot.sha256,'Baseline snapshot changed');
      save('comparison.json',{before:before.name,after:id,before_sha256:sha(bytes),after_sha256:snapshot.sha256});
      assert.deepEqual(entries,JSON.parse(bytes),'Source/build changed during this verification pair');
      snapshot.before=before.name;
    }
    note(snapshot);return {snapshot};
  }
  if(mode==='database-audit'||mode==='pg-stop'){
    const database_audit=await audit();
    if(mode==='pg-stop'){
      // No clients remain after audit's own pool closes. Recheck exact identity immediately before stop.
      await withServer(async(pool)=>{
        assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid()")).rows[0].n,0);
      });
      await command(join(bin,'pg_ctl.exe'),['-D',cluster,'-w','stop','-m','fast']);
      assert.equal((await command(join(bin,'pg_ctl.exe'),['-D',cluster,'status'],{check:false})).status,3);
      assert(!existsSync(join(cluster,'postmaster.pid')),'Postmaster PID file remains');
    }
    return {database_audit,stopped:mode==='pg-stop'};
  }
  if(mode==='browser-editor'){
    const config=join(local,'playwright.config.mjs'),configBytes=readFileSync(config),configSha=sha(configBytes);
    const configVersion=join(versions,configSha+'.playwright.config.mjs');
    if(existsSync(configVersion))assert(readFileSync(configVersion).equals(configBytes),'Preserved browser config version changed');
    else writeFileSync(configVersion,configBytes,{flag:'wx'});
    mkdirSync(browserEvidence,{recursive:false});
    const browser={origin:browserOrigin,project:'desktop-chromium',config:relative(root,config).replaceAll('\\','/'),
      config_sha256:configSha,config_version:relative(local,configVersion).replaceAll('\\','/'),
      evidence:relative(local,browserEvidence).replaceAll('\\','/'),
      specs:['apps/web/tests/review-editor.spec.ts','apps/web/tests/review-editor-recovery.spec.ts']};
    save('browser-editor.json',browser);
    await command(process.execPath,[resolve(root,'node_modules/@playwright/test/cli.js'),'test','--config',config,
      'review-editor.spec.ts','review-editor-recovery.spec.ts','--project=desktop-chromium']);
    return {commands:1,browser};
  }
  const tsc=resolve(root,'node_modules/typescript/bin/tsc');
  const commands={
    'build':[[tsc,'-p','packages/contracts/tsconfig.json'],[tsc,'-p','apps/api/tsconfig.json'],
      [tsc,'-p','apps/worker/tsconfig.json'],[tsc,'-p','apps/web/tsconfig.json','--noEmit']],
    'contracts-build':[[tsc,'-p','packages/contracts/tsconfig.json']],
    'api-build':[[tsc,'-p','apps/api/tsconfig.json']],
    'worker-build':[[tsc,'-p','apps/worker/tsconfig.json']],
    'web-typecheck':[[tsc,'-p','apps/web/tsconfig.json','--noEmit']],
    'web-test-build':[[tsc,'-p','apps/web/tsconfig.test.json']],
    'contracts-check':[['packages/contracts/dist/check-examples.js'],['packages/contracts/dist/check-data-lifecycle.js'],
      ['--test','packages/contracts/dist/ocr-v2.test.js','packages/contracts/dist/generation-issuer-binding.test.js']],
    'web-cache':[[tsc,'-p','apps/web/tsconfig.test.json'],['--test','apps/web/dist-test/review-editor-cache.test.js',
      'apps/web/dist-test/review-editor-execution-cache.test.js']],
    'api-editor-migration':[['--test','--test-concurrency=1','apps/api/dist/review-editor-execution-migration.pg.test.js']],
    'api-registry':[['--test','--test-concurrency=1','apps/api/dist/review-artifact-execution.pg.test.js']],
    'api-report':[['--test','--test-concurrency=1','apps/api/dist/review-report-execution.pg.test.js']],
    'api-artifact-probe':[['--test','--test-name-pattern=bindings reject foreign ownership','apps/api/dist/artifact-execution.pg.test.js']],
    'api-regression':[['--test','--test-concurrency=1','apps/api/dist/run-supplement-files.pg.test.js',
      'apps/api/dist/review-workspace.test.js','apps/api/dist/review-linked-workspace.test.js',
      'apps/api/dist/review-price-activation.pg.test.js','apps/api/dist/review-readable-retention.pg.test.js','apps/api/dist/run-execution-business-snapshots.pg.test.js',
      'apps/api/dist/artifact-execution.pg.test.js','apps/api/dist/run-execution-delivery.pg.test.js']],
    'worker-report':[['--test','--test-concurrency=1','apps/worker/dist/review-report-execution.pg.test.js','apps/worker/dist/review-word-registration.pg.integration.test.js']],
    'worker-regression':[['--test','--test-concurrency=1','apps/worker/dist/review-word-registration.pg.integration.test.js',
      'apps/worker/dist/review-input-execution.test.js','apps/worker/dist/review-file-stage.test.js',
      'apps/worker/dist/run-execution-consumers.pg.test.js','apps/worker/dist/review-assistant.test.js','apps/worker/dist/review-reassembly.test.js']],
  };
  if(mode==='migrate'){
    await withServer(async()=>{});env.DATABASE_URL=template;
    await command(process.execPath,['db/migrate.mjs']);return {migrated:database};
  }
  if((mode.startsWith('api-')&&mode!=='api-build')||(mode.startsWith('worker-')&&mode!=='worker-build'))await withServer(async()=>{});
  assert(commands[mode],`Unimplemented mode: ${mode}`);
  for(const args of commands[mode])await command(process.execPath,args);
  return {commands:commands[mode].length};
}

try{
  const result=await main();
  save('result.json',{id,mode,status:0,finished:new Date().toISOString(),...result});
  process.stdout.write(`${mode}: passed; evidence ${run}\n`);
}catch(error){
  const failure={name:error?.name??'Error',message:String(error?.message??error)};
  save('result.json',{id,mode,status:1,finished:new Date().toISOString(),error:failure});
  note(failure);process.stderr.write(`${mode}: failed; ${failure.message}\nEvidence: ${run}\n`);process.exitCode=1;
}finally{closeSync(log);}
