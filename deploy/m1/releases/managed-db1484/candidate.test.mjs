import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {validateBusinessOverlay,businessOverlayFiles,businessOverlayCompose} from '../../../tencent-elasticity/business-overlay.mjs';
import {bootstrapUserData} from '../../../tencent-elasticity/bootstrap.mjs';
const read=p=>readFileSync(new URL(p,import.meta.url));
const descriptor=JSON.parse(read('./descriptor.json'));
const url='https://synthetic.blob.core.windows.net/bondbuddy-private/synthetic?sp=r&sr=b&se=2099-01-01T00:00:00Z';
const sha=b=>createHash('sha256').update(b).digest('hex');
test('current recovery and timing closure extracts with role separation and exact unchanged resources',()=>{
 validateBusinessOverlay({...descriptor,url},descriptor.sha256);
 const files=businessOverlayFiles(read('./overlay.tar.gz'),descriptor);assert.equal(files.size,74);
 const base=read('../../../tencent-elasticity/compose.yaml').toString();
 const directory='/opt/bondbuddy/business-overlays/'+descriptor.sha256;
 const composed=businessOverlayCompose(base,directory,descriptor.files);
 assert.equal(composed.split('\n').filter(l=>!l.includes(directory+'/')).join('\n'),base);
 for(const role of ['authoring','review']){
  const rows=descriptor.files.filter(f=>f.service_id===role);assert.equal(rows.length,role==='authoring'?46:28);
  for(const f of rows)assert.equal(sha(files.get(role+'/'+f.path)),f.sha256);
  for(const name of ['managed-run-retries','run-lease-heartbeat','execution-node-runtime','managed-database-preflight'])assert.ok(files.has(role+'/apps/worker/dist/'+name+'.js'));
 }
 assert.notEqual(sha(files.get('authoring/apps/worker/dist/run-pipeline.js')),sha(files.get('review/apps/worker/dist/run-pipeline.js')));
});
test('version and closure are bound; unknown paths and omitted recovery dependencies fail',()=>{
 for(const change of [d=>d.version='shared-business-eight-performance-v1',d=>d.version='invented',d=>d.files.pop(),d=>d.files[0].path='apps/api/dist/evil.js',d=>d.files[0].service_id='ops']){
  const d=structuredClone(descriptor);change(d);assert.throws(()=>validateBusinessOverlay({...d,url},d.sha256));
 }
});
test('both actual public slots fit cloud user-data bound',t=>{
 const config={...JSON.parse(read('../fine-step1420/managed-node-eight/boot-public-config.json')),business_overlay_sha256:descriptor.sha256};
 const old=JSON.parse(read('../fine-step1420/managed-node-eight/package-summary.json'));
 const request={account_id:config.account_id,region:config.region,source_sha256:old.source_sha256,image_sha256:config.image_sha256,services:config.services};
 for(const slot of [0,1]){
  const data=bootstrapUserData(config,request,slot);assert.ok(Buffer.byteLength(data)<=16384);
  t.diagnostic(JSON.stringify({slot,bytes:Buffer.byteLength(data),sha256:sha(data)}));
 }
});
