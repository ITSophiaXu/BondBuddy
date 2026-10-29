import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import {Pool} from 'pg';
import {OUTCOME_PRICE_VERSION,type QaDraft,type QaResult,type ProjectFileFinding,type ProjectFileCheckResult} from '@bondbuddy/contracts';
import {Problem,publicProblem,transaction,type PrivateBlobs} from './data.js';
import {grantCredits,creditBalance} from './billing.js';
import {claim,finish,promoteWordArtifact} from './queue.js';
import {registerProjectQa} from './project-qa.js';
import {registerProjectFileConsistency,advanceProjectFileUpdates} from './project-file-consistency.js';
import {publishScopeQuote} from './scope-quotations.js';
import {inputManifestHash} from './production-rule-pin.js';
import {makeSyntheticDocxFixture} from './docx-fixtures.js';
import {isolatedTestDatabase} from './test-database.js';

// Real registered HTTP handlers and real isolated PostgreSQL. All users, materials,
// work scopes, approvals and delivered bytes are synthetic; no provider/model runs.
const database=await isolatedTestDatabase(undefined,'project-scope-http');
const sha='a'.repeat(64),media='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
function memoryBlobs():PrivateBlobs{
 const values=new Map<string,Buffer>();return {put:async(k,b)=>{values.set(k,Buffer.from(b));},get:async k=>{const b=values.get(k);assert.ok(b);return b;},getIfExists:async k=>values.get(k)??null,
  getIfExistsBounded:async(k,n)=>{const b=values.get(k);if(b&&b.length>n)throw Error('bounded');return b??null;},exists:async k=>values.has(k),delete:async k=>{values.delete(k);}};
}
async function setup(pool:Pool){
 const owner=randomUUID(),project=randomUUID();
 await pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[owner,'synthetic_scope_'+owner.slice(0,8)]);
 await pool.query("INSERT INTO bb_projects(id,owner_user_id,name,kind) VALUES($1,$2,'Synthetic scoped project','generation')",[project,owner]);
 const app=Fastify();app.setErrorHandler((e,r,reply)=>e instanceof Problem?reply.code(e.status).send(publicProblem(e,r.id)):reply.code(500).send({message:e instanceof Error?e.message:String(e)}));
 registerProjectQa(app,()=>pool,async()=>owner,true);registerProjectFileConsistency(app,()=>pool,async()=>owner,true);
 return {owner,project,app};
}
async function material(pool:Pool,owner:string,project:string,name:string,role='other'){
 const id=randomUUID(),upload=randomUUID();
 await pool.query("INSERT INTO bb_uploads(id,owner_user_id,project_id,filename,declared_media_type,byte_size,sha256,role,object_key,expires_at,state) VALUES($1,$2,$3,$4,$5,1,$6,$7,$1,now()+interval '1 day','completed')",[upload,owner,project,name,media,sha,role]);
 await pool.query("INSERT INTO bb_material_versions(id,version,owner_user_id,project_id,upload_id,role,filename,media_type,byte_size,sha256,object_key,state) VALUES($1,1,$2,$3,$4,$8,$5,$6,1,$7,$1,'persisted')",[id,owner,project,upload,name,media,sha,role]);
 return {kind:'material' as const,pin:{source_project_id:project,material_id:id,material_version:1,sha256:sha}};
}
async function approve(pool:Pool,id:string,amount:number){
 const row=(await pool.query('SELECT input_hash FROM bb_scope_quotations WHERE id=$1',[id])).rows[0];assert.ok(row);
 return publishScopeQuote(pool,{id,expected_input_hash:row.input_hash.trim(),actor:'synthetic-scope-reviewer',reason:'Synthetic review of the exact pinned work scope',
  lines:[{key:'synthetic-scope',label:'Synthetic evidenced work',quantity:1,unit:'confirmed scope',unit_price_fen:amount,amount_fen:amount,evidence:['input:'+row.input_hash.trim()]}]});
}
async function counts(pool:Pool,owner:string){return (await pool.query(`SELECT
 (SELECT count(*)::int FROM bb_runs WHERE owner_user_id=$1) AS runs,
 (SELECT count(*)::int FROM bb_credit_reservations WHERE owner_user_id=$1) AS reservations,
 (SELECT count(*)::int FROM bb_project_file_update_batches WHERE owner_user_id=$1) AS batches`,[owner])).rows[0];}

