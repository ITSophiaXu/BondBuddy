import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {X509Certificate} from 'node:crypto';
import {createControlAuthority,validateAuthorityDatabaseBinding,validateAuthorityDatabaseConnection,verifyAuthorityDatabaseIdentity} from './control-authority.mjs';
import {installPrivateTransport,transportOperationSan} from './private-transport.mjs';
import {TencentTransport} from './tencent-cvm.mjs';
import {sha256} from './policy.mjs';
import {issueTransportCredentials} from './transport-issuer.mjs';
const exec=promisify(execFile);

test('authority database deployment binding preserves isolated defaults and rejects missing, crossed and drifted production targets',()=>{
  const legacy={credential_ready:true,database_name:'bb1361_owned_isolated',system_identifier:'7705237779724353574',
    credentials_file:'/var/lib/bondbuddy/elastic-pg-mtls/issuer/pg-credentials.json'};
  const isolated=validateAuthorityDatabaseBinding({},legacy);
  validateAuthorityDatabaseConnection('postgresql://synthetic:synthetic@127.0.0.1:15432/bb1361_owned_isolated',isolated);
  verifyAuthorityDatabaseIdentity({name:legacy.database_name,system_identifier:legacy.system_identifier},isolated);
  const binding={...isolated,database_name:'bondbuddy'},pg={...legacy,database_name:'bondbuddy'};
  assert.throws(()=>validateAuthorityDatabaseBinding({},pg),/AUTHORITY_DATABASE_NOT_READY/);
  const checked=validateAuthorityDatabaseBinding({database_binding:binding},pg);
  validateAuthorityDatabaseConnection('postgresql://synthetic:synthetic@127.0.0.1:15432/bondbuddy',checked);
  validateAuthorityDatabaseConnection('postgresql://synthetic:synthetic@127.0.0.1:15432/bondbuddy?sslmode=disable',checked);
  verifyAuthorityDatabaseIdentity({name:'bondbuddy',system_identifier:pg.system_identifier},checked);
  for(const bad of [null,{}, {...binding,version:undefined},{...binding,database_name:'other'},{...binding,system_identifier:null},
    {...binding,host:'other'},{...binding,port:5432},{...binding,credentials_file:'/tmp/credentials.json'},{...binding,extra:'ignored'}])
    assert.throws(()=>validateAuthorityDatabaseBinding({database_binding:bad},pg),/AUTHORITY_DATABASE_BINDING/);
  for(const bad of [{...pg,credential_ready:false},{...pg,database_name:'bb1361_owned_isolated'},
    {...pg,system_identifier:'7705237779724353575'},{...pg,credentials_file:'/tmp/credentials.json'}])
    assert.throws(()=>validateAuthorityDatabaseBinding({database_binding:binding},bad),/AUTHORITY_DATABASE_NOT_READY/);
  for(const url of ['postgresql://synthetic:synthetic@127.0.0.1:15432/bb1361_owned_isolated','postgresql://synthetic:synthetic@other:15432/bondbuddy',
    'postgresql://synthetic:synthetic@127.0.0.1:5432/bondbuddy','postgresql://synthetic:synthetic@127.0.0.1:15432/bondbuddy?host=other',
    'postgresql://synthetic:synthetic@127.0.0.1:15432/bondbuddy?port=5432','http://127.0.0.1:15432/bondbuddy','invalid-sensitive-input'])
    assert.throws(()=>validateAuthorityDatabaseConnection(url,checked),/^Error: AUTHORITY_DATABASE_SCOPE$/);
  for(const actual of [null,{name:'bb1361_owned_isolated',system_identifier:pg.system_identifier},{name:'bondbuddy',system_identifier:'7705237779724353575'}])
    assert.throws(()=>verifyAuthorityDatabaseIdentity(actual,checked),/AUTHORITY_DATABASE_DRIFT/);
});

