// Real Fastify routes, PostgreSQL, queue leases and credit reservations; all source data is synthetic.
// No model, official-site query or customer account is used by this regression suite.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {Pool} from 'pg';
import {emptyUpdateDetails} from '@bondbuddy/contracts';
import {createServer} from './server.js';
import {transaction,type PrivateBlobs} from './data.js';
import {grantCredits,creditBalance} from './billing.js';
import {claim} from './queue.js';
import {isolatedTestDatabase} from './test-database.js';
import {uploadSyntheticReference} from './test-authoring-source.js';

const database=await isolatedTestDatabase(undefined,'integrity-concurrency');
const origin='http://bondbuddy.test';

async function fixture(){
 const pool=new Pool({connectionString:database}),owner=randomUUID(),foreign=randomUUID();let actor:string=owner;
 const files=new Map<string,Buffer>();
 const blobs:PrivateBlobs={put:async(k,b)=>{files.set(k,Buffer.from(b));},get:async k=>{const b=files.get(k);assert.ok(b);return b;},
  getIfExists:async k=>files.get(k)??null,getIfExistsBounded:async(k,n)=>{const b=files.get(k);assert.ok(!b||b.length<=n);return b??null;},
  exists:async k=>files.has(k),delete:async k=>{files.delete(k);}};
 const app=createServer({pool,blobs,allowedOrigin:origin,enableSyntheticQueue:true,paymentProviders:[],principal:async()=>({userId:actor,csrfVerified:true})});
 const send=(method:string,url:string,payload?:unknown)=>app.inject({method:method as any,url,payload:payload as any,headers:{origin}});
 const ok=async(method:string,url:string,payload?:unknown,status=200)=>{const r=await send(method,url,payload);assert.equal(r.statusCode,status,r.body);return r.json();};
 for(const id of [owner,foreign])await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[id,'synthetic_ic_'+id.slice(0,8)]);
 await transaction(pool,c=>grantCredits(c,{owner,source:'purchase',key:'synthetic-concurrency-funding',points:2000000,expiresAt:null,actor:'synthetic-test',reason:'Isolated concurrency regression; no payment'}));
 const authoring=async()=>{
  const p=await ok('POST','/api/v1/projects',{name:'Synthetic concurrent prospectus',kind:'update',issuer_name:'Synthetic issuer',market:'sse',offering:'private',
   update_details:{...emptyUpdateDetails(),authoring_mode:'unified_v1',reporting_cutoff:'2026-09-30'}},201);
  const freeze=await uploadSyntheticReference(app,p.project_id);
  const input=await ok('POST',`/api/v1/projects/${p.project_id}/input-revisions`,freeze,201);
  const quotation=await ok('POST',`/api/v1/projects/${p.project_id}/credit-quote`,{input_revision:input.input_revision,input_hash:input.input_hash});
  assert.equal(quotation.quote.quote_status,'ready');
  const request={execution_request_id:randomUUID(),project_id:p.project_id,input_revision:input.input_revision,input_hash:input.input_hash,
   task_kind:'update',input_manifest_ref:'synthetic-concurrency',storage_origin:'cloud',workspace_id:p.project_id,quote_id:quotation.quote.quote_id};
  return {id:p.project_id,input,freeze,quotation,request};
 };
 const integrity=async(project:string,save=true)=>{
  const base=`/api/v1/projects/${project}/integrity`;
  if(save)await ok('POST',base+'/draft',{expected_revision:0,draft:{subjects:[{id:'issuer',kind:'company',name:'Synthetic integrity issuer',identifier:'',role:'issuer',province:'',city:''}],site_ids:['tax'],notes:'Synthetic concurrency fixture'}});
  const round=randomUUID(),quote=await ok('POST',base+'/quote',{expected_revision:1,round_id:round});
  assert.equal(quote.quote_status,'ready');
  return {base,request:{request_id:randomUUID(),round_id:round,expected_revision:1,expected_points:quote.points,price_version:quote.price_version,scope_quote_id:quote.scope_quote_id}};
 };
 const snapshot=async(project:string)=>(await pool.query('SELECT revision,input_hash,manifest,material_versions FROM bb_input_revisions WHERE owner_user_id=$1 AND project_id=$2 ORDER BY revision',[owner,project])).rows;
 const latest=async(project:string)=>(await pool.query('SELECT latest_input_revision,draft_revision FROM bb_projects WHERE owner_user_id=$1 AND id=$2',[owner,project])).rows[0];
 const close=async()=>{await app.close();await pool.end();};
 return {pool,owner,foreign,app,send,ok,authoring,integrity,snapshot,latest,close,setActor:(id:string)=>{actor=id;}};
}

