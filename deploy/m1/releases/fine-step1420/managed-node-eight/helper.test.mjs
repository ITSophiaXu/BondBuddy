import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {validateBusinessOverlay,businessOverlayFiles,businessOverlayCompose} from './helper/business-overlay.mjs';
import {businessOverlayCompose as beforeCompose,businessOverlayFiles as beforeFiles} from './helper/business-overlay.before.mjs';
const read=p=>readFileSync(new URL(p,import.meta.url));
const hash=b=>createHash('sha256').update(b).digest('hex');
const descriptor=JSON.parse(read('./descriptor.json'));
const url='https://synthetic.blob.core.windows.net/bondbuddy-private/synthetic?sp=r&sr=b&se=2099-01-01T00:00:00Z';
const withUrl=d=>({...d,url});
const archive=read('./overlay.tar.gz');
const base=read('../release1420-cutover/node-eight-preimages-20261116T061953Z/effective/ops/app/deploy/tencent-elasticity/compose.yaml').toString();
const dir='/opt/bondbuddy/business-overlays/'+descriptor.sha256;
const fresh=()=>structuredClone(descriptor);
const altered=(fn)=>{const tar=Buffer.from(gunzipSync(archive));fn(tar);const bytes=gzipSync(tar);return {bytes,descriptor:{...descriptor,bytes:bytes.length,sha256:hash(bytes)}};};
const checksum=tar=>{tar.fill(32,148,156);const value=tar.subarray(0,512).reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')+'\0 ';tar.write(value,148,'ascii');};
test('exact 63-file role closure validates, extracts and preserves native eight-slot compose',()=>{
 validateBusinessOverlay(withUrl(descriptor),descriptor.sha256);const files=businessOverlayFiles(archive,descriptor);assert.equal(files.size,63);
 for(const row of descriptor.files)assert.equal(hash(files.get(`${row.service_id}/${row.path}`)),row.sha256);
 const composed=businessOverlayCompose(base,dir,descriptor.files),parts=composed.split('\n  review:');
 assert.equal(parts[0].split(dir+'/authoring/').length-1,40);assert.equal(parts[1].split(dir+'/review/').length-1,23);
 assert.equal(parts[0].includes(dir+'/review/'),false);assert.equal(parts[1].includes(dir+'/authoring/'),false);
 const lines=composed.split('\n').filter(line=>!line.includes(dir+'/'));assert.equal(lines.join('\n'),base);
 for(const role of ['authoring','review'])assert.equal((composed.match(new RegExp(dir+'/'+role+'/apps/api/package.json:/app/apps/api/package.json:ro','g'))??[]).length,1);
 assert.notEqual(hash(files.get('authoring/apps/worker/dist/unified-model-stage.js')),hash(files.get('review/apps/worker/dist/unified-model-stage.js')));
 assert.notEqual(hash(files.get('authoring/apps/worker/dist/run-pipeline.js')),hash(files.get('review/apps/worker/dist/run-pipeline.js')));
});
test('descriptor rejects path widening, role widening, duplicates, extra fields and bounds',()=>{
 for(const change of [d=>d.files[0].path='apps/api/dist/evil.js',d=>d.files[0].path='../private.key',d=>d.files[0].path='apps/worker/package.json',d=>d.files[0].service_id='ops',d=>d.files[0]={...d.files[1]},d=>d.files[0].extra=true,d=>d.files.pop(),d=>d.files[0].bytes=262145,d=>d.bytes=524289,d=>d.files[0].sha256='A'.repeat(64)]){const d=fresh();change(d);assert.throws(()=>validateBusinessOverlay(withUrl(d),d.sha256));}
 assert.throws(()=>validateBusinessOverlay({...withUrl(descriptor),url:url.replace('sp=r','sp=rw')},descriptor.sha256));
 assert.throws(()=>validateBusinessOverlay({...withUrl(descriptor),url:url.replace('https:','http:')},descriptor.sha256));
});
test('archive rejects checksum errors, links, traversal, extra tails, corrupt payload and decompression overflow',()=>{
 const mutations=[tar=>tar[148]=0,tar=>{tar[156]=50;checksum(tar);},tar=>{tar.fill(0,0,100);tar.write('../private.key',0);checksum(tar);},tar=>tar[tar.length-1]=1,tar=>tar[512]^=1];
 for(const mutate of mutations){const a=altered(mutate);assert.throws(()=>businessOverlayFiles(a.bytes,a.descriptor));}
 const bomb=gzipSync(Buffer.alloc(4194305));assert.throws(()=>businessOverlayFiles(bomb,{...descriptor,bytes:bomb.length,sha256:hash(bomb)}));
});
test('old eight-slot and four-slot descriptor extraction remains accepted',()=>{
 const evidence=JSON.parse(read('../release1420-cutover/node-eight-preimages-20261116T061953Z/evidence.json'));
 const old8=evidence.business_overlay.descriptor;validateBusinessOverlay(withUrl(old8),old8.sha256);
 const old4=JSON.parse(read('../release1420-managed-integration/business-overlay/descriptor.json'));validateBusinessOverlay(withUrl(old4),old4.sha256);
 assert.equal(businessOverlayFiles(read('../release1420-managed-integration/business-overlay/overlay.tar.gz'),old4).size,19);
 const c=businessOverlayCompose(base,'/opt/bondbuddy/business-overlays/'+old8.sha256,old8.files);assert.equal(c.split('/'+old8.sha256+'/').length-1,33);
 assert.equal(c,beforeCompose(base,'/opt/bondbuddy/business-overlays/'+old8.sha256,old8.files));
 assert.equal(businessOverlayCompose(base,'/opt/bondbuddy/business-overlays/'+old4.sha256,old4.files),beforeCompose(base,'/opt/bondbuddy/business-overlays/'+old4.sha256,old4.files));
 assert.deepEqual(businessOverlayFiles(read('../release1420-managed-integration/business-overlay/overlay.tar.gz'),old4),beforeFiles(read('../release1420-managed-integration/business-overlay/overlay.tar.gz'),old4));
});
