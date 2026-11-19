import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,X509Certificate} from 'node:crypto';
import {mkdtemp,rm,readFile,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Pool} from 'pg';
import {executionCapacityControl,executionCloudExpenseLedger,configureExecutionCapacity,
  bindExecutionRegistration,registerExecutionRuntime,heartbeatExecutionRuntime} from '@bondbuddy/api/execution-capacity';
import {isolatedTestDatabase} from '../../apps/api/dist/test-database.js';
import {issueNodeEnrollment} from './enrollment.mjs';
import {pruneRetiredNodeVersions} from './transport-renewal.mjs';
import {canonical,sha256} from './policy.mjs';

const h='a'.repeat(64),services=[{service_id:'authoring',capabilities:['authoring']}];
const identity={account_id:'123456',region:'ap-beijing',instance_id:'ins-cycle',epoch:randomUUID()};
const observation=(action,ack)=>({instance_state:action==='stop'?'STOPPED':'RUNNING',
  latest_operation:action==='stop'?'StopInstances':'StartInstances',latest_operation_state:'SUCCESS',
  latest_operation_request_id:ack,stop_charging_mode:action==='stop'?'STOP_CHARGING':null,
  observed_at:new Date().toISOString(),evidence_ref:'synthetic/cloud',evidence_sha256:h});
function issued(i=identity,id='old-op'){
  return {operation_id:id,action:'start',state:'completed',identity:i,provider_request_id:'ack-'+id,
    request:{services,source_sha256:h,image_sha256:h,launch_manifest_sha256:h},cloud_observation:observation('start','ack-'+id)};
}
const stopped=op=>({...op,action:'stop',operation_id:'stop-'+op.operation_id,
  provider_request_id:'stop-ack-'+op.operation_id,cloud_observation:observation('stop','stop-ack-'+op.operation_id)});
const envelope=op=>({version:'synthetic-service-template-v1',operation_action:op.action,operation_completed:true,operation_id:op.operation_id,
  identity:op.identity,provider_request_id:op.provider_request_id,registration_token:'synthetic-token',
  expires_at:Date.now()+600000,...op.request});
function ssm(values){
  const calls=[],state={deleteUnknown:false,deleteAccepted:false,putUnknown:false};
  const transport={async call(service,action,payload){
    assert.equal(service,'ssm');assert.equal(payload.SecretName,'own-slot');calls.push(action);
    if(action==='ListSecretVersionIds')return {SecretName:payload.SecretName,Versions:[...values.keys()].map(VersionId=>({VersionId}))};
    if(action==='GetSecretValue'){
      if(!values.has(payload.VersionId)){const e=Error('synthetic missing');e.code='ResourceNotFound';throw e;}
      return {SecretName:payload.SecretName,VersionId:payload.VersionId,SecretString:values.get(payload.VersionId)};
    }
    if(action==='DeleteSecretVersion'){
      if(!state.deleteUnknown||state.deleteAccepted)values.delete(payload.VersionId);
      if(state.deleteUnknown)throw Error('synthetic lost Delete ACK');return {RequestId:'synthetic-delete'};
    }
    assert.equal(action,'PutSecretValue');assert.ok(values.size<10);assert.ok(!values.has(payload.VersionId));
    if(state.putUnknown)throw Error('synthetic lost Put ACK');values.set(payload.VersionId,payload.SecretString);
    return {RequestId:'synthetic-put'};
  }};
  return {transport,calls,state};
}
async function fixture(t){const directory=await mkdtemp(join(tmpdir(),'bb-secret-retirement-'));
  t.after(()=>rm(directory,{recursive:true}));return directory;}

