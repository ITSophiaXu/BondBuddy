import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';
const local=dirname(fileURLToPath(import.meta.url)),root=resolve(local,'../..');
const output=join(root,'docs/acceptance/desktop-ux-coverage-20261026/execution-work-boundaries');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const git=(...args)=>execFileSync('git',['-c',`safe.directory=${root.replaceAll('\\','/')}`,...args],{cwd:root,windowsHide:true});
const snapshot='runs/2026-10-26T19-51-02-020Z-source-before-50260-5fc60110/snapshot.json.gz';
const frozen=new Map(JSON.parse(gunzipSync(readFileSync(join(output,snapshot)))).map(entry=>[entry.path,entry]));
const files=git('diff','--cached','--name-only','--diff-filter=AM','--','apps/api/src','apps/worker/src').toString('utf8').trim().split(/\r?\n/);
assert(files.length>0);
const sources=[];
for(const path of files){
  const bytes=readFileSync(join(root,path)),before=frozen.get(path);assert(before,`Source was not frozen: ${path}`);
  assert.equal(bytes.length,before.bytes);assert.equal(hash(bytes),before.sha256,`Source changed after tests: ${path}`);
  const index=git('show',`:${path}`),object=git('rev-parse',`:${path}`).toString('utf8').trim();
  const filtered=git('-c','core.safecrlf=false','hash-object','--path',path,path).toString('utf8').trim();
  assert.equal(object,filtered,`Index does not match the Git-filtered tested source: ${path}`);
  sources.push({path,working:{bytes:bytes.length,sha256:hash(bytes)},index:{bytes:index.length,sha256:hash(index),git_object:object},git_filtered_working_matches_index:true});
}
writeFileSync(join(output,'sources.json'),JSON.stringify({snapshot,source_count:sources.length,sources},null,2)+'\n',{flag:'wx'});
writeFileSync(join(output,'source-proof.mjs'),readFileSync(fileURLToPath(import.meta.url)),{flag:'wx'});
const manifest=JSON.parse(readFileSync(join(output,'manifest.json'),'utf8'));
for(const path of ['README.md','sources.json','source-proof.mjs']){
  assert(!manifest.some(entry=>entry.path===path));const bytes=readFileSync(join(output,path));manifest.push({path,bytes:bytes.length,sha256:hash(bytes)});
}
writeFileSync(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
process.stdout.write(JSON.stringify({source_count:sources.length,manifest_entries:manifest.length})+'\n');
