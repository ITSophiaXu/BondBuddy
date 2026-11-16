import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
import {brotliDecompressSync,brotliCompressSync,gunzipSync} from 'node:zlib';import {spawnSync} from 'node:child_process';
import {bootstrapUserData,warmBootstrapUserData} from '../../../../tencent-elasticity/bootstrap.mjs';
import {bootstrapUserData as beforeBootstrap} from './boot-reference/bootstrap.mjs';
const read=p=>readFileSync(new URL(p,import.meta.url)),hash=b=>createHash('sha256').update(b).digest('hex'),summary=JSON.parse(read('./package-summary.json'));
const config={...JSON.parse(read('./boot-public-config.json')),business_overlay_sha256:summary.archive_sha256};
const request={account_id:config.account_id,region:config.region,source_sha256:summary.source_sha256,image_sha256:config.image_sha256,services:config.services};
const prefix="python3 - <<'BB_BUSINESS_CODE'\n",suffix='BB_BUSINESS_CODE\n',slice=s=>s.slice(s.indexOf(prefix)+prefix.length,s.indexOf(suffix));
const proofs=[];
function decoded(slot){const current=bootstrapUserData(config,request,slot),before=beforeBootstrap(config,request,slot),wrapper=slice(current),match=wrapper.match(/'-e',("(?:\\.|[^"\\])*")\],input=base64\.b64decode\('([A-Za-z0-9+/=]+)'\)/);assert.ok(match);return {current,before,wrapper,decoder:JSON.parse(match[1]),compressed:Buffer.from(match[2],'base64'),program:brotliDecompressSync(Buffer.from(match[2],'base64'),{maxOutputLength:131072}).toString()};}
test('actual two slots fit unchanged 16KiB boundary and preserve every installer operation/file byte',t=>{
 for(const slot of [0,1]){
  const {current,before,program}=decoded(slot),oldProgram=slice(before),oldLoad=oldProgram.match(/^p=json\.loads\(gzip\.decompress\(base64\.b64decode\('([A-Za-z0-9+/=]+)'\)\)\)$/m),newLoad=program.match(/^p=json\.loads\(("(?:\\.|[^"\\])*")\)$/m);assert.ok(oldLoad&&newLoad);
  const original=JSON.parse(gunzipSync(Buffer.from(oldLoad[1],'base64'))),restored=JSON.parse(JSON.parse(newLoad[1]));assert.deepEqual(restored,original);
  assert.equal(program.replace(newLoad[0],()=>oldLoad[0]),oldProgram);
  assert.equal(current.slice(0,current.indexOf(prefix)),before.slice(0,before.indexOf(prefix)));assert.equal(current.slice(current.indexOf(suffix)+suffix.length),before.slice(before.indexOf(suffix)+suffix.length));assert.ok(Buffer.byteLength(current)<=16384);
  for(const [name,file] of Object.entries(restored.files))assert.equal(hash(Buffer.from(file.content)),file.sha256);
  assert.equal(hash(Buffer.from(restored.compose.content)),restored.compose.sha256);
  proofs.push({slot,user_data_bytes:Buffer.byteLength(current),decoded_program_bytes:Buffer.byteLength(program),decoded_program_sha256:hash(program),same_json:true,same_installer_operations:true,all_file_bytes_verified:true});
 }
 t.diagnostic(JSON.stringify({version:'public-bootstrap-brotli-equivalence-v1',node:process.version,proofs,no_cloud_or_installer_execution:true}));
});
test('fixed Node decoder restores exact bytes and rejects malformed/oversize compressed input',()=>{
 const {decoder,compressed,program}=decoded(0);const execute=input=>spawnSync(process.execPath,['--input-type=module','-e',decoder],{input,timeout:30000,maxBuffer:1048576});
 const good=execute(compressed);assert.equal(good.status,0);assert.equal(good.stdout.toString(),program);
 assert.notEqual(execute(Buffer.from('not-brotli')).status,0);assert.notEqual(execute(brotliCompressSync(Buffer.alloc(131073))).status,0);
});
test('retained warm bootstrap stays byte-identical and altered pin fails closed',()=>{
 const old=beforeBootstrap(config,request,0),instance='ins-warmproof',launch='a'.repeat(64),pin={instance_id:instance,launch_manifest_sha256:launch,user_data_sha256:hash(old),user_data_base64:Buffer.from(old).toString('base64')};
 assert.equal(warmBootstrapUserData({...config,retained_warm_bootstraps:[pin]},{...request,launch_manifest_sha256:launch},0,instance),old);
 assert.throws(()=>warmBootstrapUserData({...config,retained_warm_bootstraps:[{...pin,user_data_sha256:'b'.repeat(64)}]},{...request,launch_manifest_sha256:launch},0,instance));
});


test('Python parses both public wrappers and reconstructs the exact JSON payload without executing installers',()=>{
 const python=process.env.PYTHON??(process.platform==='win32'?'python':'python3');
 const check=`import ast,json,sys
v=json.load(sys.stdin)
ast.parse(v['wrapper'])
p=ast.parse(v['program'])
assignment=next(s for s in p.body if isinstance(s,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='p' for t in s.targets))
print(json.dumps(json.loads(ast.literal_eval(assignment.value.args[0]))))`;
 for(const slot of [0,1]){
  const {wrapper,program}=decoded(slot),load=program.match(/^p=json\.loads\(("(?:\\.|[^"\\])*")\)$/m);
  assert.ok(load);const parsed=spawnSync(python,['-c',check],{input:JSON.stringify({wrapper,program}),encoding:'utf8',timeout:30000,maxBuffer:131072});
  assert.equal(parsed.status,0,parsed.stderr||parsed.error?.message);assert.deepEqual(JSON.parse(parsed.stdout),JSON.parse(JSON.parse(load[1])));
 }
});