test('unexpired stopped enrollments are retired before issuance, within 34 SSM calls',async t=>{
  const directory=await fixture(t),operations=[],values=new Map();
  for(let n=0;n<10;n++){const op=issued({...identity,epoch:randomUUID()},'retired-'+n);
    operations.push(op,stopped(op));values.set(op.operation_id,canonical(envelope(op)));}
  const f=ssm(values);f.state.deleteUnknown=true;f.state.deleteAccepted=true;
  const op=issued({...identity,epoch:randomUUID()},'new-op');
  await issueNodeEnrollment({operation:op,slot:0,config:{...identity,registration_directory:directory,
    role_names:['role-a'],node_secrets:[{role_name:'role-a',role_id:'7',secret_name:'own-slot'}]},
    transport:f.transport,bind:async()=>{},serviceTemplate:{},retirement:async()=>({operations,nodes:[]})});
  assert.deepEqual([...values.keys()],['new-op']);assert.equal(f.calls.length,34);
  assert.equal(f.calls.filter(a=>a==='DeleteSecretVersion').length,10);
});

test('current, unknown and opaque versions survive; incomplete Stop proof never frees capacity',async t=>{
  const directory=await fixture(t),old=issued(),current={...identity,epoch:randomUUID()};
  for(const change of [s=>({...s,provider_request_id:null}),s=>({...s,cloud_observation:{...s.cloud_observation,latest_operation_request_id:'foreign'}}),
    s=>({...s,cloud_observation:{...s.cloud_observation,latest_operation_state:'PENDING'}}),
    s=>({...s,cloud_observation:{...s.cloud_observation,instance_state:'RUNNING'}}),
    s=>({...s,cloud_observation:{...s.cloud_observation,stop_charging_mode:'KEEP_CHARGING'}})]){
    const values=new Map([[old.operation_id,canonical(envelope(old))]]);
    for(let n=0;n<9;n++)values.set('opaque-'+n,'not an enrollment');const f=ssm(values);
    await assert.rejects(pruneRetiredNodeVersions({secretName:'own-slot',keep:[],scope:current,
      operations:[old,change(stopped(old))],nodes:[],transport:f.transport,registrationDirectory:directory}),/SECRET_VERSION_CAPACITY/);
    assert.equal(f.calls.filter(a=>a==='DeleteSecretVersion').length,0);assert.equal(values.size,10);
  }
  for(const refs of [{operations:[old,stopped(old),{...old,state:'unknown'}],nodes:[]},
    {operations:[old,stopped(old)],nodes:[{identity:old.identity,state:'ready'}]}]){
    const values=new Map([[old.operation_id,canonical(envelope(old))],['opaque','{}'],['current',canonical(envelope(issued(current)))]]),f=ssm(values);
    await pruneRetiredNodeVersions({secretName:'own-slot',keep:[],scope:current,...refs,transport:f.transport,registrationDirectory:directory});
    assert.equal(values.size,3);assert.equal(f.calls.filter(a=>a==='DeleteSecretVersion').length,0);
  }
});

test('unknown Delete only reads its original version; unknown Put never reruns pruning or Put',async t=>{
  const directory=await fixture(t),old=issued(),values=new Map([[old.operation_id,canonical(envelope(old))]]),f=ssm(values);
  f.state.deleteUnknown=true;
  const options={secretName:'own-slot',keep:[],scope:{...identity,epoch:randomUUID()},operations:[old,stopped(old)],
    nodes:[],transport:f.transport,registrationDirectory:directory};
  await assert.rejects(pruneRetiredNodeVersions(options),/DELETE_UNCONFIRMED/);
  await assert.rejects(pruneRetiredNodeVersions(options),/DELETE_UNCONFIRMED/);
  assert.equal(f.calls.filter(a=>a==='DeleteSecretVersion').length,1);assert.ok(values.has(old.operation_id));
  values.delete(old.operation_id);await pruneRetiredNodeVersions(options);
  const next=issued(options.scope,'next-op');f.state.putUnknown=true;
  const args={operation:next,slot:0,config:{...identity,registration_directory:directory,role_names:['role-a'],
    node_secrets:[{role_name:'role-a',role_id:'7',secret_name:'own-slot'}]},transport:f.transport,bind:async()=>{},serviceTemplate:{}};
  await assert.rejects(issueNodeEnrollment(args));const lists=f.calls.filter(a=>a==='ListSecretVersionIds').length;
  await assert.rejects(issueNodeEnrollment(args));assert.equal(f.calls.filter(a=>a==='PutSecretValue').length,1);
  assert.equal(f.calls.filter(a=>a==='ListSecretVersionIds').length,lists);
});

