import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {copyFile,mkdir,mkdtemp,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {brotliDecompressSync} from 'node:zlib';
import {bootstrapUserData} from './bootstrap.mjs';
import {renderPrivateTransportConfig,INTEGRITY_TRANSPORT_SECTION} from './private-egress.mjs';

const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
const config=JSON.parse(read('./node.example.json'));

test('execution image includes the workspace helper required by the pinned node adapter',()=>{
 const copies=read('../m1/Dockerfile').split('\n').filter(line=>line.startsWith('COPY ')&&line.includes('deploy/tencent-elasticity/node-adapter.mjs'));
 assert.equal(copies.length,1);
 assert.ok(copies[0].includes(' deploy/tencent-elasticity/authoring-workspace.mjs '));
 assert.match(copies[0],/ deploy\/tencent-elasticity\/\s*$/);
});

test('image deployment files support real module imports and pinned business bootstrap',async t=>{
 const root=fileURLToPath(new URL('../../',import.meta.url)),layout=await mkdtemp(join(tmpdir(),'bb-image-layout-'));
 t.after(()=>rm(layout,{recursive:true,force:true}));
 await symlink(join(root,'node_modules'),join(layout,'node_modules'),'dir');
 const worker=read('../m1/Dockerfile').replaceAll('\r\n','\n').split('FROM node-runtime AS worker\n')[1].split('\nFROM ')[0];
 for(const line of worker.split('\n').filter(line=>line.startsWith('COPY '))){
  const entries=line.split(/\s+/).slice(1).filter(part=>!part.startsWith('--')),target=entries.pop();
  for(const source of entries.filter(path=>path.startsWith('deploy/tencent-elasticity/')||path.startsWith('deploy/m1/security/'))){
   await mkdir(join(layout,target),{recursive:true});
   await copyFile(join(root,source),join(layout,target,basename(source)));
  }
 }
 for(const entry of ['ops-handler.mjs','bootstrap-entry.mjs','node-adapter.mjs','transport-renewal.mjs'])
  await t.test(entry,async()=>{await import(pathToFileURL(join(layout,'deploy/tencent-elasticity',entry)).href);});
 await t.test('business-pinned bootstrap reads the image resources',async()=>{
  const {bootstrapUserData:installed}=await import(pathToFileURL(join(layout,'deploy/tencent-elasticity/bootstrap.mjs')).href);
  const c={pool_tag:'synthetic',business_overlay_sha256:'c'.repeat(64),role_names:['synthetic-one','synthetic-two'],
   node_secrets:[{role_name:'synthetic-one',role_id:'101',secret_name:'synthetic-one'},{role_name:'synthetic-two',role_id:'102',secret_name:'synthetic-two'}]};
  const request={account_id:'100',region:'ap-beijing',source_sha256:'a'.repeat(64),image_sha256:'b'.repeat(64),services:[{service_id:'authoring',capabilities:['authoring']}]};
  for(const slot of [0,1])assert.ok(Buffer.byteLength(installed(c,request,slot))<=16384);
 });
});

test('derived authoring uses browser sandbox, reaping and a separate official egress without changing quotas',()=>{
 const result=spawnSync('docker',['compose','-f','deploy/tencent-elasticity/compose.yaml','config','--format','json'],{
  encoding:'utf8',env:{...process.env,BB_ELASTIC_IMAGE:'sha256:'+'1'.repeat(64),BB_ELASTIC_REVIEW_IMAGE:'sha256:'+'2'.repeat(64),
   BB_ELASTIC_SERVICE_ENV:'/dev/null',BB_ELASTIC_REGISTRATION_DIR:'/nonexistent/integrity-test',BB_ELASTIC_NETWORK:'synthetic-integrity'}});
 assert.equal(result.status,0,result.stderr);
 const {services}=JSON.parse(result.stdout),a=services.authoring,r=services.review;
 assert.equal(a.init,true);assert.equal(a.pids_limit,512);assert.equal(Number(a.mem_limit),6*1024**3);
 assert.equal(a.environment.BB_INTEGRITY_EGRESS_PROXY_URL,'http://172.28.61.1:15435');
 assert.equal(a.environment.HTTPS_PROXY,'http://172.28.61.1:15434');
 assert.ok(a.security_opt.some(v=>v.endsWith('/integrity-browser-seccomp.json')));
 assert.ok(a.security_opt.includes('no-new-privileges:true'));
 assert.ok(a.security_opt.includes('apparmor=bondbuddy-codex-v1'));assert.deepEqual(a.cap_drop,['ALL']);
 assert.equal(a.environment.BB_FILE_AUTHORING_WORK_ROOT,'/var/lib/bondbuddy/authoring-work');
 const workspace=a.volumes.find(v=>v.target==='/var/lib/bondbuddy/authoring-work');
 assert.ok(workspace,'authoring workspace must survive container recreation');
 assert.equal(workspace.type,'bind');assert.equal(workspace.source,'/var/lib/bondbuddy/authoring-work');
 assert.equal(workspace.read_only===true,false);assert.equal(workspace.bind.create_host_path===true,false);
 assert.equal(a.read_only,true);
 assert.equal(r.environment.BB_INTEGRITY_EGRESS_PROXY_URL,undefined);
 assert.ok(r.security_opt.some(v=>v.endsWith('/codex-seccomp.json')));
});

test('official-only listener requires mTLS and preserves the general proxy policy',()=>{
 const transport=renderPrivateTransportConfig(config);
 assert.equal(transport.split('[execution-integrity]').length,2);
 assert.ok(transport.endsWith(INTEGRITY_TRANSPORT_SECTION));
 assert.match(transport,/accept = 172\.28\.61\.1:15435\nconnect = 10\.2\.0\.5:15435/);
 assert.match(transport,/checkHost = proxy-execution\.internal/);
 const server=read('./private-integrity-server.conf');
 assert.match(server,/accept = 10\.2\.0\.5:15435\nconnect = 127\.0\.0\.1:3129/);
 assert.match(server,/verifyChain = yes\nrequireCert = yes/);
 assert.throws(()=>renderPrivateTransportConfig({...config,private_proxy:{...config.private_proxy,remote_port:3129}}),/NODE_PROXY_NETWORK_SCOPE/);
});

test('both cold slot templates carry the exact profile, module and transport section inside bounded public bootstrap',()=>{
 const hash=createHash('sha256').update('synthetic-source').digest('hex');
 const services=[{service_id:'authoring',capabilities:['authoring']},{service_id:'review',capabilities:['review','assistant']}];
 const request={account_id:'100000000001',region:'ap-beijing',source_sha256:hash,image_sha256:createHash('sha256').update('synthetic-image').digest('hex'),services};
 const c={pool_tag:'synthetic-execution',business_overlay_sha256:createHash('sha256').update('synthetic-business').digest('hex'),role_names:['synthetic-execution-node-1','synthetic-execution-node-2'],
  node_secrets:[{role_name:'synthetic-execution-node-1',role_id:'4611686018000000001',secret_name:'synthetic-execution-node-1'},{role_name:'synthetic-execution-node-2',role_id:'4611686018000000002',secret_name:'synthetic-execution-node-2'}]};
 for(let slot=0;slot<2;slot++){
  const script=bootstrapUserData(c,request,slot);
  assert.ok(Buffer.byteLength(script)<=16384,`userdata ${Buffer.byteLength(script)}`);
  const encoded=script.match(/base64\.b85decode\('([^']+)'\)/)[1];
  const b85=spawnSync('python3',['-c','import base64,sys;sys.stdout.buffer.write(base64.b85decode(sys.stdin.read()))'],{input:encoded});
  assert.equal(b85.status,0);
  const program=brotliDecompressSync(b85.stdout).toString();
  assert.match(program,/Path\('\/etc\/bondbuddy\/elastic-public.json'\)\.write_bytes/);
  assert.match(program,/systemctl','start','bondbuddy-execution-bootstrap.service'/);
  const parsed=spawnSync('python3',['-c',`import ast,json,sys,hashlib
p=ast.parse(sys.stdin.read())
a=next(n for n in p.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='p' for t in n.targets))
payload=json.loads(ast.literal_eval(a.value.args[0]))
profile=json.loads(sys.argv[1]);profile['syscalls'].append(payload['integrity_rule'])
assign=next(n for n in p.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='sfraw' for t in n.targets))
scope={'profile':profile,'json':json}
exec(compile(ast.Module(body=[assign],type_ignores=[]),'actual-profile-assignment','exec'),scope)
assert hashlib.sha256(scope['sfraw']).hexdigest()==payload['integrity_profile_sha256']
print(json.dumps(payload))`,read('../m1/security/codex-seccomp.json')],{input:program,encoding:'utf8'});
  assert.equal(parsed.status,0,parsed.stderr);
  const payload=JSON.parse(parsed.stdout);
  assert.ok(payload.files['authoring-workspace.mjs'],'cold and retained nodes require the workspace helper beside the adapter');
  assert.equal(payload.files['authoring-workspace.mjs'].content,read('./authoring-workspace.mjs'));
  assert.equal(payload.files['authoring-workspace.mjs'].sha256,createHash('sha256').update(read('./authoring-workspace.mjs')).digest('hex'));
  const profile=JSON.parse(read('../m1/security/codex-seccomp.json'));profile.syscalls.push(payload.integrity_rule);
  assert.deepEqual(profile,JSON.parse(read('../m1/security/integrity-browser-seccomp.json')));
  assert.equal(payload.integrity_section,INTEGRITY_TRANSPORT_SECTION);
  const current=read('./private-egress.mjs');
  assert.ok(current.includes(payload.egress_patch.addition));
  const original=current.replace(payload.egress_patch.addition,'').replace('+INTEGRITY_TRANSPORT_SECTION;',';');
  assert.equal(original.replace('export function renderPrivateTransportConfig',payload.egress_patch.addition+'export function renderPrivateTransportConfig').replace('proxy.remote_port,proxy.sni);','proxy.remote_port,proxy.sni)+INTEGRITY_TRANSPORT_SECTION;'),current);
  assert.match(program,/assert h\(transport\)==pg\['config_sha256'\]/);
  assert.match(program,/assert regular\(nc\)==nodebefore/);
 }
});
