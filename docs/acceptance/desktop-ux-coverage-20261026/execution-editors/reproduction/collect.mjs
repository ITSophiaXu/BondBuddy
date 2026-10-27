import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {dirname,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// Collection only. No database, subprocess, deletion, overwrite or test execution.
const local=dirname(fileURLToPath(import.meta.url)),root=resolve(local,'../..');
const destination=resolve(root,'docs/acceptance/desktop-ux-coverage-20261026/execution-editors');
assert.equal(local,resolve(root,'.local/execution-editors-20261027'));
assert(!existsSync(destination),'Never overwrite an acceptance archive');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const slash=path=>path.replaceAll('\\','/'),json=path=>JSON.parse(readFileSync(path,'utf8'));
const runs=join(local,'runs'),archiveRun=(id,path)=>`records/runs/${id}/${path}`;
function inventory(directory){
  const paths=[];
  function walk(current){for(const item of readdirSync(current,{withFileTypes:true})){
    const path=join(current,item.name);assert(!item.isSymbolicLink(),`Refuse symlink ${path}`);
    if(item.isDirectory())walk(path);else{assert(item.isFile());paths.push(slash(relative(directory,path)));}
  }}
  walk(directory);return paths.sort();
}
const plan=new Map();
function copied(source,path){assert(!plan.has(path));plan.set(path,{source:slash(relative(root,source)),bytes:readFileSync(source)});}
function generated(path,value){assert(!plan.has(path));plan.set(path,{source:null,generated_by:slash(relative(root,fileURLToPath(import.meta.url))),
  bytes:Buffer.from(typeof value==='string'?value:JSON.stringify(value,null,2)+'\n')});}
function metrics(raw){
  const log=raw.replace(/\x1b\[[0-9;]*m/g,''),summaries=[];let current;
  for(const line of log.split(/\r?\n/)){
    const match=line.match(/^(?:ℹ|#)\s+(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\s+(\d+(?:\.\d+)?)\s*$/);
    if(!match)continue;if(match[1]==='tests'){if(current)summaries.push(current);current={};}
    assert(current);assert(!(match[1] in current));current[match[1]]=Number(match[2]);
  }
  if(current)summaries.push(current);
  for(const block of summaries)for(const key of ['tests','pass','fail','cancelled','skipped'])assert(Number.isInteger(block[key]));
  return {node_summaries:summaries,counts:summaries.length===1?summaries[0]:null,
    example_lines:log.split(/\r?\n/).filter(line=>/^validated \d+ /i.test(line)),
    skipped_titles:log.split(/\r?\n/).filter(line=>line.includes('# SKIP'))};
}
const rawFiles=inventory(runs);
for(const path of rawFiles)copied(join(runs,path),`records/runs/${path}`);
const invocations=readdirSync(runs,{withFileTypes:true}).map(item=>{
  assert(item.isDirectory()&&!item.isSymbolicLink());const id=item.name,directory=join(runs,id);
  assert(existsSync(join(directory,'result.json')),`Incomplete invocation ${id}`);
  const start=json(join(directory,'start.json')),result=json(join(directory,'result.json'));
  assert.equal(start.id,id);assert.equal(result.id,id);assert.equal(start.mode,result.mode);assert([0,1].includes(result.status));
  const version=resolve(local,start.script_version);assert(version.startsWith(join(local,'versions')+'/')||version.startsWith(join(local,'versions')+'\\'));
  assert.equal(sha(readFileSync(version)),start.script_sha256);
  const commandFiles=readdirSync(directory).filter(name=>/^command-\d+-result\.json$/.test(name)).sort();
  const entry={id,mode:start.mode,status:result.status,started:start.started,finished:result.finished,
    start:archiveRun(id,'start.json'),receipt:archiveRun(id,'result.json'),log:archiveRun(id,'run.log'),script_sha256:start.script_sha256,
    commands:commandFiles.map(name=>({record:archiveRun(id,name),...json(join(directory,name))})),
    ...metrics(readFileSync(join(directory,'run.log'),'utf8')),aggregate:null};
  const browserPath=join(directory,'browser-editor/results.json');
  if(existsSync(browserPath)){const browser=json(browserPath);entry.browser_stats=browser.stats;entry.browser_errors=browser.errors;entry.browser_results=archiveRun(id,'browser-editor/results.json');}
  return entry;
}).sort((a,b)=>a.id.localeCompare(b.id));
const result=entry=>json(join(runs,entry.id,'result.json'));
const latest=mode=>{const entry=invocations.filter(item=>item.mode===mode).at(-1);assert(entry,`Missing ${mode}`);return entry;};
const freezes=new Map();
for(const entry of invocations.filter(item=>['source-before','source-after'].includes(item.mode))){
  assert.equal(entry.status,0);const receipt=result(entry),bytes=readFileSync(join(runs,entry.id,'snapshot.json')),snapshot=JSON.parse(bytes);
  assert.equal(sha(bytes),receipt.snapshot.sha256);assert.equal(snapshot.length,receipt.snapshot.files);
  assert.equal(new Set(snapshot.map(item=>item.path)).size,snapshot.length);
  for(const item of snapshot){assert(!item.path.startsWith('../')&&!item.path.startsWith('/'));assert.match(item.sha256,/^[a-f0-9]{64}$/);}
  freezes.set(entry.id,{entry,receipt,snapshot});
}
const pairs=invocations.filter(entry=>entry.mode==='source-after').map((entry,index)=>{
  const after=freezes.get(entry.id),before=freezes.get(after.receipt.snapshot.before);assert(before);assert.equal(before.entry.mode,'source-before');
  assert.deepEqual(before.snapshot,after.snapshot);assert(before.entry.id<entry.id);
  return {round:index+1,before:before.entry.id,after:entry.id,files:after.snapshot.length,equal:true,sha256:after.receipt.snapshot.sha256,
    before_snapshot:archiveRun(before.entry.id,'snapshot.json'),after_snapshot:archiveRun(entry.id,'snapshot.json'),
    comparison:archiveRun(entry.id,'comparison.json'),aggregate:null};
});
assert(pairs.length>0);assert.equal(pairs.length,invocations.filter(entry=>entry.mode==='source-before').length);
for(let i=1;i<pairs.length;i++)assert(pairs[i-1].after<pairs[i].before,'Overlapping freeze rounds');
const finalFreeze=freezes.get(pairs.at(-1).after),actual=[];
for(const directory of finalFreeze.receipt.snapshot.roots)for(const path of inventory(resolve(root,directory))){
  const name=`${directory}/${path}`,bytes=readFileSync(resolve(root,name));actual.push({path:name,bytes:bytes.length,sha256:sha(bytes)});
}
for(const item of finalFreeze.snapshot.filter(item=>!finalFreeze.receipt.snapshot.roots.some(dir=>item.path.startsWith(dir+'/')))){
  const bytes=readFileSync(resolve(root,item.path));actual.push({path:item.path,bytes:bytes.length,sha256:sha(bytes)});
}
actual.sort((a,b)=>a.path.localeCompare(b.path));assert.deepEqual(actual,finalFreeze.snapshot,'Current source/build differs from final freeze');
const transitions=pairs.slice(1).map((pair,index)=>{
  const before=new Map(freezes.get(pairs[index].after).snapshot.map(item=>[item.path,item]));
  const after=new Map(freezes.get(pair.before).snapshot.map(item=>[item.path,item]));
  return {from_round:index+1,to_round:index+2,changes:[...new Set([...before.keys(),...after.keys()])].sort()
    .filter(path=>before.get(path)?.sha256!==after.get(path)?.sha256||before.get(path)?.bytes!==after.get(path)?.bytes)
    .map(path=>({path,before:before.get(path)??null,after:after.get(path)??null}))};
});
const adopted=['api-editor','api-regression','worker-editor','worker-regression','web-cache','contracts-check','browser-editor'].map(mode=>{
  const entry=latest(mode);assert.equal(entry.status,0,`Final ${mode} failed`);
  if(mode==='browser-editor'){assert(entry.browser_stats);assert.equal(entry.browser_stats.expected,19);assert.equal(entry.browser_stats.skipped,0);
    assert.equal(entry.browser_stats.unexpected,0);assert.equal(entry.browser_stats.flaky,0);assert.deepEqual(entry.browser_errors,[]);}
  else{assert(entry.counts);assert.equal(entry.counts.fail,0);assert.equal(entry.counts.cancelled,0);}
  const pair=pairs.find(pair=>Date.parse(entry.started)>=Date.parse(freezes.get(pair.before).entry.finished)
    &&Date.parse(entry.finished)<=Date.parse(freezes.get(pair.after).entry.started));
  assert(pair,`Selected result outside a complete freeze ${mode}`);return {...entry,source_round:pair.round};
});
for(const mode of ['contracts-build','api-build','worker-build','web-typecheck','migrate'])assert.equal(latest(mode).status,0);
const stopped=latest('pg-stop');assert.equal(stopped.status,0);assert.equal(stopped.id,invocations.at(-1).id);
const stop=result(stopped);assert.equal(stop.stopped,true);assert(!existsSync(join(root,'.local/editor-postgres/data/postmaster.pid')));
const audit=stop.database_audit;assert.equal(audit.database,'bb_execution_editor_template_20261027');assert.equal(audit.server.port,15530);
assert.equal(audit.server.server_user,'bb_editor_test');assert.deepEqual(audit.clones,[]);assert.deepEqual(audit.other_clients,[]);
for(const [table,count] of Object.entries(audit.counts))assert.equal(count,['bb_users','bb_projects','bb_input_revisions','bb_platform_principals'].includes(table)?1:0);
assert.equal(audit.platform_seed.migration_sha256,'1cfd11c047e3dbee3328ba9caabd5fca7e55f208cb278c6ce85f8d1126e772d0');
for(const path of inventory(join(local,'versions')))copied(join(local,'versions',path),`reproduction/versions/${path}`);
for(const name of ['verify.mjs','playwright.config.mjs','collect.mjs'])copied(join(local,name),`reproduction/${name}`);
copied(join(local,'README.md'),'README.md');generated('.gitattributes','* -text\n');
generated('summary.json',{schemaVersion:1,date:'2026-10-27',base_commit:'cc6559e5b2e9411a30ce1d2700577b216381ca2e',
  branch:'codex/desktop-ux-coverage-20261026',goal_status:'active',g03_status:'incomplete',synthetic:true,
  collector_node_version:process.version,python_freeze_scope:'Existing Python converter sources are outside these before/after snapshots; the tests execute the configured local Python runtime and real conversion.',
  invocations,adopted_results:adopted,source_pairs:pairs,source_transitions:transitions,
  failed_invocations:invocations.filter(entry=>entry.status!==0).map(entry=>({id:entry.id,mode:entry.mode,counts:entry.counts,browser_stats:entry.browser_stats??null,log:entry.log})),
  raw_record_files:rawFiles.length,database_audit:audit,stop_receipt:stopped.receipt,aggregate:null});
const entries=[...plan].map(([path,item])=>({path,bytes:item.bytes.length,sha256:sha(item.bytes),source:item.source,
  ...(item.generated_by?{generated_by:item.generated_by}:{})})).sort((a,b)=>a.path.localeCompare(b.path));
const manifest={schemaVersion:1,files:entries.length,entries};
for(const [path,item] of plan){const target=join(destination,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,item.bytes,{flag:'wx'});}
writeFileSync(join(destination,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
assert.deepEqual(inventory(destination),[...entries.map(entry=>entry.path),'manifest.json'].sort());
for(const entry of entries){const bytes=readFileSync(join(destination,entry.path));assert.equal(bytes.length,entry.bytes);assert.equal(sha(bytes),entry.sha256);}
process.stdout.write(JSON.stringify({destination,files:entries.length+1,manifest_entries:entries.length,raw_record_files:rawFiles.length,invocations:invocations.length,
  adopted:adopted.map(entry=>({mode:entry.mode,counts:entry.counts,browser_stats:entry.browser_stats??null,source_round:entry.source_round})),source_pairs:pairs},null,2)+'\n');
