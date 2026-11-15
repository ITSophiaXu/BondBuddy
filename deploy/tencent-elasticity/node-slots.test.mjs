import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createConfiguredNodeAdapter,selectExecutionNodeConfig} from './node-adapter.mjs';
import {canonical,sha256} from './policy.mjs';
import {bootstrapUserData,bootstrapNode} from './bootstrap.mjs';
import {executionInstanceLaunchBinding} from '@bondbuddy/contracts';

// Actual configured adapter, default IMDS credential reader, STS/CVM signer and
// SSM broker. Only their lowest HTTP/metadata/Docker IO is synthetic. No live
// source credentials, network access, cloud effects or claim admission here.
const source='a'.repeat(64),services=[{service_id:'authoring',capabilities:['authoring']},{service_id:'review',capabilities:['review','assistant']}];
const images={authoring:'synthetic/image@sha256:'+'b'.repeat(64),review:'synthetic/image@sha256:'+'c'.repeat(64)};
const slots=[
  {role_name:'synthetic-node-one',role_id:'100000000011',secret_name:'synthetic-enrollment-one'},
  {role_name:'synthetic-node-two',role_id:'100000000012',secret_name:'synthetic-enrollment-two'},
];
const common={runtime_uid:1000,account_id:'100000000001',region:'ap-beijing',image_sha256:sha256(canonical(images)),images,services,
  compose_file:'/opt/bondbuddy/compose.yaml',private_pg:{system_identifier:'12345'},private_proxy:{sni:'synthetic-proxy.internal'}};
const configFor=()=>({...common,node_slots:structuredClone(slots)});
const manifestFor=slot=>({version:'execution-bootstrap-v1',account_id:common.account_id,region:common.region,
  source_sha256:source,image_sha256:common.image_sha256,services,slot_binding:structuredClone(slots[slot])});

async function withAdapter(slot,run,{manifest=manifestFor(slot),config=configFor(),fault,observedEpoch}={}){
  const originalFetch=globalThis.fetch,metadataReads=[],calls=[];
  const instance=`ins-synthetic${slot+1}`,epoch=randomUUID(),operation=`synthetic-operation-${slot+1}`,ack=`synthetic-ack-${slot+1}`;
  const envelope={identity:{account_id:common.account_id,region:common.region,instance_id:instance,epoch},role_id:slots[slot].role_id,
    expires_at:Date.now()+600000,operation_completed:true,operation_id:operation,provider_request_id:ack,
    registration_token:randomUUID(),services,source_sha256:source,image_sha256:common.image_sha256,launch_manifest_sha256:source};
  const cloudInstance={InstanceId:instance,InstanceState:'RUNNING',CamRoleName:slots[slot].role_name,LatestOperationRequestId:null,LatestOperationState:null,LatestOperation:null,
    CreatedTime:new Date().toISOString(),Tags:[{Key:'bondbuddy-enrollment-version',Value:operation},{Key:'bondbuddy-create-op',Value:operation},{Key:'bondbuddy-pool',Value:'synthetic'}]};
  const launchBinding=sha256(canonical(executionInstanceLaunchBinding(cloudInstance)));
  envelope.operation_action='run';
  envelope.run_acceptance={operation_id:operation,identity:envelope.identity,provider_request_id:ack,instance_ids:[instance],client_token:sha256(canonical(operation)),
    launch_manifest_sha256:source,launch_binding_sha256:launchBinding,evidence_ref:'synthetic/acceptance',evidence_sha256:source};
  envelope.run_creation={operation_id:operation,identity:envelope.identity,launch_manifest_sha256:source,launch_binding_sha256:launchBinding,
    created_at:cloudInstance.CreatedTime,instance_status:'RUNNING',status_request_id:'synthetic-status'};
  globalThis.fetch=async(url,options)=>{
    const target=new URL(url);
    if(target.hostname==='metadata.tencentyun.com'){
      const role=target.pathname.split('/').at(-1);metadataReads.push(role);
      assert.equal(role,slots[slot].role_name,'the adapter may only request its selected role credentials');
      return new Response(JSON.stringify({TmpSecretId:randomUUID(),TmpSecretKey:randomUUID(),Token:randomUUID(),ExpiredTime:Math.floor(Date.now()/1000)+3600}));
    }
    const service=target.hostname.split('.')[0],action=options.headers['X-TC-Action'],payload=JSON.parse(options.body);
    calls.push({service,action,payload});
    assert.match(options.headers.Authorization,/^TC3-HMAC-SHA256 /);assert.ok(options.headers['X-TC-Token']);
    let response;
    if(service==='sts'&&action==='GetCallerIdentity')response={AccountId:common.account_id,UserId:slots[slot].role_id+':synthetic-session',Type:'CAMRole'};
    else if(service==='cvm'&&action==='DescribeInstances'){
      assert.deepEqual(payload,{InstanceIds:[instance]});
      response={InstanceSet:[structuredClone(cloudInstance)]};
    }else if(service==='ssm'&&action==='GetSecretValue'){
      assert.deepEqual(payload,{SecretName:slots[slot].secret_name,VersionId:operation});
      response={SecretName:slots[slot].secret_name,VersionId:operation,SecretString:JSON.stringify(envelope)};
    }else throw Error('unexpected synthetic cloud action');
    if(fault)response=fault({service,action,response,envelope});
    return new Response(JSON.stringify({Response:{...response,RequestId:randomUUID()}}));
  };
  try{
    const adapter=await createConfiguredNodeAdapter({publicManifest:manifest},{readConfig:async()=>config,
      readMetadata:async path=>{assert.ok(['instance-id','placement/region'].includes(path));return path==='instance-id'?instance:common.region;},
      runDocker:async()=>JSON.stringify({...envelope,epoch:observedEpoch??epoch,state:'ready',system_identifier:'12345',expected_sessions_ready:true})});
    return await run({adapter,metadataReads,calls,envelope});
  }finally{globalThis.fetch=originalFetch;}
}