test('current paid routes allow both start orders and keep authoring input, quote and queued work intact',{skip:!database,timeout:120000},async()=>{
 const f=await fixture();
 try{
  for(const order of ['update-first','integrity-first']){
   const a=await f.authoring(),i=await f.integrity(a.id),before=await f.snapshot(a.id),pointer=await f.latest(a.id);
   let update:any,check:any;
   if(order==='update-first'){
    update=await f.ok('POST','/api/v1/runs/execute',a.request,202);
    const lease=await claim(f.pool,30,{runKinds:['update']});assert.equal(lease?.runId,update.run_id);
    check=await f.ok('POST',i.base+'/runs',i.request);
   }else{
    check=await f.ok('POST',i.base+'/runs',i.request);
    const lease=await claim(f.pool,30,{runKinds:['generation']});assert.equal(lease?.runId,check.run_id);
    update=await f.ok('POST','/api/v1/runs/execute',a.request,202);
   }
   assert.notEqual(update.run_id,check.run_id);
   const tasks=await f.ok('GET',`/api/v1/projects/${a.id}/tasks`);
   assert.equal(tasks.items.length,2,'both active workflows remain visible in the project task collection');
   assert.deepEqual(tasks.items.map((t:any)=>[t.run_id,t.kind,t.operation]).sort(),
    [[update.run_id,'update',null],[check.run_id,'generation','integrity_check']].sort());
   assert.ok(tasks.items.every((t:any)=>['queued','running'].includes(t.state)));
   assert.deepEqual(await f.latest(a.id),pointer,'integrity does not replace the authoring input pointer or draft version');
   assert.deepEqual((await f.snapshot(a.id))[0],before[0],'authoring snapshot remains byte-for-byte unchanged in JSON/hash/materials');
   const quoteAgain=await f.ok('POST',`/api/v1/projects/${a.id}/credit-quote`,{input_revision:a.input.input_revision,input_hash:a.input.input_hash});
   assert.equal(quoteAgain.quote.quote_id,a.quotation.quote.quote_id,'the prepared authoring quotation remains valid');
   assert.equal((await f.ok('POST','/api/v1/runs/execute',a.request,202)).run_id,update.run_id);
   const runs=(await f.pool.query('SELECT id,input_revision,task_kind,state FROM bb_runs WHERE project_id=$1 ORDER BY input_revision',[a.id])).rows;
   assert.equal(runs.length,2);assert.equal(runs[0].task_kind,'update');assert.equal(runs[1].task_kind,'generation');
   assert.ok(runs.every(r=>['queued','running'].includes(r.state)));
   assert.equal((await f.pool.query('SELECT count(*)::int n FROM bb_credit_reservations WHERE run_id=ANY($1::text[])',[[update.run_id,check.run_id]])).rows[0].n,2);
   // Free export is another integrity operation, and must also coexist with the active update.
   await f.pool.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1",[check.run_id]);
   const exported=await f.ok('POST',i.base+`/runs/${check.run_id}/exports`,{request_id:randomUUID(),expected_evidence_ids:[]});
   assert.equal((await f.pool.query('SELECT operation FROM bb_integrity_runs WHERE run_id=$1',[exported.run_id])).rows[0].operation,'export');
   assert.equal((await f.pool.query('SELECT count(*)::int n FROM bb_credit_reservations WHERE run_id=$1',[exported.run_id])).rows[0].n,0);
   assert.deepEqual(await f.latest(a.id),pointer);
   const next=await f.ok('POST',`/api/v1/projects/${a.id}/input-revisions`,a.freeze,201);
   assert.equal(next.input_revision,a.input.input_revision+3,'new authoring input skips both integrity snapshots without a primary-key collision');
   assert.equal((await f.snapshot(a.id)).length,4);
   assert.deepEqual((await f.snapshot(a.id))[0],before[0]);
   await f.pool.query("UPDATE bb_jobs SET state='cancelled',lease_token=NULL,lease_until=NULL WHERE run_id=ANY($1::text[])",[[update.run_id,check.run_id,exported.run_id]]);
   await f.pool.query("UPDATE bb_runs SET state='cancelled' WHERE id=ANY($1::text[])",[[update.run_id,exported.run_id]]);
  }
 }finally{await f.close();}
});

