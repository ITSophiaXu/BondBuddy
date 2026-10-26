import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {dirname,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync,gunzipSync} from 'node:zlib';

// Run only after the owner has supplied final receipts, frozen tests and stopped
// the dedicated postmaster: node archive.mjs <selection.json>.
const local=dirname(fileURLToPath(import.meta.url)),root=resolve(local,'../..');
assert.equal(local,resolve(root,'.local/review-body-deletion-20261027'));
const output=join(root,'docs/acceptance/desktop-ux-coverage-20261026/review-body-deletion');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=path=>JSON.parse(readFileSync(path,'utf8'));
const slash=path=>path.replaceAll('\\','/');
const selectionPath=process.argv[2];assert(selectionPath,'Owner-supplied final selection.json is required');
const selectionBytes=readFileSync(resolve(selectionPath)),selection=JSON.parse(selectionBytes);
for(const key of ['before','after','pg_stop'])assert.match(selection[key],/^[A-Za-z0-9-]+$/,`Invalid explicit ${key} receipt`);
assert(selection.adopted_test_modes&&typeof selection.adopted_test_modes==='object'&&!Array.isArray(selection.adopted_test_modes));
assert(Object.keys(selection.adopted_test_modes).length>0,'Adopted test modes must be explicit');
assert(Array.isArray(selection.adopted_build_modes)&&selection.adopted_build_modes.length>0,'Adopted build modes must be explicit');
assert(Array.isArray(selection.staged_sources)&&selection.staged_sources.length>0,'Exact staged source paths must be explicit');
assert.equal(new Set(selection.staged_sources).size,selection.staged_sources.length,'Staged source selection contains duplicates');
assert(selection.staged_sources.every(path=>typeof path==='string'&&!path.includes('..')&&!path.includes('\\')&&!path.startsWith('/')));

