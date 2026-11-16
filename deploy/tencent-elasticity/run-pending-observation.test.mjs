import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {TencentCvm,runParameters} from './tencent-cvm.mjs';
import {ExecutionPoolController} from './controller.mjs';
import {bootstrapUserData} from './bootstrap.mjs';
import {canonical,sha256} from './policy.mjs';
import {executionCloudCompletionMatches} from '@bondbuddy/contracts';

test('accepted pending Run retains its reservation; running launch drift and untrusted status still fail closed',async()=>{
  const h='a'.repeat(64),services=[{service_id:'authoring',capabilities:['authoring']}];
  const config={version:'tencent-execution-pool-v1',enabled:true,phase:'single_node_validation',
    account_id:'123456',region:'ap-beijing',zone:'ap-beijing-7',pool_tag:'synthetic-pool',instance_type:'SA9.LARGE16',
    min_running:1,max_owned:2,global_model_limit:4,node_model_limit:4,compute_cny_per_hour:.8,compute_cap_cny_per_hour:1.6,
    noncompute_cap_cny_per_hour:.8,total_cap_cny_per_hour:2.4,scale_up_wait_seconds:60,idle_seconds:300,failure_cooldown_seconds:300,
    image_id:'img-synthetic',vpc_id:'vpc-synthetic',subnet_id:'subnet-synthetic',security_group_id:'sg-synthetic',
    source_sha256:h,image_sha256:h,network_review_sha256:h,quote_sha256:h,role_names:['synthetic-one','synthetic-two'],
    private_pg_verified:true,service_credentials_verified:true,services,
    node_secrets:[{role_name:'synthetic-one',role_id:'7',secret_name:'synthetic-one'},{role_name:'synthetic-two',role_id:'8',secret_name:'synthetic-two'}]};
  const now=Date.now(),operation_id='synthetic-'+randomUUID(),epoch=randomUUID(),client_token=sha256(operation_id);
  const request={account_id:config.account_id,region:config.region,instance_id:null,instance_count:1,epoch,
    source_sha256:h,image_sha256:h,launch_manifest_sha256:h,capabilities:['authoring'],services};
  const userData=bootstrapUserData(config,request,0);
  request.launch_manifest_sha256=sha256(canonical(runParameters(config,request,client_token,userData,0,operation_id)));
  const params=runParameters(config,request,client_token,userData,0,operation_id);
  const instance={...params,InstanceId:'ins-synthetic',InstanceState:'RUNNING',CreatedTime:new Date(now).toISOString(),
    Tags:params.TagSpecification[0].Tags,PublicIpAddresses:[],LatestOperation:null,LatestOperationState:null,LatestOperationRequestId:null};
  let op={operation_id,action:'run',state:'intent',revision:0,identity:null,provider_request_id:null,client_token,request};
  let status='PENDING',statusId=instance.InstanceId,account=config.account_id,completedWrites=0;
  const calls=[],archive=[];
  const transport={call:async(service,action,payload)=>{
    calls.push(action);
    if(action==='GetCallerIdentity')return {AccountId:account,RequestId:'synthetic-sts'};
    if(action==='RunInstances')return {InstanceIdSet:[instance.InstanceId],RequestId:'synthetic-run-ack'};
    if(action==='DescribeInstancesStatus')return {RequestId:'synthetic-status',InstanceStatusSet:[{InstanceId:statusId,InstanceState:status}]};
    if(action==='DescribeInstances'){
      if(payload.Filters)return {RequestId:'synthetic-peers',TotalCount:1,InstanceSet:[instance]};
      return {RequestId:'synthetic-detail',InstanceSet:[instance]};
    }
    throw Error('unexpected synthetic call');
  }};
  const cloud=new TencentCvm({transport,config,now:()=>now,archive:async bytes=>{
    archive.push(JSON.parse(bytes));return {ref:'synthetic-evidence-'+archive.length,sha256:sha256(bytes)};
  }});
  const control={loadOperation:async()=>op,claimCloudDispatch:async()=>op={...op,state:'unknown',revision:1,dispatched_at:new Date(now).toISOString()},
    recordCloudResult:async(id,revision,result)=>{
      assert.equal(id,op.operation_id);assert.equal(revision,op.revision);
      if(result.state==='completed')completedWrites++;
      op={...op,...result,revision:revision+1};return op;
    }};
  const controller=new ExecutionPoolController({cloud,config,control});
  await controller.dispatch(op,{slot:0});assert.equal(op.state,'submitted');
  const accepted=structuredClone(op),pending=await cloud.describeRun(op);
  assert.equal(pending.instance_state,'PENDING');assert.equal(executionCloudCompletionMatches(op,pending),false);
  assert.equal(archive.at(-1).provider_request_id,op.provider_request_id);
  assert.equal(archive.at(-1).identity.instance_id,instance.InstanceId);
  const callStart=calls.length;
  assert.equal(await controller.recover(op.operation_id),op);
  assert.deepEqual(op,accepted);assert.equal(completedWrites,0);
  assert.equal(calls.slice(callStart).includes('DescribeInstances'),false);
  const untrusted={...op,provider_request_id:'different-ack'};
  await assert.rejects(cloud.describeRun(untrusted),/RUN_ACCEPTANCE_UNPROVEN/);
  for(const field of ['account_id','region']){
    const foreign=structuredClone(op);
    foreign.identity[field]=field==='region'?'ap-shanghai':'654321';
    foreign.run_acceptance.identity[field]=foreign.identity[field];
    await assert.rejects(cloud.describeRun(foreign),/OPERATION_SCOPE/);
  }
  statusId='ins-foreign';await assert.rejects(cloud.describeRun(op),/RUN_STATUS_SCOPE/);statusId=instance.InstanceId;
  account='654321';await assert.rejects(cloud.describeRun(op),/CLOUD_ACCOUNT_MISMATCH/);account=config.account_id;
  status='RUNNING';
  for(const [key,value,code] of [
    ['ImageId','img-unknown','CLOUD_LAUNCH_DRIFT'],
    ['SecurityGroupIds',['sg-unknown'],'CLOUD_LAUNCH_DRIFT'],
    ['PublicIpAddresses',['192.0.2.1'],'CLOUD_LAUNCH_DRIFT'],
    ['InstanceChargeType','PREPAID','CLOUD_OWNERSHIP_DRIFT'],
    ['CamRoleName','foreign-role','CLOUD_OWNERSHIP_DRIFT'],
    ['Tags',[],'CLOUD_OWNERSHIP_DRIFT']]){
    const original=instance[key];instance[key]=value;
    await assert.rejects(controller.recover(op.operation_id),new RegExp(code));
    assert.equal(op.state,'submitted');assert.equal(completedWrites,0);instance[key]=original;
  }
  await controller.recover(op.operation_id);assert.equal(op.state,'completed');assert.equal(completedWrites,1);
  assert.equal(calls.filter(c=>c==='RunInstances').length,1);
});
