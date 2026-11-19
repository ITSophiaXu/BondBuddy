import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {issueNodeEnrollment,createSsmEnrollmentBroker} from './enrollment.mjs';
import {canonical,sha256} from './policy.mjs';
const h='a'.repeat(64),identity={account_id:'123456',region:'ap-beijing',instance_id:'ins-a1',epoch:'e3432123-84b5-4f11-8b51-94a29eac1234'};
const services=[{service_id:'authoring',capabilities:['authoring']},{service_id:'review',capabilities:['review','assistant']}];
const operation={operation_id:'op1',action:'start',state:'completed',provider_request_id:'ack1',identity,cloud_observation:{instance_state:'RUNNING',latest_operation:'StartInstances',latest_operation_state:'SUCCESS',latest_operation_request_id:'ack1',stop_charging_mode:null,observed_at:new Date().toISOString(),evidence_ref:'synthetic/describe',evidence_sha256:h},request:{services,source_sha256:h,image_sha256:h,launch_manifest_sha256:h}};

test('exact SSM version resolves lost Put ACK with the same PG token; repeat never rewrites version',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bb-enrollment-'));let stored,puts=0,tags=0;const tokens=[];
 const config={account_id:identity.account_id,region:identity.region,registration_directory:dir,role_names:['role-a','role-b'],node_secrets:[{role_name:'role-a',role_id:'7',secret_name:'node-a'}]};
 const transport={call:async(_,action,p)=>{if(action==='ListSecretVersionIds')return {SecretName:p.SecretName,Versions:[]};if(action==='GetSecretValue'){if(!stored){const e=Error();e.code='ResourceNotFound';throw e;}return {SecretName:p.SecretName,VersionId:p.VersionId,SecretString:stored};}
 if(action==='PutSecretValue'){puts++;stored=p.SecretString;throw Error('lost ACK');}if(action==='ModifyResourceTags'){tags++;return {RequestId:'tag'};}}};
 const options={operation,slot:0,config,transport,serviceTemplate:{service_environments:{authoring:{DATABASE_URL:'synthetic'},review:{DATABASE_URL:'synthetic-review'}}},bind:async(_,__,token)=>tokens.push(sha256(token))};
 try{await issueNodeEnrollment(options);await issueNodeEnrollment(options);assert.equal(puts,1);assert.equal(tags,0);assert.equal(tokens[0],tokens[1]);
  const original=stored;stored=canonical({...JSON.parse(stored),registration_token:'different'});await assert.rejects(issueNodeEnrollment(options),/SECRET_VERSION_CONFLICT/);assert.equal(puts,1);stored=original;
  await assert.rejects(issueNodeEnrollment({...options,slot:1}),/ISSUER_SCOPE/);
 }finally{await rm(dir,{recursive:true});}
});

