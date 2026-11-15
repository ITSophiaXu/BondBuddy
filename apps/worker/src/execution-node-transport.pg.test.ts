import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer,type Socket} from 'node:net';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool} from 'pg';
import {configureExecutionCapacity,executionCapacityControl,bindExecutionRegistration,registerExecutionRuntime} from '@bondbuddy/api/execution-capacity';
import {claim,releaseLease,type Lease} from '@bondbuddy/api/queue';
import {inputManifestHash} from '@bondbuddy/api/production-rule-pin';
import type {PrivateBlobs} from '@bondbuddy/api/data';
import type {ExecutionNodeContext} from '@bondbuddy/contracts';
import {createExecutionTransportClient,executionTransportFromEnv,type ExecutionTransportProtocol} from './execution-node-transport.js';
import {WorkerRuntime} from './runtime.js';
import {PgModelCallBudget,type ModelCallPermit} from './model-call-budget.js';
import type {StageContext} from './run-pipeline.js';
import {isolatedTestDatabase} from './test-database.js';

const hash='a'.repeat(64);
const blobs=new Proxy({}, {get:()=>async()=>{throw Error('synthetic test expects no object storage');}}) as PrivateBlobs;
const until=async(check:()=>Promise<boolean>,ms=7000)=>{
  const deadline=Date.now()+ms;while(Date.now()<deadline){if(await check())return;await delay(25);}throw Error('condition did not settle');
};
// Use the deployed module's validator; no second copy of its wire contract.
const loadProtocol=async()=>await import(new URL('../../../deploy/tencent-elasticity/transport-renewal.mjs',import.meta.url).href) as ExecutionTransportProtocol;
async function serverFixture(){
  const directory=await mkdtemp(join(tmpdir(),'execution-transport-')),path=join(directory,'transport.sock');
  const connections=new Set<Socket>(),requests:unknown[]=[];
  let respond:(request:any)=>unknown=()=>null;
  const server=createServer(socket=>{
    connections.add(socket);socket.on('error',()=>{});socket.once('close',()=>connections.delete(socket));
    let bytes='';socket.on('data',chunk=>{
      bytes+=chunk.toString();if(!bytes.endsWith('\n'))return;
      const request=JSON.parse(bytes);requests.push(request);const response=respond(request);
      if(response!==null)socket.end(typeof response==='string'?response:JSON.stringify(response)+'\n');
    });
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(path,resolve);});
  return {path,requests,setResponse(fn:typeof respond){respond=fn;},async close(){
    for(const socket of connections)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true});
  }};
}
const responseFor=(context:ExecutionNodeContext,protocol:ExecutionTransportProtocol,healthy:boolean)=>({
  version:protocol.TRANSPORT_REFRESH_VERSION,identity:context.identity,status:healthy?'current':'blocked',
  not_after:healthy?new Date(Date.now()+12*60*60*1000).toISOString():null,
  admission_allowed:healthy,evidence_sha256:healthy?hash:null,
});
async function enroll(connection:string){
  const pool=new Pool({connectionString:connection,max:5}),control=executionCapacityControl(pool);
  const identity={account_id:'synthetic-account',region:'synthetic-region',instance_id:randomUUID(),epoch:randomUUID()};
  const context:ExecutionNodeContext={identity,session_id:randomUUID()},operationId=randomUUID();
  await configureExecutionCapacity(pool,0,{managed_nodes:true,global_model_limit:4,max_nodes:2,budget_available:true});
  let op=await control.reserveStart({...identity,instance_id:null,instance_count:1,source_sha256:hash,image_sha256:hash,launch_manifest_sha256:hash,
    capabilities:['authoring'],services:[{service_id:'one',capabilities:['authoring']}]},operationId,1);
  op=await control.claimCloudDispatch(op.operation_id,op.revision);
  op=await control.recordCloudResult(op.operation_id,op.revision,{state:'submitted',identity,provider_request_id:'synthetic-ack',observation:null});
  await control.recordCloudResult(op.operation_id,op.revision,{state:'completed',identity,provider_request_id:'synthetic-ack',observation:{
    instance_state:'RUNNING',latest_operation:'RunInstances',latest_operation_state:'SUCCESS',latest_operation_request_id:'synthetic-ack',
    stop_charging_mode:null,observed_at:new Date().toISOString(),evidence_ref:'synthetic-transport-observation.json',evidence_sha256:hash,
  }});
  const token='synthetic-transport-registration-012345';await bindExecutionRegistration(pool,identity,operationId,token);
  await registerExecutionRuntime(pool,context,{service_id:'one',capabilities:['authoring'],source_sha256:hash,image_sha256:hash,launch_manifest_sha256:hash,
    registration_token:token,process_identity:{pid:String(process.pid)}});
  const ready=async()=>!!(await pool.query('SELECT ready FROM bb_execution_node_sessions WHERE session_id=$1',[context.session_id])).rows[0]?.ready;
  const beginDrain=async()=>control.beginDrain(identity,randomUUID(),(await control.snapshot()).nodes[0]!.revision);
  return {pool,control,context,ready,beginDrain};
}
async function addJob(pool:Pool){
  const id=randomUUID(),owner='synthetic-owner',manifest={synthetic:true},h=inputManifestHash(manifest);
  await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'synthetic','generation')",[id,owner]);
  await pool.query("INSERT INTO bb_input_revisions(project_id,owner_user_id,revision,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,$2,1,1,$3,$4,'[]','[]')",[id,owner,h,manifest]);
  await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$1,1,$3,$1,'generation',$3,'queued')",[id,owner,h]);
  await pool.query("INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state) VALUES($1,$2,$1,'generation','default','queued')",[id,owner]);return id;
}

