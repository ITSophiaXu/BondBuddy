import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,X509Certificate} from 'node:crypto';
import {Value} from '@sinclair/typebox/value';
import {ExecutionCloudObservationSchema,executionCloudCompletionMatches} from '@bondbuddy/contracts';
import {TencentCvm,TencentTransport,runParameters} from './tencent-cvm.mjs';
import {ExecutionPoolController} from './controller.mjs';
import {bootstrapUserData} from './bootstrap.mjs';
import {observationArchive} from './private-files.mjs';
import {issueNodeEnrollment,createSsmEnrollmentBroker,nodeCloudCompletionMatches} from './enrollment.mjs';
import {createControlAuthority,readAuthorityRegisteredNodes} from './control-authority.mjs';
import {canonical,sha256,validateConfig,retainedNodePin} from './policy.mjs';
import {executionCloudClientToken} from '@bondbuddy/api/execution-capacity';
import {createExecutionPoolOpsHandler} from './ops-handler.mjs';
import {produceExpenseSnapshot} from './costcap.mjs';

const exec=promisify(execFile),h='a'.repeat(64);
const services=[{service_id:'authoring',capabilities:['authoring']}];
const config={version:'tencent-execution-pool-v1',enabled:true,phase:'single_node_validation',account_id:'123456',pool_tag:'synthetic-pool',region:'ap-beijing',zone:'ap-beijing-7',
  instance_type:'SA9.LARGE16',min_running:1,max_owned:2,global_model_limit:4,node_model_limit:4,compute_cny_per_hour:.8,compute_cap_cny_per_hour:1.6,noncompute_cap_cny_per_hour:.8,total_cap_cny_per_hour:2.4,
  scale_up_wait_seconds:60,idle_seconds:300,failure_cooldown_seconds:300,image_id:'img-synthetic',vpc_id:'vpc-synthetic',subnet_id:'subnet-synthetic',security_group_id:'sg-synthetic',
  source_sha256:h,image_sha256:h,network_review_sha256:h,quote_sha256:h,role_names:['synthetic-one','synthetic-two'],private_pg_verified:true,service_credentials_verified:true,
  services,expense_policy_revision:1,expense_policy_sha256:h,time_zone:'Asia/Shanghai',period_cap_cny:48,reservation_hours:1,drain_reserve_hours:1,
  node_secrets:[{role_name:'synthetic-one',role_id:'7',secret_name:'synthetic-one'},{role_name:'synthetic-two',role_id:'8',secret_name:'synthetic-two'}]};

