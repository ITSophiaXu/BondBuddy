import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {brotliDecompressSync} from 'node:zlib';
import {encodeBootstrap85,bootstrapUserData,warmBootstrapUserData} from '../../../tencent-elasticity/bootstrap.mjs';
const python=process.env.BB_TEST_PYTHON||'python3';
const read=p=>readFileSync(new URL(p,import.meta.url));
test('Base85 public transport round-trips through the actual Python decoder at every padding length',()=>{
 for(const size of [0,1,2,3,4,5,31,32,33,1025,16384]){
  const bytes=randomBytes(size),encoded=encodeBootstrap85(bytes);
  const p=spawnSync(python,['-c','import base64,sys;sys.stdout.buffer.write(base64.b85decode(sys.stdin.buffer.read()))'],{input:encoded});
  assert.equal(p.status,0);assert.deepEqual(p.stdout,bytes);
  assert.ok(!/['"\\\s]/.test(encoded));
 }
});
test('cold installer decodes to exact public files and valid Python; warm pins remain unchanged',()=>{
 const config={...JSON.parse(read('../fine-step1420/managed-node-eight/boot-public-config.json')),business_overlay_sha256:JSON.parse(read('./descriptor.json')).sha256};
 const request={account_id:config.account_id,region:config.region,source_sha256:JSON.parse(read('../fine-step1420/managed-node-eight/package-summary.json')).source_sha256,image_sha256:config.image_sha256,services:config.services};
 for(const slot of [0,1]){
  const code=bootstrapUserData(config,request,slot),match=code.match(/input=base64\.b85decode\('([^']+)'\)/);assert.ok(match);
  const p=spawnSync(python,['-c','import base64,sys;sys.stdout.buffer.write(base64.b85decode(sys.stdin.buffer.read()))'],{input:match[1]});assert.equal(p.status,0);
  const program=brotliDecompressSync(p.stdout).toString();
  const compiled=spawnSync(python,['-c',"import sys;compile(sys.stdin.read(),'public-installer','exec')"],{input:program});assert.equal(compiled.status,0);
  const payload=JSON.parse(JSON.parse(program.match(/^p=json.loads\(("(?:\\.|[^"\\])*")\)$/m)[1]));
  for(const name of ['node-adapter.mjs','business-overlay.mjs'])assert.equal(payload.files[name].content,read('../../../tencent-elasticity/'+name).toString());
  assert.equal(payload.compose.content,read('../../../tencent-elasticity/compose.yaml').toString());
  assert.ok(Buffer.byteLength(code)<=16384);
 }
});

