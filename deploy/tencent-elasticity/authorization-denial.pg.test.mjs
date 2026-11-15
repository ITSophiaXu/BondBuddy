import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,writeFile,readFile,chmod,symlink,link,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Pool} from 'pg';
import {executionCapacityControl,configureExecutionCapacity,executionCloudClientToken,executionCloudExpenseLedger} from '@bondbuddy/api/execution-capacity';
import {canonical,sha256,planCapacity} from './policy.mjs';
import {observationArchive} from './private-files.mjs';
import {ExecutionPoolController} from './controller.mjs';
import {TencentTransport,TencentCvm,safeDenialDiagnostic} from './tencent-cvm.mjs';

const h='a'.repeat(64),account='100006372392',role='4611686018450406472';
const document={version:'2.0',statement:[{effect:'allow',action:['finance:trade'],resource:['qcs::cvm:::*']}]};
const messageHash='a5a18865ce9c1a95ae855ce4812ab77c6775bb7e21722a1830c908ca6640c20d';
const connection=process.env.BB1398_TEST_DATABASE_URL;

test('a bare authorization error stays unknown; no automatic terminal or redispatch',async()=>{
 let writes=0,calls=0;
 const op={operation_id:'synthetic-op',revision:0,action:'run',identity:null,request:{instance_count:1,account_id:account,region:'ap-beijing',source_sha256:h,image_sha256:h,services:[{service_id:'authoring',capabilities:['authoring']}]},state:'intent'};
 const config={failure_cooldown_seconds:60,pool_tag:'synthetic',role_names:['role-a','role-b'],node_secrets:[{role_name:'role-a',role_id:'1',secret_name:'synthetic-a'},{role_name:'role-b',role_id:'2',secret_name:'synthetic-b'}]};
 const controller=new ExecutionPoolController({config,cloud:{execute:async()=>{calls++;throw Object.assign(Error('synthetic'),{code:'UnauthorizedOperation'});},capacityRejection:async()=>null},
  control:{claimCloudDispatch:async()=>({...op,state:'unknown',revision:1}),recordCloudResult:async(_,__,r)=>r,finalizeRunAuthorizationDenial:async()=>{writes++;}}});
 const result=await controller.dispatch(op,{slot:0});assert.equal(result.state,'unknown');assert.equal(result.provider_request_id,null);assert.equal(writes,0);assert.equal(calls,1);
 await controller.dispatch({...op,state:'unknown'});assert.equal(calls,1);
});

test('contradictory error plus instance ACK is uncertain, not a no-creation denial',async()=>{
 const transport=new TencentTransport({region:'ap-beijing',credentials:async()=>({secretId:'synthetic',secretKey:'synthetic',token:'synthetic',expiresAt:Date.now()+120000}),
  fetchImpl:async()=>new Response(JSON.stringify({Response:{Error:{Code:'UnauthorizedOperation'},RequestId:'synthetic-ack',InstanceIdSet:['ins-synthetic']}}))});
 await assert.rejects(transport.call('cvm','RunInstances',{}),e=>e.message==='CLOUD_RESPONSE_UNCERTAIN'&&!e.code);
});

test('diagnostics retain request identifiers only, not arbitrary vendor text',()=>{
 const d=safeDenialDiagnostic('cvm','RunInstances',{ImageId:'img-good'},'secret credential qcs::cvm:ap-beijing:uin/100006372392:image/img-secret qcs::cvm:ap-beijing:uin/100006372392:image/img-good qcs:secret/123:cvm:ap-beijing:uin/100006372392:image/img-good qcs::cvm:other-region:uin/100006372392:image/img-good qcs::cvm:ap-beijing:uin/123:image/img-good',{accountId:account,region:'ap-beijing'});
 assert.deepEqual(d,{actions:['name/cvm:RunInstances'],resources:['qcs::cvm:ap-beijing:uin/100006372392:image/img-good']});
});

