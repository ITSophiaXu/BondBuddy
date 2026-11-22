import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Pool} from 'pg';
import {digest,transaction,type PrivateBlobs} from '@bondbuddy/api/data';
import {claim,finish,promoteWordArtifact,fenceRestoredExecutionEpoch,resumeRestoredRun} from '@bondbuddy/api/queue';
import {savePromptSnapshot} from '@bondbuddy/api/log-ops';
import {grantCredits,reserveCreditLots} from '../../api/dist/billing.js';
import {inputManifestHash} from '@bondbuddy/api/production-rule-pin';
import {assertGateOpen,gateState,tripEvidenceGate,resumeEvidenceGate,resetProcessGateForTests,restoreCanonical,restoreBillingSnapshot,resumeDatabaseRestoreGate} from '@bondbuddy/api/evidence-gate';
import {executionCapacityControl,configureExecutionCapacity,bindExecutionRegistration,heartbeatExecutionRuntime} from '@bondbuddy/api/execution-capacity';
import {CodexDurableJournal} from './durable-probe-journal.js';
import {runContainedModelCall,DEFAULT_DISABLED_FEATURES,type CodexAdapterConfig} from './codex-adapter.js';
import {assertManagedDatabasePrivileges} from './managed-database-preflight.js';
import {enrollExecutionNodeFromEnv} from './execution-node-runtime.js';
import {makeWorkerDocxFixture} from './docx-test-fixture.js';
import {isolatedTestDatabase} from './test-database.js';

const connection=await isolatedTestDatabase(undefined,'managed-database-permissions');
const ident=(s:string)=>'"'+s.replaceAll('"','""')+'"';
const hash='a'.repeat(64),registration='synthetic-registration-token-0123456789';