test('QA HTTP scope quote stays free/pending, rejects stale work, then pins a reviewed total without question-count multiplication',{skip:!database,timeout:120000},async()=>{
 const pool=new Pool({connectionString:database}),h=await setup(pool),blobs=memoryBlobs(),base=`/api/v1/projects/${h.project}/qa`;
 try{
  const asset=await material(pool,h.owner,h.project,'Synthetic questions.docx');
  // Answering requires a separate, adopted prospectus selected as evidence for this round.
  const prospectus=await material(pool,h.owner,h.project,'Synthetic current prospectus.docx','historical'),sourceVersion=randomUUID();
  await pool.query("INSERT INTO bb_prospectus_versions(id,owner_user_id,project_id,sequence,origin,filename,sha256,material_id,material_version) VALUES($1,$2,$3,1,'upload','Synthetic current prospectus.docx',$4,$5,1)",[sourceVersion,h.owner,h.project,sha,prospectus.pin.material_id]);
  await pool.query('INSERT INTO bb_prospectus_selection(owner_user_id,project_id,version_id,revision) VALUES($1,$2,$3,1)',[h.owner,h.project,sourceVersion]);
  const prepared=await h.app.inject({method:'POST',url:base+'/prepare',payload:{request_id:randomUUID(),source:asset}});assert.equal(prepared.statusCode,200,prepared.body);
  const runId=prepared.json().run_id,lease=await claim(pool);assert.ok(lease);assert.equal(lease.runId,runId);
  const doc=await promoteWordArtifact(pool,lease,makeSyntheticDocxFixture({text:'Synthetic reviewer question'}),blobs,'generated_pair_v1');
  const artifact=(await pool.query('SELECT * FROM bb_artifact_versions WHERE id=$1',[doc.artifactId])).rows[0],run=(await pool.query('SELECT * FROM bb_runs WHERE id=$1',[runId])).rows[0];
  const questions=[{id:'q0',start:0,end:0,question:'Synthetic reviewer question'}];
  const result:QaResult={version:'project-qa-result-v1',input_hash:run.input_hash.trim(),document:{key:artifact.object_key,sha256:artifact.sha256.trim(),byte_size:(await blobs.get(artifact.object_key)).length},
   snapshot:{version:'project-file-text-v1',sha256:sha,format:'docx',spans:[{id:'s0',text:questions[0].question,location:'Synthetic page 1',sha256:sha}],warnings:[],coverage:'complete'},questions,answers:[],warnings:[],evidence:[]};
  await pool.query('UPDATE bb_project_qa_runs SET result=$2,result_hash=$3 WHERE run_id=$1',[runId,result,inputManifestHash(result)]);
  await finish(pool,lease,'succeeded',{artifactId:doc.artifactId,artifactVersion:1,blobs});
  const draft:QaDraft={preparation_id:runId,questions,materials:[prospectus],requirements:'Use evidenced facts',use_knowledge:false};
  const saved=await h.app.inject({method:'POST',url:base+'/draft',payload:{expected_revision:0,draft}});assert.equal(saved.statusCode,200,saved.body);
  assert.equal(saved.json().price.quote_status,'pending_scope');assert.equal(saved.json().price.points,0);
  const before=await counts(pool,h.owner),pending=await h.app.inject({method:'POST',url:base+'/quote',payload:{expected_revision:1}});
  assert.equal(pending.statusCode,200,pending.body);const pq=pending.json();assert.equal(pq.quote_status,'pending_scope');assert.equal(pq.points,0);assert.ok(pq.scope_quote_id);
  const blocked=await h.app.inject({method:'POST',url:base+'/runs',payload:{request_id:randomUUID(),expected_revision:1,expected_points:0,price_version:OUTCOME_PRICE_VERSION,scope_quote_id:pq.scope_quote_id}});
  assert.equal(blocked.statusCode,409,blocked.body);assert.deepEqual(await counts(pool,h.owner),before);
  await approve(pool,pq.scope_quote_id,2671);
  const ready=await h.app.inject({method:'POST',url:base+'/quote',payload:{expected_revision:1}});assert.equal(ready.statusCode,200,ready.body);assert.equal(ready.json().points,2671);assert.equal(ready.json().quote_status,'ready');
  assert.equal((await h.app.inject({method:'POST',url:base+'/draft',payload:{expected_revision:1,draft:{...draft,requirements:'Updated actual reply scope'}}})).statusCode,200);
  const stale=await h.app.inject({method:'POST',url:base+'/runs',payload:{request_id:randomUUID(),expected_revision:2,expected_points:2671,price_version:OUTCOME_PRICE_VERSION,scope_quote_id:pq.scope_quote_id}});
  assert.equal(stale.statusCode,409,stale.body);assert.deepEqual(await counts(pool,h.owner),before);
  const next=await h.app.inject({method:'POST',url:base+'/quote',payload:{expected_revision:2}});assert.equal(next.statusCode,200,next.body);assert.notEqual(next.json().scope_quote_id,pq.scope_quote_id);assert.equal(next.json().quote_status,'pending_scope');
  await approve(pool,next.json().scope_quote_id,3817);await transaction(pool,c=>grantCredits(c,{owner:h.owner,points:3817,key:randomUUID(),source:'purchase',expiresAt:null,actor:'synthetic-test',reason:'synthetic-only'}));
  const request={request_id:randomUUID(),expected_revision:2,expected_points:3817,price_version:OUTCOME_PRICE_VERSION,scope_quote_id:next.json().scope_quote_id};
  const started=await h.app.inject({method:'POST',url:base+'/runs',payload:request});assert.equal(started.statusCode,200,started.body);
  const duplicate=await h.app.inject({method:'POST',url:base+'/runs',payload:request});assert.equal(duplicate.statusCode,200,duplicate.body);assert.equal(duplicate.json().run_id,started.json().run_id);
  const quote=(await pool.query('SELECT * FROM bb_project_qa_quotes WHERE run_id=$1',[started.json().run_id])).rows[0];assert.equal(Number(quote.points),3817);assert.equal(quote.unit_points,0);assert.equal(quote.scope_quote_id,next.json().scope_quote_id);assert.equal(quote.scope_lines.length,1);
  assert.deepEqual(await creditBalance(pool,h.owner),{available:0,frozen:3817});
  await pool.query("UPDATE bb_runs SET state='failed' WHERE id=$1",[started.json().run_id]);assert.deepEqual(await creditBalance(pool,h.owner),{available:3817,frozen:0});
 }finally{await h.app.close();await pool.end();}
});

