// Read-only alert decisions over real PostgreSQL; explicitly synthetic task state.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {Pool} from 'pg';
import {isolatedTestDatabase} from './test-database.js';
import {checkWorkflowOperationsHealth} from './workflow-operations-health.js';
const connection=await isolatedTestDatabase(undefined,'workflow-operations-health');
test('due scan and expired handoff alerts preserve task state, owner linkage and unknown no-send safety',{skip:!connection},async()=>{
 const pool=new Pool({connectionString:connection}),owner=randomUUID(),hash='a'.repeat(64),leases=new Map<string,string>();
 const add=async(kind:'due'|'future'|'legacy_due'|'handoff'|'live_handoff'|'ordinary'|'manual'|'unsupported'|'wrong_manual')=>{
  const id=randomUUID(),paused=['due','future','legacy_due','manual','unsupported','wrong_manual'].includes(kind),token=randomUUID();leases.set(id,token);
  const checkpoint=paused?{provider_reconcile_unknown:kind==='legacy_due'?null:{next_check_ms:Date.now()+(kind==='future'?600000:-600000),last_at:new Date(Date.now()-900000).toISOString()}}:
   {workflow_pending_disposition_v1:{kind:kind==='ordinary'?'pause':'handoff',stage:'postprocess',reason:'workflow_handoff'}};
  if(['manual','unsupported','wrong_manual'].includes(kind))Object.assign(checkpoint,{workflow_protocol:2});
  if(['manual','wrong_manual'].includes(kind))Object.assign(checkpoint,{provider_reconcile_manual:{disposition:'manual_required',reason_code:kind==='manual'?'workflow_protocol_unsupported':'unconfirmed_reason'},provider_reconcile_unknown:{next_check_ms:null}});
  await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic health','generation')",[id,owner]);
  await pool.query("INSERT INTO bb_input_revisions(project_id,owner_user_id,revision,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,$2,1,1,$3,'{}','[]','[]')",[id,owner,hash]);
  await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state,stage,updated_at) VALUES($1,$2,$1,1,$3,$1,'generation',$3,$4,$5,clock_timestamp()-interval '10 minutes')",[id,owner,hash,paused?'paused':'running',paused?'provider_reconcile':'stopping']);
  await pool.query("INSERT INTO bb_jobs(id,owner_user_id,project_id,run_id,job_type,subtype,state,stage,checkpoint,lease_token,lease_until,updated_at) VALUES($1,$2,$1,$1,'generation','default',$3,$4,$5,$6,CASE WHEN $6::text IS NULL THEN NULL WHEN $7 THEN clock_timestamp()+interval '10 minutes' ELSE clock_timestamp()-interval '1 minute' END,clock_timestamp()-interval '10 minutes')",[id,owner,paused?'paused':'running',paused?'provider_reconcile':'stopping',checkpoint,paused?null:token,kind==='live_handoff']);return id;
 };
 try{
  await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'synthetic_health_'+owner.slice(0,8)]);
  const due=await add('due'),legacy=await add('legacy_due'),unsupported=await add('unsupported'),wrongManual=await add('wrong_manual'),handoff=await add('handoff');await add('future');await add('live_handoff');await add('ordinary');await add('manual');
  const before=(await pool.query('SELECT row_to_json(j) value FROM bb_jobs j ORDER BY id')).rows;
  assert.deepEqual(await checkWorkflowOperationsHealth(pool,300),{due_scan_stale:4,handoff_stale:1});
  const alerts=(await pool.query("SELECT kind,detail FROM bb_ops_alerts WHERE kind IN ('provider_due_scan_stale','workflow_handoff_stale') ORDER BY kind,detail->>'job_id'")).rows;
  assert.equal(alerts.length,5);assert.deepEqual(new Set(alerts.filter(a=>a.kind==='provider_due_scan_stale').map(a=>a.detail.job_id)),new Set([due,legacy,unsupported,wrongManual]));
  const h=alerts.find(a=>a.kind==='workflow_handoff_stale');assert.equal(h.detail.job_id,handoff);assert.equal(h.detail.run_id,handoff);assert.equal(h.detail.owner_user_id,owner);
  assert.equal(h.detail.lease_token_sha256,createHash('sha256').update(leases.get(handoff)!).digest('hex'));assert.ok(!JSON.stringify(alerts).includes(leases.get(handoff)!));
  assert.deepEqual(await checkWorkflowOperationsHealth(pool,300),{due_scan_stale:4,handoff_stale:1});assert.equal((await pool.query("SELECT count(*)::int n FROM bb_ops_alerts WHERE kind IN ('provider_due_scan_stale','workflow_handoff_stale')")).rows[0].n,5,'dedupe survives repeated scheduler scans');
  assert.deepEqual((await pool.query('SELECT row_to_json(j) value FROM bb_jobs j ORDER BY id')).rows,before);assert.equal((await pool.query('SELECT count(*)::int n FROM bb_model_call_attempts')).rows[0].n,0);
 }finally{await pool.end();}
});