test('one shared image selects each exact role/secret through the actual configured adapter and default broker',async()=>{
  for(let slot=0;slot<2;slot++)await withAdapter(slot,async({adapter,metadataReads,calls,envelope})=>{
    const metadata=await adapter.metadata(),verified=await adapter.broker.enroll(metadata);
    assert.equal(verified.verified,true);assert.deepEqual(verified.identity,envelope.identity);assert.equal(verified.role_id,slots[slot].role_id);
    await adapter.runtime.verifyAllReady([{id:'a'.repeat(64)},{id:'b'.repeat(64)}]);
    assert.deepEqual(metadataReads,[slots[slot].role_name,slots[slot].role_name,slots[slot].role_name]);
    assert.deepEqual(calls.map(c=>c.action),['GetCallerIdentity','DescribeInstances','GetSecretValue']);
    assert.equal(calls.at(-1).payload.SecretName,slots[slot].secret_name);
    const selected=selectExecutionNodeConfig(configFor(),manifestFor(slot));
    assert.deepEqual(selected.images,images);assert.equal(selected.image_sha256,common.image_sha256);
    assert.deepEqual(selected.private_pg,common.private_pg);assert.deepEqual(selected.private_proxy,common.private_proxy);assert.equal(selected.node_slots,undefined);
  });
});

test('the actual bootstrap producer passes each bound slot to the configured adapter and default broker',async()=>{
  for(let slot=0;slot<2;slot++){
    const userData=bootstrapUserData({pool_tag:'synthetic',role_names:slots.map(s=>s.role_name),node_secrets:slots},
      {account_id:common.account_id,region:common.region,source_sha256:source,image_sha256:common.image_sha256,services},slot);
    const match=userData.match(/printf '%s' '([^']+)' >/);assert.ok(match);
    const manifest=JSON.parse(match[1]);assert.deepEqual(manifest.slot_binding,slots[slot]);
    await withAdapter(slot,async({adapter})=>{
      const verified=await adapter.broker.enroll(await adapter.metadata());assert.equal(verified.role_id,slots[slot].role_id);
    },{manifest});
  }
});

test('missing, unknown, multi-valued and crossed public bindings never fall back to the first slot',async()=>{
  const bad=[
    {...manifestFor(1),slot_binding:undefined},
    {...manifestFor(1),slot_binding:null},
    {...manifestFor(1),slot_binding:{...slots[1],role_name:'unknown-role'}},
    {...manifestFor(1),slot_binding:{...slots[1],role_name:[slots[0].role_name,slots[1].role_name]}},
    {...manifestFor(1),slot_binding:{...slots[1],role_id:slots[0].role_id}},
    {...manifestFor(1),slot_binding:{...slots[1],secret_name:slots[0].secret_name}},
    {...manifestFor(1),slot_binding:{...slots[1],secret_name:'*'}},
    {...manifestFor(1),slot_binding:{...slots[1],unexpected:'ignored'}},
  ];
  for(const manifest of bad)await withAdapter(1,async()=>assert.fail('invalid binding produced an adapter'),{manifest}).then(
    ()=>assert.fail('invalid binding accepted'),error=>assert.match(error.message,/NODE_SLOT_/));
  const missing=manifestFor(0);delete missing.slot_binding;
  assert.throws(()=>selectExecutionNodeConfig(configFor(),missing),/BINDING_REQUIRED/);
});

