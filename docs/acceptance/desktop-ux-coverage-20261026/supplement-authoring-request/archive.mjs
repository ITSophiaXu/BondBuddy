import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {dirname,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync,gunzipSync} from 'node:zlib';

const local=dirname(fileURLToPath(import.meta.url)),root=resolve(local,'../..');
const output=join(root,'docs/acceptance/desktop-ux-coverage-20261026/supplement-authoring-request');
const beforeId='2026-10-26T20-18-07-895Z-source-before-44124-5fa0b297';
const afterId='2026-10-26T20-21-41-630Z-source-after-40160-3654a436';
const stopId='2026-10-26T20-21-46-654Z-pg-stop-20944-39581834';
const freezeHash='405336f08ecffc3409d5af283bfa34b901265c2214b3120b25a749c09851fac7';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=path=>JSON.parse(readFileSync(path,'utf8'));
const slash=path=>path.replaceAll('\\','/');
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
for(const id of readdirSync(runRoot).sort()){
  const directory=join(runRoot,id);assert(readdirSync(directory).includes('result.json'),`Unfinished invocation: ${id}`);
  const start=json(join(directory,'start.json')),result=json(join(directory,'result.json'));
  assert(result.finished && result.id===id && start.id===id,'Every invocation must have its own completed receipt');
  const commands=readdirSync(directory).filter(name=>/^command-\d+-result\.json$/.test(name)).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}))
    .map(name=>({path:`runs/${id}/${name}`,...json(join(directory,name))}));
  const log=readFileSync(join(directory,'run.log'));
  const version=join(local,start.script_version);
  assert.equal(sha(readFileSync(version)),start.script_sha256,`Verifier version changed: ${id}`);
  runs.push({id,mode:result.mode,status:result.status,started:start.started,finished:result.finished,
    script_sha256:start.script_sha256,script_version:start.script_version,commands,
    test_summaries:testSummaries(log),...(result.error?{error:result.error}:{}),_result:result,_log:log.toString('utf8')});
}
const byId=id=>{const run=runs.find(value=>value.id===id);assert(run,`Missing required invocation ${id}`);return run;};
const before=byId(beforeId),after=byId(afterId),stop=byId(stopId);
for(const run of [before,after,stop])assert.equal(run.status,0,`Required receipt failed: ${run.id}`);
assert.equal(before.mode,'source-before');assert.equal(after.mode,'source-after');assert.equal(stop.mode,'pg-stop');
assert.equal(stop._result.stopped,true);assert.equal(stop._result.database_audit.server.pid,18064);
assert(!existsSync(join(root,'.local/report-postgres/data/postmaster.pid')),'Archive only after the dedicated postmaster has stopped');
const beforeBytes=readFileSync(join(runRoot,beforeId,'snapshot.json')),afterBytes=readFileSync(join(runRoot,afterId,'snapshot.json'));
assert.equal(sha(beforeBytes),freezeHash);assert.equal(sha(afterBytes),freezeHash);
assert.equal(before._result.snapshot.sha256,freezeHash);assert.equal(after._result.snapshot.sha256,freezeHash);
assert.equal(after._result.snapshot.before,beforeId);assert.deepEqual(json(join(runRoot,beforeId,'snapshot.json')),json(join(runRoot,afterId,'snapshot.json')));
assert.equal(json(join(runRoot,afterId,'snapshot.json')).length,2327);
const comparison=json(join(runRoot,afterId,'comparison.json'));
assert.equal(comparison.before,beforeId);assert.equal(comparison.after,afterId);
assert.equal(comparison.before_sha256,freezeHash);assert.equal(comparison.after_sha256,freezeHash);
const latest=mode=>{const run=runs.filter(value=>value.mode===mode).at(-1);assert(run,`Missing ${mode}`);return run;};
const adoptedTests={};
for(const [mode,expected] of [['api-preparation',161],['worker-preparation',10],['worker-authoring-regression',20]]){
  const run=latest(mode);assert.equal(run.status,0,`Latest ${mode} failed; never silently adopt an older pass`);
  assert.equal(run.test_summaries.length,1,`Expected one separate test invocation summary for ${mode}`);
  const counts=run.test_summaries[0];assert.equal(counts.tests,expected);assert.equal(counts.pass,expected);assert.equal(counts.fail,0);assert.equal(counts.skipped,0);
  assert(Date.parse(run.started)>=Date.parse(before.started) && Date.parse(run.finished)<=Date.parse(after.finished),'Adopted tests must belong to the final freeze pair');
  adoptedTests[mode]={id:run.id,status:run.status,...counts};
}
const buildModes=[...new Set(runs.filter(run=>/(?:^|-)build$/.test(run.mode)||run.mode==='web-typecheck').map(run=>run.mode))];
const adoptedBuilds=Object.fromEntries(buildModes.map(mode=>{
  const successful=runs.filter(run=>run.mode===mode && run.status===0).at(-1);assert(successful,`No successful ${mode}`);
  return [mode,{id:successful.id,status:successful.status}];
}));
const closureFailures=runs.filter(run=>run.status!==0 && /Lease\s*\|\s*null/.test(run._log)).map(run=>run.id);
const snapshotFailures=runs.filter(run=>run.status!==0 && /Invalid private snapshot metadata/.test(run._log)).map(run=>run.id);
assert(closureFailures.length>0,'Retain the initial Lease closure typecheck failure');
assert(snapshotFailures.length>0,'Retain the initial invalid snapshot metadata test failures');
assert(Date.parse(stop.finished)>Date.parse(after.finished));
if(existsSync(output))assert(readdirSync(output).every(name=>name==='README.md'),'Never overwrite an existing archive');
mkdirSync(output,{recursive:true});
const manifest=[],raw=[];
const save=(path,bytes,extra={})=>{const target=join(output,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,bytes,{flag:'wx'});manifest.push({path,bytes:bytes.length,sha256:sha(bytes),...extra});};
const archiveFile=path=>{
  const bytes=readFileSync(path),name=slash(relative(local,path)),archive=`${name}.gz`;
  const compressed=gzipSync(bytes,{level:9});assert(gunzipSync(compressed).equals(bytes),'Gzip must roundtrip the exact original bytes');
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
const serializableRuns=runs.map(({_result,_log,...run})=>run);
const summary={version:'supplement-authoring-request-evidence-v1',
  scope:'M1 captured-work and material-delta request/workspace preparation. No adoption, V2 execution, quote, new model call or supplemental charge.',
  adopted:{tests:adoptedTests,builds:adoptedBuilds,source:{before:beforeId,after:afterId,entries:2327,sha256:freezeHash},
    pg_stop:{id:stopId,status:stop.status,stopped:true,pid:18064,database_audit:`runs/${stopId}/database-audit.json.gz`}},
  preserved_failures:{api_fixture_lease_closure:{invocations:closureFailures,note:'Initial API tsc Lease|null closure narrowing failure; retained separately from later successful builds.'},
    snapshot_redaction_fixture:{invocations:snapshotFailures,note:'Initial test rounds rejected synthetic-v1 private snapshot metadata. The fixture was corrected to synthetic_v1; these failed rounds remain separate and are not added to final pass counts.'}},
  counting:'Each invocation retains its own test_summaries; superseded failures and reruns are never summed into adopted counts.',
  runs:serializableRuns};
save('raw-files.json',Buffer.from(JSON.stringify(raw,null,2)+'\n'));
save('summary.json',Buffer.from(JSON.stringify(summary,null,2)+'\n'));
if(existsSync(join(output,'README.md'))){const bytes=readFileSync(join(output,'README.md'));manifest.push({path:'README.md',bytes:bytes.length,sha256:sha(bytes)});}
writeFileSync(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
process.stdout.write(JSON.stringify({output,archived_originals:raw.length,manifest_entries:manifest.length,runs:runs.length,
  failed_invocations:runs.filter(run=>run.status!==0).map(run=>run.id),adopted_tests:adoptedTests})+'\n');