const connection=await isolatedTestDatabase(undefined,'secret-retirement-cycles');
test('real PG completes twelve warm cycles with positive Stop proofs and unexpired certificates',
  {skip:!connection,timeout:30000},async t=>{
    const directory=await fixture(t),pool=new Pool({connectionString:connection,max:3});t.after(()=>pool.end());
    if(!(await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name='bb_execution_cloud_operations' AND column_name='run_acceptance'")).rowCount)
      await pool.query(await readFile(new URL('../../db/migrations/0183_execution_run_acceptance.sql',import.meta.url),'utf8'));
    const exec=promisify(execFile),ca=join(directory,'ca.pem'),key=join(directory,'ca.key');
    await exec('/usr/bin/openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-days','2',
      '-subj','/CN=Synthetic retirement CA','-keyout',key,'-out',ca],{timeout:5000,maxBuffer:4096});
    await chmod(ca,0o600);await chmod(key,0o600);
    const pg_issuer={ca_file:ca,signing_key_file:key,ca_sha256:sha256(await readFile(ca))};
    const config={...identity,registration_directory:join(directory,'vault'),role_names:['role-a'],
      node_secrets:[{role_name:'role-a',role_id:'7',secret_name:'own-slot',pg_issuer}]};
    const control=executionCapacityControl(pool),values=new Map(),f=ssm(values);
    await configureExecutionCapacity(pool,(await control.snapshot()).policy.revision,
      {managed_nodes:true,global_model_limit:4,max_nodes:2,budget_available:true,expense_policy_sha256:h});
    for(let cycle=0;cycle<12;cycle++){
      const opId='cycle-'+cycle,epoch=randomUUID(),local={...identity,epoch};
      const request={account_id:identity.account_id,region:identity.region,instance_id:cycle?identity.instance_id:null,
        instance_count:1,epoch,services,capabilities:['authoring'],source_sha256:h,image_sha256:h,launch_manifest_sha256:h};
      const intent=await control.reserveStart(request,opId,(await control.snapshot()).policy.revision);
      const claimed=await control.claimCloudDispatch(opId,intent.revision),ack='synthetic-'+opId;
      const acceptance={operation_id:opId,identity:local,provider_request_id:ack,instance_ids:[local.instance_id],
        client_token:claimed.client_token,launch_manifest_sha256:h,launch_binding_sha256:h,evidence_ref:'synthetic/run',evidence_sha256:h};
      const submitted=await control.recordCloudResult(opId,claimed.revision,{state:'submitted',identity:local,provider_request_id:ack,observation:null,
        ...(!cycle?{run_acceptance:acceptance}:{})});
      const observed=observation('start',ack);
      if(!cycle){Object.assign(observed,{latest_operation:null,latest_operation_state:null,latest_operation_request_id:null,
        run_creation:{operation_id:opId,identity:local,launch_manifest_sha256:h,launch_binding_sha256:h,
          created_at:claimed.dispatched_at,instance_status:'RUNNING',status_request_id:'synthetic-status'}});}
      const op=await control.recordCloudResult(opId,submitted.revision,{state:'completed',identity:local,provider_request_id:ack,observation:observed});
      const before=f.calls.length;
      await issueNodeEnrollment({operation:op,slot:0,config,transport:f.transport,serviceTemplate:{version:'synthetic-service-template-v1'},
        bind:(...args)=>bindExecutionRegistration(pool,...args),
        retirement:async()=>({operations:(await executionCloudExpenseLedger(pool)).operations,nodes:(await control.snapshot()).nodes})});
      assert.ok(f.calls.length-before<=34);assert.equal(values.size,1);
      const secret=JSON.parse(values.get(opId));assert.equal(secret.identity.epoch,epoch);
      assert.ok(Date.parse(new X509Certificate(secret.transport_credentials.cert_pem).validTo)>Date.now()+600000);
      const runtime=new Pool({connectionString:connection,max:1});
      try{await registerExecutionRuntime(runtime,{identity:local,session_id:randomUUID()},
        {source_sha256:h,image_sha256:h,launch_manifest_sha256:h,registration_token:secret.registration_token,
          service_id:'authoring',capabilities:['authoring'],process_identity:{pid:String(process.pid),boot:randomUUID()}});
        await heartbeatExecutionRuntime(runtime,{native_processes:0,unpersisted_results:0,ready:true});
        const node=(await control.snapshot()).nodes.find(n=>n.identity.instance_id===identity.instance_id),stopId='stop-'+cycle;
        await control.beginDrain(local,stopId,node.revision);
        await heartbeatExecutionRuntime(runtime,{native_processes:0,unpersisted_results:0,ready:false,finished:true});
        const proof=await control.drainProof(local,stopId);assert.ok(proof);assert.ok(proof.positive_session_receipts>0);assert.equal(proof.active_leases,0);assert.equal(proof.active_model_calls,0);
        const stopIntent=await control.submitStop(proof,'stop'),stopClaim=await control.claimCloudDispatch(stopId,stopIntent.revision),stopAck='synthetic-'+stopId;
        const stopSubmitted=await control.recordCloudResult(stopId,stopClaim.revision,{state:'submitted',identity:local,provider_request_id:stopAck,observation:null});
        await control.recordCloudResult(stopId,stopSubmitted.revision,{state:'completed',identity:local,provider_request_id:stopAck,observation:observation('stop',stopAck)});
      }finally{await runtime.end();}
    }
    assert.equal(f.calls.filter(a=>a==='PutSecretValue').length,12);
    assert.equal(f.calls.filter(a=>a==='DeleteSecretVersion').length,11);
    assert.equal((await executionCloudExpenseLedger(pool)).operations.filter(op=>op.action==='stop'&&op.state==='completed').length,12);
  });


test('enrollment recovery keeps all predecessor versions, fits the existing 34-call fee bound, retires only after Stop',async t=>{
 const directory=await fixture(t),values=new Map(),operations=[],f=ssm(values);let at=Date.now();
 const op=issued({...identity,epoch:randomUUID()},'recovering-op');
 const options={operation:op,slot:0,config:{...identity,registration_directory:directory,role_names:['role-a'],node_secrets:[{role_name:'role-a',role_id:'7',secret_name:'own-slot'}]},
   transport:f.transport,bind:async()=>{},serviceTemplate:{},retirement:async()=>({operations,nodes:[]}),now:()=>at};
 await issueNodeEnrollment(options);
 for(let generation=1;generation<=3;generation++){
   let n=0;while(values.size<10){const old=issued({...identity,epoch:randomUUID()},`retired-${generation}-${n++}`);
     operations.push(old,stopped(old));values.set(old.operation_id,canonical(envelope(old)));}
   at+=600001;f.calls.length=0;
   assert.equal((await issueNodeEnrollment(options)).recovery_generation,generation);
   assert.equal(f.calls.length,34-2*generation);
   assert.equal(values.size,generation+1,'same-epoch enrollment bytes survive until exact Stop');
 }
 operations.push(op,stopped(op));
 const fresh=issued({...identity,epoch:randomUUID()},'after-stop');
 await issueNodeEnrollment({...options,operation:fresh});
 assert.deepEqual([...values.keys()],['after-stop']);
});