test('integrity replays reserve once, concurrent new rounds serialize, and ownership remains isolated',{skip:!database,timeout:120000},async()=>{
 const f=await fixture();
 try{
  const a=await f.authoring(),i=await f.integrity(a.id),before=await creditBalance(f.pool,f.owner);
  const replay=await Promise.all([f.send('POST',i.base+'/runs',i.request),f.send('POST',i.base+'/runs',i.request)]);
  replay.forEach(r=>assert.equal(r.statusCode,200,r.body));const run=replay[0].json().run_id;
  assert.equal(replay[1].json().run_id,run);
  const points=Number(i.request.expected_points);
  assert.deepEqual(await creditBalance(f.pool,f.owner),{available:before.available-points,frozen:points});
  const next=await f.integrity(a.id,false),blocked=await f.send('POST',next.base+'/runs',next.request);
  assert.equal(blocked.statusCode,409,blocked.body);assert.equal(blocked.json().code,'PROJECT_RUN_ACTIVE');
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM bb_integrity_runs WHERE project_id=$1',[a.id])).rows[0].n,1);
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM bb_credit_reservations WHERE owner_user_id=$1',[f.owner])).rows[0].n,1);
  f.setActor(f.foreign);
  for(const response of [await f.send('GET',i.base),await f.send('POST',next.base+'/runs',next.request),await f.send('GET',`/api/v1/runs/${run}`)])assert.equal(response.statusCode,404,response.body);
  assert.deepEqual(await creditBalance(f.pool,f.foreign),{available:0,frozen:0});f.setActor(f.owner);
  await f.pool.query("UPDATE bb_runs SET state='cancelled' WHERE id=$1",[run]);
  assert.deepEqual(await creditBalance(f.pool,f.owner),before);
  const other=await f.integrity(a.id,false);
  const racing=await Promise.all([f.send('POST',next.base+'/runs',next.request),f.send('POST',other.base+'/runs',other.request)]);
  assert.deepEqual(racing.map(r=>r.statusCode).sort(),[200,409],racing.map(r=>r.body).join('\n'));
  assert.equal(racing.find(r=>r.statusCode===409)!.json().code,'PROJECT_RUN_ACTIVE');
  assert.equal((await f.pool.query("SELECT count(*)::int n FROM bb_integrity_runs i JOIN bb_runs r ON r.id=i.run_id WHERE i.project_id=$1 AND r.state='queued'",[a.id])).rows[0].n,1);
  assert.equal((await f.pool.query("SELECT count(*)::int n FROM bb_credit_reservations WHERE owner_user_id=$1 AND state='held'",[f.owner])).rows[0].n,1);
  assert.deepEqual(await creditBalance(f.pool,f.owner),{available:before.available-points,frozen:points});
 }finally{await f.close();}
});