export async function runFixture(t,slot=0){
  const directory=await mkdtemp(join(tmpdir(),'bb-run-proof-'));t.after(()=>rm(directory,{recursive:true}));
  const operation_id='synthetic-'+randomUUID(),epoch=randomUUID(),client_token=sha256(canonical(operation_id)),now=Date.now();
  const request={account_id:config.account_id,region:config.region,instance_id:null,instance_count:1,epoch,source_sha256:h,image_sha256:h,launch_manifest_sha256:h,capabilities:['authoring'],services};
  request.launch_manifest_sha256=sha256(canonical(runParameters(config,request,client_token,bootstrapUserData(config,request,slot),slot,operation_id)));
  const params=runParameters(config,request,client_token,bootstrapUserData(config,request,slot),slot,operation_id);
  const instance={...params,InstanceId:'ins-synthetic'+slot,InstanceState:'RUNNING',CreatedTime:new Date(now).toISOString(),Tags:params.TagSpecification[0].Tags,
    LatestOperation:null,LatestOperationState:null,LatestOperationRequestId:null,PublicIpAddresses:[]};
  let operation={operation_id,identity:null,action:'run',state:'intent',revision:0,client_token,provider_request_id:null,request,proof_sha256:null,retry_after:null};
  const calls=[],secrets=new Map();let mutation;
  const transport=new TencentTransport({region:config.region,credentials:async()=>({secretId:'synthetic',secretKey:'synthetic',token:'synthetic',expiresAt:Date.now()+600000}),fetchImpl:async(_url,options)=>{
    const action=options.headers['X-TC-Action'],payload=JSON.parse(options.body);calls.push(action);let result;
    if(action==='GetCallerIdentity')result={AccountId:config.account_id,UserId:config.node_secrets[slot].role_id+':synthetic'};
    else if(action==='RunInstances'){assert.equal(payload.CamRoleName,config.role_names[slot]);result={RequestId:'synthetic-accepted',InstanceIdSet:[instance.InstanceId]};}
    else if(action==='DescribeInstances'){
      if(payload.Filters)assert.deepEqual(payload,{Filters:[{Name:'tag:bondbuddy-execution-slot',Values:[config.role_names[slot]]}],Limit:3});
      else assert.deepEqual(payload,{InstanceIds:[instance.InstanceId]});result={TotalCount:1,InstanceSet:[structuredClone(instance)]};}
    else if(action==='DescribeInstancesStatus'){assert.deepEqual(payload,{InstanceIds:[instance.InstanceId]});result={InstanceStatusSet:[{InstanceId:instance.InstanceId,InstanceState:instance.InstanceState}]};}
    else if(action==='ListSecretVersionIds')result={SecretName:payload.SecretName,Versions:[...secrets.keys()].map(VersionId=>({VersionId}))};
    else if(action==='GetSecretValue'){const value=secrets.get(payload.VersionId);result=value?{SecretName:payload.SecretName,VersionId:payload.VersionId,SecretString:value}:{Error:{Code:'ResourceNotFound'}};}
    else if(action==='PutSecretValue'){secrets.set(payload.VersionId,payload.SecretString);result={};}
    else throw Error('unexpected synthetic action');
    if(mutation)result=mutation(action,result);
    return new Response(JSON.stringify({Response:{RequestId:'synthetic-read-'+action,...result}}));
  }});
  const poolConfig=structuredClone(config);
  const cloud=new TencentCvm({transport,config:poolConfig,archive:observationArchive(directory)});
  const control={claimCloudDispatch:async()=>operation={...operation,state:'unknown',revision:1,dispatched_at:new Date(now).toISOString()},loadOperation:async()=>operation,
    recordCloudResult:async(_id,revision,result)=>{assert.equal(revision,operation.revision);operation={...operation,...result,cloud_observation:result.observation,revision:revision+1};return operation;}};
  const controller=new ExecutionPoolController({config:poolConfig,cloud,control});
  return {config:poolConfig,cloud,controller,control,transport,instance,calls,secrets,directory,slot,get operation(){return operation;},set operation(value){operation=value;},set mutation(value){mutation=value;}};
}

async function retainedFixture(t) {
  const f=await runFixture(t);await f.controller.dispatch(f.operation,{slot:0});await f.controller.recover(f.operation.operation_id);
  const original=structuredClone(f.operation);
  const pin={instance_id:f.instance.InstanceId,image_id:f.instance.ImageId,source_sha256:f.config.source_sha256,image_sha256:f.config.image_sha256,
    role_name:f.instance.CamRoleName,create_operation_id:original.operation_id,launch_manifest_sha256:original.request.launch_manifest_sha256,
    launch_binding_sha256:original.run_acceptance.launch_binding_sha256};
  f.config.retained_nodes=[pin];f.config.image_id='img-new';f.config.image_sha256='b'.repeat(64);f.config.source_sha256='c'.repeat(64);
  const node={identity:{...original.identity,epoch:randomUUID()},state:'stopped',source_sha256:pin.source_sha256,image_sha256:pin.image_sha256,
    launch_manifest_sha256:pin.launch_manifest_sha256,expected_services:original.request.services,capabilities:original.request.capabilities,
    cloud_start_operation_id:'synthetic-latest-warm',ready_slots:0};
  const snapshot={policy:{revision:1,managed_nodes:true,budget_available:true,node_model_limit:4,global_model_limit:4,max_nodes:2},
    nodes:[node],pending_cloud_reservations:0,active_model_calls:0,groups:[],effective_queued_work:0};
  f.control.snapshot=async()=>snapshot;
  f.control.loadOperation=async id=>id===pin.create_operation_id?original:f.operation;
  f.cloud.control=f.control;
  const warm={operation_id:'synthetic-warm',identity:{...node.identity,epoch:randomUUID()},action:'start',state:'intent',revision:0,
    request:{...original.request,instance_id:pin.instance_id,epoch:randomUUID()},client_token:executionCloudClientToken('synthetic-warm')};
  warm.request.epoch=warm.identity.epoch;
  const read=f.transport.call.bind(f.transport),writes=[];
  f.transport.call=async(service,action,payload,options)=>{
    if(action==='StartInstances'){writes.push({action,payload});return {RequestId:'synthetic-warm-ack'};}
    if(action==='RunInstances'){
      writes.push({action,payload});return {RequestId:'synthetic-new-ack',InstanceIdSet:['ins-new']};
    }
    if(action==='DescribeInstances'&&payload.Filters?.[0].Name==='tag:bondbuddy-pool')return {TotalCount:1,InstanceSet:[f.instance],RequestId:'synthetic-inventory'};
    return read(service,action,payload,options);
  };
  f.instance.InstanceState='STOPPED';
  return {...f,original,pin,node,snapshot,warm,writes};
}

