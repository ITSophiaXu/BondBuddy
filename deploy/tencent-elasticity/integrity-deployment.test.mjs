import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {brotliDecompressSync} from 'node:zlib';
import {bootstrapUserData} from './bootstrap.mjs';
import {renderPrivateTransportConfig,INTEGRITY_TRANSPORT_SECTION} from './private-egress.mjs';

const read=p=>readFileSync(new URL(p,import.meta.url),'utf8');
const config=JSON.parse(read('./node.example.json'));

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
  console.log(JSON.stringify({slot,bootstrap_bytes:Buffer.byteLength(script)}));
  assert.ok(Buffer.byteLength(script)<=16384,`userdata ${Buffer.byteLength(script)}`);
  const encoded=script.match(/base64\.b85decode\('([^']+)'\)/)[1];
  const b85=spawnSync('python3',['-c','import base64,sys;sys.stdout.buffer.write(base64.b85decode(sys.stdin.read()))'],{input:encoded});
  assert.equal(b85.status,0);
  const program=brotliDecompressSync(b85.stdout).toString();
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