test('transport entry preserves legacy and requires the exact managed socket',async()=>{
  assert.equal(await executionTransportFromEnv(undefined,{}),undefined);
  await assert.rejects(executionTransportFromEnv(undefined,{BB_EXECUTION_TRANSPORT_SOCKET:'/unexpected'}),/ENROLLMENT_REQUIRED/);
  const context:ExecutionNodeContext={identity:{account_id:'synthetic',region:'synthetic',instance_id:'one',epoch:randomUUID()},session_id:randomUUID()};
  await assert.rejects(executionTransportFromEnv({context,service_id:'one'},{}),/SOCKET_REQUIRED/);
  await assert.rejects(executionTransportFromEnv({context,service_id:'one'},{BB_EXECUTION_TRANSPORT_SOCKET:'/other.sock'}),/SOCKET_REQUIRED/);
});

const admissionConnection=await isolatedTestDatabase(undefined,'transport-admission');
test('actual UDS client shares one bounded refresh and never publishes malformed or late replies',{skip:!admissionConnection,timeout:5000},async t=>{
  const protocol=await loadProtocol(),server=await serverFixture();let now=Date.now();
  const context:ExecutionNodeContext={identity:{account_id:'synthetic',region:'synthetic',instance_id:'one',epoch:randomUUID()},session_id:randomUUID()};
  const transport=createExecutionTransportClient({socketPath:server.path,context,serviceId:'one',protocol,timeoutMs:150,now:()=>now});
  t.after(async()=>{transport.close();await server.close();});
  assert.equal(transport.ready(),false);
  const one=transport.refresh(),two=transport.refresh();assert.equal(one,two);
  const results=await Promise.allSettled([one,two]);assert.equal(server.requests.length,1);
  for(const result of results){assert.equal(result.status,'rejected');if(result.status==='rejected')assert.equal(result.reason.message,'EXECUTION_TRANSPORT_REFRESH_FAILED');}
  server.setResponse(()=>({...responseFor(context,protocol,true),not_after:new Date(now+12*60*60*1000).toISOString()}));
  await transport.refresh();assert.equal(transport.ready(),true);
  now+=12*60*60*1000-protocol.TRANSPORT_ADMISSION_MARGIN_MS;assert.equal(transport.ready(),false,'cached admission expires at the safety margin');now=Date.now();
  for(const response of ['x'.repeat(4097)+'\n',JSON.stringify(responseFor(context,protocol,true)),'{synthetic private error}\n']){
    server.setResponse(()=>response);await assert.rejects(transport.refresh(),/^Error: EXECUTION_TRANSPORT_REFRESH_FAILED$/);assert.equal(transport.ready(),false);
  }
  server.setResponse(()=>null);const pending=transport.refresh();await until(async()=>server.requests.length===6);
  transport.close();await assert.rejects(pending,/REFRESH_FAILED/);assert.equal(transport.ready(),false);
});
test('actual UDS response gates PG claims and the existing idle heartbeat restores readiness',{skip:!admissionConnection,timeout:20000},async t=>{
  const protocol=await loadProtocol(),fixture=await enroll(admissionConnection!),server=await serverFixture();
  const {pool,context,ready}=fixture;
  const transport=createExecutionTransportClient({socketPath:server.path,context,serviceId:'one',protocol,timeoutMs:500});
  const runtime=new WorkerRuntime({pool,blobs,kinds:['run'],runKinds:['qa'],concurrency:1,interactiveSlots:0,parseSlots:0,
    heartbeatMs:40,pollMs:40,sweepMs:100,executionTransport:transport}).start();
  let lease:Lease|null=null;
  t.after(async()=>{if(lease)await releaseLease(pool,lease);await runtime.stop();transport.close();await server.close();await pool.end();});
  const job=await addJob(pool);
  server.setResponse(()=>responseFor(context,protocol,false));
  await until(async()=>server.requests.length>0);
  assert.equal(await ready(),false);await assert.rejects(claim(pool,5,{runKinds:['generation']}),/not ready/);
  // A regular idle tick, with no new business event, performs each recovery.
  const badResponses=[
    ()=>'{synthetic malformed}\n',
    ()=>({...responseFor(context,protocol,true),identity:{...context.identity,epoch:randomUUID()}}),
    ()=>({...responseFor(context,protocol,true),not_after:new Date(Date.now()-1).toISOString()}),
    ()=>({...responseFor(context,protocol,true),evidence_sha256:null}),
  ];
  for(const bad of badResponses){
    server.setResponse(()=>responseFor(context,protocol,true));await until(ready);
    server.setResponse(bad);await until(async()=>!await ready());
    await assert.rejects(claim(pool,5,{runKinds:['generation']}),/not ready/);
  }
  server.setResponse(()=>responseFor(context,protocol,true));await until(ready);
  lease=await claim(pool,5,{runKinds:['generation']});assert.equal(lease?.jobId,job);
  assert.deepEqual(server.requests[0],{version:protocol.TRANSPORT_REFRESH_VERSION,context,service_id:'one'});
  await releaseLease(pool,lease!);lease=null;
  await fixture.beginDrain();await runtime.stop();
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts')).rows[0].n,0);
});

