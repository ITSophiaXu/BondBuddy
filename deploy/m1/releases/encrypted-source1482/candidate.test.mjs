import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {validateBusinessOverlay,businessOverlayFiles,businessOverlayCompose} from '../../../tencent-elasticity/business-overlay.mjs';
import {bootstrapUserData} from '../../../tencent-elasticity/bootstrap.mjs';
const read=p=>readFileSync(new URL(p,import.meta.url)),json=p=>JSON.parse(read(p));
const sha=b=>createHash('sha256').update(b).digest('hex');
const descriptor=json('./descriptor.json'),archive=read('./overlay.tar.gz'),old=json('../managed-db1484/descriptor.json');
const url='https://synthetic.blob.core.windows.net/bondbuddy-private/synthetic?sp=r&sr=b&se=2099-01-01T00:00:00Z';
test('current permissions remain byte-identical except exact encrypted-source error mapping',()=>{
 validateBusinessOverlay({...descriptor,url},descriptor.sha256);
 const files=businessOverlayFiles(archive,descriptor),before=businessOverlayFiles(read('../managed-db1484/overlay.tar.gz'),old);
 assert.equal(files.size,78);assert.equal(before.size,74);let retained=0;
 for(const [path,bytes] of before){
  if(path.endsWith('/file-authoring-stage.js'))assert.equal(files.get(path).toString(),bytes.toString().replace("code: 'MATERIAL_UNREADABLE'",'code: error.code'));
  else{assert.deepEqual(files.get(path),bytes);retained++;}
 }
 assert.equal(retained,72);
 for(const role of ['authoring','review']){
  assert.ok(files.has(role+'/apps/worker/dist/managed-database-preflight.js'));
  assert.ok(files.has(role+'/apps/api/dist/evidence-gate.js'));
  assert.ok(files.has(role+'/apps/worker/dist/file-authoring-format.js'));
  assert.ok(files.has(role+'/python/bondbuddy_file_authoring/fixed_edit.py'));
  assert.ok(!files.has(role+'/packages/contracts/dist/integrity-site-availability.js'));
 }
 const base=read('../../../tencent-elasticity/compose.yaml').toString(),directory='/opt/bondbuddy/business-overlays/'+descriptor.sha256;
 const composed=businessOverlayCompose(base,directory,descriptor.files);
 assert.equal(composed.split('\n').filter(l=>!l.includes(directory+'/')).join('\n'),base);
 assert.equal(composed.split('\n').filter(l=>l.includes(directory+'/')).length,78);
});
test('strict version, path, count, role, archive and descriptor bounds reject invalid packages',()=>{
 for(const mutate of [d=>d.version=old.version,d=>d.version='invented',d=>d.files.pop(),d=>d.files[0]=d.files[1],d=>d.files[0].service_id='ops',d=>d.files[0].path='python/evil.py',d=>d.files[0].bytes=262145,d=>d.files[0].extra=true,d=>d.bytes=524289]){
  const d=structuredClone(descriptor);mutate(d);assert.throws(()=>validateBusinessOverlay({...d,url},d.sha256));
 }
 for(const mutate of [b=>{b[0]^=1;return b;},b=>{b[512]^=1;return b;},b=>Buffer.concat([b,Buffer.from('forbidden')])]){
  const changed=gzipSync(mutate(Buffer.from(gunzipSync(archive))));
  assert.throws(()=>businessOverlayFiles(changed,{...descriptor,bytes:changed.length,sha256:sha(changed)}));
 }
});
test('both current new-node slots fit the unchanged cloud bootstrap limit',t=>{
 const config={...json('../fine-step1420/managed-node-eight/boot-public-config.json'),business_overlay_sha256:descriptor.sha256};
 const prior=json('../fine-step1420/managed-node-eight/package-summary.json');
 const request={account_id:config.account_id,region:config.region,source_sha256:prior.source_sha256,image_sha256:config.image_sha256,services:config.services};
 for(const slot of [0,1]){const data=bootstrapUserData(config,request,slot);assert.ok(Buffer.byteLength(data)<=16384);t.diagnostic(JSON.stringify({slot,bytes:Buffer.byteLength(data),sha256:sha(data)}));}
});