import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {issueNodeEnrollment,createSsmEnrollmentBroker} from './enrollment.mjs';
import {canonical,sha256} from './policy.mjs';
const h='a'.repeat(64),identity={account_id:'123456',region:'ap-beijing',instance_id:'ins-a1',epoch:'e3432123-84b5-4f11-8b51-94a29eac1234'};
const services=[{service_id:'authoring',capabilities:['authoring']},{service_id:'review',capabilities:['review','assistant']}];
const operation={operation_id:'op1',action:'run',state:'completed',provider_request_id:'ack1',identity,request:{services,source_sha256:h,image_sha256:h,launch_manifest_sha256:h}};

test('exact SSM version resolves lost Put ACK with the same PG token; repeat never rewrites version',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'bb-enrollment-'));let stored,puts=0,tags=0;const tokens=[];
 const config={account_id:identity.account_id,region:identity.region,registration_directory:dir,role_names:['role-a','role-b'],node_secrets:[{role_name:'role-a',role_id:'7',secret_name:'node-a'}]};
 const transport={call:async(_,action,p)=>{if(action==='GetSecretValue'){if(!stored){const e=Error();e.code='ResourceNotFound';throw e;}return {SecretName:p.SecretName,VersionId:p.VersionId,SecretString:stored};}
 if(action==='PutSecretValue'){puts++;stored=p.SecretString;throw Error('lost ACK');}if(action==='ModifyResourceTags'){tags++;return {RequestId:'tag'};}}};
 const options={operation,slot:0,config,transport,serviceTemplate:{service_environments:{authoring:{DATABASE_URL:'synthetic'},review:{DATABASE_URL:'synthetic-review'}}},bind:async(_,__,token)=>tokens.push(sha256(token))};
 try{await issueNodeEnrollment(options);await issueNodeEnrollment(options);assert.equal(puts,1);assert.equal(tags,2);assert.equal(tokens[0],tokens[1]);
  const original=stored;stored=canonical({...JSON.parse(stored),registration_token:'different'});await assert.rejects(issueNodeEnrollment(options),/SECRET_VERSION_CONFLICT/);assert.equal(puts,1);stored=original;
  await assert.rejects(issueNodeEnrollment({...options,slot:1}),/ISSUER_SCOPE/);
 }finally{await rm(dir,{recursive:true});}
});

test('warm boot waits for exact current Start ACK version; stale public tag cannot register old epoch',async()=>{
 const config={account_id:identity.account_id,region:identity.region,role_name:'role-a',role_id:'7',secret_name:'node-a'};
 const envelope={identity,role_id:'7',services,expires_at:Date.now()+300000,operation_completed:true,operation_id:'op1',provider_request_id:'ack1'};
 let reads=0,waits=0;
 const transport={call:async(_,action,p)=>{if(action==='GetCallerIdentity')return {AccountId:identity.account_id,UserId:'7:synthetic'};
 if(action==='DescribeInstances'){reads++;return {InstanceSet:[{InstanceId:identity.instance_id,CamRoleName:'role-a',LatestOperation:'StartInstances',LatestOperationState:'SUCCESS',LatestOperationRequestId:reads===1?'new-ack':'ack1',Tags:[{Key:'bondbuddy-enrollment-version',Value:'op1'}]}]};}
 if(action==='GetSecretValue')return {SecretName:p.SecretName,VersionId:p.VersionId,SecretString:canonical(envelope)};}};
 const broker=createSsmEnrollmentBroker({config,transport,wait:async()=>{waits++;},attempts:2});
 assert.equal((await broker.enroll(identity)).verified,true);assert.equal(waits,1);assert.equal(reads,2);
 const foreign=createSsmEnrollmentBroker({config:{...config,role_id:'8'},transport,wait:async()=>{},attempts:1});await assert.rejects(foreign.enroll(identity),/NODE_ROLE_MISMATCH/);
});
