import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {X509Certificate} from 'node:crypto';
import {createControlAuthority} from './control-authority.mjs';
import {installPrivateTransport,transportOperationSan} from './private-transport.mjs';
import {TencentTransport} from './tencent-cvm.mjs';
import {sha256} from './policy.mjs';
const exec=promisify(execFile);

test('root signing authorization comes from PG and exact cloud ACK; leaf binds the immutable operation',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'bb-authority-'));t.after(()=>rm(dir,{recursive:true}));
  await exec('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-days','2','-subj','/CN=synthetic-ca','-keyout',join(dir,'ca.key'),'-out',join(dir,'ca.pem')]);await chmod(join(dir,'ca.pem'),0o600);
  const identity={account_id:'123456',region:'ap-beijing',instance_id:'ins-a1',epoch:'a3432123-84b5-4f11-8b51-94a29eac1234'};
  const issuer={ca_file:join(dir,'ca.pem'),signing_key_file:join(dir,'ca.key'),ca_sha256:sha256(await readFile(join(dir,'ca.pem')))};
  const config={account_id:identity.account_id,region:identity.region,control_role_id:'7',issuer,pool:{source_sha256:'a'.repeat(64),image_sha256:'b'.repeat(64)}};
  let operation={operation_id:'op1',identity,state:'completed',action:'run',provider_request_id:'ack1',request:{source_sha256:config.pool.source_sha256,image_sha256:config.pool.image_sha256,launch_manifest_sha256:'c'.repeat(64)}};
  let cloudAck='ack1',nodeEpoch=identity.epoch,dbChecks=0;
  const authority=createControlAuthority({config,control:{loadOperation:async()=>operation},expenseLedger:async()=>({nodes:[{identity:{...identity,epoch:nodeEpoch},state:'ready',cloud_start_operation_id:'op1',launch_manifest_sha256:operation.request.launch_manifest_sha256}]}),
    cloud:{describe:async()=>({instance_state:'RUNNING',latest_operation_state:'SUCCESS',latest_operation:'RunInstances',latest_operation_request_id:cloudAck})},
    verifyDatabase:async()=>{dbChecks++;},credentialsProvider:{get:async()=>({secretId:'short-only',secretKey:'synthetic',token:'synthetic',expiresAt:Date.now()+1800000})}});
  const request={version:'execution-pg-issuer-v1',action:'issue',operation_id:'op1',identity};
  const result=await authority.handle(request);
  assert.equal(new X509Certificate(result.transport_credentials.cert_pem).subjectAltName,`URI:${transportOperationSan(identity,'op1','ack1')}`);
  const expected={...identity,operation_id:'op1',provider_request_id:'ack1',ca_sha256:issuer.ca_sha256};
  await installPrivateTransport(join(dir,'private'),result.transport_credentials,expected);
  const original=sha256(await readFile(join(dir,'private/client.pem')));
  await assert.rejects(installPrivateTransport(join(dir,'private'),result.transport_credentials,{...expected,operation_id:'old-op'}),/PG_CERTIFICATE_OPERATION_BINDING/);
  assert.equal(sha256(await readFile(join(dir,'private/client.pem'))),original);
  cloudAck='drift';await assert.rejects(authority.handle(request),/AUTHORITY_CLOUD_COMPLETION/);cloudAck='ack1';
  nodeEpoch='old';await assert.rejects(authority.handle(request),/AUTHORITY_NODE_SCOPE/);nodeEpoch=identity.epoch;
  operation={...operation,state:'unknown'};await assert.rejects(authority.handle(request),/AUTHORITY_OPERATION_SCOPE/);
  await assert.rejects(authority.handle({...request,operation:{state:'completed'}}),/AUTHORITY_ISSUER_ACTION/);
  assert.ok(dbChecks>=4);
});

test('actual source TC3 signer and provider verify role and originating principal before exposing a short credential',async()=>{
  const {createControlCredentialProvider}=await import('./control-credentials.mjs');
  const time=Math.floor(Date.now()/1000)*1000,expiry=time+1800000,accountId='123456',sourcePrincipalUin='8',roleId='7';
  const options={sourceCredentialsFile:'/synthetic/source.json',accountId,sourcePrincipalUin,roleId,roleArn:`qcs::cam::uin/${accountId}:roleName/bondbuddy-execution-control`,roleSessionName:'bondbuddy-execution-control'};
  let calls=0,badPrincipal=false;
  const provider=createControlCredentialProvider(options,{now:()=>time,readSource:async()=>({secretId:'synthetic-source',secretKey:'synthetic-only'}),
    createTransport:opts=>new TencentTransport({...opts,now:()=>time,fetchImpl:async(url,request)=>{
      calls++;assert.equal(url,'https://sts.tencentcloudapi.com/');assert.match(request.headers.Authorization,/^TC3-HMAC-SHA256/);
      if(request.headers['X-TC-Action']==='AssumeRole'){
        assert.equal('X-TC-Token' in request.headers,false);assert.equal(JSON.parse(request.body).RoleArn,options.roleArn);
        return new Response(JSON.stringify({Response:{RequestId:'synthetic-issued',ExpiredTime:expiry/1000,Expiration:new Date(expiry).toISOString(),Credentials:{TmpSecretId:'synthetic-short',TmpSecretKey:'synthetic-short-key',Token:'synthetic-short-token'}}}));
      }
      assert.equal(request.headers['X-TC-Action'],'GetCallerIdentity');assert.equal(request.headers['X-TC-Token'],'synthetic-short-token');
      return new Response(JSON.stringify({Response:{RequestId:'synthetic-identity',AccountId:accountId,UserId:`${roleId}:${options.roleSessionName}`,PrincipalId:badPrincipal?'foreign':sourcePrincipalUin}}));
    }})});
  assert.equal((await provider.get()).secretId,'synthetic-short');assert.equal((await provider.get()).token,'synthetic-short-token');assert.equal(calls,2);
  const invalid=createControlCredentialProvider(options,{now:()=>time,readSource:async()=>({secretId:'synthetic',secretKey:'synthetic'}),createTransport:async opts=>{
    if(opts.purpose==='control-source')return {call:async()=>({RequestId:'synthetic',ExpiredTime:expiry/1000,Expiration:new Date(expiry).toISOString(),Credentials:{TmpSecretId:'synthetic',TmpSecretKey:'synthetic',Token:'synthetic'}})};
    return {call:async()=>({RequestId:'synthetic',AccountId:accountId,UserId:`${roleId}:${options.roleSessionName}`,PrincipalId:'foreign'})};
  }});
  await assert.rejects(invalid.get(),/CONTROL_CREDENTIALS_UNAVAILABLE/);
});
