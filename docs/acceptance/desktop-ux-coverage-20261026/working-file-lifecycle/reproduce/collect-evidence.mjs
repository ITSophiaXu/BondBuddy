import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {constants,copyFileSync,existsSync,lstatSync,mkdirSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {isAbsolute,join,relative,resolve} from 'node:path';

// One-shot collection into this new round only. Never reads earlier evidence.
const root=process.cwd(),local=resolve(root,'.local/working-file-lifecycle');
const target=resolve(root,'docs/acceptance/desktop-ux-coverage-20261026/working-file-lifecycle');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const within=(base,file)=>{const part=relative(base,resolve(file));assert(part&&!part.startsWith('..')&&!isAbsolute(part),`Outside ${base}: ${file}`);};
within(root,local);within(root,target);
assert(existsSync(join(target,'README.md')),'Write the current-round acceptance boundaries before collecting');
assert(readdirSync(target).every(name=>name==='README.md'),'Never overwrite an already collected evidence directory');
const summary=JSON.parse(readFileSync(join(local,'verification-summary.json'),'utf8'));
assert.equal(summary.baseline_commit,'a35034b3');assert.equal(summary.goal_complete,false);assert.equal(summary.g03_complete,false);
assert.equal(summary.source_binding.current_files_match,true);
assert.equal(summary.source_binding.selected_test_window_validated,true);
assert.equal(summary.infrastructure_cleanup.postgres.stop.status,0);assert.equal(summary.infrastructure_cleanup.postgres.status_after.status,3);
const after=JSON.parse(readFileSync(join(local,'source-after.json'),'utf8'));
assert.deepEqual(after,JSON.parse(readFileSync(join(local,'source-before.json'),'utf8')));
for(const file of after){const path=resolve(root,file.path);within(root,path);assert.equal(sha(readFileSync(path)),file.sha256,`Source/build changed after summary: ${file.path}`);}

const records=readdirSync(local).filter(name=>/\.(?:json|log)$/.test(name)&&name!=='verification-summary.json').sort();
assert.deepEqual(records,[...summary.record_files.map(file=>file.path)].sort(),'Records changed after summary; regenerate it before collecting');
for(const record of summary.record_files){
 const path=join(local,record.path);within(local,path);assert(lstatSync(path).isFile()&&!lstatSync(path).isSymbolicLink());
 const bytes=readFileSync(path);assert.equal(bytes.length,record.bytes,`Record size changed: ${record.path}`);assert.equal(sha(bytes),record.sha256,`Record changed: ${record.path}`);
}
const copied=[];
const copy=(source,destination)=>{
 within(local,source);within(target,destination);
 const stat=lstatSync(source);assert(stat.isFile()&&!stat.isSymbolicLink(),`Only regular files may be collected: ${source}`);
 assert(!/(?:private-bytes|\.docx$|\.pdf$)/i.test(relative(local,source)),'Private/generated document evidence is excluded');
 const bytes=readFileSync(source);mkdirSync(resolve(destination,'..'),{recursive:true});copyFileSync(source,destination,constants.COPYFILE_EXCL);
 assert.equal(sha(readFileSync(destination)),sha(bytes),`Copied evidence mismatch: ${source}`);
 copied.push({source,destination,sha256:sha(bytes)});
};
for(const name of [...records,'verification-summary.json'])copy(join(local,name),join(target,'records',name));
// Preserve this round's actual screenshots/assertions and all failed contexts.
// Their presence does not manufacture a passing browser claim in the summary.
for(const name of readdirSync(local)){
 const source=join(local,name);if(!lstatSync(source).isDirectory()||lstatSync(source).isSymbolicLink())continue;
 if(/^(?:browser-real|browser-ui|inflight-test)-evidence(?:-\d+)?$/.test(name)){
  for(const file of readdirSync(source))if(file.endsWith('.png')||file.endsWith('-assertions.json'))copy(join(source,file),join(target,'browser',name,file));
 }
 if(/^(?:browser-real|browser-ui|inflight-test)-results(?:-\d+)?$/.test(name)){
  const walk=directory=>{for(const item of readdirSync(directory,{withFileTypes:true})){
   const file=join(directory,item.name);assert(!item.isSymbolicLink(),'Symlink in browser results is excluded');
   if(item.isDirectory())walk(file);
   else if(item.isFile()&&(item.name==='error-context.md'||item.name.endsWith('.png')))copy(file,join(target,'records','browser-results',name,relative(source,file)));
  }};walk(source);
 }
}
for(const name of ['verify.mjs','summarize.mjs','collect-evidence.mjs','sink-scope.mjs','audit-evidence.mjs'])copy(join(local,name),join(target,'reproduce',name));
// The main task may supply a current-round cleanup driver. Do not copy its old-round counterpart.
if(existsSync(join(local,'audit-stop.mjs')))copy(join(local,'audit-stop.mjs'),join(target,'reproduce','audit-stop.mjs'));
for(const item of copied)assert.equal(sha(readFileSync(item.source)),item.sha256,`Evidence changed during collection: ${item.source}`);
writeFileSync(join(target,'.gitattributes'),'# Preserve exact recorded bytes and manifest hashes.\n* -text\nrecords/** -diff\n*.png binary\n',{flag:'wx'});
const files=[];
const walk=directory=>{for(const item of readdirSync(directory,{withFileTypes:true})){
 const file=join(directory,item.name);assert(!item.isSymbolicLink(),'Symlink in collected evidence');
 if(item.isDirectory())walk(file);
 else if(item.isFile()){const bytes=readFileSync(file);files.push({path:relative(target,file).replaceAll('\\','/'),bytes:bytes.length,sha256:sha(bytes)});}
}};walk(target);files.sort((a,b)=>a.path.localeCompare(b.path));
assert(files.every(file=>!/(?:private-bytes|\.docx$|\.pdf$)/i.test(file.path)));
writeFileSync(join(target,'manifest.json'),JSON.stringify({synthetic:true,baseline_commit:'a35034b3',
 current_round_browser_claim:summary.current_round_browser_claim,includes_private_byte_store:false,includes_generated_word:false,files},null,2)+'\n',{flag:'wx'});
console.log(`Collected ${files.length} current-round evidence files; prior rounds, private-byte stores and generated Word/PDF are excluded.`);
