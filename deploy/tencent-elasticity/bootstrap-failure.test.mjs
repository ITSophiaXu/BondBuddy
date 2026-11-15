import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import * as fs from 'node:fs/promises';
import {createBootstrapFailureRecorder} from './bootstrap-failure.mjs';
import {bootstrapNode} from './bootstrap.mjs';
import {runBootstrapEntry} from './bootstrap-entry.mjs';

const exec=promisify(execFile),secret='SYNTHETIC_PRIVATE_SECRET_7ad913',id='a'.repeat(64),h='b'.repeat(64);
const identity={account_id:'100',region:'ap-beijing',instance_id:'ins-synthetic',epoch:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'};
const services=[{service_id:'authoring',capabilities:['authoring']},{service_id:'review',capabilities:['review']}];
const material={verified:true,expires_at:Date.now()+600000,identity,services,source_sha256:h,image_sha256:h,
  launch_manifest_sha256:h,registration_token:secret,operation_completed:true};
const collect=()=>{const records=[];return {records,diagnostics:createBootstrapFailureRecorder({emit:r=>records.push(r)})};};

test('polluted exceptions and container state emit only bounded allowlisted fields',async()=>{
 const {records,diagnostics}=collect();diagnostics.stage('compose_up','authoring');
 await diagnostics.capture(Object.assign(Error(secret),{code:17,signal:secret,stdout:secret,
  stderr:`OCI runtime create failed: password=${secret}`,env:{TOKEN:secret},cause:Error(secret)}),async()=>[
  {id,service:'authoring',state:{Status:'exited',Running:false,ExitCode:42,Error:`permission denied: ${secret}`,Env:secret}},
  {id:secret,service:secret,state:{Status:secret,Error:secret}},
  {id:'c'.repeat(64),service:secret,state:{Status:secret,Running:secret,ExitCode:secret,Error:secret}},
 ]);
 const r=records[0];assert.equal(records.length,1);assert.equal(r.stage,'compose_up');assert.equal(r.exit_code,17);
 assert.equal(r.stderr_class,'oci_start_failed');assert.equal(r.signal,null);assert.equal(r.code,null);
 assert.equal(r.containers.length,2);assert.equal(r.containers[0].exit_code,42);assert.equal(r.containers[0].error_class,'permission_denied');
 assert.equal(r.containers[1].status,null);assert.equal(r.containers[1].service,null);
 assert.equal(JSON.stringify(records).includes(secret),false);
 for(const key of ['message','cause','stack','stdout','stderr','env'])assert.equal(Object.hasOwn(r,key),false);
});

test('unknown evidence and failed output cannot change cleanup or invent empty inventory',async()=>{
 const {records,diagnostics}=collect();diagnostics.stage(secret,secret);
 await diagnostics.capture(Object.assign(Error(secret),{code:secret,signal:secret}),async()=>{throw Error(secret);});
 assert.equal(records[0].containers,null);assert.equal(records[0].service,null);assert.equal(records[0].error_class,'unclassified');
 assert.equal(JSON.stringify(records).includes(secret),false);
 const failing=createBootstrapFailureRecorder({emit:async()=>{throw Error(secret);}});
 await failing.capture(Error(secret)); // Neither throw nor an unhandled rejected sink.
});

test('first startup failure is recorded before disableClaims, even when cleanup also fails',async()=>{
 const order=[],records=[];
 const diagnostics=createBootstrapFailureRecorder({emit:r=>{order.push('evidence');records.push(r);}});
 const original=Object.assign(Error(secret),{code:23,stderr:`permission denied ${secret}`});
 await assert.rejects(bootstrapNode({publicManifest:{version:'execution-bootstrap-v1',...material,account_id:'100',region:'ap-beijing'},
  metadata:identity,broker:{enroll:async()=>material},diagnostics,
  writeEnvelope:async()=>{order.push('envelope');return 'synthetic';},runtime:{
   verifyArtifacts:async()=>{},startService:async()=>{order.push('start');throw original;},
   failureContainers:async()=>[{id,service:'authoring',state:{Status:'created',Running:false,ExitCode:0}}],
   disableClaims:async()=>{order.push('cleanup');throw Error('synthetic cleanup failure');},
  }}),/synthetic cleanup failure/);
 assert.deepEqual(order,['envelope','start','evidence','cleanup']);assert.equal(records[0].stage,'service_start');
 assert.equal(records[0].exit_code,23);assert.equal(records[0].containers[0].status,'created');
 await diagnostics.capture(Error('later'));assert.equal(records.length,1);
});

test('entry preserves early failure phase before admission release and keeps success silent',async()=>{
 for(const fail of ['metadata','enrollment','artifacts',null]){
  const {records,diagnostics}=collect(),events=[];
  const reject=stage=>{if(fail===stage)throw Object.assign(Error(secret),{code:'EACCES'});};
  const args={diagnostics,readConfig:async()=>({enabled:true,adapter_path:'/opt/bondbuddy/adapter.mjs',adapter_sha256:h}),
   readManifest:async()=>({version:'execution-bootstrap-v1',...material,account_id:'100',region:'ap-beijing'}),
   readAdapter:async()=>Buffer.from('unused'),importAdapter:async()=>({}),enableBootstrap:async()=>{},
   writeEnvelope:async()=>'/synthetic/envelope.json',acquireAdmission:async()=>async()=>events.push('release')};
  // Real adapter-byte check, with synthetic bytes and exact hash.
  const {sha256}=await import('./policy.mjs');args.readConfig=async()=>({enabled:true,adapter_path:'/opt/bondbuddy/adapter.mjs',adapter_sha256:sha256('unused')});
  args.importAdapter=async()=>({createConfiguredNodeAdapter:async(_selection,{diagnostics:shared})=>{
   assert.equal(shared,diagnostics);return {metadata:async()=>{reject('metadata');return identity;},broker:{enroll:async()=>{reject('enrollment');return material;}},
    runtime:{verifyArtifacts:async()=>reject('artifacts'),startService:async()=>({id}),verifyAllReady:async()=>{},disableClaims:async()=>events.push('cleanup')}};
  }});
  if(fail){await assert.rejects(runBootstrapEntry(args));assert.equal(records.length,1);
   assert.equal(records[0].stage,{metadata:'metadata',enrollment:'enrollment',artifacts:'artifact_verification'}[fail]);assert.equal(records[0].code,'EACCES');}
  else {await runBootstrapEntry(args);assert.deepEqual(records,[]);}
  assert.deepEqual(events,['release']);assert.equal(JSON.stringify(records).includes(secret),false);
 }
});

test('actual command exit/stdout/stderr remain private while safe exit and category survive',async()=>{
 const {records,diagnostics}=collect();diagnostics.stage('compose_up','authoring');
 let failure;
 try{await exec(process.execPath,['-e',`process.stdout.write(${JSON.stringify(secret)});process.stderr.write(${JSON.stringify('permission denied '+secret)});process.exit(37)`],{timeout:5000});}
 catch(error){failure=error;}
 assert.equal(failure.code,37);assert.ok(failure.stdout.includes(secret));assert.ok(failure.stderr.includes(secret));
 await diagnostics.capture(failure);assert.equal(records[0].exit_code,37);assert.equal(records[0].stderr_class,'permission_denied');
 assert.equal(JSON.stringify(records).includes(secret),false);
});

test('actual adapter distinguishes probe, Compose and state failures without running a consumer',async t=>{
 // Only filesystem writes/ownership are synthetic. Production adapter order and
 // failure capture run unchanged; Docker IO is injected, no daemon/PG/model.
 t.mock.module('node:fs/promises',{namedExports:{...fs,writeFile:async()=>{},chmod:async()=>{},chown:async()=>{}}});
 const {createNodeAdapter}=await import('./node-adapter.mjs');
 for(const fault of ['pg_probe_start','compose_up','compose_id'])await t.test(fault,async()=>{
  const {records,diagnostics}=collect(),calls=[];
  const config={runtime_uid:1000,image_sha256:h,compose_file:'/opt/bondbuddy/compose.yaml',images:{authoring:h},services,
   execution_network:'synthetic',private_pg:{local_host:'127.0.0.1',local_port:12345,system_identifier:'123'}};
  const failed=Object.assign(Error(secret),{code:19,stderr:`OCI runtime start failed ${secret}`});
  const adapter=createNodeAdapter(config,{diagnostics,enrollmentBroker:{enroll:async()=>({...material,
   service_environments:{authoring:{DATABASE_URL:'postgres://synthetic@127.0.0.1:12345/synthetic'}}})},runDocker:async args=>{
    calls.push(args);
    if(args[0]==='create')return id;
    if(args[0]==='start'){if(fault==='pg_probe_start')throw failed;return '{"system_identifier":"123"}';}
    if(args[0]==='rm')return id;
    if(args[0]==='inspect')return args[2]==='{{.State.Running}}'?'false':JSON.stringify({Status:'created',Running:false,ExitCode:0,Error:secret});
    if(args.includes('up')){if(fault==='compose_up')throw failed;return '';}
    if(args.includes('ps'))return fault==='compose_id'&&!args.includes('-a')?'':id;
    throw Error('unexpected command');
   }});
  await adapter.broker.enroll(identity);
  await assert.rejects(adapter.runtime.startService(services[0],'/synthetic/envelope.json'));
  assert.equal(records.length,fault==='compose_id'?0:1); // invariant captured by bootstrap before cleanup below
  if(fault==='compose_id')await diagnostics.capture(Error('NODE_CONTAINER_ID'),adapter.runtime.failureContainers);
  assert.equal(records[0].stage,fault);assert.equal(records[0].service,'authoring');
  assert.equal(JSON.stringify(records).includes(secret),false);
  if(fault==='pg_probe_start')assert.ok(calls.findIndex(c=>c[0]==='inspect'&&c[2]==='{{json .State}}')<calls.findIndex(c=>c[0]==='rm'));
 });
});
