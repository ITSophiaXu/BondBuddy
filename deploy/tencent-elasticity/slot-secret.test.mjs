import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {runFixture} from './run-completion.test.mjs';
import {createSsmEnrollmentBroker,issueNodeEnrollment,readNodeSecretVersions,NODE_SECRET_SCAN_CALL_BOUND,NODE_ENROLLMENT_ATTEMPT_BOUND} from './enrollment.mjs';
import {executionSlotReadTag,executionInstanceLaunchBinding} from '@bondbuddy/contracts';
import {canonical,sha256} from './policy.mjs';
import {TencentTransport} from './tencent-cvm.mjs';

async function enrolledFixture(t){
 const f=await runFixture(t);await f.controller.dispatch(f.operation,{slot:0});await f.controller.recover(f.operation.operation_id);
 await issueNodeEnrollment({operation:f.operation,slot:0,config:{...f.config,registration_directory:join(f.directory,'vault')},transport:f.transport,bind:async()=>{},serviceTemplate:{}});
 const broker=()=>createSsmEnrollmentBroker({config:{...f.config,...f.config.node_secrets[0]},transport:f.transport,attempts:1});
 return {f,broker};
}

test('Run fixes the final slot tag in the canonical launch and rejects missing or duplicate slot inventory',async t=>{
 const f=await runFixture(t),tag=executionSlotReadTag(f.config.pool_tag,f.config.role_names[0]);
 assert.deepEqual(tag,{Key:'bondbuddy-execution-slot',Value:f.config.role_names[0]});
 assert.equal(executionInstanceLaunchBinding(f.instance).read_slot_tag,tag.Value);
 await f.controller.dispatch(f.operation,{slot:0});
 const original=f.instance.Tags;f.instance.Tags=original.filter(x=>x.Key!==tag.Key);
 await assert.rejects(f.cloud.describeRun(f.operation),/CLOUD_SLOT_TAG_DRIFT/);f.instance.Tags=original;
 f.mutation=(action,result)=>action==='DescribeInstances'?{...result,TotalCount:2}:result;
 await assert.rejects(f.cloud.describeRun(f.operation),/CLOUD_SLOT_NOT_UNIQUE/);
});

test('a still-valid old Run cannot shadow the exact new Start epoch in either SSM list order',async t=>{
 const {f,broker}=await enrolledFixture(t),old=JSON.parse(f.secrets.get(f.operation.operation_id));
 assert.ok(old.expires_at>Date.now()+60000);
 const warm={...f.operation,action:'start',operation_id:'warm-'+randomUUID(),identity:{...f.operation.identity,epoch:randomUUID()},provider_request_id:'warm-ack',
   cloud_observation:{...f.operation.cloud_observation,latest_operation:'StartInstances',latest_operation_state:'SUCCESS',latest_operation_request_id:'warm-ack'}};
 f.instance.LatestOperation='StartInstances';f.instance.LatestOperationState='SUCCESS';f.instance.LatestOperationRequestId='warm-ack';
 await issueNodeEnrollment({operation:warm,slot:0,config:{...f.config,registration_directory:join(f.directory,'vault')},transport:f.transport,bind:async()=>{},serviceTemplate:{}});
 for(const reverse of [false,true]){
   f.mutation=(action,result)=>action==='ListSecretVersionIds'&&reverse?{...result,Versions:[...result.Versions].reverse()}:result;
   assert.equal((await broker().enroll({instance_id:f.instance.InstanceId})).identity.epoch,warm.identity.epoch);
 }
 const fresh=f.secrets.get(warm.operation_id);f.secrets.delete(warm.operation_id);
 await assert.rejects(broker().enroll({instance_id:f.instance.InstanceId}),/NODE_ENROLLMENT_PENDING/);
 f.secrets.set(warm.operation_id,canonical({...JSON.parse(fresh),provider_request_id:'wrong'}));
 await assert.rejects(broker().enroll({instance_id:f.instance.InstanceId}),/NODE_ENROLLMENT_PENDING/);
 assert.ok(!f.calls.includes('ModifyResourceTags'));
});

