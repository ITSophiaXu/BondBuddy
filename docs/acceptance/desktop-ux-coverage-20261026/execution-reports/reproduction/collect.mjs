import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// Collection only: no subprocess, database connection, test, deletion or overwrite.
// Run only after all verifier invocations have finished and the exact PG is stopped.
const script=fileURLToPath(import.meta.url),local=dirname(script),root=resolve(local,'../..');
const destination=resolve(root,'docs/acceptance/desktop-ux-coverage-20261026/execution-reports');
const cluster=resolve(root,'.local/report-postgres/data'),database='bb_execution_report_template_20261027';
const port=15540,user='bb_report_test',baseCommit='05f5b235fe104bcefd9d4c6e8674d21f56bd6352';
const testModes=['api-report','worker-report','api-regression','worker-regression'];
const testFiles={
  'api-report':['apps/api/dist/review-report-execution.pg.test.js'],
  'worker-report':['apps/worker/dist/review-report-execution.pg.test.js','apps/worker/dist/review-word-registration.pg.integration.test.js'],
  'api-regression':['apps/api/dist/run-supplement-files.pg.test.js','apps/api/dist/review-workspace.test.js','apps/api/dist/review-linked-workspace.test.js',
    'apps/api/dist/review-price-activation.pg.test.js','apps/api/dist/review-readable-retention.pg.test.js','apps/api/dist/run-execution-business-snapshots.pg.test.js',
    'apps/api/dist/artifact-execution.pg.test.js','apps/api/dist/run-execution-delivery.pg.test.js'],
  'worker-regression':['apps/worker/dist/review-word-registration.pg.integration.test.js','apps/worker/dist/review-input-execution.test.js',
    'apps/worker/dist/review-file-stage.test.js','apps/worker/dist/run-execution-consumers.pg.test.js','apps/worker/dist/review-assistant.test.js','apps/worker/dist/review-reassembly.test.js'],
};
const freezeRoots=['apps/api/src','apps/api/dist','apps/worker/src','apps/worker/dist','apps/web/src','apps/web/tests',
  'packages/contracts/src','packages/contracts/dist','packages/contracts/examples','apps/web/dist-test','db/migrations','python'];
const freezeExtra=['package.json','package-lock.json','apps/api/package.json','apps/api/tsconfig.json',
  'apps/worker/package.json','apps/worker/tsconfig.json','apps/web/package.json','apps/web/tsconfig.json','apps/web/tsconfig.test.json',
  'packages/contracts/package.json','packages/contracts/tsconfig.json','db/migrate.mjs',
  '.local/execution-reports-20261027/verify.mjs','.local/execution-reports-20261027/playwright.config.mjs'];
assert.equal(local,resolve(root,'.local/execution-reports-20261027'));
assert(!existsSync(destination),'Never overwrite an acceptance archive');
const slash=path=>path.replaceAll('\\','/'),normalized=path=>slash(resolve(path)).toLowerCase();
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=path=>JSON.parse(readFileSync(path,'utf8'));
const date=value=>{assert.equal(typeof value,'string');const ms=Date.parse(value);assert(Number.isFinite(ms),`Invalid timestamp ${value}`);return ms;};
const safeRelative=path=>{assert.equal(typeof path,'string');assert(path&&!isAbsolute(path)&&!path.includes('\\')&&!path.split('/').some(p=>p==='..'||p===''||p==='.')&&!path.includes(':'));return path;};
const within=(parent,path)=>{const name=relative(parent,path);assert(name&&!name.startsWith('..')&&!isAbsolute(name),`Path outside ${parent}: ${path}`);return path;};
function inventory(directory,{excludePycache=false}={}){
  const paths=[];
  function walk(current){for(const item of readdirSync(current,{withFileTypes:true})){
    const path=join(current,item.name);assert(!item.isSymbolicLink(),`Refuse symlink ${path}`);
    if(item.isDirectory()&&excludePycache&&item.name==='__pycache__')continue;
    if(item.isDirectory())walk(path);else{assert(item.isFile(),`Unsupported file ${path}`);paths.push(slash(relative(directory,path)));}
  }}
  walk(directory);return paths.sort();
}
const plan=new Map();
function copied(source,path){safeRelative(path);assert(!plan.has(path));plan.set(path,{source:slash(relative(root,source)),bytes:readFileSync(source)});}
function generated(path,value){safeRelative(path);assert(!plan.has(path));plan.set(path,{source:null,generated_by:slash(relative(root,script)),
  bytes:Buffer.from(typeof value==='string'?value:JSON.stringify(value,null,2)+'\n')});}