test('duplicate role names, role IDs or secrets and mixed single/shared templates reject ambiguous selection',()=>{
  for(const key of ['role_name','role_id','secret_name']){
    const config=configFor();config.node_slots[1][key]=config.node_slots[0][key];
    assert.throws(()=>selectExecutionNodeConfig(config,manifestFor(0)),/TEMPLATE_INVALID/);
  }
  for(const slots of [[],[configFor().node_slots[0]],null])assert.throws(()=>selectExecutionNodeConfig({...common,node_slots:slots},manifestFor(0)),/TEMPLATE_INVALID/);
  assert.throws(()=>selectExecutionNodeConfig({...configFor(),...slots[0]},manifestFor(0)),/CONFIG_CONFLICT/);
});

test('slot selection rejects mismatched common scope and malformed source pins',()=>{
  for(const change of [{version:'other'},{account_id:'100000000002'},{region:'other'},{image_sha256:'d'.repeat(64)},{source_sha256:null},{services:[services[0]]}])
    assert.throws(()=>selectExecutionNodeConfig(configFor(),{...manifestFor(0),...change}),/PUBLIC_CONFIG_MISMATCH/);
});

test('a selected role cannot bypass the bootstrap source pin before any envelope is written',async()=>{
  const manifest={...manifestFor(1),source_sha256:'d'.repeat(64)};
  await withAdapter(1,async({adapter})=>{
    await assert.rejects(bootstrapNode({publicManifest:manifest,metadata:await adapter.metadata(),broker:adapter.broker,
      runtime:adapter.runtime,writeEnvelope:async()=>assert.fail('a mismatched source wrote an envelope')}),/ENROLLMENT_BINDING/);
  },{manifest});
});

test('selection does not replace STS, exact instance/role or own secret proof',async()=>{
  const cases=[
    {code:/NODE_ROLE_MISMATCH/,fault:x=>x.service==='sts'?{...x.response,UserId:slots[0].role_id+':other'}:x.response},
    {code:/NODE_INSTANCE_SCOPE/,fault:x=>x.service==='cvm'?{InstanceSet:[{...x.response.InstanceSet[0],CamRoleName:slots[0].role_name}]}:x.response},
    {code:/NODE_INSTANCE_SCOPE/,fault:x=>x.service==='cvm'?{InstanceSet:[{...x.response.InstanceSet[0],CamRoleName:'unknown-role'}]}:x.response},
    {code:/NODE_INSTANCE_SCOPE/,fault:x=>x.service==='cvm'?{InstanceSet:[{...x.response.InstanceSet[0],CamRoleName:slots.map(s=>s.role_name)}]}:x.response},
    {code:/NODE_INSTANCE_SCOPE/,fault:x=>x.service==='cvm'?{InstanceSet:[x.response.InstanceSet[0],x.response.InstanceSet[0]]}:x.response},
    {code:/NODE_SECRET_VERSION_MISMATCH/,fault:x=>x.service==='ssm'?{...x.response,SecretName:slots[0].secret_name}:x.response},
    {code:/NODE_SECRET_BINDING/,fault:x=>x.service==='ssm'?{...x.response,SecretString:JSON.stringify({...x.envelope,role_id:slots[0].role_id})}:x.response},
  ];
  for(const entry of cases)await withAdapter(1,async({adapter})=>{
    await assert.rejects(adapter.broker.enroll(await adapter.metadata()),entry.code);
  },{fault:entry.fault});
});

test('selected slot cannot mark a different observed database epoch ready',async()=>{
  for(let slot=0;slot<2;slot++)await withAdapter(slot,async({adapter})=>{
    await adapter.broker.enroll(await adapter.metadata());
    await assert.rejects(adapter.runtime.verifyAllReady([{id:'a'.repeat(64)},{id:'b'.repeat(64)}]),/NODE_PG_IDENTITY_DRIFT/);
  },{observedEpoch:randomUUID()});
});

test('single-config compatibility still requires an exact supplied binding',()=>{
  const single={...common,...slots[0]};assert.deepEqual(selectExecutionNodeConfig(single),single);
  assert.deepEqual(selectExecutionNodeConfig(single,manifestFor(0)),single);
  assert.throws(()=>selectExecutionNodeConfig(single,manifestFor(1)),/NOT_UNIQUE/);
  assert.throws(()=>selectExecutionNodeConfig(single,{...manifestFor(0),slot_binding:null}),/BINDING_INVALID/);
});
