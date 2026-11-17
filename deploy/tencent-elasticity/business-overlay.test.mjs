import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gzipSync} from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {sha256} from './policy.mjs';
import {businessOverlayFiles,businessOverlayCompose,validateBusinessOverlay} from './business-overlay.mjs';
import {bootstrapUserData} from './bootstrap.mjs';

test('pinned business archive and public cold bootstrap preserve exact boundaries',()=>{
  const synthetic=Array.from({length:19},(_,i)=>({path:`apps/api/dist/example-${i}.js`,bytes:Buffer.from('export const value=1;\n')}));
  const blocks=[];
  for(const entry of [...synthetic,{path:'db/migrations/0180_batch_four_way.sql',bytes:Buffer.from('-- test')},{path:'db/migrations/0186_shared_batch_capacity.sql',bytes:Buffer.from('-- test')}]){
    const h=Buffer.alloc(512);h.write(entry.path);h.write(entry.bytes.length.toString(8).padStart(11,'0'),124);h[156]=48;
    blocks.push(h,entry.bytes,Buffer.alloc((512-entry.bytes.length%512)%512));
  }
  blocks.push(Buffer.alloc(1024));
  const archive=process.env.BB_BUSINESS_TEST_ARCHIVE?readFileSync(process.env.BB_BUSINESS_TEST_ARCHIVE):gzipSync(Buffer.concat(blocks));
  const delivery=process.env.BB_BUSINESS_TEST_DELIVERY?JSON.parse(readFileSync(process.env.BB_BUSINESS_TEST_DELIVERY)):{runtime_files:synthetic.map(e=>({compiled_path:e.path,compiled_bytes:e.bytes.length,compiled_sha256:sha256(e.bytes)}))};
  const descriptor={version:'shared-business-four-v1',url:'https://testaccount.blob.core.windows.net/bondbuddy-private/artifact?sp=r&sr=b&se=2099-01-01&sig=private-test-capability',
    sha256:sha256(archive),bytes:archive.length,files:delivery.runtime_files.map(e=>({path:e.compiled_path,sha256:e.compiled_sha256,bytes:e.compiled_bytes}))};
  validateBusinessOverlay(descriptor,descriptor.sha256);
  const files=businessOverlayFiles(archive,descriptor);assert.equal(files.size,19);
  const base=process.env.BB_BUSINESS_TEST_COMPOSE?readFileSync(process.env.BB_BUSINESS_TEST_COMPOSE,'utf8'):'# Standalone execution nodes only: test\nservices:\n  authoring:\n    volumes:\n      - /original:/original:ro\n  review:\n    volumes:\n      - /review:/review:ro\n';
  const compose=businessOverlayCompose(base,'/opt/bondbuddy/business-overlays/'+descriptor.sha256,descriptor.files);
  assert.equal(compose.split(':ro\n').length-base.split(':ro\n').length,19);
  assert.equal(compose.slice(compose.indexOf('\n  review:')),base.slice(base.indexOf('\n  review:')));
  assert.throws(()=>businessOverlayFiles(Buffer.concat([archive,Buffer.from('x')]),descriptor),/ARCHIVE/);
  assert.throws(()=>validateBusinessOverlay({...descriptor,files:[{...descriptor.files[0],path:'apps/worker/dist/runtime.js'},...descriptor.files.slice(1)]},descriptor.sha256),/SCOPE/);
  const config={pool_tag:'test-pool',business_overlay_sha256:descriptor.sha256,role_names:['test-slot1','test-slot2'],node_secrets:[{role_name:'test-slot1',role_id:'123',secret_name:'test-secret1'}]};
  const request={account_id:'123456789',region:'ap-beijing',source_sha256:'a'.repeat(64),image_sha256:'b'.repeat(64),services:[{service_id:'authoring'}]};
  const script=bootstrapUserData(config,request,0);
  assert.ok(Buffer.byteLength(script)<=16384,`userdata ${Buffer.byteLength(script)}`);
  assert.ok(!script.includes('private-test-capability')&&!script.includes('.blob.core.windows.net'));
  const python=script.split("python3 - <<'BB_BUSINESS_CODE'\n")[1].split('\nBB_BUSINESS_CODE')[0];
  const parsed=spawnSync(process.env.BB_TEST_PYTHON||'python3',['-c','import ast,sys;ast.parse(sys.stdin.read())'],{input:python,encoding:'utf8'});
  assert.equal(parsed.status,0,parsed.stderr);
  console.log(JSON.stringify({runtime_files:files.size,user_data_bytes:Buffer.byteLength(script),private_capability_in_userdata:false}));
});