test('canonical source mutex excludes integrity in both directions while DB and API retain document and integrity guards',{skip:!database,timeout:120000},async()=>{
 const f=await fixture();
 try{
  const root=await f.authoring(),linked=await f.authoring();
  await f.pool.query('UPDATE bb_projects SET execution_scope_project_id=$2 WHERE id=$1',[linked.id,root.id]);
  const first=await f.integrity(root.id),rootIntegrity=await f.ok('POST',first.base+'/runs',first.request);
  const document=await f.ok('POST','/api/v1/runs/execute',linked.request,202);
  const second=await f.integrity(linked.id),linkedIntegrity=await f.ok('POST',second.base+'/runs',second.request);
  assert.notEqual(rootIntegrity.run_id,linkedIntegrity.run_id,'integrity rounds are independent across projects in one canonical scope');
  const denied=await f.send('POST','/api/v1/runs/execute',root.request);
  assert.equal(denied.statusCode,409,denied.body);assert.equal(denied.json().code,'PROJECT_RUN_ACTIVE');
  const insert=(project:string,revision:number,hash:string,kind:string)=>f.pool.query(
   "INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'queued')",
   [randomUUID(),f.owner,project,revision,hash,randomUUID(),kind,'a'.repeat(64)]);
  await assert.rejects(insert(root.id,root.input.input_revision,root.input.input_hash,'update'),{code:'23514'},'direct DB insertion cannot bypass document mutex');
  const input=(await f.pool.query('SELECT input_revision,input_hash FROM bb_runs WHERE id=$1',[linkedIntegrity.run_id])).rows[0];
  await assert.rejects(insert(linked.id,input.input_revision,input.input_hash.trim(),'generation'),{code:'23514'},'direct DB insertion cannot start a second integrity operation');
  const current=(await f.pool.query('SELECT id,state FROM bb_runs WHERE id=ANY($1::text[])',[[rootIntegrity.run_id,document.run_id,linkedIntegrity.run_id]])).rows;
  assert.equal(current.length,3);assert.ok(current.every(r=>r.state==='queued'));
  assert.equal((await f.pool.query('SELECT count(*)::int n FROM bb_credit_reservations WHERE owner_user_id=$1',[f.owner])).rows[0].n,3);
 }finally{await f.close();}
});

test('integrity on a new project leaves no authoring pointer and later prospectus upload, freeze and quote succeed',{skip:!database,timeout:120000},async()=>{
 const f=await fixture();
 try{
  const p=await f.ok('POST','/api/v1/projects',{name:'Synthetic integrity before prospectus',kind:'update',issuer_name:'Synthetic issuer',market:'sse',offering:'private',
   update_details:{...emptyUpdateDetails(),authoring_mode:'unified_v1',reporting_cutoff:'2026-09-30'}},201),id=p.project_id;
  assert.equal((await f.latest(id)).latest_input_revision,null);
  const i=await f.integrity(id),check=await f.ok('POST',i.base+'/runs',i.request);
  assert.equal((await f.latest(id)).latest_input_revision,null,'integrity-only input cannot masquerade as an authoring snapshot');
  const project=await f.ok('GET',`/api/v1/projects/${id}`);
  assert.equal(project.input_revision,null);assert.equal(project.input_hash,null);
  const integritySnapshot=(await f.snapshot(id))[0];
  assert.equal(integritySnapshot.revision,1);assert.equal(integritySnapshot.manifest.version,'integrity-round-v1');
  const freeze=await uploadSyntheticReference(f.app,id),input=await f.ok('POST',`/api/v1/projects/${id}/input-revisions`,freeze,201);
  assert.equal(input.input_revision,2,'the first prospectus snapshot follows the existing integrity snapshot');
  assert.equal((await f.latest(id)).latest_input_revision,2);
  assert.deepEqual((await f.snapshot(id))[0],integritySnapshot);
  const quote=await f.ok('POST',`/api/v1/projects/${id}/credit-quote`,{input_revision:input.input_revision,input_hash:input.input_hash});
  assert.equal(quote.quote.quote_status,'ready');assert.equal(quote.quote.input_revision,2);
  const update=await f.ok('POST','/api/v1/runs/execute',{execution_request_id:randomUUID(),project_id:id,input_revision:2,input_hash:input.input_hash,
   task_kind:'update',input_manifest_ref:'synthetic-concurrency',storage_origin:'cloud',workspace_id:id,quote_id:quote.quote.quote_id},202);
  const tasks=await f.ok('GET',`/api/v1/projects/${id}/tasks`);
  assert.deepEqual(tasks.items.map((t:any)=>[t.run_id,t.kind,t.operation]).sort(),
   [[update.run_id,'update',null],[check.run_id,'generation','integrity_check']].sort());
 }finally{await f.close();}
});