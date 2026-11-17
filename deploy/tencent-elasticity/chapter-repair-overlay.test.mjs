import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
import {brotliDecompressSync} from 'node:zlib';
import {sha256} from './policy.mjs';
import {businessOverlayProfile,businessOverlayFiles,businessOverlayCompose,validateBusinessOverlay,CHAPTER_REPAIR_VERSION,chapterRepairFiles} from './business-overlay.mjs';
import {buildChapterRepairOverlay,packOverlay,pinnedOverlaySql} from './chapter-repair-overlay.mjs';
import {bootstrapUserData} from './bootstrap.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
function baseline(){
  const version='shared-business-eight-permissions-encrypted-v1',profile=businessOverlayProfile(version),entries=new Map(),files=[];
  for(const [role,paths] of Object.entries(profile.paths))for(const path of paths){
    const bytes=Buffer.from(`// synthetic pinned ${role} ${path}\n`);entries.set(`${role}/${path}`,bytes);
    files.push({service_id:role,path,bytes:bytes.length,sha256:sha256(bytes)});
  }
  for(const [path,pin] of Object.entries(profile.sql))entries.set(path,pinnedOverlaySql(root,path,pin));
  const archive=packOverlay(entries),descriptor={version,bytes:archive.length,sha256:sha256(archive),files};
  return {archive,descriptor};
}
const url='https://testaccount.blob.core.windows.net/bondbuddy-private/synthetic?sp=r&sr=b&se=2099-01-01';

test('real built repair closure is additive for both roles and rejects omissions/extra paths',()=>{
  const base=baseline(),built=buildChapterRepairOverlay(base.descriptor,base.archive,root);
  const descriptor={...built.descriptor,url};validateBusinessOverlay(descriptor,descriptor.sha256);
  const files=businessOverlayFiles(built.archive,descriptor);
  for(const role of ['authoring','review'])for(const path of chapterRepairFiles)
    assert.deepEqual(files.get(`${role}/${path}`),readFileSync(resolve(root,path)));
  for(const f of built.receipt.preserved_entries)
    assert.equal(sha256(files.get(`${f.service_id}/${f.path}`)),f.sha256);
  assert.ok(built.receipt.preserved_entries.some(f=>f.path==='apps/worker/dist/codex-adapter.js'));
  assert.ok(built.receipt.preserved_entries.some(f=>f.path==='apps/worker/dist/runtime.js'));
  assert.equal(built.receipt.deployed,false);
  assert.throws(()=>validateBusinessOverlay({...descriptor,files:descriptor.files.slice(1)},descriptor.sha256),/SCOPE/);
  assert.throws(()=>validateBusinessOverlay({...descriptor,files:[{...descriptor.files[0],path:'python/arbitrary.py'},...descriptor.files.slice(1)]},descriptor.sha256),/SCOPE/);
  assert.throws(()=>validateBusinessOverlay({...descriptor,files:[descriptor.files[1],...descriptor.files.slice(1)]},descriptor.sha256),/SCOPE/);
  assert.throws(()=>businessOverlayFiles(Buffer.concat([built.archive,Buffer.from('x')]),descriptor),/ARCHIVE/);
  const compose=businessOverlayCompose(readFileSync(new URL('compose.yaml',import.meta.url),'utf8'),'/opt/bondbuddy/business-overlays/'+descriptor.sha256,descriptor.files);
  for(const path of chapterRepairFiles)assert.equal(compose.split(`/app/${path}:ro`).length-1,2);
  assert.ok(built.archive.length<=524288);
  console.log(JSON.stringify({version:CHAPTER_REPAIR_VERSION,service_path_entries:files.size,real_repair_files:chapterRepairFiles.length,archive_bytes:built.archive.length,base:'synthetic pinned encrypted overlay'}));
});

test('old encrypted descriptors remain valid; other bases cannot be silently repackaged',()=>{
  const base=baseline();validateBusinessOverlay({...base.descriptor,url},base.descriptor.sha256);
  assert.equal(businessOverlayFiles(base.archive,base.descriptor).size,78);
  assert.throws(()=>buildChapterRepairOverlay({...base.descriptor,version:'unknown'},base.archive,root),/BASE_REQUIRED/);
});

test('cold userdata embeds the updated loader within the unchanged provider limit',()=>{
  const config={pool_tag:'test-pool',business_overlay_sha256:'a'.repeat(64),role_names:['test-slot1','test-slot2'],
    node_secrets:[{role_name:'test-slot1',role_id:'123',secret_name:'test-secret1'},{role_name:'test-slot2',role_id:'124',secret_name:'test-secret2'}]};
  const request={account_id:'123456789',region:'ap-beijing',source_sha256:'b'.repeat(64),image_sha256:'c'.repeat(64),services:[{service_id:'authoring'},{service_id:'review'}]};
  for(const slot of [0,1]){
    const script=bootstrapUserData(config,request,slot);
    assert.ok(Buffer.byteLength(script)<=16384);
    assert.ok(!script.includes('.blob.core.windows.net'));
    const encoded=script.match(/base64\.b85decode\('([^']+)'\)/)[1];
    const alphabet='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~',blocks=[];
    for(let i=0;i<encoded.length;i+=5){
      const part=encoded.slice(i,i+5);let number=0;
      for(const c of part.padEnd(5,'~'))number=number*85+alphabet.indexOf(c);
      const bytes=Buffer.alloc(4);bytes.writeUInt32BE(number>>>0);blocks.push(bytes.subarray(0,part.length-1));
    }
    const program=brotliDecompressSync(Buffer.concat(blocks),{maxOutputLength:131072}).toString();
    assert.ok(program.startsWith("with open('/etc/bondbuddy/elastic-public.json','w',encoding='utf-8')"));
    assert.ok(program.includes(config.node_secrets[slot].secret_name));
    assert.ok(program.includes(CHAPTER_REPAIR_VERSION));
    const payload=JSON.parse(program.match(/p=json.loads\(r'''([^]*?)'''\)/)[1]);
    for(const name of ['business-overlay.mjs','node-adapter.mjs']){
      const bytes=readFileSync(new URL(name,import.meta.url));
      assert.equal(payload.files[name].sha256,sha256(bytes));assert.equal(payload.files[name].content,bytes.toString());
    }
  }
});