test('file HTTP quotes use 9.9 check and a 10-yuan same-version sync upgrade, retain evidence and pin retry price',{skip:!database,timeout:120000},async()=>{
 const pool=new Pool({connectionString:database}),h=await setup(pool),blobs=memoryBlobs(),base=`/api/v1/projects/${h.project}/project-files`;
 try{
  const source=await material(pool,h.owner,h.project,'Synthetic prospectus.docx'),target=await material(pool,h.owner,h.project,'Synthetic target.docx'),sourceVersion=randomUUID(),file=randomUUID(),version=randomUUID();
  await pool.query("INSERT INTO bb_prospectus_versions(id,owner_user_id,project_id,sequence,origin,filename,sha256,material_id,material_version) VALUES($1,$2,$3,1,'upload','Synthetic prospectus.docx',$4,$5,1)",[sourceVersion,h.owner,h.project,sha,source.pin.material_id]);
  await pool.query('INSERT INTO bb_prospectus_selection(owner_user_id,project_id,version_id,revision) VALUES($1,$2,$3,1)',[h.owner,h.project,sourceVersion]);
  await pool.query("INSERT INTO bb_project_files(id,owner_user_id,project_id,document_type) VALUES($1,$2,$3,'synthetic-document')",[file,h.owner,h.project]);
  await pool.query("INSERT INTO bb_project_file_versions(id,owner_user_id,file_id,sequence,filename,asset,source_version_id) VALUES($1,$2,$3,1,'Synthetic target.docx',$4,$5)",[version,h.owner,file,target,sourceVersion]);
  await pool.query('UPDATE bb_project_files SET latest_version_id=$2 WHERE id=$1',[file,version]);
  await transaction(pool,c=>grantCredits(c,{owner:h.owner,points:10000,key:randomUUID(),source:'purchase',expiresAt:null,actor:'synthetic-test',reason:'synthetic-only'}));
  const request={request_id:randomUUID(),expected_source_version_id:sourceVersion,file_version_ids:[version]},before=await counts(pool,h.owner);
  const quoted=await h.app.inject({method:'POST',url:base+'/checks/quote',payload:request});assert.equal(quoted.statusCode,200,quoted.body);assert.equal(quoted.json().quote_status,'ready');assert.equal(quoted.json().points,990);
  const blocked=await h.app.inject({method:'POST',url:base+'/checks',payload:{...request,price_version:OUTCOME_PRICE_VERSION,expected_points:0,scope_quote_id:quoted.json().scope_quote_id}});assert.equal(blocked.statusCode,409,blocked.body);assert.deepEqual(await counts(pool,h.owner),before);
  const ready=await h.app.inject({method:'POST',url:base+'/checks/quote',payload:request});assert.equal(ready.statusCode,200,ready.body);assert.equal(ready.json().points,990);
  const started=await h.app.inject({method:'POST',url:base+'/checks',payload:{...request,price_version:OUTCOME_PRICE_VERSION,expected_points:990,scope_quote_id:ready.json().scope_quote_id}});assert.equal(started.statusCode,200,started.body);const check=started.json().run_id;
  const finding:ProjectFileFinding={id:'synthetic-conflict',kind:'conflict',target_span_id:'target-1',original:'100',replacement:'120',source_span_id:'source-1',source_quote:'120',source_location:'Synthetic source page 1',target_location:'Synthetic target page 1',reason:'Synthetic period amount changed',field:'Synthetic amount',period:'2026',unit:'CNY'};
  const result:ProjectFileCheckResult={version:'project-file-check-v1',files:[{file_version_id:version,status:'conflict',coverage:'Synthetic amount only',findings:[finding],links:[]}]},checkHash=inputManifestHash(result);
  await pool.query('UPDATE bb_project_file_operations SET result=$2,result_hash=$3 WHERE run_id=$1',[check,result,checkHash]);
  const lease=await claim(pool);assert.ok(lease);assert.equal(lease.runId,check);
  const report=await promoteWordArtifact(pool,lease,makeSyntheticDocxFixture({text:'Synthetic consistency report'}),blobs,'generated_review_v1');
  await finish(pool,lease,'succeeded',{artifactId:report.artifactId,artifactVersion:1,blobs});
  assert.deepEqual(await creditBalance(pool,h.owner),{available:9010,frozen:0});
  const reused=await h.app.inject({method:'POST',url:base+'/checks/quote',payload:request});assert.equal(reused.statusCode,200,reused.body);assert.equal(reused.json().points,0);assert.equal(reused.json().quote_status,'ready');
  const updateRequest={expected_check_sha256:checkHash,files:[{file_version_id:version}]},url=base+'/checks/'+check+'/updates',upgrade=await h.app.inject({method:'POST',url:url+'/quote',payload:updateRequest});
  assert.equal(upgrade.statusCode,200,upgrade.body);assert.equal(upgrade.json().quote_status,'ready');assert.equal(upgrade.json().points,1000);const scopeId=upgrade.json().items[0].scope_quote_id;
  const scope=(await pool.query('SELECT * FROM bb_scope_quotations WHERE id=$1',[scopeId])).rows[0];assert.equal(scope.snapshot.paid_check.run_id,check);assert.equal(Number(scope.snapshot.paid_check.points),990);
  const noStart=await h.app.inject({method:'POST',url,payload:{...updateRequest,request_id:randomUUID(),price_version:OUTCOME_PRICE_VERSION,expected_points:1,files:[{file_version_id:version,scope_quote_id:scopeId}]}});assert.equal(noStart.statusCode,409,noStart.body);assert.equal((await counts(pool,h.owner)).batches,0);
  const upReady=await h.app.inject({method:'POST',url:url+'/quote',payload:updateRequest});assert.equal(upReady.statusCode,200,upReady.body);assert.equal(upReady.json().quote_status,'ready');assert.equal(upReady.json().points,1000);
  const accepted=await h.app.inject({method:'POST',url,payload:{...updateRequest,request_id:randomUUID(),price_version:OUTCOME_PRICE_VERSION,expected_points:1000,files:[{file_version_id:version,scope_quote_id:scopeId}]}});assert.equal(accepted.statusCode,200,accepted.body);const batch=accepted.json().batch_id;
  await advanceProjectFileUpdates(pool);let item=(await pool.query('SELECT items FROM bb_project_file_update_batches WHERE id=$1',[batch])).rows[0].items[0];assert.ok(item.run_id);assert.equal(item.scope_quote_id,scopeId);assert.equal(item.points,1000);
  const first=item.run_id,locked=(await pool.query('SELECT * FROM bb_project_file_update_quotes WHERE run_id=$1',[first])).rows[0];assert.equal(locked.scope_work_hash.trim(),scope.input_hash.trim());assert.equal(Number(locked.points),1000);
  await pool.query("UPDATE bb_runs SET state='failed' WHERE id=$1",[first]);await advanceProjectFileUpdates(pool);
  assert.equal((await pool.query('SELECT state FROM bb_project_file_update_batches WHERE id=$1',[batch])).rows[0].state,'paused');
  const retry=await h.app.inject({method:'POST',url:base+'/updates/'+batch+'/retry'});assert.equal(retry.statusCode,200,retry.body);await advanceProjectFileUpdates(pool);
  item=(await pool.query('SELECT items FROM bb_project_file_update_batches WHERE id=$1',[batch])).rows[0].items[0];assert.notEqual(item.run_id,first);assert.equal(item.scope_quote_id,scopeId);assert.equal(item.points,1000);
  const retried=(await pool.query('SELECT * FROM bb_project_file_update_quotes WHERE run_id=$1',[item.run_id])).rows[0];assert.equal(retried.scope_quote_id,scopeId);assert.equal(Number(retried.points),1000);assert.deepEqual(await creditBalance(pool,h.owner),{available:8010,frozen:1000});
  await pool.query("UPDATE bb_runs SET state='failed' WHERE id=$1",[item.run_id]);
 }finally{await h.app.close();await pool.end();}
});