test('retained instance inventory and warm Start preserve original Run despite a newer epoch and default image',async t=>{
  const f=await retainedFixture(t);
  const inventory=await f.cloud.inventory();assert.equal(inventory.length,1);assert.equal(inventory[0].instance_id,f.pin.instance_id);
  assert.notEqual(f.node.identity.epoch,f.original.identity.epoch);assert.notEqual(f.node.cloud_start_operation_id,f.pin.create_operation_id);
  const result=await f.cloud.execute(f.warm);assert.equal(result.RequestId,'synthetic-warm-ack');
  assert.deepEqual(f.writes,[{action:'StartInstances',payload:{InstanceIds:[f.pin.instance_id]}}]);
  // The same business pins also support a cloud ImageId-only replacement.
  f.config.source_sha256=f.pin.source_sha256;f.config.image_sha256=f.pin.image_sha256;
  await f.cloud.describe(f.pin.instance_id);
});

test('new Run uses only the new default image and pins while the retained instance remains registered',async t=>{
  const f=await retainedFixture(t),id='synthetic-cold',slot=1;
  const request={...f.original.request,source_sha256:f.config.source_sha256,image_sha256:f.config.image_sha256,epoch:randomUUID()};
  const token=executionCloudClientToken(id),userData=bootstrapUserData(f.config,request,slot);
  request.launch_manifest_sha256=sha256(canonical(runParameters(f.config,request,token,userData,slot,id)));
  const result=await f.cloud.execute({action:'run',operation_id:id,client_token:token,request},{slot,userData});
  assert.equal(result.InstanceIdSet[0],'ins-new');assert.equal(f.writes.length,1);
  const params=f.writes[0].payload;assert.equal(params.ImageId,'img-new');assert.equal(params.CamRoleName,f.config.role_names[1]);
  const manifest=JSON.parse(Buffer.from(params.UserData,'base64').toString().match(/printf '%s' '([^']+)'/)[1]);
  assert.equal(manifest.source_sha256,f.config.source_sha256);assert.equal(manifest.image_sha256,f.config.image_sha256);
  const cold={...params,InstanceId:'ins-new',Tags:params.TagSpecification[0].Tags,PublicIpAddresses:[],InstanceState:'RUNNING'};
  const read=f.transport.call;
  f.transport.call=async(service,action,payload,options)=>{
    if(action!=='DescribeInstances')return read(service,action,payload,options);
    const all=[f.instance,cold],instances=payload.InstanceIds?all.filter(i=>payload.InstanceIds.includes(i.InstanceId)):
      payload.Filters[0].Name==='tag:bondbuddy-pool'?all:all.filter(i=>i.CamRoleName===payload.Filters[0].Values[0]);
    return {TotalCount:instances.length,InstanceSet:instances,RequestId:'synthetic-mixed-inventory'};
  };
  const inventory=await f.cloud.inventory();assert.deepEqual(inventory.map(i=>i.instance_id),[f.pin.instance_id,'ins-new']);
});