test('full exclusive-secret inventory has at most ten distinct exact versions and eleven SSM calls',async()=>{
 const config={secret_name:'own-secret'},versions=Array.from({length:10},(_,i)=>({VersionId:'version-'+i}));let gets=0,all=0;
 const read=async(service,action,p)=>{assert.equal(service,'ssm');assert.equal(p.SecretName,config.secret_name);all++;
   if(action==='ListSecretVersionIds')return {SecretName:p.SecretName,Versions:versions};
   gets++;return {SecretName:p.SecretName,VersionId:p.VersionId,SecretString:'{}'};};
 assert.equal((await readNodeSecretVersions(config,read)).length,10);assert.equal(gets,10);assert.equal(all,NODE_SECRET_SCAN_CALL_BOUND);
 assert.equal(NODE_ENROLLMENT_ATTEMPT_BOUND,6);
 for(const bad of [[...versions,{VersionId:'eleven'}],[versions[0],versions[0]],[{VersionId:null}]]){
   await assert.rejects(readNodeSecretVersions(config,async()=>({SecretName:config.secret_name,Versions:bad})),/NODE_SECRET_VERSION_INVENTORY/);
 }
 await assert.rejects(readNodeSecretVersions(config,async(_s,a,p)=>a==='ListSecretVersionIds'?{SecretName:p.SecretName,Versions:[versions[0]]}:
   {SecretName:'foreign',VersionId:p.VersionId,SecretString:'{}'}),/NODE_SECRET_VERSION_MISMATCH/);
});

test('post-scan cloud Stop or a duplicate slot prevents returning enrollment credentials',async t=>{
 const {f,broker}=await enrolledFixture(t);
 f.mutation=(action,result)=>{if(action==='GetSecretValue'){f.instance.LatestOperation='StopInstances';f.instance.LatestOperationState='PENDING';f.instance.LatestOperationRequestId='stop-ack';}return result;};
 await assert.rejects(broker().enroll({instance_id:f.instance.InstanceId}),/NODE_ENROLLMENT_PENDING/);
 f.instance.LatestOperation=null;f.instance.LatestOperationState=null;f.instance.LatestOperationRequestId=null;
 f.mutation=(action,result)=>action==='DescribeInstances'?{...result,TotalCount:2}:result;
 await assert.rejects(broker().enroll({instance_id:f.instance.InstanceId}),/NODE_SLOT_NOT_UNIQUE/);
});

test('bounded scans include the window after a publish just later than the second control tick',async t=>{
 const {f}=await enrolledFixture(t),version=f.operation.operation_id,saved=f.secrets.get(version);f.secrets.clear();
 const start=Date.now();let time=start;const waits=[];
 const broker=createSsmEnrollmentBroker({config:{...f.config,...f.config.node_secrets[0]},transport:f.transport,now:()=>time,
   wait:async ms=>{waits.push(ms);time+=ms;if(time-start===90000)f.secrets.set(version,saved);}});
 assert.equal((await broker.enroll({instance_id:f.instance.InstanceId})).operation_id,version);
 assert.deepEqual(waits,[30000,30000,30000]);
 f.secrets.clear();time=start;
 await assert.rejects(createSsmEnrollmentBroker({config:{...f.config,...f.config.node_secrets[0]},transport:f.transport,now:()=>time,
   wait:async()=>{time+=180001;}}).enroll({instance_id:f.instance.InstanceId}),/NODE_ENROLLMENT_DEADLINE/);
});

test('the default TC3 transport honors an outer scan abort before signing or issuing a request',async()=>{
 let fetches=0;
 const cloud=new TencentTransport({region:'ap-beijing',credentials:async()=>{await new Promise(resolve=>setTimeout(resolve,20));
   return {secretId:'synthetic',secretKey:'synthetic',token:'synthetic',expiresAt:Date.now()+600000};},fetchImpl:async()=>{fetches++;throw Error('unexpected network');}});
 await assert.rejects(cloud.call('ssm','ListSecretVersionIds',{SecretName:'own-secret'},{signal:AbortSignal.timeout(5)}),e=>e.name==='TimeoutError');
 assert.equal(fetches,0);
});
