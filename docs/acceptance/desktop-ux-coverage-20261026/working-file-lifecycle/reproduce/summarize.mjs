import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {isAbsolute,join,relative,resolve} from 'node:path';

// Run only after final verification and this round's dedicated cleanup audit.
// It reads no earlier acceptance or .local evidence directory.
const root=process.cwd(),local=resolve(root,'.local/working-file-lifecycle');
const baseline='a35034b3',sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=name=>readFileSync(join(local,name));
const json=name=>JSON.parse(read(name).toString('utf8'));
const clean=value=>value.replace(/\x1b\[[0-9;]*m/g,'');
const record=name=>{const bytes=read(name);return {path:name,bytes:bytes.length,sha256:sha(bytes)};};
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const candidates=mode=>readdirSync(local).flatMap(name=>{
 const match=name.match(new RegExp(`^${escape(mode)}(?:-(\\d+))?\\.json$`));
 return match?[{name,iteration:Number(match[1]??0)}]:[];
}).sort((a,b)=>a.iteration-b.iteration);
const latest=(mode,expectedStatus=0)=>{
 const values=candidates(mode);assert(values.length,`Missing current-round ${mode} receipt`);
 const selected=values.at(-1),value=json(selected.name),log=selected.name.replace(/\.json$/,'.log');
 assert.equal(value.status,expectedStatus,`Unexpected process status in latest ${selected.name}`);
 assert(!value.error,`${selected.name} contains a process error`);
 assert(existsSync(join(local,log)),`Missing paired ${log}`);
 assert(Number.isFinite(Date.parse(value.started))&&Number.isFinite(Date.parse(value.finished)),`Missing command times in ${selected.name}`);
 assert(Date.parse(value.finished)>=Date.parse(value.started),`Invalid command times in ${selected.name}`);
 return {receipt:selected.name,log,...value};
};
const nodeTest=(mode,{expectedStatus=0,expectedFailures=0}={})=>{
 const result=latest(mode,expectedStatus),log=clean(read(result.log).toString('utf8'));
 const count=field=>{
  const values=[...log.matchAll(new RegExp(`^(?:ℹ|#)\\s+${field}\\s+(\\d+)\\s*$`,'gm'))];
  assert.equal(values.length,1,`Missing or repeated ${field} summary in ${result.log}`);
  return Number(values[0][1]);
 };
 const counts={tests:count('tests'),passed:count('pass'),failed:count('fail'),cancelled:count('cancelled'),skipped:count('skipped'),todo:count('todo')};
 assert(counts.tests>0,`No tests in ${result.log}`);
 assert.equal(counts.failed,expectedFailures);assert.equal(counts.cancelled,0);assert.equal(counts.todo,0);
 assert.equal(counts.tests,counts.passed+counts.failed+counts.skipped,`Inconsistent test counts in ${result.log}`);
 const skip_lines=log.split(/\r?\n/).filter(line=>/# SKIP\b/.test(line)).map(line=>line.trim());
 assert(counts.skipped===0||skip_lines.length>0,`Skipped tests without retained skip lines in ${result.log}`);
 return {...result,counts,skip_lines};
};
const browser=mode=>{
 if(!candidates(mode).length)return {status:'not_run',reason:'No current-round command receipt; earlier browser evidence is excluded'};
 const result=latest(mode),suffix=result.receipt.slice(mode.length,-'.json'.length);
 const report=`${mode}-report${suffix}.json`;assert(existsSync(join(local,report)),`Missing current-round ${report}`);
 const stats=json(report).stats;assert(stats,'Missing Playwright statistics');
 for(const field of ['expected','unexpected','flaky','skipped'])assert(Number.isSafeInteger(stats[field])&&stats[field]>=0,`Invalid ${field} in ${report}`);
 assert(stats.expected>0,`No completed expected tests in ${report}`);
 assert.equal(stats.unexpected,0);assert.equal(stats.flaky,0);
 return {...result,command_status:result.status,status:'passed',report,stats};
};

const snapshots=readdirSync(local).filter(name=>/^source-before-\d+\.json$/.test(name))
 .sort((a,b)=>Number(a.match(/-(\d+)\.json$/)[1])-Number(b.match(/-(\d+)\.json$/)[1]));
snapshots.push('source-before.json');
const validateSnapshot=(name,entries)=>{
 assert(Array.isArray(entries)&&entries.length>0,`Empty source snapshot ${name}`);
 const paths=new Set();
 for(const file of entries){
  assert(typeof file.path==='string'&&!isAbsolute(file.path),`Unsafe source path in ${name}`);
  const path=resolve(root,file.path),part=relative(root,path);
  assert(part&&!part.startsWith('..')&&!isAbsolute(part),`Source outside repository in ${name}`);
  assert(/^[a-f0-9]{64}$/.test(file.sha256),`Invalid hash in ${name}`);
  assert(!paths.has(file.path),`Duplicate path in ${name}`);paths.add(file.path);
 }
 return entries;
};
const before=validateSnapshot('source-before.json',json('source-before.json'));
const after=validateSnapshot('source-after.json',json('source-after.json'));
assert.deepEqual(after,before,'Final source-before/source-after differ');
const freeze=json('verification-freeze.json'),freezeTime=Date.parse(freeze.created_at);
assert(Number.isFinite(freezeTime),'Missing current-round verification freeze timestamp');
assert.equal(freeze.source_before_sha256,sha(read('source-before.json')),'Freeze does not bind final source-before bytes');
assert.equal(freeze.files,before.length,'Freeze file count differs from final source-before');
for(const file of after)assert.equal(sha(readFileSync(resolve(root,file.path))),file.sha256,`Source/build changed after final snapshot: ${file.path}`);
const changes=(original,next)=>{
 const old=new Map(original.map(file=>[file.path,file.sha256])),now=new Map(next.map(file=>[file.path,file.sha256]));
 return {added:next.filter(file=>!old.has(file.path)),
  modified:next.filter(file=>old.has(file.path)&&old.get(file.path)!==file.sha256).map(file=>({path:file.path,before:old.get(file.path),after:file.sha256})),
  removed:original.filter(file=>!now.has(file.path))};
};
const history=snapshots.map(name=>{
 const original=validateSnapshot(name,json(name));
 return {record:record(name),files:original.length,changes_to_final:changes(original,before)};
});

const migrate=latest('migrate');
const migrationRuns=candidates('migrate').map(({name})=>{
 const value=json(name),log=name.replace(/\.json$/,'.log');assert(existsSync(join(local,log)),`Missing paired migration log ${log}`);
 const applied=[...clean(read(log).toString('utf8')).matchAll(/^Applied (012[23]_[^\r\n]+\.sql)\s*$/gm)].map(match=>match[1]);
 return {receipt:name,log,...value,applied};
});
const migrationProofs=['0122','0123'].map(prefix=>{
 const successful=migrationRuns.filter(run=>run.status===0&&!run.error&&run.applied.some(name=>name.startsWith(`${prefix}_`)));
 const names=[...new Set(successful.flatMap(run=>run.applied.filter(name=>name.startsWith(`${prefix}_`))))];
 assert.equal(names.length,1,`Current-round successful migration logs must establish exactly one ${prefix} migration`);
 return {filename:names[0],receipts:successful.map(run=>({receipt:run.receipt,log:run.log}))};
});
const builds=['contracts-build','api-build','worker-build','web-tsc','web-build'].map(mode=>latest(mode));
const contracts=latest('contracts-check'),contractLog=clean(read(contracts.log).toString('utf8'));
const examples=contractLog.match(/validated (\d+) synthetic examples \+ (\d+) internal library examples/);
assert(examples,'Contract example counts missing from current-round log');
const fullApi=nodeTest('api-test',{expectedStatus:1,expectedFailures:1}),worker=nodeTest('worker-test');
const focusedTests={working_files:nodeTest('working-files-test')};
const corrective=nodeTest('readable-retention-test');assert.equal(corrective.counts.skipped,0,'Corrective PG suite must actually run');
assert.deepEqual(corrective.args,['--test','apps/api/dist/review-readable-retention.pg.test.js'],'Corrective command must run the exact fixture suite');
const retainedFailureTitle='real working-file purge waits for readable report validation and denies the next raw read';
const correctivePassedTitles=[...clean(read(corrective.log).toString('utf8')).matchAll(/^\s*✔ (.+?) \([\d.]+(?:ms|s)\)\s*$/gm)].map(match=>match[1]);
assert(correctivePassedTitles.includes(retainedFailureTitle),'Corrective log must actually pass the exact previously failing title');
const failureTitles=[...new Set([...clean(read(fullApi.log).toString('utf8')).matchAll(/^\s*✖ (.+?) \([\d.]+(?:ms|s)\)\s*$/gm)].map(match=>match[1]))];
assert.deepEqual(failureTitles,[retainedFailureTitle],'Full API failure must be only the known readable-retention fixture title');
const oldSnapshotName='source-before-2.json',oldFreezeName='verification-freeze-2.json';
const oldSnapshot=validateSnapshot(oldSnapshotName,json(oldSnapshotName)),oldFreeze=json(oldFreezeName),oldFreezeTime=Date.parse(oldFreeze.created_at);
assert(Number.isFinite(oldFreezeTime)&&oldFreezeTime<freezeTime,'Missing earlier verification freeze for composite evidence');
assert.equal(oldFreeze.source_before_sha256,sha(read(oldSnapshotName)),'Earlier freeze does not bind its exact snapshot');
assert.equal(oldFreeze.files,oldSnapshot.length,'Earlier freeze file count mismatch');
const fixtureAllowedPaths=['apps/api/src/review-readable-retention.pg.test.ts',
 'apps/api/dist/review-readable-retention.pg.test.js','apps/api/dist/review-readable-retention.pg.test.js.map',
 'apps/api/dist/review-readable-retention.pg.test.d.ts','apps/api/dist/review-readable-retention.pg.test.d.ts.map'];
const fixtureChanges=changes(oldSnapshot,before),changedPaths=[...fixtureChanges.added,...fixtureChanges.modified,...fixtureChanges.removed].map(file=>file.path);
assert(changedPaths.length>0&&changedPaths.every(path=>fixtureAllowedPaths.includes(path)),'Only the exact readable-retention fixture and its build outputs may change between accepted snapshots');
for(const path of fixtureAllowedPaths.slice(0,2)){
 assert(oldSnapshot.some(file=>file.path===path)&&before.some(file=>file.path===path),`Required fixture source/build absent: ${path}`);
 assert(fixtureChanges.modified.some(file=>file.path===path),`Fixture correction must change its exact source/build: ${path}`);
}
for(const result of [focusedTests.working_files,fullApi,worker]){
 assert(Date.parse(result.started)>=oldFreezeTime,`${result.receipt} predates its retained verification freeze`);
 assert(Date.parse(result.finished)<=freezeTime,`${result.receipt} falls outside the earlier fixture-only correction window`);
}
assert(Date.parse(corrective.started)>=freezeTime,`${corrective.receipt} predates the corrected verification freeze`);
const sinkTitles=['NDJSON sink cannot be split by log injection','file sink repeat and concurrent processes retain one durable line per key',
 'replay of a complete pre-existing line still acknowledges only after file sync','size cap fails closed for new keys but permits replay of a full segment',
 'replay also detects a key in a legacy rotated segment'];
const sinkPattern=`--test-skip-pattern=^#79 (?:${sinkTitles.join('|')})$`;
assert(fullApi.args.includes(sinkPattern),'Full API run must retain only the five exact Windows sink exclusions');
assert.equal(fullApi.args.filter(arg=>arg.startsWith('--test-skip-pattern=')).length,1);
const sinkScope=json('sink-scope.json');assert.equal(sinkScope.baseline,baseline);assert.equal(sinkScope.unchanged,true);assert.equal(sinkScope.tests_unchanged,true);assert.equal(sinkScope.acceptance,false);
const api={status:'full_run_with_targeted_fixture_correction',full_run:fullApi,corrective,
 retained_full_run_failure:{title:retainedFailureTitle,reason:'Synthetic successful codex-review-file-v1 fixture omitted its required raw report.docx; production unchanged'},
 full_run_repeated_after_fixture_correction:false,aggregate_counts:null,
 excluded_windows_sink_tests:{argument:sinkPattern,titles:sinkTitles.map(title=>`#79 ${title}`),
  count:5,included_in_node_summary_skipped_count:false,acceptance:false,scope_record:'sink-scope.json'},
 result_note:'Composite evidence only: retain the full-run failure and its exact targeted correction; do not add counts or label a single complete API run as passed'};
const browserRuns={full_main:browser('browser-real'),desktop_components:browser('browser-ui'),controlled_inflight:browser('inflight-test')};

const database=json('database-final.json');assert.equal(database.runs,0);assert.equal(database.executions,0);assert.deepEqual(database.clones,[]);
for(const proof of migrationProofs)assert(database.schema?.some(row=>row.filename===proof.filename),`Final database schema does not include ${proof.filename}`);
const cleanup=json('database-cleanup-audit.json'),stopped=json('postgres-stop.json'),started=json('postgres-start.json');
const cluster=resolve(root,'.local/g03-postgres/data'),normalized=value=>resolve(value).toLowerCase();
for(const value of [cleanup.cluster,stopped.cluster,started.cluster])assert.equal(normalized(value),cluster.toLowerCase(),'Cleanup must identify this dedicated cluster');
assert.equal(String(cleanup.port),'15526');
assert.deepEqual(cleanup.databases,[{datname:'bb_g03_template_20261026'}]);assert.deepEqual(cleanup.other_client_sessions,[]);
assert.equal(cleanup.template_runs,0);assert.equal(cleanup.template_executions,0);
assert(Number.isSafeInteger(cleanup.postmaster_pid)&&cleanup.postmaster_pid>0);assert.equal(stopped.postmaster_pid,cleanup.postmaster_pid);
assert.equal(stopped.status_before.status,0);assert.equal(stopped.stop.status,0);assert.equal(stopped.status_after.status,3);
assert(Number.isFinite(Date.parse(started.started))&&Number.isFinite(Date.parse(cleanup.checked_at))&&Number.isFinite(Date.parse(stopped.finished)));
assert(Date.parse(cleanup.checked_at)>=Date.parse(started.started),'Cleanup audit predates this round PostgreSQL start');
assert(Date.parse(stopped.finished)>=Date.parse(cleanup.checked_at),'PostgreSQL stop predates this round cleanup audit');
assert.equal(database.server_version,cleanup.server_version,'Final database/audit PostgreSQL versions disagree');

const commandRuns=readdirSync(local).filter(name=>name.endsWith('.json')&&name!=='verification-summary.json').flatMap(name=>{
 const value=json(name);if(!value||typeof value!=='object'||!Object.hasOwn(value,'status')||!Array.isArray(value.args))return [];
 const log=name.replace(/\.json$/,'.log');assert(existsSync(join(local,log)),`Missing historical paired ${log}`);
 return [{receipt:name,log,...value}];
}).sort((a,b)=>String(a.started).localeCompare(String(b.started))||a.receipt.localeCompare(b.receipt));
const recordFiles=readdirSync(local).filter(name=>/\.(?:json|log)$/.test(name)&&name!=='verification-summary.json').sort().map(record);
const summary={synthetic:true,baseline_commit:baseline,generated_at:new Date().toISOString(),goal_complete:false,g03_complete:false,
 scope:'Exact private working-file registration, immutable multi-source claims, retention/purge serialization and protected reads',
 current_round_browser_claim:Object.values(browserRuns).some(run=>run.status==='passed'),
 new_adoption_executed:false,new_supplier_generation_accepted:false,supplemented_word_accepted:false,
 surcharge_decision:'B: necessary rework quoted separately; explicit surcharge confirmation before continuing',surcharge_formula:null,
 source_binding:{final_before:record('source-before.json'),final_after:record('source-after.json'),final_unchanged_files:after.length,current_files_match:true,
  verification_freeze:{record:record('verification-freeze.json'),...freeze},selected_test_window_validated:true,
  retained_verification_freeze:{record:record(oldFreezeName),snapshot:record(oldSnapshotName),...oldFreeze},
  fixture_only_correction:{allowed_paths:fixtureAllowedPaths,changes:fixtureChanges,production_changes:false},
  selected_test_receipts:[focusedTests.working_files,fullApi,worker,corrective].map(result=>({receipt:result.receipt,started:result.started,finished:result.finished,
   freeze:result===corrective?'verification-freeze.json':oldFreezeName})),
  per_command_source_hash_available:false,
  selected_receipt_scope_review:'Working-files/full API/worker bind the retained freeze; only the exact readable-retention fixture source/build changed, and its targeted correction binds the final freeze; final before/after and current files match',history},
 migration:{latest:migrate,proofs:migrationProofs,history:migrationRuns},builds,contracts:{...contracts,synthetic_examples:Number(examples[1]),internal_library_examples:Number(examples[2])},
 api,worker,focused_tests:focusedTests,browser:browserRuns,database,infrastructure_cleanup:{audit:cleanup,postgres:stopped},
 command_history:commandRuns,historical_failures_retained:commandRuns.filter(run=>run.status!==0||run.error),record_files:recordFiles,
 limits:['Synthetic cases and private bytes do not establish Word content or professional quality',
  'Only actual current-round receipts support browser results; prior browser counts are excluded',
  'Historical raw files whose parent content was already lost and which lack registry may remain diagnostic only',
  'Immutable database editor body lifecycle and general provider JSON pre-write intent remain separate gaps',
  'V1 only; no adopted successor input, surcharge formula, new business execution or supplemented Word acceptance',
  'The API evidence is a failed full run plus targeted fixture correction, not one complete passing run and not an additive pass total',
  'Skipped tests remain explicit; five exact Windows NDJSON sink titles are excluded by name and not included in the Node skipped count or sink acceptance',
  'No real supplier, Azure, PR, push or deployment acceptance']};
// Preserve an existing summary before replacing it.
const destination=join(local,'verification-summary.json');
if(existsSync(destination)){
 let n=1;while(existsSync(join(local,`verification-summary-history-${n}.json`)))n++;
 writeFileSync(join(local,`verification-summary-history-${n}.json`),readFileSync(destination),{flag:'wx'});
 // Include the newly retained prior summary in the collection inventory.
 summary.record_files.push(record(`verification-summary-history-${n}.json`));summary.record_files.sort((a,b)=>a.path.localeCompare(b.path));
}
writeFileSync(destination,JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({baseline_commit:baseline,api:{status:api.status,full_run:api.full_run.counts,corrective:api.corrective.counts},worker:worker.counts,
 browser:Object.fromEntries(Object.entries(browserRuns).map(([name,run])=>[name,run.status==='passed'?run.stats:run.status])),
 final_unchanged_files:after.length,preserved_failed_commands:summary.historical_failures_retained.length},null,2));