test('retained pins cannot authorize an unregistered, destroyed or changed node or an unproven original Run',async t=>{
  const f=await retainedFixture(t);
  const node=structuredClone(f.node),original=structuredClone(f.original);
  const cases=[()=>{f.snapshot.nodes=[];},()=>{f.snapshot.nodes=[node,node];},()=>{f.node.state='destroyed';},
    ()=>{f.node.identity.instance_id='ins-other';},()=>{f.node.identity.account_id='654321';},()=>{f.node.identity.region='other';},
    ()=>{f.node.source_sha256='d'.repeat(64);},()=>{f.node.image_sha256='d'.repeat(64);},()=>{f.node.launch_manifest_sha256='d'.repeat(64);},
    ()=>{f.node.expected_services=[];},()=>{f.original.state='unknown';},()=>{f.original.identity.instance_id='ins-other';},
    ()=>{f.original.run_acceptance=null;},()=>{f.original.run_acceptance.launch_binding_sha256='d'.repeat(64);},
    ()=>{f.original.request.launch_manifest_sha256='d'.repeat(64);},()=>{f.original.request.source_sha256='d'.repeat(64);}];
  for(const mutate of cases){
    Object.assign(f.node,structuredClone(node));Object.assign(f.original,structuredClone(original));f.snapshot.nodes=[f.node];mutate();
    await assert.rejects(f.cloud.execute(f.warm),/RETAINED_NODE_/);assert.equal(f.writes.length,0);
  }
  Object.assign(f.node,node);Object.assign(f.original,original);f.snapshot.nodes=[f.node];
  f.cloud.control=undefined;await assert.rejects(f.cloud.inventory(),/REGISTRY_REQUIRED/);
});

test('retained cloud identity, role, network, source and launch drift fail closed before any Start or Run',async t=>{
  const f=await retainedFixture(t),instance=structuredClone(f.instance),pool=structuredClone(f.config),request=structuredClone(f.warm.request);
  const cases=[()=>{f.instance.ImageId='img-unknown';},()=>{f.instance.ImageId=f.config.image_id;},
    ()=>{f.instance.CamRoleName=f.config.role_names[1];},()=>{f.instance.VirtualPrivateCloud.VpcId='vpc-other';},
    ()=>{f.instance.SecurityGroupIds=['sg-other'];},()=>{f.instance.SystemDisk.DiskSize=80;},()=>{f.instance.PublicIpAddresses=['192.0.2.1'];},
    ()=>{f.instance.Tags.find(t=>t.Key==='bondbuddy-create-op').Value='other';},
    ()=>{f.config.vpc_id='vpc-other';},()=>{f.config.node_secrets[0].role_id='99';},()=>{f.config.node_secrets[0].secret_name='other';},
    ()=>{f.warm.request.source_sha256='d'.repeat(64);},()=>{f.warm.request.image_sha256='d'.repeat(64);},
    ()=>{f.warm.request.launch_manifest_sha256='d'.repeat(64);},()=>{f.warm.request.services=[];}];
  for(const mutate of cases){Object.assign(f.instance,structuredClone(instance));Object.assign(f.config,structuredClone(pool));f.warm.request=structuredClone(request);mutate();
    await assert.rejects(f.cloud.execute(f.warm));assert.equal(f.writes.length,0);}
  Object.assign(f.instance,instance);Object.assign(f.config,pool);
  f.instance.InstanceId='ins-other';const read=f.transport.call;
  f.transport.call=async(service,action,payload,options)=>action==='DescribeInstances'?{InstanceSet:[f.instance],TotalCount:1,RequestId:'synthetic-other'}:read(service,action,payload,options);
  await assert.rejects(f.cloud.describe('ins-other'),/CLOUD_LAUNCH_DRIFT/);
});

test('retained pin configuration rejects wildcards, duplicates and incomplete or unknown fields',async t=>{
  const f=await retainedFixture(t),pin=structuredClone(f.pin);
  for(const pins of [null,{},[pin,pin],[pin,pin,pin],[{...pin,instance_id:'*'}],[{...pin,image_id:'*'}],
    [{...pin,role_name:'unknown'}],[{...pin,source_sha256:null}],[{...pin,launch_binding_sha256:undefined}],[{...pin,extra:true}],
    [{...pin,create_operation_id:undefined}]])assert.throws(()=>validateConfig({...f.config,retained_nodes:pins}),/RETAINED_NODE_PINS/);
  assert.equal(retainedNodePin(f.config,'ins-other'),undefined);
});

