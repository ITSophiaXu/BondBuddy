import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';

// The owner stages final sources before running this after archive.mjs.
const local=dirname(fileURLToPath(import.meta.url)),root=resolve(local,'../..');
assert.equal(local,resolve(root,'.local/supplement-multifile-request-20261027'));
const output=join(root,'docs/acceptance/desktop-ux-coverage-20261026/supplement-multifile-request');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const git=(...args)=>execFileSync('git',['-c',`safe.directory=${root.replaceAll('\\','/')}`,...args],{cwd:root,windowsHide:true,maxBuffer:64*1024*1024});
const json=path=>JSON.parse(readFileSync(path,'utf8'));
const manifest=json(join(output,'manifest.json'));
for(const entry of manifest){const bytes=readFileSync(join(output,entry.path));assert.equal(bytes.length,entry.bytes);
  assert.equal(sha(bytes),entry.sha256,`Archived evidence changed: ${entry.path}`);}
const summary=json(join(output,'summary.json')),selection=json(join(output,'selection.json'));
assert.equal(summary.version,'supplement-multifile-request-evidence-v1');
assert.equal(summary.adopted.source.before,selection.before);assert.equal(summary.adopted.source.after,selection.after);
const snapshot=`runs/${summary.adopted.source.after}/snapshot.json.gz`,beforeSnapshot=`runs/${summary.adopted.source.before}/snapshot.json.gz`;
const snapshotBytes=gunzipSync(readFileSync(join(output,snapshot))),beforeBytes=gunzipSync(readFileSync(join(output,beforeSnapshot)));
assert.equal(sha(snapshotBytes),summary.adopted.source.sha256);assert(snapshotBytes.equals(beforeBytes));
const frozenEntries=JSON.parse(snapshotBytes),frozen=new Map(frozenEntries.map(entry=>[entry.path,entry]));
assert.equal(frozenEntries.length,summary.adopted.source.entries);
for(const required of ['apps/worker/skills','knowledge/material-drafting']){
  assert(summary.adopted.source.roots.includes(required));assert(frozenEntries.some(entry=>entry.path.startsWith(`${required}/`)));
}
const expected=[...selection.staged_sources].sort();assert.deepEqual(expected,summary.adopted.source.staged_sources);
assert.equal(expected.length,summary.adopted.source.staged_source_count);
const selected=path=>/^(?:apps\/[^/]+\/(?:src\/|skills\/|package\.json$|tsconfig[^/]*\.json$)|packages\/|knowledge\/|db\/|python\/|package(?:-lock)?\.json$)/.test(path);
const cached=git('diff','--cached','--name-only','-z').toString('utf8').split('\0').filter(Boolean).filter(selected).sort();
assert.deepEqual(cached,expected,'Proof must cover precisely the owner-selected final staged sources');
const addedOrModified=new Set(git('diff','--cached','--name-only','-z','--diff-filter=AM').toString('utf8').split('\0').filter(Boolean));
const sources=[];
for(const path of cached){
  assert(addedOrModified.has(path),`Unexpected renamed/deleted staged source: ${path}`);
  const bytes=readFileSync(join(root,path)),entry=frozen.get(path);assert(entry,`Staged source was not in the final freeze: ${path}`);
  assert.equal(bytes.length,entry.bytes,`Working bytes changed after verification: ${path}`);
  assert.equal(sha(bytes),entry.sha256,`Working source changed after verification: ${path}`);
  const index=git('show',`:${path}`),object=git('rev-parse',`:${path}`).toString('utf8').trim();
  const filtered=git('-c','core.safecrlf=false','hash-object','--path',path,path).toString('utf8').trim();
  assert.equal(filtered,object,`Staged blob differs from actual Git-filtered working source: ${path}`);
  sources.push({path,working:{bytes:bytes.length,sha256:sha(bytes)},index:{bytes:index.length,sha256:sha(index),git_object:object},
    git_filtered_working_matches_index:true});
}
const proof={version:'supplement-multifile-request-sources-v1',head:git('rev-parse','HEAD').toString('utf8').trim(),
  snapshot,snapshot_sha256:sha(snapshotBytes),source_count:sources.length,
  normalization:'Index identity is compared with git hash-object --path using actual repository attributes/filters. Raw working bytes separately match the explicit final tested snapshot.',sources};
const proofPath=join(output,'sources.json');assert(!existsSync(proofPath),'Never overwrite a source proof');
assert(readFileSync(join(output,'source-proof.mjs')).equals(readFileSync(fileURLToPath(import.meta.url))),'Archived proof helper differs from the helper actually run');
writeFileSync(proofPath,JSON.stringify(proof,null,2)+'\n',{flag:'wx'});
const bytes=readFileSync(proofPath);assert(!manifest.some(entry=>entry.path==='sources.json'));
manifest.push({path:'sources.json',bytes:bytes.length,sha256:sha(bytes)});
writeFileSync(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
process.stdout.write(JSON.stringify({source_count:sources.length,manifest_entries:manifest.length,files:sources.map(entry=>entry.path)})+'\n');
