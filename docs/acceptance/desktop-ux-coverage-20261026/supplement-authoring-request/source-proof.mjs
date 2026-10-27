import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';

const local=dirname(fileURLToPath(import.meta.url)),root=resolve(local,'../..');
const output=join(root,'docs/acceptance/desktop-ux-coverage-20261026/supplement-authoring-request');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const git=(...args)=>execFileSync('git',['-c',`safe.directory=${root.replaceAll('\\','/')}`,...args],{cwd:root,windowsHide:true,maxBuffer:64*1024*1024});
const manifest=JSON.parse(readFileSync(join(output,'manifest.json'),'utf8'));
for(const entry of manifest){const bytes=readFileSync(join(output,entry.path));assert.equal(bytes.length,entry.bytes);assert.equal(sha(bytes),entry.sha256,`Archived evidence changed: ${entry.path}`);}
const summary=JSON.parse(readFileSync(join(output,'summary.json'),'utf8'));
const snapshot=`runs/${summary.adopted.source.after}/snapshot.json.gz`;
const snapshotBytes=gunzipSync(readFileSync(join(output,snapshot)));
assert.equal(sha(snapshotBytes),summary.adopted.source.sha256);
assert.equal(sha(snapshotBytes),'405336f08ecffc3409d5af283bfa34b901265c2214b3120b25a749c09851fac7');
const frozen=new Map(JSON.parse(snapshotBytes).map(entry=>[entry.path,entry]));
const selected=path=>/^apps\/[^/]+\/(?:src\/|package\.json$)/.test(path);
const cached=git('diff','--cached','--name-only','-z','--','apps').toString('utf8').split('\0').filter(Boolean).filter(selected).sort();
assert.equal(cached.length,11,'Proof must cover precisely the staged 11 app source/package files');
const addedOrModified=new Set(git('diff','--cached','--name-only','-z','--diff-filter=AM','--','apps').toString('utf8').split('\0').filter(Boolean));
const sources=[];
for(const path of cached){
  assert(addedOrModified.has(path),`Unexpected renamed/deleted staged source: ${path}`);
  const bytes=readFileSync(join(root,path)),entry=frozen.get(path);assert(entry,`Staged source was not in the final freeze: ${path}`);
  assert.equal(bytes.length,entry.bytes,`Working bytes changed after verification: ${path}`);
  assert.equal(sha(bytes),entry.sha256,`Working source changed after verification: ${path}`);
  const index=git('show',`:${path}`),object=git('rev-parse',`:${path}`).toString('utf8').trim();
  const filtered=git('-c','core.safecrlf=false','hash-object','--path',path,path).toString('utf8').trim();
  assert.equal(filtered,object,`Staged blob differs from actual Git-filtered working source: ${path}`);
  sources.push({path,working:{bytes:bytes.length,sha256:sha(bytes)},
    index:{bytes:index.length,sha256:sha(index),git_object:object},git_filtered_working_matches_index:true});
}
const proof={version:'supplement-authoring-request-sources-v1',head:git('rev-parse','HEAD').toString('utf8').trim(),
  snapshot,snapshot_sha256:sha(snapshotBytes),source_count:sources.length,
  normalization:'Index identity is compared with git hash-object --path using the actual repository attributes/filters. Raw working bytes separately match the final tested snapshot.',sources};
const proofPath=join(output,'sources.json');assert(!existsSync(proofPath),'Never overwrite a source proof');
writeFileSync(proofPath,JSON.stringify(proof,null,2)+'\n',{flag:'wx'});
assert(readFileSync(join(output,'source-proof.mjs')).equals(readFileSync(fileURLToPath(import.meta.url))),'Archived proof helper differs from the helper actually run');
const bytes=readFileSync(proofPath);assert(!manifest.some(entry=>entry.path==='sources.json'));
manifest.push({path:'sources.json',bytes:bytes.length,sha256:sha(bytes)});
writeFileSync(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
process.stdout.write(JSON.stringify({source_count:sources.length,manifest_entries:manifest.length,files:sources.map(entry=>entry.path)})+'\n');