test('existing controller entry creates warm requests from retained PG pins and rejects request drift before reservation',async t=>{
  const f=await retainedFixture(t);let reserved,writes=0;
  f.control.listPendingOperations=async()=>[];
  f.control.reserveStart=async request=>{reserved=request;return {...f.warm,request};};
  f.control.claimCloudDispatch=async()=>({...f.warm,state:'unknown'});
  f.control.recordCloudResult=async(_id,_revision,result)=>result;
  const quote={version:'execution-cloud-price-bounds-v1',currency:'CNY',account_id:f.config.account_id,region:f.config.region,policy_revision:1,
    valid_from:'2026-01-01T00:00:00Z',valid_until:'2030-01-01T00:00:00Z',fixed_commitments:['secret','snapshot'].map(kind=>({kind,upper_bound_cny:0,
      evidence_ref:'synthetic/fixed',evidence_sha256:h,enforced_bound_sha256:h})),components:['compute','disk','ip','egress','network','secret'].map(kind=>({kind,
      running_cny_per_node_hour:kind==='compute'?.8:.08,stopped_cny_per_node_hour:kind==='compute'?0:.08,evidence_ref:'synthetic/quote',evidence_sha256:h,enforced_bound_sha256:h}))};
  f.config.quote_sha256=sha256(canonical(quote));
  const costSnapshot=async inventory=>produceExpenseSnapshot({config:f.config,quote,inventory,ledger:{captured_at:new Date().toISOString(),
    operations:[f.original],nodes:[{...f.node,identity:f.original.identity,cloud_start_operation_id:f.original.operation_id,
      created_at:f.original.dispatched_at,destroyed_at:null}]}});
  const handler=createExecutionPoolOpsHandler({control:f.control,configPath:'synthetic',dependencies:{readConfig:async()=>f.config,
    costSnapshot,cloud:{inventory:()=>f.cloud.inventory(),execute:async()=>{writes++;return {RequestId:'synthetic-start'};}}}});
  await handler.tick();assert.ok(reserved);assert.equal(reserved.launch_manifest_sha256,f.pin.launch_manifest_sha256);
  assert.equal(reserved.source_sha256,f.pin.source_sha256);assert.equal(reserved.image_sha256,f.pin.image_sha256);assert.equal(writes,1);
  const bad={...reserved,launch_manifest_sha256:'d'.repeat(64)};reserved=undefined;
  await assert.rejects(f.controller.start(bad,'synthetic-drift'),/RETAINED_NODE_REQUEST_DRIFT/);assert.equal(reserved,undefined);
});

