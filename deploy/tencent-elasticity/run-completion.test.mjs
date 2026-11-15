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
import {createControlAuthority} from './control-authority.mjs';
import {canonical,sha256} from './policy.mjs';

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
    else if(action==='DescribeInstances'){assert.deepEqual(payload,{InstanceIds:[instance.InstanceId]});result={InstanceSet:[structuredClone(instance)]};}
    else if(action==='DescribeInstancesStatus'){assert.deepEqual(payload,{InstanceIds:[instance.InstanceId]});result={InstanceStatusSet:[{InstanceId:instance.InstanceId,InstanceState:instance.InstanceState}]};}
    else if(action==='GetSecretValue'){const value=secrets.get(payload.VersionId);result=value?{SecretName:payload.SecretName,VersionId:payload.VersionId,SecretString:value}:{Error:{Code:'ResourceNotFound'}};}
    else if(action==='PutSecretValue'){secrets.set(payload.VersionId,payload.SecretString);result={};}
    else if(action==='ModifyResourceTags'){instance.Tags.push({Key:'bondbuddy-enrollment-version',Value:operation_id});result={};}
    else throw Error('unexpected synthetic action');
    if(mutation)result=mutation(action,result);
    return new Response(JSON.stringify({Response:{RequestId:'synthetic-read-'+action,...result}}));
  }});
  const cloud=new TencentCvm({transport,config,archive:observationArchive(directory)});
  const control={claimCloudDispatch:async()=>operation={...operation,state:'unknown',revision:1,dispatched_at:new Date(now).toISOString()},loadOperation:async()=>operation,
    recordCloudResult:async(_id,revision,result)=>{assert.equal(revision,operation.revision);operation={...operation,...result,cloud_observation:result.observation,revision:revision+1};return operation;}};
  const controller=new ExecutionPoolController({config,cloud,control});
  return {config,cloud,controller,control,transport,instance,calls,directory,slot,get operation(){return operation;},set operation(value){operation=value;},set mutation(value){mutation=value;}};
}

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
  f.instance.InstanceState='STOPPED';await assert.rejects(authority.handle(request),/AUTHORITY_CLOUD_COMPLETION/);
});