test('captured consumer ACL supports real admission, result persistence and terminal paths',
 {skip:!connection,timeout:90000},async t=>{
  const admin=new Pool({connectionString:connection});
  const role='synthetic_acl_'+randomUUID().replaceAll('-',''),password=randomUUID();
  await admin.query(`CREATE ROLE ${ident(role)} LOGIN PASSWORD '${password}'`);
  const acl=JSON.parse(await readFile(new URL('../src/fixtures/managed-runtime-acl.json',import.meta.url),'utf8'));
  for(const table of acl.tables){
    for(const privilege of table.privileges)await admin.query(`GRANT ${privilege} ON public.${ident(table.name)} TO ${ident(role)}`);
    for(const [privilege,columns] of Object.entries(table.columns) as [string,string[]][])
      await admin.query(`GRANT ${privilege}(${columns.map(ident).join(',')}) ON public.${ident(table.name)} TO ${ident(role)}`);
  }
  const apply=async(name:string)=>{
    const sql=await readFile(new URL('../../../deploy/m1/security/'+name,import.meta.url),'utf8');
    await admin.query(sql.replaceAll(':"runtime_role"',ident(role)));
  };
  await apply('managed-model-activity-grants.sql');
  await apply('managed-capacity-settlement-grants.sql');
  const url=new URL(connection!);url.username=role;url.password=password;
  const worker=new Pool({connectionString:url.toString()}),peer=new Pool({connectionString:url.toString()});
  const scratch=await mkdtemp(join(tmpdir(),'bb-managed-acl-'));
  t.after(async()=>{
    resetProcessGateForTests();
    await worker.end();await peer.end();
    await admin.query(`DROP OWNED BY ${ident(role)}`);await admin.query(`DROP ROLE ${ident(role)}`);await admin.end();
    await rm(scratch,{recursive:true,force:true});
  });
  await t.test('existing two-item fix still reproduces both remaining permission gaps',async()=>{
    await assert.rejects(assertManagedDatabasePrivileges(worker),(error:unknown)=>{
      assert.ok(error instanceof Error);
      const missing=error.message.replace('MANAGED_DATABASE_PRIVILEGES_MISSING:','').split(',');
      for(const check of ['evidence_gate_lock','file_check_attempts','refund_slice_insert','refund_unit_insert','authoring_scope_reservation_insert'])assert.ok(missing.includes(check),check);
      return true;
    });
    await assert.rejects(transaction(worker,c=>c.query('LOCK TABLE public.bb_evidence_gate_events IN SHARE MODE')),{code:'42501'});
    await assert.rejects(worker.query('SELECT 1 FROM public.bb_project_file_check_attempts'),{code:'42501'});
    await assert.rejects(worker.query('SELECT public.bb_lock_evidence_gate(false)'),{code:'42501'});
  });
  await apply('managed-execution-prerequisites.sql');
  await t.test('explicit delta is repeatable and grants no audit mutation or table-wide update',async()=>{
    await apply('managed-execution-prerequisites.sql');
    await assertManagedDatabasePrivileges(worker);
    await worker.query('SELECT 1 FROM public.bb_project_file_check_attempts');
    const row=(await admin.query(`SELECT
      has_table_privilege($1,'bb_evidence_gate_events','UPDATE,DELETE,TRUNCATE') AS gate_write,
      has_table_privilege($1,'bb_credit_reservations','UPDATE') AS wallet_write,
      has_table_privilege($1,'bb_error_recovery_events','INSERT') AS audit_write`,[role])).rows[0];
    assert.deepEqual(row,{gate_write:false,wallet_write:false,audit_write:false});
    await assert.rejects(worker.query("UPDATE public.bb_evidence_gate_events SET state='open'"),{code:'42501'});
    await assert.rejects(worker.query('TRUNCATE public.bb_evidence_gate_events'),{code:'42501'});
    await assert.rejects(worker.query('SELECT public.bb_lock_evidence_gate(NULL)'),{code:'22004'});
  });
  await t.test('preflight checks alert and performance read and every required write column',async()=>{
    for(const [table,read,insert,update] of [
      ['bb_ops_alerts','ops_alert_read','ops_alert_write',null],
      ['bb_performance_sessions','performance_session_read','performance_session_insert','performance_session_update'],
      ['bb_performance_spans','performance_span_read','performance_span_insert','performance_span_update'],
    ] as const){
      const captured=acl.tables.find((item:{name:string})=>item.name===table);
      assert.ok(captured,table);
      for(const [privilege,columns,missing] of [
        ['SELECT',[null],read],
        ['INSERT',captured.columns.INSERT,insert],
        ...(update?[['UPDATE',captured.columns.UPDATE,update]]:[]),
      ] as [string,(string|null)[],string][]){
        for(const column of columns){
          const grant=privilege+(column?'('+ident(column)+')':'');
          await admin.query(`REVOKE ${grant} ON public.${ident(table)} FROM ${ident(role)}`);
          try{
            await assert.rejects(assertManagedDatabasePrivileges(worker),
              new RegExp('MANAGED_DATABASE_PRIVILEGES_MISSING:'+missing+'$'),table+'.'+String(column));
          }finally{
            await admin.query(`GRANT ${grant} ON public.${ident(table)} TO ${ident(role)}`);
          }
          await assertManagedDatabasePrivileges(worker);
        }
      }
      assert.equal((await admin.query("SELECT has_table_privilege($1,$2,'INSERT,UPDATE,DELETE,TRUNCATE') AS broad",
        [role,'public.'+table])).rows[0].broad,false,table);
    }
  });
  await t.test('reservation trigger checks every identity insert column without scope mutation grants',async()=>{
    for(const column of ['owner_user_id','scope_quote_id','reservation_id']){
      await admin.query(`REVOKE INSERT(${ident(column)}) ON public.bb_authoring_scope_reservations FROM ${ident(role)}`);
      await assert.rejects(assertManagedDatabasePrivileges(worker),
        /MANAGED_DATABASE_PRIVILEGES_MISSING:authoring_scope_reservation_insert$/);
      await apply('managed-execution-prerequisites.sql');
      await assertManagedDatabasePrivileges(worker);
    }
    assert.equal((await admin.query("SELECT has_table_privilege($1,'public.bb_authoring_scope_reservations','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS broad",[role])).rows[0].broad,false);
  });
  await t.test('preflight rejects a missing indirect workpaper mutex dependency before enrollment',async()=>{
    await admin.query(`REVOKE SELECT ON public.bb_workpaper_paid_check_items FROM ${ident(role)}`);
    await assert.rejects(assertManagedDatabasePrivileges(worker),
      /MANAGED_DATABASE_PRIVILEGES_MISSING:workpaper_paid_check_items$/);
    await apply('managed-execution-prerequisites.sql');
    await assertManagedDatabasePrivileges(worker);
    const rights=(await admin.query(`SELECT
      has_table_privilege($1,'public.bb_workpaper_paid_check_items','SELECT') AS read,
      has_table_privilege($1,'public.bb_workpaper_paid_check_items','INSERT,UPDATE,DELETE,TRUNCATE') AS mutate`,[role])).rows[0];
    assert.deepEqual(rights,{read:true,mutate:false});
    await admin.query(`REVOKE SELECT(purpose) ON public.bb_platform_principals FROM ${ident(role)}`);
    await assert.rejects(assertManagedDatabasePrivileges(worker),/MANAGED_DATABASE_PRIVILEGES_MISSING:platform_probe_owner$/);
    await apply('managed-execution-prerequisites.sql');
    const platform=(await admin.query(`SELECT has_table_privilege($1,'public.bb_platform_principals','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') AS broad,
      has_column_privilege($1,'public.bb_platform_principals','user_id','SELECT') AND has_column_privilege($1,'public.bb_platform_principals','purpose','SELECT') AS required`,[role])).rows[0];
    assert.deepEqual(platform,{broad:false,required:true});
    await admin.query(`REVOKE INSERT(manifest) ON public.bb_m4_executions FROM ${ident(role)}`);
    await admin.query(`REVOKE INSERT(charged_points) ON public.bb_credit_reservations FROM ${ident(role)}`);
    await assert.rejects(assertManagedDatabasePrivileges(worker),
      /MANAGED_DATABASE_PRIVILEGES_MISSING:reservation_charged_points_insert,workpaper_execution_insert$/);
    await apply('managed-execution-prerequisites.sql');
    assert.equal((await admin.query("SELECT has_table_privilege($1,'public.bb_m4_executions','INSERT,UPDATE,DELETE,TRUNCATE') AS broad",[role])).rows[0].broad,false);
  });
  await t.test('refund capture checks every required column and leaves refund approval unavailable',async()=>{
    await admin.query(`REVOKE INSERT(evidence) ON public.bb_task_refund_units FROM ${ident(role)}`);
    await admin.query(`REVOKE INSERT(points) ON public.bb_task_refund_unit_slices FROM ${ident(role)}`);
    await assert.rejects(assertManagedDatabasePrivileges(worker),
      /MANAGED_DATABASE_PRIVILEGES_MISSING:refund_slice_insert,refund_unit_insert$/);
    await apply('managed-execution-prerequisites.sql');
    await assertManagedDatabasePrivileges(worker);
    for(const table of ['bb_task_refund_units','bb_task_refund_unit_slices','bb_task_refund_requests','bb_task_refund_decisions','bb_task_refund_credits']){
      assert.equal((await admin.query('SELECT has_table_privilege($1,$2,$3) AS broad',[role,'public.'+table,'INSERT,UPDATE,DELETE,TRUNCATE'])).rows[0].broad,false,table);
    }
  });
  await t.test('acceptance evidence checks every insert column without granting refund authority',async()=>{
    for(const [table,columns,missing] of [
      ['bb_task_refund_units',['owner_user_id','reservation_id','item_id','run_id','ordinal','source_item_key','label','points','scope_quote_id','evidence_kind','evidence'],'refund_unit_insert'],
      ['bb_task_refund_unit_slices',['reservation_id','item_id','origin_lot_id','points'],'refund_slice_insert']
    ] as const){
      for(const column of columns){
        await admin.query(`REVOKE INSERT(${ident(column)}) ON public.${ident(table)} FROM ${ident(role)}`);
        await assert.rejects(assertManagedDatabasePrivileges(worker),new RegExp('MANAGED_DATABASE_PRIVILEGES_MISSING:'+missing+'$'));
        await apply('managed-execution-prerequisites.sql');
      }
      assert.equal((await admin.query("SELECT has_table_privilege($1,$2,'INSERT,UPDATE,DELETE,TRUNCATE') broad",[role,table])).rows[0].broad,false);
    }
    assert.equal((await admin.query("SELECT has_column_privilege($1,'bb_task_refund_units','created_at','INSERT') AS insert",[role])).rows[0].insert,false);
    for(const table of ['bb_task_refund_requests','bb_task_refund_decisions','bb_task_refund_returned_items','bb_task_refund_credits']){
      assert.equal((await admin.query("SELECT has_any_column_privilege($1,$2,'INSERT,UPDATE') OR has_table_privilege($1,$2,'DELETE,TRUNCATE') AS mutate",[role,table])).rows[0].mutate,false);
    }
    await assertManagedDatabasePrivileges(worker);
  });
  await t.test('preflight detects missing individual activity and settlement column grants',async()=>{
    await admin.query(`REVOKE INSERT(lease_token) ON public.bb_run_model_activity FROM ${ident(role)}`);
    await admin.query(`REVOKE UPDATE(updated_at) ON public.bb_run_model_activity FROM ${ident(role)}`);
    await admin.query(`REVOKE UPDATE(finalized_at) ON public.bb_credit_reservations FROM ${ident(role)}`);
    await assert.rejects(assertManagedDatabasePrivileges(worker),
      /MANAGED_DATABASE_PRIVILEGES_MISSING:model_activity_insert,model_activity_update,reservation_finalized_at$/);
    await apply('managed-execution-prerequisites.sql');
  });
  await t.test('new lock keeps legacy lock serialization and ignores caller search_path',async()=>{
    const first=await worker.connect(),second=await peer.connect();
    try{
      await first.query('BEGIN');
      await first.query('CREATE TEMP TABLE bb_evidence_gate_events(id text)');
      await first.query('SET LOCAL search_path=pg_temp');
      await first.query('SELECT public.bb_lock_evidence_gate(false)');
      await second.query('BEGIN');await second.query("SET LOCAL lock_timeout='100ms'");
      await second.query('SELECT public.bb_lock_evidence_gate(false)');
      await assert.rejects(second.query('SELECT public.bb_lock_evidence_gate(true)'),{code:'55P03'});
      await second.query('ROLLBACK');
      const old=await admin.connect();
      try{
        await old.query('BEGIN');await old.query("SET LOCAL lock_timeout='100ms'");
        await assert.rejects(old.query('LOCK TABLE public.bb_evidence_gate_events IN SHARE ROW EXCLUSIVE MODE'),{code:'55P03'});
      }finally{await old.query('ROLLBACK');old.release();}
    }finally{await first.query('ROLLBACK');await second.query('ROLLBACK');first.release();second.release();}
  });
  await t.test('restricted consumer can persist a real evidence outage, block calls and recover',async()=>{
    await tripEvidenceGate(worker,'synthetic_outage');
    assert.equal((await gateState(worker)).state,'paused');
    await assert.rejects(transaction(worker,c=>assertGateOpen(c)),{code:'DATA_UNAVAILABLE'});
    await resumeEvidenceGate(admin,'synthetic-operator','synthetic_recovered');
    await transaction(worker,c=>assertGateOpen(c));
  });

  const control=executionCapacityControl(admin),identity={account_id:'synthetic',region:'synthetic',instance_id:'synthetic-acl-node',epoch:randomUUID()};
  await configureExecutionCapacity(admin,0,{managed_nodes:true,global_model_limit:4,max_nodes:2,budget_available:true});
  let op=await control.reserveStart({...identity,instance_id:null,instance_count:1,source_sha256:hash,image_sha256:hash,launch_manifest_sha256:hash,
    capabilities:['authoring'],services:[{service_id:'author',capabilities:['authoring']}]},randomUUID(),(await control.snapshot()).policy.revision);
  op=await control.claimCloudDispatch(op.operation_id,op.revision);const ack=randomUUID();
  op=await control.recordCloudResult(op.operation_id,op.revision,{state:'submitted',identity,provider_request_id:ack,observation:null,
    run_acceptance:{operation_id:op.operation_id,identity,provider_request_id:ack,instance_ids:[identity.instance_id],client_token:op.client_token,launch_manifest_sha256:hash,launch_binding_sha256:hash,evidence_ref:'synthetic',evidence_sha256:hash}});
  await control.recordCloudResult(op.operation_id,op.revision,{state:'completed',identity,provider_request_id:ack,observation:{
    instance_state:'RUNNING',latest_operation:'RunInstances',latest_operation_state:'SUCCESS',latest_operation_request_id:ack,stop_charging_mode:null,observed_at:new Date().toISOString(),evidence_ref:'synthetic',evidence_sha256:hash,
    run_creation:{operation_id:op.operation_id,identity,launch_manifest_sha256:hash,launch_binding_sha256:hash,created_at:new Date().toISOString(),instance_status:'RUNNING',status_request_id:'synthetic'}}});
  await bindExecutionRegistration(admin,identity,op.operation_id,registration);
  await t.test('startup refuses enrollment before registration if the runtime identity lacks a prerequisite',async()=>{
    const path=join(scratch,'enrollment.json');
    await writeFile(path,JSON.stringify({context:{identity,session_id:randomUUID()},service_id:'author',source_sha256:hash,image_sha256:hash,launch_manifest_sha256:hash,registration_token:registration}),{mode:0o600});
    const options={kinds:['run'],parseSlots:0,runKinds:['generation']};
    await admin.query(`REVOKE EXECUTE ON FUNCTION public.bb_lock_evidence_gate(boolean) FROM ${ident(role)}`);
    await assert.rejects(enrollExecutionNodeFromEnv(worker,options,{BB_EXECUTION_ENROLLMENT_FILE:path}),
      /MANAGED_DATABASE_PRIVILEGES_MISSING:evidence_gate_lock$/);
    assert.equal((await admin.query('SELECT count(*)::int n FROM bb_execution_node_sessions')).rows[0].n,0);
    await apply('managed-execution-prerequisites.sql');
    assert.equal((await enrollExecutionNodeFromEnv(worker,options,{BB_EXECUTION_ENROLLMENT_FILE:path}))?.service_id,'author');
  });
  await heartbeatExecutionRuntime(worker,{native_processes:0,unpersisted_results:0,ready:true});
  const owner=randomUUID();await admin.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'acl_'+owner.slice(0,8)]);
  const objects=new Map<string,Buffer>();
  const blobs:PrivateBlobs={put:async(k,b)=>{objects.set(k,Buffer.from(b));},get:async k=>objects.get(k)!,getIfExists:async k=>objects.get(k)??null,
    getIfExistsBounded:async(k,n)=>{const b=objects.get(k);return b&&b.length<=n?b:null;},exists:async k=>objects.has(k),delete:async k=>{objects.delete(k);}};
  const add=async()=>{
    const id=randomUUID(),manifest={synthetic:true},h=inputManifestHash(manifest);
    await admin.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic ACL','generation')",[id,owner]);
    await admin.query("INSERT INTO bb_input_revisions(project_id,owner_user_id,revision,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,$2,1,1,$3,$4,'[]','[]')",[id,owner,h,manifest]);
    await admin.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$1,1,$3,$1,'generation',$3,'queued')",[id,owner,h]);
    await admin.query("INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state) VALUES($1,$2,$1,'generation','default','queued')",[id,owner]);
    const lease=await claim(worker,120,{runKinds:['generation']});assert.equal(lease?.runId,id);return lease!;
  };
  await t.test('actual native adapter acquires a slot, records intent, saves and reuses a result',async()=>{
    const lease=await add(),reply={answer:'Synthetic permission regression'};
    const fake=join(scratch,'supplier.mjs'),marker=join(scratch,'sent');
    await writeFile(fake,`import{appendFileSync}from'node:fs';for await(const c of process.stdin){};appendFileSync(process.argv[2],'sent\\n');const out=v=>console.log(JSON.stringify(v));out({type:'thread.started',thread_id:'synthetic-thread'});out({type:'turn.started'});out({type:'item.completed',item:{id:'reply',type:'agent_message',text:process.argv[3]}});out({type:'turn.completed',usage:{input_tokens:83,cached_input_tokens:41,output_tokens:17,reasoning_output_tokens:3}});`);
    const config:CodexAdapterConfig={command:[process.execPath,fake,marker,JSON.stringify(reply)],model_id:'deepseek-flash',model_provider:'deepseek',base_url:'https://api.deepseek.com',wire_api:'responses',model_config_version:'synthetic-acl',reasoning_effort:null,credential:{kind:'env',name:'BB_ACL_SYNTHETIC_KEY'},work_root:join(scratch,'model'),timeout_ms:5000,kill_grace_ms:100,max_output_bytes:1048576,max_schema_reasks:0,disabled_features:DEFAULT_DISABLED_FEATURES,path_env:process.env.PATH!};
    process.env.BB_ACL_SYNTHETIC_KEY='synthetic-no-provider';
    const snapshot=await savePromptSnapshot(worker,blobs,{owner,projectId:lease.runId,runId:lease.runId,kind:'model_request',version:1,body:'Synthetic ACL',inputRevision:1,inputHash:inputManifestHash({synthetic:true}),templateVersion:'synthetic-v1'});
    const validate=(v:unknown)=>typeof v==='object'&&v!==null&&(v as typeof reply).answer===reply.answer;
    const journal=new CodexDurableJournal({pool:worker,blobs,lease,validateResult:validate});
    const call={owner_user_id:owner,project_id:lease.runId,job_id:lease.jobId,run_id:lease.runId,trace_id:lease.runId,logical_call_id:'synthetic-acl',prompt_snapshot_ref:snapshot,prompt:'Synthetic ACL',result_schema_version:'synthetic-v1',
      output:{kind:'json' as const,schema:{type:'object',properties:{answer:{type:'string'}},required:['answer'],additionalProperties:false},validate}};
    assert.equal((await runContainedModelCall(call,journal,config)).status,'completed');
    assert.equal((await runContainedModelCall(call,journal,config)).status,'reused');
    assert.equal(await readFile(marker,'utf8'),'sent\n');
    assert.equal((await admin.query('SELECT count(*)::int n FROM bb_provider_result_refs WHERE job_id=$1',[lease.jobId])).rows[0].n,1);
    const artifact=await promoteWordArtifact(worker,lease,makeWorkerDocxFixture({externalLink:false}),blobs,'generated_pair_v1');
    assert.equal(artifact.status,'available');
    if(artifact.status!=='available')throw Error('Synthetic artifact unavailable');
    assert.equal((await finish(worker,lease,'succeeded',{artifactId:artifact.artifactId,artifactVersion:artifact.artifactVersion,blobs})).state,'succeeded');
    assert.equal((await admin.query('SELECT count(*)::int n FROM bb_model_capacity_holders')).rows[0].n,0);
  });
  await t.test('failed task persists its terminal state with the same restricted identity',async()=>{
    const lease=await add();
    const reservation=randomUUID(),quote=randomUUID(),version=randomUUID();
    await transaction(admin,async c=>{
      await grantCredits(c,{owner,source:'existing_grant',key:randomUUID(),points:100,expiresAt:null,actor:'synthetic',reason:'Synthetic terminal settlement'});
      await c.query("INSERT INTO bb_credit_price_versions(id,prices,effective_at,actor,reason) VALUES($1,'{}',clock_timestamp(),'synthetic','Synthetic terminal settlement')",[version]);
      await c.query("INSERT INTO bb_credit_quotes(id,owner_user_id,project_id,input_revision,input_hash,price_version,task_type,points,reason) VALUES($1,$2,$3,1,$4,$5,'annual',60,'Synthetic terminal settlement')",[quote,owner,lease.runId,inputManifestHash({synthetic:true}),version]);
    });
    // These are the real on-delivery allocations. Their deferred trigger must
    // commit as the restricted consumer, not as the administrative fixture.
    const accept=()=>transaction(worker,async c=>{
      await c.query("INSERT INTO bb_credit_reservations(id,owner_user_id,run_id,quote_id,points,billing_policy) VALUES($1,$2,$3,$4,60,'on_delivery')",[reservation,owner,lease.runId,quote]);
      await reserveCreditLots(c,owner,reservation,60n);
    });
    await admin.query(`REVOKE INSERT(evidence) ON public.bb_task_refund_units FROM ${ident(role)}`);
    await assert.rejects(accept(),{code:'42501'},'deferred capture rejects COMMIT without its precise grant');
    assert.equal((await admin.query('SELECT count(*)::int n FROM bb_credit_reservations WHERE id=$1',[reservation])).rows[0].n,0,'failed COMMIT rolls back the reservation');
    assert.equal((await admin.query('SELECT sum(frozen)::int n FROM bb_credit_lots WHERE owner_user_id=$1',[owner])).rows[0].n,0,'failed COMMIT rolls back frozen points');
    await apply('managed-execution-prerequisites.sql');
    await accept();
    assert.equal((await admin.query('SELECT count(*)::int n FROM bb_task_refund_units WHERE reservation_id=$1',[reservation])).rows[0].n,1);
    assert.equal((await admin.query('SELECT sum(points)::int n FROM bb_task_refund_unit_slices WHERE reservation_id=$1',[reservation])).rows[0].n,60);
    await admin.query("UPDATE bb_runs SET billing_mode='fixed_credits',reservation_id=$2 WHERE id=$1",[lease.runId,reservation]);
    assert.equal((await finish(worker,lease,'failed',{errorCode:'DATA_UNAVAILABLE'})).state,'failed');
    const final=(await admin.query("SELECT state,finalized_at IS NOT NULL AS finalized FROM bb_credit_reservations WHERE id=$1",[reservation])).rows[0];
    assert.deepEqual(final,{state:'released',finalized:true});
    assert.equal((await admin.query("SELECT count(*)::int n FROM bb_credit_events WHERE reservation_id=$1 AND kind='release'",[reservation])).rows[0].n,1);
  });
  await t.test('ordinary consumer cannot invoke dedicated restore control or mutate its receipts',async()=>{
    const live=await add(),restoreOwner=randomUUID(),id=randomUUID(),quarantineId=randomUUID(),controlEpoch=randomUUID(),manifest={synthetic:true},inputHash=inputManifestHash(manifest);
    await admin.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[restoreOwner,'acl_restore_'+restoreOwner.slice(0,8)]);
    await transaction(admin,c=>grantCredits(c,{owner:restoreOwner,source:'existing_grant',key:randomUUID(),points:42,expiresAt:null,actor:'synthetic',reason:'Synthetic restore ACL billing invariant'}));
    await admin.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic restore ACL','generation')",[id,restoreOwner]);
    await admin.query("INSERT INTO bb_input_revisions(project_id,owner_user_id,revision,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,$2,1,1,$3,$4,'[]','[]')",[id,restoreOwner,inputHash,manifest]);
    await admin.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage) VALUES($1,$2,$1,1,$3,$1,'generation',$3,'paused','database_restore_quarantine')",[id,restoreOwner,inputHash]);
    await admin.query("INSERT INTO bb_jobs(id,owner_user_id,run_id,job_type,subtype,state,stage,checkpoint) VALUES($1,$2,$1,'generation','default','paused','database_restore_quarantine',$3)",[id,restoreOwner,{never_admitted_v1:{version:'never-admitted-v1',job_id:id}}]);
    const original=(await admin.query('SELECT row_to_json(j) AS record FROM bb_jobs j WHERE id=$1',[id])).rows[0].record;
    const body={version:'database-restore-safety-v1',restore_id:quarantineId,backup_sha256:hash,control_epoch:controlEpoch,audit:{complete:true,backup_at:new Date().toISOString(),covered_until:new Date().toISOString()},account_ids:[restoreOwner],fences:[],calls:[],billing:[{owner_user_id:restoreOwner,sha256:digest(restoreCanonical(await restoreBillingSnapshot(admin,restoreOwner))),consistent:true}],never_sent_runs:[id]};
    const manifestSha=digest(restoreCanonical(body)),gateId=randomUUID();
    await admin.query("INSERT INTO bb_evidence_gate_events(id,state,reason_code,actor_type) VALUES($1,'paused','database_restore_quarantine','system')",[gateId]);
    await admin.query('INSERT INTO bb_database_restore_quarantines(id,backup_sha256,manifest_sha256,control_epoch,receipt,preimage,gate_event_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[quarantineId,hash,manifestSha,controlEpoch,{...body,manifest_sha256:manifestSha},{nodes:[],jobs:[original],holders:[],messages:[],waiters:[]},gateId]);
    await admin.query("UPDATE bb_jobs SET checkpoint=checkpoint||jsonb_build_object('database_restore_quarantine',$2::jsonb) WHERE id=$1",[id,{restore_id:quarantineId,manifest_sha256:manifestSha,job_id:id,run_id:id,owner_user_id:restoreOwner}]);
    await resumeDatabaseRestoreGate(admin,'synthetic-restore-operator',{quarantine_id:quarantineId,manifest_sha256:manifestSha,owner_user_ids:[restoreOwner]},async()=>{throw Error('Never-admitted restore cannot read provider evidence');});
    const snapshot=async()=>({jobs:(await admin.query(`SELECT j.id,j.state,j.lease_token,j.attempts,j.checkpoint,r.state AS run_state,r.stage AS run_stage
      FROM bb_jobs j JOIN bb_runs r ON r.id=j.run_id WHERE j.id=ANY($1::text[]) ORDER BY j.id`,[[id,live.jobId]])).rows,billing:await restoreBillingSnapshot(admin,restoreOwner)});
    const before=await snapshot();assert.ok(before.jobs.some(row=>row.lease_token===live.token));
    for(const table of ['bb_database_restore_quarantines','bb_database_restore_reconciliations','bb_database_restore_fence_releases']){
      const rights=(await admin.query("SELECT has_any_column_privilege($1,$2,'INSERT,UPDATE') OR has_table_privilege($1,$2,'DELETE,TRUNCATE') AS mutate",[role,table])).rows[0];assert.equal(rights.mutate,false,table);
      await assert.rejects(worker.query(`INSERT INTO public.${ident(table)}(id) VALUES($1)`,[randomUUID()]),{code:'42501'});
    }
    await assert.rejects(resumeRestoredRun(worker,'synthetic-consumer',restoreOwner,id,{quarantineId,manifestSha256:manifestSha},{blobs}),/Restore control privileges are required/);
    await assert.rejects(fenceRestoredExecutionEpoch(worker,'synthetic-consumer',{quarantineId,manifestSha256:manifestSha,nodeId:randomUUID(),epoch:randomUUID(),expectedTokens:[{kind:'job',id:live.jobId,token:live.token}],evidenceRef:'synthetic-rejected-fence'},{readObject:async()=>{throw Error('Unauthorized restore must not read evidence');}}),/Restore control privileges are required/);
    assert.deepEqual(await snapshot(),before,'refused restore control must retain original jobs, tokens and money');
    assert.equal(await resumeRestoredRun(admin,'synthetic-restore-operator',restoreOwner,id,{quarantineId,manifestSha256:manifestSha},{blobs}),true,'the same valid receipt remains usable by the operator');
    assert.deepEqual(await restoreBillingSnapshot(admin,restoreOwner),before.billing);
    assert.equal((await admin.query('SELECT lease_token FROM bb_jobs WHERE id=$1',[live.jobId])).rows[0].lease_token,live.token);
    await admin.query("UPDATE bb_jobs SET state='cancelled' WHERE id=$1",[id]);await admin.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1",[id]);
    await finish(worker,live,'failed',{errorCode:'DATA_UNAVAILABLE'});
  });
});
