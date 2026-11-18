import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {businessOverlayFiles} from '../../../tencent-elasticity/business-overlay.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const here=new URL('./',import.meta.url),file=p=>readFile(new URL(p,here));
function members(gz){const b=gunzipSync(gz),m=new Map();let n=0;while(n+512<=b.length){const h=b.subarray(n,n+512);n+=512;if(h.every(x=>x===0))break;const size=parseInt(h.subarray(124,136).toString().trim(),8),name=h.subarray(0,100).toString().split('\0')[0];m.set(name,b.subarray(n,n+size));n+=Math.ceil(size/512)*512;}return m;}
test('fixed runtime archive changes only the two preflight leaves and retains every SQL and business member',async()=>{
 assert.equal(sha(await file('main-cutover-adapter.py')),'59818258171123633d3c4d5a7cc8037e4ec2082a997bf18e7bfefd7a54849a4c');
 const desc=JSON.parse(await file('descriptor.json')),candidate=await file('overlay.tar.gz'),old=await file('../encrypted-source1482/overlay.tar.gz');
 assert.equal(sha(old),'c9449fc3294e0a1590ddc5081d99cb9387ea439acf4d096db4ea41e790391770');
 assert.equal(sha(candidate),'b0080b09ab87f97f1e1533902b671757fa8b44a207c79dfb28b0a667791bb0b9');
 assert.equal(businessOverlayFiles(candidate,desc).size,78);
 const a=members(old),b=members(candidate);assert.deepEqual([...a.keys()],[...b.keys()]);assert.equal(a.size,83);
 const changed=[...a.keys()].filter(k=>!a.get(k).equals(b.get(k)));
 assert.deepEqual(changed,['authoring/apps/worker/dist/managed-database-preflight.js','review/apps/worker/dist/managed-database-preflight.js']);
 const compiled=await file('managed-database-preflight.mjs');for(const k of changed)assert.deepEqual(b.get(k),compiled);
 assert.equal(sha(compiled),'258f33e9842279db61cb6c4abd03ce530e71cd6eb363126f84e77faa688878d9');
});
test('archive descriptor rejects corruption or an unreviewed runtime addition',async()=>{
 const desc=JSON.parse(await file('descriptor.json')),a=await file('overlay.tar.gz'),broken=Buffer.from(a);broken[100]^=1;
 assert.throws(()=>businessOverlayFiles(broken,desc));
 assert.throws(()=>businessOverlayFiles(a,{...desc,files:[...desc.files,{service_id:'authoring',path:'apps/worker/dist/unreviewed.js',bytes:1,sha256:'a'.repeat(64)}]}));
});test('both future slots with the candidate pin fit the current cloud bootstrap size limit',async t=>{
 const fixture=JSON.parse(await file('public-bootstrap-bytes.json'));
 const root=await mkdtemp(join(tmpdir(),'bb1551-boot-'));
 try {
 for(const [path,f] of Object.entries(fixture.files)){const bytes=Buffer.from(f.base64,'base64');assert.equal(bytes.length,f.bytes);assert.equal(sha(bytes),f.sha256);const p=join(root,path);await mkdir(dirname(p),{recursive:true});await writeFile(p,bytes);}
 const {bootstrapUserData}=await import(pathToFileURL(join(root,'deploy/tencent-elasticity/bootstrap.mjs')));
 const config={...JSON.parse(await file('../fine-step1420/managed-node-eight/boot-public-config.json')),business_overlay_sha256:'b0080b09ab87f97f1e1533902b671757fa8b44a207c79dfb28b0a667791bb0b9'};
 const prior=JSON.parse(await file('../fine-step1420/managed-node-eight/package-summary.json'));
 const request={account_id:config.account_id,region:config.region,source_sha256:prior.source_sha256,image_sha256:config.image_sha256,services:config.services};
 for(const slot of [0,1]){const data=bootstrapUserData(config,request,slot);assert.ok(Buffer.byteLength(data)<=16384);t.diagnostic(JSON.stringify({slot,bytes:Buffer.byteLength(data),sha256:sha(data)}));}
 }finally{assert.equal(dirname(root),resolve(tmpdir()));await rm(root,{recursive:true,force:true});}
});