test('restricted signing registration read avoids forbidden policy snapshots and preserves all retained Run guards',async t=>{
  const f=await retainedFixture(t);let snapshots=0,queries=0;
  const denied=()=>Object.assign(new Error('permission denied for table bb_execution_capacity_policy'),{code:'42501'});
  f.control.snapshot=async()=>{snapshots++;throw denied();};
  const registration={account_id:f.config.account_id,region:f.config.region,instance_id:f.pin.instance_id,state:'ready',destroyed_at:null,
    source_sha256:f.pin.source_sha256,image_sha256:f.pin.image_sha256,launch_manifest_sha256:f.pin.launch_manifest_sha256,expected_services:services};
  let rows=[registration];
  const issuerPool={query:async(sql,parameters)=>{
    queries++;
    if(sql.includes('bb_execution_capacity_policy'))throw denied();
    assert.equal(sql.replace(/\s+/g,' ').trim(),
      'SELECT account_id,region,instance_id,state,destroyed_at,source_sha256,image_sha256,launch_manifest_sha256,expected_services FROM bb_execution_nodes WHERE account_id=$1 AND region=$2 AND instance_id=$3');
    assert.deepEqual(parameters,[f.config.account_id,f.config.region,f.pin.instance_id]);return {rows};
  }};
  // This is the prior failing wiring. No extra privileges are granted to make
  // the full snapshot work; only the authority's exact read is substituted.
  await assert.rejects(f.cloud.verifyRetainedNode(f.pin.instance_id),{code:'42501'});assert.equal(snapshots,1);snapshots=0;
  f.cloud.readRegisteredNodes=identity=>readAuthorityRegisteredNodes(issuerPool,identity);
  const warm={...f.warm,state:'completed',provider_request_id:'synthetic-warm-ack'};
  Object.assign(f.node,{identity:warm.identity,state:'ready',cloud_start_operation_id:warm.operation_id});
  f.control.loadOperation=async id=>id===f.pin.create_operation_id?f.original:id===warm.operation_id?warm:null;
  Object.assign(f.instance,{InstanceState:'RUNNING',LatestOperation:'StartInstances',LatestOperationState:'SUCCESS',LatestOperationRequestId:warm.provider_request_id});
  await exec('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-days','2','-subj','/CN=synthetic-restricted-ca',
    '-keyout',join(f.directory,'ca.key'),'-out',join(f.directory,'ca.pem')]);await chmod(join(f.directory,'ca.pem'),0o600);
  const issuer={ca_file:join(f.directory,'ca.pem'),signing_key_file:join(f.directory,'ca.key'),ca_sha256:sha256(await readFile(join(f.directory,'ca.pem')))};
  const authority=createControlAuthority({config:{account_id:f.config.account_id,region:f.config.region,pool:f.config,issuer},control:f.control,
    expenseLedger:async()=>({nodes:[f.node]}),cloud:f.cloud,verifyDatabase:async()=>{}});
  const request={version:'execution-pg-issuer-v1',action:'issue',operation_id:warm.operation_id,identity:warm.identity};
  const result=await authority.handle(request);assert.equal(result.operation_id,warm.operation_id);assert.equal(queries,2);assert.equal(snapshots,0);
  const original=structuredClone(f.original),initial=structuredClone(registration);
  const faults=[()=>{rows=[];},()=>{rows=[registration,registration];},()=>{registration.account_id='654321';},
    ()=>{registration.region='other';},()=>{registration.instance_id='ins-other';},()=>{registration.state='destroyed';},
    ()=>{registration.destroyed_at=new Date();},()=>{registration.source_sha256='d'.repeat(64);},()=>{registration.image_sha256='d'.repeat(64);},
    ()=>{registration.launch_manifest_sha256='d'.repeat(64);},()=>{registration.expected_services=[];},()=>{f.original.state='unknown';},
    ()=>{f.original.run_acceptance=null;},()=>{f.original.run_acceptance.launch_binding_sha256='d'.repeat(64);},
    ()=>{f.original.request.source_sha256='d'.repeat(64);},()=>{f.original.client_token='d'.repeat(64);}];
  for(const fault of faults){Object.assign(registration,structuredClone(initial));Object.assign(f.original,structuredClone(original));rows=[registration];fault();
    await assert.rejects(authority.handle(request),/RETAINED_NODE_/);assert.equal(snapshots,0);}
  Object.assign(registration,initial);Object.assign(f.original,original);rows=[registration];
  issuerPool.query=async()=>{throw Object.assign(new Error('synthetic unavailable registration read'),{code:'42501'});};
  await assert.rejects(authority.handle(request),{code:'42501'});assert.equal(snapshots,0);assert.equal(f.writes.length,0);
});

test('actual TC3 Run singleton is durably accepted then completes with three null latest fields and enrolls each slot',async t=>{
  for(const slot of [0,1]){
    const f=await runFixture(t,slot);await f.controller.dispatch(f.operation,{slot});assert.equal(f.operation.state,'submitted');
    const a=f.operation.run_acceptance;assert.deepEqual(a.instance_ids,[f.instance.InstanceId]);assert.equal(a.provider_request_id,'synthetic-accepted');
    const recorded=JSON.parse(await readFile(a.evidence_ref,'utf8'));assert.deepEqual(recorded.instance_ids,[f.instance.InstanceId]);assert.equal(recorded.provider_request_id,a.provider_request_id);
    await f.controller.recover(f.operation.operation_id);assert.equal(f.operation.state,'completed');
    const observation=f.operation.cloud_observation;assert.equal(Value.Check(ExecutionCloudObservationSchema,observation),true);
    assert.equal(observation.latest_operation,null);assert.equal(observation.latest_operation_state,null);assert.equal(observation.latest_operation_request_id,null);
    await issueNodeEnrollment({operation:f.operation,slot,config:{...config,registration_directory:join(f.directory,'vault')},transport:f.transport,bind:async()=>{},serviceTemplate:{}});
    const broker=createSsmEnrollmentBroker({config:{...config,...config.node_secrets[slot]},transport:f.transport,attempts:1});
    const e=await broker.enroll({instance_id:f.instance.InstanceId});assert.equal(e.verified,true);assert.equal(e.operation_action,'run');
    // The refresh service consumes the same readback guard after boot.
    assert.equal(nodeCloudCompletionMatches(e,f.instance),true);
  }
});

