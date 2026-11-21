import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {digest} from '@bondbuddy/api/data';
import {readCommittedEditorOperations} from './committed-editor-files.js';

test('committed operations survive a missing or stale flat mirror; corrupt manifest fails closed',async t=>{
  const root=await mkdtemp(join(tmpdir(),'bb-editor-receipt-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const bytes=Buffer.from('{"operations":["committed"]}'),hash=digest(bytes);await mkdir(join(root,'.operations.json.objects'));
  await writeFile(join(root,'.operations.json.objects',hash+'.json'),bytes);
  const manifest={version:'word-edit-manifest-v1',operations_object_path:'.operations.json.objects/'+hash+'.json',operations_sha256:hash};
  await writeFile(join(root,'operations.json.manifest.json'),JSON.stringify(manifest));
  assert.deepEqual(await readCommittedEditorOperations(root),bytes);
  await writeFile(join(root,'operations.json'),'stale');assert.deepEqual(await readCommittedEditorOperations(root),bytes);
  await writeFile(join(root,'operations.json.manifest.json'),JSON.stringify({...manifest,operations_sha256:'a'.repeat(64)}));
  await assert.rejects(readCommittedEditorOperations(root),/HASH_MISMATCH/);
});
