import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {dirname,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// Collection only: no subprocesses, database connections, builds or tests.
// Run once after README.md is prepared and the final pg-stop has succeeded.
const local=dirname(fileURLToPath(import.meta.url)),root=resolve(local,'../..');
const destination=resolve(root,'docs/acceptance/desktop-ux-coverage-20261026/history-pairs');
const cluster=resolve(root,'.local/history-pairs-postgres/data');
assert.equal(local,resolve(root,'.local/history-pairs-20261027'));
assert(!existsSync(destination),'Never overwrite an existing acceptance archive');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const slash=path=>path.replaceAll('\\','/');
const json=path=>JSON.parse(readFileSync(path,'utf8'));
const relativeSource=path=>slash(relative(root,path));
const archiveRun=(id,name)=>`records/runs/${id}/${name}`;
const plan=new Map();

function inventory(directory){
  const files=[];
  function walk(current){
    for(const item of readdirSync(current,{withFileTypes:true})){
      assert(!item.isSymbolicLink(),`Refuse a symbolic link: ${join(current,item.name)}`);
      const path=join(current,item.name);
      if(item.isDirectory())walk(path);
      else{assert(item.isFile(),`Unexpected file type: ${path}`);files.push(slash(relative(directory,path)));}
    }
  }
  walk(directory);return files.sort();
}

function copied(source,path){
  assert(!plan.has(path),`Duplicate archive destination: ${path}`);
  plan.set(path,{source:relativeSource(source),bytes:readFileSync(source)});
}

function generated(path,value){
  assert(!plan.has(path));
  const bytes=Buffer.from(typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');
  plan.set(path,{source:null,generated_by:relativeSource(fileURLToPath(import.meta.url)),bytes});
}

function metrics(raw){
  const log=raw.replace(/\x1b\[[0-9;]*m/g,''),blocks=[];
  let current;
  for(const line of log.split(/\r?\n/)){
    const match=line.match(/^(?:ℹ|#)\s+(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\s+(\d+(?:\.\d+)?)\s*$/);
    if(!match)continue;
    if(match[1]==='tests'){if(current)blocks.push(current);current={};}
    assert(current,`Summary field precedes tests: ${line}`);
    assert(!(match[1] in current),`Duplicate Node summary field: ${line}`);
    current[match[1]]=Number(match[2]);
  }
  if(current)blocks.push(current);
  for(const block of blocks)for(const key of ['tests','pass','fail','skipped','cancelled'])assert(Number.isInteger(block[key]),`Missing Node summary ${key}`);
  const examples=[];
  for(const line of log.split(/\r?\n/)){
    let match=line.match(/^validated (\d+) synthetic examples \+ (\d+) internal library examples\b/i);
    if(match){examples.push({kind:'contracts',synthetic:Number(match[1]),internal_library:Number(match[2]),output:line});continue;}
    match=line.match(/^validated (\d+) synthetic data-lifecycle examples\b/i);
    if(match)examples.push({kind:'data_lifecycle',synthetic:Number(match[1]),output:line});
  }
  return {counts:blocks.length===1?blocks[0]:null,node_summaries:blocks,contracts_examples:examples,
    skipped_titles:log.split(/\r?\n/).filter(line=>line.includes('# SKIP'))};
}

const runsDirectory=join(local,'runs');
const rawInventory=inventory(runsDirectory);
assert(rawInventory.length>0,'No raw evidence');
for(const path of rawInventory){
  assert(/\.(?:json|log)$/.test(path),`Unexpected raw evidence extension: ${path}`);
  copied(join(runsDirectory,path),`records/runs/${path}`);
}
const runNames=readdirSync(runsDirectory,{withFileTypes:true}).map(item=>{
  assert(item.isDirectory()&&!item.isSymbolicLink(),'runs/ must contain only real invocation directories');return item.name;
}).sort();
const invocations=runNames.map(id=>{
  const directory=join(runsDirectory,id);
  assert(existsSync(join(directory,'result.json')),`Refuse running/incomplete invocation: ${id}`);
  const start=json(join(directory,'start.json')),result=json(join(directory,'result.json'));
  assert.equal(start.id,id);assert.equal(result.id,id);assert.equal(start.mode,result.mode);
  assert([0,1].includes(result.status),`Invocation has no final status: ${id}`);
  assert(Number.isFinite(Date.parse(start.started))&&Number.isFinite(Date.parse(result.finished)));
  assert(Date.parse(result.finished)>=Date.parse(start.started));
  const log=readFileSync(join(directory,'run.log'),'utf8');
  const commands=readdirSync(directory).filter(name=>/^command-\d+-result\.json$/.test(name)).sort().map(name=>({record:archiveRun(id,name),...json(join(directory,name))}));
  return {id,mode:start.mode,status:result.status,started:start.started,finished:result.finished,
    start:archiveRun(id,'start.json'),receipt:archiveRun(id,'result.json'),log:archiveRun(id,'run.log'),
    script_sha256:start.script_sha256,...metrics(log),commands,aggregate:null};
});
const receipt=entry=>json(join(runsDirectory,entry.id,'result.json'));
const rawLog=entry=>readFileSync(join(runsDirectory,entry.id,'run.log'),'utf8');
const latest=(mode,successful=false)=>{
  const result=invocations.filter(entry=>entry.mode===mode&&(!successful||entry.status===0)).at(-1);
  assert(result,`Missing ${successful?'successful ':''}${mode}`);return result;
};

// Every original script hash recorded by the invocations must remain reproducible.
const scripts=['verify.mjs','verify-initial.mjs','verify-recovery.mjs','probe.mjs','collect.mjs'];
for(const name of scripts)copied(join(local,name),`reproduction/${name}`);
const verifyHashes=new Set(['verify.mjs','verify-initial.mjs','verify-recovery.mjs'].map(name=>sha(readFileSync(join(local,name)))));
for(const invocation of invocations)assert(verifyHashes.has(invocation.script_sha256),`Unarchived verifier version: ${invocation.id}`);
const probes=readdirSync(local).filter(name=>/^probe-.*\.json$/.test(name)).sort();
assert(probes.length>0,'Missing original connection probe');
for(const name of probes){json(join(local,name));copied(join(local,name),`records/${name}`);}
copied(join(local,'README.md'),'README.md');

const requiredRoots=['apps/api/src','apps/api/dist','apps/worker/src','apps/worker/dist','apps/web/src',
  'packages/contracts/src','packages/contracts/dist','packages/contracts/examples','db/migrations'];
const extraFiles=['package.json','package-lock.json','apps/api/package.json','apps/api/tsconfig.json',
  'apps/worker/package.json','apps/worker/tsconfig.json','apps/web/package.json','apps/web/tsconfig.json',
  'packages/contracts/package.json','packages/contracts/tsconfig.json','db/migrate.mjs'];
const snapshots=new Map();
for(const invocation of invocations.filter(entry=>['source-before','source-after'].includes(entry.mode))){
  assert.equal(invocation.status,0,`Incomplete source freeze: ${invocation.id}`);
  const result=receipt(invocation),bytes=readFileSync(join(runsDirectory,invocation.id,'snapshot.json'));
  assert.equal(sha(bytes),result.snapshot.sha256,`Snapshot receipt changed: ${invocation.id}`);
  const entries=JSON.parse(bytes);
  assert.equal(entries.length,1900);assert.equal(result.snapshot.files,1900);
  assert.deepEqual(result.snapshot.roots,requiredRoots);
  assert.equal(new Set(entries.map(entry=>entry.path)).size,1900,'Duplicate snapshot path');
  for(const entry of entries){
    assert.equal(entry.path,slash(relative(root,resolve(root,entry.path))),'Snapshot path must be project-relative');
    assert(!entry.path.startsWith('../')&&!entry.path.startsWith('/'),'Snapshot path escaped repository');
    assert(Number.isInteger(entry.bytes)&&entry.bytes>=0);assert.match(entry.sha256,/^[a-f0-9]{64}$/);
  }
  assert.deepEqual(entries.map(entry=>entry.path),entries.map(entry=>entry.path).sort((a,b)=>a.localeCompare(b)),'Snapshot paths must retain canonical order');
  snapshots.set(invocation.id,{invocation,result,entries,sha256:sha(bytes)});
}
const beforeRuns=invocations.filter(entry=>entry.mode==='source-before');
const afterRuns=invocations.filter(entry=>entry.mode==='source-after');
assert.equal(beforeRuns.length,3,'Exactly three complete source-freeze pairs are required');
assert.equal(afterRuns.length,3,'Exactly three complete source-freeze pairs are required');
const pairedBefore=new Set();
const pairs=afterRuns.map((after,index)=>{
  const a=snapshots.get(after.id),before=a.result.snapshot.before,b=snapshots.get(before);
  assert(b&&b.invocation.mode==='source-before');assert(!pairedBefore.has(before),'Reused source-before pair');pairedBefore.add(before);
  assert.equal(before,beforeRuns[index].id,'Source pairs must retain chronological order');
  assert(before<after.id);if(index<beforeRuns.length-1)assert(after.id<beforeRuns[index+1].id,'Source-freeze rounds overlap');
  assert.deepEqual(b.entries,a.entries,`Source changed inside pair ${index+1}`);
  const comparison=json(join(runsDirectory,after.id,'comparison.json'));
  assert.deepEqual(comparison,{before,after:after.id,before_sha256:b.sha256,after_sha256:a.sha256});
  return {round:index+1,before,after:after.id,files:1900,equal:true,sha256:a.sha256,
    before_snapshot:archiveRun(before,'snapshot.json'),after_snapshot:archiveRun(after.id,'snapshot.json'),
    comparison:archiveRun(after.id,'comparison.json'),invocations:invocations.filter(entry=>entry.id>before&&entry.id<after.id).map(entry=>entry.id),aggregate:null};
});
const delta=(before,after)=>{
  const a=new Map(before.map(entry=>[entry.path,entry])),b=new Map(after.map(entry=>[entry.path,entry]));
  return [...new Set([...a.keys(),...b.keys()])].sort().filter(path=>a.get(path)?.sha256!==b.get(path)?.sha256||a.get(path)?.bytes!==b.get(path)?.bytes)
    .map(path=>({path,before:a.get(path)?{bytes:a.get(path).bytes,sha256:a.get(path).sha256}:null,
      after:b.get(path)?{bytes:b.get(path).bytes,sha256:b.get(path).sha256}:null}));
};
const transitions=pairs.slice(1).map((pair,index)=>({from_round:index+1,to_round:index+2,
  changes:delta(snapshots.get(pairs[index].before).entries,snapshots.get(pair.before).entries)}));
const lastPair=pairs.at(-1),lastSnapshot=snapshots.get(lastPair.after).entries;
const currentEntries=[];
for(const directory of requiredRoots)for(const file of inventory(resolve(root,directory))){
  const path=`${directory}/${file}`,bytes=readFileSync(resolve(root,path));currentEntries.push({path,bytes:bytes.length,sha256:sha(bytes)});
}
for(const path of extraFiles){const bytes=readFileSync(resolve(root,path));currentEntries.push({path,bytes:bytes.length,sha256:sha(bytes)});}
currentEntries.sort((a,b)=>a.path.localeCompare(b.path));
assert.equal(currentEntries.length,1900);assert.deepEqual(currentEntries,lastSnapshot,'Current source/build bytes or inventory differ from final freeze');

const selectedResults=['api-history','api-consumers'].map(mode=>{
  const selected=latest(mode,true);assert.equal(latest(mode).id,selected.id,`A later ${mode} failure exists`);
  assert(selected.counts&&selected.node_summaries.length===1,`Expected one complete Node summary: ${selected.id}`);
  assert.equal(selected.counts.fail,0);assert.equal(selected.counts.cancelled,0);
  return {...selected,source_round:pairs.find(pair=>selected.id>pair.before&&selected.id<pair.after)?.round??null};
});
for(const selected of selectedResults)assert(selected.source_round,'Selected result must belong to an unchanged source pair');
for(const mode of ['contracts-build','api-build','worker-build','web-typecheck','contracts-check','migrate'])assert.equal(latest(mode).status,0,`Final ${mode} did not succeed`);
const contractChecks=invocations.filter(entry=>entry.mode==='contracts-check');
for(const entry of contractChecks.filter(entry=>entry.status===0)){
  assert(entry.contracts_examples.some(example=>example.kind==='contracts'));
  assert(entry.contracts_examples.some(example=>example.kind==='data_lifecycle'));
  assert(entry.counts&&entry.counts.fail===0&&entry.counts.cancelled===0);
}

// Retain the actual failed attempts as evidence; they never become acceptance.
const failedInit=invocations.find(entry=>entry.mode==='initdb'&&entry.status===1);
const failedStart=invocations.find(entry=>entry.mode==='pg-start-direct'&&entry.status===1);
const failedBuild=invocations.find(entry=>entry.mode==='api-build'&&entry.status===1);
const red=invocations.find(entry=>entry.mode==='api-history'&&entry.status===1&&entry.counts?.tests===17&&entry.counts?.pass===15&&entry.counts?.fail===2);
assert(failedInit&&failedStart&&failedBuild&&red,'Missing original failure history');
assert.match(rawLog(failedInit),/error code 87/);assert.match(receipt(failedStart).error.message,/timeout/i);
assert(existsSync(join(runsDirectory,failedStart.id,'direct-child.json')));
assert(failedBuild.commands.some(command=>command.status!==0),'Missing original failed build command');
assert.equal(red.counts.cancelled,0);assert.equal(red.counts.skipped,0);
assert(red.id>pairs[0].before&&red.id<pairs[0].after,'Red regression must belong to the first freeze');
const seedGuardFailures=['database-audit','pg-stop'].map(mode=>{
  const failed=invocations.find(entry=>entry.mode===mode&&entry.status===1);
  assert(failed,`Missing retained initial seed guard failure: ${mode}`);
  const proof=json(join(runsDirectory,failed.id,'database-audit.json'));
  assert.equal(proof.counts.bb_projects,1);
  for(const [table,count] of Object.entries(proof.counts))if(table!=='bb_projects')assert.equal(count,0);
  assert.deepEqual(proof.clones,[]);assert.deepEqual(proof.other_clients,[]);
  assert.match(receipt(failed).error.message,/bb_projects template must stay empty/);
  assert.equal(failed.script_sha256,sha(readFileSync(join(local,'verify-recovery.mjs'))));
  return {id:failed.id,mode,status:failed.status,audit:archiveRun(failed.id,'database-audit.json'),
    reason:'The original guard treated the exact migration-created platform probe project as user-test residue; the guard failed before any stop command.'};
});
const failureHistory={sandbox_initdb:failedInit.id,startup_connection_timeout:failedStart.id,
  initial_api_build:failedBuild.id,red_regression:{id:red.id,counts:red.counts},
  original_seed_guard_failures:seedGuardFailures,aggregate:null};

// The collector only inspects the final stop receipts and filesystem; it never connects.
const stopped=latest('pg-stop');assert.equal(stopped.status,0);assert.equal(stopped.id,invocations.at(-1).id,'pg-stop must be the final verification invocation');
const stopReceipt=receipt(stopped);assert.equal(stopReceipt.stopped,true);
assert(!existsSync(join(cluster,'postmaster.pid')),'Dedicated PostgreSQL is still running');
const databaseAudit=stopReceipt.database_audit;
assert.deepEqual(databaseAudit,json(join(runsDirectory,stopped.id,'database-audit.json')));
assert.equal(databaseAudit.database,'bb_history_pairs_template_20261027');
assert.equal(resolve(databaseAudit.server.data_directory).toLowerCase(),cluster.toLowerCase());
assert.equal(databaseAudit.server.port,15529);assert.equal(databaseAudit.server.server_user,'bb_history_test');
assert.match(databaseAudit.server.server_version,/^16\./);
const runtimeTables=['bb_users','bb_projects','bb_input_revisions','bb_platform_principals','bb_runs','bb_jobs','bb_run_events','bb_run_execution_versions',
  'bb_review_execution_snapshots','bb_m4_execution_snapshots','bb_artifact_versions','bb_artifact_execution_bindings',
  'bb_word_delivery_evidence','bb_run_execution_deliveries','bb_run_execution_delivery_artifacts'];
assert.deepEqual(Object.keys(databaseAudit.counts).sort(),[...runtimeTables].sort());
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
const seed=databaseAudit.platform_seed;
assert(seed,'Final audit must prove the exact seed rather than allow an arbitrary project');
assert.equal(seed.migration,'db/migrations/0027_m1_platform_probe.sql');
assert.equal(seed.migration_sha256,'1cfd11c047e3dbee3328ba9caabd5fca7e55f208cb278c6ce85f8d1126e772d0');
assert.equal(lastSnapshot.find(entry=>entry.path===seed.migration)?.sha256,seed.migration_sha256);
assert.equal(sha(Buffer.from('bb-platform-probe-input-v1')),expectedSeed.bb_input_revisions.input_hash);
assert(Number.isFinite(Date.parse(seed.applied_at)),'Original seed migration timestamp missing');
assert.deepEqual(Object.keys(seed.rows).sort(),Object.keys(expectedSeed).sort());
for(const [table,expected] of Object.entries(expectedSeed)){
  assert.equal(seed.rows[table].length,1,`${table} must contain exactly the original migration seed`);
  const row={...seed.rows[table][0]};
  for(const key of ['created_at',...(table==='bb_projects'?['updated_at']:[])]){
    assert.equal(Date.parse(row[key]),Date.parse(seed.applied_at),`${table}.${key} changed after its seed migration`);delete row[key];
  }
  assert.deepEqual(row,expected,`${table} seed was changed`);
}
for(const [table,count] of Object.entries(databaseAudit.counts))assert.equal(count,table in expectedSeed?1:0,`${table} contains user-test business residue`);
assert.deepEqual(databaseAudit.clones,[]);assert.deepEqual(databaseAudit.other_clients,[]);
const migrations=lastSnapshot.filter(entry=>/^db\/migrations\/\d+.*\.sql$/.test(entry.path)).map(entry=>entry.path.slice('db/migrations/'.length)).sort();
assert.deepEqual(databaseAudit.migrations,migrations,'Final template lacks the complete migration replay');
const ready=invocations.filter(entry=>['pg-start-direct','pg-recover-direct'].includes(entry.mode)&&entry.status===0).at(-1);
assert(ready);assert.deepEqual(databaseAudit.server,receipt(ready).server,'Stop does not belong to the recorded direct server');
const stopCommand=stopped.commands.find(command=>command.args.includes('stop'));
const statusCommand=stopped.commands.find(command=>command.args.at(-1)==='status');
assert(stopCommand&&statusCommand);assert.equal(stopCommand.status,0);assert.equal(statusCommand.status,3);

generated('.gitattributes','# Preserve exact recorded bytes and manifest hashes.\n* -text\nrecords/** -diff\n');
generated('summary.json',{schemaVersion:1,recorded_at:new Date().toISOString(),synthetic:true,
  goal_complete:false,g03_complete:false,aggregate:null,
  count_policy:'Each invocation and each source-freeze round stands alone. Overlapping runs, red regressions, skips and diagnostic failures are never added or counted as passed.',
  selected_results:selectedResults,invocations,contracts_checks:contractChecks,failure_history:failureHistory,
  source_freezes:{pairs,transitions,initial_to_final:delta(snapshots.get(pairs[0].before).entries,lastSnapshot),
    current_final_inventory_matches:true,current_files:1900,aggregate:null},
  database_audit:{record:archiveRun(stopped.id,'database-audit.json'),...databaseAudit},
  template_residue_policy:'Only the exact original 0027 platform-probe user, project, input and principal remain (one row each); every other audited business table is empty. No user-test business residue is allowed.',
  postgres_stopped:{invocation:stopped.id,receipt:stopped.receipt,postmaster_pid_absent:true,
    stop_command:stopCommand.record,status_command:statusCommand.record,status_after_stop:3},
  reproduction:scripts.map(name=>({path:`reproduction/${name}`,source:relativeSource(join(local,name)),sha256:sha(readFileSync(join(local,name)))})),
  probes:probes.map(name=>({path:`records/${name}`,source:relativeSource(join(local,name))})),
  limits:['This increment verifies existing delivery history; the overall desktop UX goal and G03 remain unfinished.',
    'No successor execution/V2 adoption, supplementary-material reuse, surcharge pricing/confirmation/accounting or complete same-task continuation journey is accepted here.',
    'The user chose separately quoted rework with explicit surcharge confirmation; its pricing basis remains undecided.',
    'Skipped tests are preserved individually and do not count as passes. No coverage percentage or combined test total is inferred.',
    'No browser, real provider, Azure, payment or Word/WPS layout acceptance is claimed.']});

// Final preflight detects evidence additions/mutations before creating any archive.
assert.deepEqual(inventory(runsDirectory),rawInventory,'Raw evidence inventory changed during collection');
for(const entry of plan.values())if(entry.source)assert(readFileSync(resolve(root,entry.source)).equals(entry.bytes),`Source evidence changed: ${entry.source}`);
assert(!existsSync(destination),'Acceptance destination appeared during preflight');
mkdirSync(destination);
for(const [path,entry] of plan){
  const target=join(destination,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,entry.bytes,{flag:'wx'});
}
const entries=[...plan].map(([path,entry])=>({path,bytes:entry.bytes.length,sha256:sha(entry.bytes),source:entry.source,
  ...(entry.generated_by?{generated_by:entry.generated_by}:{})})).sort((a,b)=>a.path.localeCompare(b.path));
writeFileSync(join(destination,'manifest.json'),JSON.stringify({schemaVersion:1,files:entries.length,entries},null,2)+'\n',{flag:'wx'});
const manifest=json(join(destination,'manifest.json'));
assert.equal(manifest.files,entries.length);assert.deepEqual(manifest.entries,entries);
assert.deepEqual(inventory(destination),[...entries.map(entry=>entry.path),'manifest.json'].sort(),'Archive manifest inventory mismatch');
for(const entry of manifest.entries){
  const bytes=readFileSync(join(destination,entry.path));assert.equal(bytes.length,entry.bytes);assert.equal(sha(bytes),entry.sha256);
  if(entry.source)assert(bytes.equals(readFileSync(resolve(root,entry.source))),`Raw-byte copy mismatch: ${entry.path}`);
}
console.log(JSON.stringify({archive:relativeSource(destination),files:entries.length+1,manifest_files:entries.length,
  raw_records:rawInventory.length,invocations:invocations.length,source_pairs:pairs.length,current_source_files:1900,
  selected_results:selectedResults.map(entry=>({id:entry.id,mode:entry.mode,counts:entry.counts})),aggregate:null},null,2));