test('no accepted ACK or wrong singleton, token, epoch, operation and manifest cannot complete Run',async t=>{
  const f=await runFixture(t);await f.controller.dispatch(f.operation,{slot:0});const op=structuredClone(f.operation),observed=await f.cloud.describeRun(op);
  for(const mutate of [o=>{o.provider_request_id=null;},o=>{o.run_acceptance=null;},o=>{o.run_acceptance.instance_ids=['ins-other'];},o=>{o.run_acceptance.instance_ids.push('ins-other');},
    o=>{o.run_acceptance.client_token='wrong';},o=>{o.run_acceptance.identity.epoch=randomUUID();},o=>{o.run_acceptance.operation_id='other';},o=>{o.run_acceptance.launch_manifest_sha256='b'.repeat(64);},
    o=>{o.run_acceptance.launch_binding_sha256='b'.repeat(64);},o=>{o.run_acceptance.provider_request_id='other';}]){
    const bad=structuredClone(op);mutate(bad);assert.equal(executionCloudCompletionMatches(bad,observed),false);
  }
  f.operation={...op,state:'unknown',provider_request_id:null,run_acceptance:null};const reads=f.calls.length;
  await f.controller.recover(op.operation_id);assert.equal(f.calls.length,reads);assert.equal(f.operation.state,'unknown');
});

test('actual creation readback rejects wrong tag, immutable role/image/network, status identity and pending state',async t=>{
  const f=await runFixture(t);await f.controller.dispatch(f.operation,{slot:0});
  for(const [key,value] of [['ImageId','img-other'],['CamRoleName',config.role_names[1]],['SecurityGroupIds',['sg-other']],['Tags',[{Key:'bondbuddy-pool',Value:config.pool_tag},{Key:'bondbuddy-create-op',Value:'other'}]]]){
    const prior=f.instance[key];f.instance[key]=value;await assert.rejects(f.cloud.describeRun(f.operation));f.instance[key]=prior;
  }
  f.mutation=(action,result)=>action==='DescribeInstancesStatus'?{InstanceStatusSet:[{InstanceId:'ins-other',InstanceState:'RUNNING'}]}:result;
  await assert.rejects(f.cloud.describeRun(f.operation),/RUN_STATUS_SCOPE/);f.mutation=null;
  f.instance.InstanceState='PENDING';await f.controller.recover(f.operation.operation_id);assert.equal(f.operation.state,'submitted');
  f.instance.InstanceState='RUNNING';await f.controller.recover(f.operation.operation_id);assert.equal(f.operation.state,'completed');
});

test('Start and Stop still require the exact nonempty latest ACK, action, success and charging proof',async()=>{
  const identity={account_id:config.account_id,region:config.region,instance_id:'ins-synthetic',epoch:randomUUID()};
  for(const action of ['start','stop']){
    const op={action,identity,provider_request_id:'exact'},observation={instance_state:action==='stop'?'STOPPED':'RUNNING',latest_operation:action==='stop'?'StopInstances':'StartInstances',
      latest_operation_state:'SUCCESS',latest_operation_request_id:'exact',stop_charging_mode:action==='stop'?'STOP_CHARGING':null,observed_at:new Date().toISOString(),evidence_ref:'synthetic/ack',evidence_sha256:h};
    assert.equal(executionCloudCompletionMatches(op,observation),true);
    for(const bad of [{...op,provider_request_id:null}])assert.equal(executionCloudCompletionMatches(bad,observation),false);
    for(const [key,value] of [['latest_operation_request_id',null],['latest_operation_request_id','foreign'],['latest_operation',null],['latest_operation','RunInstances'],['latest_operation_state',null],['latest_operation_state','PENDING']])
      assert.equal(executionCloudCompletionMatches(op,{...observation,[key]:value}),false);
    if(action==='stop')assert.equal(executionCloudCompletionMatches(op,{...observation,stop_charging_mode:'KEEP_CHARGING'}),false);
  }
});