const continuationConnection=await isolatedTestDatabase(undefined,'transport-continuation');
test('a hanging refresh leaves real lease renewal, exact model continuation and positive drain intact',{skip:!continuationConnection,timeout:20000},async t=>{
  const protocol=await loadProtocol(),fixture=await enroll(continuationConnection!),server=await serverFixture();
  const {pool,context,ready}=fixture;
  server.setResponse(()=>responseFor(context,protocol,true));
  const transport=createExecutionTransportClient({socketPath:server.path,context,serviceId:'one',protocol,timeoutMs:3500});
  const budget=new PgModelCallBudget(pool);let permit:ModelCallPermit|undefined,stageContext:StageContext|undefined;
  let finishStage!:()=>void;const stageLatch=new Promise<void>(resolve=>{finishStage=resolve;});
  const first=await addJob(pool);await delay(5);const queued=await addJob(pool);
  const runtime=new WorkerRuntime({pool,blobs,kinds:['run'],runKinds:['generation'],concurrency:1,interactiveSlots:0,parseSlots:0,
    heartbeatMs:40,pollMs:40,sweepMs:100,leaseSeconds:5,drainMs:20,executionTransport:transport,
    runStages:[{name:'synthetic_transport_stage',run:async ctx=>{
      permit=await budget.acquire(ctx.signal,'synthetic:transport:first',{kind:'job',id:ctx.lease.jobId,token:ctx.lease.token});
      stageContext=ctx;await stageLatch;await permit.release();return {kind:'done',checkpoint:{synthetic:true,transport_failure_did_not_cancel:true}};
    }},{name:'synthetic_no_delivery',run:async()=>({kind:'pause',stage:'capability_not_ready',reason:'synthetic_no_word_or_model'})}]}).start();
  t.after(async()=>{finishStage();await permit?.release();await runtime.stop();transport.close();await server.close();await pool.end();});
  await until(async()=>!!stageContext);const ctx=stageContext!;assert.equal(ctx.lease.jobId,first);
  const before=(await pool.query('SELECT lease_until FROM bb_jobs WHERE id=$1',[first])).rows[0].lease_until.getTime();
  const requestsBefore=server.requests.length;
  server.setResponse(()=>null);await until(async()=>server.requests.length>requestsBefore);
  const started=Date.now(),count=server.requests.length;
  await delay(2200);
  assert.equal(server.requests.length,count,'only one refresh can be in flight');
  const hanging=(await pool.query('SELECT lease_token,lease_until FROM bb_jobs WHERE id=$1',[first])).rows[0];
  assert.equal(hanging.lease_token,ctx.lease.token);assert.ok(hanging.lease_until.getTime()>before);
  assert.ok((await pool.query('SELECT heartbeat_at FROM bb_execution_node_sessions WHERE session_id=$1',[context.session_id])).rows[0].heartbeat_at.getTime()>started);
  await until(async()=>!await ready());server.setResponse(()=>responseFor(context,protocol,false));
  await assert.rejects(claim(pool,5,{runKinds:['generation']}),/not ready/);
  assert.equal(ctx.signal.aborted,false);assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_capacity_holders')).rows[0].n,1);
  await permit!.release();permit=await budget.acquire(ctx.signal,'synthetic:transport:followup',{kind:'job',id:first,token:ctx.lease.token});
  const drain=await fixture.beginDrain();let stopped=false;const stopping=runtime.stop().then(()=>{stopped=true;});
  await delay(2200);assert.equal(stopped,false);assert.equal(ctx.signal.aborted,false);
  await permit.release();permit=await budget.acquire(ctx.signal,'synthetic:transport:draining',{kind:'job',id:first,token:ctx.lease.token});
  assert.equal((await pool.query('SELECT state,lease_token FROM bb_jobs WHERE id=$1',[queued])).rows[0].state,'queued');
  assert.equal(await fixture.control.drainProof(context.identity,drain.drain_operation_id!),null);
  finishStage();await stopping;
  const row=(await pool.query('SELECT state,lease_token,checkpoint FROM bb_jobs WHERE id=$1',[first])).rows[0];
  assert.equal(row.state,'paused');assert.equal(row.lease_token,null);
  assert.equal(row.checkpoint.stages.synthetic_transport_stage.transport_failure_did_not_cancel,true);
  assert.ok(await fixture.control.drainProof(context.identity,drain.drain_operation_id!));
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_capacity_holders')).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts')).rows[0].n,0);
});