test('warm boot waits for exact current Start ACK version; stale public tag cannot register old epoch',async()=>{
 const config={pool_tag:'synthetic',account_id:identity.account_id,region:identity.region,role_name:'role-a',role_id:'7',secret_name:'node-a',services,source_sha256:h,image_sha256:h};
 const envelope={identity,role_id:'7',services,source_sha256:h,image_sha256:h,expires_at:Date.now()+300000,operation_completed:true,operation_action:'start',launch_manifest_sha256:h,operation_id:'op1',provider_request_id:'ack1'};
 let reads=0,waits=0;
 const transport={call:async(_,action,p)=>{if(action==='GetCallerIdentity')return {AccountId:identity.account_id,UserId:'7:synthetic'};
 if(action==='DescribeInstances'){if(p.InstanceIds)reads++;return {TotalCount:1,InstanceSet:[{InstanceId:identity.instance_id,InstanceState:'RUNNING',CamRoleName:'role-a',LatestOperation:'StartInstances',LatestOperationState:'SUCCESS',LatestOperationRequestId:reads===1?'new-ack':'ack1',Tags:[{Key:'bondbuddy-enrollment-version',Value:'op1'},{Key:'bondbuddy-pool',Value:'synthetic'},{Key:'bondbuddy-execution-slot',Value:'role-a'}]}]};}
 if(action==='ListSecretVersionIds')return {SecretName:p.SecretName,Versions:[{VersionId:'op1'}]};
 if(action==='GetSecretValue')return {SecretName:p.SecretName,VersionId:p.VersionId,SecretString:canonical(envelope)};}};
 const broker=createSsmEnrollmentBroker({config,transport,wait:async()=>{waits++;},attempts:2});
 assert.equal((await broker.enroll(identity)).verified,true);assert.equal(waits,1);assert.equal(reads,3);
 const foreign=createSsmEnrollmentBroker({config:{...config,role_id:'8'},transport,wait:async()=>{},attempts:1});await assert.rejects(foreign.enroll(identity),/NODE_ROLE_MISMATCH/);
});
test('first boot tolerates bounded exact-policy propagation; identity and unknown failures still stop before enrollment',async()=>{
 const config={pool_tag:'synthetic',account_id:identity.account_id,region:identity.region,role_name:'role-a',role_id:'7',secret_name:'node-a',services,source_sha256:h,image_sha256:h};
 const envelope={identity,role_id:'7',services,source_sha256:h,image_sha256:h,expires_at:Date.now()+300000,operation_completed:true,operation_action:'start',launch_manifest_sha256:h,operation_id:'op1',provider_request_id:'ack1'};
 let descriptions=0,waits=0;
 const transport={call:async(_,action,p)=>{
   if(action==='GetCallerIdentity')return {AccountId:identity.account_id,UserId:'7:synthetic'};
   if(action==='DescribeInstances'){if(++descriptions===1){const e=Error('CLOUD_API_ERROR');e.code='UnauthorizedOperation';e.requestId='synthetic-denial';throw e;}
     return {TotalCount:1,InstanceSet:[{InstanceId:identity.instance_id,InstanceState:'RUNNING',CamRoleName:'role-a',LatestOperation:'StartInstances',LatestOperationState:'SUCCESS',LatestOperationRequestId:'ack1',Tags:[{Key:'bondbuddy-enrollment-version',Value:'op1'},{Key:'bondbuddy-pool',Value:'synthetic'},{Key:'bondbuddy-execution-slot',Value:'role-a'}]}]};}
   if(action==='ListSecretVersionIds')return {SecretName:p.SecretName,Versions:[{VersionId:'op1'}]};
   if(action==='GetSecretValue')return {SecretName:p.SecretName,VersionId:p.VersionId,SecretString:canonical(envelope)};
   throw Error('unexpected mutation');
 }};
 assert.equal((await createSsmEnrollmentBroker({config,transport,attempts:2,wait:async()=>{waits++;}}).enroll(identity)).verified,true);assert.equal(waits,1);
 waits=0;await assert.rejects(createSsmEnrollmentBroker({config,attempts:2,wait:async()=>{waits++;},transport:{call:async()=>{throw Error('CLOUD_HTTP_UNCERTAIN');}}}).enroll(identity),/CLOUD_HTTP_UNCERTAIN/);assert.equal(waits,0);
});
test('unknown initial secret publish cannot be reissued by a later tick',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bb-enrollment-unknown-'));let puts=0;
 const config={account_id:identity.account_id,region:identity.region,registration_directory:dir,role_names:['role-a','role-b'],node_secrets:[{role_name:'role-a',role_id:'7',secret_name:'node-a'}]};
 const options={config,operation,slot:0,serviceTemplate:{},bind:async()=>{},transport:{call:async(_,action)=>{
   if(action==='ListSecretVersionIds')return {SecretName:'node-a',Versions:[]};if(action==='PutSecretValue'){puts++;throw Error('lost unobserved ACK');}const error=Error();error.code='ResourceNotFound';throw error;
 }}};
 try{await assert.rejects(issueNodeEnrollment(options));await assert.rejects(issueNodeEnrollment(options));assert.equal(puts,1);}finally{await rm(dir,{recursive:true});}
});