const runRoot=join(local,'runs'),runs=[];
function testSummaries(bytes){
  const blocks=[];let current;
  const text=bytes.toString('utf8').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
  for(const line of text.split(/\r?\n/)){
    const match=/^(?:# |ℹ )(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\s+([\d.]+)\s*$/.exec(line);
    if(!match)continue;
    if(match[1]==='tests'){current={};blocks.push(current);}
    if(current)current[match[1]]=Number(match[2]);
  }
  return blocks;
}
for(const item of readdirSync(runRoot,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
  assert(item.isDirectory()&&!item.isSymbolicLink(),'Every run entry must be a real invocation directory');
  const id=item.name,directory=join(runRoot,id);
  assert(existsSync(join(directory,'result.json')),`Unfinished controlled invocation: ${id}`);
  const start=json(join(directory,'start.json')),result=json(join(directory,'result.json'));
  assert(result.finished&&result.id===id&&start.id===id&&start.mode===result.mode,'Invocation receipts must match');
  assert([0,1].includes(result.status),'Unknown controlled invocation status');
  const commandNames=readdirSync(directory).filter(name=>/^command-\d+-start\.json$/.test(name))
    .sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
  const commands=commandNames.map(name=>{
    const resultName=name.replace('-start.json','-result.json');
    assert(existsSync(join(directory,resultName)),`Unfinished command ${id}/${name}`);
    const begin=json(join(directory,name)),end=json(join(directory,resultName));
    assert.equal(begin.started,end.started);assert.equal(begin.exe,end.exe);assert.deepEqual(begin.args,end.args);
    return {path:`runs/${id}/${resultName}`,...end};
  });
  assert.equal(commands.length,readdirSync(directory).filter(name=>/^command-\d+-result\.json$/.test(name)).length);
  const log=readFileSync(join(directory,'run.log')),version=join(local,start.script_version);
  assert.equal(sha(readFileSync(version)),start.script_sha256,`Preserved verifier version changed: ${id}`);
  runs.push({id,mode:result.mode,status:result.status,started:start.started,finished:result.finished,
    script_sha256:start.script_sha256,script_version:start.script_version,commands,test_summaries:testSummaries(log),
    ...(result.error?{error:result.error}:{}),_start:start,_result:result});
}
const byId=id=>{const run=runs.find(value=>value.id===id);assert(run,`Missing required invocation ${id}`);return run;};
const before=byId(selection.before),after=byId(selection.after),stop=byId(selection.pg_stop);
for(const run of [before,after,stop])assert.equal(run.status,0,`Required receipt failed: ${run.id}`);
assert.equal(before.mode,'source-before');assert.equal(after.mode,'source-after');assert.equal(stop.mode,'pg-stop');
assert.equal(stop._result.stopped,true);
const server=stop._result.database_audit.server;
assert(Number.isSafeInteger(server.pid)&&server.pid>0,'Stop audit must identify its exact dedicated postmaster');
const launched=runs.filter(run=>['pg-start-direct','pg-recover-direct'].includes(run.mode)&&run.status===0
  &&Date.parse(run.finished)<=Date.parse(stop.started)).at(-1);assert(launched,'Stop must follow a recorded successful direct launch');
assert.equal(server.pid,launched._result.server.pid);assert.equal(server.server_started_at,launched._result.server.server_started_at);
assert.equal(stop._start.cluster,launched._start.cluster);assert.equal(stop._start.port,launched._start.port);
assert.equal(resolve(stop._start.cluster),resolve(root,'.local/report-postgres/data'),'Stop receipt refers to another cluster');
assert(!existsSync(join(stop._start.cluster,'postmaster.pid')),'Archive only after the dedicated postmaster has stopped');

const beforeBytes=readFileSync(join(runRoot,before.id,'snapshot.json')),afterBytes=readFileSync(join(runRoot,after.id,'snapshot.json'));
const freezeHash=sha(beforeBytes),frozen=JSON.parse(beforeBytes);
assert.equal(sha(afterBytes),freezeHash);assert.deepEqual(JSON.parse(afterBytes),frozen);
assert.equal(before._result.snapshot.sha256,freezeHash);assert.equal(after._result.snapshot.sha256,freezeHash);
assert.equal(before._result.snapshot.files,frozen.length);assert.equal(after._result.snapshot.files,frozen.length);
assert.equal(after._result.snapshot.before,before.id);
assert.deepEqual(before._result.snapshot.roots,after._result.snapshot.roots);
for(const required of ['apps/worker/skills','knowledge/material-drafting'])assert(before._result.snapshot.roots.includes(required),`Freeze omitted ${required}`);
const frozenPaths=new Set(frozen.map(entry=>entry.path));
for(const path of selection.staged_sources)assert(frozenPaths.has(path),`Selected staged source missing from freeze: ${path}`);
const comparison=json(join(runRoot,after.id,'comparison.json'));
assert.deepEqual(comparison,{before:before.id,after:after.id,before_sha256:freezeHash,after_sha256:freezeHash});
assert(Date.parse(after.started)>Date.parse(before.finished),'Freeze pair must be ordered');
// Every adopted test finishes before after.started (checked below). The final
// comparison reads source/build files only; PG data and evidence output are
// outside those roots. Its hashing and the independent owned-server stop may
// overlap after all tests. Preserve the actual timestamps instead of inventing
// a sequential receipt or restarting an already stopped server for ordering.
assert(Date.parse(stop.started)>=Date.parse(after.started),'PostgreSQL stop must follow all tests and the start of final source comparison');

const latest=mode=>{const run=runs.filter(value=>value.mode===mode).at(-1);assert(run,`Missing ${mode}`);return run;};
const adoptedTests={};
for(const [mode,expected] of Object.entries(selection.adopted_test_modes)){
  // An integer retains the original zero-skip interface. Explicit objects keep
  // expected skips separate from passes and preserve the runner's total count.
  const expectedCounts=typeof expected==='number'?{tests:expected,pass:expected,skipped:0}:expected;
  assert(expectedCounts&&typeof expectedCounts==='object'&&!Array.isArray(expectedCounts),`Invalid expected counts for ${mode}`);
  assert.deepEqual(Object.keys(expectedCounts).sort(),['pass','skipped','tests'],`Expected only tests/pass/skipped for ${mode}`);
  for(const key of ['tests','pass','skipped'])assert(Number.isSafeInteger(expectedCounts[key])&&expectedCounts[key]>=0,
    `Invalid expected ${key} count for ${mode}`);
  assert(expectedCounts.tests>0,`Expected at least one test for ${mode}`);
  assert.equal(expectedCounts.tests,expectedCounts.pass+expectedCounts.skipped,`Expected total must equal passes plus skips for ${mode}`);
  const run=latest(mode);assert.equal(run.status,0,`Latest ${mode} failed; never silently adopt an older pass`);
  assert.equal(run.test_summaries.length,1,`Expected one independent test summary for ${mode}`);
  const counts=run.test_summaries[0];
  for(const key of ['tests','pass','skipped'])assert.equal(counts[key],expectedCounts[key],`${mode} ${key} does not match explicit expected counts`);
  assert.equal(counts.tests,counts.pass+counts.skipped,`${mode} total must equal actual passes plus skips`);
  for(const key of ['fail','cancelled','todo'])assert.equal(counts[key],0,`${mode} ${key} must be zero`);
  assert(Date.parse(run.started)>=Date.parse(before.finished)&&Date.parse(run.finished)<=Date.parse(after.started),
    `Adopted ${mode} must belong to the explicit final freeze pair`);
  adoptedTests[mode]={id:run.id,status:run.status,...counts};
}
const adoptedBuilds={};
for(const mode of selection.adopted_build_modes){
  assert(typeof mode==='string'&&(/(?:^|-)build$/.test(mode)||mode==='web-typecheck'),'Unexpected build mode');
  assert(!Object.hasOwn(adoptedBuilds,mode),'Duplicate adopted build mode');
  const run=latest(mode);assert.equal(run.status,0,`Latest ${mode} failed`);
  assert(run.commands.length>0&&run.commands.every(command=>command.status===0),`Build command did not pass: ${mode}`);
  assert(Date.parse(run.finished)<=Date.parse(after.started),'Adopted build must precede the final comparison');
  adoptedBuilds[mode]={id:run.id,status:run.status};
}

if(existsSync(output))assert(readdirSync(output).every(name=>name==='README.md'),'Never overwrite an existing evidence archive');
mkdirSync(output,{recursive:true});
const manifest=[],raw=[];
const save=(path,bytes,extra={})=>{const target=join(output,path);mkdirSync(dirname(target),{recursive:true});
  writeFileSync(target,bytes,{flag:'wx'});manifest.push({path,bytes:bytes.length,sha256:sha(bytes),...extra});};
const archiveFile=path=>{
  const bytes=readFileSync(path),name=slash(relative(local,path)),archive=`${name}.gz`;
  const compressed=gzipSync(bytes,{level:9});assert(gunzipSync(compressed).equals(bytes),'Gzip must roundtrip exact original bytes');
  save(archive,compressed,{source:{path:slash(relative(root,path)),bytes:bytes.length,sha256:sha(bytes)}});
  raw.push({path:name,bytes:bytes.length,sha256:sha(bytes),archive});
};
function walk(directory){for(const entry of readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
  const path=join(directory,entry.name);assert(!entry.isSymbolicLink(),'Evidence cannot silently skip a symlink');
  if(entry.isDirectory())walk(path);else{assert(entry.isFile());archiveFile(path);}
}}
walk(runRoot);walk(join(local,'versions'));
for(const name of ['verify.mjs','archive.mjs','source-proof.mjs','playwright.config.mjs']){
  const path=join(local,name);archiveFile(path);save(name,readFileSync(path),{source:slash(relative(root,path))});
}
save('selection.json',selectionBytes,{source:slash(relative(root,resolve(selectionPath)))});
const serializableRuns=runs.map(({_start,_result,...run})=>run);
const failures=serializableRuns.filter(run=>run.status!==0);
const summary={version:'review-body-deletion-evidence-v1',
  scope:'Delete four legacy/canonical review editor/report SQL-body copies after the actual user-deleted-project window, with exact metadata-only receipts and guards against resurrection. No adoption, executable V2, quote, provider call or supplemental charge.',
  verification_order:{source_after:{started:after.started,finished:after.finished},pg_stop:{started:stop.started,finished:stop.finished},
    overlap_ms:Math.max(0,Math.min(Date.parse(after.finished),Date.parse(stop.finished))-Math.max(Date.parse(after.started),Date.parse(stop.started))),
    reason:'All adopted tests finished before both operations. Source comparison performs no database I/O and excludes the PostgreSQL cluster and per-run evidence directories; it may overlap the independent owned-server stop. Original timestamps and receipts are unchanged.'},
  adopted:{tests:adoptedTests,builds:adoptedBuilds,
    source:{before:before.id,after:after.id,entries:frozen.length,sha256:freezeHash,roots:before._result.snapshot.roots,
      staged_source_count:selection.staged_sources.length,staged_sources:[...selection.staged_sources].sort()},
    pg_stop:{id:stop.id,status:stop.status,stopped:true,pid:server.pid,server_started_at:server.server_started_at,
      database_audit:`runs/${stop.id}/database-audit.json.gz`}},
  preserved_failures:failures.map(run=>({id:run.id,mode:run.mode,status:run.status,...(run.error?{error:run.error}:{}),
    note:'Independent failed controlled invocation; retained separately and excluded from adopted pass counts.'})),
  limitations:[
    'This archive preserves controlled verifier invocations and does not claim to record every editing or read-only audit command.',
    'This slice clears only four review SQL-body tables. Other project plaintext copies, input adoption, executable V2, supplemental pricing and the complete pause/supplement/resume/Word journey remain unfinished.',
    'Synthetic private bytes and private PostgreSQL fixtures are test evidence; no real provider run, production data, cloud Blob service or supplemental billing execution is represented.'
  ],
  counting:'Each controlled invocation retains its own commands and test_summaries. Superseded failures and reruns are never summed into adopted counts.',
  selection:'selection.json',runs:serializableRuns};
save('raw-files.json',Buffer.from(JSON.stringify(raw,null,2)+'\n'));
save('summary.json',Buffer.from(JSON.stringify(summary,null,2)+'\n'));
if(existsSync(join(output,'README.md'))){const bytes=readFileSync(join(output,'README.md'));manifest.push({path:'README.md',bytes:bytes.length,sha256:sha(bytes)});}
writeFileSync(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
process.stdout.write(JSON.stringify({output,archived_originals:raw.length,manifest_entries:manifest.length,runs:runs.length,
  failed_invocations:failures.map(run=>run.id),adopted_tests:adoptedTests,source_entries:frozen.length,source_sha256:freezeHash})+'\n');