test('root authority uses accepted creation proof with null latest fields and refuses a post-sign stop',async t=>{
  const f=await runFixture(t);await f.controller.dispatch(f.operation,{slot:0});await f.controller.recover(f.operation.operation_id);
  await exec('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-days','2','-subj','/CN=synthetic-run-ca','-keyout',join(f.directory,'ca.key'),'-out',join(f.directory,'ca.pem')]);
  await chmod(join(f.directory,'ca.pem'),0o600);
  const issuer={ca_file:join(f.directory,'ca.pem'),signing_key_file:join(f.directory,'ca.key'),ca_sha256:sha256(await readFile(join(f.directory,'ca.pem')))};
  const node={identity:f.operation.identity,state:'starting',cloud_start_operation_id:f.operation.operation_id,launch_manifest_sha256:f.operation.request.launch_manifest_sha256};
  const authority=createControlAuthority({config:{account_id:config.account_id,region:config.region,pool:config,issuer},control:f.control,expenseLedger:async()=>({nodes:[node]}),cloud:f.cloud,verifyDatabase:async()=>{}});
  const request={version:'execution-pg-issuer-v1',action:'issue',operation_id:f.operation.operation_id,identity:f.operation.identity};
  const result=await authority.handle(request);assert.match(new X509Certificate(result.transport_credentials.cert_pem).subjectAltName,/urn:bondbuddy:execution/);
  f.instance.InstanceState='STOPPED';await assert.rejects(authority.handle(request),/AUTHORITY_CLOUD_COMPLETION/);f.instance.InstanceState='RUNNING';
  // The same issuer can authorize a registered warm generation whose original
  // Run pins are retained while the default image/source have changed.
  const original=structuredClone(f.operation),pin={instance_id:f.instance.InstanceId,image_id:f.instance.ImageId,source_sha256:h,image_sha256:h,
    role_name:f.instance.CamRoleName,create_operation_id:original.operation_id,launch_manifest_sha256:original.request.launch_manifest_sha256,
    launch_binding_sha256:original.run_acceptance.launch_binding_sha256};
  Object.assign(f.config,{retained_nodes:[pin],image_id:'img-new',source_sha256:'b'.repeat(64),image_sha256:'c'.repeat(64)});
  f.operation={...original,action:'start',operation_id:'synthetic-warm-issuer',identity:{...original.identity,epoch:randomUUID()},provider_request_id:'synthetic-warm-ack'};
  f.operation.request={...original.request,instance_id:f.instance.InstanceId,epoch:f.operation.identity.epoch};
  Object.assign(node,{identity:f.operation.identity,cloud_start_operation_id:f.operation.operation_id,source_sha256:h,image_sha256:h,expected_services:services});
  f.instance.LatestOperation='StartInstances';f.instance.LatestOperationState='SUCCESS';f.instance.LatestOperationRequestId=f.operation.provider_request_id;
  f.control.snapshot=async()=>({nodes:[node]});f.control.loadOperation=async id=>id===original.operation_id?original:f.operation;f.cloud.control=f.control;
  const retainedAuthority=createControlAuthority({config:{account_id:f.config.account_id,region:f.config.region,pool:f.config,issuer},control:f.control,
    expenseLedger:async()=>({nodes:[node]}),cloud:f.cloud,verifyDatabase:async()=>{}});
  const warmRequest={...request,operation_id:f.operation.operation_id,identity:f.operation.identity};
  const warmResult=await retainedAuthority.handle(warmRequest);assert.equal(warmResult.operation_id,f.operation.operation_id);
  node.source_sha256='d'.repeat(64);await assert.rejects(retainedAuthority.handle(warmRequest),/RETAINED_NODE_REGISTRY_DRIFT/);node.source_sha256=h;
  f.instance.InstanceState='STOPPED';await assert.rejects(retainedAuthority.handle(warmRequest),/AUTHORITY_CLOUD_COMPLETION/);
});
