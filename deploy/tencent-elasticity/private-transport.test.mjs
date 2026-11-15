import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile,lstat,symlink,rm,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import {once} from 'node:events';
import {installPrivateTransport,ensurePrivateExecutionNetwork,transportOperationSan} from './private-transport.mjs';
import {sha256} from './policy.mjs';
import {issueTransportCredentials} from './transport-issuer.mjs';
import {issueNodeEnrollment} from './enrollment.mjs';
import {createTransportRefresher,validateTransportLifecycleProof,selectTransportRenewalVersion} from './transport-refresher.mjs';
import {TRANSPORT_REFRESH_VERSION,renewNodeTransport,pruneExpiredTransportVersions} from './transport-renewal.mjs';
import {X509Certificate} from 'node:crypto';
import {createStunnelReloadController} from './stunnel-reload.mjs';
const exec=promisify(execFile);
const identity={account_id:'123456',region:'ap-beijing',instance_id:'ins-a1',epoch:'a3432123-84b5-4f11-8b51-94a29eac1234'};
async function fixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'bb-mtls-'));t.after(()=>rm(dir,{recursive:true}));
  await exec('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-days','2','-subj','/CN=synthetic-pg-ca','-keyout',join(dir,'ca.key'),'-out',join(dir,'ca.pem')]);
  await chmod(join(dir,'ca.pem'),0o600);
  for(const [name,cn,usage] of [['client',`${identity.instance_id}:${identity.epoch}`,'clientAuth'],['server','localhost','serverAuth']]) {
    await exec('openssl',['req','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-subj',`/CN=${cn}`,'-keyout',join(dir,`${name}.key`),'-out',join(dir,`${name}.csr`)]);
    await writeFile(join(dir,`${name}.ext`),`extendedKeyUsage=${usage}\n${name==='server'?'subjectAltName=DNS:localhost\n':''}`);
    await exec('openssl',['x509','-req','-in',join(dir,`${name}.csr`),'-CA',join(dir,'ca.pem'),'-CAkey',join(dir,'ca.key'),'-CAcreateserial','-days','1','-extfile',join(dir,`${name}.ext`),'-out',join(dir,`${name}.pem`)]);
  }
  const credentials={version:'execution-pg-mtls-v1',...identity,ca_pem:await readFile(join(dir,'ca.pem'),'utf8'),cert_pem:await readFile(join(dir,'client.pem'),'utf8'),key_pem:await readFile(join(dir,'client.key'),'utf8')};
  return {dir,credentials,expected:{...identity,ca_sha256:sha256(credentials.ca_pem)}};
}
async function shortLeaf(dir,credentials,{hours=1,operationId,requestId}={}){
  await writeFile(join(dir,'index'),'');await writeFile(join(dir,'serial'),'01\n');
  const cfg=join(dir,'sign.conf');await writeFile(cfg,`[ca]\ndefault_ca=x\n[x]\ndatabase=${dir}/index\nnew_certs_dir=${dir}\ncertificate=${dir}/ca.pem\nprivate_key=${dir}/ca.key\nserial=${dir}/serial\ndefault_md=sha256\npolicy=p\nunique_subject=no\nx509_extensions=e\n[p]\ncommonName=supplied\n[e]\nextendedKeyUsage=clientAuth\nbasicConstraints=critical,CA:FALSE\n`+(operationId?`subjectAltName=URI:${transportOperationSan(credentials,operationId,requestId)}\n`:''));
  const stamp=n=>new Date(n).toISOString().replace(/[-:TZ.]/g,'').slice(2,14)+'Z';
  await exec('openssl',['ca','-batch','-notext','-config',cfg,'-in',join(dir,'client.csr'),'-out',join(dir,'short.pem'),'-startdate',stamp(Date.now()-60000),'-enddate',stamp(Date.now()+hours*3600000)]);
  return {...credentials,cert_pem:await readFile(join(dir,'short.pem'),'utf8')};
}
test('overlapping renewal versions select the unique greatest signed expiry and reject tied winners',async t=>{
 const {dir,credentials,expected}=await fixture(t),state={identity,operation_id:'op1',provider_request_id:'ack1',source_sha256:'a'.repeat(64),image_sha256:'b'.repeat(64),launch_manifest_sha256:'c'.repeat(64)};
 const config={private_pg:{ca_sha256:expected.ca_sha256}},options={operationId:state.operation_id,requestId:state.provider_request_id};
 const active=await shortLeaf(dir,credentials,options),middle=await shortLeaf(dir,credentials,{...options,hours:4}),latest=await shortLeaf(dir,credentials,{...options,hours:8});
 const value=c=>({version:'execution-transport-envelope-v1',...state,transport_credentials:c}),versions=[active,middle,latest].map(c=>({value:value(c)}));
 for(const list of [versions,[...versions].reverse()])assert.equal(selectTransportRenewalVersion(list,state,config,active).transport_credentials,latest);
 const wrong={value:{...value(latest),image_sha256:'d'.repeat(64)}},badSignature={value:value({...latest,ca_pem:middle.cert_pem})};
 assert.equal(selectTransportRenewalVersion([wrong,badSignature,...versions],state,config,active).transport_credentials,latest);
 assert.throws(()=>selectTransportRenewalVersion([...versions,{value:value(latest)}],state,config,active),/TRANSPORT_RENEWAL_AMBIGUOUS/);
 assert.throws(()=>selectTransportRenewalVersion([{value:value(active)}],state,config,active),/TRANSPORT_RENEWAL_PENDING/);
 assert.equal(selectTransportRenewalVersion(versions,state,config,active,{now:()=>Date.now()+2*3600000}).transport_credentials,latest);
});
test('a valid replacement with under two hours remaining preserves transport but fences new admission',async t=>{
 const {dir,credentials,expected}=await fixture(t),old=await shortLeaf(dir,credentials,{hours:.5}),next=await shortLeaf(dir,credentials,{hours:1});
 const state={identity,provider_request_id:'ack',source_sha256:'a'.repeat(64),image_sha256:'b'.repeat(64),launch_manifest_sha256:'c'.repeat(64)};
 const config={services:[{service_id:'authoring'}],private_pg:{ca_sha256:expected.ca_sha256}};
 const request={version:TRANSPORT_REFRESH_VERSION,context:{identity,session_id:'a3432123-84b5-4f11-8b51-94a29eac9999'},service_id:'authoring'};
 let installed=0;
 const refresh=createTransportRefresher({config,state,readActive:async()=>old,broker:async()=>({version:'execution-transport-envelope-v1',...state,transport_credentials:next}),
   install:async()=>{installed++;},reload:async cert_sha256=>({cert_sha256}),probe:async()=>{}});
 const result=await refresh.refresh(request);assert.equal(result.status,'refreshed');assert.equal(result.admission_allowed,false);assert.equal(installed,1);
});
test('newly issued node/epoch mTLS credentials are private; different identity, CA and symlink fail closed',async t=>{
  const {dir,credentials,expected}=await fixture(t),target=join(dir,'private');
  const files=await installPrivateTransport(target,credentials,expected);
  assert.equal((await lstat(target)).mode&0o777,0o700);
  for(const file of Object.values(files))assert.equal((await lstat(file)).mode&0o777,0o600);
  await assert.rejects(installPrivateTransport(target,{...credentials,epoch:'old'},expected),/PG_CREDENTIAL_IDENTITY/);
  await assert.rejects(installPrivateTransport(target,credentials,{...expected,ca_sha256:'0'.repeat(64)}),/PG_CA_PIN/);
  await symlink(target,join(dir,'link'));await assert.rejects(installPrivateTransport(join(dir,'link'),credentials,expected),/PG_PRIVATE_DIRECTORY/);
  await rm(files.key_file);await symlink(join(dir,'client.key'),files.key_file);
  await assert.rejects(installPrivateTransport(target,credentials,expected),/PG_PRIVATE_FILE/);
});
test('private execution network is idempotent and refuses existing unreviewed bridge or uncertain inventory',async()=>{
  const config={execution_network:'synthetic-execution',execution_network_subnet:'172.28.61.0/24',private_pg:{local_host:'172.28.61.1'}};
  const row={Name:config.execution_network,Driver:'bridge',Internal:true,Labels:{'bondbuddy.execution.network':'v1'},IPAM:{Config:[{Subnet:config.execution_network_subnet,Gateway:config.private_pg.local_host}]}};
  let exists=false,creates=0;
  const docker=async a=>{if(a[1]==='inspect'){if(!exists)throw Error('not found');return JSON.stringify([row]);}if(a[1]==='ls')return 'bridge\nnone';if(a[1]==='create'){exists=true;creates++;return 'synthetic';}throw Error('unexpected');};
  await ensurePrivateExecutionNetwork(config,docker);await ensurePrivateExecutionNetwork(config,docker);assert.equal(creates,1);
  await assert.rejects(ensurePrivateExecutionNetwork(config,async()=>JSON.stringify([{...row,Internal:false}])),/NODE_NETWORK_DRIFT/);
  await assert.rejects(ensurePrivateExecutionNetwork(config,async a=>{if(a[1]==='inspect')throw Error();return config.execution_network;}),/NODE_NETWORK_OBSERVATION_UNKNOWN/);
});
test('operation-aware issuer signs a new warm epoch and preserves exact vault certificate/token after lost publish ACK',async t=>{
  const {dir,credentials}=await fixture(t),pg_issuer={ca_file:join(dir,'ca.pem'),ca_sha256:sha256(credentials.ca_pem),signing_key_file:join(dir,'ca.key')};
  const config={account_id:identity.account_id,region:identity.region,registration_directory:join(dir,'vault'),role_names:['role-a','role-b'],node_secrets:[{role_name:'role-a',role_id:'7',secret_name:'node-a',pg_issuer}]};
  const op={operation_id:'run1',state:'completed',action:'run',provider_request_id:'ack1',identity,request:{services:[{service_id:'authoring',capabilities:['authoring']}],source_sha256:'a'.repeat(64),image_sha256:'a'.repeat(64),launch_manifest_sha256:'a'.repeat(64)}};
  const stored=new Map();let puts=0;
  const transport={call:async(_,action,p)=>{if(action==='GetSecretValue'){if(!stored.has(p.VersionId)){const e=Error();e.code='ResourceNotFound';throw e;}return {SecretName:p.SecretName,VersionId:p.VersionId,SecretString:stored.get(p.VersionId)};}if(action==='PutSecretValue'){puts++;stored.set(p.VersionId,p.SecretString);throw Error('lost ACK');}if(action==='ModifyResourceTags')return {RequestId:'synthetic'};throw Error('unexpected');}};
  const options={operation:op,slot:0,config,transport,bind:async()=>{},serviceTemplate:{service_environments:{authoring:{DATABASE_URL:'synthetic-only'}}}};
  await issueNodeEnrollment(options);const first=stored.get('run1');await issueNodeEnrollment(options);assert.equal(stored.get('run1'),first);assert.equal(puts,1);
  const warm={...op,operation_id:'start1',action:'start',provider_request_id:'ack2',identity:{...identity,epoch:'b3432123-84b5-4f11-8b51-94a29eac1234'}};
  await issueNodeEnrollment({...options,operation:warm});const fresh=JSON.parse(stored.get('start1')).transport_credentials;
  assert.notEqual(sha256(fresh.cert_pem),sha256(JSON.parse(first).transport_credentials.cert_pem));
  await installPrivateTransport(join(dir,'warm'),fresh,{...warm.identity,ca_sha256:pg_issuer.ca_sha256});
  await assert.rejects(issueTransportCredentials(identity,{...pg_issuer,ca_sha256:'0'.repeat(64)}),/PG_ISSUER_CA_PIN/);
});
test('concurrent existing ticks share one renewal version; uncertain publish never reissues Put',async t=>{
  const {dir,credentials}=await fixture(t),old=await shortLeaf(dir,credentials),vault=join(dir,'vault');
  await import('node:fs/promises').then(fs=>fs.mkdir(vault,{mode:0o700}));
  const op={operation_id:'run1',state:'completed',action:'run',identity,provider_request_id:'ack',request:{source_sha256:'a'.repeat(64),image_sha256:'a'.repeat(64),launch_manifest_sha256:'a'.repeat(64)}};
  await writeFile(join(vault,sha256(op.operation_id)+'.json'),JSON.stringify({identity,provider_request_id:'ack',transport_credentials:old}),{mode:0o600});
  const config={account_id:identity.account_id,region:identity.region,registration_directory:vault,node_secrets:[{secret_name:'own-node',pg_issuer:{ca_file:join(dir,'ca.pem'),ca_sha256:sha256(credentials.ca_pem),signing_key_file:join(dir,'ca.key')}}]};
  let puts=0;const values=new Map();const transport={call:async(_,action,p)=>{if(action==='ListSecretVersionIds')return {SecretName:p.SecretName,Versions:[]};if(action==='GetSecretValue'){if(!values.has(p.VersionId)){const e=Error();e.code='ResourceNotFound';throw e;}return {SecretName:p.SecretName,VersionId:p.VersionId,SecretString:values.get(p.VersionId)};}if(action==='PutSecretValue'){puts++;values.set(p.VersionId,p.SecretString);throw Error('lost ACK');}return {RequestId:'synthetic'};}};
  const args={node:{state:'ready',identity},operation:op,slot:0,config,transport};
  await Promise.all([renewNodeTransport(args),renewNodeTransport(args),renewNodeTransport(args)]);assert.equal(puts,1);assert.equal(values.size,1);
  const unknownDir=join(dir,'unknown');await import('node:fs/promises').then(fs=>fs.mkdir(unknownDir,{mode:0o700}));await writeFile(join(unknownDir,sha256(op.operation_id)+'.json'),JSON.stringify({identity,provider_request_id:'ack',transport_credentials:old}),{mode:0o600});
  let unknownPuts=0;const unknown={...args,config:{...config,registration_directory:unknownDir},transport:{call:async(_,action,p)=>{if(action==='ListSecretVersionIds')return {SecretName:p.SecretName,Versions:[]};if(action==='PutSecretValue'){unknownPuts++;throw Error();}const e=Error();e.code='ResourceNotFound';throw e;}}};
  await assert.rejects(renewNodeTransport(unknown));await assert.rejects(renewNodeTransport(unknown));assert.equal(unknownPuts,1);
});
test('failed fresh-session verification fences admission until an actual retry succeeds; wrong material never installs',async t=>{
  const {dir,credentials,expected}=await fixture(t),old=await shortLeaf(dir,credentials);
  const fresh=await issueTransportCredentials(identity,{ca_file:join(dir,'ca.pem'),ca_sha256:expected.ca_sha256,signing_key_file:join(dir,'ca.key')});
  const state={identity,source_sha256:'a'.repeat(64),image_sha256:'a'.repeat(64),launch_manifest_sha256:'a'.repeat(64),provider_request_id:'ack'};
  const config={services:[{service_id:'authoring'}],private_pg:{ca_sha256:expected.ca_sha256}};
  const request={version:TRANSPORT_REFRESH_VERSION,context:{identity,session_id:'a3432123-84b5-4f11-8b51-94a29eac9999'},service_id:'authoring'};
  let active=old,time=Date.now(),fail=true,probes=0,installs=0;
  const make=()=>({version:'execution-transport-envelope-v1',...state,transport_credentials:fresh});
  const r=createTransportRefresher({config,state,readActive:async()=>active,broker:async()=>make(),install:async c=>{installs++;active=c;},reload:async cert_sha256=>({cert_sha256}),
    probe:async()=>{probes++;if(fail&&active===fresh)throw Error('synthetic interrupted PG');},now:()=>time});
  assert.equal((await r.refresh(request)).admission_allowed,false);assert.equal((await r.refresh(request)).admission_allowed,false);assert.equal(probes,2);
  time+=61000;fail=false;assert.equal((await r.refresh(request)).admission_allowed,true);assert.equal(probes,3);assert.equal(installs,1);
  let badInstalls=0;
  const bad=createTransportRefresher({config,state,readActive:async()=>old,broker:async()=>({...make(),identity:{...identity,epoch:'wrong'}}),install:async()=>{badInstalls++;},reload:async cert_sha256=>({cert_sha256}),probe:async()=>{}});
  assert.equal((await bad.refresh(request)).admission_allowed,false);assert.equal(badInstalls,0);
  assert.throws(()=>validateTransportLifecycleProof(null,{source_sha256:state.source_sha256,image_sha256:state.image_sha256}),/TRANSPORT_RENEWAL_PROOF_REQUIRED/);
});
test('SSM cleanup retains current versions and unproven old epochs; deletes only expired TLS or exact stopped-epoch credentials',async t=>{
  const {dir,credentials}=await fixture(t),leaf=await shortLeaf(dir,credentials),oldIdentity={...identity,epoch:'b3432123-84b5-4f11-8b51-94a29eac1234'};
  const values=new Map([['tls-expired',{version:'execution-transport-envelope-v1',identity,transport_credentials:leaf}],
    ['old-stopped',{identity:oldIdentity,expires_at:Date.now()-1000,transport_credentials:leaf}],
    ['unknown-old',{identity:{...identity,epoch:'c3432123-84b5-4f11-8b51-94a29eac1234'},expires_at:Date.now()-1000,transport_credentials:leaf}],
    ['keep-current',{version:'execution-transport-envelope-v1',identity,transport_credentials:leaf}]]);
  const deleted=[];const transport={call:async(_,action,p)=>{if(action==='ListSecretVersionIds')return {SecretName:p.SecretName,Versions:[...values.keys()].map(VersionId=>({VersionId}))};
    if(action==='DeleteSecretVersion'){deleted.push(p.VersionId);values.delete(p.VersionId);return {RequestId:'synthetic'};}
    if(!values.has(p.VersionId)){const e=Error();e.code='ResourceNotFound';throw e;}return {SecretName:p.SecretName,VersionId:p.VersionId,SecretString:JSON.stringify(values.get(p.VersionId))};}};
  await pruneExpiredTransportVersions({secretName:'own-node',keep:['keep-current'],scope:identity,stoppedIdentities:[oldIdentity],transport,now:()=>Date.now()+3601000});
  assert.deepEqual(deleted,['tls-expired','old-stopped']);assert.ok(values.has('unknown-old'));assert.ok(values.has('keep-current'));
});
test('same-epoch native stunnel reload preserves existing PG session and authenticates new sessions with the renewed leaf',
 {skip:!process.env.BB_TEST_DATABASE_URL||!process.env.BB_TEST_STUNNEL_BINARY,timeout:20000},async t=>{
  const {isolatedTestDatabase}=await import('../../apps/api/dist/test-database.js');
  const {Pool}=await import('pg');const connection=await isolatedTestDatabase(undefined,'private-mtls');
  const fixtureData=await fixture(t),{dir,expected}=fixtureData;
  const credentials=await shortLeaf(dir,fixtureData.credentials);
  const renewed=await issueTransportCredentials(identity,{ca_file:join(dir,'ca.pem'),ca_sha256:expected.ca_sha256,signing_key_file:join(dir,'ca.key')});
  const files=await installPrivateTransport(join(dir,'private'),credentials,expected);
  const url=new URL(connection),upstreamHost=url.hostname,upstreamPort=Number(url.port),sockets=new Set(),peers=[];
  const server=tls.createServer({key:await readFile(join(dir,'server.key')),cert:await readFile(join(dir,'server.pem')),
    ca:credentials.ca_pem,requestCert:true,rejectUnauthorized:true},s=>{
    assert.equal(s.authorized,true);peers.push(s.getPeerCertificate().fingerprint256);const upstream=net.connect(upstreamPort,upstreamHost);sockets.add(s);sockets.add(upstream);
    s.on('error',()=>{});upstream.on('error',()=>s.destroy());s.pipe(upstream).pipe(s);
  });server.on('tlsClientError',()=>{});server.listen(0,'127.0.0.1');await once(server,'listening');
  let child,closed,direct,through;
  t.after(async()=>{await through?.end();await direct?.end();if(child?.exitCode===null)child.kill('SIGTERM');if(closed)await closed;for(const s of sockets)s.destroy();server.close();});
  const reservation=net.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(r=>reservation.close(r));
  const conf=join(dir,'stunnel.conf');await writeFile(conf,`foreground = yes\npid =\ndebug = notice\noutput = /dev/null\n[pg]\nclient = yes\naccept = 127.0.0.1:${port}\nconnect = 127.0.0.1:${server.address().port}\nverifyChain = yes\ncheckHost = localhost\nsni = localhost\nCAfile = ${files.ca_file}\ncert = ${files.cert_file}\nkey = ${files.key_file}\n`,{mode:0o600});
  child=spawn(process.env.BB_TEST_STUNNEL_BINARY,[conf],{stdio:['ignore','ignore','pipe']});closed=once(child,'close');
  const nativeReload=createStunnelReloadController(child);await nativeReload.ready();
  const started=Date.now();for(;;){try{await new Promise((r,j)=>{const s=net.connect(port,'127.0.0.1');s.on('connect',()=>{s.destroy();r();});s.on('error',j);});break;}catch{assert.ok(Date.now()-started<3000);await new Promise(r=>setTimeout(r,25));}}
  direct=new Pool({connectionString:connection,max:1});
  const expectedId=(await direct.query('SELECT system_identifier::text FROM pg_control_system()')).rows[0].system_identifier;
  url.hostname='127.0.0.1';url.port=String(port);through=new Pool({connectionString:url.toString(),ssl:false,max:1,connectionTimeoutMillis:5000});
  const result=(await through.query('SELECT system_identifier::text,current_database(),current_user FROM pg_control_system()')).rows[0];
  assert.equal(result.system_identifier,expectedId);assert.equal(result.current_database,decodeURIComponent(url.pathname.slice(1)));assert.ok(result.current_user);
  const before=(await through.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  assert.equal(peers.at(-1),new X509Certificate(credentials.cert_pem).fingerprint256);
  let active=credentials;
  const state={identity,source_sha256:'a'.repeat(64),image_sha256:'a'.repeat(64),launch_manifest_sha256:'a'.repeat(64),provider_request_id:'ack'};
  const config={services:[{service_id:'authoring'}],private_pg:{ca_sha256:expected.ca_sha256}};
  const envelope={version:'execution-transport-envelope-v1',...state,transport_credentials:renewed};
  const refresh=createTransportRefresher({config,state,readActive:async()=>active,broker:async()=>envelope,
    install:async c=>{await installPrivateTransport(join(dir,'private'),c,expected);active=c;},
    reload:nativeReload.reload,
    probe:async()=>{const fresh=new Pool({connectionString:url.toString(),ssl:false,max:1});try{assert.equal((await fresh.query('SELECT system_identifier::text FROM pg_control_system()')).rows[0].system_identifier,expectedId);}finally{await fresh.end();}}});
  const request={version:TRANSPORT_REFRESH_VERSION,context:{identity,session_id:'a3432123-84b5-4f11-8b51-94a29eac9999'},service_id:'authoring'};
  const receipt=await refresh.refresh(request);assert.equal(receipt.status,'refreshed');assert.equal(receipt.admission_allowed,true);
  assert.equal(peers.at(-1),new X509Certificate(renewed.cert_pem).fingerprint256);
  assert.equal((await through.query('SELECT pg_backend_pid() pid')).rows[0].pid,before);
  assert.equal((await refresh.refresh(request)).status,'current');
  await assert.rejects(refresh.refresh({...request,context:{...request.context,identity:{...identity,epoch:'old'}}}),/TRANSPORT_REQUEST_SCOPE/);
});


test('concurrent refresh cannot pass the first asynchronous read; reload failure remains unverified across the next call',async t=>{
  const {dir,credentials,expected}=await fixture(t),old=await shortLeaf(dir,credentials);
  const fresh=await issueTransportCredentials(identity,{ca_file:join(dir,'ca.pem'),ca_sha256:expected.ca_sha256,signing_key_file:join(dir,'ca.key')});
  const state={identity,source_sha256:'a'.repeat(64),image_sha256:'a'.repeat(64),launch_manifest_sha256:'a'.repeat(64),provider_request_id:'ack'};
  const config={services:[{service_id:'authoring'},{service_id:'review'}],private_pg:{ca_sha256:expected.ca_sha256}};
  const request={version:TRANSPORT_REFRESH_VERSION,context:{identity,session_id:'a3432123-84b5-4f11-8b51-94a29eac9999'},service_id:'authoring'};
  let release,active=old,time=Date.now(),reads=0,reloads=0,probes=0,brokers=0,fail=true;
  const gate=new Promise(r=>{release=r;});
  const refresh=createTransportRefresher({config,state,now:()=>time,readActive:async()=>{reads++;await gate;return active;},
    broker:async()=>{brokers++;return {version:'execution-transport-envelope-v1',...state,transport_credentials:fresh};},
    install:async c=>{active=c;},reload:async cert_sha256=>{reloads++;if(fail&&active===fresh)throw Error('synthetic reload failure');return {cert_sha256};},probe:async()=>{probes++;}});
  const first=refresh.refresh(request);assert.equal((await refresh.refresh({...request,service_id:'review'})).admission_allowed,false);assert.equal(reads,1);release();
  assert.equal((await first).admission_allowed,false);assert.equal(brokers,1);assert.equal(probes,1);assert.equal(reloads,2);
  assert.equal((await refresh.refresh(request)).admission_allowed,false);assert.equal(reloads,2); // old in-memory identity could still answer PG
  time+=61000;fail=false;assert.equal((await refresh.refresh(request)).admission_allowed,true);assert.equal(reloads,3);assert.equal(probes,2);assert.equal(brokers,1);
  const restarted=createTransportRefresher({config,state,now:()=>time,readActive:async()=>active,broker:async()=>{throw Error('unnecessary');},install:async()=>{},
    reload:async cert_sha256=>{reloads++;return {cert_sha256};},probe:async()=>{probes++;}});
  assert.equal((await restarted.refresh(request)).admission_allowed,true);assert.equal(reloads,4); // restart never trusts disk alone
});

test('expired or nearly expired old material can recover through a valid same-epoch replacement',async t=>{
  const {dir,credentials,expected}=await fixture(t),old=await shortLeaf(dir,credentials);
  for(const remaining of [30000,-1000]){
    const time=Date.parse(new X509Certificate(old.cert_pem).validTo)-remaining;
    const fresh=await issueTransportCredentials(identity,{ca_file:join(dir,'ca.pem'),ca_sha256:expected.ca_sha256,signing_key_file:join(dir,'ca.key')});
    const state={identity,source_sha256:'a'.repeat(64),image_sha256:'a'.repeat(64),launch_manifest_sha256:'a'.repeat(64),provider_request_id:'ack'};
    const config={services:[{service_id:'authoring'}],private_pg:{ca_sha256:expected.ca_sha256}};
    let active=old,installs=0;
    const refresh=createTransportRefresher({config,state,now:()=>time,readActive:async()=>active,
      broker:async()=>({version:'execution-transport-envelope-v1',...state,transport_credentials:fresh}),install:async c=>{installs++;active=c;},
      reload:async cert_sha256=>({cert_sha256}),probe:async()=>{}});
    const result=await refresh.refresh({version:TRANSPORT_REFRESH_VERSION,context:{identity,session_id:'a3432123-84b5-4f11-8b51-94a29eac9999'},service_id:'authoring'});
    assert.equal(result.status,'refreshed');assert.equal(result.admission_allowed,true);assert.equal(installs,1);
  }
});


test('persisted control and broker rate bound survives recreation and a backwards clock',async t=>{
 const {acquireControlTick}=await import('./control-tick-bound.mjs');
 const dir=await mkdtemp(join(tmpdir(),'bb-control-rate-'));t.after(()=>rm(dir,{recursive:true}));
 let now=Date.now();const a=await acquireControlTick(dir,{now:()=>now});assert.equal(typeof a,'function');
 assert.equal(await acquireControlTick(dir,{now:()=>now+61000}),null);await a();
 assert.equal(await acquireControlTick(dir,{now:()=>now}),null);
 assert.equal(await acquireControlTick(dir,{now:()=>now-60000}),null);
 const b=await acquireControlTick(dir,{now:()=>now+61000});assert.equal(typeof b,'function');await b();
});


test('refresh response validation fences malformed, old identity and near-expiry admission',async()=>{
 const {validateTransportRefreshResponse}=await import('./transport-renewal.mjs');
 const now=Date.now(),request={version:TRANSPORT_REFRESH_VERSION,context:{identity,session_id:'a3432123-84b5-4f11-8b51-94a29eac9999'},service_id:'authoring'};
 const response={version:TRANSPORT_REFRESH_VERSION,identity,status:'current',not_after:new Date(now+86400000).toISOString(),admission_allowed:true,evidence_sha256:'a'.repeat(64)};
 assert.equal(validateTransportRefreshResponse(request,response,now).admissionAllowed,true);
 assert.equal(validateTransportRefreshResponse(request,{...response,status:'blocked',admission_allowed:false},now).admissionAllowed,false);
 assert.equal(validateTransportRefreshResponse(request,{...response,not_after:new Date(now+60000).toISOString()},now).admissionAllowed,false);
 assert.throws(()=>validateTransportRefreshResponse(request,{...response,identity:{...identity,epoch:'old'}},now),/TRANSPORT_REFRESH_RESPONSE_INVALID/);
 assert.throws(()=>validateTransportRefreshResponse(request,{...response,token:'forbidden'},now),/TRANSPORT_REFRESH_RESPONSE_INVALID/);
});