function metrics(raw){
  const log=raw.replace(/\x1b\[[0-9;]*m/g,''),blocks=[],errors=[];let current;
  for(const line of log.split(/\r?\n/)){
    const match=line.match(/^(?:ℹ|#)\s+(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\s+(\d+(?:\.\d+)?)\s*$/);
    if(!match)continue;
    if(match[1]==='tests'){if(current)blocks.push(current);current={};}
    if(!current){errors.push(`Summary field before tests: ${line}`);continue;}
    if(match[1] in current)errors.push(`Duplicate summary field: ${line}`);
    current[match[1]]=Number(match[2]);
  }
  if(current)blocks.push(current);
  for(const [index,block] of blocks.entries()){
    for(const key of ['tests','suites','pass','fail','cancelled','skipped','todo'])
      if(!Number.isInteger(block[key])||block[key]<0)errors.push(`Block ${index+1}: invalid/missing ${key}`);
    if(!Number.isFinite(block.duration_ms)||block.duration_ms<0)errors.push(`Block ${index+1}: invalid/missing duration_ms`);
    if(block.tests!==block.pass+block.fail+block.cancelled+block.skipped+block.todo)errors.push(`Block ${index+1}: test count does not reconcile`);
  }
  return {node_summaries:blocks,node_summary_errors:errors,counts:blocks.length===1&&errors.length===0?blocks[0]:null,
    example_lines:log.split(/\r?\n/).filter(line=>/^validated \d+ /i.test(line)),
    skipped_titles:log.split(/\r?\n/).filter(line=>line.includes('# SKIP')),aggregate:null};
}
const runs=join(local,'runs'),archiveRun=(id,path)=>`records/runs/${id}/${path}`;
const rawFiles=inventory(runs);
for(const path of rawFiles)copied(join(runs,path),`records/runs/${path}`);
const invocations=readdirSync(runs,{withFileTypes:true}).map(item=>{
  assert(item.isDirectory()&&!item.isSymbolicLink());const id=item.name,directory=join(runs,id);
  assert.match(id,/^[A-Za-z0-9-]+$/);
  for(const name of ['start.json','result.json','run.log'])assert(existsSync(join(directory,name)),`Incomplete invocation ${id}: ${name}`);
  const start=json(join(directory,'start.json')),result=json(join(directory,'result.json'));
  assert.equal(start.id,id);assert.equal(result.id,id);assert.equal(start.mode,result.mode);assert([0,1].includes(result.status));
  assert(date(start.started)<=date(result.finished));assert.equal(normalized(start.cwd),normalized(root));
  assert.equal(normalized(start.cluster),normalized(cluster));assert.equal(start.port,port);assert.equal(start.user,user);assert.equal(start.database,database);
  assert.match(start.script_sha256,/^[a-f0-9]{64}$/);assert.equal(start.script_version,`versions/${start.script_sha256}.mjs`);
  const version=within(join(local,'versions'),resolve(local,start.script_version));assert.equal(sha(readFileSync(version)),start.script_sha256);
  const names=readdirSync(directory),numbers=names.filter(name=>/^command-\d+-start\.json$/.test(name))
    .map(name=>Number(name.match(/^command-(\d+)-/)[1])).sort((a,b)=>a-b);
  assert.deepEqual(numbers,numbers.map((_,index)=>index+1),`Command sequence ${id}`);
  assert.equal(names.filter(name=>/^command-\d+-result\.json$/.test(name)).length,numbers.length,`Unpaired command result ${id}`);
  const commands=numbers.map(number=>{
    const prefix=`command-${number}`,commandStart=json(join(directory,`${prefix}-start.json`)),commandResult=json(join(directory,`${prefix}-result.json`));
    assert.equal(commandStart.started,commandResult.started);assert.equal(commandStart.exe,commandResult.exe);assert.deepEqual(commandStart.args,commandResult.args);
    assert.equal(normalized(commandStart.cwd),normalized(root));assert(Array.isArray(commandResult.args));
    assert(date(commandStart.started)>=date(start.started)&&date(commandResult.finished)>=date(commandStart.started)&&date(commandResult.finished)<=date(result.finished));
    assert(commandResult.status===null||Number.isInteger(commandResult.status));assert(commandResult.signal===null||typeof commandResult.signal==='string');
    return {start_record:archiveRun(id,`${prefix}-start.json`),record:archiveRun(id,`${prefix}-result.json`),...commandResult};
  });
  if(result.commands!==undefined)assert.equal(result.commands,commands.length);
  return {id,mode:start.mode,status:result.status,started:start.started,finished:result.finished,
    start:archiveRun(id,'start.json'),receipt:archiveRun(id,'result.json'),log:archiveRun(id,'run.log'),
    script_sha256:start.script_sha256,script_version:`reproduction/${start.script_version}`,commands,
    ...metrics(readFileSync(join(directory,'run.log'),'utf8'))};
}).sort((a,b)=>date(a.started)-date(b.started)||a.id.localeCompare(b.id));
const result=entry=>json(join(runs,entry.id,'result.json'));
const latestSuccessful=modes=>{
  const wanted=Array.isArray(modes)?modes:[modes],entry=invocations.filter(item=>wanted.includes(item.mode)&&item.status===0).at(-1);
  assert(entry,`Missing successful ${wanted.join('/')}`);return entry;
};
const laterFailures=entry=>invocations.filter(item=>item.mode===entry.mode&&item.status!==0&&date(item.started)>date(entry.started))
  .map(item=>({id:item.id,receipt:item.receipt,log:item.log}));
const freezes=new Map();
for(const entry of invocations.filter(item=>['source-before','source-after'].includes(item.mode)&&item.status===0)){
  const receipt=result(entry),bytes=readFileSync(join(runs,entry.id,'snapshot.json')),snapshot=JSON.parse(bytes);
  assert.equal(sha(bytes),receipt.snapshot.sha256);assert.equal(snapshot.length,receipt.snapshot.files);assert.deepEqual(receipt.snapshot.roots,freezeRoots);
  assert.equal(new Set(snapshot.map(item=>item.path)).size,snapshot.length);
  for(const item of snapshot){safeRelative(item.path);assert(Number.isInteger(item.bytes)&&item.bytes>=0);assert.match(item.sha256,/^[a-f0-9]{64}$/);assert(!item.path.split('/').includes('__pycache__'));}
  assert.deepEqual(snapshot.map(item=>item.path),snapshot.map(item=>item.path).sort((a,b)=>a.localeCompare(b)));
  assert.deepEqual(snapshot.filter(item=>!freezeRoots.some(dir=>item.path.startsWith(dir+'/'))).map(item=>item.path).sort(),[...freezeExtra].sort());
  freezes.set(entry.id,{entry,receipt,snapshot});
}
const pairs=invocations.filter(entry=>entry.mode==='source-after'&&entry.status===0).map((entry,index)=>{
  const after=freezes.get(entry.id),before=freezes.get(after.receipt.snapshot.before);assert(before);assert.equal(before.entry.mode,'source-before');
  assert(date(before.entry.finished)<=date(entry.started));assert.deepEqual(before.snapshot,after.snapshot);
  const comparison=json(join(runs,entry.id,'comparison.json'));
  assert.deepEqual(comparison,{before:before.entry.id,after:entry.id,before_sha256:before.receipt.snapshot.sha256,after_sha256:after.receipt.snapshot.sha256});
  return {round:index+1,before:before.entry.id,after:entry.id,files:after.snapshot.length,equal:true,sha256:after.receipt.snapshot.sha256,
    before_snapshot:archiveRun(before.entry.id,'snapshot.json'),after_snapshot:archiveRun(entry.id,'snapshot.json'),comparison:archiveRun(entry.id,'comparison.json'),aggregate:null};
});
assert(pairs.length>0,'No complete successful source freeze');
assert.equal(new Set(pairs.map(pair=>pair.before)).size,pairs.length,'A baseline cannot represent two source rounds');
for(let i=1;i<pairs.length;i++)assert(date(freezes.get(pairs[i-1].after).entry.finished)<=date(freezes.get(pairs[i].before).entry.started),'Overlapping source rounds');
const finalFreeze=freezes.get(pairs.at(-1).after);
function assertCurrentFreeze(){
  const actual=[];
  for(const directory of freezeRoots)for(const path of inventory(resolve(root,directory),{excludePycache:true})){
    const name=`${directory}/${path}`,bytes=readFileSync(resolve(root,name));actual.push({path:name,bytes:bytes.length,sha256:sha(bytes)});
  }
  for(const path of freezeExtra){const bytes=readFileSync(resolve(root,path));actual.push({path,bytes:bytes.length,sha256:sha(bytes)});}
  actual.sort((a,b)=>a.path.localeCompare(b.path));assert.deepEqual(actual,finalFreeze.snapshot,'Current source/build differs from final freeze');
}
assertCurrentFreeze();
const transitions=pairs.slice(1).map((pair,index)=>{
  const before=new Map(freezes.get(pairs[index].after).snapshot.map(item=>[item.path,item]));
  const after=new Map(freezes.get(pair.before).snapshot.map(item=>[item.path,item]));
  return {from_round:index+1,to_round:index+2,changes:[...new Set([...before.keys(),...after.keys()])].sort()
    .filter(path=>before.get(path)?.sha256!==after.get(path)?.sha256||before.get(path)?.bytes!==after.get(path)?.bytes)
    .map(path=>({path,before:before.get(path)??null,after:after.get(path)??null}))};
});
const adopted=testModes.map(mode=>{
  const entry=latestSuccessful(mode);assert(entry.counts,`Require one complete Node summary: ${entry.id}`);
  assert.equal(entry.node_summaries.length,1);assert.deepEqual(entry.node_summary_errors,[]);
  for(const key of ['fail','cancelled','todo'])assert.equal(entry.counts[key],0,`Reject adopted ${key}: ${entry.id}`);
  assert(entry.counts.tests>0&&entry.counts.pass>0,'An entirely skipped suite is not a passing acceptance');
  assert.equal(entry.commands.length,1);assert.equal(entry.commands[0].status,0);assert.equal(entry.commands[0].signal,null);
  assert.deepEqual(entry.commands[0].args,['--test','--test-concurrency=1',...testFiles[mode]],`Unexpected test collection command: ${entry.id}`);
  const pair=pairs.find(pair=>date(entry.started)>=date(freezes.get(pair.before).entry.finished)&&date(entry.finished)<=date(freezes.get(pair.after).entry.started));
  assert(pair,`Selected result outside a complete freeze: ${entry.id}`);
  const verifier=freezes.get(pair.before).snapshot.find(item=>item.path==='.local/execution-reports-20261027/verify.mjs');
  assert(verifier);assert.equal(entry.script_sha256,verifier.sha256,'Adopted test verifier differs from its frozen verifier');
  return {...entry,source_round:pair.round,later_same_mode_failures:laterFailures(entry)};
});
const builds=['build','api-build','worker-build'].map(mode=>{
  const entry=latestSuccessful(mode);assert.equal(entry.commands.length,mode==='build'?4:1);
  for(const command of entry.commands){assert.equal(command.status,0);assert.equal(command.signal,null);}
  assert(date(entry.finished)<=date(freezes.get(pairs.at(-1).before).entry.started),`Build after final baseline: ${entry.id}`);return {...entry,later_same_mode_failures:laterFailures(entry)};
});
const migrationNames=readdirSync(join(root,'db/migrations')).filter(name=>/^\d+.*\.sql$/.test(name)).sort();
const migrationFile='db/migrations/0128_review_execution_reports.sql',migrationBytes=readFileSync(resolve(root,migrationFile));
assert.match(migrationBytes.toString('utf8'),/CHECK\s*\(\s*isfinite\s*\(\s*created_at\s*\)\s*\)/i,'Final 0128 must reject infinite registration times');
const migrated=latestSuccessful('migrate'),reset=latestSuccessful('database-reset');
assert(date(migrated.started)>=date(reset.finished),'Adopt the fresh migration after the last seed-only reset');
assert(date(migrated.finished)<=date(freezes.get(pairs.at(-1).before).entry.started));assert.equal(result(migrated).migrated,database);
assert.equal(migrated.commands.length,1);assert.equal(migrated.commands[0].status,0);assert.equal(migrated.commands[0].signal,null);
const applied=readFileSync(join(runs,migrated.id,'run.log'),'utf8').split(/\r?\n/).flatMap(line=>line.startsWith('Applied ')?[line.slice(8)]:[]);
assert.deepEqual(applied,migrationNames,'Adopt only a complete fresh migration replay, not a no-op migrate');

const auditTables=['bb_users','bb_projects','bb_input_revisions','bb_platform_principals','bb_runs','bb_jobs','bb_run_events','bb_run_execution_versions',
  'bb_review_execution_snapshots','bb_m4_execution_snapshots','bb_artifact_versions','bb_artifact_execution_bindings','bb_word_delivery_evidence',
  'bb_run_execution_deliveries','bb_run_execution_delivery_artifacts','bb_review_executions','bb_review_editors','bb_review_execution_editors','bb_review_reports','bb_review_execution_reports'];
const expectedSeed={
  bb_users:{id:'bb-platform-probe',username:'bb_platform_probe',status:'disabled',phone_e164:null,closed_at:null},
  bb_projects:{id:'bb-platform-probe-project',owner_user_id:'bb-platform-probe',name:'Platform model probe (synthetic)',kind:'platform_probe',
    issuer_name:null,market:null,offering:null,draft_revision:1,latest_input_revision:1,deleted_at:null,event_cursor:0,update_details:{},archived_at:null,execution_scope_project_id:null},
  bb_input_revisions:{project_id:'bb-platform-probe-project',revision:1,owner_user_id:'bb-platform-probe',draft_revision:1,
    input_hash:'b25e3c7c3362dd95e7d063b8d7ad0a53ab00d3452de0127d06a0422761ab8cab',
    manifest:{synthetic:true,purpose:'platform_probe',user_data:false},material_versions:[],requirement_message_ids:[],rule_pack_version:null,template_version:null,reference_release:null},
  bb_platform_principals:{user_id:'bb-platform-probe',purpose:'platform_probe',project_id:'bb-platform-probe-project',input_revision:1},
};
function checkAudit(audit){
  assert.equal(audit.database,database);assert.equal(normalized(audit.server.data_directory),normalized(cluster));
  assert.equal(audit.server.port,port);assert.equal(audit.server.server_user,user);assert.match(audit.server.server_version,/^16\./);
  assert(Number.isInteger(audit.server.pid)&&audit.server.pid>0);date(audit.server.server_started_at);
  assert.deepEqual(audit.clones,[]);assert.deepEqual(audit.other_clients,[]);assert.deepEqual(Object.keys(audit.counts).sort(),[...auditTables].sort());
  for(const table of auditTables)assert.equal(audit.counts[table],Object.hasOwn(expectedSeed,table)?1:0,`Unexpected business rows: ${table}`);
  assert.deepEqual(audit.migrations,migrationNames);assert.equal(audit.platform_seed.migration,'db/migrations/0027_m1_platform_probe.sql');
  assert.equal(audit.platform_seed.migration_sha256,'1cfd11c047e3dbee3328ba9caabd5fca7e55f208cb278c6ce85f8d1126e772d0');
  assert.deepEqual(Object.keys(audit.platform_seed.rows).sort(),Object.keys(expectedSeed).sort());
  const seedTime=date(audit.platform_seed.applied_at);let exactCreated;
  for(const [table,expected] of Object.entries(expectedSeed)){
    assert.equal(audit.platform_seed.rows[table].length,1);const row={...audit.platform_seed.rows[table][0]};
    for(const key of ['created_at',...(table==='bb_projects'?['updated_at']:[])]){
      assert.equal(date(row[key]),seedTime);exactCreated??=row[key];assert.equal(row[key],exactCreated,'Seed row PG timestamps differ');delete row[key];
    }
    assert.deepEqual(row,expected,`Changed original seed: ${table}`);
  }
}
const resetResult=result(reset);assert.equal(resetResult.database,database);assert.equal(resetResult.reset,true);checkAudit(resetResult.database_audit);
const creation=invocations.find(entry=>entry.id===resetResult.original_creation);assert(creation&&creation.mode==='database-create'&&creation.status===0);
assert.equal(result(creation).database,database);assert.equal(result(creation).created,true);assert(date(creation.finished)<=date(reset.started));
const audited=latestSuccessful('database-audit'),stopped=latestSuccessful('pg-stop');assert.equal(stopped.id,invocations.at(-1).id);
assert(date(audited.started)>=date(finalFreeze.entry.finished)&&date(stopped.started)>=date(audited.finished));
for(const entry of invocations)assert(date(entry.finished)<=date(stopped.finished),'An invocation completed after PG stop');
const stop=result(stopped),audit=result(audited).database_audit;assert.equal(stop.stopped,true);checkAudit(audit);checkAudit(stop.database_audit);
assert(date(audit.platform_seed.applied_at)>=date(migrated.started)&&date(audit.platform_seed.applied_at)<=date(migrated.finished),
  'Final database seed must have been created by the adopted fresh migrate');
assert.deepEqual(json(join(runs,audited.id,'database-audit.json')),audit);assert.deepEqual(json(join(runs,stopped.id,'database-audit.json')),stop.database_audit);
assert.deepEqual(audit,stop.database_audit,'Final standalone audit and stop audit differ');
const launch=latestSuccessful(['pg-start-direct','pg-recover-direct']);assert.deepEqual(audit.server,result(launch).server,'Stop must identify the recorded direct PostgreSQL child');
assert(date(launch.finished)<=date(reset.started));
const childRun=launch.mode==='pg-start-direct'?launch:invocations.find(entry=>entry.id===result(launch).recovered_from);assert(childRun);
const child=json(join(runs,childRun.id,'direct-child.json'));assert.equal(child.pid,audit.server.pid);assert.equal(child.port,port);assert.equal(normalized(child.cluster),normalized(cluster));
assert.equal(stopped.commands.length,2);
for(const command of stopped.commands){assert(command.exe.toLowerCase().endsWith('pg_ctl.exe'));assert.equal(command.signal,null);}
assert.equal(stopped.commands[0].status,0);assert.deepEqual(stopped.commands[0].args,['-D',cluster,'-w','stop','-m','fast']);
assert.equal(stopped.commands[1].status,3);assert.deepEqual(stopped.commands[1].args,['-D',cluster,'status']);assert(!existsSync(join(cluster,'postmaster.pid')),'Postmaster PID file remains');

for(const path of inventory(join(local,'versions'))){
  assert.match(path,/^[a-f0-9]{64}(?:\.playwright\.config)?\.mjs$/);assert.equal(sha(readFileSync(join(local,'versions',path))),path.slice(0,64));
  copied(join(local,'versions',path),`reproduction/versions/${path}`);
}
for(const name of ['verify.mjs','playwright.config.mjs','collect.mjs','README.template.md'])copied(join(local,name),`reproduction/${name}`);
generated('.gitattributes','* -text\n');
function gitHead(){
  const entry=join(root,'.git'),gitdir=lstatSync(entry).isDirectory()?entry:resolve(root,readFileSync(entry,'utf8').trim().replace(/^gitdir: /,''));
  const common=existsSync(join(gitdir,'commondir'))?resolve(gitdir,readFileSync(join(gitdir,'commondir'),'utf8').trim()):gitdir;
  const head=readFileSync(join(gitdir,'HEAD'),'utf8').trim();if(/^[a-f0-9]{40}$/.test(head))return {commit:head,ref:null};
  assert.match(head,/^ref: refs\/heads\//);const ref=head.slice(5),loose=[join(gitdir,ref),join(common,ref)].find(existsSync);
  const commit=loose?readFileSync(loose,'utf8').trim():readFileSync(join(common,'packed-refs'),'utf8').split(/\r?\n/).find(line=>line.endsWith(' '+ref))?.split(' ')[0];
  assert.match(commit,/^[a-f0-9]{40}$/);return {commit,ref};
}
const failures=invocations.filter(entry=>entry.status!==0);
const summary={schemaVersion:1,date:'2026-10-27',base_commit:baseCommit,branch:'codex/desktop-ux-coverage-20261026',git_at_collection:gitHead(),
  goal_status:'active',g03_status:'incomplete',ux_a03_status:'incomplete',synthetic:true,collector_node_version:process.version,
  python_freeze_scope:'Python source is included; only directories named __pycache__ are excluded. External Python/Node/PostgreSQL runtime binaries are not frozen.',
  invocations,adopted_results:adopted,build_results:builds,migration_result:{...migrated,after_reset:reset.id,applied_migrations:applied,
    final_frozen_migration:{path:migrationFile,bytes:migrationBytes.length,sha256:sha(migrationBytes),finite_created_at_check:true},
    provenance_limit:'Migration receipt has no migration-time source-byte hash. This archive retains the complete fresh Applied log and the final SQL path/size/hash freeze record; SQL body remains in repository db/migrations/0128_review_execution_reports.sql, not in this archive.'},
  source_pairs:pairs,source_transitions:transitions,
  unpaired_source_before:invocations.filter(entry=>entry.mode==='source-before'&&entry.status===0&&!pairs.some(pair=>pair.before===entry.id)).map(entry=>entry.id),
  failed_invocations:failures.map(entry=>({id:entry.id,mode:entry.mode,counts:entry.counts,node_summaries:entry.node_summaries,node_summary_errors:entry.node_summary_errors,log:entry.log,receipt:entry.receipt})),
  raw_record_files:rawFiles.length,raw_record_inventory:rawFiles.map(path=>{const item=plan.get(`records/runs/${path}`);return {path:`records/runs/${path}`,bytes:item.bytes.length,sha256:sha(item.bytes)};}),
  database_audit:audit,database_audit_receipt:audited.receipt,stop_receipt:stopped.receipt,pg_launch_receipt:launch.receipt,
  excluded_new_acceptance:['Word content/delivery','real model/provider','browser'],
  scope_limits:['V2 remains disabled','No supplement adoption or new-input successor execution','No price decision or new ledger authority','B selected; B1/B2 calculation remains undecided','Full UX goal/G03/UX-A03 remain active and incomplete','SQL does not recompute the JavaScript canonical report digest'],aggregate:null};
generated('summary.json',summary);
const countsText=counts=>counts?`${counts.tests} tests / ${counts.pass} pass / ${counts.fail} fail / ${counts.cancelled} cancelled / ${counts.skipped} skip / ${counts.todo} todo`:'无完整、可采用的单一 Node summary';
const values={
  BASE_COMMIT:baseCommit,ADOPTED_TABLE:['| 集合 | 独立采用结果 | 冻结轮次 | 原始 receipt |','| --- | --- | --- | --- |',
    ...adopted.map(entry=>`| ${entry.mode} | ${countsText(entry.counts)} | ${entry.source_round} | [${entry.id}](${entry.receipt}) |`)].join('\n'),
  FREEZE_DETAILS:pairs.map(pair=>`- 第 ${pair.round} 轮：${pair.files} 个文件，before/after 完全一致；[before](${pair.before_snapshot}) / [after](${pair.after_snapshot})。`).join('\n'),
  FAILURE_DETAILS:failures.length?failures.map(entry=>`- [${entry.id}](${entry.log})：${entry.mode}，status=${entry.status}；${countsText(entry.counts)}。失败记录完整保留，不加入采用计数。`).join('\n'):'本轮没有 status 非零的 invocation。',
  BUILD_DETAILS:builds.map(entry=>`- [${entry.mode}](${entry.receipt})：${entry.commands.length} 个命令均退出 0。`).join('\n'),
  MIGRATION_DETAILS:`采用 reset 后 [完整 fresh migrate](${migrated.receipt})，逐项 Applied 到 0128。最终冻结的 0128 SHA-256 为 \`${sha(migrationBytes)}\`，包含 \`CHECK(isfinite(created_at))\`。迁移 receipt 未登记执行当时的 SQL 字节 hash；本档案保存完整 fresh 日志和最终 SQL 的路径/字节数/hash 冻结记录，SQL 正文位于仓库 \`db/migrations/0128_review_execution_reports.sql\`，未复制进档案。不将这些记录冒称为独立的迁移时字节证明。`,
  CLEANUP_DETAILS:`本轮准确 PostgreSQL PID **${audit.server.pid}**，目录 \`.local/report-postgres/data\`，端口 **${port}**，角色 \`${user}\`，模板 \`${database}\`。最终独立 audit 与 stop audit 一致，仅原 0027 的四条准确禁用种子，所审计业务表全零，clones/other clients 均为空。记录的同一 direct child 已 stop=0、status=3，当前 PID 文件不存在。见 [audit](${audited.receipt}) / [stop](${stopped.receipt})。`,
  RAW_DETAILS:`保留 ${invocations.length} 个完整 invocation、${rawFiles.length} 个原始文件。每个文件的库存、字节数、SHA-256 与来源均在 [summary.json](summary.json) 和 [manifest.json](manifest.json)；不同集合、重复执行和轮次不相加。`,
};
let readme=readFileSync(join(local,'README.template.md'),'utf8');
for(const [key,value] of Object.entries(values)){assert(readme.includes(`{{${key}}}`),`Missing template key ${key}`);readme=readme.replaceAll(`{{${key}}}`,value);}
assert(!/\{\{[A-Z_]+\}\}/.test(readme),'Unresolved README placeholder');generated('README.md',readme);
const entries=[...plan].map(([path,item])=>({path,bytes:item.bytes.length,sha256:sha(item.bytes),source:item.source,
  ...(item.generated_by?{generated_by:item.generated_by}:{})})).sort((a,b)=>a.path.localeCompare(b.path));
const manifest={schemaVersion:1,files:entries.length,collector:slash(relative(root,script)),collector_sha256:sha(readFileSync(script)),entries};
function assertSourcesUnchanged(){
  assert.deepEqual(inventory(runs),rawFiles,'Raw invocation inventory changed during collection');
  for(const item of plan.values())if(item.source)assert(readFileSync(resolve(root,item.source)).equals(item.bytes),`Collection source changed: ${item.source}`);
}
assertSourcesUnchanged();assertCurrentFreeze();
// All validation precedes destination creation. Manifest is written last; every
// output is exclusive-create, and existing archives are never opened for write.
mkdirSync(destination,{recursive:false});
for(const [path,item] of plan){const target=join(destination,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,item.bytes,{flag:'wx'});}
assertSourcesUnchanged();assertCurrentFreeze();
assert.deepEqual(inventory(destination),entries.map(entry=>entry.path).sort());
for(const entry of entries){const bytes=readFileSync(join(destination,entry.path));assert.equal(bytes.length,entry.bytes);assert.equal(sha(bytes),entry.sha256);}
writeFileSync(join(destination,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
assert.deepEqual(inventory(destination),[...entries.map(entry=>entry.path),'manifest.json'].sort());
process.stdout.write(JSON.stringify({destination,files:entries.length+1,manifest_entries:entries.length,raw_record_files:rawFiles.length,invocations:invocations.length,
  adopted:adopted.map(entry=>({mode:entry.mode,counts:entry.counts,source_round:entry.source_round})),source_pairs:pairs,pg_pid:audit.server.pid},null,2)+'\n');
