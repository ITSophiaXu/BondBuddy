import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {Pool} from 'pg';
import {setTimeout as delay} from 'node:timers/promises';
import {inputManifestHash} from '@bondbuddy/api/production-rule-pin';
import {executionCapacityControl,configureExecutionCapacity,bindExecutionRegistration} from '@bondbuddy/api/execution-capacity';
import {isolatedTestDatabase} from './test-database.js';
const connection=await isolatedTestDatabase(undefined,'execution-native-processes');
// Two actual independent Node processes, one node epoch and sole PG. Native
// processes exercise real registration/claim/permit adapters, not suppliers.
test('two native service processes share exactly four node permits',{skip:!connection,timeout:15000},async t=>{
 const pool=new Pool({connectionString:connection,max:2});t.after(()=>pool.end());const control=executionCapacityControl(pool),hash='a'.repeat(64),epoch=randomUUID(),token='synthetic-registration-0123456789012345';
 const identity={account_id:'synthetic',region:'synthetic',instance_id:'native-node',epoch};
 await configureExecutionCapacity(pool,0,{managed_nodes:true,global_model_limit:8,max_nodes:2,budget_available:true,provider_concurrency_limit:8,provider_policy_sha256:hash,expense_policy_sha256:hash});
 let op=await control.reserveStart({...identity,instance_id:null,instance_count:1,source_sha256:hash,image_sha256:hash,launch_manifest_sha256:hash,capabilities:['authoring'],services:[{service_id:'one',capabilities:['authoring']},{service_id:'two',capabilities:['authoring']}]},'native-run',1);op=await control.claimCloudDispatch(op.operation_id,0);
 op=await control.recordCloudResult(op.operation_id,op.revision,{state:'submitted',provider_request_id:'native-ack',identity,observation:null});
 await control.recordCloudResult(op.operation_id,op.revision,{state:'completed',provider_request_id:'native-ack',identity,observation:{instance_state:'RUNNING',latest_operation:'RunInstances',latest_operation_state:'SUCCESS',latest_operation_request_id:'native-ack',stop_charging_mode:null,observed_at:new Date().toISOString(),evidence_ref:'synthetic-native-describe.json',evidence_sha256:hash}});
 await bindExecutionRegistration(pool,identity,'native-run',token);
 const jobs:string[]=[];
 for(let n=0;n<4;n++){
  const id=randomUUID(),manifest={synthetic:true},h=inputManifestHash(manifest);jobs.push(id);
  await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,'native-owner','native','generation')",[id]);
  await pool.query("INSERT INTO bb_input_revisions(project_id,owner_user_id,revision,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,'native-owner',1,1,$2,$3,'[]','[]')",[id,h,manifest]);
  await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,'native-owner',$1,1,$2,$1,'generation',$2,'queued')",[id,h]);
  await pool.query("INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state) VALUES($1,'native-owner',$1,'generation','default','queued')",[id]);
 }
 const source=`import {Pool} from 'pg';import {randomUUID} from 'node:crypto';import {once} from 'node:events';import {readFile,readlink} from 'node:fs/promises';
 import {registerExecutionRuntime,heartbeatExecutionRuntime,executionClaimGate} from '@bondbuddy/api/execution-capacity';import {transaction} from '@bondbuddy/api/data';import {PgModelCallBudget} from './apps/worker/dist/model-call-budget.js';
 const [raw]=await once(process.stdin,'data'),input=JSON.parse(raw.toString());const pool=new Pool({connectionString:input.connection});
 const processStart=(await readFile('/proc/self/stat','utf8')).split(') ')[1].split(' ')[19];
 await registerExecutionRuntime(pool,input.context,{service_id:input.service,capabilities:['authoring'],source_sha256:input.hash,image_sha256:input.hash,launch_manifest_sha256:input.hash,registration_token:input.token,process_identity:{pid:String(process.pid),process_start:processStart,host_boot_id:(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim(),pid_namespace:await readlink('/proc/self/ns/pid')}});
 await heartbeatExecutionRuntime(pool,{native_processes:0,unpersisted_results:0,ready:true});
 for(let n=0;n<100;n++){if((await pool.query('SELECT state FROM bb_execution_nodes WHERE instance_id=$1',[input.context.identity.instance_id])).rows[0].state==='ready')break;await new Promise(r=>setTimeout(r,25));}
 const budget=new PgModelCallBudget(pool),held=[];
 for(const id of input.jobs){const lease=randomUUID();await transaction(pool,async c=>{await executionClaimGate(c,pool);await c.query("UPDATE bb_jobs SET state='running',lease_token=$2,lease_until=now()+interval '60 seconds' WHERE id=$1",[id,lease]);});held.push(await budget.acquire(AbortSignal.timeout(5000),'native:'+id,{kind:'job',id,token:lease}));}
 process.stdout.write('held\\n');await once(process.stdin,'data');for(const permit of held)await permit.release();await pool.query("UPDATE bb_jobs SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE id=ANY($1::text[])",[input.jobs]);await heartbeatExecutionRuntime(pool,{native_processes:0,unpersisted_results:0,ready:false,finished:true});await pool.end();process.stdout.write('done\\n');process.stdin.destroy();`;
 const children=[0,1].map(n=>{
  const child=spawn(process.execPath,['--input-type=module','-e',source],{cwd:process.cwd(),stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
  child.stdout.on('data',b=>{stdout+=b.toString();});child.stderr.on('data',b=>{stderr+=b.toString();});
  const closed=new Promise<number|null>(resolve=>child.once('close',resolve));
  child.stdin.write(JSON.stringify({connection,context:{identity,session_id:randomUUID()},token,hash,service:n?'two':'one',jobs:jobs.slice(n*2,n*2+2)})+'\n');
  return {child,closed,output:()=>({stdout,stderr})};
 });
 t.after(async()=>{for(const c of children){if(c.child.exitCode===null)c.child.kill('SIGTERM');await c.closed;}});
 for(let n=0;;n++){if(children.every(c=>c.output().stdout.includes('held')))break;assert.ok(n<100,children.map(c=>c.output().stderr).join('\n'));await delay(25);}
 const holders=(await pool.query('SELECT parent_pid,node_slot,slot FROM bb_model_capacity_holders ORDER BY node_slot')).rows;
 assert.equal(holders.length,4);assert.equal(new Set(holders.map(h=>h.parent_pid)).size,2);assert.deepEqual(holders.map(h=>h.node_slot),[1,2,3,4]);assert.equal((await control.snapshot()).available_model_slots,4);
 for(const c of children)c.child.stdin.write('release\n');for(const c of children)assert.equal(await c.closed,0,c.output().stderr);
 assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_capacity_holders')).rows[0].n,0);
 const n=(await control.snapshot()).nodes[0]!;await control.beginDrain(identity,'native-drain',n.revision);assert.ok(await control.drainProof(identity,'native-drain'));
});