// Cloud/audit/policy fixtures are synthetic. All CAS, constraints, recovery and
// ledger reads below use a separate real PostgreSQL database, never a live pool.
test('payment denial: real PG evidence binding, persistent expansion fence and reviewed resume',{skip:!connection,timeout:60000},async t=>{
 const pool=new Pool({connectionString:connection,max:4});
 assert.equal((await pool.query('SELECT current_database() AS db')).rows[0].db,'bb1398_denial');
 const directory=await mkdtemp(join(tmpdir(),'bb1398-proof-'));
 t.after(async()=>{await pool.end();await rm(directory,{recursive:true});});
 const archive=observationArchive(directory);
 const save=async v=>{const r=await archive(typeof v==='string'?v:canonical(v));return {evidence_ref:r.ref,evidence_sha256:r.sha256};};
 async function fixture(){
  await pool.query('INSERT INTO bb_execution_capacity_policy(singleton) VALUES(true) ON CONFLICT DO NOTHING');
  await pool.query('UPDATE bb_execution_capacity_policy SET revision=0,managed_nodes=false,budget_available=true,launch_blocked_by_operation_id=NULL,launch_recovery_review=NULL,cooldown_until=NULL');
  await pool.query('DELETE FROM bb_execution_cloud_operations');
  await pool.query('TRUNCATE bb_execution_nodes CASCADE');
  await configureExecutionCapacity(pool,0,{managed_nodes:true,global_model_limit:4,max_nodes:2,budget_available:true,expense_policy_sha256:h});
  const id=randomUUID(),token=executionCloudClientToken(id),params={InstanceCount:1,ClientToken:token,TagSpecification:[{ResourceType:'instance',Tags:[{Key:'bondbuddy-create-op',Value:id}]}]};
  const request={account_id:account,region:'ap-beijing',instance_id:null,instance_count:1,epoch:randomUUID(),source_sha256:h,image_sha256:h,launch_manifest_sha256:sha256(canonical(params)),capabilities:['authoring'],services:[{service_id:'authoring',capabilities:['authoring']}]};
  const scope={directory,accountId:account,region:'ap-beijing',roleId:role,configurationSha256:h,paymentContractSha256:h};
  const control=executionCapacityControl(pool,scope),reserved=await control.reserveStart(request,id,1),op=await control.claimCloudDispatch(id,reserved.revision);
  const raw={service:'cvm',action:'RunInstances',instance_count:1,operation_id:id,client_token_sha256:sha256(token),code:'UnauthorizedOperation',request_id:randomUUID()};
  // Noncanonical whitespace proves that verification hashes ORIGINAL bytes.
  const evidence=await save(JSON.stringify(raw,null,2)+'\n');
  const audit={version:'payment-prerequisite-audit-attestation-v1',account_id:account,region:'ap-beijing',action:'run',cloud_action:'RunInstances',operation_id:id,provider_request_id:raw.request_id,client_token_sha256:raw.client_token_sha256,launch_manifest_sha256:request.launch_manifest_sha256,original_rejection_archive_sha256:evidence.evidence_sha256,classification:'payment_rights_prerequisite_rejected',
   cloud_audit:{lookup_api:'cloudaudit.LookUpEvents',lookup_request_id:randomUUID(),original_response_sha256:h,event_time_utc:op.dispatched_at,actor_type:'AssumedRole',actor_role_id:role,actor_assumer_uin:'123456',error_message_sha256:messageHash,instance_ids_returned:false},
   source_notes:{token_in_audit:'synthetic fixture',request_scalar_types:'synthetic fixture',remaining_request_values:'synthetic fixture'},official_prerequisite:{url:'https://cloud.tencent.com/document/product/555/61542',source_html_sha256:h,claim:'synthetic contract fixture'},derived_at_utc:op.dispatched_at};
  const payment_audit=await save(audit);scope.paymentAuditSha256=payment_audit.evidence_sha256;
  const input={evidence,payment_audit,launch_parameters:params};
  const finish=()=>control.finalizeRunAuthorizationDenial(id,op.revision,input);
  const correction={version:'execution-run-authorization-correction-v1',account_id:account,region:'ap-beijing',role_id:role,configuration_sha256:h,policy_id:7,policy_document:document,policy_document_sha256:sha256(canonical(document)),policy_readback_request_id:randomUUID(),attachment_readback_request_id:randomUUID(),previous_policy_ids:[1,2,3,4,5,6],attached_policy_ids:[1,2,3,4,5,6,7]};
  const review=async c=>{const correction_evidence=await save(c),r=await save({version:'execution-run-authorization-recovery-v1',operation_id:id,account_id:account,region:'ap-beijing',denial_evidence_sha256:evidence.evidence_sha256,correction_evidence,decision:'allow_new_operations'});scope.recoveryReviewSha256=r.evidence_sha256;scope.correctionEvidenceSha256=correction_evidence.evidence_sha256;return r;};
  return {id,op,request,params,scope,control,raw,audit,input,finish,correction,review};
 }
 await t.test('legacy original bytes + payment proof finalize concurrently once, no success ACK',async()=>{
  const f=await fixture(),before=await readFile(f.input.evidence.evidence_ref);
  const results=await Promise.all([f.finish(),f.finish()]);
  assert.ok(results.every(r=>r.state==='rejected'&&r.revision===f.op.revision+1&&!r.identity&&!r.provider_request_id));
  assert.equal((await f.control.snapshot()).policy.revision,2);
  assert.equal((await f.control.snapshot()).policy.launch_blocked_by_operation_id,f.id);
  assert.deepEqual(await readFile(f.input.evidence.evidence_ref),before);
  assert.equal((await executionCloudExpenseLedger(pool)).operations[0].authorization_denial.payment_audit.evidence_sha256,f.input.payment_audit.evidence_sha256);
  await assert.rejects(f.control.claimCloudDispatch(f.id,results[0].revision));
  const changed=await save({...f.raw,request_id:randomUUID()});await assert.rejects(f.control.finalizeRunAuthorizationDenial(f.id,f.op.revision,{...f.input,evidence:changed}));
 });
 await t.test('wrong archive binding and a bare code/hash cannot finalize',async()=>{
  const f=await fixture();
  for(const raw of [{...f.raw,code:'AuthFailure'},{...f.raw,operation_id:randomUUID()},{...f.raw,client_token_sha256:h},{...f.raw,action:'StopInstances'},{...f.raw,account_id:'wrong'}])
   await assert.rejects(f.control.finalizeRunAuthorizationDenial(f.id,f.op.revision,{...f.input,evidence:await save(raw)}));
  await assert.rejects(f.control.finalizeRunAuthorizationDenial(f.id,f.op.revision,{evidence:f.input.evidence,launch_parameters:f.params}));
  await assert.rejects(executionCapacityControl(pool).finalizeRunAuthorizationDenial(f.id,f.op.revision,f.input));
  await assert.rejects(f.control.finalizeRunAuthorizationDenial(f.id,f.op.revision,{...f.input,launch_parameters:{...f.params,ClientToken:'different'}}));
  assert.equal((await f.control.loadOperation(f.id)).state,'unknown');
 });
 await t.test('audit must be pinned and exactly match original request/account/role/manifest/time',async()=>{
  const f=await fixture();
  const bad=[{...f.audit,provider_request_id:randomUUID()},{...f.audit,account_id:'other'},{...f.audit,region:'other'},{...f.audit,launch_manifest_sha256:h},{...f.audit,cloud_audit:{...f.audit.cloud_audit,actor_role_id:'other'}},{...f.audit,cloud_audit:{...f.audit.cloud_audit,instance_ids_returned:true}},{...f.audit,cloud_audit:{...f.audit.cloud_audit,event_time_utc:'2000-01-01T00:00:00Z'}}];
  for(const a of bad){const payment_audit=await save(a);f.scope.paymentAuditSha256=payment_audit.evidence_sha256;await assert.rejects(f.control.finalizeRunAuthorizationDenial(f.id,f.op.revision,{...f.input,payment_audit}));}
  f.scope.paymentAuditSha256=h;await assert.rejects(f.finish());assert.equal((await f.control.loadOperation(f.id)).state,'unknown');
 });
 await t.test('trusted path, no-follow, exact hash, ownership modes and no hardlinks',async()=>{
  const f=await fixture();const file=f.input.evidence.evidence_ref,bytes=await readFile(file);
  await chmod(file,0o644);await assert.rejects(f.finish());await chmod(file,0o600);
  const linked=file+'.link';await link(file,linked);await assert.rejects(f.finish());await unlink(linked);
  await unlink(file);await symlink(f.input.payment_audit.evidence_ref,file);await assert.rejects(f.finish());await unlink(file);await writeFile(file,bytes,{mode:0o600});
  await writeFile(file,Buffer.concat([bytes,Buffer.from(' ')]));await assert.rejects(f.finish());await writeFile(file,bytes);
  await assert.rejects(f.control.finalizeRunAuthorizationDenial(f.id,f.op.revision,{...f.input,evidence:{evidence_ref:file+'.elsewhere',evidence_sha256:f.input.evidence.evidence_sha256}}));
 });
 await t.test('identity/ACK or stale revision cannot be converted to a denial',async()=>{
  const f=await fixture();await assert.rejects(f.control.finalizeRunAuthorizationDenial(f.id,f.op.revision+1,f.input));
  await pool.query('UPDATE bb_execution_cloud_operations SET provider_request_id=$2 WHERE operation_id=$1',[f.id,randomUUID()]);await assert.rejects(f.finish());
  await pool.query("UPDATE bb_execution_cloud_operations SET provider_request_id=NULL,instance_id='ins-synthetic' WHERE operation_id=$1",[f.id]);await assert.rejects(f.finish());
 });
 await t.test('bound v1 archive succeeds only with exact account/region/manifest',async()=>{
  const f=await fixture(),bound={...f.raw,version:'execution-run-denial-v1',account_id:account,region:'ap-beijing',launch_manifest_sha256:f.request.launch_manifest_sha256};
  const evidence=await save(bound),audit={...f.audit,original_rejection_archive_sha256:evidence.evidence_sha256},payment_audit=await save(audit);f.scope.paymentAuditSha256=payment_audit.evidence_sha256;
  const result=await f.control.finalizeRunAuthorizationDenial(f.id,f.op.revision,{...f.input,evidence,payment_audit});assert.equal(result.authorization_denial.archive_binding,'bound_v1');
 });
 await t.test('quote/budget refresh and generic configuration cannot clear expansion fence',async()=>{
  const f=await fixture();await f.finish();let p=(await f.control.snapshot()).policy;
  await f.control.setAdmissionBudget(p.revision,false,h);p=(await f.control.snapshot()).policy;await f.control.setAdmissionBudget(p.revision,true,h);p=(await f.control.snapshot()).policy;
  await configureExecutionCapacity(pool,p.revision,{managed_nodes:true,global_model_limit:4,max_nodes:2,budget_available:true,expense_policy_sha256:h});p=(await f.control.snapshot()).policy;
  await assert.rejects(f.control.reserveStart({...f.request,epoch:randomUUID()},randomUUID(),p.revision));
  const config={version:'tencent-execution-pool-v1',enabled:true,phase:'single_node_validation',account_id:account,pool_tag:'synthetic',region:'ap-beijing',zone:'ap-beijing-7',instance_type:'SA9.LARGE16',min_running:1,max_owned:2,global_model_limit:4,node_model_limit:4,compute_cny_per_hour:.8,compute_cap_cny_per_hour:1.6,scale_up_wait_seconds:60,idle_seconds:60,failure_cooldown_seconds:60};
  assert.equal(planCapacity(await f.control.snapshot(),[],config).reason,'authorization_denial');
 });
 await t.test('previously reserved Run/Start cannot dispatch under the persistent block; Stop can',async()=>{
  const f=await fixture();await f.finish();const revision=(await f.control.snapshot()).policy.revision;
  for(const action of ['run','start','stop']){
   const id=randomUUID();await pool.query("INSERT INTO bb_execution_cloud_operations(operation_id,account_id,region,epoch,action,state,request,request_sha256,client_token,policy_revision) VALUES($1,$2,'ap-beijing',$3,$4,'intent',$5,$6,$7,$8)",[id,account,randomUUID(),action,f.request,sha256(canonical(f.request)),executionCloudClientToken(id),revision]);
   if(action==='stop')assert.equal((await f.control.claimCloudDispatch(id,0)).state,'unknown');
   else{await assert.rejects(f.control.claimCloudDispatch(id,0));await assert.rejects(f.control.reauthorizeCloudIntent(id,0,revision));}
  }
 });
 await t.test('terminal original operation is immutable at the database boundary',async()=>{
  const f=await fixture();await f.finish();
  await assert.rejects(pool.query("UPDATE bb_execution_cloud_operations SET state='unknown',revision=revision+1 WHERE operation_id=$1",[f.id]),e=>e.code==='55000');
  await assert.rejects(pool.query("UPDATE bb_execution_cloud_operations SET run_acceptance='{}' WHERE operation_id=$1",[f.id]),e=>e.code==='55000');
 });
 await t.test('exact payment policy readback and explicit CAS resume; deny/unrelated/lost old policies fail',async()=>{
  const f=await fixture();await f.finish();const revision=(await f.control.snapshot()).policy.revision;
  for(const c of [{...f.correction,policy_document:{version:'2.0',statement:[{effect:'deny',action:['finance:trade'],resource:['qcs::cvm:::*']}]}},{...f.correction,policy_document:{version:'2.0',statement:[{effect:'allow',action:['cvm:DescribeInstances'],resource:['qcs::cvm:::*']}]}},{...f.correction,attached_policy_ids:[7]},{...f.correction,role_id:'other'},{...f.correction,configuration_sha256:'b'.repeat(64)}]){
   c.policy_document_sha256=sha256(canonical(c.policy_document));await assert.rejects(f.control.resumeRunAuthorization(f.id,revision,await f.review(c)));
  }
  const review=await f.review(f.correction);await assert.rejects(f.control.resumeRunAuthorization(f.id,revision+1,review));
  f.scope.recoveryReviewSha256=h;await assert.rejects(f.control.resumeRunAuthorization(f.id,revision,review));f.scope.recoveryReviewSha256=review.evidence_sha256;
  const results=await Promise.all([f.control.resumeRunAuthorization(f.id,revision,review),f.control.resumeRunAuthorization(f.id,revision,review)]);
  assert.ok(results.every(p=>p.launch_blocked_by_operation_id===null&&p.revision===revision+1));
  assert.equal((await f.control.loadOperation(f.id)).state,'rejected');
  const next=await f.control.reserveStart({...f.request,epoch:randomUUID()},randomUUID(),revision+1);assert.equal(next.state,'intent');
  assert.equal((await f.control.loadOperation(f.id)).client_token,f.op.client_token);
 });
});
