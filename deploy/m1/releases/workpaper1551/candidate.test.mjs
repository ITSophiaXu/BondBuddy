import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {businessOverlayFiles} from '../../../tencent-elasticity/business-overlay.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const here=new URL('./',import.meta.url),file=p=>readFile(new URL(p,here));
function members(gz){const b=gunzipSync(gz),m=new Map();let n=0;while(n+512<=b.length){const h=b.subarray(n,n+512);n+=512;if(h.every(x=>x===0))break;const size=parseInt(h.subarray(124,136).toString().trim(),8),name=h.subarray(0,100).toString().split('\0')[0];m.set(name,b.subarray(n,n+size));n+=Math.ceil(size/512)*512;}return m;}
test('fixed runtime archive changes only the two preflight leaves and retains every SQL and business member',async()=>{
 const desc=JSON.parse(await file('descriptor.json')),candidate=await file('overlay.tar.gz'),old=await file('../encrypted-source1482/overlay.tar.gz');
 assert.equal(sha(old),'c9449fc3294e0a1590ddc5081d99cb9387ea439acf4d096db4ea41e790391770');
 assert.equal(sha(candidate),'eb3e2a9a8000ed61e7516d8ae98d1f9074e07ca76be400ca9ca72a7e3956d64c');
 assert.equal(businessOverlayFiles(candidate,desc).size,78);
 const a=members(old),b=members(candidate);assert.deepEqual([...a.keys()],[...b.keys()]);assert.equal(a.size,83);
 const changed=[...a.keys()].filter(k=>!a.get(k).equals(b.get(k)));
 assert.deepEqual(changed,['authoring/apps/worker/dist/managed-database-preflight.js','review/apps/worker/dist/managed-database-preflight.js']);
 const compiled=await file('managed-database-preflight.mjs');for(const k of changed)assert.deepEqual(b.get(k),compiled);
 assert.equal(sha(compiled),'0d37fa38b0fc141b14ed790ff2e9dfc953d3106893c7fde13f784eddb1d80df3');
});
test('archive descriptor rejects corruption or an unreviewed runtime addition',async()=>{
 const desc=JSON.parse(await file('descriptor.json')),a=await file('overlay.tar.gz'),broken=Buffer.from(a);broken[100]^=1;
 assert.throws(()=>businessOverlayFiles(broken,desc));
 assert.throws(()=>businessOverlayFiles(a,{...desc,files:[...desc.files,{service_id:'authoring',path:'apps/worker/dist/unreviewed.js',bytes:1,sha256:'a'.repeat(64)}]}));
});test('both future slots with the candidate pin fit the current cloud bootstrap size limit',async t=>{
 const {bootstrapUserData}=await import('../../../tencent-elasticity/bootstrap.mjs');
 const config={...JSON.parse(await file('../fine-step1420/managed-node-eight/boot-public-config.json')),business_overlay_sha256:'eb3e2a9a8000ed61e7516d8ae98d1f9074e07ca76be400ca9ca72a7e3956d64c'};
 const prior=JSON.parse(await file('../fine-step1420/managed-node-eight/package-summary.json'));
 const request={account_id:config.account_id,region:config.region,source_sha256:prior.source_sha256,image_sha256:config.image_sha256,services:config.services};
 for(const slot of [0,1]){const data=bootstrapUserData(config,request,slot);assert.ok(Buffer.byteLength(data)<=16384);t.diagnostic(JSON.stringify({slot,bytes:Buffer.byteLength(data),sha256:sha(data)}));}
});