test('expired confirmed enrollment renews immutable version, same PG token and epoch, bounded to three recoveries',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bb-enrollment-expiry-'));let at=Date.now(),puts=0;const stored=new Map(),tokens=[];
 const config={account_id:identity.account_id,region:identity.region,registration_directory:dir,role_names:['role-a','role-b'],node_secrets:[{role_name:'role-a',role_id:'7',secret_name:'node-a'}]};
 const transport={call:async(_,action,p)=>{
   if(action==='ListSecretVersionIds')return {SecretName:p.SecretName,Versions:[...stored.keys()].map(VersionId=>({VersionId}))};
   if(action==='PutSecretValue'){assert(!stored.has(p.VersionId));stored.set(p.VersionId,p.SecretString);puts++;throw Error('lost ACK after accepted');}
   if(action==='GetSecretValue'){if(!stored.has(p.VersionId)){const e=Error();e.code='ResourceNotFound';throw e;}return {SecretName:p.SecretName,VersionId:p.VersionId,SecretString:stored.get(p.VersionId)};}
   throw Error('unexpected mutation '+action);
 }};
 const options={operation,slot:0,config,transport,serviceTemplate:{},bind:async(i,op,token)=>{assert.deepEqual(i,identity);assert.equal(op,operation.operation_id);tokens.push(token);},now:()=>at};
 try{
   for(let gen=0;gen<=3;gen++){
     const result=await issueNodeEnrollment(options);assert.equal(result.recovery_generation,gen);
     assert.equal((await issueNodeEnrollment(options)).recovery_generation,gen);assert.equal(puts,gen+1);
     at+=600001;
   }
   await assert.rejects(issueNodeEnrollment(options),/ENROLLMENT_RECOVERY_EXHAUSTED/);
   assert.equal(puts,4);assert.equal(new Set(tokens).size,1);assert.equal(stored.size,4);
 }finally{await rm(dir,{recursive:true});}
});

test('expired unconfirmed publication cannot be bypassed with a new version',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bb-enrollment-unknown-expired-'));let at=Date.now(),puts=0;
 const config={account_id:identity.account_id,region:identity.region,registration_directory:dir,role_names:['role-a','role-b'],node_secrets:[{role_name:'role-a',role_id:'7',secret_name:'node-a'}]};
 const options={operation,slot:0,config,now:()=>at,serviceTemplate:{},bind:async()=>{},transport:{call:async(_,action)=>{
   if(action==='ListSecretVersionIds')return {SecretName:'node-a',Versions:[]};if(action==='PutSecretValue'){puts++;throw Error('uncertain');}
   const e=Error();e.code='ResourceNotFound';throw e;
 }}};
 try{await assert.rejects(issueNodeEnrollment(options));at+=600001;await assert.rejects(issueNodeEnrollment(options));assert.equal(puts,1);}
 finally{await rm(dir,{recursive:true});}
});

test('node accepts current generation only with exact completed Start, scope and derived immutable version',async()=>{
 const {enrollmentVersionId}=await import('./enrollment-version.mjs');const at=Date.now();
 const config={pool_tag:'synthetic',account_id:identity.account_id,region:identity.region,role_name:'role-a',role_id:'7',secret_name:'node-a',services,source_sha256:h,image_sha256:h};
 const envelope={identity,role_id:'7',services,source_sha256:h,image_sha256:h,expires_at:at+600000,operation_completed:true,operation_action:'start',launch_manifest_sha256:h,operation_id:'op1',provider_request_id:'ack1',enrollment_generation:1};
 let version=enrollmentVersionId('op1',1),ack='ack1';
 const transport={call:async(_,action,p)=>{
   if(action==='GetCallerIdentity')return {AccountId:identity.account_id,UserId:'7:synthetic'};
   if(action==='DescribeInstances')return {TotalCount:1,InstanceSet:[{InstanceId:identity.instance_id,InstanceState:'RUNNING',CamRoleName:'role-a',LatestOperation:'StartInstances',LatestOperationState:'SUCCESS',LatestOperationRequestId:ack,Tags:[{Key:'bondbuddy-pool',Value:'synthetic'},{Key:'bondbuddy-execution-slot',Value:'role-a'}]}]};
   if(action==='ListSecretVersionIds')return {SecretName:p.SecretName,Versions:[{VersionId:'op1'},{VersionId:version}]};
   if(action==='GetSecretValue')return {SecretName:p.SecretName,VersionId:p.VersionId,SecretString:canonical(p.VersionId==='op1'?{...envelope,enrollment_generation:0,expires_at:at-1}:envelope)};
 }};
 const enroll=()=>createSsmEnrollmentBroker({config,transport,now:()=>at,attempts:1}).enroll(identity);
 assert.equal((await enroll()).enrollment_generation,1);
 version='foreign';await assert.rejects(enroll(),/NODE_SECRET_BINDING/);
 version=enrollmentVersionId('op1',1);ack='old-ack';await assert.rejects(enroll(),/NODE_ENROLLMENT_PENDING/);
});