async function raceAuthority(t,{sign,describe,now,history=[]}={}){
  const dir=await mkdtemp(join(tmpdir(),'bb-authority-race-'));t.after(()=>rm(dir,{recursive:true}));
  await exec('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-days','2','-subj','/CN=synthetic-ca','-keyout',join(dir,'ca.key'),'-out',join(dir,'ca.pem')]);await chmod(join(dir,'ca.pem'),0o600);
  const identity={account_id:'123456',region:'ap-beijing',instance_id:'ins-a1',epoch:'a3432123-84b5-4f11-8b51-94a29eac1234'};
  const issuer={ca_file:join(dir,'ca.pem'),signing_key_file:join(dir,'ca.key'),ca_sha256:sha256(await readFile(join(dir,'ca.pem')))};
  const operation={operation_id:'op1',identity,state:'completed',action:'start',provider_request_id:'ack1',request:{source_sha256:'a'.repeat(64),image_sha256:'b'.repeat(64),launch_manifest_sha256:'c'.repeat(64)}};
  const node={identity:{...identity},state:'ready',cloud_start_operation_id:'op1',launch_manifest_sha256:operation.request.launch_manifest_sha256};
  const observed={instance_state:'RUNNING',latest_operation_state:'SUCCESS',latest_operation:'StartInstances',latest_operation_request_id:'ack1',stop_charging_mode:null,observed_at:new Date().toISOString(),evidence_ref:'synthetic/describe',evidence_sha256:'a'.repeat(64)};
  const authority=createControlAuthority({config:{account_id:identity.account_id,region:identity.region,issuer,pool:operation.request},
    control:{loadOperation:async()=>structuredClone(operation)},expenseLedger:async()=>({nodes:[structuredClone(node),...structuredClone(history)]}),
    cloud:{describe:describe??(async()=>observed)},verifyDatabase:async()=>{},now,
    ...(sign?{sign}:{}),credentialsProvider:{get:async()=>{throw Error('unused');}}});
  return {authority,node,observed,request:{version:'execution-pg-issuer-v1',action:'issue',operation_id:'op1',identity}};
}

test('issuer excludes retired stopped ledger rows while retaining live capacity and target retirement guards',async t=>{
  const history=[1,2].map(i=>({identity:{instance_id:'ins-retired'+i},state:'stopped',destroyed_at:new Date().toISOString()}));
  const fixture=await raceAuthority(t,{history,sign:async()=>({})});
  await fixture.authority.handle(fixture.request);
  fixture.node.destroyed_at=new Date().toISOString();
  await assert.rejects(fixture.authority.handle(fixture.request),/AUTHORITY_NODE_SCOPE/);
  const live=await raceAuthority(t,{history:history.map(n=>({...n,destroyed_at:null})),sign:async()=>({})});
  await assert.rejects(live.authority.handle(live.request),/AUTHORITY_NODE_SCOPE/);
});

test('signing that advances time and remains pending retains exclusive ownership until settlement',async t=>{
  let time=Date.now(),started,release,calls=0;
  const barrier=new Promise(r=>{release=r;}),entered=new Promise(r=>{started=r;});
  const {authority,request}=await raceAuthority(t,{now:()=>time,sign:async()=>{calls++;time+=20001;started();await barrier;return {};}});
  const first=authority.handle(request);
  await entered;
  await assert.rejects(authority.handle(request),/AUTHORITY_BUSY/);
  assert.equal(calls,1);
  release();await assert.rejects(first,/AUTHORITY_REQUEST_EXPIRED/);
  await new Promise(r=>setImmediate(r));
  await assert.rejects(authority.handle(request,{deadline:time}),/AUTHORITY_REQUEST_EXPIRED/);
  assert.equal(calls,1); // An expired boundary never starts the signer.
});

test('final cloud read cannot hide a Stop or epoch change that occurred while it was pending',async t=>{
  for(const change of ['stop','epoch']){
    let calls=0,entered,release;
    const arrived=new Promise(r=>{entered=r;}),barrier=new Promise(r=>{release=r;});
    const fixture=await raceAuthority(t,{describe:async()=>{if(++calls===2){entered();await barrier;}return fixture.observed;}});
    const pending=fixture.authority.handle(fixture.request);await arrived;
    if(change==='stop')fixture.node.state='stop_submitted';else fixture.node.identity.epoch='b3432123-84b5-4f11-8b51-94a29eac1234';
    release();await assert.rejects(pending,/AUTHORITY_NODE_SCOPE/);assert.equal(calls,2);
  }
});

