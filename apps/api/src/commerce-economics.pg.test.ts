import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {emptyUpdateDetails} from '@bondbuddy/contracts';
import {isolatedTestDatabase} from './test-database.js';
import {inputManifestHash} from './production-rule-pin.js';
import {transaction} from './data.js';
import {quoteCredits,reserveCredits,grantCredits} from './billing.js';
import {publishScopeQuote} from './scope-quotations.js';
import {EXPENSE_CATEGORIES,recordExpenseEvidence,readRunEconomics,reviewRunCosts} from './commerce-economics.js';

const database=await isolatedTestDatabase(undefined,'commerce-economics');
test('synthetic cost evidence is immutable/idempotent; missing and late costs block a complete margin claim',{skip:!database,timeout:60000},async()=>{
 const pool=new Pool({connectionString:database});
 try{
  const owner=randomUUID(),project=randomUUID(),run=randomUUID();
  await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'synthetic_cost_'+owner.slice(0,8)]);
  await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic cost evidence','generation')",[project,owner]);
  const manifest={draft_revision:1,issuer_name:'Synthetic issuer',market:'sse',offering:'private',materials:[],update_details:{...emptyUpdateDetails(),reporting_cutoff:'2026-09-30'},authoring:{version:'unified_v1',source_prospectuses:[],requirements:[],knowledge:[],knowledge_status:'authoring_reference_not_compliance_approval'}};
  const hash=inputManifestHash(manifest);
  await pool.query("INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,1,$2,1,$3,$4,'[]','[]')",[project,owner,hash,manifest]);
  await pool.query('UPDATE bb_projects SET latest_input_revision=1 WHERE id=$1',[project]);
  await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,1,$4,$1,'generation',$4,'queued')",[run,owner,project,hash]);
  await assert.rejects(readRunEconomics(pool,run),e=>(e as any).code==='VALIDATION_FAILED','unpriced legacy/trial runs cannot be reinterpreted as cash');
  const pending=await quoteCredits(pool,owner,project,1,hash,true);
  await publishScopeQuote(pool,{id:pending.quote.scope_quote_id!,expected_input_hash:hash,lines:[{key:'synthetic-scope',label:'Synthetic work scope',quantity:1,unit:'scope',unit_price_fen:12300,amount_fen:12300,evidence:['synthetic:'+hash]}],actor:'synthetic-reviewer',reason:'Synthetic only'});
  const quote=(await quoteCredits(pool,owner,project,1,hash,true)).quote;
  await transaction(pool,async c=>{
   await grantCredits(c,{owner,source:'purchase',key:'synthetic-funding',points:12300,expiresAt:null,actor:'synthetic',reason:'Synthetic only'});
   const r=(await c.query('SELECT * FROM bb_runs WHERE id=$1',[run])).rows[0],p=(await c.query('SELECT * FROM bb_projects WHERE id=$1',[project])).rows[0];
   await reserveCredits(c,owner,r,quote.quote_id,{revision:1,manifest},p,undefined,true);
  });
  await pool.query("UPDATE bb_runs SET state='failed' WHERE id=$1",[run]);
  let report=await readRunEconomics(pool,run);assert.equal(report.cost_complete,false);assert.equal(report.delivered_service_charge_fen,0);
  const evidence=(category:typeof EXPENSE_CATEGORIES[number],i:number)=>({run_id:run,event_key:'cost-'+i,category,amount_fen:i===0?300:0,within_fixed_budget:false,incurred_at:'2026-10-28T00:00:00Z',source_ref:'synthetic://local-cost-proof',evidence_sha256:'a'.repeat(64),actor:'synthetic-cost-reviewer',reason:'Synthetic expense or explicit no incremental expense'});
  const first=evidence(EXPENSE_CATEGORIES[0],0),id=await recordExpenseEvidence(pool,first);
  assert.equal(await recordExpenseEvidence(pool,first),id);
  await assert.rejects(recordExpenseEvidence(pool,{...first,amount_fen:301}),e=>(e as any).code==='IDEMPOTENCY_CONFLICT');
  await assert.rejects(recordExpenseEvidence(pool,{...first,event_key:'negative',amount_fen:-1}),e=>(e as any).code==='VALIDATION_FAILED');
  await assert.rejects(pool.query('UPDATE bb_commerce_expense_evidence SET amount_fen=0 WHERE id=$1',[id]),e=>(e as any).code==='23514');
  for(let i=1;i<EXPENSE_CATEGORIES.length;i++)await recordExpenseEvidence(pool,evidence(EXPENSE_CATEGORIES[i],i));
  assert.equal(Number((await pool.query("SELECT count(*) n FROM bb_outbox WHERE owner_user_id=$1 AND event_type='commerce.cost_evidence_recorded'",[owner])).rows[0].n),6);
  report=await readRunEconomics(pool,run);
  const review={run_id:run,expected_snapshot_hash:report.snapshot_hash,model_required:false,actor:'synthetic-cost-reviewer',reason:'Failed before sending a model request; all incremental categories accounted',source_ref:'synthetic://local-cost-review'};
  await assert.rejects(reviewRunCosts(pool,{...review,model_required:true}),e=>(e as any).code==='VALIDATION_FAILED');
  const closed=await reviewRunCosts(pool,review);assert.equal(closed.cost_complete,true);assert.equal(closed.variable_cost_cny,3);assert.equal(closed.contribution_cny,-3);assert.equal(closed.after_tax_net_margin,null);
  assert.equal((await reviewRunCosts(pool,review)).cost_complete,true);
  await assert.rejects(reviewRunCosts(pool,{...review,reason:'different'}),e=>(e as any).code==='IDEMPOTENCY_CONFLICT');
  assert.equal(Number((await pool.query("SELECT count(*) n FROM bb_outbox WHERE owner_user_id=$1 AND event_type='commerce.cost_reviewed'",[owner])).rows[0].n),1);
  await recordExpenseEvidence(pool,{...evidence('support_extra',8),amount_fen:500});
  report=await readRunEconomics(pool,run);assert.equal(report.cost_complete,false);assert.equal(report.extra_cost_fen,800);assert.equal(report.variable_cost_cny,null);
  await assert.rejects(reviewRunCosts(pool,review),e=>(e as any).code==='INPUT_REVISION_CONFLICT');
 }finally{await pool.end();}
});