test('root signing authorization comes from PG and exact cloud ACK; leaf binds the immutable operation',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'bb-authority-'));t.after(()=>rm(dir,{recursive:true}));
  await exec('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-days','2','-subj','/CN=synthetic-ca','-keyout',join(dir,'ca.key'),'-out',join(dir,'ca.pem')]);await chmod(join(dir,'ca.pem'),0o600);
  const identity={account_id:'123456',region:'ap-beijing',instance_id:'ins-a1',epoch:'a3432123-84b5-4f11-8b51-94a29eac1234'};
  const issuer={ca_file:join(dir,'ca.pem'),signing_key_file:join(dir,'ca.key'),ca_sha256:sha256(await readFile(join(dir,'ca.pem')))};
  const config={account_id:identity.account_id,region:identity.region,control_role_id:'7',issuer,pool:{source_sha256:'a'.repeat(64),image_sha256:'b'.repeat(64)}};
  let operation={operation_id:'op1',identity,state:'completed',action:'start',provider_request_id:'ack1',request:{source_sha256:config.pool.source_sha256,image_sha256:config.pool.image_sha256,launch_manifest_sha256:'c'.repeat(64)}};
  let cloudAck='ack1',nodeEpoch=identity.epoch,dbChecks=0,invalidateOnSign=false;
  const authority=createControlAuthority({config,control:{loadOperation:async()=>operation},expenseLedger:async()=>({nodes:[{identity:{...identity,epoch:nodeEpoch},state:'ready',cloud_start_operation_id:'op1',launch_manifest_sha256:operation.request.launch_manifest_sha256}]}),
    cloud:{describe:async()=>({instance_state:'RUNNING',latest_operation_state:'SUCCESS',latest_operation:'StartInstances',latest_operation_request_id:cloudAck,stop_charging_mode:null,observed_at:new Date().toISOString(),evidence_ref:'synthetic/describe',evidence_sha256:'a'.repeat(64)})},
    verifyDatabase:async()=>{dbChecks++;},credentialsProvider:{get:async()=>({secretId:'short-only',secretKey:'synthetic',token:'synthetic',expiresAt:Date.now()+1800000})},
    sign:async(...args)=>{const c=await issueTransportCredentials(...args);if(invalidateOnSign)nodeEpoch='new-epoch';return c;}});
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
  operation={...operation,state:'completed'};invalidateOnSign=true;
  await assert.rejects(authority.handle(request),/AUTHORITY_NODE_SCOPE/);
  assert.equal(sha256(await readFile(join(dir,'private/client.pem'))),original);
  assert.ok(dbChecks>=4);
});

test('authority deadline retains the uncertain flight and a disconnect cannot trigger issuance',async()=>{
  let release,calls=0;const pending=new Promise(r=>{release=r;});
  const authority=createControlAuthority({config:{account_id:'123456',control_role_id:'7',issuer:{}},credentialsProvider:{get:async()=>{
    calls++;await pending;return {token:'synthetic',expiresAt:Date.now()+1800000};}}});
  const request={version:'execution-control-credentials-v1',account_id:'123456',role_id:'7'};
  const first=authority.handle(request,{deadline:Date.now()+20});
  await assert.rejects(authority.handle(request),/AUTHORITY_BUSY/);
  await assert.rejects(first,/AUTHORITY_REQUEST_EXPIRED/);
  await assert.rejects(authority.handle(request),/AUTHORITY_BUSY/);assert.equal(calls,1);
  release();await new Promise(r=>setImmediate(r));
  await assert.rejects(authority.handle(request,{isConnected:()=>false}),/AUTHORITY_REQUEST_EXPIRED/);assert.equal(calls,1);
  assert.ok((await authority.handle(request)).credentials.token);assert.equal(calls,2);
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
